import { describe, expect, it } from 'vitest';
import {
  RING_RADII_KM,
  bearingDeg,
  countryCodeFromTags,
  dedupeCandidates,
  elementsToCandidates,
  haversineKm,
  isValidNearSample,
  kindFromTags,
  localizedName,
  mapCountryCode,
  overpassRingQuery,
  pickAround,
  recommendedAltitudeM,
  ringForDistance,
  scoreTags,
  type Candidate,
} from '../src/index.js';

function city(name: string, lat: number, lon: number, score: number): Candidate {
  return {
    osmId: name,
    name,
    lat,
    lon,
    score,
    kind: 'city',
    countryCode: 'ru',
  };
}

describe('rings logic', () => {
  it('normalizes ISO country codes and supports optional custom mappers', () => {
    expect(countryCodeFromTags({ 'ISO3166-1': 'RU' })).toBe('ru');
    expect(countryCodeFromTags({ 'is_in:country_code': ' GB ' })).toBe('gb');
    expect(countryCodeFromTags({ 'addr:country': 'ca' })).toBe('ca');
    expect(countryCodeFromTags({ 'addr:country': 'invalid' })).toBeNull();

    expect(mapCountryCode('RU')).toBe('ru');
    expect(mapCountryCode(null)).toBe('unknown');

    const customMapper = (iso: string | null) => {
      const table: Record<string, string> = { ru: 'russia', gb: 'uk' };
      return (iso && table[iso]) ?? iso ?? 'unknown';
    };
    expect(mapCountryCode('RU', customMapper)).toBe('russia');
    expect(mapCountryCode('gb', customMapper)).toBe('uk');
    expect(mapCountryCode('xx', customMapper)).toBe('xx');
    expect(mapCountryCode(null, customMapper)).toBe('unknown');
  });

  it('offers ten logarithmic view radii and snaps a distance onto the nearest one', () => {
    expect(RING_RADII_KM).toHaveLength(10);
    expect([...RING_RADII_KM]).toEqual([5, 10, 15, 25, 40, 55, 75, 100, 140, 200]);
    expect(ringForDistance(0.4)).toBeNull();
    expect(ringForDistance(9)).toBe(10);
    expect(ringForDistance(21)).toBe(25);
    expect(ringForDistance(48)).toBe(55);
    expect(ringForDistance(110)).toBe(100);
    expect(ringForDistance(280)).toBeNull();
    expect(ringForDistance(400)).toBeNull();
  });

  it('picks one place per view radius when each band has a town', () => {
    const origin = { lat: 55.75, lon: 37.62 };
    const candidates = RING_RADII_KM.map((km) => city(`r${km}`, 55.75 + km / 111, 37.62, 40));
    const picked = pickAround(origin, candidates);
    expect(picked.map((item) => item.ringKm)).toEqual([...RING_RADII_KM]);
  });

  it('keeps the nearest places and drops a famous city beyond 230 km', () => {
    const origin = { lat: 55.75, lon: 37.62 };
    const candidates: Candidate[] = [
      city('north-10', 55.84, 37.62, 40),
      city('east-20', 55.75, 37.95, 30),
      city('south-30', 55.5, 37.62, 20),
      city('far-capital', 55.75, 33.2, 200),
      city('north-10-weak', 55.83, 37.62, 10),
    ];

    const picked = pickAround(origin, candidates);
    const names = picked.map((item) => item.name);

    expect(names).toEqual(['north-10', 'east-20', 'south-30']);
    expect(names).not.toContain('far-capital');
    expect(names).not.toContain('north-10-weak');
    expect(haversineKm(origin, picked[0]!)).toBeGreaterThan(1.6);
  });

  it('does not fill the list with a distant capital when a local town exists', () => {
    const origin = { lat: 55.75, lon: 37.62 };
    const candidates: Candidate[] = [
      { ...city('local-town', 55.82, 37.7, 54), kind: 'town' },
      city('far-capital', 55.75, 33.2, 200),
    ];
    const picked = pickAround(origin, candidates);
    expect(picked.map((item) => item.name)).toEqual(['local-town']);
  });

  it('breaks ties by score when two candidates are within 0.5 km of the same ring', () => {
    const origin = { lat: 55.75, lon: 37.62 };
    const ring5 = city('r5', 55.75 + 5 / 111.19, 37.62, 50);
    // ~10.0 km south and ~10.2 km east (separated from each other by > 14 km)
    const weakCloser = city('weak', 55.75 - 10.0 / 111.19, 37.62, 20);
    const strongNearTie = city('strong', 55.75, 37.62 + 10.2 / (111.19 * Math.cos((55.75 * Math.PI) / 180)), 95);

    const picked = pickAround(origin, [ring5, weakCloser, strongNearTie]);
    const ring10 = picked.find((item) => item.ringKm === 10);
    expect(ring10?.name).toBe('strong');
  });

  it('deduplicates spatial clusters by descending score', () => {
    const origin = { lat: 0, lon: 0 };
    const kept = dedupeCandidates(origin, [
      city('too-close-to-origin', 0.005, 0, 100),
      city('cluster-weak', 0, 0.09, 20),
      city('cluster-strong', 0, 0.095, 90),
    ]);
    expect(kept.map((item) => item.name)).toEqual(['cluster-strong']);
  });

  it('rejects a nearby sample with too few named OSM places or coordinate fallbacks', () => {
    expect(isValidNearSample([{ id: 'near-here-1', name: 'Moscow' }])).toBe(false);
    expect(
      isValidNearSample([
        { id: 'near-here-1', name: 'Moscow' },
        { id: 'near-n1', name: 'Khimki' },
        { id: 'near-n2', name: 'Mytishchi' },
        { id: 'near-n3', name: 'Podolsk' },
      ]),
    ).toBe(true);
    expect(
      isValidNearSample([
        { id: 'near-here-1', name: 'Moscow' },
        { id: 'near-n1', name: '55.80°N 37.60°E' },
        { id: 'near-n2', name: 'Mytishchi' },
        { id: 'near-n3', name: 'Podolsk' },
      ]),
    ).toBe(false);
  });

  it('extracts kind, localized name, scores, and converts Overpass elements', () => {
    expect(kindFromTags({ place: 'city' })).toBe('city');
    expect(kindFromTags({ natural: 'volcano' })).toBe('peak');
    expect(kindFromTags({ historic: 'ruins' })).toBe('castle');
    expect(kindFromTags({ tourism: 'museum' })).toBe('attraction');
    expect(kindFromTags({ tourism: 'viewpoint' })).toBe('viewpoint');
    expect(kindFromTags({ amenity: 'cafe' })).toBeNull();

    expect(
      localizedName({ name: 'München', 'name:en': 'Munich', 'name:fr': 'Munich' }, 'en-US'),
    ).toBe('Munich');

    const cityScore = scoreTags({ place: 'city', capital: 'yes', wikipedia: 'en:Paris', population: '2100000' }, 'city');
    const villageScore = scoreTags({ place: 'village' }, 'village');
    expect(cityScore).toBeGreaterThan(villageScore);

    const candidates = elementsToCandidates(
      [
        {
          type: 'node',
          id: 42,
          lat: 48.85,
          lon: 2.35,
          tags: { place: 'city', name: 'Paris', 'ISO3166-1': 'FR' },
        },
        {
          type: 'way',
          id: 99,
          center: { lat: 48.9, lon: 2.4 },
          tags: { historic: 'castle', 'name:fr': 'Château' },
        },
        {
          type: 'node',
          id: 100,
          lat: 48.91,
          lon: 2.41,
          tags: { highway: 'residential' },
        },
      ],
      'fr',
    );
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.osmId).toBe('node42');
    expect(candidates[0]?.countryCode).toBe('fr');
    expect(candidates[1]?.osmId).toBe('way99');
    expect(candidates[1]?.name).toBe('Château');
  });

  it('computes bearings, suggested altitudes, and Overpass ring queries', () => {
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(0, 3);
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(90, 3);
    expect(recommendedAltitudeM(null)).toBe(24_000);
    expect(recommendedAltitudeM(5)).toBe(24_000);
    expect(recommendedAltitudeM(40)).toBe(128_000);
    expect(recommendedAltitudeM(200)).toBe(450_000);

    const ql = overpassRingQuery(55.75, 37.62, 20);
    expect(ql).toContain('[timeout:20]');
    expect(ql).toContain('around:200000,55.75000,37.62000');
  });
});
