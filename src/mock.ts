import type { ArrivalService, BusStop, RouteStop, RouteStopTimes, ServiceInfo } from './types.js';

/**
 * Synthetic stand-in for the DataMall BusStops feed, used only when no
 * AccountKey is configured. Codes, names and coordinates here are made up to
 * be plausible — do NOT treat them as the real stop list. Once the key is in
 * place the real ~5,000-stop feed replaces this wholesale.
 */
export const MOCK_STOPS: BusStop[] = [
  { code: '10001', roadName: 'Demo Ave 1', description: 'Blk 101', lat: 1.3521, lon: 103.8198 },
  { code: '10009', roadName: 'Demo Ave 1', description: 'Opp Blk 101', lat: 1.3524, lon: 103.8201 },
  { code: '10011', roadName: 'Demo Ave 2', description: 'Demo Stn Exit A', lat: 1.3489, lon: 103.8231 },
  { code: '10019', roadName: 'Demo Ave 2', description: 'Demo Stn Exit B', lat: 1.3492, lon: 103.8237 },
  { code: '20021', roadName: 'Sample Rd', description: 'Sample Mall', lat: 1.3005, lon: 103.8384 },
  { code: '20029', roadName: 'Sample Rd', description: 'Opp Sample Mall', lat: 1.3009, lon: 103.8389 },
  { code: '30031', roadName: 'Example Cres', description: 'Example Hawker Ctr', lat: 1.3212, lon: 103.8925 },
  { code: '30039', roadName: 'Example Cres', description: 'Bef Example Hawker Ctr', lat: 1.3216, lon: 103.8931 },
  { code: '40041', roadName: 'Placeholder St', description: 'Placeholder Poly', lat: 1.3762, lon: 103.8492 },
  { code: '40049', roadName: 'Placeholder St', description: 'Aft Placeholder Poly', lat: 1.3767, lon: 103.8497 },
  { code: '50051', roadName: 'Testbed Way', description: 'Testbed Interchange', lat: 1.4043, lon: 103.9021 },
  { code: '60061', roadName: 'Fixture Link', description: 'Fixture Park', lat: 1.2903, lon: 103.8010 },
];

const SERVICES_BY_STOP: Record<string, string[]> = {
  '10001': ['52', '167', '985'],
  '10009': ['52', '167'],
  '10011': ['74', '151', '154', '186'],
  '10019': ['74', '151'],
  '20021': ['36', '77', '106'],
  '20029': ['36', '77'],
  '30031': ['13', '31', '43'],
  '30039': ['13', '31'],
  '40041': ['66', '169', '900'],
  '40049': ['66', '169'],
  '50051': ['2', '24', '39', '168'],
  '60061': ['5', '61'],
};

/**
 * Each service's journey through the mock world, hand-ordered. This is the
 * ordered inverse of SERVICES_BY_STOP and MUST stay that way: a service appears
 * on a stop's arrival board iff that stop appears in the service's route, or
 * mock mode contradicts itself between the board and the route page.
 * `src/mock.test.ts` pins the invariant — edit the two together.
 *
 * The inverse map confines every service to one road, so journeys are short;
 * the stop descriptions decide their shape. 'Opp X' pairs are opposite kerbs,
 * so the return leg uses the other code; 'Bef X' / 'Aft X' / station-exit pairs
 * sit on one kerb, so both legs call at both in reverse order; interchange and
 * park stops are a terminus each leg starts or ends at. '52' is the one loop:
 * out to the opposite kerb and back, origin visited twice, single direction.
 */
const ROUTE_SHAPES: Array<{ serviceNo: string; directions: string[][]; loopDesc?: string }> = [
  // Demo Ave 1 — 10001 (Blk 101) faces 10009 (Opp Blk 101).
  { serviceNo: '52', directions: [['10001', '10009', '10001']], loopDesc: 'Opp Blk 101' },
  { serviceNo: '167', directions: [['10001'], ['10009']] },
  { serviceNo: '985', directions: [['10001'], ['10001']] },
  // Demo Ave 2 — both station exits sit on one kerb.
  { serviceNo: '74', directions: [['10011', '10019'], ['10019', '10011']] },
  { serviceNo: '151', directions: [['10011', '10019'], ['10019', '10011']] },
  { serviceNo: '154', directions: [['10011'], ['10011']] },
  { serviceNo: '186', directions: [['10011'], ['10011']] },
  // Sample Rd — opposite kerbs.
  { serviceNo: '36', directions: [['20021'], ['20029']] },
  { serviceNo: '77', directions: [['20021'], ['20029']] },
  { serviceNo: '106', directions: [['20021'], ['20021']] },
  // Example Cres — 'Bef Example Hawker Ctr' precedes the hawker centre on one run.
  { serviceNo: '13', directions: [['30039', '30031'], ['30031', '30039']] },
  { serviceNo: '31', directions: [['30039', '30031'], ['30031', '30039']] },
  { serviceNo: '43', directions: [['30031'], ['30031']] },
  // Placeholder St — 'Aft Placeholder Poly' follows the poly on one run.
  { serviceNo: '66', directions: [['40041', '40049'], ['40049', '40041']] },
  { serviceNo: '169', directions: [['40041', '40049'], ['40049', '40041']] },
  { serviceNo: '900', directions: [['40041'], ['40041']] },
  // Testbed Interchange and Fixture Park — single stops, a terminus for each leg.
  { serviceNo: '2', directions: [['50051'], ['50051']] },
  { serviceNo: '24', directions: [['50051'], ['50051']] },
  { serviceNo: '39', directions: [['50051'], ['50051']] },
  { serviceNo: '168', directions: [['50051'], ['50051']] },
  { serviceNo: '5', directions: [['60061'], ['60061']] },
  { serviceNo: '61', directions: [['60061'], ['60061']] },
];

const OPERATORS = ['SBST', 'SMRT', 'TTS', 'GAS'];
const LOADS = ['SEA', 'SEA', 'SDA', 'LSD'] as const;
const TYPES = ['SD', 'DD', 'DD', 'BD'];

/** Cheap deterministic hash so a given stop/service pair looks stable-ish. */
const hash = (input: string): number => {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) h = (h * 31 + input.charCodeAt(i)) | 0;
  return Math.abs(h);
};

/**
 * Fabricates arrivals that actually tick down as the clock advances, so the
 * frontend's refresh loop and relative-time rendering can be exercised
 * properly without an upstream.
 */
export const mockArrivals = (stopCode: string, now = new Date()): ArrivalService[] => {
  const services = SERVICES_BY_STOP[stopCode] ?? ['1', '2'];
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();

  return services.map((serviceNo) => {
    const seed = hash(`${stopCode}:${serviceNo}`);
    // Phase each service differently, then walk it with the clock so timings
    // count down and wrap around instead of sitting frozen.
    const headway = 6 + (seed % 9);
    const phase = (seed + minuteOfDay) % headway;
    const first = headway - phase;

    const buses = [first, first + headway, first + headway * 2].map((offsetMin, index) => {
      const at = new Date(now.getTime() + offsetMin * 60_000 + (seed % 60) * 1_000);
      return {
        estimatedArrival: at.toISOString(),
        load: LOADS[(seed + index) % LOADS.length] ?? null,
        wheelchairAccessible: seed % 3 !== 0,
        type: TYPES[(seed + index) % TYPES.length] ?? null,
        monitored: (seed + index) % 7 !== 0,
      };
    });

    return {
      serviceNo,
      operator: OPERATORS[seed % OPERATORS.length] ?? 'SBST',
      buses,
    };
  });
};

const hhmm = (minuteOfDay: number): string => {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
};

const firstLast = (minuteOfDay: number): RouteStopTimes => ({
  wd: hhmm(minuteOfDay),
  sat: hhmm(minuteOfDay + 5),
  sun: hhmm(minuteOfDay + 10),
});

/**
 * Flattened route records in the shape the live BusRoutes mapper produces.
 * Every record carries per-stop first/last times, as the real feed does — the
 * RouteIndex reads the seq-1 record for the route page's terminus schedule and
 * every record for the stop page's reverse index, and a fixture with times on
 * seq 1 only would leave the second path unexercised. Each stop down the leg
 * runs two minutes later than the one before, so a stop a service visits twice
 * gets two different schedules and the min/max merge is observable.
 */
export const MOCK_ROUTES: RouteStop[] = ROUTE_SHAPES.flatMap(({ serviceNo, directions }) =>
  directions.flatMap((codes, dirIndex) =>
    codes.map((code, i): RouteStop => {
      const seed = hash(serviceNo);
      return {
        serviceNo,
        direction: dirIndex === 0 ? 1 : 2,
        seq: i + 1,
        code,
        firstBus: firstLast(5 * 60 + 30 + (seed % 30) + i * 2),
        lastBus: firstLast(23 * 60 + (seed % 45) + i * 2),
      };
    }),
  ),
);

/** Per-service metadata matching MOCK_ROUTES; loopDesc set on the one loop. */
export const MOCK_SERVICE_INFO: ServiceInfo[] = ROUTE_SHAPES.map(({ serviceNo, loopDesc }) => ({
  serviceNo,
  operator: OPERATORS[hash(serviceNo) % OPERATORS.length] ?? 'SBST',
  category: loopDesc === undefined ? 'TRUNK' : 'FEEDER',
  loopDesc: loopDesc ?? '',
  // Plausible headways so the stop page's freq column has something to show;
  // seeded like everything else here, so a service keeps its figures.
  freq: {
    peak: `${String(5 + (hash(serviceNo) % 4)).padStart(2, '0')}-${String(9 + (hash(serviceNo) % 4)).padStart(2, '0')}`,
    offpeak: `${10 + (hash(serviceNo) % 5)}-${15 + (hash(serviceNo) % 5)}`,
  },
}));

export const mockRoutes = (): RouteStop[] => MOCK_ROUTES;

export const mockServiceInfo = (): ServiceInfo[] => MOCK_SERVICE_INFO;
