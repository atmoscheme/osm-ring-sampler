import { bearingDeg, haversineKm } from './geo.js';
import {
  RING_RADII_KM,
  type Candidate,
  type CountryCodeMapper,
  type GeoPoint,
  type OverpassElement,
  type PickedPlace,
  type PlaceKind,
  type RingKm,
} from './types.js';

const DEFAULT_MIN_ORIGIN_KM = 1.6;
const DEFAULT_MIN_SEPARATION_KM = 2.4;
const DEFAULT_MAX_RADIUS_KM = 230;

/** Snaps a distance in km onto the nearest logarithmic ring radius, or `null` if out of bounds. */
export function ringForDistance(km: number): RingKm | null;
export function ringForDistance(km: number, radii: readonly number[]): number | null;
export function ringForDistance(
  km: number,
  radii: readonly number[] = RING_RADII_KM,
): number | null {
  if (km < 1.2 || km > DEFAULT_MAX_RADIUS_KM || radii.length === 0) return null;
  let best = radii[0]!;
  let bestGap = Infinity;
  for (const radius of radii) {
    const gap = Math.abs(km - radius);
    if (gap < bestGap) {
      best = radius;
      bestGap = gap;
    }
  }
  const window = Math.max(8, best * 0.45);
  if (bestGap > window) return null;
  return best;
}

/** Classifies OSM element tags into a normalized POI kind, or `null` if unsupported. */
export function kindFromTags(tags: Record<string, string>): PlaceKind | null {
  const place = tags.place;
  if (
    place === 'city' ||
    place === 'town' ||
    place === 'suburb' ||
    place === 'village' ||
    place === 'hamlet'
  ) {
    return place;
  }
  if (tags.natural === 'peak' || tags.natural === 'volcano') return 'peak';
  if (tags.historic === 'castle' || tags.historic === 'monument' || tags.historic === 'ruins') {
    return 'castle';
  }
  if (tags.tourism === 'attraction' || tags.tourism === 'museum') return 'attraction';
  if (tags.tourism === 'viewpoint') return 'viewpoint';
  return null;
}

/** Resolves localized name from OSM tags in order: name:<lang>, name, name:en, int_name. */
export function localizedName(tags: Record<string, string>, lang: string): string {
  const shortLang = lang.slice(0, 2).toLowerCase();
  return (
    tags[`name:${shortLang}`] ||
    tags.name ||
    tags['name:en'] ||
    tags.int_name ||
    ''
  ).trim();
}

/** Extracts a normalized lowercase ISO 3166-1 alpha-2 country code from OSM tags, if present. */
export function countryCodeFromTags(tags: Record<string, string>): string | null {
  const raw = tags['ISO3166-1'] || tags['is_in:country_code'] || tags['addr:country'] || '';
  const iso = raw.trim();
  if (/^[A-Za-z]{2}$/.test(iso)) return iso.toLowerCase();
  return null;
}

/** Applies an optional custom country code mapper, falling back to normalized ISO code or `fallback`. */
export function mapCountryCode(
  code: string | null | undefined,
  mapper?: CountryCodeMapper,
  fallback = 'unknown',
): string {
  const iso = (code ?? '').trim().toLowerCase();
  const normalized = /^[a-z]{2}$/.test(iso) ? iso : null;
  if (mapper) {
    return mapper(normalized);
  }
  return normalized ?? fallback;
}

/** Scores an OSM POI candidate based on place hierarchy, Wikipedia/Wikidata presence, population, and elevation. */
export function scoreTags(tags: Record<string, string>, kind: string): number {
  const population = Number(tags.population);
  const elevation = Number(tags.ele);
  let score = 8;
  if (kind === 'city') score = 86;
  else if (kind === 'town') score = 54;
  else if (kind === 'suburb') score = 24;
  else if (kind === 'village') score = 18;
  else if (kind === 'hamlet') score = 10;
  else if (kind === 'peak') score = 36;
  else if (kind === 'castle') score = 44;
  else if (kind === 'attraction') score = 40;
  else if (kind === 'viewpoint') score = 26;

  if (tags.wikipedia || tags.wikidata) score += 22;
  if (tags.capital === 'yes' || tags.admin_level === '2') score += 28;
  if (Number.isFinite(population) && population > 0) {
    score += Math.min(42, Math.log10(population + 1) * 9);
  }
  if (kind === 'peak' && Number.isFinite(elevation) && elevation > 0) {
    score += Math.min(24, elevation / 180);
  }
  return score;
}

/**
 * Deduplicates spatial candidates greedily by descending score,
 * removing items closer than `minOriginKm` to the origin or within `minSeparationKm` of a higher-scoring pick.
 */
export function dedupeCandidates(
  origin: GeoPoint,
  items: readonly Candidate[],
  minSeparationKm = DEFAULT_MIN_SEPARATION_KM,
  minOriginKm = DEFAULT_MIN_ORIGIN_KM,
): Candidate[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const kept: Candidate[] = [];
  for (const item of sorted) {
    if (haversineKm(origin, item) < minOriginKm) continue;
    if (kept.some((other) => haversineKm(item, other) < minSeparationKm)) continue;
    kept.push(item);
  }
  return kept;
}

export interface PickAroundOptions {
  minSeparationKm?: number;
  minOriginKm?: number;
  maxRadiusKm?: number;
}

/**
 * Selects up to one representative POI per logarithmic distance ring (`5..200 km`).
 * Within each ring's tolerance window `max(8, radius * 0.45)`, prefers the closest match
 * and uses score as a tie-breaker within 0.5 km.
 */
export function pickAround(
  origin: GeoPoint,
  candidates: readonly Candidate[],
  options?: PickAroundOptions,
): PickedPlace[] {
  const minSeparationKm = options?.minSeparationKm ?? DEFAULT_MIN_SEPARATION_KM;
  const minOriginKm = options?.minOriginKm ?? DEFAULT_MIN_ORIGIN_KM;
  const maxRadiusKm = options?.maxRadiusKm ?? DEFAULT_MAX_RADIUS_KM;

  const unique = dedupeCandidates(origin, candidates, minSeparationKm, minOriginKm);
  const ranked = unique
    .map((item) => ({
      ...item,
      distanceKm: haversineKm(origin, item),
      bearing: bearingDeg(origin, item),
    }))
    .filter((item) => item.distanceKm >= minOriginKm && item.distanceKm <= maxRadiusKm);

  const used = new Set<string>();
  const picked: PickedPlace[] = [];

  for (const radius of RING_RADII_KM) {
    const window = Math.max(8, radius * 0.45);
    let best: (typeof ranked)[number] | null = null;
    let bestGap = Infinity;

    for (const item of ranked) {
      if (used.has(item.osmId)) continue;
      const gap = Math.abs(item.distanceKm - radius);
      if (gap > window) continue;
      const closer = gap < bestGap - 0.5;
      const sharper =
        best != null && Math.abs(gap - bestGap) <= 0.5 && item.score > best.score;
      if (!best || closer || sharper) {
        best = item;
        bestGap = gap;
      }
    }

    if (!best) continue;
    used.add(best.osmId);
    picked.push({ ...best, ringKm: radius });
  }

  return picked;
}

/** Computes a suggested camera altitude in meters (`24,000` to `450,000`) for a given ring radius. */
export function recommendedAltitudeM(ringKm: number | null): number {
  if (ringKm == null) return 24_000;
  return Math.round(Math.min(450_000, Math.max(24_000, ringKm * 3200)));
}

/**
 * Validates that a sampled place list contains enough named non-origin OSM places
 * and does not rely on raw coordinate strings as place names.
 */
export function isValidNearSample(
  places: readonly { name: string; id?: string }[],
  minExtraPlaces = 3,
): boolean {
  const extra = places.filter(
    (item) => item.id?.startsWith('near-') && !item.id.startsWith('near-here-'),
  );
  if (extra.length < minExtraPlaces) return false;
  return extra.every((item) => item.name.trim().length > 1 && !/°[NS]/.test(item.name));
}

/** Converts raw Overpass elements into scored `Candidate` records. */
export function elementsToCandidates(
  elements: readonly OverpassElement[],
  lang = 'en',
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const element of elements) {
    if (element.id == null) continue;
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    if (lat == null || lon == null || !element.tags) continue;
    const kind = kindFromTags(element.tags);
    if (!kind) continue;
    const name = localizedName(element.tags, lang);
    if (!name) continue;
    candidates.push({
      osmId: `${element.type}${element.id}`,
      name,
      lat,
      lon,
      kind,
      score: scoreTags(element.tags, kind),
      countryCode: countryCodeFromTags(element.tags),
    });
  }
  return candidates;
}

/** Builds an Overpass QL query covering settlements, peaks, castles, and attractions across the 5..200 km rings. */
export function overpassRingQuery(lat: number, lon: number, timeoutSec = 28): string {
  const p = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  return `[out:json][timeout:${Math.max(1, Math.round(timeoutSec))}];
(
  nwr["place"~"^(suburb|village|hamlet)$"](around:40000,${p});
  nwr["place"="town"](around:100000,${p});
  nwr["place"="city"](around:200000,${p});
  nwr["tourism"~"^(attraction|viewpoint|museum)$"]["name"](around:25000,${p});
  nwr["natural"="peak"]["name"](around:40000,${p});
  nwr["historic"~"^(castle|monument|ruins)$"]["name"](around:40000,${p});
);
out center;`;
}
