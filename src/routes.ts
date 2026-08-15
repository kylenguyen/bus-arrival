import { config, mockMode } from './config.js';
import { fetchAllRoutes, fetchAllServices } from './lta.js';
import { mockRoutes, mockServiceInfo } from './mock.js';
import type { RouteStop, RouteStopTimes, ServiceInfo, StopService } from './types.js';

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

/** Both views over one BusRoutes pass: by service for the route page, by stop
 *  for the stop page's schedule table. */
export interface BuiltRoutes {
  services: Map<string, RouteService>;
  /** Values sorted numerically by serviceNo, ready to serve as-is. */
  stopServices: Map<string, StopService[]>;
}

const emptyTimes = (): RouteStopTimes => ({ wd: '', sat: '', sun: '' });

const DAY_TYPES = ['wd', 'sat', 'sun'] as const;

/**
 * Ordering key for a last-bus time: before 0400 is a past-midnight bus, so it
 * belongs after 2359, not before the morning's first departure. 0400 is the
 * conventional cutoff — no Singapore day service starts earlier, no night
 * service ends later.
 */
const lastBusKey = (hhmm: string): number => {
  const minutes = Number(hhmm);
  return minutes < 400 ? minutes + 2400 : minutes;
};

/** Keep the earlier time per day-type; '' means "no data" and never wins. */
const mergeFirst = (into: RouteStopTimes, add: RouteStopTimes | undefined): void => {
  if (!add) return;
  for (const day of DAY_TYPES) {
    const time = add[day];
    // Zero-padded HHMM strings order lexicographically as they do numerically.
    if (time && (!into[day] || time < into[day])) into[day] = time;
  }
};

/** Keep the later time per day-type, counting a pre-0400 bus as next-day. */
const mergeLast = (into: RouteStopTimes, add: RouteStopTimes | undefined): void => {
  if (!add) return;
  for (const day of DAY_TYPES) {
    const time = add[day];
    if (time && (!into[day] || lastBusKey(time) > lastBusKey(into[day]))) into[day] = time;
  }
};

/**
 * Folds the flat BusRoutes records and BusServices metadata into the per-service
 * shape the route page needs, plus the stop→services reverse index the stop
 * page needs. Pure and exported so the tests can feed it hand-written records —
 * the same bargain `places.ts` strikes with `loadBuffer`.
 */
export const buildRoutes = (routeStops: RouteStop[], services: ServiceInfo[]): BuiltRoutes => {
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
  // stopCode → serviceKey → merged entry. Keyed by service so a stop visited
  // twice — a loop's origin, or both directions of a trunk — merges into one
  // row instead of appearing once per record.
  const atStop = new Map<string, Map<string, StopService>>();
  for (const [key, byDirection] of recordsByService) {
    // LoopDesc is authoritative when BusServices answered for this service; the
    // single-direction fallback exists because BusRoutes and BusServices are
    // two feeds and a service can appear in one before the other.
    const info = infoByService.get(key);

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

      // The reverse index reads every record's schedule — unlike the direction
      // shape above, which deliberately keeps the seq-1 terminus times only.
      for (const record of records) {
        let services = atStop.get(record.code);
        if (!services) {
          services = new Map();
          atStop.set(record.code, services);
        }
        let entry = services.get(key);
        if (!entry) {
          entry = {
            serviceNo: record.serviceNo,
            operator: info?.operator ?? '',
            firstBus: emptyTimes(),
            lastBus: emptyTimes(),
            freq: info?.freq ?? { peak: null, offpeak: null },
          };
          services.set(key, entry);
        }
        mergeFirst(entry.firstBus, record.firstBus);
        mergeLast(entry.lastBus, record.lastBus);
      }
    }

    const loopDesc = info?.loopDesc ?? '';
    const loop = info ? loopDesc !== '' : directions.size === 1;

    index.set(key, { serviceNo, operator: info?.operator ?? '', loop, loopDesc, directions });
  }

  const stopServices = new Map<string, StopService[]>();
  for (const [code, services] of atStop) {
    stopServices.set(
      code,
      [...services.values()].sort((a, b) =>
        a.serviceNo.localeCompare(b.serviceNo, 'en', { numeric: true, sensitivity: 'base' }),
      ),
    );
  }
  return { services: index, stopServices };
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
  #stopServices = new Map<string, StopService[]>();
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

      const built = buildRoutes(routeStops, services);
      this.#services = built.services;
      this.#stopServices = built.stopServices;
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

  /**
   * Every service calling at a stop, merged across directions and sorted
   * numerically — the stop page's schedule table. Empty for an unknown stop:
   * "no code" and "no services" render the same there, and the 404 comes from
   * `StopIndex`, which owns which codes exist.
   */
  servicesAt(code: string): StopService[] {
    return this.#stopServices.get(code.trim()) ?? [];
  }
}
