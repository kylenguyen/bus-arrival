import { config, mockMode } from './config.js';
import { fetchAllStops } from './lta.js';
import { MOCK_STOPS } from './mock.js';
import type { BusStop, NearbyStop } from './types.js';

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

const haversineM = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

const normalise = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The whole stop list is a few thousand rows, so it lives in memory and both
 * search and nearest-neighbour are linear scans. No index, no database — at
 * this size a scan is well under a millisecond and there is nothing to keep
 * in sync.
 */
export class StopIndex {
  #stops: BusStop[] = [];
  #byCode = new Map<string, BusStop>();
  #loadedAt: Date | null = null;
  #timer: NodeJS.Timeout | null = null;

  get size(): number {
    return this.#stops.length;
  }

  get loadedAt(): Date | null {
    return this.#loadedAt;
  }

  /** Loads once up front, then refreshes on a timer. */
  async start(): Promise<void> {
    await this.reload();
    this.#timer = setInterval(() => {
      void this.reload();
    }, config.stopRefreshMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async reload(): Promise<void> {
    try {
      const stops = mockMode ? MOCK_STOPS : await fetchAllStops();
      if (stops.length === 0) throw new Error('stop feed returned nothing');

      this.#stops = stops;
      this.#byCode = new Map(stops.map((stop) => [stop.code, stop]));
      this.#loadedAt = new Date();
      console.log(`loaded ${stops.length} bus stops${mockMode ? ' (mock)' : ''}`);
    } catch (err) {
      // Keep serving the previous list rather than going dark on a refresh
      // failure. Only a cold start leaves us genuinely empty.
      console.error('bus stop refresh failed:', err instanceof Error ? err.message : err);
    }
  }

  get(code: string): BusStop | null {
    return this.#byCode.get(code.trim()) ?? null;
  }

  search(query: string, limit = 20): BusStop[] {
    const q = normalise(query);
    if (q.length < 2) return [];

    const scored: Array<{ stop: BusStop; score: number }> = [];

    for (const stop of this.#stops) {
      const code = stop.code.toLowerCase();
      const description = normalise(stop.description);
      const road = normalise(stop.roadName);

      let score = 0;
      if (code === q) score = 100;
      else if (code.startsWith(q)) score = 90;
      else if (description.startsWith(q)) score = 80;
      else if (description.includes(q)) score = 60;
      else if (road.startsWith(q)) score = 50;
      else if (road.includes(q)) score = 40;
      else continue;

      scored.push({ stop, score });
    }

    return scored
      .sort((a, b) => b.score - a.score || a.stop.code.localeCompare(b.stop.code))
      .slice(0, limit)
      .map((entry) => entry.stop);
  }

  /** Straight-line metres from a point to a stop. */
  distanceFrom(stop: BusStop, lat: number, lon: number): number {
    return Math.round(haversineM(lat, lon, stop.lat, stop.lon));
  }

  nearby(lat: number, lon: number, limit = 8): NearbyStop[] {
    return this.#stops
      // A few records carry 0,0 coordinates; they would otherwise rank as
      // "nearby" for anyone standing off the west coast of Africa.
      .filter((stop) => stop.lat !== 0 || stop.lon !== 0)
      .map((stop) => ({ ...stop, distanceM: Math.round(haversineM(lat, lon, stop.lat, stop.lon)) }))
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, limit);
  }
}
