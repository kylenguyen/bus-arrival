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

const { RouteIndex, buildRoutes } = await import('./routes.js');
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
];

/** One record per direction, as the real feed sends — the index collapses it. */
const SERVICE_FEED = [
  { ServiceNo: '972M', Operator: 'SMRT', Category: 'TRUNK', LoopDesc: '' },
  { ServiceNo: '972M', Operator: 'SMRT', Category: 'TRUNK', LoopDesc: '' },
  { ServiceNo: '359', Operator: 'SBST', Category: 'FEEDER', LoopDesc: 'Pasir Ris Dr 1' },
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
if (index.size !== 4) {
  throw new Error(`fixture did not seed: ${index.size} of 4 services`);
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
    assert.equal(index.size, 4);
    assert.deepEqual(index.get('972M')?.directions.get(1)?.stops, ['44009', '44119', '44229']);
    assert.equal(index.loadedAt, before);
  });
});

describe('mock-mode build', () => {
  // What `reload()` does when no AccountKey is configured, minus the branch —
  // its mock arm is exactly this call.
  const built = buildRoutes(mockRoutes(), mockServiceInfo());

  it('builds every fixture service', () => {
    const serviceNos = new Set(mockServiceInfo().map((info) => info.serviceNo.toUpperCase()));
    assert.equal(built.size, serviceNos.size);
    for (const serviceNo of serviceNos) assert.ok(built.has(serviceNo));
  });

  it('builds the fixture loop with its double visit and schedule', () => {
    const loop = built.get('52');
    assert.ok(loop);
    assert.equal(loop.loop, true);
    assert.equal(loop.loopDesc, 'Opp Blk 101');
    assert.equal(loop.directions.size, 1);
    assert.deepEqual(loop.directions.get(1)?.stops, ['10001', '10009', '10001']);
    assert.ok(loop.directions.get(1)?.firstBus);
    assert.ok(loop.directions.get(1)?.lastBus);
  });
});
