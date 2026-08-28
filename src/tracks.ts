import { haversineKm } from './geo.js';
import type { LonLat, OverpassElement, OverpassNode, TrackMatch } from './types.js';

function pointDistanceKm(a: LonLat, b: LonLat): number {
  return haversineKm({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] });
}

function samePoint(a: LonLat, b: LonLat): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Converts Overpass geometry nodes into `[lon, lat]` coordinate tuples, skipping incomplete nodes. */
export function nodesToPath(nodes: readonly OverpassNode[] | undefined): LonLat[] {
  if (!nodes?.length) return [];
  const path: LonLat[] = [];
  for (const node of nodes) {
    if (node.lat == null || node.lon == null) continue;
    path.push([node.lon, node.lat]);
  }
  return path;
}

/**
 * Extracts and stitches polyline coordinates from an Overpass `way` or `relation` element.
 * Handles consecutive relation member geometries in both forward and reversed orientation,
 * deduplicating shared boundary vertices.
 */
export function stitchElementPath(element: OverpassElement): LonLat[] {
  const direct = nodesToPath(element.geometry);
  if (direct.length >= 8) return direct;

  const parts = (element.members ?? [])
    .map((member) => nodesToPath(member.geometry))
    .filter((part) => part.length >= 2);

  if (!parts.length) return direct;

  const joined: LonLat[] = [];
  for (const part of parts) {
    const last = joined[joined.length - 1];
    const first = part[0];
    const partEnd = part[part.length - 1];

    if (last && first && samePoint(last, first)) {
      joined.push(...part.slice(1));
    } else if (last && partEnd && samePoint(last, partEnd)) {
      joined.push(...part.slice(0, -1).reverse());
    } else {
      joined.push(...part);
    }
  }
  return joined;
}

/** Computes total polyline length in kilometers along consecutive vertices. */
export function pathLengthKm(path: readonly LonLat[]): number {
  let sum = 0;
  for (let i = 1; i < path.length; i += 1) {
    sum += pointDistanceKm(path[i - 1]!, path[i]!);
  }
  return sum;
}

/** Returns the midpoint vertex of a polyline as its spatial anchor. */
export function pathAnchor(path: readonly LonLat[]): LonLat {
  const mid = path[Math.floor(path.length / 2)];
  return mid ?? path[0] ?? [0, 0];
}

export interface PickTrackOptions {
  minNodes?: number;
  minLengthKm?: number;
  maxLengthKm?: number;
  maxDistanceKm?: number;
  closedThresholdKm?: number;
}

/**
 * Evaluates candidate ways/relations and returns the best-scoring track match with metadata,
 * favoring closed loops and tracks closer to the target coordinate.
 */
export function pickTrackMatch(
  elements: readonly OverpassElement[],
  lat: number,
  lon: number,
  options?: PickTrackOptions,
): TrackMatch | null {
  const minNodes = options?.minNodes ?? 8;
  const minLengthKm = options?.minLengthKm ?? 0.6;
  const maxLengthKm = options?.maxLengthKm ?? 40;
  const maxDistanceKm = options?.maxDistanceKm ?? 6;
  const closedThresholdKm = options?.closedThresholdKm ?? 0.12;

  const origin: LonLat = [lon, lat];
  let best: TrackMatch | null = null;

  for (const element of elements) {
    const path = stitchElementPath(element);
    if (path.length < minNodes) continue;
    const lengthKm = pathLengthKm(path);
    if (lengthKm < minLengthKm || lengthKm > maxLengthKm) continue;
    const distanceKm = pointDistanceKm(origin, pathAnchor(path));
    if (distanceKm > maxDistanceKm) continue;
    const closed = pointDistanceKm(path[0]!, path[path.length - 1]!) < closedThresholdKm;
    const score = lengthKm * (closed ? 1.4 : 1) * (1 / (0.35 + distanceKm));
    if (!best || score > best.score) {
      best = {
        coordinates: path,
        closed,
        lengthKm,
        distanceKm,
        score,
      };
    }
  }

  return best;
}

/** Convenience helper returning only the best-matching `[lon, lat][]` polyline or `null`. */
export function pickTrackPath(
  elements: readonly OverpassElement[],
  lat: number,
  lon: number,
  options?: PickTrackOptions,
): LonLat[] | null {
  return pickTrackMatch(elements, lat, lon, options)?.coordinates ?? null;
}

/** Builds an Overpass QL query for nearby raceways and motor tracks within `radiusM` (default 5,000 m). */
export function overpassTrackQuery(
  lat: number,
  lon: number,
  options?: { radiusM?: number; timeoutSec?: number },
): string {
  const radiusM = Math.max(100, Math.round(options?.radiusM ?? 5000));
  const timeoutSec = Math.max(1, Math.round(options?.timeoutSec ?? 22));
  const p = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  return `[out:json][timeout:${timeoutSec}];
(
  way["highway"="raceway"](around:${radiusM},${p});
  relation["highway"="raceway"](around:${radiusM},${p});
  way["leisure"="track"]["sport"~"motor"](around:${radiusM},${p});
  relation["route"="raceway"](around:${radiusM},${p});
);
out geom;`;
}
