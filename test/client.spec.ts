import { describe, expect, it, vi } from 'vitest';
import {
  InvalidCoordinatesError,
  MemoryCache,
  OsmConfigError,
  OsmRingSampler,
  OsmTimeoutError,
  OsmUpstreamError,
  ThinSampleError,
  createOsmRingSampler,
  type FetchLike,
} from '../src/index.js';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function getHeader(init: RequestInit | undefined, key: string): string | null {
  if (!init?.headers) return null;
  return new Headers(init.headers).get(key);
}

const SAMPLE_ELEMENTS = [
  { type: 'node', id: 1, lat: 55.795, lon: 37.62, tags: { place: 'suburb', name: 'Ostankino', 'ISO3166-1': 'RU' } },
  { type: 'node', id: 2, lat: 55.84, lon: 37.62, tags: { place: 'town', name: 'Mytishchi', 'ISO3166-1': 'RU' } },
  { type: 'node', id: 3, lat: 55.885, lon: 37.62, tags: { place: 'town', name: 'Pushkino', 'ISO3166-1': 'RU' } },
  { type: 'node', id: 4, lat: 55.975, lon: 37.62, tags: { place: 'town', name: 'Sergiev Posad', 'ISO3166-1': 'RU' } },
];

describe('OsmRingSampler HTTP client', () => {
  it('requires a non-empty User-Agent and throws OsmConfigError otherwise', () => {
    expect(() => new OsmRingSampler({ userAgent: '' })).toThrow(OsmConfigError);
    expect(() => new OsmRingSampler({ userAgent: '   ' })).toThrow(OsmConfigError);
    expect(() =>
      createOsmRingSampler({
        userAgent: 'test-app/1.0',
        overpassEndpoints: [],
      }),
    ).toThrow(OsmConfigError);
  });

  it('validates WGS84 coordinates', async () => {
    const sampler = createOsmRingSampler({
      userAgent: 'test-app/1.0',
      fetchImpl: vi.fn<FetchLike>(),
    });

    await expect(sampler.sampleRings(91, 0)).rejects.toThrow(InvalidCoordinatesError);
    await expect(sampler.sampleRings(0, -181)).rejects.toThrow(InvalidCoordinatesError);
    await expect(sampler.sampleTrack(Number.NaN, 10)).rejects.toThrow(InvalidCoordinatesError);
  });

  it('sends configured User-Agent to Nominatim and Overpass and returns clean ISO codes + optional countryMapper', async () => {
    const calls: { url: string; userAgent: string | null }[] = [];

    const fetchMock = vi.fn<FetchLike>(async (input, init) => {
      const url = String(input);
      calls.push({ url, userAgent: getHeader(init, 'User-Agent') });

      if (url.includes('nominatim')) {
        return jsonResponse({
          address: {
            city: 'Moscow',
            country: 'Russia',
            country_code: 'ru',
          },
        });
      }

      return jsonResponse({ elements: SAMPLE_ELEMENTS });
    });

    const sampler = createOsmRingSampler({
      userAgent: 'MyGeoApp/2.1 (https://mygeoapp.example; ops@mygeoapp.example)',
      fetchImpl: fetchMock,
      countryMapper: (iso) => (iso === 'ru' ? 'russia' : iso ?? 'unknown'),
    });

    const result = await sampler.sampleRings(55.75, 37.62, { lang: 'en' });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.userAgent).toBe('MyGeoApp/2.1 (https://mygeoapp.example; ops@mygeoapp.example)');
    expect(calls[1]?.userAgent).toBe('MyGeoApp/2.1 (https://mygeoapp.example; ops@mygeoapp.example)');

    expect(result.origin.name).toBe('Moscow');
    expect(result.origin.countryCode).toBe('ru');
    expect(result.origin.countryKey).toBe('russia');
    expect(result.origin.ringKm).toBeNull();
    expect(result.places.length).toBeGreaterThanOrEqual(4);
    expect(result.places[1]?.countryCode).toBe('ru');
    expect(result.places[1]?.countryKey).toBe('russia');
    expect(result.places[1]?.recommendedAltitudeM).toBeGreaterThanOrEqual(24_000);
  });

  it('falls back to compact coordinates if Nominatim fails and throws ThinSampleError when sample is too sparse', async () => {
    const fetchMock = vi.fn<FetchLike>(async (input) => {
      const url = String(input);
      if (url.includes('nominatim')) {
        return jsonResponse({ message: 'rate limited' }, { status: 503 });
      }
      return jsonResponse({
        elements: [SAMPLE_ELEMENTS[0]],
      });
    });

    const sampler = createOsmRingSampler({
      userAgent: 'test-app/1.0',
      fetchImpl: fetchMock,
      retry: { retries: 0 },
    });

    await expect(sampler.sampleRings(55.75, 37.62)).rejects.toThrow(ThinSampleError);

    // Also verify origin uses compact coordinates when minSamplePlaces allows 1 place
    const permissive = createOsmRingSampler({
      userAgent: 'test-app/1.0',
      fetchImpl: fetchMock,
      retry: { retries: 0 },
      minSamplePlaces: 1,
    });
    const res = await permissive.sampleRings(55.75, 37.62);
    expect(res.origin.name).toBe('55.75°N 37.62°E');
    expect(res.origin.countryCode).toBeNull();
  });

  it('aborts and rejects with OsmTimeoutError when upstream exceeds timeoutMs', async () => {
    const fetchMock = vi.fn<FetchLike>((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new Error('aborted'));
        });
      });
    });

    const sampler = createOsmRingSampler({
      userAgent: 'test-app/1.0',
      fetchImpl: fetchMock,
      overpassEndpoints: ['https://overpass.example.test/api/interpreter'],
      overpassTimeoutMs: 100,
      retry: { retries: 0 },
    });

    await expect(sampler.sampleTrack(26.0325, 50.5106)).rejects.toThrow(OsmTimeoutError);
  });

  it('rejects with OsmTimeoutError even if fetchImpl ignores AbortSignal', async () => {
    const fetchMock = vi.fn<FetchLike>(() => new Promise<Response>(() => {}));

    const sampler = createOsmRingSampler({
      userAgent: 'test-app/1.0',
      fetchImpl: fetchMock,
      overpassEndpoints: ['https://overpass.example.test/api/interpreter'],
      overpassTimeoutMs: 100,
      retry: { retries: 0 },
    });

    await expect(sampler.sampleTrack(26.0325, 50.5106)).rejects.toThrow(OsmTimeoutError);
  });

  it('retries transient 429/503 responses and fails over across Overpass endpoints', async () => {
    let primaryCalls = 0;
    let secondaryCalls = 0;
    const retryEvents: string[] = [];

    const fetchMock = vi.fn<FetchLike>(async (input) => {
      const url = String(input);
      if (url.includes('primary')) {
        primaryCalls += 1;
        return new Response('rate limit', {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      }
      secondaryCalls += 1;
      return jsonResponse({
        elements: [
          {
            type: 'relation',
            id: 777,
            members: [
              {
                geometry: [
                  { lat: 26.0325, lon: 50.5106 },
                  { lat: 26.034, lon: 50.518 },
                  { lat: 26.028, lon: 50.522 },
                  { lat: 26.022, lon: 50.518 },
                ],
              },
              {
                geometry: [
                  { lat: 26.022, lon: 50.518 },
                  { lat: 26.02, lon: 50.512 },
                  { lat: 26.024, lon: 50.506 },
                  { lat: 26.03, lon: 50.505 },
                  { lat: 26.0325, lon: 50.5106 },
                ],
              },
            ],
          },
        ],
      });
    });

    const sampler = createOsmRingSampler({
      userAgent: 'test-app/1.0',
      fetchImpl: fetchMock,
      overpassEndpoints: [
        'https://primary.overpass.test/api',
        'https://secondary.overpass.test/api',
      ],
      retry: { retries: 1, baseDelayMs: 0, maxDelayMs: 0 },
      onRetry: (event) => retryEvents.push(`${event.endpoint}:${event.reason}`),
    });

    const track = await sampler.sampleTrack(26.0325, 50.5106);

    expect(primaryCalls).toBe(2); // initial + 1 retry
    expect(secondaryCalls).toBe(1);
    expect(retryEvents).toHaveLength(1);
    expect(track.closed).toBe(true);
    expect(track.coordinates).toHaveLength(8);
  });

  it('does not retry non-retryable 4xx errors on the same endpoint', async () => {
    let calls = 0;
    const fetchMock = vi.fn<FetchLike>(async () => {
      calls += 1;
      return new Response('bad query', { status: 400 });
    });

    const sampler = createOsmRingSampler({
      userAgent: 'test-app/1.0',
      fetchImpl: fetchMock,
      overpassEndpoints: ['https://primary.overpass.test/api'],
      retry: { retries: 3, baseDelayMs: 0 },
    });

    await expect(sampler.sampleTrack(26.0325, 50.5106)).rejects.toThrow(OsmUpstreamError);
    expect(calls).toBe(1);
  });

  it('deduplicates concurrent in-flight requests and invokes cache hit/miss hooks', async () => {
    let overpassCalls = 0;
    let nominatimCalls = 0;
    const hits: string[] = [];
    const misses: string[] = [];

    const fetchMock = vi.fn<FetchLike>(async (input) => {
      const url = String(input);
      if (url.includes('nominatim')) {
        nominatimCalls += 1;
        await new Promise((r) => setTimeout(r, 15));
        return jsonResponse({ address: { city: 'Moscow', country_code: 'ru' } });
      }
      overpassCalls += 1;
      await new Promise((r) => setTimeout(r, 15));
      return jsonResponse({ elements: SAMPLE_ELEMENTS });
    });

    const sampler = createOsmRingSampler({
      userAgent: 'test-app/1.0',
      fetchImpl: fetchMock,
      cache: new MemoryCache(),
      onCacheHit: (ctx) => hits.push(`${ctx.operation}:${ctx.key}`),
      onCacheMiss: (ctx) => misses.push(`${ctx.operation}:${ctx.key}`),
    });

    // Two concurrent identical requests should collapse into one set of HTTP calls
    const [first, second] = await Promise.all([
      sampler.sampleRings(55.75, 37.62),
      sampler.sampleRings(55.75, 37.62),
    ]);

    expect(first).toEqual(second);
    expect(nominatimCalls).toBe(1);
    expect(overpassCalls).toBe(1);
    expect(misses).toHaveLength(3); // 2 near misses + 1 reverse miss

    // Third call hits cache directly
    const third = await sampler.sampleRings(55.75, 37.62);
    expect(third).toEqual(first);
    expect(overpassCalls).toBe(1);
    expect(hits).toHaveLength(1);

    await sampler.clearCache();
    await sampler.sampleRings(55.75, 37.62);
    expect(overpassCalls).toBe(2);
  });
});
