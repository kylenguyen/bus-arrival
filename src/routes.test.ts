import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Invariants of `RouteIndex` the route page depends on. Like a scoring ladder,
 * a route index fails by drawing the wrong spine under a healthy 200, so `curl`
 * cannot verify any of this.
 *
 * Env before the dynamic import, same pattern as `stops.test.ts`: `config`
 * reads the environment once at import time, and these tests need the *live*
 * path — reload through a stubbed `fetch` — because the reload-failure case
 * cannot be provoked in mock mode, where reload never fetches. The mock-mode
 * build is covered through `buildRoutes` directly: `reload()`'s mock branch is
 * exactly `buildRoutes(mockRoutes(), mockServiceInfo())`.
 */
process.env.LTA_ACCOUNT_KEY = 'test-key';
process.env.LTA_BASE_URL = 'http://datamall.test/ltaodataservice';

const { RouteIndex, buildRoutes, compareServiceNos } = await import('./routes.js');
const { mockRoutes, mockServiceInfo } = await import('./mock.js');

/**
 * Raw `BusRoutes` records, deliberately out of StopSequence order so the sort
 * is observable. The seq-2 record of 972M carries first/last times of its own,
 * which the index must ignore: schedule comes from the seq-1 record only.
 *
 * `359` is the loop: LoopDesc set in BusServices, one direction, origin `77009`
 * visited at seq 1 and again at seq 4. `825` has one direction and *no*
 * BusServices record, so its loop flag can only come from the fallback; `107`
 * has two directions and no BusServices record, so its flag must stay false.
 *
 * `61` exists for the reverse index: both directions call at `83059` with
 * different per-stop schedules, so `servicesAt` has a real merge to do —
 * min first / max last per day-type, a past-midnight last bus (`0010` beats
 * `2330`), and `-` day-types that must not erase the other direction's times.
 */
const ROUTE_FEED = [
  // 972M direction 1, shuffled: 3, 1, 2.
  { ServiceNo: '972M', Direction: 1, StopSequence: 3, BusStopCode: '44229' },
  {
    ServiceNo: '972M',
    Direction: 1,
    StopSequence: 1,
    BusStopCode: '44009',
    WD_FirstBus: '0600',
    WD_LastBus: '2330',
    SAT_FirstBus: '0605',
    SAT_LastBus: '2335',
    SUN_FirstBus: '0610',
    SUN_LastBus: '2340',
  },
  {
    ServiceNo: '972M',
    Direction: 1,
    StopSequence: 2,
    BusStopCode: '44119',
    WD_FirstBus: '0611',
    WD_LastBus: '2341',
  },
  // 972M direction 2 — no times anywhere, so both schedules must be null.
  { ServiceNo: '972M', Direction: 2, StopSequence: 1, BusStopCode: '02089' },
  { ServiceNo: '972M', Direction: 2, StopSequence: 2, BusStopCode: '02099' },
  // 359 the loop, origin twice, shuffled: 4, 1, 3, 2.
  { ServiceNo: '359', Direction: 1, StopSequence: 4, BusStopCode: '77009' },
  {
    ServiceNo: '359',
    Direction: 1,
    StopSequence: 1,
    BusStopCode: '77009',
    WD_FirstBus: '0530',
    WD_LastBus: '2345',
  },
  { ServiceNo: '359', Direction: 1, StopSequence: 3, BusStopCode: '77021' },
  { ServiceNo: '359', Direction: 1, StopSequence: 2, BusStopCode: '77011' },
  // 825: one direction, absent from BusServices — loop by fallback.
  { ServiceNo: '825', Direction: 1, StopSequence: 1, BusStopCode: '55009' },
  { ServiceNo: '825', Direction: 1, StopSequence: 2, BusStopCode: '55019' },
  // 107: two directions, absent from BusServices — not a loop.
  { ServiceNo: '107', Direction: 1, StopSequence: 1, BusStopCode: '60011' },
  { ServiceNo: '107', Direction: 2, StopSequence: 1, BusStopCode: '60019' },
  // 61: both directions call at 83059, each with its own per-stop schedule.
  {
    ServiceNo: '61',
    Direction: 1,
    StopSequence: 1,
    BusStopCode: '83059',
    WD_FirstBus: '0610',
    WD_LastBus: '2330',
    SAT_FirstBus: '0700',
    SAT_LastBus: '2200',
    SUN_FirstBus: '-',
    SUN_LastBus: '-',
  },
  { ServiceNo: '61', Direction: 1, StopSequence: 2, BusStopCode: '84549' },
  { ServiceNo: '61', Direction: 2, StopSequence: 1, BusStopCode: '84549' },
  {
    ServiceNo: '61',
    Direction: 2,
    StopSequence: 2,
    BusStopCode: '83059',
    WD_FirstBus: '0545',
    WD_LastBus: '0010',
    SAT_FirstBus: '-',
    SAT_LastBus: '-',
    SUN_FirstBus: '0700',
    SUN_LastBus: '2250',
  },
];

/** One record per direction, as the real feed sends — the index collapses it. */
const SERVICE_FEED = [
  {
    ServiceNo: '972M',
    Operator: 'SMRT',
    Category: 'TRUNK',
    LoopDesc: '',
    AM_Peak_Freq: '06-08',
    AM_Offpeak_Freq: '10-15',
  },
  {
    ServiceNo: '972M',
    Operator: 'SMRT',
    Category: 'TRUNK',
    LoopDesc: '',
    AM_Peak_Freq: '06-08',
    AM_Offpeak_Freq: '10-15',
  },
  // `-` peak and a missing offpeak must both come through as null.
  { ServiceNo: '359', Operator: 'SBST', Category: 'FEEDER', LoopDesc: 'Pasir Ris Dr 1', AM_Peak_Freq: '-' },
  { ServiceNo: '61', Operator: 'SBST', Category: 'TRUNK', LoopDesc: '', AM_Peak_Freq: '05-09' },
];

const stubFetch = (async (input: URL | string) => {
  const url = new URL(String(input));
  const skip = Number(url.searchParams.get('$skip') ?? '0');
  // Page two comes back empty or the walk runs to its request ceiling — both
  // fetchers advance $skip by the records a page actually returned.
  const feed = url.pathname.includes('BusRoutes')
    ? ROUTE_FEED
    : url.pathname.includes('BusServices')
      ? SERVICE_FEED
      : null;
  if (!feed) throw new Error(`unexpected DataMall path: ${url.pathname}`);
  return new Response(JSON.stringify({ value: skip === 0 ? feed : [] }), { status: 200 });
}) as typeof fetch;

const index = new RouteIndex();

{
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch;
  try {
    await index.reload();
  } finally {
    globalThis.fetch = realFetch;
  }
}

// `reload()` swallows its own failures by design, so an unseeded index would
// otherwise surface as a dozen confusing failures instead of one clear one.
if (index.size !== 5) {
  throw new Error(`fixture did not seed: ${index.size} of 5 services`);
}

describe('RouteIndex stop ordering', () => {
  it('sorts a shuffled feed into StopSequence order', () => {
    const service = index.get('972M');
    assert.ok(service);
    assert.deepEqual(service.directions.get(1)?.stops, ['44009', '44119', '44229']);
    assert.deepEqual(service.directions.get(2)?.stops, ['02089', '02099']);
  });

  it('preserves a loop double-visit twice, in visit order', () => {
    const loop = index.get('359');
    assert.ok(loop);
    assert.deepEqual(loop.directions.get(1)?.stops, ['77009', '77011', '77021', '77009']);
  });
});

describe('RouteIndex loop flag', () => {
  it('flags a loop from a non-empty LoopDesc', () => {
    const loop = index.get('359');
    assert.equal(loop?.loop, true);
    assert.equal(loop?.loopDesc, 'Pasir Ris Dr 1');
    assert.equal(loop?.operator, 'SBST');
  });

  it('does not flag a two-direction service with an empty LoopDesc', () => {
    assert.equal(index.get('972M')?.loop, false);
  });

  it('falls back to single-direction when BusServices has no record', () => {
    assert.equal(index.get('825')?.loop, true);
    assert.equal(index.get('107')?.loop, false);
  });
});

describe('RouteIndex first/last bus', () => {
  it('reads schedule from the StopSequence-1 record only', () => {
    const direction = index.get('972M')?.directions.get(1);
    // The seq-2 record's 0611/2341 must not leak in.
    assert.deepEqual(direction?.firstBus, { wd: '0600', sat: '0605', sun: '0610' });
    assert.deepEqual(direction?.lastBus, { wd: '2330', sat: '2335', sun: '2340' });
  });

  it('is null when the seq-1 record carries no times', () => {
    const direction = index.get('972M')?.directions.get(2);
    assert.equal(direction?.firstBus, null);
    assert.equal(direction?.lastBus, null);
  });
});

describe('RouteIndex.get', () => {
  it('is case-insensitive', () => {
    assert.equal(index.get('972m')?.serviceNo, '972M');
    assert.equal(index.get(' 972M ')?.serviceNo, '972M');
  });

  it('returns null for an unknown service', () => {
    assert.equal(index.get('NOPE'), null);
  });
});

describe('compareServiceNos', () => {
  it('orders by numeric prefix, then lexically, letter-only services last', () => {
    const sorted = ['12', '2', '10e', '10', 'NR7'].sort(compareServiceNos);
    assert.deepEqual(sorted, ['2', '10', '10e', '12', 'NR7']);
  });
});

describe('RouteIndex.all', () => {
  it('enumerates every service, in compareServiceNos order', () => {
    const services = index.all();
    assert.equal(services.length, index.size);
    assert.deepEqual(
      services.map((s) => s.serviceNo),
      ['61', '107', '359', '825', '972M'],
    );
  });
});

describe('RouteIndex.servicesAt', () => {
  it('merges a stop served in both directions into one entry, min first / max last per day-type', () => {
    const services = index.servicesAt('83059');
    assert.equal(services.length, 1);
    const entry = services[0];
    assert.ok(entry);
    assert.equal(entry.serviceNo, '61');
    assert.equal(entry.operator, 'SBST');
    // wd first: 0545 (direction 2) beats 0610; sat/sun each exist in one
    // direction only and must survive the other's `-`.
    assert.deepEqual(entry.firstBus, { wd: '0545', sat: '0700', sun: '0700' });
    // wd last: 0010 is past midnight, so it beats 2330 as the latest bus.
    assert.deepEqual(entry.lastBus, { wd: '0010', sat: '2200', sun: '2250' });
  });

  it('lists a loop service once for a stop it visits twice, schedule intact', () => {
    // 359 calls at 77009 at seq 1 (with times) and again at seq 4 (without).
    const services = index.servicesAt('77009');
    assert.deepEqual(services.map((s) => s.serviceNo), ['359']);
    assert.deepEqual(services[0]?.firstBus, { wd: '0530', sat: '', sun: '' });
    assert.deepEqual(services[0]?.lastBus, { wd: '2345', sat: '', sun: '' });
  });

  it('keeps empty times as empty when no record carries a schedule', () => {
    // 84549 is 61's other stop; neither of its records has times, and "no
    // data" must stay '' rather than borrowing 83059's schedule.
    const services = index.servicesAt('84549');
    assert.deepEqual(services.map((s) => s.serviceNo), ['61']);
    assert.deepEqual(services[0]?.firstBus, { wd: '', sat: '', sun: '' });
    assert.deepEqual(services[0]?.lastBus, { wd: '', sat: '', sun: '' });
  });

  it('carries BusServices freq through, with `-` and missing both null', () => {
    assert.deepEqual(index.servicesAt('44009')[0]?.freq, { peak: '06-08', offpeak: '10-15' });
    assert.deepEqual(index.servicesAt('83059')[0]?.freq, { peak: '05-09', offpeak: null });
    // 359's AM_Peak_Freq is `-` and its AM_Offpeak_Freq is absent.
    assert.deepEqual(index.servicesAt('77009')[0]?.freq, { peak: null, offpeak: null });
    // 825 has no BusServices record at all.
    assert.deepEqual(index.servicesAt('55009')[0]?.freq, { peak: null, offpeak: null });
  });

  it('returns [] for an unknown stop', () => {
    assert.deepEqual(index.servicesAt('00000'), []);
  });
});

describe('RouteIndex.reload', () => {
  it('keeps the previous data when a refresh fails', async () => {
    const before = index.loadedAt;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    try {
      await index.reload();
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(index.size, 5);
    assert.deepEqual(index.get('972M')?.directions.get(1)?.stops, ['44009', '44119', '44229']);
    assert.deepEqual(index.servicesAt('44009').map((s) => s.serviceNo), ['972M']);
    assert.equal(index.loadedAt, before);
  });
});

describe('mock-mode build', () => {
  // What `reload()` does when no AccountKey is configured, minus the branch —
  // its mock arm is exactly this call.
  const built = buildRoutes(mockRoutes(), mockServiceInfo());

  it('builds every fixture service', () => {
    const serviceNos = new Set(mockServiceInfo().map((info) => info.serviceNo.toUpperCase()));
    assert.equal(built.services.size, serviceNos.size);
    for (const serviceNo of serviceNos) assert.ok(built.services.has(serviceNo));
  });

  it('builds the fixture loop with its double visit and schedule', () => {
    const loop = built.services.get('52');
    assert.ok(loop);
    assert.equal(loop.loop, true);
    assert.equal(loop.loopDesc, 'Opp Blk 101');
    assert.equal(loop.directions.size, 1);
    assert.deepEqual(loop.directions.get(1)?.stops, ['10001', '10009', '10001']);
    assert.ok(loop.directions.get(1)?.firstBus);
    assert.ok(loop.directions.get(1)?.lastBus);
  });

  it('indexes 10001 with its three services, numerically sorted, times and freq present', () => {
    const services = built.stopServices.get('10001') ?? [];
    // Numeric order — plain string sort would put '167' before '52'.
    assert.deepEqual(services.map((s) => s.serviceNo), ['52', '167', '985']);
    for (const service of services) {
      assert.match(service.firstBus.wd, /^\d{4}$/, `firstBus for ${service.serviceNo}`);
      assert.match(service.lastBus.wd, /^\d{4}$/, `lastBus for ${service.serviceNo}`);
      assert.match(service.freq.peak ?? '', /^\d{2}-\d{2}$/, `freq for ${service.serviceNo}`);
    }
  });

  it('merges the mock loop 52 across its two visits to 10001', () => {
    const entry = built.stopServices.get('10001')?.find((s) => s.serviceNo === '52');
    assert.ok(entry);
    // Visit 1 runs earlier than visit 3 by construction (+2 min per seq), so
    // the merge must keep visit 1's first and visit 3's last.
    const visits = mockRoutes().filter((r) => r.serviceNo === '52' && r.code === '10001');
    assert.equal(visits.length, 2);
    assert.equal(entry.firstBus.wd, visits[0]?.firstBus?.wd);
    assert.equal(entry.lastBus.wd, visits[1]?.lastBus?.wd);
  });
});
