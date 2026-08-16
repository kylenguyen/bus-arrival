import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { ROUTE_STATIC_TARGET, buildRouteJsonLd, buildRouteStatic } from './route-page.js';
import type { RouteDirectionPayload, RouteStopJoined } from './types.js';

/**
 * The static route-page body, pinned by hand-written fixtures — the same
 * bargain as stop-page.test.ts. Everything here fails as a healthy 200 (a
 * mis-ordered list, a collapsed loop duplicate, a JSON-LD block that will not
 * parse), so `curl` cannot verify any of it.
 */

const joined = (
  code: string,
  seq: number,
  description: string,
  roadName: string,
): RouteStopJoined => ({ seq, code, description, roadName, lat: 1.35, lon: 103.82 });

/** A join miss, exactly as joinRouteStop degrades it: code as description. */
const missed = (code: string, seq: number): RouteStopJoined => ({
  seq,
  code,
  description: code,
  roadName: '',
  lat: 0,
  lon: 0,
});

const direction = (
  dir: 1 | 2,
  stops: RouteStopJoined[],
  times: Partial<Pick<RouteDirectionPayload, 'firstBus' | 'lastBus'>> = {},
): RouteDirectionPayload => {
  const first = stops[0];
  const last = stops[stops.length - 1];
  assert.ok(first && last, 'fixture direction needs stops');
  return {
    direction: dir,
    origin: { code: first.code, description: first.description, roadName: first.roadName, lat: first.lat, lon: first.lon },
    destination: { code: last.code, description: last.description, roadName: last.roadName, lat: last.lat, lon: last.lon },
    // `in`, not `??`: a fixture passing an explicit null means "the feed has
    // no schedule" and must not be papered over with the default.
    firstBus: 'firstBus' in times ? (times.firstBus ?? null) : { wd: '0530', sat: '0535', sun: '0540' },
    lastBus: 'lastBus' in times ? (times.lastBus ?? null) : { wd: '2330', sat: '2335', sun: '2340' },
    stops,
  };
};

const TRUNK = { serviceNo: '74', operator: 'SBST', loop: false, loopDesc: '' };
const LOOP = { serviceNo: '52', operator: 'SBST', loop: true, loopDesc: 'Opp Blk 101' };

const TRUNK_DIRECTIONS = [
  direction(1, [
    joined('10011', 1, 'Demo Stn Exit A', 'Demo Ave 2'),
    joined('10019', 2, 'Demo Stn Exit B', 'Demo Ave 2'),
  ]),
  direction(2, [
    joined('10019', 1, 'Demo Stn Exit B', 'Demo Ave 2'),
    joined('10011', 2, 'Demo Stn Exit A', 'Demo Ave 2'),
  ]),
];

describe('buildRouteStatic', () => {
  const html = buildRouteStatic(TRUNK, TRUNK_DIRECTIONS);

  it('renders one card and one <ol> per direction', () => {
    assert.equal((html.match(/<ol class="rt-stops">/g) ?? []).length, 2);
    assert.equal((html.match(/class="card rt-dir"/g) ?? []).length, 2);
    assert.ok(html.includes('To Demo Stn Exit B'));
    assert.ok(html.includes('To Demo Stn Exit A'));
  });

  it('keeps each <ol> in the input seq order', () => {
    const lists = [...html.matchAll(/<ol class="rt-stops">(.*?)<\/ol>/gs)].map((m) => m[1] ?? '');
    assert.equal(lists.length, 2);
    const codesOf = (list: string) => [...list.matchAll(/href="\/stop\/(\d{5})"/g)].map((m) => m[1]);
    assert.deepEqual(codesOf(lists[0] ?? ''), ['10011', '10019']);
    assert.deepEqual(codesOf(lists[1] ?? ''), ['10019', '10011']);
  });

  it('links every stop to its stop page with description and road', () => {
    assert.ok(html.includes('href="/stop/10011"'));
    assert.ok(html.includes('<span class="nb-name">Demo Stn Exit A</span>'));
    assert.ok(html.includes('<span class="nb-sub">Demo Ave 2</span>'));
  });

  it('carries the operator and the direction first/last bus line', () => {
    assert.ok(html.includes('Operated by SBST.'));
    assert.ok(html.includes('2 stops · first bus – last: weekdays 05:30 – 23:30 · Sat 05:35 – 23:35 · Sun 05:40 – 23:40'));
  });

  it('renders no times line when the feed has no schedule, no fake dashes', () => {
    const bare = buildRouteStatic(TRUNK, [
      direction(1, TRUNK_DIRECTIONS[0]?.stops ?? [], { firstBus: null, lastBus: null }),
    ]);
    assert.ok(bare.includes('<p class="rt-dir-meta">2 stops</p>'));
    assert.ok(!bare.includes('first bus'));
  });

  it('keeps a loop\'s duplicated origin — 10001 appears twice, in order', () => {
    const loopHtml = buildRouteStatic(LOOP, [
      direction(1, [
        joined('10001', 1, 'Blk 101', 'Demo Ave 1'),
        joined('10009', 2, 'Opp Blk 101', 'Demo Ave 1'),
        joined('10001', 3, 'Blk 101', 'Demo Ave 1'),
      ]),
    ]);
    assert.equal((loopHtml.match(/href="\/stop\/10001"/g) ?? []).length, 2);
    assert.ok(loopHtml.includes('⟲ Loop at Opp Blk 101'));
    const codes = [...loopHtml.matchAll(/href="\/stop\/(\d{5})"/g)].map((m) => m[1]);
    assert.deepEqual(codes, ['10001', '10009', '10001']);
  });

  it('falls back to the origin description for a loop with an empty loopDesc', () => {
    const loopHtml = buildRouteStatic({ ...LOOP, loopDesc: '' }, [
      direction(1, [joined('10001', 1, 'Blk 101', 'Demo Ave 1'), joined('10001', 2, 'Blk 101', 'Demo Ave 1')]),
    ]);
    assert.ok(loopHtml.includes('⟲ Loop at Blk 101'));
  });

  it('renders a join-miss as its bare code, with no road span', () => {
    const html = buildRouteStatic(TRUNK, [
      direction(1, [joined('10011', 1, 'Demo Stn Exit A', 'Demo Ave 2'), missed('99997', 2)]),
    ]);
    assert.ok(html.includes('href="/stop/99997"'));
    assert.ok(html.includes('<span class="nb-name">99997</span></a>'), 'code must stand in as description');
  });

  it('escapes descriptions and roads — <&"\' never reaches the markup raw', () => {
    const nasty = buildRouteStatic({ ...TRUNK, operator: 'S&B <T>' }, [
      direction(1, [
        joined('10011', 1, `Blk <&"'>`, `Rd & "Lane" <1>`),
        joined('10019', 2, 'Plain', 'Rd'),
      ]),
    ]);
    assert.ok(nasty.includes('Blk &lt;&amp;&quot;&#39;&gt;'));
    assert.ok(nasty.includes('Rd &amp; &quot;Lane&quot; &lt;1&gt;'));
    assert.ok(nasty.includes('Operated by S&amp;B &lt;T&gt;.'));
    assert.ok(!nasty.includes('Blk <'), 'raw < leaked into the list');
  });

  it('collapses to the shell\'s own generic section for empty input', () => {
    assert.equal(buildRouteStatic(TRUNK, []), ROUTE_STATIC_TARGET);
  });

  it('omits the operator line when the feed gave none', () => {
    const html = buildRouteStatic({ ...TRUNK, operator: '' }, TRUNK_DIRECTIONS);
    assert.ok(!html.includes('Operated by'));
  });
});

describe('buildRouteJsonLd', () => {
  /** The script body, exactly as a consumer would slice it out. */
  const bodyOf = (html: string): string => {
    const match = /^<script type="application\/ld\+json">(.*)<\/script>$/s.exec(html);
    assert.ok(match?.[1], 'not a single JSON-LD script tag');
    return match[1];
  };

  const stops = TRUNK_DIRECTIONS[0]?.stops ?? [];

  it('parses with JSON.parse and carries the BreadcrumbList and ItemList', () => {
    const parsed = JSON.parse(bodyOf(buildRouteJsonLd('74', stops))) as Array<Record<string, unknown>>;
    assert.equal(parsed.length, 2);
    const [crumbs, list] = parsed;
    assert.ok(crumbs && list);
    assert.equal(crumbs['@type'], 'BreadcrumbList');
    const trail = crumbs.itemListElement as Array<Record<string, unknown>>;
    assert.equal(trail.length, 3);
    assert.equal(trail[0]?.item, 'https://ezbus.sg/');
    assert.equal(trail[1]?.item, 'https://ezbus.sg/buses');
    assert.equal(trail[1]?.name, 'Buses');
    assert.equal(trail[2]?.item, 'https://ezbus.sg/bus/74');
    assert.equal(trail[2]?.name, 'Bus 74');

    assert.equal(list['@type'], 'ItemList');
    assert.equal(list.numberOfItems, 2);
    const items = list.itemListElement as Array<Record<string, unknown>>;
    assert.deepEqual(
      items.map((item) => [item.position, item.name, item.url]),
      [
        [1, 'Demo Stn Exit A', 'https://ezbus.sg/stop/10011'],
        [2, 'Demo Stn Exit B', 'https://ezbus.sg/stop/10019'],
      ],
    );
  });

  it('cannot be broken out of: a </script> in a description stays JSON-escaped', () => {
    const hostile = [{ code: '10011', description: 'A </script><script>alert(1)' }];
    const body = bodyOf(buildRouteJsonLd('74', hostile));
    assert.ok(!body.includes('<'), 'a raw < survived into the script body');
    const parsed = JSON.parse(body) as Array<Record<string, unknown>>;
    const items = parsed[1]?.itemListElement as Array<Record<string, unknown>>;
    // Round-trips: the escape is JSON's own, so the value is untouched.
    assert.equal(items[0]?.name, 'A </script><script>alert(1)');
  });
});

describe('shell pairing', () => {
  // The whole injection pattern rests on the shell and the constant matching
  // byte for byte — an edit to one side without the other fails silently as a
  // page that simply stops being injected, which curl in mock mode catches
  // but this catches first and names.
  it('the swap target appears verbatim, exactly once, in public/route.html', () => {
    const shell = readFileSync(new URL('../public/route.html', import.meta.url), 'utf8');
    assert.equal(
      shell.split(ROUTE_STATIC_TARGET).length,
      2,
      `target missing or duplicated: ${ROUTE_STATIC_TARGET.slice(0, 60)}…`,
    );
  });
});
