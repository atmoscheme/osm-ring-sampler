# osm-ring-sampler

Backend OpenStreetMap Overpass and Nominatim client for sampling places on concentric distance rings (`5..200 km`) and stitching raceway/track polylines. Built for the `/api/near` and `/api/route` endpoints in [atmoscheme.com](https://atmoscheme.com).

```bash
npm install osm-ring-sampler
```

Requires Node.js >= 20 (uses built-in `fetch` and `AbortController`, or pass `fetchImpl`).

## Why concentric rings (`5..200 km`)

A plain Overpass `around:` query around a coordinate usually returns dozens of adjacent suburbs within 2 km, drowning out regional towns, peaks, castles, and landmarks farther out. `sampleRings` partitions the horizon into 10 logarithmic bands (`[5, 10, 15, 25, 40, 55, 75, 100, 140, 200]` km):

1. `elementsToCandidates` scores Overpass nodes/ways/relations by OSM place hierarchy (`city`, `town`, `castle`, `attraction`, `peak`, `viewpoint`, `suburb`, `village`, `hamlet`), Wikipedia/Wikidata tags, `log10(population)`, and peak elevation.
2. `dedupeCandidates` drops candidates within `1.6 km` of the origin or `2.4 km` of a higher-scoring pick.
3. `pickAround` selects at most one place per ring inside a `max(8, radius * 0.45)` km window, favoring the closest match to the ring radius and breaking ties within `0.5 km` by score.
4. `isValidNearSample` rejects sparse results (`< minSamplePlaces`, default `3`) with `ThinSampleError` instead of falling back to raw coordinate labels.

## User-Agent and upstream limits

Public Nominatim and Overpass instances block or rate-limit requests without an identifying `User-Agent` header. `createOsmRingSampler` requires a non-empty `userAgent` (throwing `OsmConfigError` otherwise) and sends it on every request, even if custom headers are merged.

The client also includes:

- Failover across `overpassEndpoints` (`overpass-api.de`, `overpass.kumi.systems` by default).
- In-flight request deduplication for concurrent identical queries.
- Retry with `Retry-After` parsing on HTTP `429`, `502`, `503`, `504`.
- Built-in `MemoryCache` (`30 min` for `near` and `reverse`, `24 h` for `track`), or pass a custom `CacheAdapter` (Redis/KV) or `cache: false`.

For heavy traffic, point `overpassEndpoints` and `nominatimUrl` at self-hosted instances.

## Usage

```ts
import { createOsmRingSampler } from 'osm-ring-sampler';

const sampler = createOsmRingSampler({
  userAgent: 'my-geo-app/1.0.0 (https://example.com; contact@example.com)',
});

const rings = await sampler.sampleRings(48.8566, 2.3522, { lang: 'en' });
for (const place of rings.places) {
  console.log(place.ringKm, place.name, `${place.distanceKm} km`, place.countryCode);
}

const track = await sampler.sampleTrack(26.0325, 50.5106);
if (track.coordinates) {
  console.log({
    vertices: track.coordinates.length,
    closed: track.closed,
    lengthKm: track.lengthKm,
  });
}
```

Pass `countryMapper` if you map ISO 3166-1 alpha-2 codes (`"fr"`, `"gb"`) to custom locale keys.

## Stitching track relations

Circuit geometry in OSM (`highway=raceway`, `leisure=track`, `route=raceway`) is often split across multiple `way` members inside a `relation`, sometimes with reversed member direction. `stitchElementPath` uses `element.geometry` directly when a single `way` has at least 8 nodes; otherwise it walks `element.members`, joins consecutive segments, drops duplicate seam vertices, and reverses a member segment automatically when its trailing vertex matches the previous segment's end.

`pickTrackMatch` filters candidates to `>= 8` vertices, length `0.6–40 km`, and anchor distance `<= 6 km`, applying a `1.4x` score multiplier to closed loops (endpoints within `120 m`).

## Pure domain exports and errors

The HTTP-free helpers (`pickAround`, `dedupeCandidates`, `stitchElementPath`, `pickTrackMatch`, `haversineKm`, `bearingDeg`) are exported directly for unit tests or custom pipelines.

Errors inherit from `OsmSamplerError`: `OsmConfigError`, `InvalidCoordinatesError`, `OsmUpstreamError`, `OsmTimeoutError`, and `ThinSampleError`.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

MIT
