import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  STOP_NEARBY_TARGET,
  STOP_PLATE_TARGET,
  STOP_SCHED_TARGET,
  buildStopJsonLd,
  buildStopNearby,
  buildStopPlate,
  buildStopSched,
  hasUsableCoord,
} from './stop-page.js';
import type { BusStop, NearbyStop, StopService } from './types.js';

/**
 * The static stop-page body, pinned by hand-written fixtures — the same
 * bargain as routes.test.ts. Everything here fails as a healthy 200 (a wrong
 * href, an unescaped description, a JSON-LD block that will not parse), so
 * `curl` cannot verify any of it.
 */

const STOP: BusStop = {
  code: '10001',
  roadName: 'Demo Ave 1',
  description: 'Blk 101',
  lat: 1.3521,
  lon: 103.8198,
};

/** A description a hostile feed could carry — every special HTML character. */
const NASTY_STOP: BusStop = {
  code: '99998',
  roadName: `Rd & "Lane" <1>`,
  description: `Blk <&"'>`,
  lat: 1.3,
  lon: 103.8,
};

const service = (serviceNo: string, wdFirst = '0540', wdLast = '2311'): StopService => ({
  serviceNo,
  operator: 'SBST',
  firstBus: { wd: wdFirst, sat: '0545', sun: '0550' },
  lastBus: { wd: wdLast, sat: '2316', sun: '2321' },
  freq: { peak: '06-08', offpeak: '10-15' },
});

/** Text content of an HTML fragment — tags dropped, entities left alone. */
const textOf = (html: string): string => html.replace(/<[^>]*>/g, '');

describe('buildStopPlate', () => {
  const html = buildStopPlate(STOP, { code: '10009', description: 'Opp Blk 101' });

  it('renders the h1 whose text is "<description> (<code>), <roadName>"', () => {
    const h1 = /<h1[^>]*>(.*?)<\/h1>/.exec(html);
    assert.ok(h1?.[1], 'no h1 in the plate');
    // The aria-hidden stencil code leads visually; the heading's readable text
    // carries the prescribed form.
    assert.ok(textOf(h1[1]).includes('Blk 101 (10001), Demo Ave 1'));
  });

  it('keeps the plate structure the client rebuilds — code, name, road spans', () => {
    assert.ok(html.includes('<span class="meta-code" aria-hidden="true">10001</span>'));
    assert.ok(html.includes('<span class="meta-where">Demo Ave 1</span>'));
    assert.ok(html.startsWith('<div id="sp-plate">'), 'must keep the #sp-plate wrapper stop.js targets');
  });

  it('links the opposite stop, and omits the chip when there is none', () => {
    assert.ok(html.includes('href="/stop/10009"'));
    assert.ok(html.includes('Opposite · Opp Blk 101'));
    const alone = buildStopPlate(STOP, null);
    assert.ok(!alone.includes('Opposite'));
    assert.ok(!alone.includes('href="/stop/'));
  });

  it('escapes description and road — <&"\' never reaches the markup raw', () => {
    const nasty = buildStopPlate(NASTY_STOP, null);
    assert.ok(nasty.includes('Blk &lt;&amp;&quot;&#39;&gt;'));
    assert.ok(nasty.includes('Rd &amp; &quot;Lane&quot; &lt;1&gt;'));
    assert.ok(!nasty.includes('Blk <'), 'raw < leaked into the plate');
  });

  it('drops the road (and its comma) cleanly when roadName is empty', () => {
    const bare = buildStopPlate({ ...STOP, roadName: '' }, null);
    const h1 = /<h1[^>]*>(.*?)<\/h1>/.exec(bare);
    assert.ok(h1?.[1]);
    assert.equal(textOf(h1[1]).replace(/\s+/g, ' ').trim(), '10001Blk 101 (10001)'.replace(/\s+/g, ' '));
    assert.ok(!bare.includes('meta-where'));
  });
});

describe('buildStopSched', () => {
  const services = [service('52'), service('167'), service('985')];
  const html = buildStopSched(services);

  it('renders one row per service, each linked to its route page', () => {
    assert.equal((html.match(/scope="row"/g) ?? []).length, 3);
    for (const no of ['52', '167', '985']) {
      assert.ok(html.includes(`href="/bus/${no}"`), `missing /bus/${no}`);
    }
  });

  it('formats first/last per day-type, HHMM to HH:MM', () => {
    assert.ok(html.includes('<td>05:40 – 23:11</td>'));
    assert.ok(html.includes('<td>05:45 – 23:16</td>'));
    assert.ok(html.includes('<td>05:50 – 23:21</td>'));
  });

  it('renders an en dash, never a fake time, for empty or junk schedule data', () => {
    const rows = buildStopSched([
      {
        ...service('61'),
        firstBus: { wd: '', sat: '-', sun: '2400' },
        lastBus: { wd: '', sat: '-', sun: '2400' },
      },
    ]);
    assert.equal((rows.match(/<td>–<\/td>/g) ?? []).length, 3);
  });

  it('collapses to the shell\'s own empty section when no services call here', () => {
    assert.equal(buildStopSched([]), STOP_SCHED_TARGET);
  });
});

describe('buildStopNearby', () => {
  const nearby: NearbyStop[] = [
    { code: '10009', roadName: 'Demo Ave 1', description: 'Opp Blk 101', lat: 1.3524, lon: 103.8201, distanceM: 47 },
    { code: '10011', roadName: 'Demo Ave 2', description: 'Demo Stn Exit A', lat: 1.3489, lon: 103.8231, distanceM: 512 },
  ];
  const html = buildStopNearby(nearby);

  it('links every neighbour with road name and distance in metres', () => {
    assert.ok(html.includes('href="/stop/10009"'));
    assert.ok(html.includes('href="/stop/10011"'));
    assert.ok(html.includes('Demo Ave 1 · 47 m'));
    assert.ok(html.includes('Demo Ave 2 · 512 m'));
  });

  it('renders a bare section — no heading, no card — for an empty list', () => {
    const empty = buildStopNearby([]);
    assert.equal(empty, '<section id="sp-nearby"></section>');
  });
});

describe('buildStopJsonLd', () => {
  /** The script body, exactly as a consumer would slice it out. */
  const bodyOf = (html: string): string => {
    const match = /^<script type="application\/ld\+json">(.*)<\/script>$/s.exec(html);
    assert.ok(match?.[1], 'not a single JSON-LD script tag');
    return match[1];
  };

  it('parses with JSON.parse and carries the BusStop and BreadcrumbList', () => {
    const parsed = JSON.parse(bodyOf(buildStopJsonLd(STOP))) as Array<Record<string, unknown>>;
    assert.equal(parsed.length, 2);
    const [busStop, crumbs] = parsed;
    assert.ok(busStop && crumbs);
    assert.equal(busStop['@type'], 'BusStop');
    assert.equal(busStop.name, 'Blk 101');
    assert.equal(busStop.identifier, '10001');
    assert.deepEqual(busStop.geo, { '@type': 'GeoCoordinates', latitude: 1.3521, longitude: 103.8198 });
    assert.equal((busStop.address as Record<string, unknown>).addressLocality, 'Singapore');
    assert.equal(crumbs['@type'], 'BreadcrumbList');
    const items = crumbs.itemListElement as Array<Record<string, unknown>>;
    assert.equal(items.length, 2);
    assert.equal(items[0]?.item, 'https://ezbus.sg/');
    assert.equal(items[1]?.item, 'https://ezbus.sg/stop/10001');
    assert.equal(items[1]?.name, 'Blk 101 (10001)');
  });

  it('cannot be broken out of: a </script> in the description stays JSON-escaped', () => {
    const hostile: BusStop = { ...STOP, description: 'Blk 1 </script><script>alert(1)' };
    const body = bodyOf(buildStopJsonLd(hostile));
    assert.ok(!body.includes('<'), 'a raw < survived into the script body');
    const parsed = JSON.parse(body) as Array<Record<string, unknown>>;
    // Round-trips: the escape is JSON's own, so the value is untouched.
    assert.equal(parsed[0]?.name, 'Blk 1 </script><script>alert(1)');
  });

  it('omits geo for the 0,0 "unknown coordinate" stops', () => {
    const parsed = JSON.parse(bodyOf(buildStopJsonLd({ ...STOP, lat: 0, lon: 0 }))) as Array<
      Record<string, unknown>
    >;
    assert.ok(parsed[0] && !('geo' in parsed[0]));
  });
});

describe('hasUsableCoord', () => {
  it('rejects 0,0 and non-finite pairs, accepts real coordinates', () => {
    assert.equal(hasUsableCoord(STOP), true);
    assert.equal(hasUsableCoord({ lat: 0, lon: 0 }), false);
    assert.equal(hasUsableCoord({ lat: NaN, lon: 103.8 }), false);
  });
});

describe('shell pairing', () => {
  // The whole injection pattern rests on the shell and the constants matching
  // byte for byte — an edit to one side without the other fails silently as a
  // page that simply stops being injected, which curl in mock mode catches
  // but this catches first and names.
  it('every swap target appears verbatim, exactly once, in public/stop.html', () => {
    const shell = readFileSync(new URL('../public/stop.html', import.meta.url), 'utf8');
    for (const target of [STOP_PLATE_TARGET, STOP_SCHED_TARGET, STOP_NEARBY_TARGET]) {
      assert.equal(shell.split(target).length, 2, `target missing or duplicated: ${target.slice(0, 60)}…`);
    }
  });
});
