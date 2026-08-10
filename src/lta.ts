import { config } from './config.js';
import { CircuitBreaker } from './limiter.js';
import type { ArrivalBus, ArrivalService, BusStop, Load } from './types.js';

/**
 * Client for LTA DataMall.
 *
 * Endpoint paths and field names below follow the DataMall API user guide;
 * verify them against the current guide when you activate the account, since
 * LTA has revised paths before (BusArrival -> BusArrivalv2 -> v3/BusArrival).
 */

const PAGE_SIZE = 500;
const MAX_PAGES = 40; // ~20k stops; the real figure is around 5k.

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
 * for the full 8 s `upstreamTimeoutMs`, five at a time, and a 15-stop board
 * takes 24 s to render nothing. Five consecutive timeouts across every stop on
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

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await request('BusStops', { $skip: String(page * PAGE_SIZE) });
    // The stop feed has no non-operating hours, so an empty body here is a
    // failure, not "there are no stops". Throwing keeps `stops.ts` on the
    // previous list; returning what we have so far would silently truncate it
    // mid-pagination, which no zero-length check downstream could catch.
    if (body === EMPTY_BODY) throw new DataMallError('DataMall BusStops returned an empty body');

    const batch = (body as { value?: RawStop[] }).value ?? [];
    for (const raw of batch) {
      const stop = toStop(raw);
      if (stop) stops.push(stop);
    }
    if (batch.length < PAGE_SIZE) return stops;
  }

  console.warn(`stop feed hit the ${MAX_PAGES}-page ceiling; list may be truncated`);
  return stops;
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
