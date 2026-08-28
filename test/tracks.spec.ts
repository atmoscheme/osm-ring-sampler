import { describe, expect, it } from 'vitest';
import {
  nodesToPath,
  overpassTrackQuery,
  pathAnchor,
  pathLengthKm,
  pickTrackMatch,
  pickTrackPath,
  stitchElementPath,
  type OverpassElement,
} from '../src/index.js';

describe('tracks logic', () => {
  it('picks the closed raceway nearest the pin', () => {
    const far: OverpassElement = {
      type: 'way',
      geometry: [
        { lat: 26.1, lon: 50.7 },
        { lat: 26.11, lon: 50.71 },
        { lat: 26.12, lon: 50.72 },
        { lat: 26.13, lon: 50.73 },
        { lat: 26.14, lon: 50.74 },
        { lat: 26.15, lon: 50.75 },
        { lat: 26.16, lon: 50.76 },
        { lat: 26.17, lon: 50.77 },
        { lat: 26.18, lon: 50.78 },
      ],
    };
    const track: OverpassElement = {
      type: 'way',
      geometry: [
        { lat: 26.0325, lon: 50.5106 },
        { lat: 26.034, lon: 50.518 },
        { lat: 26.028, lon: 50.522 },
        { lat: 26.022, lon: 50.518 },
        { lat: 26.02, lon: 50.512 },
        { lat: 26.024, lon: 50.506 },
        { lat: 26.03, lon: 50.505 },
        { lat: 26.034, lon: 50.508 },
        { lat: 26.0325, lon: 50.5106 },
      ],
    };

    const path = pickTrackPath([far, track], 26.0325, 50.5106);
    expect(path?.[0]).toEqual([50.5106, 26.0325]);
    expect(path?.length).toBeGreaterThan(7);
  });

  it('stitches relation member polylines and deduplicates shared boundary vertices', () => {
    const relation: OverpassElement = {
      type: 'relation',
      members: [
        {
          geometry: [
            { lat: 26.0325, lon: 50.5106 },
            { lat: 26.034, lon: 50.518 },
            { lat: 26.028, lon: 50.522 },
          ],
        },
        {
          // Shared vertex (26.028, 50.522) at start
          geometry: [
            { lat: 26.028, lon: 50.522 },
            { lat: 26.022, lon: 50.518 },
            { lat: 26.02, lon: 50.512 },
          ],
        },
        {
          // Reversed member segment ending at (26.02, 50.512)
          geometry: [
            { lat: 26.0325, lon: 50.5106 },
            { lat: 26.034, lon: 50.508 },
            { lat: 26.03, lon: 50.505 },
            { lat: 26.024, lon: 50.506 },
            { lat: 26.02, lon: 50.512 },
          ],
        },
      ],
    };

    const stitched = stitchElementPath(relation);
    // 3 + (3 - 1) + (5 - 1) = 9 vertices (no duplicate seam points)
    expect(stitched).toHaveLength(9);
    expect(stitched[0]).toEqual([50.5106, 26.0325]);
    expect(stitched[stitched.length - 1]).toEqual([50.5106, 26.0325]);

    const match = pickTrackMatch([relation], 26.0325, 50.5106);
    expect(match).not.toBeNull();
    expect(match?.closed).toBe(true);
    expect(match?.lengthKm).toBeGreaterThan(2);
    expect(match?.coordinates).toEqual(stitched);
  });

  it('prefers a closed loop over an open track of comparable length and distance', () => {
    const openTrack: OverpassElement = {
      type: 'way',
      geometry: [
        { lat: 26.0325, lon: 50.5106 },
        { lat: 26.035, lon: 50.514 },
        { lat: 26.036, lon: 50.518 },
        { lat: 26.035, lon: 50.522 },
        { lat: 26.032, lon: 50.525 },
        { lat: 26.028, lon: 50.526 },
        { lat: 26.024, lon: 50.525 },
        { lat: 26.021, lon: 50.522 },
      ],
    };

    const closedTrack: OverpassElement = {
      type: 'way',
      geometry: [
        { lat: 26.0325, lon: 50.5106 },
        { lat: 26.035, lon: 50.515 },
        { lat: 26.033, lon: 50.521 },
        { lat: 26.027, lon: 50.522 },
        { lat: 26.023, lon: 50.517 },
        { lat: 26.024, lon: 50.511 },
        { lat: 26.029, lon: 50.508 },
        { lat: 26.0325, lon: 50.5106 },
      ],
    };

    const match = pickTrackMatch([openTrack, closedTrack], 26.0325, 50.5106);
    expect(match?.closed).toBe(true);
  });

  it('skips incomplete nodes and computes path metrics and queries', () => {
    const path = nodesToPath([
      { lat: 10, lon: 20 },
      { lat: 10 },
      { lon: 20 },
      { lat: 10.01, lon: 20.01 },
    ]);
    expect(path).toEqual([
      [20, 10],
      [20.01, 10.01],
    ]);
    expect(pathLengthKm(path)).toBeGreaterThan(1);
    expect(pathAnchor(path)).toEqual([20.01, 10.01]);

    const query = overpassTrackQuery(26.0325, 50.5106, { radiusM: 3500, timeoutSec: 15 });
    expect(query).toContain('[timeout:15]');
    expect(query).toContain('around:3500,26.03250,50.51060');
  });
});
