import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Three invariants of `StopIndex` that the board's ranking depends on, plus the
 * opposite-stop pairing heuristic behind the stop page's "opposite" chip. The
 * first three are each load-bearing for a rule in `public/origin.js`; if a case
 * there goes red, the client rule it names is silently wrong, not merely
 * untested. The pairing gets its own fixture further down: `MOCK_STOPS` carries
 * the ready-made description pairs (`Opp` / `Bef` / `Aft`) the heuristic reads,
 * and a few synthetic rows cover the cases mock data deliberately lacks.
 *
 * There used to be six. The other three were about `search()`, which this class
 * no longer has: the finder searches addresses through `PlaceIndex`, and the
 * only thing left here for a 5-digit stop code is `get()`, an exact `Map`
 * lookup with nothing to rank.
 *
 * `config` reads the environment once, at import time, and `request()` refuses
 * to call out without an AccountKey, so both have to be in place before
 * `stops.js` is evaluated — hence the dynamic import rather than a static one,
 * the same pattern as `lta.stops.test.ts`. Mock mode would need no stub at all,
 * but `MOCK_STOPS` holds no 0,0 record and one of these three cases is about
 * exactly that record — `nearby()` must drop it, wherever the caller is
 * standing. Each test file is its own process under `node --test`, so the env
 * mutation leaks nowhere.
 */
process.env.LTA_ACCOUNT_KEY = 'test-key';
process.env.LTA_BASE_URL = 'http://datamall.test/ltaodataservice';

const { StopIndex } = await import('./stops.js');
const { MOCK_STOPS } = await import('./mock.js');

/** The coordinate of stop 01012 below, to the digit. */
const ORIGIN = { lat: 1.29684825, lon: 103.85253591 };
const ZERO_COORD_CODE = '46999';

/**
 * Raw `BusStops` records, in feed order. `toStop` drops a record only when the
 * code is missing or a coordinate is non-finite, so the 0,0 row survives into
 * the index — which is what makes `nearby()`'s filter observable here at all.
 * `get('46999')` still returns it, and the client's `isUsableCoord` is what
 * refuses it as an origin.
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
    // The card the board is ranked from sits at the head of this list, and
    // `distanceLabel` renders its `distanceM` of 0 as "Here" for a gps origin.
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

describe('StopIndex.all', () => {
  it('enumerates every stop the index holds, 0,0 rows included', () => {
    // `all()` is enumeration, not ranking: the sitemap needs the 0,0 stop's
    // page listed even though `nearby()` will never surface it.
    const stops = index.all();
    assert.equal(stops.length, index.size);
    assert.ok(stops.some((stop) => stop.code === ZERO_COORD_CODE));
  });
});

describe('StopIndex.distanceFrom', () => {
  it('is zero for a stop at the query coordinate', () => {
    const stop = index.get('01012');
    assert.ok(stop);
    assert.equal(index.distanceFrom(stop, ORIGIN.lat, ORIGIN.lon), 0);
  });
});

/**
 * Second fixture, for `oppositeOf()`. The mock stops already stage every
 * description shape the heuristic reads — `Opp` reciprocity on Demo Ave 1,
 * station exits on one kerb on Demo Ave 2, `Bef`/`Aft` same-kerb pairs on
 * Example Cres and Placeholder St — so they are the fixture verbatim, plus
 * synthetic rows for what mock data deliberately lacks: a cross-road
 * neighbour, a pair beyond the 120 m ceiling, and a 0,0 record. The
 * synthetics sit far from every mock stop so no ring overlaps another test's.
 */
const PAIRING_FEED = [
  ...MOCK_STOPS.map((stop) => ({
    BusStopCode: stop.code,
    RoadName: stop.roadName,
    Description: stop.description,
    Latitude: stop.lat,
    Longitude: stop.lon,
  })),
  // Reciprocal names ~47 m apart, but across a road-name boundary.
  {
    BusStopCode: '70071',
    RoadName: 'Kerb Rd',
    Description: 'Corner Blk',
    Latitude: 1.45,
    Longitude: 103.70,
  },
  {
    BusStopCode: '70079',
    RoadName: 'Junction Ave',
    Description: 'Opp Corner Blk',
    Latitude: 1.4503,
    Longitude: 103.7003,
  },
  // Reciprocal names on one road, but ~300 m apart.
  {
    BusStopCode: '80081',
    RoadName: 'Far Rd',
    Description: 'Far Blk',
    Latitude: 1.46,
    Longitude: 103.71,
  },
  {
    BusStopCode: '80089',
    RoadName: 'Far Rd',
    Description: 'Opp Far Blk',
    Latitude: 1.4627,
    Longitude: 103.71,
  },
  // The 0,0 shape that survives `toStop` (see the header comment above).
  {
    BusStopCode: '90091',
    RoadName: 'Zero Rd',
    Description: 'Zero Blk',
    Latitude: 0,
    Longitude: 0,
  },
];

const pairIndex = new StopIndex();

{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL) => {
    const skip = Number(new URL(input).searchParams.get('$skip') ?? '0');
    return new Response(JSON.stringify({ value: skip === 0 ? PAIRING_FEED : [] }), {
      status: 200,
    });
  }) as typeof fetch;

  try {
    await pairIndex.reload();
  } finally {
    globalThis.fetch = realFetch;
  }
}

if (pairIndex.size !== PAIRING_FEED.length) {
  throw new Error(`pairing fixture did not seed: ${pairIndex.size} of ${PAIRING_FEED.length} stops`);
}

describe('StopIndex.oppositeOf', () => {
  it('pairs a reciprocal Opp pair both ways', () => {
    assert.equal(pairIndex.oppositeOf('10001')?.code, '10009');
    assert.equal(pairIndex.oppositeOf('10009')?.code, '10001');
  });

  it('returns null for a Bef same-kerb pair with no other candidate', () => {
    // 30031 "Example Hawker Ctr" and 30039 "Bef Example Hawker Ctr" share
    // Example Cres and sit well inside the 120 m ring, so both survive to the
    // description rules. Neither names the other with `Opp`, so reciprocity
    // does not fire; `Bef <base>` marks them as one kerb, the drop leaves the
    // road empty, and the chip is rightly withheld — a "cross the road" link
    // to the stop just behind you would be worse than none.
    assert.equal(pairIndex.oppositeOf('30031'), null);
    assert.equal(pairIndex.oppositeOf('30039'), null);
  });

  it('pairs station exits as nearest survivors — the accepted imprecision', () => {
    // "Demo Stn Exit A"/"Exit B" are one kerb in reality, but nothing in the
    // descriptions says so, and the heuristic reads descriptions. They fall
    // through to rule 4 and pair as nearest survivors. Documented here because
    // /api/stop's smoke test asserts this exact expectation for 10011.
    assert.equal(pairIndex.oppositeOf('10011')?.code, '10019');
    assert.equal(pairIndex.oppositeOf('10019')?.code, '10011');
  });

  it('never pairs across a road name, whatever the distance and naming say', () => {
    assert.equal(pairIndex.oppositeOf('70071'), null);
    assert.equal(pairIndex.oppositeOf('70079'), null);
  });

  it('refuses a reciprocal pair beyond the 120 m ceiling', () => {
    assert.equal(pairIndex.oppositeOf('80081'), null);
    assert.equal(pairIndex.oppositeOf('80089'), null);
  });

  it('returns null for an unknown code', () => {
    assert.equal(pairIndex.oppositeOf('99999'), null);
  });

  it('returns null for a stop with 0,0 coordinates', () => {
    assert.equal(pairIndex.oppositeOf('90091'), null);
  });
});
