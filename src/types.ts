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
