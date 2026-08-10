import { config } from './config.js';
import type { ArrivalBus, ArrivalService, BusStop, Load } from './types.js';

/**
 * Client for LTA DataMall.
 *
 * Endpoint paths and field names below follow the DataMall API user guide;
 * verify them against the current guide when you activate the account, since
 * LTA has revised field sets before (BusArrival -> BusArrivalv2).
 */

const PAGE_SIZE = 500;
const MAX_PAGES = 40; // ~20k stops; the real figure is around 5k.

class DataMallError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DataMallError';
  }
}

const request = async (path: string, params: Record<string, string> = {}): Promise<unknown> => {
  if (!config.accountKey) throw new DataMallError('no AccountKey configured');

  const url = new URL(`${config.baseUrl}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const res = await fetch(url, {
    headers: { AccountKey: config.accountKey, accept: 'application/json' },
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
  });

  if (!res.ok) {
    // Never surface the body — it can echo the key back in error responses.
    throw new DataMallError(`DataMall ${path} returned ${res.status}`, res.status);
  }
  return res.json();
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

/** Walks the $skip-paginated BusStops feed to completion. */
export const fetchAllStops = async (): Promise<BusStop[]> => {
  const stops: BusStop[] = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = (await request('BusStops', { $skip: String(page * PAGE_SIZE) })) as {
      value?: RawStop[];
    };
    const batch = body.value ?? [];
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
  const body = (await request('BusArrivalv2', { BusStopCode: stopCode })) as {
    Services?: RawService[];
  };

  return (body.Services ?? [])
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
