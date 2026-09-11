export const RING_RADII_KM = [5, 10, 15, 25, 40, 55, 75, 100, 140, 200] as const;

export type RingKm = (typeof RING_RADII_KM)[number];

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** [longitude, latitude] pair following GeoJSON / RFC 7946 coordinate order. */
export type LonLat = [lon: number, lat: number];

export type PlaceKind =
  | 'city'
  | 'town'
  | 'suburb'
  | 'village'
  | 'hamlet'
  | 'peak'
  | 'castle'
  | 'attraction'
  | 'viewpoint';

export interface Candidate {
  osmId: string;
  name: string;
  lat: number;
  lon: number;
  score: number;
  kind: PlaceKind | (string & {});
  countryCode: string | null;
}

export interface PickedPlace<TRing extends number = RingKm> extends Candidate {
  ringKm: TRing;
  distanceKm: number;
  bearing: number;
}

export interface NearPlace {
  id: string;
  name: string;
  /** Lowercase ISO 3166-1 alpha-2 country code (e.g. `"fr"`, `"gb"`), or `null` if unavailable. */
  countryCode: string | null;
  /** Optional custom country key computed via `countryMapper` when provided. */
  countryKey?: string;
  countryName: string;
  lat: number;
  lon: number;
  /** Suggested viewing altitude in meters (`24_000`..`450_000`). */
  recommendedAltitudeM: number;
  ringKm: number | null;
  distanceKm: number;
  bearingDeg: number;
}

export interface NearSampleResult {
  origin: NearPlace;
  places: NearPlace[];
}

export interface OriginMetadata {
  name: string;
  countryCode: string | null;
  countryName: string;
}

export interface OverpassNode {
  lat?: number;
  lon?: number;
}

export interface OverpassMember {
  type?: string;
  ref?: number;
  role?: string;
  geometry?: OverpassNode[];
}

export interface OverpassElement {
  type: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  geometry?: OverpassNode[];
  members?: OverpassMember[];
}

export interface OverpassResponse {
  elements?: OverpassElement[];
}

export interface NominatimReverseResponse {
  name?: string;
  display_name?: string;
  address?: {
    neighbourhood?: string;
    suburb?: string;
    city?: string;
    town?: string;
    village?: string;
    hamlet?: string;
    county?: string;
    state?: string;
    country?: string;
    country_code?: string;
  };
}

export interface TrackMatch {
  coordinates: LonLat[];
  closed: boolean;
  lengthKm: number;
  distanceKm: number;
  score: number;
}

export interface TrackSampleResult {
  coordinates: LonLat[] | null;
  closed: boolean;
  lengthKm: number | null;
}

export type CountryCodeMapper = (isoCode: string | null) => string;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CacheAdapter<T = unknown> {
  get(key: string): T | undefined | Promise<T | undefined>;
  set(key: string, value: T, ttlMs: number): void | Promise<void>;
  clear?(): void | Promise<void>;
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** HTTP status codes retried with backoff (default: [429, 502, 503, 504]). */
  retryOnStatuses?: readonly number[];
}

export interface CacheHookContext {
  operation: 'near' | 'track' | 'reverse';
  key: string;
}

export interface RequestHookContext {
  service: 'nominatim' | 'overpass';
  endpoint: string;
  attempt: number;
}

export interface RetryHookContext extends RequestHookContext {
  delayMs: number;
  reason: string;
}

export interface OsmRingSamplerOptions {
  /**
   * Required User-Agent identifying your app and contact URL/email,
   * per OpenStreetMap Nominatim & Overpass usage policies:
   * - https://operations.osmfoundation.org/policies/nominatim/
   * - https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances
   */
  userAgent: string;
  fetchImpl?: FetchLike;
  overpassEndpoints?: readonly string[];
  nominatimUrl?: string;
  overpassTimeoutMs?: number;
  nominatimTimeoutMs?: number;
  retry?: RetryOptions;
  /** Custom cache adapter, or `false` to disable caching. */
  cache?: CacheAdapter<unknown> | false;
  nearCacheTtlMs?: number;
  trackCacheTtlMs?: number;
  reverseCacheTtlMs?: number;
  dedupeInFlight?: boolean;
  countryMapper?: CountryCodeMapper;
  minSamplePlaces?: number;
  onCacheHit?: (context: CacheHookContext) => void;
  onCacheMiss?: (context: CacheHookContext) => void;
  onRequest?: (context: RequestHookContext) => void;
  onRetry?: (context: RetryHookContext) => void;
}

export interface SampleRingsOptions {
  lang?: string;
  minSamplePlaces?: number;
  bypassCache?: boolean;
  signal?: AbortSignal;
}

export interface SampleTrackOptions {
  bypassCache?: boolean;
  signal?: AbortSignal;
}
