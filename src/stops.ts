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

// A few records carry 0,0 coordinates; they would otherwise rank as
// "nearby" for anyone standing off the west coast of Africa, and would
// "pair" with nothing 120 m from Null Island.
const hasUsableCoord = (stop: BusStop): boolean =>
  Number.isFinite(stop.lat) && Number.isFinite(stop.lon) && (stop.lat !== 0 || stop.lon !== 0);

/**
 * Two stops facing each other are almost always the same 120 m ring apart. A
 * pair as far apart as an opposite kerb can plausibly be — LTA's own naming
 * convention (`Opp <base>`) is the strong signal, distance breaks ties.
 */
const MAX_OPPOSITE_M = 120;

const normDesc = (description: string): string => description.trim().toLowerCase();

/** The pair names each other: one description reads `Opp <the other>`. */
const isReciprocal = (a: string, b: string): boolean => a === `opp ${b}` || b === `opp ${a}`;

/**
 * The pair sits on one kerb, not across the road: `Bef <base>` / `Aft <base>`
 * name the stop before/after `<base>` along the same side.
 */
const isSameKerb = (a: string, b: string): boolean =>
  a === `bef ${b}` || a === `aft ${b}` || b === `bef ${a}` || b === `aft ${a}`;

/**
 * The whole stop list is a few thousand rows, so it lives in memory and
 * nearest-neighbour is a linear scan. No index, no database — at this size a
 * scan is well under a millisecond and there is nothing to keep in sync.
 *
 * **There is no name search here any more.** The finder searches addresses
 * (`PlaceIndex` in [places.ts](./places.ts)), and the only thing it still asks
 * of this class is `get()`, the exact lookup behind the 5-digit stop-code
 * escape hatch. Adding a scan back would put a second, worse finder beside the
 * indexed one.
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

  /** Straight-line metres from a point to a stop. */
  distanceFrom(stop: BusStop, lat: number, lon: number): number {
    return Math.round(haversineM(lat, lon, stop.lat, stop.lon));
  }

  /**
   * The stop across the road, or `null` when no confident pair exists — the
   * stop page renders no chip at all for `null`, never a disabled one.
   *
   * Heuristic, in order: candidates are other stops with usable coordinates
   * within 120 m on the **same road** (exact `roadName` match); a description
   * reciprocity (`Opp <base>` naming) wins outright, nearest first; otherwise
   * same-kerb pairs (`Bef`/`Aft <base>`) are dropped and the nearest survivor
   * is taken. Deliberately a linear scan per call rather than a pairing
   * precomputed on refresh: one call per stop-page load over ~5,000 rows is
   * well under a millisecond, and a precomputed map would be a second thing to
   * rebuild and keep in step with `reload()`.
   */
  oppositeOf(code: string): BusStop | null {
    const stop = this.get(code);
    if (!stop || !hasUsableCoord(stop)) return null;
    const base = normDesc(stop.description);

    let reciprocal: BusStop | null = null;
    let reciprocalM = Infinity;
    let survivor: BusStop | null = null;
    let survivorM = Infinity;

    for (const candidate of this.#stops) {
      if (candidate.code === stop.code || !hasUsableCoord(candidate)) continue;
      if (candidate.roadName !== stop.roadName) continue;
      const distanceM = haversineM(stop.lat, stop.lon, candidate.lat, candidate.lon);
      if (distanceM > MAX_OPPOSITE_M) continue;

      const desc = normDesc(candidate.description);
      if (isReciprocal(base, desc)) {
        if (distanceM < reciprocalM) {
          reciprocal = candidate;
          reciprocalM = distanceM;
        }
      } else if (!isSameKerb(base, desc) && distanceM < survivorM) {
        survivor = candidate;
        survivorM = distanceM;
      }
    }

    return reciprocal ?? survivor;
  }

  nearby(lat: number, lon: number, limit = 8): NearbyStop[] {
    return this.#stops
      .filter(hasUsableCoord)
      .map((stop) => ({ ...stop, distanceM: Math.round(haversineM(lat, lon, stop.lat, stop.lon)) }))
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, limit);
  }
}
