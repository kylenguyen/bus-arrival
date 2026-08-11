import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Six invariants of `StopIndex` that the client's first-run journey depends on.
 * Each one is load-bearing for a rule in `public/origin.js`; if a case here
 * goes red, the client rule it names is silently wrong, not merely untested.
 *
 * `config` reads the environment once, at import time, and `request()` refuses
 * to call out without an AccountKey, so both have to be in place before
 * `stops.js` is evaluated — hence the dynamic import rather than a static one,
 * the same pattern as `lta.stops.test.ts`. Mock mode would need no stub at all,
 * but `MOCK_STOPS` holds no 0,0 record and two of these six cases are about
 * exactly that record. Each test file is its own process under `node --test`,
 * so the env mutation leaks nowhere.
 */
process.env.LTA_ACCOUNT_KEY = 'test-key';
process.env.LTA_BASE_URL = 'http://datamall.test/ltaodataservice';

const { StopIndex } = await import('./stops.js');

/** The coordinate of stop 01012 below, to the digit. */
const ORIGIN = { lat: 1.29684825, lon: 103.85253591 };
const ZERO_COORD_CODE = '46999';

/**
 * Raw `BusStops` records, in feed order. `toStop` drops a record only when the
 * code is missing or a coordinate is non-finite, so the 0,0 row survives into
 * the index — which is what makes the nearby/search split observable here.
 *
 * 431791 leads and 43179 trails deliberately: feed order is the ranking a
 * scoreless implementation would produce, so the exact-match case cannot pass
 * by accident of insertion order.
 */
const FEED = [
  {
    BusStopCode: '431791',
    RoadName: 'Woodlands Ave 1',
    Description: 'Blk 869A',
    Latitude: 1.4302,
    Longitude: 103.789,
  },
  {
    BusStopCode: '01012',
    RoadName: 'Victoria St',
    Description: 'Hotel Grand Pacific',
    Latitude: ORIGIN.lat,
    Longitude: ORIGIN.lon,
  },
  {
    BusStopCode: '01013',
    RoadName: 'Victoria St',
    Description: "St. Joseph's Ch",
    Latitude: 1.2977097,
    Longitude: 103.8504056,
  },
  {
    BusStopCode: ZERO_COORD_CODE,
    RoadName: 'Nowhere Rd',
    Description: 'Zeroland Ter',
    Latitude: 0,
    Longitude: 0,
  },
  {
    BusStopCode: '43179',
    RoadName: 'Woodlands Ave 5',
    Description: 'Woodlands Int',
    Latitude: 1.438,
    Longitude: 103.7855,
  },
];

const index = new StopIndex();

{
  const realFetch = globalThis.fetch;
  // `fetchAllStops` advances `$skip` by the records a page returned and halts on
  // the first empty page, so page two has to come back empty or the walk runs
  // to its request ceiling.
  globalThis.fetch = (async (input: URL) => {
    const skip = Number(new URL(input).searchParams.get('$skip') ?? '0');
    return new Response(JSON.stringify({ value: skip === 0 ? FEED : [] }), { status: 200 });
  }) as typeof fetch;

  try {
    await index.reload();
  } finally {
    globalThis.fetch = realFetch;
  }
}

// `reload()` swallows its own failures by design, so an unseeded index would
// otherwise show up as six confusing failures instead of one clear one.
if (index.size !== FEED.length) {
  throw new Error(`fixture did not seed: ${index.size} of ${FEED.length} stops`);
}

describe('StopIndex.nearby', () => {
  it('puts the stop you are standing at first, at zero metres', () => {
    // `distanceLabel`'s `(This stop)` and `shouldShowDelistedNote` both read the
    // origin stop off the head of this list and expect distanceM to be 0 there.
    const stops = index.nearby(ORIGIN.lat, ORIGIN.lon);
    assert.equal(stops[0]?.code, '01012');
    assert.equal(stops[0]?.distanceM, 0);
  });

  it('excludes a 0,0 stop even when there is room for it', () => {
    // The default limit is 8 and the fixture holds 5, so the one absentee is the
    // filter at work, not truncation.
    const stops = index.nearby(ORIGIN.lat, ORIGIN.lon);
    assert.equal(stops.length, FEED.length - 1);
    assert.ok(!stops.some((stop) => stop.code === ZERO_COORD_CODE));
  });
});

describe('StopIndex.search', () => {
  it('keeps a 0,0 stop findable by name', () => {
    // The other half of the AGENTS.md split, and the reason the client carries
    // its own `isUsableStopCoord` guard: a search result may be uncommittable.
    const results = index.search('zeroland');
    assert.deepEqual(
      results.map((stop) => stop.code),
      [ZERO_COORD_CODE],
    );
    const stop = results[0];
    assert.ok(stop);
    assert.equal(stop.lat, 0);
    assert.equal(stop.lon, 0);
  });

  it('ranks an exact code match above a code that merely starts with the query', () => {
    // `commitDecision` commits on Enter by finding `code === query` in the
    // results; ranking the exact match first is what keeps it inside `limit`.
    const results = index.search('43179');
    assert.equal(results[0]?.code, '43179');
    assert.ok(
      results.some((stop) => stop.code === '431791'),
      'the prefix match is present, just ranked below',
    );
  });

  it('returns nothing below two characters', () => {
    // The guard that lets the client query on every keystroke without `/api/stops`
    // answering 400.
    assert.deepEqual(index.search('4'), []);
    assert.deepEqual(index.search(''), []);
  });
});

describe('StopIndex.distanceFrom', () => {
  it('is zero for a stop at the query coordinate', () => {
    const stop = index.get('01012');
    assert.ok(stop);
    assert.equal(index.distanceFrom(stop, ORIGIN.lat, ORIGIN.lon), 0);
  });
});
