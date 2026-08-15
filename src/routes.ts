import { config, mockMode } from './config.js';
import { fetchAllRoutes, fetchAllServices } from './lta.js';
import { mockRoutes, mockServiceInfo } from './mock.js';
import type { RouteStop, RouteStopTimes, ServiceInfo } from './types.js';

/** One direction of a service's journey, ready for the route page to render. */
export interface RouteDirection {
  /**
   * Stop codes in StopSequence order. Duplicates are legitimate and preserved:
   * a loop service calls at its origin (and sometimes an interchange) twice,
   * and collapsing the pair would straighten the loop into a line.
   */
  stops: string[];
  /**
   * From the StopSequence-1 record only, and null when that record carries
   * none. Later records hold per-stop schedules the route page does not show;
   * reading them here would silently change what "first bus" means.
   */
  firstBus: RouteStopTimes | null;
  lastBus: RouteStopTimes | null;
}

export interface RouteService {
  /** As DataMall spells it — the map key is the uppercased form, this is not. */
  serviceNo: string;
  operator: string;
  loop: boolean;
  /** Where a loop turns; empty string for a normal two-direction service. */
  loopDesc: string;
  directions: Map<1 | 2, RouteDirection>;
}

/**
 * Folds the flat BusRoutes records and BusServices metadata into the per-service
 * shape the route page needs. Pure and exported so the tests can feed it
 * hand-written records — the same bargain `places.ts` strikes with `loadBuffer`.
 */
export const buildRoutes = (
  routeStops: RouteStop[],
  services: ServiceInfo[],
): Map<string, RouteService> => {
  // BusServices carries one record per service per direction; the fields read
  // here are direction-independent, so the first record wins.
  const infoByService = new Map<string, ServiceInfo>();
  for (const info of services) {
    const key = info.serviceNo.toUpperCase();
    if (!infoByService.has(key)) infoByService.set(key, info);
  }

  const recordsByService = new Map<string, Map<1 | 2, RouteStop[]>>();
  for (const record of routeStops) {
    const key = record.serviceNo.toUpperCase();
    let byDirection = recordsByService.get(key);
    if (!byDirection) {
      byDirection = new Map();
      recordsByService.set(key, byDirection);
    }
    let records = byDirection.get(record.direction);
    if (!records) {
      records = [];
      byDirection.set(record.direction, records);
    }
    records.push(record);
  }

  const index = new Map<string, RouteService>();
  for (const [key, byDirection] of recordsByService) {
    const directions = new Map<1 | 2, RouteDirection>();
    let serviceNo = key;
    for (const [direction, records] of byDirection) {
      records.sort((a, b) => a.seq - b.seq);
      serviceNo = records[0]?.serviceNo ?? serviceNo;
      const first = records.find((record) => record.seq === 1);
      directions.set(direction, {
        stops: records.map((record) => record.code),
        firstBus: first?.firstBus ?? null,
        lastBus: first?.lastBus ?? null,
      });
    }

    // LoopDesc is authoritative when BusServices answered for this service; the
    // single-direction fallback exists because BusRoutes and BusServices are
    // two feeds and a service can appear in one before the other.
    const info = infoByService.get(key);
    const loopDesc = info?.loopDesc ?? '';
    const loop = info ? loopDesc !== '' : directions.size === 1;

    index.set(key, { serviceNo, operator: info?.operator ?? '', loop, loopDesc, directions });
  }
  return index;
};

/**
 * Every service's route, in memory, refreshed daily — a structural copy of
 * `StopIndex` (see [stops.ts](./stops.ts)). A few hundred services over ~26k
 * route records is ~2–4 MB retained, which buys the same thing the stop list
 * buys: no per-request upstream call and nothing to keep in sync.
 *
 * Nothing here may ever gate readiness. The route feed serves the route page
 * only; the board must stay ready — and a cold pod must still become ready —
 * through a route-feed outage.
 */
export class RouteIndex {
  #services = new Map<string, RouteService>();
  #loadedAt: Date | null = null;
  #timer: NodeJS.Timeout | null = null;

  get size(): number {
    return this.#services.size;
  }

  get loadedAt(): Date | null {
    return this.#loadedAt;
  }

  /** Loads once up front, then refreshes on a timer. */
  async start(): Promise<void> {
    await this.reload();
    this.#timer = setInterval(() => {
      void this.reload();
    }, config.routeRefreshMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async reload(): Promise<void> {
    try {
      const [routeStops, services] = mockMode
        ? [mockRoutes(), mockServiceInfo()]
        : await Promise.all([fetchAllRoutes(), fetchAllServices()]);
      if (routeStops.length === 0) throw new Error('route feed returned nothing');

      this.#services = buildRoutes(routeStops, services);
      this.#loadedAt = new Date();
      console.log(`loaded routes for ${this.#services.size} bus services${mockMode ? ' (mock)' : ''}`);
    } catch (err) {
      // Keep serving the previous routes rather than going dark on a refresh
      // failure. Only a cold start leaves us genuinely empty.
      console.error('bus route refresh failed:', err instanceof Error ? err.message : err);
    }
  }

  /** Case-insensitive: the URL path may carry `972m` for DataMall's `972M`. */
  get(serviceNo: string): RouteService | null {
    return this.#services.get(serviceNo.trim().toUpperCase()) ?? null;
  }
}
