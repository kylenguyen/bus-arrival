export interface BusStop {
  code: string;
  roadName: string;
  description: string;
  lat: number;
  lon: number;
}

/** A stop plus the straight-line distance used to rank it. */
export interface NearbyStop extends BusStop {
  distanceM: number;
}

/**
 * One row of the address finder. Strings arrive ALL CAPS, as the source dump
 * spells them: uppercasing the query is one operation, normalising 121k records
 * would be 121k, and display casing belongs to the client anyway.
 *
 * `postal` and `code` are mutually exclusive and either may be null — an address
 * has a postal code, the 5-digit stop-code escape hatch has a stop code.
 * `postal` is a string, never a number: `Number('018956')` loses the zero.
 */
export interface Place {
  postal: string | null;
  code: string | null;
  building: string;
  block: string;
  road: string;
  lat: number;
  lon: number;
}

export interface PlacesResponse {
  places: Place[];
}

/**
 * First/last scheduled bus at a stop, HHMM strings exactly as DataMall sends
 * them (`"0530"`) — parsing them into clock times is display's problem, and a
 * string survives the leading zero where a number would not.
 */
export interface RouteStopTimes {
  wd: string;
  sat: string;
  sun: string;
}

/**
 * One BusRoutes record: a service calls at stop `code` as its `seq`-th stop
 * travelling in `direction`. `firstBus`/`lastBus` are absent when the feed has
 * no schedule for that day pattern — DataMall writes `-` there.
 */
export interface RouteStop {
  serviceNo: string;
  direction: 1 | 2;
  seq: number;
  code: string;
  firstBus?: RouteStopTimes;
  lastBus?: RouteStopTimes;
}

/**
 * Headway strings from BusServices, raw as DataMall spells them (`"06-08"`,
 * minutes) — formatting for display is the client's job. `null` when the feed
 * writes `-` or omits the field, which it does for services that do not run in
 * that window. AM only: the stop page shows one peak and one off-peak figure,
 * and the PM pair adds two fields nobody reads.
 */
export interface ServiceFreq {
  peak: string | null;
  offpeak: string | null;
}

/** Service-level metadata from BusServices. */
export interface ServiceInfo {
  serviceNo: string;
  operator: string;
  /** DataMall `Category`: TRUNK, FEEDER, EXPRESS and friends. */
  category: string;
  /** Where a loop service turns; empty for a normal two-direction service. */
  loopDesc: string;
  /** DataMall `AM_Peak_Freq` / `AM_Offpeak_Freq`. */
  freq: ServiceFreq;
}

/**
 * One service calling at a stop, for the stop page's schedule table — the
 * per-stop view `RouteStop` records are folded into. A service serving the
 * stop in both directions (or twice on a loop) appears once: per day-type,
 * `firstBus` keeps the earliest time and `lastBus` the latest, where a last
 * bus before 0400 counts as next-day. Empty string still means "no data",
 * exactly as `RouteStopTimes` spells it.
 */
export interface StopService {
  serviceNo: string;
  operator: string;
  firstBus: RouteStopTimes;
  lastBus: RouteStopTimes;
  freq: ServiceFreq;
}

/**
 * A route stop joined against the stop list for display. When a route record's
 * code is missing from `StopIndex` — the two feeds can drift for a day — the
 * join degrades rather than dropping the stop: `description` falls back to the
 * code, `roadName` to `''` and the coordinate to `0,0`, the same "unknown
 * coordinate" a handful of real stops already carry.
 */
export interface RouteStopJoined {
  seq: number;
  code: string;
  description: string;
  roadName: string;
  lat: number;
  lon: number;
}

/** A direction's terminus, joined the same way (no `seq` — position says it). */
export type RouteEndpoint = Omit<RouteStopJoined, 'seq'>;

export interface RouteDirectionPayload {
  direction: 1 | 2;
  origin: RouteEndpoint;
  destination: RouteEndpoint;
  firstBus: RouteStopTimes | null;
  lastBus: RouteStopTimes | null;
  stops: RouteStopJoined[];
}

export interface RouteResponse {
  serviceNo: string;
  operator: string;
  loop: boolean;
  /** Null for a normal two-direction service — the wire shape, unlike the
   *  empty string `RouteService` holds internally. */
  loopDesc: string | null;
  /** Direction 1 first, then 2; a loop service carries one entry. */
  directions: RouteDirectionPayload[];
  fetchedAt: string;
  mock: boolean;
}

/**
 * Everything the stop page needs that is not live arrivals: the stop itself,
 * the opposite-kerb pair when one can be inferred, and the schedule of every
 * service calling there. Arrivals stay on `/api/arrivals` — they are `no-store`
 * and this payload is cacheable.
 */
export interface StopResponse {
  stop: BusStop;
  /** Null when no confident pair exists — the client omits the chip, never
   *  disables it. */
  opposite: Pick<BusStop, 'code' | 'description'> | null;
  services: StopService[];
  fetchedAt: string;
  mock: boolean;
}

export type Load = 'SEA' | 'SDA' | 'LSD' | null;

export interface ArrivalBus {
  /**
   * ISO 8601, normalised to UTC. DataMall sends it with a +08:00 offset
   * (`2024-08-14T16:41:48+08:00`); `lta.ts` reparses and emits the `Z` form, so
   * the client's arithmetic against `Date.now()` never depends on the offset.
   */
  estimatedArrival: string | null;
  load: Load;
  /** DataMall `Feature` is 'WAB' when the bus is wheelchair accessible. */
  wheelchairAccessible: boolean;
  /** DataMall `Type`: 'SD' single deck, 'DD' double deck, 'BD' bendy. */
  type: string | null;
  /** DataMall `Monitored`: 0 means the timing is scheduled, not live-tracked. */
  monitored: boolean;
}

export interface ArrivalService {
  serviceNo: string;
  operator: string;
  buses: ArrivalBus[];
}

/** One card on the board: where the stop is, and what is coming. */
export interface BoardStop extends BusStop {
  /** Null when the visitor has not shared a location. */
  distanceM: number | null;
  pinned: boolean;
  /**
   * Two different absences, and the difference is load-bearing:
   * `[]` means the call succeeded and nothing is running — outside operating
   * hours DataMall answers with no body at all — while `null` means the call
   * itself failed and the rest of the board stands without this stop. Only
   * `null` is a failure signal; backoff and the breaker must ignore `[]`.
   */
  services: ArrivalService[] | null;
}

export interface BoardResponse {
  stops: BoardStop[];
  located: boolean;
  fetchedAt: string;
  mock: boolean;
}

export interface ArrivalsResponse {
  /** `services` splits empty from failed exactly as `BoardStop.services` does. */
  arrivals: Array<{ code: string; services: ArrivalService[] | null }>;
  fetchedAt: string;
  mock: boolean;
}
