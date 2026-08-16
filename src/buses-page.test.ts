import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { BUSES_LIST_TARGET, buildBusesIndex, type BusesRow } from './buses-page.js';

/**
 * The /buses directory, pinned by hand-written fixtures — the same bargain as
 * stop-page.test.ts and route-page.test.ts. Everything here fails as a healthy
 * 200 (a mis-ordered directory, a dropped row, a raw `<` in a description), so
 * `curl` cannot verify any of it.
 */

const row = (overrides: Partial<BusesRow> & Pick<BusesRow, 'serviceNo'>): BusesRow => ({
  operator: 'SBST',
  loop: false,
  loopDesc: '',
  origin: 'Demo Stn Exit A',
  destination: 'Demo Stn Exit B',
  ...overrides,
});

const FLEET: BusesRow[] = [
  row({ serviceNo: '52', loop: true, loopDesc: 'Opp Blk 101', origin: 'Blk 101', destination: 'Blk 101' }),
  row({ serviceNo: '74' }),
  row({ serviceNo: '167', operator: 'SMRT' }),
  row({ serviceNo: '985' }),
];

describe('buildBusesIndex', () => {
  const html = buildBusesIndex(FLEET);

  it('renders one linked row per service', () => {
    assert.equal((html.match(/<li>/g) ?? []).length, 4);
    for (const service of FLEET) {
      assert.ok(html.includes(`href="/bus/${service.serviceNo}"`), `missing /bus/${service.serviceNo}`);
    }
  });

  it('keeps the caller\'s order — the sort is decided in routes.ts, not here', () => {
    const nos = [...html.matchAll(/href="\/bus\/([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(nos, ['52', '74', '167', '985']);
  });

  it('sets the service number in the stencil face span', () => {
    assert.ok(html.includes('<span class="service-no">74</span>'));
  });

  it('summarises a two-direction service as origin → destination', () => {
    assert.ok(html.includes('<span class="nb-name">Demo Stn Exit A → Demo Stn Exit B</span>'));
  });

  it('summarises a loop by its turn, and falls back to the origin without one', () => {
    assert.ok(html.includes('<span class="nb-name">⟲ Loop at Opp Blk 101</span>'));
    const bare = buildBusesIndex([row({ serviceNo: '52', loop: true, loopDesc: '', origin: 'Blk 101' })]);
    assert.ok(bare.includes('<span class="nb-name">⟲ Loop at Blk 101</span>'));
  });

  it('trails the operator, and omits the span when the feed gave none', () => {
    assert.ok(html.includes('<span class="nb-sub">SMRT</span>'));
    const anon = buildBusesIndex([row({ serviceNo: '74', operator: '' })]);
    assert.ok(!anon.includes('nb-sub'));
  });

  it('omits the summary span entirely when the feed gave no endpoints', () => {
    const blind = buildBusesIndex([row({ serviceNo: '74', origin: '', destination: '' })]);
    assert.ok(!blind.includes('nb-name'));
    assert.ok(blind.includes('href="/bus/74"'));
  });

  it('carries the heading and the service count', () => {
    assert.ok(html.includes('<h2 class="rt-dir-head">All bus services in Singapore</h2>'));
    assert.ok(html.includes('4 services'));
  });

  it('escapes descriptions and operators — <&"\' never reaches the markup raw', () => {
    const nasty = buildBusesIndex([
      row({ serviceNo: '74', origin: `Blk <&"'>`, destination: 'Plain', operator: 'S&B <T>' }),
    ]);
    assert.ok(nasty.includes('Blk &lt;&amp;&quot;&#39;&gt; → Plain'));
    assert.ok(nasty.includes('<span class="nb-sub">S&amp;B &lt;T&gt;</span>'));
    assert.ok(!nasty.includes('Blk <'), 'raw < leaked into the list');
  });

  it('collapses to the shell\'s own generic section for empty input', () => {
    assert.equal(buildBusesIndex([]), BUSES_LIST_TARGET);
  });
});

describe('shell pairing', () => {
  // The whole injection pattern rests on the shell and the constant matching
  // byte for byte — an edit to one side without the other fails silently as a
  // page that simply stops being injected. Same guard as the stop and route
  // shells' tests.
  it('the swap target appears verbatim, exactly once, in public/buses.html', () => {
    const shell = readFileSync(new URL('../public/buses.html', import.meta.url), 'utf8');
    assert.equal(
      shell.split(BUSES_LIST_TARGET).length,
      2,
      `target missing or duplicated: ${BUSES_LIST_TARGET.slice(0, 60)}…`,
    );
  });
});
