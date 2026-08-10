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

export type Load = 'SEA' | 'SDA' | 'LSD' | null;

export interface ArrivalBus {
  /** ISO 8601 with +08:00 offset, as DataMall returns it. */
  estimatedArrival: string | null;
  load: Load;
  /** 'WAB' when the bus is wheelchair accessible. */
  wheelchairAccessible: boolean;
  /** 'SD' single deck, 'DD' double deck, 'BD' bendy. */
  type: string | null;
  /** False when the timing is scheduled rather than live-tracked. */
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
