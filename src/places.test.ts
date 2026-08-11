import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import { PlaceIndex } from './places.js';

/**
 * The fixture is built in memory: a dozen hand-written records, serialised into
 * the same envelope `tools/build-places.mjs` writes, gzipped, and handed to
 * `loadBuffer`. Nothing is written to disk and no fixture file is committed —
 * the gunzip → parse → validate → index path still runs for real.
 *
 * The committed 11 MB artefact is deliberately never opened here. `node --test`
 * gives every test file its own process, so reading it would cost ~200 ms and
 * ~35 MB per file, and the cases would then fail for reasons belonging to the
 * data rather than to this code — a renamed building would break a ranking test.
 *
 * Static imports, unlike the dynamic-import ceremony in `stops.test.ts`:
 * `places.ts` reads no `process.env` and never calls `fetch`, so there is
 * nothing that has to be in place before the module is evaluated.
 */

const VALID = [
  {
    postal: '018956',
    building: 'MARINA BAY SANDS',
    block: '10',
    road: 'BAYFRONT AVENUE',
    lat: 1.283761,
    lon: 103.860719,
  },
  // Two blocks on one road, no building on either: the pair the block bonus
  // exists for.
  { postal: '310155', building: '', block: '155', road: 'LORONG 1 TOA PAYOH', lat: 1.33241, lon: 103.847 },
  { postal: '310159', building: '', block: '159', road: 'LORONG 1 TOA PAYOH', lat: 1.33256, lon: 103.84722 },
  {
    postal: '310480',
    building: 'TOA PAYOH HDB HUB',
    block: '480',
    road: 'LORONG 6 TOA PAYOH',
    lat: 1.33224,
    lon: 103.84757,
  },
  // The bare name, so exact / prefix / contains are three different rows.
  { postal: '319123', building: 'TOA PAYOH', block: '', road: 'TOA PAYOH CENTRAL', lat: 1.33212, lon: 103.84711 },
  {
    postal: '319762',
    building: 'THE TOA PAYOH MALL',
    block: '9',
    road: 'LORONG 8 TOA PAYOH',
    lat: 1.33478,
    lon: 103.85312,
  },
  // Punctuation inside a name, both a full stop and an apostrophe.
  { postal: '321010', building: '', block: '10', road: "ST. GEORGE'S ROAD", lat: 1.32355, lon: 103.86107 },
  // Road only: no building and no block.
  { postal: '188064', building: '', block: '', road: 'VICTORIA STREET', lat: 1.29684, lon: 103.85253 },
  // The tenant inside the landmark, at the landmark's own coordinates: the pair
  // that made `toa payoh hub` answer with a bank branch.
  {
    postal: '310481',
    building: 'CITIBANK TOA PAYOH HUB',
    block: '480',
    road: 'LORONG 6 TOA PAYOH',
    lat: 1.33224,
    lon: 103.84757,
  },
  // A brand the user can name in its own right, to catch the lead penalty
  // misfiring on the record it is supposed to find.
  {
    postal: '310482',
    building: 'NTUC FAIRPRICE TOA PAYOH',
    block: '470',
    road: 'LORONG 6 TOA PAYOH',
    lat: 1.33231,
    lon: 103.84765,
  },
  // The abbreviation cases. Roads are stored in full and LTA's stop descriptions
  // write "Ave", so these are the rows a rider types the short form of.
  { postal: '738343', building: '', block: '501', road: 'WOODLANDS AVENUE 5', lat: 1.43812, lon: 103.79014 },
  { postal: '560308', building: '', block: '308', road: 'ANG MO KIO AVENUE 3', lat: 1.36954, lon: 103.84688 },
  { postal: '208787', building: '', block: '', road: 'JALAN BESAR', lat: 1.30924, lon: 103.85712 },
  // The decoy that made `ang mo kio ave 3` return one wrong row: its block `339`
  // is what the trailing `3` prefix-matched.
  {
    postal: '569933',
    building: 'OCBC ANG MO KIO AVE 1 - 7 ELEVEN',
    block: '339',
    road: 'ANG MO KIO AVENUE 1',
    lat: 1.36211,
    lon: 103.85399,
  },
];

const INVALID = [
  // Five digits: a bus stop code that wandered into the postal column.
  { postal: '31015', building: 'FIVE DIGIT HOUSE', block: '', road: 'NOWHERE ROAD', lat: 1.3, lon: 103.8 },
  { postal: '400001', building: 'NAN TOWER', block: '', road: 'NOWHERE ROAD', lat: 'abc', lon: 103.8 },
  { postal: '400002', building: 'NULL ISLAND', block: '', road: 'NOWHERE ROAD', lat: 0, lon: 0 },
  { postal: '400003', building: 'LONDON HOUSE', block: '', road: 'NOWHERE ROAD', lat: 51.5, lon: -0.12 },
  // Same postal as Blk 155 above, with different fields: the first wins.
  { postal: '310155', building: 'IMPOSTOR', block: '', road: 'NOWHERE ROAD', lat: 1.3, lon: 103.8 },
];

const GENERATED_AT = '2026-08-11';

const artefact = (places: unknown[], generatedAt: string | null = GENERATED_AT) =>
  gzipSync(
    JSON.stringify({
      source: 'https://example.test/buildings.json',
      licence: 'Singapore Open Data Licence',
      generatedAt,
      count: places.length,
      places,
    }),
  );

const seeded = () => {
  const index = new PlaceIndex();
  index.loadBuffer(artefact([...VALID, ...INVALID]));
  return index;
};

const index = seeded();

// `loadBuffer` throws rather than swallowing, so an unseeded index would show up
// as twenty confusing failures instead of one clear one.
if (index.size !== VALID.length) {
  throw new Error(`fixture did not seed: ${index.size} of ${VALID.length} places`);
}

const postals = (places: Array<{ postal: string | null }>) => places.map((place) => place.postal);

describe('PlaceIndex.loadBuffer', () => {
  it('seeds size and generatedAt from the envelope', () => {
    // `generatedAt` is how old the data is, which is what /healthz reports; a
    // load timestamp would only ever say "boot".
    assert.equal(index.size, VALID.length);
    assert.equal(index.generatedAt, GENERATED_AT);
  });

  it('drops every invalid record and keeps the first of a duplicated postal', () => {
    // D2 is applied here as well as in the build tool because the artefact is
    // committed data a human can hand-edit, and the client commits a tapped row
    // as the board's origin without re-checking the coordinate.
    assert.equal(index.get('31015'), null);
    assert.equal(index.get('400001'), null);
    assert.equal(index.get('400002'), null);
    assert.equal(index.get('400003'), null);
    assert.equal(index.get('310155')?.road, 'LORONG 1 TOA PAYOH');
  });

  it('throws on a valid gzip whose places is not an array, leaving size at 0', () => {
    const empty = new PlaceIndex();
    assert.throws(() => empty.loadBuffer(gzipSync(JSON.stringify({ generatedAt: GENERATED_AT }))), /places/);
    assert.equal(empty.size, 0);
    assert.equal(empty.generatedAt, null);
  });
});

describe('PlaceIndex.get', () => {
  it('trims its input', () => {
    assert.equal(index.get('  018956  ')?.building, 'MARINA BAY SANDS');
  });

  it('is null for a postal code nothing sits at', () => {
    assert.equal(index.get('999999'), null);
  });
});

describe('PlaceIndex.search', () => {
  it('resolves a six-digit query to exactly that record', () => {
    const rows = index.search('018956');
    assert.deepEqual(postals(rows), ['018956']);
    assert.equal(rows[0]?.code, null);
  });

  it('returns nothing for a six-digit query with no address, rather than searching for it', () => {
    // Six digits mean a postal code and only that. Falling through to the token
    // search would answer a question the user did not ask, and the client needs
    // the empty result to say which code it could not find.
    assert.deepEqual(index.search('999999'), []);
  });

  // Relative positions rather than a fixed slice: the ladder is the claim, and a
  // fixture that grows a new matching row should not have to rewrite it.
  it('ranks an exact building name above a prefix above a mere containment', () => {
    const rows = postals(index.search('toa payoh'));
    assert.equal(rows[0], '319123');
    assert.ok(rows.indexOf('319123') < rows.indexOf('310480'));
    assert.ok(rows.indexOf('310480') < rows.indexOf('319762'));
  });

  it('ranks a building match above a road match for the same query', () => {
    const rows = postals(index.search('toa payoh'));
    // 319762 has "TOA PAYOH" inside its building name, 310155 only in its road.
    assert.ok(rows.indexOf('319762') < rows.indexOf('310155'));
  });

  it('collapses whitespace and ignores case', () => {
    assert.deepEqual(index.search('  toa   payoh  '), index.search('TOA PAYOH'));
  });

  it('matches every token in any order', () => {
    // Both rows are the same building — the landmark and a tenant inside it — and
    // the landmark leads, which is the ranking fix rather than the conjunction.
    assert.deepEqual(postals(index.search('hub payoh')), ['310480', '310481']);
    // AND, not OR: "hub" alone would have hit, so this pins the conjunction.
    assert.deepEqual(index.search('hub sengkang'), []);
  });

  it('treats only the last token as a prefix', () => {
    // The last token is the one still being typed. An earlier one the user has
    // finished typing is a whole word, so this asymmetry is the feature.
    assert.ok(index.search('toa pay').length > 0);
    assert.deepEqual(index.search('pay toa'), []);
  });

  it('requires a single-character token to match as well', () => {
    // Too short to be indexed, but someone who typed "lorong 1" means lorong 1
    // and not lorong 6, so it is still verified against the stored road.
    assert.deepEqual(postals(index.search('lorong 1 toa payoh')), ['310155', '310159']);
  });

  it('finds a word that punctuation separates', () => {
    // "ST. GEORGE'S ROAD" — a plain includes(' ' + token) test would miss this,
    // because the boundary before GEORGE follows a full stop and the one after
    // it is an apostrophe.
    assert.deepEqual(postals(index.search('george')), ['321010']);
  });

  it('puts the block the query names above its neighbour on the same road', () => {
    // "155 toa payoh" prefix-matches nothing — it skips the middle of the road
    // name — so without the block bonus Blk 155 would rank on nothing at all.
    assert.equal(index.search('155 toa payoh')[0]?.postal, '310155');
    const rows = postals(index.search('155 toa payoh'));
    assert.ok(rows.indexOf('310159') === -1 || rows.indexOf('310159') > rows.indexOf('310155'));
  });

  it('puts the same block first when the whole road name is typed out', () => {
    assert.equal(index.search('155 lorong 1 toa payoh')[0]?.postal, '310155');
  });

  it('ignores "blk", which the user reads off this app and no record spells', () => {
    // Added after the 20-address pass in Task 6: the chip, the Recent list and
    // LTA's own stop descriptions all render "Blk 155", so typing it back is the
    // obvious thing to do — and under the strict AND it matched nothing at all,
    // because the stored field is "155". A query stop word, not a looser
    // conjunction and not an index change.
    assert.deepEqual(index.search('blk 155 lorong 1 toa payoh'), index.search('155 lorong 1 toa payoh'));
    assert.equal(index.search('blk 155 lorong 1 toa payoh')[0]?.postal, '310155');
    // Nothing but stop words names no address, so it still answers with nothing.
    assert.deepEqual(index.search('blk'), []);
    assert.deepEqual(index.search('blk 155'), []);
  });

  it('returns nothing for a bare block number', () => {
    // Documented consequence of not indexing block numbers, pinned so nobody
    // "fixes" it: they are short, repeated thousands of times and would generate
    // huge candidate lists for no discriminating power.
    assert.deepEqual(index.search('155'), []);
  });

  it('returns nothing below two characters', () => {
    // The guard that lets the client query on every keystroke without the route
    // answering 400.
    assert.deepEqual(index.search('1'), []);
    assert.deepEqual(index.search(''), []);
    assert.deepEqual(index.search('   '), []);
  });

  it('caps the result count at the limit', () => {
    assert.ok(index.search('toa payoh').length > 2);
    assert.equal(index.search('toa payoh', 2).length, 2);
  });

  it('answers the same query with a deeply equal array', () => {
    assert.deepEqual(index.search('toa payoh'), index.search('toa payoh'));
  });

  it('finds a record that has no building by its road', () => {
    assert.deepEqual(postals(index.search('victoria')), ['188064']);
  });

  it('never returns a row at 0,0', () => {
    // Null Island is in the fixture and is rejected at load, which is what lets
    // the client commit a tapped row as an origin without re-checking it.
    for (const query of ['null', 'nowhere', 'toa payoh', 'marina', 'george', 'victoria']) {
      for (const row of index.search(query)) {
        assert.ok(row.lat !== 0 || row.lon !== 0, `${query} returned a 0,0 row`);
      }
    }
  });
});

// Road-name abbreviations. Every query below is what a rider types after reading
// a bus stop description off a card in this app, which writes "Ave" because LTA
// does; the dump stores "AVENUE".
describe('PlaceIndex.search — abbreviations', () => {
  it('finds a road by an abbreviation in the middle of the query', () => {
    assert.deepEqual(postals(index.search('woodlands ave 5')), ['738343']);
  });

  it('puts the named avenue above the decoy whose block matched the number', () => {
    const found = postals(index.search('ang mo kio ave 3'));
    assert.equal(found[0], '560308');
  });

  // The reason expansion is a variant and not a rewrite: rewriting ST to STREET
  // would have broken this record to fix the abbreviation above.
  it('still finds a record whose own name is the abbreviation', () => {
    assert.deepEqual(postals(index.search('st george')), ['321010']);
  });

  it('expands lor and jln', () => {
    assert.deepEqual(postals(index.search('lor 1 toa payoh')), ['310155', '310159']);
    assert.deepEqual(postals(index.search('jln besar')), ['208787']);
  });

  // Additive, not a rewrite: the full spelling behaves exactly as it did.
  it('leaves the written-out query untouched', () => {
    assert.deepEqual(postals(index.search('woodlands avenue 5')), ['738343']);
    assert.deepEqual(postals(index.search('victoria street')), ['188064']);
  });

  it('keeps the last-token-only prefix rule', () => {
    assert.ok(postals(index.search('toa pay')).length > 0);
    assert.deepEqual(index.search('pay toa'), []);
  });

  it('still drops blk, and still refuses a bare block number', () => {
    assert.deepEqual(postals(index.search('blk 155 lor 1 toa payoh')), ['310155']);
    assert.deepEqual(index.search('blk'), []);
    assert.deepEqual(index.search('155'), []);
  });

  it('truncates an over-long query rather than throwing', () => {
    assert.doesNotThrow(() => index.search(`ave ${'x'.repeat(200)}`));
    assert.doesNotThrow(() => index.search('ave '.repeat(40)));
  });

  // An expansion may only ever raise a row's score, so a row that already matched
  // as typed cannot be demoted by one that needed expanding.
  it('never demotes a row that matched as typed', () => {
    assert.equal(postals(index.search('bayfront avenue'))[0], '018956');
    assert.equal(postals(index.search('marina bay sands'))[0], '018956');
  });
});

// A name led by a word the user did not type ranks below the thing they did type.
//
// Measured against the real 121k index, not reasoned about: without these two
// rules `woodlands ave 5` answers with `HDB-WOODLANDS` and `ang mo kio ave 3` with
// `KEBUN BARU HEIGHTS`, because a building on the road scores exactly what the road
// scores and then wins the postal-code tiebreak. That is the payoff — it is what
// makes the abbreviation fix above return the road the rider named.
//
// **What it does not fix:** open issue 2, the tenant-over-landmark case, in
// production. It orders the fixture pair below correctly, but the real record is
// `HDB HUB` with `TOA PAYOH` only in its *road*, so no building-based rule can see
// the words `toa payoh hub` is made of. Verified against the real index: that query
// is unchanged. Issue 2 stays open, and a fix for it has to reason across building
// and road together.
describe('PlaceIndex.search — an unnamed lead ranks lower', () => {
  it('puts the landmark above the branded tenant that shares its address', () => {
    const rows = postals(index.search('toa payoh hub'));
    assert.ok(rows.indexOf('310480') < rows.indexOf('310481'), rows.join(' '));
  });

  it('puts the named road above a branded building sitting on it', () => {
    assert.equal(postals(index.search('ang mo kio ave 3'))[0], '560308');
    assert.equal(postals(index.search('woodlands ave 5'))[0], '738343');
  });

  // The rule must not misfire on the record it is meant to find: naming the brand
  // is naming the lead.
  it('finds a brand the user names outright', () => {
    assert.equal(postals(index.search('ntuc fairprice'))[0], '310482');
    assert.equal(postals(index.search('citibank toa payoh'))[0], '310481');
  });

  // Mid-typing the lead is not yet spelled out, and must not count as unnamed.
  it('does not tax a lead the last token is still spelling', () => {
    assert.deepEqual(postals(index.search('citiban')), ['310481']);
  });

  it('leaves an exact building name at the top', () => {
    assert.equal(postals(index.search('marina bay sands'))[0], '018956');
    assert.equal(postals(index.search('toa payoh'))[0], '319123');
  });

  // Road-only records are exempt: a lorong leads with a road type, not a tenant,
  // so the block bonus is still what orders two blocks on one road.
  it('does not tax a road-led record for the way roads are spelled', () => {
    const rows = postals(index.search('lorong 1 toa payoh'));
    assert.ok(rows.includes('310155'));
    assert.ok(rows.includes('310159'));
    assert.equal(postals(index.search('155 lorong 1 toa payoh'))[0], '310155');
    assert.equal(postals(index.search('155 lor 1 toa payoh'))[0], '310155');
  });
});
