import { config } from './config.js';
import { CircuitBreaker } from './limiter.js';
import type {
  ArrivalBus,
  ArrivalService,
  BusStop,
  Load,
  RouteStop,
  RouteStopTimes,
  ServiceInfo,
} from './types.js';

/**
 * Client for LTA DataMall.
 *
 * Paths, parameters and field names below were checked against the API User
 * Guide v6.9 (3 Aug 2026) — §2.1 Bus Arrival and §2.4 Bus Stops — on
 * 10 Aug 2026. Re-check on activation only if the guide has moved past 6.9:
 * LTA has revised paths twice (BusArrival -> BusArrivalv2 -> v3/BusArrival)
 * and the field set once (v6.0 added `Monitored`).
 */

/**
 * Ceiling on requests per stop-list refresh. Not a claim about the feed's size:
 * at the guide's documented 500 records a call this is 20k stops against a real
 * figure around 5k, and it leaves headroom if LTA lowers the cap.
 */
const MAX_REQUESTS = 40;

/**
 * Ceiling for the BusRoutes walk. The route feed is an order of magnitude
 * bigger than the stop list — ~26k records is ~53 pages at the documented 500
 * a call — so `MAX_REQUESTS` would truncate it mid-walk. 80 covers that with
 * the same sort of headroom the stop ceiling carries.
 */
const MAX_ROUTE_REQUESTS = 80;

class DataMallError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Upstream's own `Retry-After`, in ms, when it sent a usable one. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'DataMallError';
  }
}

const WINDOW_SECONDS = 60;

/**
 * Cumulative and trailing-60s upstream call counts.
 *
 * The trailing window is one bucket per second rather than one entry per call:
 * an array of every call timestamp since boot grows without bound, and even a
 * pruned one peaks at one entry per call in flight. This holds at most 60
 * objects whatever the traffic, and one-second resolution is far finer than
 * anything a readiness probe reads it at.
 *
 * `now` is injectable so the window can be tested without sleeping, matching
 * `TtlCache`.
 */
export class RollingCounter {
  #total = 0;
  #buckets: { second: number; count: number }[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  record(): void {
    this.#total += 1;
    const second = Math.floor(this.now() / 1000);
    const last = this.#buckets.at(-1);
    if (last?.second === second) last.count += 1;
    else this.#buckets.push({ second, count: 1 });
    this.#prune(second);
  }

  get total(): number {
    return this.#total;
  }

  /** Calls recorded in the trailing 60s, pruned on read so an idle process decays. */
  perMinute(): number {
    const second = Math.floor(this.now() / 1000);
    this.#prune(second);
    return this.#buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  }

  #prune(second: number): void {
    const cutoff = second - WINDOW_SECONDS;
    this.#buckets = this.#buckets.filter((bucket) => bucket.second > cutoff);
  }
}

const calls = new RollingCounter();

/**
 * Guards arrivals only — see `guarded()` for why the stop list is exempt.
 */
const breaker = new CircuitBreaker();

/** Read side of the upstream counters, shaped for the `/healthz` payload. */
export const upstreamStats = (): {
  upstreamCalls: number;
  upstreamCallsPerMin: number;
  breakerOpen: boolean;
} => ({
  upstreamCalls: calls.total,
  upstreamCallsPerMin: calls.perMinute(),
  // Half-open reads as open here: the breaker has tripped and no probe has yet
  // proved otherwise, so "we are still not trusting arrivals" is the true
  // statement for whoever is watching the probe.
  breakerOpen: breaker.isOpen(),
});

/**
 * A 200 that carried no body at all. Outside operating hours DataMall answers
 * with nothing — not `{}`, not an empty `Services` array, no attribute tags —
 * so `res.json()` throws and a healthy API at 01:30 is indistinguishable from a
 * broken one. Callers get this sentinel instead and decide what "nothing" means
 * for their endpoint, because the answer differs: no arrivals is legitimate, no
 * stop list is not.
 */
const EMPTY_BODY = Symbol('empty DataMall body');

/**
 * `Retry-After` in either form RFC 9110 allows: delta-seconds, or an HTTP-date.
 * Absent, malformed or already past all return `undefined`, so the breaker
 * falls back to its own window instead of taking a NaN deadline that would
 * never elapse — `Number('Wed, 21 Oct 2015 07:28:00 GMT')` is NaN, and a
 * deadline of NaN compares false against every clock reading forever.
 */
const retryAfterMs = (raw: string | null): number | undefined => {
  const header = raw?.trim();
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : undefined;

  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  const ms = at - Date.now();
  return ms > 0 ? ms : undefined;
};

const request = async (path: string, params: Record<string, string> = {}): Promise<unknown> => {
  if (!config.accountKey) throw new DataMallError('no AccountKey configured');

  const url = new URL(`${config.baseUrl}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  // Counted here rather than at the call sites, so arrivals and the BusStops
  // pull are both covered and a cache hit — which never reaches this function —
  // is correctly not counted. The attempt is what costs the account, so a 429
  // or a 500 counts exactly like a 200.
  calls.record();

  const res = await fetch(url, {
    headers: { AccountKey: config.accountKey, accept: 'application/json' },
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
  });

  if (!res.ok) {
    // Never surface the body — it can echo the key back in error responses.
    // Headers are safe and `Retry-After` is the one upstream asks us to read.
    throw new DataMallError(
      `DataMall ${path} returned ${res.status}`,
      res.status,
      retryAfterMs(res.headers.get('retry-after')),
    );
  }

  // Read as text, not `res.json()`: only a zero-length body is the benign
  // non-operating-hours case. A body that is present but not JSON is upstream
  // misbehaving and stays an error, so backoff and the breaker still see it.
  const text = await res.text();
  if (text.trim() === '') return EMPTY_BODY;

  try {
    return JSON.parse(text);
  } catch {
    throw new DataMallError(`DataMall ${path} returned an unparseable body`, res.status);
  }
};

/**
 * Does this failure mean upstream is refusing us, as opposed to disliking one
 * request? Only 429 and 5xx do. A 404 or a 400 is our bug and would still be
 * our bug in 60 s, so breaking on it buys nothing and hides it.
 *
 * A network error or timeout — no status at all — counts. That is a judgement
 * call, and the argument for it is that the hung-upstream case is exactly the
 * one an open breaker is worth most in: every attempt otherwise holds a socket
 * for the full 8 s `upstreamTimeoutMs`, five at a time, and a full 8-stop board
 * takes 16 s to render nothing. Five consecutive timeouts across every stop on
 * the board is not a flaky socket, and if it was, the cost of being wrong is a
 * 60 s wait ended early by one probe. `DataMallError`s that carry no status are
 * ours, not the network's ("no AccountKey configured"), and are excluded.
 */
const meansUpstreamRefusal = (err: unknown): boolean => {
  if (!(err instanceof DataMallError)) return true;
  if (err.status === undefined) return false;
  return err.status === 429 || err.status >= 500;
};

/**
 * `request()` behind the circuit breaker.
 *
 * Scope note, because the plan (docs/datamall-activation.md §5) says the
 * breaker covers "the whole client" and this deliberately does not: only
 * arrivals are guarded. The stop list calls `request()` directly. Breaking it
 * too would let a run of arrivals failures block the `BusStops` pull, and that
 * pull is what makes the pod ready — a cold start during an arrivals outage
 * would leave `/healthz` at 503 and the board empty, turning degraded timings
 * into total downtime. Nothing is lost by exempting it: the stop list is one
 * call a day, so it cannot be the thing that burns the quota, and its own
 * failure path already keeps the previous list (`stops.ts:63-67`). The call
 * counter still counts every upstream call, this one included.
 */
const guarded = async (path: string, params: Record<string, string> = {}): Promise<unknown> => {
  // Refuse before `fetch`, not around it: an open breaker has to be fast, or it
  // has merely swapped an upstream timeout for a local one.
  if (!breaker.tryAcquire()) {
    throw new DataMallError(`DataMall ${path} not attempted: circuit breaker open`);
  }

  try {
    const body = await request(path, params);
    breaker.recordSuccess();
    return body;
  } catch (err) {
    // Anything else still counts as upstream answering, so it clears the
    // consecutive run and releases a half-open probe. Only a failure that means
    // "stop" may hold the breaker open.
    if (meansUpstreamRefusal(err)) {
      breaker.recordFailure(err instanceof DataMallError ? err.retryAfterMs : undefined);
    } else {
      breaker.recordSuccess();
    }
    throw err;
  }
};

interface RawStop {
  BusStopCode?: string;
  RoadName?: string;
  Description?: string;
  Latitude?: number;
  Longitude?: number;
}

const toStop = (raw: RawStop): BusStop | null => {
  const code = raw.BusStopCode?.trim();
  const lat = Number(raw.Latitude);
  const lon = Number(raw.Longitude);
  if (!code || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // A handful of stops carry 0,0 coordinates. Keep them searchable by name but
  // they would otherwise pollute "nearby" results near the Gulf of Guinea.
  return {
    code,
    roadName: raw.RoadName?.trim() ?? '',
    description: raw.Description?.trim() ?? code,
    lat,
    lon,
  };
};

/**
 * Walks the $skip-paginated BusStops feed to completion. Deliberately calls
 * `request()` rather than `guarded()` — see the note on `guarded()`.
 */
export const fetchAllStops = async (): Promise<BusStop[]> => {
  const stops: BusStop[] = [];
  let skip = 0;

  for (let attempt = 0; attempt < MAX_REQUESTS; attempt += 1) {
    const body = await request('BusStops', { $skip: String(skip) });
    // The stop feed has no non-operating hours, so an empty body here is a
    // failure, not "there are no stops". Throwing keeps `stops.ts` on the
    // previous list; returning what we have so far would silently truncate it
    // mid-pagination, which no zero-length check downstream could catch.
    if (body === EMPTY_BODY) throw new DataMallError('DataMall BusStops returned an empty body');

    const batch = (body as { value?: RawStop[] }).value ?? [];
    // Stop on an empty page, and advance `$skip` by what actually came back
    // rather than by an assumed 500. The guide states the per-call record cap
    // "may be adjusted from time to time" (§1, Table 1) and `$skip` counts
    // records, so treating a short page as the last one would truncate the
    // whole list to a single page the day LTA lowers the cap — and a short
    // list is indistinguishable downstream from a genuinely short feed. The
    // price is one extra request per refresh, which is once a day.
    if (batch.length === 0) return stops;
    skip += batch.length;

    for (const raw of batch) {
      const stop = toStop(raw);
      if (stop) stops.push(stop);
    }
  }

  console.warn(`stop feed hit the ${MAX_REQUESTS}-request ceiling; list may be truncated`);
  return stops;
};

/**
 * Raw shapes for BusRoutes (§2.3) and BusServices (§2.2), checked against the
 * guide on 15 Aug 2026. Named `RawRoute`/`RawServiceInfo` because `RawService`
 * is already taken by the arrivals payload below — a different shape from the
 * same upstream noun.
 */
interface RawRoute {
  ServiceNo?: string;
  Direction?: number | string;
  StopSequence?: number | string;
  BusStopCode?: string;
  WD_FirstBus?: string;
  WD_LastBus?: string;
  SAT_FirstBus?: string;
  SAT_LastBus?: string;
  SUN_FirstBus?: string;
  SUN_LastBus?: string;
}

interface RawServiceInfo {
  ServiceNo?: string;
  Operator?: string;
  Category?: string;
  LoopDesc?: string;
}

/** DataMall writes `-` where a stop has no scheduled bus for that day pattern. */
const toTimes = (wd?: string, sat?: string, sun?: string): RouteStopTimes | undefined => {
  const clean = (value?: string) => {
    const trimmed = value?.trim();
    return trimmed && trimmed !== '-' ? trimmed : '';
  };
  const times = { wd: clean(wd), sat: clean(sat), sun: clean(sun) };
  return times.wd || times.sat || times.sun ? times : undefined;
};

const toRouteStop = (raw: RawRoute): RouteStop | null => {
  const serviceNo = raw.ServiceNo?.trim();
  const code = raw.BusStopCode?.trim();
  const direction = Number(raw.Direction);
  const seq = Number(raw.StopSequence);
  if (!serviceNo || !code || (direction !== 1 && direction !== 2) || !Number.isFinite(seq)) {
    return null;
  }
  return {
    serviceNo,
    direction,
    seq,
    code,
    firstBus: toTimes(raw.WD_FirstBus, raw.SAT_FirstBus, raw.SUN_FirstBus),
    lastBus: toTimes(raw.WD_LastBus, raw.SAT_LastBus, raw.SUN_LastBus),
  };
};

/**
 * Walks the $skip-paginated BusRoutes feed to completion, by the same rules as
 * `fetchAllStops`: advance by what actually came back, terminate on an empty
 * page, treat an empty body as failure — the route feed has no non-operating
 * hours either. Deliberately calls `request()` rather than `guarded()`: the
 * breaker is arrivals-only, and the scope note on `guarded()` says why.
 */
export const fetchAllRoutes = async (): Promise<RouteStop[]> => {
  const routes: RouteStop[] = [];
  let skip = 0;

  for (let attempt = 0; attempt < MAX_ROUTE_REQUESTS; attempt += 1) {
    const body = await request('BusRoutes', { $skip: String(skip) });
    if (body === EMPTY_BODY) throw new DataMallError('DataMall BusRoutes returned an empty body');

    const batch = (body as { value?: RawRoute[] }).value ?? [];
    if (batch.length === 0) return routes;
    skip += batch.length;

    for (const raw of batch) {
      const stop = toRouteStop(raw);
      if (stop) routes.push(stop);
    }
  }

  console.warn(`route feed hit the ${MAX_ROUTE_REQUESTS}-request ceiling; list may be truncated`);
  return routes;
};

const toServiceInfo = (raw: RawServiceInfo): ServiceInfo | null => {
  const serviceNo = raw.ServiceNo?.trim();
  if (!serviceNo) return null;
  return {
    serviceNo,
    operator: raw.Operator?.trim() ?? '',
    category: raw.Category?.trim() ?? '',
    loopDesc: raw.LoopDesc?.trim() ?? '',
  };
};

/**
 * Walks the BusServices feed — one record per service per direction, so a
 * two-direction service appears twice; the caller's map collapses that. A few
 * hundred services is ~2 pages, so `MAX_REQUESTS` is plenty. Unguarded for the
 * same reason as the other bulk walks — see the scope note on `guarded()`.
 */
export const fetchAllServices = async (): Promise<ServiceInfo[]> => {
  const services: ServiceInfo[] = [];
  let skip = 0;

  for (let attempt = 0; attempt < MAX_REQUESTS; attempt += 1) {
    const body = await request('BusServices', { $skip: String(skip) });
    if (body === EMPTY_BODY) throw new DataMallError('DataMall BusServices returned an empty body');

    const batch = (body as { value?: RawServiceInfo[] }).value ?? [];
    if (batch.length === 0) return services;
    skip += batch.length;

    for (const raw of batch) {
      const service = toServiceInfo(raw);
      if (service) services.push(service);
    }
  }

  console.warn(`service feed hit the ${MAX_REQUESTS}-request ceiling; list may be truncated`);
  return services;
};

interface RawBus {
  EstimatedArrival?: string;
  Load?: string;
  Feature?: string;
  Type?: string;
  Monitored?: number | string;
}

interface RawService {
  ServiceNo?: string;
  Operator?: string;
  NextBus?: RawBus;
  NextBus2?: RawBus;
  NextBus3?: RawBus;
}

const isLoad = (value: string | undefined): value is Exclude<Load, null> =>
  value === 'SEA' || value === 'SDA' || value === 'LSD';

/** DataMall uses empty objects and empty strings for "no further bus". */
const toBus = (raw: RawBus | undefined): ArrivalBus | null => {
  const eta = raw?.EstimatedArrival?.trim();
  if (!eta) return null;
  const parsed = new Date(eta);
  if (Number.isNaN(parsed.getTime())) return null;

  return {
    estimatedArrival: parsed.toISOString(),
    load: isLoad(raw?.Load?.trim()) ? (raw?.Load?.trim() as Exclude<Load, null>) : null,
    wheelchairAccessible: raw?.Feature?.trim() === 'WAB',
    type: raw?.Type?.trim() || null,
    monitored: String(raw?.Monitored ?? '1') === '1',
  };
};

export const fetchArrivals = async (stopCode: string): Promise<ArrivalService[]> => {
  const body = await guarded('v3/BusArrival', { BusStopCode: stopCode });
  // No body means no buses are running, which is a legitimate answer rather
  // than a failure. It must map to `[]` so the caller can tell it apart from a
  // failed call, and so task 4's backoff never treats a healthy 01:30 as an
  // outage.
  if (body === EMPTY_BODY) return [];

  return ((body as { Services?: RawService[] }).Services ?? [])
    .map((service) => ({
      serviceNo: service.ServiceNo?.trim() ?? '',
      operator: service.Operator?.trim() ?? '',
      buses: [toBus(service.NextBus), toBus(service.NextBus2), toBus(service.NextBus3)].filter(
        (bus): bus is ArrivalBus => bus !== null,
      ),
    }))
    .filter((service) => service.serviceNo !== '')
    .sort((a, b) =>
      a.serviceNo.localeCompare(b.serviceNo, 'en', { numeric: true, sensitivity: 'base' }),
    );
};
