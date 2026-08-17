import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Unit tests for [public/route-logic.js](../public/route-logic.js) — the pure
 * half of the route page. Plain input/output assertions: no timers, no
 * network, no DOM.
 *
 * The specifier below is computed on purpose; leave it that way. It is the
 * same bargain [origin.test.ts](./origin.test.ts) documents: a literal
 * `'../public/route-logic.js'` trips TS2307 and TS6059 under `rootDir: "src"`,
 * while a URL built at runtime is never resolved by tsc, types as `any`, and
 * compiles clean under `strict`.
 */
const routeUrl = new URL('../public/route-logic.js', import.meta.url);
const route = await import(routeUrl.href);

/** Injected clock for everything time-dependent — the module never reads one. */
const NOW = 1_760_000_000_000;

/** Metres per degree of latitude under the module's own Earth radius, so the
 * guard-boundary fixtures land at exactly the distance their names claim. */
const M_PER_DEG = (Math.PI / 180) * 6_371_000;

// --- fixtures --------------------------------------------------------------
//
// One trunk service shaped like the API contract: direction 1 runs 12 stops
// north along a meridian (~334 m apart), direction 2 runs only the first five
// back on the other side of the road (~11 m east), so a translate near the
// top of direction 1 has no candidate within the guard.

const LAT0 = 1.3;
const LON0 = 103.8;
const STEP_DEG = 0.003; // ~334 m

const stopAt = (code: string, lat: number, lon: number, description: string, roadName: string): any =>
  ({ seq: 0, code, description, roadName, lat, lon });

const D1_SEED: Array<[string, string, string]> = [
  ['84009', 'Eunos Int', 'Eunos Rd 8'],
  ['84011', 'Blk 111', 'Sims Ave'],
  ['84021', 'Blk 121', 'Sims Ave'],
  ['84031', 'Aft Eunos Stn', 'Sims Ave East'],
  ['84041', 'Kaki Bukit Ctr', 'Kaki Bukit Ave 1'],
  ['84051', 'Blk 545', 'Bedok North Rd'],
  ['84061', 'Opp Bedok Mall', 'New Upp Changi Rd'],
  ['84071', 'Bedok Stn', 'New Upp Changi Rd'],
  ['84081', 'Blk 216', 'Bedok North St 1'],
  ['84091', 'Blk 88', 'Bedok North Ave 4'],
  ['84101', 'Blk 109', 'Bedok Reservoir Rd'],
  ['43009', 'Bukit Batok Int', 'Bukit Batok Ctrl'],
];
const D1_STOPS: any[] = D1_SEED.map(([code, description, roadName], i) =>
  stopAt(code, LAT0 + i * STEP_DEG, LON0, description, roadName),
);

const D2_SEED: Array<[string, string, string]> = [
  ['84010', 'Opp Eunos Int', 'Eunos Rd 8'],
  ['84012', 'Opp Blk 111', 'Sims Ave'],
  ['84022', 'Opp Blk 121', 'Sims Ave'],
  ['84032', 'Bef Eunos Stn', 'Sims Ave East'],
  ['84042', 'Opp Kaki Bukit Ctr', 'Kaki Bukit Ave 1'],
];
const D2_STOPS: any[] = D2_SEED.map(([code, description, roadName], i) =>
  stopAt(code, LAT0 + i * STEP_DEG, LON0 + 0.0001, description, roadName),
);

const direction = (dir: number, stops: any[]): any => ({
  direction: dir,
  origin: { code: stops[0].code, description: stops[0].description },
  destination: { code: stops[stops.length - 1].code, description: stops[stops.length - 1].description },
  firstBus: { wd: '0530', sat: '0530', sun: '0530' },
  lastBus: { wd: '2345', sat: '2345', sun: '2345' },
  stops: stops.map((s, i) => ({ ...s, seq: i + 1 })),
});

const DIRS: any[] = [direction(1, D1_STOPS), direction(2, D2_STOPS)];

/** A place origin record at a coordinate, as `bus-board.origin.v1` stores it. */
const placeAt = (lat: number, lon: number): string =>
  JSON.stringify({ mode: 'place', postal: null, code: null, label: 'Test', name: 'Test', lat, lon });

/** resolveAnchor with every rung empty unless overridden. */
const resolve = (over: object): any =>
  route.resolveAnchor({
    serviceNo: '61',
    queryStop: null,
    anchorsRaw: null,
    originRaw: null,
    locRaw: null,
    directions: DIRS,
    ...over,
  });

/**
 * The purity tripwire, mirrored from origin.test.ts: the plan states the
 * module holds no DOM, storage, network or clock access, and nothing else
 * enforces it. Comments are stripped first.
 */
describe('route-logic.js module contract', () => {
  it('has no DOM, storage, network or clock access', () => {
    const source = readFileSync(routeUrl, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (const forbidden of ['Date.now', 'document', 'localStorage', 'fetch(']) {
      assert.equal(source.includes(forbidden), false, `route-logic.js must not use ${forbidden}`);
    }
  });

  // The Shared Contract's numbers, pinned so a drive-by "tune" shows up red.
  it('exports the contract constants unchanged', () => {
    assert.equal(route.GUARD_DISTANCE_M, 2000);
    assert.equal(route.UPSTREAM_WINDOW, 4);
    assert.equal(route.DOWNSTREAM_SHOWN, 2);
    assert.equal(route.FOLD_MIN, 3);
    assert.equal(route.ANCHOR_LRU_MAX, 30);
  });

  it('exports the honesty label verbatim', () => {
    assert.equal(
      route.BUS_POSITION_LABEL,
      'Bus position is read from timings at each stop, not GPS — it can jump, and may be approximate.',
    );
  });
});

describe('parseServicePath', () => {
  it('reads the service off /bus/:service', () => {
    assert.equal(route.parseServicePath('/bus/61'), '61');
    assert.equal(route.parseServicePath('/bus/61/'), '61');
  });

  it('uppercases, so 972m and 972M are one service everywhere downstream', () => {
    assert.equal(route.parseServicePath('/bus/972m'), '972M');
  });

  it('rejects what the server would 400', () => {
    assert.equal(route.parseServicePath('/bus/'), null);
    assert.equal(route.parseServicePath('/bus/123456'), null); // 6 chars
    assert.equal(route.parseServicePath('/bus/6%201'), null); // decodes to a space
    assert.equal(route.parseServicePath('/api/board'), null);
    assert.equal(route.parseServicePath('/bus/61/extra'), null);
    assert.equal(route.parseServicePath(null), null);
  });

  it('rejects an undecodable percent-escape rather than throwing', () => {
    assert.equal(route.parseServicePath('/bus/%E0%A4%A'), null);
  });
});

describe('haversineM', () => {
  it('matches the metres-per-degree yardstick along a meridian', () => {
    const d = route.haversineM(1.3, 103.8, 1.3 + 1000 / M_PER_DEG, 103.8);
    assert.ok(Math.abs(d - 1000) < 0.001, `expected ~1000, got ${d}`);
  });

  it('is zero at zero separation', () => {
    assert.equal(route.haversineM(1.3, 103.8, 1.3, 103.8), 0);
  });
});

describe('readAnchors', () => {
  it('reads corrupt input as absent — the readOriginRecord bargain', () => {
    for (const raw of [null, undefined, '', '{', 'null', '[]', '"61"', '[{"61":"84041"}]']) {
      const anchors = route.readAnchors(raw);
      assert.ok(anchors instanceof Map);
      assert.equal(anchors.size, 0, `expected empty for ${JSON.stringify(raw)}`);
    }
  });

  it('keeps valid entries and drops only the bad ones', () => {
    const anchors = route.readAnchors(
      JSON.stringify({ '61': '84041', '93': 12345, X: '8404', '196': '84051', TOOLONG: '84061' }),
    );
    assert.equal(anchors.get('61'), '84041');
    assert.equal(anchors.get('196'), '84051');
    assert.equal(anchors.size, 2);
  });

  it('normalises the service key to upper case', () => {
    assert.equal(route.readAnchors('{"972m":"84041"}').get('972M'), '84041');
  });

  it('caps at 30, keeping the most recent end', () => {
    const record: Record<string, string> = {};
    for (let i = 1; i <= 32; i += 1) record[`S${i}`] = '84041';
    const anchors = route.readAnchors(JSON.stringify(record));
    assert.equal(anchors.size, 30);
    assert.equal(anchors.has('S1'), false);
    assert.equal(anchors.has('S2'), false);
    assert.equal(anchors.has('S32'), true);
  });
});

describe('rememberAnchor', () => {
  it('returns a new Map, so a failed storage write stays visible', () => {
    const before = route.readAnchors('{"61":"84041"}');
    const after = route.rememberAnchor(before, '93', '84051');
    assert.notEqual(after, before);
    assert.equal(before.size, 1);
    assert.equal(after.size, 2);
  });

  it('moves a re-anchored service to the most-recent end', () => {
    let map = route.rememberAnchor(new Map(), 'A1', '84041');
    map = route.rememberAnchor(map, 'B1', '84051');
    map = route.rememberAnchor(map, 'A1', '84061');
    assert.deepEqual([...map.keys()], ['B1', 'A1']);
    assert.equal(map.get('A1'), '84061');
  });

  // The eviction test the task names: the 31st service drops the least recent,
  // and a service re-anchored along the way has earned its survival.
  it('evicts the least recently used at 31', () => {
    let map = new Map<string, string>();
    for (let i = 1; i <= 30; i += 1) map = route.rememberAnchor(map, `S${i}`, '84041');
    map = route.rememberAnchor(map, 'S1', '84051'); // S1 is now most recent
    map = route.rememberAnchor(map, 'S31', '84041'); // 31st distinct service
    assert.equal(map.size, 30);
    assert.equal(map.has('S2'), false, 'S2 became the oldest and should go');
    assert.equal(map.get('S1'), '84051', 'the re-anchored service must survive');
    assert.equal(map.has('S31'), true);
  });

  it('rejects a bad code or service without touching the rest', () => {
    const before = route.rememberAnchor(new Map(), '61', '84041');
    for (const [svc, code] of [
      ['61', '123'],
      ['61', 84041],
      ['toolong', '84051'],
      ['', '84051'],
    ] as Array<[any, any]>) {
      const after = route.rememberAnchor(before, svc, code);
      assert.deepEqual([...after.entries()], [...before.entries()]);
    }
  });
});

describe('resolveAnchor — the ladder', () => {
  // Rung 1: the URL is the most explicit statement of intent there is.
  it('anchors a valid ?stop= with source query and no notices', () => {
    const result = resolve({ queryStop: '84041' });
    assert.equal(result.state, 'anchored');
    assert.equal(result.source, 'query');
    assert.equal(result.code, '84041');
    assert.equal(result.stop.description, 'Kaki Bukit Ctr');
    assert.equal(result.direction, 1);
    assert.deepEqual(result.notices, []);
    assert.equal(result.dropRemembered, false);
  });

  it('finds a direction-2 query stop and says so', () => {
    const result = resolve({ queryStop: '84042' });
    assert.equal(result.source, 'query');
    assert.equal(result.direction, 2);
  });

  // Rung 2: remembered beats inferred, and is never distance-checked —
  // being far from a stop the user chose is not staleness.
  it('anchors the remembered stop with source remembered', () => {
    const result = resolve({ anchorsRaw: '{"61":"84051"}' });
    assert.equal(result.state, 'anchored');
    assert.equal(result.source, 'remembered');
    assert.equal(result.code, '84051');
  });

  it('keeps a remembered anchor even when the origin is far from it', () => {
    // Origin sits at the top terminus, remembered stop near the bottom.
    const result = resolve({
      anchorsRaw: '{"61":"84011"}',
      originRaw: placeAt(LAT0 + 11 * STEP_DEG, LON0),
    });
    assert.equal(result.source, 'remembered');
    assert.equal(result.code, '84011');
  });

  // The stale-query fallthrough the task names: notice, then the next rung.
  // The copy names the service and never says "any more" — a fresh link's stop
  // has no history on this route to have gone stale.
  it('notices a stale ?stop= and continues to the remembered anchor', () => {
    const result = resolve({ queryStop: '99999', anchorsRaw: '{"61":"84051"}' });
    assert.equal(result.state, 'anchored');
    assert.equal(result.source, 'remembered');
    assert.equal(result.notices.length, 1);
    assert.equal(result.notices[0].reason, 'stale-query');
    assert.equal(result.notices[0].code, '99999');
    assert.equal(result.notices[0].message, "Stop 99999 isn't on route 61.");
  });

  // A mangled link was never a stop this app wrote into a URL; naming junk in
  // a chip helps nobody, so it is skipped without a notice.
  it('silently ignores a malformed queryStop', () => {
    const result = resolve({ queryStop: 'abc12' });
    assert.equal(result.state, 'picker');
    assert.deepEqual(result.notices, []);
  });

  it('flags a stale remembered stop for deletion and continues', () => {
    const result = resolve({
      anchorsRaw: '{"61":"99999"}',
      originRaw: placeAt(LAT0 + 5 * STEP_DEG, LON0),
    });
    assert.equal(result.state, 'anchored');
    assert.equal(result.source, 'nearest');
    assert.equal(result.dropRemembered, true, 'the glue must drop the dead key');
    assert.equal(result.notices.length, 1);
    assert.equal(result.notices[0].reason, 'stale-remembered');
    // The remembered rung keeps "any more": this one really was the user's stop.
    assert.match(result.notices[0].message, /isn't on this route any more/);
  });

  // Rung 3, place door: the record carries its own coordinate.
  it('anchors the nearest on-route stop to a place origin, with the distance', () => {
    const result = resolve({ originRaw: placeAt(LAT0 + 5 * STEP_DEG, LON0) });
    assert.equal(result.state, 'anchored');
    assert.equal(result.source, 'nearest');
    assert.equal(result.code, '84051');
    assert.equal(result.distanceM, 0);
  });

  // Rung 3, gps door: the coordinate comes from the last fix, via originCoord,
  // so the route page can never anchor from a different door than the board.
  it('anchors from the last fix when the origin is gps mode', () => {
    const result = resolve({
      originRaw: '{"mode":"gps","at":1}',
      locRaw: JSON.stringify({ lat: LAT0 + 2 * STEP_DEG, lon: LON0, at: NOW }),
    });
    assert.equal(result.source, 'nearest');
    assert.equal(result.code, '84021');
  });

  it('falls to the picker when gps mode holds no fix', () => {
    const result = resolve({ originRaw: '{"mode":"gps","at":1}', locRaw: null });
    assert.equal(result.state, 'picker');
  });

  // The guard boundary, measured with the module's own yardstick: the
  // comparison is ≤ 2000 on the unrounded distance.
  it('auto-anchors at 1999 m', () => {
    const result = resolve({ originRaw: placeAt(LAT0 - 1999 / M_PER_DEG, LON0) });
    assert.equal(result.state, 'anchored');
    assert.equal(result.source, 'nearest');
    assert.equal(result.code, '84009');
    assert.equal(result.distanceM, 1999);
  });

  it('guards at 2001 m, suggesting the stop it refused to assume', () => {
    const result = resolve({ originRaw: placeAt(LAT0 - 2001 / M_PER_DEG, LON0) });
    assert.equal(result.state, 'guard');
    assert.equal(result.suggestion.code, '84009');
    assert.equal(result.suggestion.distanceM, 2001);
    assert.equal(result.suggestion.stop.description, 'Eunos Int');
  });

  // Rung 4: nothing to go on.
  it('lands on the picker with nothing stored at all', () => {
    const result = resolve({});
    assert.equal(result.state, 'picker');
    assert.deepEqual(result.notices, []);
    assert.equal(result.dropRemembered, false);
  });

  it('reads corrupt anchors and origin records as absent, without throwing', () => {
    const result = resolve({ anchorsRaw: '{', originRaw: '{', locRaw: '{' });
    assert.equal(result.state, 'picker');
  });

  it('ignores an origin at 0,0 — the Gulf of Guinea trap', () => {
    const result = resolve({
      originRaw: '{"mode":"gps","at":1}',
      locRaw: '{"lat":0,"lon":0,"at":1}',
    });
    assert.equal(result.state, 'picker');
  });
});

describe('directionFor', () => {
  it('returns the direction entry holding the code', () => {
    assert.equal(route.directionFor(DIRS, '84041').direction, 1);
    assert.equal(route.directionFor(DIRS, '84042').direction, 2);
  });

  it('returns null for a code on neither direction', () => {
    assert.equal(route.directionFor(DIRS, '00000'), null);
    assert.equal(route.directionFor(null, '84041'), null);
  });
});

describe('translateAnchor', () => {
  // The across-road case: the return stop is ~11 m east of the anchor.
  it('finds the stop across the road in the target direction', () => {
    const anchor = D1_STOPS[4]; // Kaki Bukit Ctr
    const result = route.translateAnchor(DIRS, anchor, 2);
    assert.equal(result.stop.code, '84042');
    assert.ok(result.distanceM >= 5 && result.distanceM <= 20, `got ${result.distanceM}`);
  });

  it('translates back to the original side', () => {
    const result = route.translateAnchor(DIRS, D2_STOPS[4], 1);
    assert.equal(result.stop.code, '84041');
  });

  // Direction 2 ends five stops in, so an anchor near the top of direction 1
  // has no return candidate within the guard — picker plus notice, not a
  // 2-km "return stop".
  it('returns null when the nearest candidate is beyond the guard', () => {
    const result = route.translateAnchor(DIRS, D1_STOPS[11], 2);
    assert.equal(result, null);
  });

  it('returns null for a direction that does not exist', () => {
    assert.equal(route.translateAnchor(DIRS, D1_STOPS[4], 3), null);
  });

  it('returns null for an anchor with no usable coordinate', () => {
    assert.equal(route.translateAnchor(DIRS, { code: '84041', lat: 0, lon: 0 }, 2), null);
    assert.equal(route.translateAnchor(DIRS, null, 2), null);
  });
});

describe('searchStops', () => {
  it('matches the description, case-insensitively, with the highlight range', () => {
    const results = route.searchStops(D1_STOPS, 'KAKI');
    assert.equal(results.length, 1);
    assert.equal(results[0].stop.code, '84041');
    const desc = results[0].matches.find((m: any) => m.field === 'description');
    assert.deepEqual(desc, { field: 'description', start: 0, end: 4 });
    // The road matches too, and both are reported so the glue tints both lines.
    const road = results[0].matches.find((m: any) => m.field === 'roadName');
    assert.deepEqual(road, { field: 'roadName', start: 0, end: 4 });
  });

  it('slices back the exact text the range claims', () => {
    const [hit] = route.searchStops(D1_STOPS, 'bukit ctr');
    const match = hit.matches[0];
    assert.equal(
      hit.stop[match.field].slice(match.start, match.end).toLowerCase(),
      'bukit ctr',
    );
  });

  it('matches a partial stop code', () => {
    const results = route.searchStops(D1_STOPS, '8404');
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].matches, [{ field: 'code', start: 0, end: 4 }]);
  });

  it('matches by road name across several stops', () => {
    const results = route.searchStops(D1_STOPS, 'sims ave');
    assert.deepEqual(
      results.map((r: any) => r.stop.code),
      ['84011', '84021', '84031'],
    );
  });

  // [] and null are different answers: [] earns the no-match copy, null keeps
  // the full spine because nothing was searched.
  it('returns [] for a query that matched nothing', () => {
    assert.deepEqual(route.searchStops(D1_STOPS, 'atlantis'), []);
  });

  it('returns null for an empty or one-character query', () => {
    assert.equal(route.searchStops(D1_STOPS, ''), null);
    assert.equal(route.searchStops(D1_STOPS, 'k'), null);
    assert.equal(route.searchStops(D1_STOPS, '  8  '), null);
    assert.equal(route.searchStops(D1_STOPS, null), null);
  });
});

describe('windowFor', () => {
  it('takes the four upstream stops in route order, anchor named separately', () => {
    const window = route.windowFor(D1_STOPS, 6);
    assert.equal(window.anchorCode, '84061');
    assert.deepEqual(window.upstreamCodes, ['84021', '84031', '84041', '84051']);
  });

  // The route-start case the task names: fewer than four exist, so fewer come
  // back — never padding, never a wrap around the terminus.
  it('shrinks the window near the route start', () => {
    assert.deepEqual(route.windowFor(D1_STOPS, 2).upstreamCodes, ['84009', '84011']);
    assert.deepEqual(route.windowFor(D1_STOPS, 0).upstreamCodes, []);
    assert.equal(route.windowFor(D1_STOPS, 0).anchorCode, '84009');
  });

  it('keeps termini, window, anchor and two downstream for the fold plan', () => {
    assert.deepEqual(route.windowFor(D1_STOPS, 6).keepIndices, [0, 2, 3, 4, 5, 6, 7, 8, 11]);
  });

  it('clips the downstream keep at the route end', () => {
    assert.deepEqual(route.windowFor(D1_STOPS, 11).keepIndices, [0, 7, 8, 9, 10, 11]);
  });

  it('returns null for an out-of-range anchor', () => {
    assert.equal(route.windowFor(D1_STOPS, 12), null);
    assert.equal(route.windowFor(D1_STOPS, -1), null);
    assert.equal(route.windowFor([], 0), null);
  });
});

describe('arrivalsParams', () => {
  it('joins the codes into one stops= param', () => {
    const params = new URLSearchParams(route.arrivalsParams(['84041', '84051', '84061']));
    assert.equal(params.get('stops'), '84041,84051,84061');
  });

  // The boardParams idiom: absence, never emptiness. `stops=` would be a
  // request for stop '' rather than a request for nothing.
  it('omits the param entirely with no codes', () => {
    assert.equal(route.arrivalsParams([]), '');
    assert.equal(route.arrivalsParams(null), '');
    assert.equal(route.arrivalsParams(['', null] as any), '');
  });
});

describe('foldPlan', () => {
  it('folds a run of three or more into one row that names its splice', () => {
    const plan = route.foldPlan(D1_STOPS, [0, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(plan, [
      { kind: 'stop', index: 0 },
      { kind: 'fold', count: 3, startIndex: 1 },
      ...[4, 5, 6, 7, 8, 9, 10, 11].map((index) => ({ kind: 'stop', index })),
    ]);
  });

  // The min-3 rule: a fold hiding two stops costs what showing them costs.
  it('renders a run shorter than three as its stops, not a fold', () => {
    const plan = route.foldPlan(D1_STOPS, [0, 3, 11]);
    assert.deepEqual(plan, [
      { kind: 'stop', index: 0 },
      { kind: 'stop', index: 1 },
      { kind: 'stop', index: 2 },
      { kind: 'stop', index: 3 },
      { kind: 'fold', count: 7, startIndex: 4 },
      { kind: 'stop', index: 11 },
    ]);
  });

  it('always keeps both termini, whatever keepIndices says', () => {
    const plan = route.foldPlan(D1_STOPS, [5]);
    assert.deepEqual(plan[0], { kind: 'stop', index: 0 });
    assert.deepEqual(plan[plan.length - 1], { kind: 'stop', index: 11 });
    assert.deepEqual(plan[1], { kind: 'fold', count: 4, startIndex: 1 });
    assert.deepEqual(plan[3], { kind: 'fold', count: 5, startIndex: 6 });
  });

  // Short routes stay unfolded as arithmetic, not as a special case.
  it('leaves a short route fully unfolded', () => {
    const plan = route.foldPlan(D1_STOPS.slice(0, 4), []);
    assert.deepEqual(
      plan,
      [0, 1, 2, 3].map((index) => ({ kind: 'stop', index })),
    );
  });

  it('expands by re-planning with the fold’s own indices kept', () => {
    const before = route.foldPlan(D1_STOPS, [0, 3, 11]);
    const fold = before.find((row: any) => row.kind === 'fold');
    const opened = Array.from({ length: fold.count }, (_, i) => fold.startIndex + i);
    const after = route.foldPlan(D1_STOPS, [0, 3, 11, ...opened]);
    assert.equal(after.every((row: any) => row.kind === 'stop'), true);
    assert.equal(after.length, 12);
  });

  it('returns [] for an empty route and ignores out-of-range keeps', () => {
    assert.deepEqual(route.foldPlan([], [0]), []);
    const plan = route.foldPlan(D1_STOPS.slice(0, 3), [-1, 99, 1.5]);
    assert.deepEqual(
      plan,
      [0, 1, 2].map((index) => ({ kind: 'stop', index })),
    );
  });
});

describe('filterServiceEta', () => {
  const bus = (mins: number): any => ({
    estimatedArrival: new Date(NOW + mins * 60_000).toISOString(),
    load: 'SEA',
    wheelchairAccessible: true,
    type: 'DD',
    monitored: true,
  });
  const entry = {
    code: '84041',
    services: [
      { serviceNo: '61', operator: 'SBST', buses: [bus(3), bus(12)] },
      { serviceNo: '972M', operator: 'SMRT', buses: [bus(7)] },
    ],
  };

  it('returns the named service’s buses', () => {
    const buses = route.filterServiceEta(entry, '61');
    assert.equal(buses.length, 2);
    assert.equal(buses[0].estimatedArrival, new Date(NOW + 3 * 60_000).toISOString());
  });

  it('matches the service case-insensitively', () => {
    assert.equal(route.filterServiceEta(entry, '972m').length, 1);
  });

  // The two absences must stay distinguishable, exactly as types.ts documents
  // them: [] is "nothing running", null is "the fetch failed".
  it('returns [] when the service is not at this stop', () => {
    assert.deepEqual(route.filterServiceEta(entry, '999'), []);
    assert.deepEqual(route.filterServiceEta({ code: '84041', services: [] }, '61'), []);
  });

  it('returns null when the stop’s fetch failed', () => {
    assert.equal(route.filterServiceEta({ code: '84041', services: null }, '61'), null);
    assert.equal(route.filterServiceEta(null, '61'), null);
  });
});

describe('inferBusSegment', () => {
  // Lead timings in route order, furthest upstream first, anchor last.
  const eta = (secs: number, monitored = true): any => ({
    estimatedArrival: new Date(NOW + secs * 1000).toISOString(),
    monitored,
  });

  // The happy path: the near bus has passed stops 0–2, so their lead timing is
  // the *next* vehicle (600–800 s), while stops 3–4 still see the near one
  // (180 s, 300 s). One clean jump between indices 2 and 3 → the bus is there.
  it('places the bus at the single clean jump', () => {
    const window = [eta(600), eta(720), eta(800), eta(180), eta(300)];
    assert.equal(route.inferBusSegment(window, NOW), 2);
  });

  it('places a bus one segment above the anchor', () => {
    // Passed everything but the anchor: the jump sits between indices 3 and 4.
    const window = [eta(500), eta(560), eta(620), eta(700), eta(90)];
    assert.equal(route.inferBusSegment(window, NOW), 3);
  });

  // Conflict: two rises past tolerance means two buses or noise, and the mark
  // must not guess which.
  it('returns null on two jumps', () => {
    const window = [eta(600), eta(900), eta(800), eta(180), eta(300)];
    assert.equal(route.inferBusSegment(window, NOW), null);
  });

  it('returns null when no jump exists — the bus has not entered the window', () => {
    const window = [eta(100), eta(180), eta(240), eta(300), eta(360)];
    assert.equal(route.inferBusSegment(window, NOW), null);
  });

  // A rise of exactly the tolerance is noise; one second past it is a bus.
  it('tolerates rises up to 90 s and counts them past it', () => {
    assert.equal(route.inferBusSegment([eta(270), eta(180), eta(300)], NOW), null);
    assert.equal(route.inferBusSegment([eta(271), eta(180), eta(300)], NOW), 0);
  });

  // Every contributing timing must be monitored: a timetable estimate cannot
  // support a claim about where a physical vehicle is.
  it('returns null when any timing is unmonitored', () => {
    const window = [eta(600), eta(720), eta(800, false), eta(180), eta(300)];
    assert.equal(route.inferBusSegment(window, NOW), null);
  });

  it('returns null on a missing or unparseable timing', () => {
    assert.equal(route.inferBusSegment([eta(600), null, eta(300)], NOW), null);
    assert.equal(
      route.inferBusSegment([eta(600), { estimatedArrival: null, monitored: true }, eta(300)], NOW),
      null,
    );
    assert.equal(
      route.inferBusSegment([eta(600), { estimatedArrival: 'nope', monitored: true }, eta(300)], NOW),
      null,
    );
  });

  it('returns null when a timing has gone stale past the tolerance', () => {
    assert.equal(route.inferBusSegment([eta(600), eta(-200), eta(300)], NOW), null);
  });

  it('returns null with fewer than two stops to compare', () => {
    assert.equal(route.inferBusSegment([eta(300)], NOW), null);
    assert.equal(route.inferBusSegment([], NOW), null);
    assert.equal(route.inferBusSegment(null, NOW), null);
  });
});

describe('busMarkPlacement', () => {
  // Same fixture shape as inferBusSegment above: lead timings in route order,
  // furthest upstream first, anchor last.
  const eta = (secs: number, monitored = true): any => ({
    estimatedArrival: new Date(NOW + secs * 1000).toISOString(),
    monitored,
  });

  // Rung 3. "Arr" is the anchor's own claim to the bus, and it outranks any
  // segment reading the window might also support.
  it('marks the anchor when its lead has arrived', () => {
    assert.deepEqual(route.busMarkPlacement([eta(600), eta(720), eta(-30)], NOW), {
      kind: 'anchor',
    });
    // The boundary: exactly due counts as arrived, not as 0 s away.
    assert.deepEqual(route.busMarkPlacement([eta(600), eta(720), eta(0)], NOW), {
      kind: 'anchor',
    });
    // ...and it wins over the clean single jump in the same window.
    assert.deepEqual(route.busMarkPlacement([eta(600), eta(720), eta(800), eta(-30)], NOW), {
      kind: 'anchor',
    });
  });

  // Rung 2. Past the tolerance the anchor timing is stale rather than arrived,
  // and a mark drawn from it would be claiming a bus nobody is tracking.
  it('draws nothing when the anchor timing has gone stale', () => {
    assert.equal(route.busMarkPlacement([eta(600), eta(720), eta(-120)], NOW), null);
  });

  // Rung 4, mirroring the inferBusSegment cases so the two readings stay in
  // step: the same windows, wrapped.
  it('places a segment at the single clean jump', () => {
    assert.deepEqual(
      route.busMarkPlacement([eta(600), eta(720), eta(800), eta(180), eta(300)], NOW),
      { kind: 'segment', seg: 2 },
    );
    assert.deepEqual(
      route.busMarkPlacement([eta(500), eta(560), eta(620), eta(700), eta(90)], NOW),
      { kind: 'segment', seg: 3 },
    );
  });

  // Rung 5. Every stop still sees the same vehicle — the timings shrink
  // walking upstream from the anchor, with nothing rising past the tolerance —
  // so it has not entered the window yet. Same fixture as inferBusSegment's
  // no-jump case, where the answer is null for a reason this rung must not
  // confuse with the two-jump one below.
  it('puts the mark beyond the window when nothing has jumped', () => {
    assert.deepEqual(
      route.busMarkPlacement([eta(100), eta(180), eta(240), eta(300), eta(360)], NOW),
      { kind: 'beyond' },
    );
  });

  // Rung 6. inferBusSegment answers null for both of the next two, and the
  // ladder must not read that as "beyond".
  it('degrades to approx on two jumps', () => {
    assert.deepEqual(
      route.busMarkPlacement([eta(600), eta(900), eta(800), eta(180), eta(300)], NOW),
      { kind: 'approx' },
    );
  });

  it('degrades to approx when an upstream lead is unreadable', () => {
    // Unmonitored — a timetable estimate cannot place a vehicle.
    assert.deepEqual(
      route.busMarkPlacement([eta(600), eta(720, false), eta(800), eta(180), eta(300)], NOW),
      { kind: 'approx' },
    );
    // Missing entirely — that stop's fetch failed or the service is not on it.
    assert.deepEqual(
      route.busMarkPlacement([eta(600), null, eta(800), eta(180), eta(300)], NOW),
      { kind: 'approx' },
    );
    // Stale upstream, live anchor: only the *anchor* going stale is a null.
    assert.deepEqual(
      route.busMarkPlacement([eta(600), eta(-200), eta(800), eta(180), eta(300)], NOW),
      { kind: 'approx' },
    );
  });

  // Rung 2 again, from the other side: the anchor is the mark's whole subject,
  // so a clean window upstream cannot rescue an unusable anchor timing.
  it('draws nothing when the anchor lead itself is unusable', () => {
    const clean = [eta(600), eta(720), eta(800)];
    assert.equal(route.busMarkPlacement([...clean, eta(180, false)], NOW), null);
    assert.equal(route.busMarkPlacement([...clean, null], NOW), null);
    assert.equal(
      route.busMarkPlacement([...clean, { estimatedArrival: null, monitored: true }], NOW),
      null,
    );
    assert.equal(
      route.busMarkPlacement([...clean, { estimatedArrival: 'nope', monitored: true }], NOW),
      null,
    );
  });

  // The terminus case: one stop in the window and nothing to compare it with.
  // T3 maps 'beyond' here onto the origin-terminus row.
  it('handles a single-element window', () => {
    assert.deepEqual(route.busMarkPlacement([eta(300)], NOW), { kind: 'beyond' });
    assert.deepEqual(route.busMarkPlacement([eta(-30)], NOW), { kind: 'anchor' });
    assert.equal(route.busMarkPlacement([eta(300, false)], NOW), null);
  });

  it('draws nothing with nothing to read', () => {
    assert.equal(route.busMarkPlacement([], NOW), null);
    assert.equal(route.busMarkPlacement(null, NOW), null);
    assert.equal(route.busMarkPlacement(undefined, NOW), null);
  });
});

describe('markTarget', () => {
  // A 20-stop route anchored at 12 gives the real shape: window 8–12, the
  // terminus kept at 0, and therefore a 7-stop fold covering 1–7 whose
  // startIndex + count lands exactly on `from`.
  const stops = Array.from({ length: 20 }, (_, i) => ({ code: String(50000 + i) }));
  const anchorIdx = 12;
  const win = route.windowFor(stops, anchorIdx);
  const from = anchorIdx - win.upstreamCodes.length; // 8
  const plan = route.foldPlan(stops, win.keepIndices);
  const foldAbove = plan.find(
    (row: any) => row.kind === 'fold' && row.startIndex + row.count === from,
  );

  it('has the fixture the rest of this block assumes', () => {
    assert.equal(from, 8);
    assert.deepEqual(foldAbove, { kind: 'fold', count: 7, startIndex: 1 });
  });

  it('puts a segment on the stop being approached, exactly', () => {
    assert.deepEqual(route.markTarget({ kind: 'segment', seg: 0 }, plan, from, anchorIdx), {
      row: { kind: 'stop', index: 9 },
      approx: false,
    });
    // seg 3 is the last gap in a 4-upstream window: the anchor's own row.
    assert.deepEqual(route.markTarget({ kind: 'segment', seg: 3 }, plan, from, anchorIdx), {
      row: { kind: 'stop', index: anchorIdx },
      approx: false,
    });
  });

  it('puts anchor and approx on the anchor row, and only approx admits it', () => {
    assert.deepEqual(route.markTarget({ kind: 'anchor' }, plan, from, anchorIdx), {
      row: { kind: 'stop', index: anchorIdx },
      approx: false,
    });
    assert.deepEqual(route.markTarget({ kind: 'approx' }, plan, from, anchorIdx), {
      row: { kind: 'stop', index: anchorIdx },
      approx: true,
    });
  });

  // Rung 5, folded: the fold row above the window is a range already, so a mark
  // on it claims exactly what is true and takes no approx treatment.
  it('puts beyond on the fold row immediately above the window', () => {
    assert.deepEqual(route.markTarget({ kind: 'beyond' }, plan, from, anchorIdx), {
      row: { kind: 'fold', startIndex: 1 },
      approx: false,
    });
  });

  // The same fold spliced open: its stops are kept, the fold row is gone, and
  // the last row above the window is stop 7 — which the bus is at *or before*.
  it('falls back to the stop above the window when that fold is expanded', () => {
    const expandedPlan = route.foldPlan(stops, [...win.keepIndices, 1, 2, 3, 4, 5, 6, 7]);
    // The downstream fold survives — only the upstream one is spliced open, and
    // only that one was ever a candidate.
    assert.equal(
      expandedPlan.some((row: any) => row.kind === 'fold' && row.startIndex + row.count === from),
      false,
    );
    assert.deepEqual(route.markTarget({ kind: 'beyond' }, expandedPlan, from, anchorIdx), {
      row: { kind: 'stop', index: from - 1 },
      approx: true,
    });
  });

  // A gap under FOLD_MIN never produced a fold row in the first place; same
  // fallback, reached without anyone tapping anything.
  it('falls back the same way when the gap was too small to fold', () => {
    const near = 6; // window 2–6, gap 1 leaves stop 1 rendered on its own
    const nearWin = route.windowFor(stops, near);
    const nearFrom = near - nearWin.upstreamCodes.length;
    const nearPlan = route.foldPlan(stops, nearWin.keepIndices);
    assert.equal(nearFrom, 2);
    assert.equal(
      nearPlan.some((row: any) => row.kind === 'fold' && row.startIndex + row.count === nearFrom),
      false,
    );
    assert.deepEqual(route.markTarget({ kind: 'beyond' }, nearPlan, nearFrom, near), {
      row: { kind: 'stop', index: 1 },
      approx: true,
    });
  });

  // `from === 0`: nothing upstream because there is no route upstream. The
  // origin terminus is a precise reading, not a fallback, so no approx.
  it('puts beyond on the origin terminus when the window starts at the route start', () => {
    const nearAnchor = 3;
    const zeroWin = route.windowFor(stops, nearAnchor);
    const zeroFrom = nearAnchor - zeroWin.upstreamCodes.length;
    assert.equal(zeroFrom, 0);
    const zeroPlan = route.foldPlan(stops, zeroWin.keepIndices);
    assert.deepEqual(route.markTarget({ kind: 'beyond' }, zeroPlan, zeroFrom, nearAnchor), {
      row: { kind: 'stop', index: 0 },
      approx: false,
    });
  });

  // The terminus anchor: one stop in the window, `busMarkPlacement` says
  // 'beyond', and the anchor row and the origin row are the same row.
  it('collapses the terminus anchor onto its own row', () => {
    const termWin = route.windowFor(stops, 0);
    const termPlan = route.foldPlan(stops, termWin.keepIndices);
    assert.deepEqual(route.markTarget({ kind: 'beyond' }, termPlan, 0, 0), {
      row: { kind: 'stop', index: 0 },
      approx: false,
    });
  });

  it('draws nothing without a placement, or with one it does not know', () => {
    assert.equal(route.markTarget(null, plan, from, anchorIdx), null);
    assert.equal(route.markTarget(undefined, plan, from, anchorIdx), null);
    assert.equal(route.markTarget({ kind: 'nonsense' }, plan, from, anchorIdx), null);
  });
});
