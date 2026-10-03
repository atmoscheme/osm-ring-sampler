import { MemoryCache } from './cache.js';
import { OsmConfigError, OsmUpstreamError, ThinSampleError } from './errors.js';
import { compactCoords, validateCoordinates } from './geo.js';
import {
  DEFAULT_NOMINATIM_URL,
  DEFAULT_OVERPASS_ENDPOINTS,
  assertValidUserAgent,
  fetchJsonWithRetry,
  normalizeRetryOptions,
  type NormalizedRetryOptions,
} from './http.js';
import {
  elementsToCandidates,
  isValidNearSample,
  overpassRingQuery,
  pickAround,
  recommendedAltitudeM,
} from './rings.js';
import { overpassTrackQuery, pickTrackMatch } from './tracks.js';
import type {
  CacheAdapter,
  CacheHookContext,
  Candidate,
  CountryCodeMapper,
  FetchLike,
  NearPlace,
  NearSampleResult,
  NominatimReverseResponse,
  OriginMetadata,
  OsmRingSamplerOptions,
  OverpassResponse,
  RequestHookContext,
  RetryHookContext,
  SampleRingsOptions,
  SampleTrackOptions,
  TrackSampleResult,
} from './types.js';

const DEFAULT_NEAR_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_TRACK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REVERSE_CACHE_TTL_MS = 30 * 60 * 1000;

export class OsmRingSampler {
  private readonly userAgent: string;
  private readonly fetchImpl: FetchLike;
  private readonly overpassEndpoints: readonly string[];
  private readonly nominatimUrl: string;
  private readonly overpassTimeoutMs: number;
  private readonly nominatimTimeoutMs: number;
  private readonly retry: NormalizedRetryOptions;
  private readonly cache: CacheAdapter<unknown> | null;
  private readonly nearCacheTtlMs: number;
  private readonly trackCacheTtlMs: number;
  private readonly reverseCacheTtlMs: number;
  private readonly dedupeInFlight: boolean;
  private readonly countryMapper?: CountryCodeMapper;
  private readonly minSamplePlaces: number;
  private readonly onCacheHit?: (context: CacheHookContext) => void;
  private readonly onCacheMiss?: (context: CacheHookContext) => void;
  private readonly onRequest?: (context: RequestHookContext) => void;
  private readonly onRetry?: (context: RetryHookContext) => void;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(options: OsmRingSamplerOptions) {
    this.userAgent = assertValidUserAgent(options.userAgent);

    const resolvedFetch = options.fetchImpl ?? globalThis.fetch;
    if (typeof resolvedFetch !== 'function') {
      throw new OsmConfigError(
        'No `fetch` implementation available. Pass `fetchImpl` or run on Node.js >= 20.',
      );
    }
    this.fetchImpl = resolvedFetch;

    const endpoints = options.overpassEndpoints ?? DEFAULT_OVERPASS_ENDPOINTS;
    if (endpoints.length === 0) {
      throw new OsmConfigError('`overpassEndpoints` must contain at least one URL.');
    }
    this.overpassEndpoints = [...endpoints];
    this.nominatimUrl = options.nominatimUrl ?? DEFAULT_NOMINATIM_URL;
    this.overpassTimeoutMs = Math.max(100, options.overpassTimeoutMs ?? 30_000);
    this.nominatimTimeoutMs = Math.max(100, options.nominatimTimeoutMs ?? 8_000);
    this.retry = normalizeRetryOptions(options.retry);

    this.cache =
      options.cache === false ? null : (options.cache ?? new MemoryCache<unknown>());
    this.nearCacheTtlMs = options.nearCacheTtlMs ?? DEFAULT_NEAR_CACHE_TTL_MS;
    this.trackCacheTtlMs = options.trackCacheTtlMs ?? DEFAULT_TRACK_CACHE_TTL_MS;
    this.reverseCacheTtlMs = options.reverseCacheTtlMs ?? DEFAULT_REVERSE_CACHE_TTL_MS;
    this.dedupeInFlight = options.dedupeInFlight ?? true;
    this.countryMapper = options.countryMapper;
    this.minSamplePlaces = Math.max(0, options.minSamplePlaces ?? 3);
    this.onCacheHit = options.onCacheHit;
    this.onCacheMiss = options.onCacheMiss;
    this.onRequest = options.onRequest;
    this.onRetry = options.onRetry;
  }

  /**
   * Samples up to 10 POIs around `(lat, lon)` distributed along concentric logarithmic
   * rings (`5..200 km`), enriched with Nominatim reverse-geocoding for the origin.
   */
  async sampleRings(
    lat: number,
    lon: number,
    options?: SampleRingsOptions,
  ): Promise<NearSampleResult> {
    validateCoordinates(lat, lon);
    const locale = (options?.lang ?? 'en').slice(0, 2).toLowerCase() || 'en';
    const minPlaces = options?.minSamplePlaces ?? this.minSamplePlaces;
    const cacheKey = `near:${lat.toFixed(3)}:${lon.toFixed(3)}:${locale}:${minPlaces}`;

    if (!options?.bypassCache && this.cache) {
      const cached = (await this.cache.get(cacheKey)) as NearSampleResult | undefined;
      if (cached) {
        this.onCacheHit?.({ operation: 'near', key: cacheKey });
        return cached;
      }
      this.onCacheMiss?.({ operation: 'near', key: cacheKey });
    }

    return this.runDeduplicated(cacheKey, Boolean(options?.bypassCache), async () => {
      const originMeta = await this.reverseGeocodeSafe(lat, lon, locale, options?.signal);
      const origin = this.buildOriginPlace(lat, lon, originMeta);

      let candidates: Candidate[] = [];
      let upstreamError: unknown = null;
      try {
        const query = overpassRingQuery(lat, lon, Math.ceil(this.overpassTimeoutMs / 1000));
        const payload = await this.queryOverpass(query, options?.signal);
        candidates = elementsToCandidates(payload.elements ?? [], locale);
      } catch (error) {
        if (options?.signal?.aborted) {
          throw error;
        }
        upstreamError = error;
      }

      const picked = pickAround(origin, candidates);
      const places: NearPlace[] = [
        origin,
        ...picked.map((item) => {
          const place: NearPlace = {
            id: `near-${item.osmId}`,
            name: item.name,
            countryCode: item.countryCode,
            countryName: item.countryCode ? item.countryCode.toUpperCase() : '',
            lat: item.lat,
            lon: item.lon,
            recommendedAltitudeM: recommendedAltitudeM(item.ringKm),
            ringKm: item.ringKm,
            distanceKm: Math.round(item.distanceKm * 10) / 10,
            bearingDeg: Math.round(item.bearing * 10) / 10,
          };
          if (this.countryMapper) {
            place.countryKey = this.countryMapper(item.countryCode);
          }
          return place;
        }),
      ];

      if (!isValidNearSample(places, minPlaces)) {
        if (upstreamError && picked.length === 0) {
          throw upstreamError;
        }
        throw new ThinSampleError(
          Math.max(0, places.length - 1),
          minPlaces,
        );
      }

      const result: NearSampleResult = { origin, places };
      if (this.cache) {
        await this.cache.set(cacheKey, result, this.nearCacheTtlMs);
      }
      return result;
    });
  }

  /**
   * Queries Overpass for nearby raceways/motor tracks (`way` or `relation`), stitches
   * relation member polylines, and returns the best-scoring track polyline or `null`.
   */
  async sampleTrack(
    lat: number,
    lon: number,
    options?: SampleTrackOptions,
  ): Promise<TrackSampleResult> {
    validateCoordinates(lat, lon);
    const cacheKey = `track:${lat.toFixed(4)}:${lon.toFixed(4)}`;

    if (!options?.bypassCache && this.cache) {
      const cached = (await this.cache.get(cacheKey)) as TrackSampleResult | undefined;
      if (cached) {
        this.onCacheHit?.({ operation: 'track', key: cacheKey });
        return cached;
      }
      this.onCacheMiss?.({ operation: 'track', key: cacheKey });
    }

    return this.runDeduplicated(cacheKey, Boolean(options?.bypassCache), async () => {
      const query = overpassTrackQuery(lat, lon, {
        timeoutSec: Math.ceil(this.overpassTimeoutMs / 1000),
      });
      const payload = await this.queryOverpass(query, options?.signal);
      const match = pickTrackMatch(payload.elements ?? [], lat, lon);

      const result: TrackSampleResult = match
        ? {
            coordinates: match.coordinates,
            closed: match.closed,
            lengthKm: Math.round(match.lengthKm * 1000) / 1000,
          }
        : {
            coordinates: null,
            closed: false,
            lengthKm: null,
          };

      if (this.cache) {
        await this.cache.set(cacheKey, result, this.trackCacheTtlMs);
      }
      return result;
    });
  }

  /** Performs Nominatim reverse-geocoding for `(lat, lon)`. */
  async reverseGeocode(
    lat: number,
    lon: number,
    options?: { lang?: string; bypassCache?: boolean; signal?: AbortSignal },
  ): Promise<OriginMetadata> {
    validateCoordinates(lat, lon);
    const locale = (options?.lang ?? 'en').slice(0, 2).toLowerCase() || 'en';
    const cacheKey = `reverse:${lat.toFixed(3)}:${lon.toFixed(3)}:${locale}`;

    if (!options?.bypassCache && this.cache) {
      const cached = (await this.cache.get(cacheKey)) as OriginMetadata | undefined;
      if (cached) {
        this.onCacheHit?.({ operation: 'reverse', key: cacheKey });
        return cached;
      }
      this.onCacheMiss?.({ operation: 'reverse', key: cacheKey });
    }

    return this.runDeduplicated(cacheKey, Boolean(options?.bypassCache), async () => {
      const url = new URL(this.nominatimUrl);
      url.searchParams.set('lat', String(lat));
      url.searchParams.set('lon', String(lon));
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('zoom', '12');
      url.searchParams.set('addressdetails', '1');
      url.searchParams.set('accept-language', locale);

      const payload = await fetchJsonWithRetry<NominatimReverseResponse>({
        service: 'nominatim',
        url: url.toString(),
        userAgent: this.userAgent,
        fetchImpl: this.fetchImpl,
        timeoutMs: this.nominatimTimeoutMs,
        retry: this.retry,
        signal: options?.signal,
        onRequest: this.onRequest,
        onRetry: this.onRetry,
      });

      const meta = extractOriginMetadata(payload, lat, lon);
      if (this.cache) {
        await this.cache.set(cacheKey, meta, this.reverseCacheTtlMs);
      }
      return meta;
    });
  }

  /** Clears the underlying cache adapter if supported. */
  async clearCache(): Promise<void> {
    await this.cache?.clear?.();
  }

  private async reverseGeocodeSafe(
    lat: number,
    lon: number,
    lang: string,
    signal?: AbortSignal,
  ): Promise<OriginMetadata> {
    try {
      return await this.reverseGeocode(lat, lon, { lang, signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        name: compactCoords(lat, lon),
        countryCode: null,
        countryName: '',
      };
    }
  }

  private buildOriginPlace(lat: number, lon: number, meta: OriginMetadata): NearPlace {
    const origin: NearPlace = {
      id: `near-here-${lat.toFixed(3)}-${lon.toFixed(3)}`,
      name: meta.name,
      countryCode: meta.countryCode,
      countryName: meta.countryName,
      lat,
      lon,
      recommendedAltitudeM: recommendedAltitudeM(null),
      ringKm: null,
      distanceKm: 0,
      bearingDeg: 0,
    };
    if (this.countryMapper) {
      origin.countryKey = this.countryMapper(meta.countryCode);
    }
    return origin;
  }

  private async queryOverpass(
    query: string,
    signal?: AbortSignal,
  ): Promise<OverpassResponse> {
    let lastError: unknown;
    for (const endpoint of this.overpassEndpoints) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error('Request aborted');
      }
      try {
        return await fetchJsonWithRetry<OverpassResponse>({
          service: 'overpass',
          url: endpoint,
          userAgent: this.userAgent,
          fetchImpl: this.fetchImpl,
          timeoutMs: this.overpassTimeoutMs,
          retry: this.retry,
          signal,
          onRequest: this.onRequest,
          onRetry: this.onRetry,
          init: {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            },
            body: `data=${encodeURIComponent(query)}`,
          },
        });
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new OsmUpstreamError('All Overpass upstream endpoints failed');
  }

  private runDeduplicated<T>(
    key: string,
    bypass: boolean,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.dedupeInFlight || bypass) {
      return fn();
    }
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }
    const promise = fn().finally(() => {
      if (this.inFlight.get(key) === promise) {
        this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, promise);
    return promise;
  }
}

export function createOsmRingSampler(options: OsmRingSamplerOptions): OsmRingSampler {
  return new OsmRingSampler(options);
}

function extractOriginMetadata(
  payload: NominatimReverseResponse | null | undefined,
  lat: number,
  lon: number,
): OriginMetadata {
  const address = payload?.address;
  const name =
    address?.village ||
    address?.hamlet ||
    address?.town ||
    address?.suburb ||
    address?.neighbourhood ||
    address?.city ||
    address?.county ||
    payload?.name ||
    compactCoords(lat, lon);

  const rawCode = address?.country_code?.trim().toLowerCase() ?? '';
  const countryCode = /^[a-z]{2}$/.test(rawCode) ? rawCode : null;

  return {
    name,
    countryCode,
    countryName: address?.country || (countryCode ? countryCode.toUpperCase() : ''),
  };
}
