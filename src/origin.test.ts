import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Unit tests for [public/origin.js](../public/origin.js) — the pure half of the
 * front end. Everything here is a plain input/output assertion: no timers, no
 * network, no DOM, no `process.env`.
 *
 * The specifier below is computed on purpose; leave it that way. `tsconfig.json`
 * sets `rootDir: "src"`, so a literal `'../public/origin.js'` trips TS2307 (the
 * module has no declarations) and TS6059 (it sits outside `rootDir`). Built at
 * runtime instead, tsc never tries to resolve it, the module types as `any`, and
 * this file compiles clean under `strict`. Top-level `await import()` in a test
 * is already the house pattern (`lta.stops.test.ts`, `stops.test.ts`). This file
 * runs as `dist/origin.test.js`, from where the URL lands on
 * `<repo>/public/origin.js`.
 *
 * The accepted cost: no compile-time check on these signatures, so a renamed
 * export fails here at runtime rather than in the build.
 */
const originUrl = new URL('../public/origin.js', import.meta.url);
const origin = await import(originUrl.href);

/**
 * The tripwire for the module's purity, which the plan states and nothing else
 * enforces. Reading the clock is the one that matters most: every time-dependent
 * function must take `now` as a parameter, or the tests need fake timers.
 * Comments are stripped first, so a comment may still name any of these.
 */
describe('origin.js module contract', () => {
  it('has no DOM, storage, network or clock access', () => {
    const source = readFileSync(originUrl, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (const forbidden of ['Date.now', 'document', 'localStorage', 'fetch(']) {
      assert.equal(source.includes(forbidden), false, `origin.js must not use ${forbidden}`);
    }
  });
});

// Function blocks follow in the order of the plan's table; append new ones at
// the end rather than reordering, so several agents can add to this file.

describe('isUsableCoord', () => {
  it('accepts a normal Singapore coordinate', () => {
    assert.equal(origin.isUsableCoord(1.29684825, 103.85253591), true);
  });

  it('rejects 0,0 — the stops search() keeps but nearby() drops', () => {
    assert.equal(origin.isUsableCoord(0, 0), false);
  });

  it('accepts lat 0 with a non-zero lon, which is a real place', () => {
    assert.equal(origin.isUsableCoord(0, 103.85), true);
    assert.equal(origin.isUsableCoord(1.29, 0), true);
  });

  it('rejects NaN, undefined and strings', () => {
    assert.equal(origin.isUsableCoord(NaN, 103.85), false);
    assert.equal(origin.isUsableCoord(1.29, NaN), false);
    assert.equal(origin.isUsableCoord(undefined, undefined), false);
    assert.equal(origin.isUsableCoord('1.29', '103.85'), false);
    assert.equal(origin.isUsableCoord(Infinity, 103.85), false);
  });
});

describe('formatMetres', () => {
  it('shows whole metres below a kilometre', () => {
    assert.equal(origin.formatMetres(420), '420 m');
  });

  it('shows one decimal of a kilometre above it', () => {
    assert.equal(origin.formatMetres(1500), '1.5 km');
  });

  it('shows 0 m rather than nothing', () => {
    assert.equal(origin.formatMetres(0), '0 m');
  });

  it('returns an empty string for a non-number', () => {
    assert.equal(origin.formatMetres(null), '');
    assert.equal(origin.formatMetres(undefined), '');
    assert.equal(origin.formatMetres('420'), '');
  });
});

// These two pin what the cards showed before the extraction, so moving the
// function off app.js is provably behaviour-neutral.
describe('formatDistance', () => {
  it('appends the walking time at ~80 m/min', () => {
    assert.equal(origin.formatDistance(420), '420 m · 5 min walk');
  });

  it('floors the walk at one minute, so 0 m is not "0 min walk"', () => {
    assert.equal(origin.formatDistance(0), '0 m · 1 min walk');
  });
});

const GPS_RECORD = { mode: 'gps', at: 1_700_000_000_000 };
/**
 * The origin record as it is written from Task 4 onwards. Its coordinate matches
 * the one `LEGACY_STOP_RECORD` carries, so the `originCoord` and `boardParams`
 * assertions below are unchanged by the rename.
 */
const PLACE_RECORD = {
  mode: 'place',
  postal: '310155',
  code: null,
  label: 'Blk 155',
  name: '155 Lorong 1 Toa Payoh',
  lat: 1.3325,
  lon: 103.8475,
};
/**
 * What a returning user who came in through the stop-code door still has in
 * `bus-board.origin.v1`. The key was deliberately not versioned past v1, so this
 * shape must keep booting to a board rather than to the intro dialog — every
 * assertion mentioning it is a regression net for exactly that.
 */
const LEGACY_STOP_RECORD = {
  mode: 'stop',
  code: '43179',
  description: 'Blk 155',
  roadName: 'Lor 1 Toa Payoh',
  lat: 1.3325,
  lon: 103.8475,
};

describe('readOriginRecord', () => {
  it('accepts a valid gps record', () => {
    assert.deepEqual(origin.readOriginRecord(JSON.stringify(GPS_RECORD)), GPS_RECORD);
  });

  it('returns a valid place record intact', () => {
    assert.deepEqual(origin.readOriginRecord(JSON.stringify(PLACE_RECORD)), PLACE_RECORD);
  });

  it('returns null when the key is absent', () => {
    assert.equal(origin.readOriginRecord(null), null);
  });

  it('returns null for an empty string', () => {
    assert.equal(origin.readOriginRecord(''), null);
  });

  it('returns null for a malformed record, without the throw escaping', () => {
    assert.equal(origin.readOriginRecord('{'), null);
  });

  it('returns null for the JSON literal null', () => {
    assert.equal(origin.readOriginRecord('null'), null);
  });

  it('returns null for a JSON array', () => {
    assert.equal(origin.readOriginRecord('[{"mode":"gps"}]'), null);
  });

  it('returns null for an unknown mode', () => {
    assert.equal(origin.readOriginRecord('{"mode":"walk"}'), null);
  });

  // The single highest-value assertion in this file. Dropping the legacy record
  // instead would send every returning stop-mode user back to the intro dialog —
  // the exact failure `decideBoot`'s grandfathering exists to prevent — and it
  // would do it silently, because a reset first visit looks like a first visit.
  it('migrates a legacy stop record, keeping its coordinate', () => {
    assert.deepEqual(origin.readOriginRecord(JSON.stringify(LEGACY_STOP_RECORD)), {
      mode: 'place',
      postal: null,
      code: '43179',
      label: 'Stop 43179',
      name: 'Blk 155, Lor 1 Toa Payoh',
      lat: 1.3325,
      lon: 103.8475,
    });
  });

  // The description and road are gone, so the label has to carry the code — but
  // it is still a rankable coordinate, which is the only thing the board needs.
  it('migrates a legacy stop record that has nothing but a code', () => {
    const place = origin.readOriginRecord(
      '{"mode":"stop","code":"43179","lat":1.33,"lon":103.84}',
    );
    assert.equal(place.label, 'Stop 43179');
    assert.equal(place.name, 'Stop 43179');
  });

  it('returns null for a legacy stop record with no coordinates', () => {
    assert.equal(origin.readOriginRecord('{"mode":"stop","code":"43179"}'), null);
  });

  // Still rejected after the migration, and for a sharper reason than before: a
  // 4-digit code was never a stop this app wrote, so `Stop 4317` would be a
  // plausible-looking lie in the masthead rather than a harmless label.
  it('returns null for a legacy stop record with a 4-digit code', () => {
    assert.equal(
      origin.readOriginRecord('{"mode":"stop","code":"4317","lat":1.33,"lon":103.84}'),
      null,
    );
  });

  // The Gulf of Guinea trap: search() keeps 0,0 stops findable, so this record
  // is reachable. Accepting it would rank all of Singapore ~1,300 km away.
  it('returns null for a legacy stop record at 0,0', () => {
    assert.equal(origin.readOriginRecord('{"mode":"stop","code":"43179","lat":0,"lon":0}'), null);
  });

  it('returns null for a non-numeric lat', () => {
    assert.equal(
      origin.readOriginRecord('{"mode":"stop","code":"43179","lat":"1.33","lon":103.84}'),
      null,
    );
  });

  it('rejects a place record with no coordinate, at 0,0, or with an empty label', () => {
    const broken = [
      { ...PLACE_RECORD, lat: undefined, lon: undefined },
      { ...PLACE_RECORD, lat: 0, lon: 0 },
      { ...PLACE_RECORD, label: '' },
      { ...PLACE_RECORD, label: '   ' },
      { ...PLACE_RECORD, lat: '1.3325' },
    ];
    for (const record of broken) {
      assert.equal(origin.readOriginRecord(JSON.stringify(record)), null);
    }
  });

  // A malformed postal is not a reason to throw away a record with a usable
  // coordinate and a name on it — it is a reason to stop claiming a postal, which
  // is all `chipState` needs to know before it speaks "Singapore 310155".
  it('nulls a non-6-digit postal rather than rejecting the record', () => {
    for (const postal of ['31015', '3101555', 310155, 'S310155', null]) {
      const place = origin.readOriginRecord(JSON.stringify({ ...PLACE_RECORD, postal }));
      assert.equal(place.postal, null);
      assert.equal(place.label, 'Blk 155');
    }
  });

  // The property that replaces "only ever a 5-digit string": what made the old
  // record safe to interpolate into the chip was its shape, and what makes this
  // one safe is that the read re-caps and re-collapses on the way out. The chip
  // is one `white-space: nowrap` flex row, so a newline breaks it silently.
  it('never returns a label over 18 characters or containing a newline', () => {
    const raws = [
      JSON.stringify({ ...PLACE_RECORD, label: 'A'.repeat(200) }),
      JSON.stringify({ ...PLACE_RECORD, label: 'Blk 155\nOpp The Mall' }),
      JSON.stringify({ ...PLACE_RECORD, label: `Blk\t155 ${'x'.repeat(200)}\n` }),
      JSON.stringify({ ...PLACE_RECORD, name: 'N'.repeat(200) }),
      JSON.stringify({ ...LEGACY_STOP_RECORD, description: 'D'.repeat(200) }),
      JSON.stringify({ ...LEGACY_STOP_RECORD, roadName: 'Lor 1\nToa Payoh' }),
      JSON.stringify(PLACE_RECORD),
      JSON.stringify(LEGACY_STOP_RECORD),
    ];
    let accepted = 0;
    for (const raw of raws) {
      const record = origin.readOriginRecord(raw);
      if (record === null) continue;
      accepted += 1;
      assert.ok(record.label.length <= 18, `label too long: ${record.label}`);
      assert.equal(record.label.includes('\n'), false);
      assert.equal(record.name.includes('\n'), false);
    }
    assert.equal(accepted, raws.length); // every one of them is a usable record
  });
});

describe('decideBoot', () => {
  const NOW = 1_760_000_000_000;

  it('sends a valid gps record straight to the gps journey', () => {
    const decision = origin.decideBoot({
      originRaw: JSON.stringify(GPS_RECORD),
      locRaw: null,
      pinCount: 0,
      now: NOW,
    });
    assert.equal(decision.journey, 'gps');
    assert.equal(decision.persist, false);
  });

  it('sends a valid place record to the place journey and hands back the record', () => {
    const decision = origin.decideBoot({
      originRaw: JSON.stringify(PLACE_RECORD),
      locRaw: null,
      pinCount: 0,
      now: NOW,
    });
    assert.equal(decision.journey, 'place');
    assert.deepEqual(decision.origin, PLACE_RECORD);
  });

  // The regression net for returning users, at the level `app.js` actually reads.
  // `persist: false` is the point of the assertion as much as the journey is: the
  // record is usable and wins outright, so this is *not* grandfathering, and a
  // future change that starts synthesising a gps record here would silently move
  // every one of these users off the address they chose.
  it('boots a legacy stop record to the place journey with persist false', () => {
    const decision = origin.decideBoot({
      originRaw: JSON.stringify(LEGACY_STOP_RECORD),
      locRaw: null,
      pinCount: 0,
      now: NOW,
    });
    assert.equal(decision.journey, 'place');
    assert.equal(decision.persist, false);
    assert.equal(decision.origin.mode, 'place');
    assert.equal(decision.origin.label, 'Stop 43179');
    assert.equal(decision.origin.lat, 1.3325);
    assert.equal(decision.origin.lon, 103.8475);
  });

  // Not the intro, either: a legacy user with no fix and no pins has nothing else
  // in storage to grandfather them by, so the migrated record is the only thing
  // standing between them and a first-visit dialog.
  it('never shows the intro to a legacy stop-record user with nothing else stored', () => {
    const decision = origin.decideBoot({
      originRaw: JSON.stringify(LEGACY_STOP_RECORD),
      locRaw: null,
      pinCount: 0,
      now: NOW,
    });
    assert.notEqual(decision.journey, 'intro');
  });

  it('shows the intro when there is nothing stored at all', () => {
    const decision = origin.decideBoot({
      originRaw: null,
      locRaw: null,
      pinCount: 0,
      now: NOW,
    });
    assert.equal(decision.journey, 'intro');
    assert.equal(decision.origin, null);
    assert.equal(decision.persist, false);
  });

  // Grandfathering: an existing user must never be introduced to a site they
  // have been using. The synthesised record is stamped with the injected clock.
  it('grandfathers a user who already holds a fix, and stamps it with now', () => {
    const decision = origin.decideBoot({
      originRaw: null,
      locRaw: '{"lat":1.3005,"lon":103.8384,"at":1750000000000}',
      pinCount: 0,
      now: NOW,
    });
    assert.equal(decision.journey, 'gps');
    assert.equal(decision.persist, true);
    assert.deepEqual(decision.origin, { mode: 'gps', at: NOW });
  });

  it('grandfathers a user who holds pins but no fix', () => {
    const decision = origin.decideBoot({
      originRaw: null,
      locRaw: null,
      pinCount: 1,
      now: NOW,
    });
    assert.equal(decision.journey, 'gps');
    assert.equal(decision.persist, true);
  });

  // readPins() returns [] for both "no key" and "[]", so the count is the only
  // honest signal — this is the misfire guard.
  it('shows the intro when the pin count is 0', () => {
    const decision = origin.decideBoot({
      originRaw: null,
      locRaw: null,
      pinCount: 0,
      now: NOW,
    });
    assert.equal(decision.journey, 'intro');
  });

  it('grandfathers a corrupt origin when a valid fix exists', () => {
    const decision = origin.decideBoot({
      originRaw: '{',
      locRaw: '{"lat":1.3005,"lon":103.8384,"at":1750000000000}',
      pinCount: 0,
      now: NOW,
    });
    assert.equal(decision.journey, 'gps');
    assert.equal(decision.persist, true);
  });

  it('shows the intro for a corrupt origin with nothing else', () => {
    const decision = origin.decideBoot({
      originRaw: '{',
      locRaw: null,
      pinCount: 0,
      now: NOW,
    });
    assert.equal(decision.journey, 'intro');
  });

  it('shows the intro for a legacy stop record whose code is valid but sits at 0,0', () => {
    const decision = origin.decideBoot({
      originRaw: '{"mode":"stop","code":"43179","lat":0,"lon":0}',
      locRaw: null,
      pinCount: 0,
      now: NOW,
    });
    assert.equal(decision.journey, 'intro');
    assert.equal(decision.origin, null);
  });

  it('shows the intro when the stored fix is present but malformed', () => {
    const decision = origin.decideBoot({
      originRaw: null,
      locRaw: '{"lat":"nope"}',
      pinCount: 0,
      now: NOW,
    });
    assert.equal(decision.journey, 'intro');
  });
});

describe('originCoord', () => {
  const FIX = { lat: 1.3005, lon: 103.8384, at: 1_760_000_000_000 };

  it('returns the place record’s own coordinate, ignoring the last fix', () => {
    assert.deepEqual(origin.originCoord(PLACE_RECORD, FIX), { lat: 1.3325, lon: 103.8475 });
  });

  it('returns the last fix in gps mode', () => {
    assert.deepEqual(origin.originCoord(GPS_RECORD, FIX), FIX);
  });

  it('returns null in gps mode with no fix yet', () => {
    assert.equal(origin.originCoord(GPS_RECORD, null), null);
  });

  it('returns null with no origin', () => {
    assert.equal(origin.originCoord(null, FIX), null);
  });
});

/**
 * Contractual in the string: which keys are present, their values, and that
 * `pinned` is comma-separated (the server splits on commas). Key *order* is not
 * contractual, so these parse rather than compare strings.
 */
describe('boardParams', () => {
  const FIX = { lat: 1.3005, lon: 103.8384, at: 1_760_000_000_000 };
  const parse = (query: string) => new URLSearchParams(query);

  it('always sets the limit', () => {
    const params = parse(origin.boardParams({ origin: null, lastLoc: null, pins: [], limit: 8 }));
    assert.equal(params.get('limit'), '8');
  });

  it('sends the place record’s coordinate in place mode', () => {
    const params = parse(
      origin.boardParams({ origin: PLACE_RECORD, lastLoc: FIX, pins: [], limit: 8 }),
    );
    assert.equal(params.get('lat'), '1.3325');
    assert.equal(params.get('lon'), '103.8475');
  });

  it('sends the last fix in gps mode', () => {
    const params = parse(
      origin.boardParams({ origin: GPS_RECORD, lastLoc: FIX, pins: [], limit: 8 }),
    );
    assert.equal(params.get('lat'), '1.3005');
    assert.equal(params.get('lon'), '103.8384');
  });

  // Absent, not empty: `lat=` reads as 0 and `lat=NaN` as NaN, and only absence
  // reaches the server's located:false path.
  it('omits lat and lon entirely when there is no coordinate', () => {
    const query = origin.boardParams({ origin: GPS_RECORD, lastLoc: null, pins: [], limit: 8 });
    const params = parse(query);
    assert.equal(params.has('lat'), false);
    assert.equal(params.has('lon'), false);
    assert.equal(query.includes('lat'), false);
  });

  it('joins pinned codes with commas', () => {
    const params = parse(
      origin.boardParams({
        origin: GPS_RECORD,
        lastLoc: FIX,
        pins: [{ code: '43179' }, { code: '20021' }],
        limit: 8,
      }),
    );
    assert.equal(params.get('pinned'), '43179,20021');
  });

  it('omits pinned when there are no pins', () => {
    const params = parse(
      origin.boardParams({ origin: GPS_RECORD, lastLoc: FIX, pins: [], limit: 8 }),
    );
    assert.equal(params.has('pinned'), false);
  });
});

describe('shouldRelocateOnFocus', () => {
  const NOW = 1_760_000_000_000;
  const fixAgedMinutes = (minutes: number) => ({
    lat: 1.3005,
    lon: 103.8384,
    at: NOW - minutes * 60_000,
  });

  it('re-locates in gps mode when the fix is ten minutes old', () => {
    assert.equal(origin.shouldRelocateOnFocus(GPS_RECORD, fixAgedMinutes(10), NOW), true);
  });

  it('does not re-locate in gps mode when the fix is a minute old', () => {
    assert.equal(origin.shouldRelocateOnFocus(GPS_RECORD, fixAgedMinutes(1), NOW), false);
  });

  it('re-locates in gps mode when there is no fix at all', () => {
    assert.equal(origin.shouldRelocateOnFocus(GPS_RECORD, null, NOW), true);
  });

  // The two cases below are the regression net for the highest-ranked risk in
  // the plan: a place-mode user usually holds no fix, so a listener testing
  // `lastLoc` alone asks for their location on every tab focus.
  it('never re-locates in place mode with no fix', () => {
    assert.equal(origin.shouldRelocateOnFocus(PLACE_RECORD, null, NOW), false);
  });

  it('never re-locates in place mode however ancient the fix', () => {
    const ancient = fixAgedMinutes(60 * 24 * 30);
    assert.equal(origin.shouldRelocateOnFocus(PLACE_RECORD, ancient, NOW), false);
  });

  it('never re-locates with no origin', () => {
    assert.equal(origin.shouldRelocateOnFocus(null, null, NOW), false);
  });
});

describe('taglineFor', () => {
  it('says nearest you in gps mode', () => {
    assert.equal(origin.taglineFor(GPS_RECORD), 'Stops nearest you, live from LTA');
  });

  // Behind the intro and on the dismissal gate there is no board on screen, so
  // "stops nearest you" would describe something absent in a mode nothing has been
  // granted for — the claim `chipState` already refuses to make for the same state.
  it('claims no mode before a door is taken', () => {
    assert.equal(origin.taglineFor(null), 'Any stop in Singapore, live from LTA');
    assert.equal(origin.taglineFor(null).includes('nearest you'), false);
  });

  // The long name, not the short label: the tagline has a line to itself, which
  // is the whole reason `Place` carries two strings.
  it('names the address in place mode', () => {
    assert.equal(
      origin.taglineFor(PLACE_RECORD),
      'Stops near 155 Lorong 1 Toa Payoh, live from LTA',
    );
  });

  // Both clauses, always. The demo notice used to overwrite this sentence and
  // latch, so the origin clause never came back for the rest of the session; now
  // the two are composed and the contradiction is impossible to construct.
  it('keeps the origin clause in mock mode', () => {
    assert.equal(origin.taglineFor(GPS_RECORD, true), 'Stops nearest you · demo timings, not live');
    assert.equal(
      origin.taglineFor(PLACE_RECORD, true),
      'Stops near 155 Lorong 1 Toa Payoh · demo timings, not live',
    );
    assert.equal(
      origin.taglineFor(null, true),
      'Any stop in Singapore · demo timings, not live',
    );
  });

  // An omitted argument must keep the wording every existing caller already gets.
  // The other reading would have old call sites silently claiming demo data.
  it('reads an absent mock flag as live', () => {
    for (const record of [GPS_RECORD, PLACE_RECORD, null]) {
      assert.equal(origin.taglineFor(record), origin.taglineFor(record, false));
      assert.match(origin.taglineFor(record), /live from LTA$/);
    }
  });

  // "No LTA API key configured yet" is written for whoever deploys this, not for
  // whoever is waiting at the stop.
  it('never mentions the deployment in either mode', () => {
    for (const mock of [true, false, undefined]) {
      for (const record of [GPS_RECORD, PLACE_RECORD, null]) {
        const line = origin.taglineFor(record, mock);
        assert.equal(line.includes('API key'), false);
        assert.equal(line.includes('configured'), false);
      }
    }
  });

  // In mock mode nothing came from LTA, so the line must not say it did.
  it('drops the LTA claim when the timings are synthetic', () => {
    for (const record of [GPS_RECORD, PLACE_RECORD, null]) {
      assert.equal(origin.taglineFor(record, true).includes('LTA'), false);
    }
  });
});

describe('gateMessageFor', () => {
  it('names you in gps mode and the address in place mode', () => {
    assert.equal(origin.gateMessageFor(GPS_RECORD), 'Finding stops near you…');
    assert.equal(origin.gateMessageFor(null), 'Finding stops near you…');
    assert.equal(origin.gateMessageFor(PLACE_RECORD), 'Finding stops near Blk 155…');
  });

  // The **short** label, unlike the tagline: this sentence sits centred over the
  // skeleton cards, where a full address wraps to three lines on a 360 px phone
  // and pushes the placeholders off the first screenful.
  it('uses the short label rather than the full name', () => {
    const message = origin.gateMessageFor(PLACE_RECORD);
    assert.equal(message.includes('Lorong'), false);
    assert.ok(message.length < origin.taglineFor(PLACE_RECORD).length);
  });
});

describe('distanceLabel', () => {
  const card = (code: string, distanceM: unknown) => ({ code, distanceM });

  it('shows the walk from the user in gps mode', () => {
    assert.equal(origin.distanceLabel(card('43171', 420), GPS_RECORD), '420 m · 5 min walk');
  });

  // A phone fix is good to a few tens of metres, so a walking time under that is
  // invented from noise — and "0 m · 1 min walk" contradicts itself on the card the
  // commuter standing at the stop reads first.
  it('says Here rather than a walking time within a fix’s accuracy', () => {
    assert.equal(origin.distanceLabel(card('43171', 0), GPS_RECORD), 'Here');
    assert.equal(origin.distanceLabel(card('43171', 29), GPS_RECORD), 'Here');
  });

  it('starts describing the walk at the threshold, not before it', () => {
    assert.equal(origin.distanceLabel(card('43171', 30), GPS_RECORD), '30 m · 1 min walk');
  });

  // A stop origin refused walking times because the board could be ranked from a
  // stop the user was nowhere near. A typed address is somewhere they are at or
  // going to, so the walk is real — and it is the most decision-relevant number
  // on the card.
  it('shows metres and a walking time in place mode', () => {
    assert.equal(origin.distanceLabel(card('43171', 420), PLACE_RECORD), '420 m · 5 min walk');
    assert.match(origin.distanceLabel(card('43171', 60), PLACE_RECORD), /min walk$/);
  });

  // `AT_STOP_M` is a statement about GPS fix noise, and a geocoded building has
  // none: 0 m from a postal code means the stop really is outside that door.
  it('never says Here in place mode, even at 0 m', () => {
    assert.equal(origin.distanceLabel(card('43171', 0), PLACE_RECORD), '0 m · 1 min walk');
    for (const metres of [0, 1, 29, 30, 420]) {
      assert.equal(origin.distanceLabel(card('43171', metres), PLACE_RECORD).includes('Here'), false);
    }
  });

  // The origin marker is gone, not renamed: it named nothing a place origin can
  // be, and there is no longer a code to match a card against.
  it('never marks a card as the origin in place mode', () => {
    for (const metres of [0, 60]) {
      const label = origin.distanceLabel(card('43179', metres), PLACE_RECORD);
      assert.equal(label.includes('('), false);
      assert.equal(label.includes('stop'), false);
    }
  });

  it('returns an empty string when the server sent no distance', () => {
    assert.equal(origin.distanceLabel(card('43171', null), PLACE_RECORD), '');
    assert.equal(origin.distanceLabel(card('43171', null), GPS_RECORD), '');
  });

  it('returns an empty string when distanceM is missing entirely', () => {
    assert.equal(origin.distanceLabel({ code: '43171' }, GPS_RECORD), '');
    assert.equal(origin.distanceLabel({ code: '43171' }, PLACE_RECORD), '');
  });

  it('returns an empty string with no origin at all', () => {
    assert.equal(origin.distanceLabel(card('43171', 420), null), '');
  });

  // Belt and braces on the one cell that is interpolated into innerHTML: the
  // label never carries a stop code through, so there is nothing to escape.
  // `escape()` in renderShells is the braces.
  it('never puts a raw < in the label, whatever the stop code contains', () => {
    const nasty = card('<script>alert(1)</script>', 60);
    for (const record of [GPS_RECORD, PLACE_RECORD, null]) {
      assert.equal(origin.distanceLabel(nasty, record).includes('<'), false);
    }
  });
});

describe('noStopsMessage', () => {
  it('says near you in gps mode', () => {
    assert.equal(origin.noStopsMessage(GPS_RECORD), 'No bus stops found near you.');
    assert.equal(origin.noStopsMessage(null), 'No bus stops found near you.');
  });

  // "near you" would misdescribe a board ranked from an address the user may be
  // nowhere near. Short label, like `gateMessageFor`: this sentence lands in the
  // same centred slot over the same skeleton cards.
  it('names the address in place mode, by its short label', () => {
    assert.equal(origin.noStopsMessage(PLACE_RECORD), 'No bus stops found near Blk 155.');
    assert.equal(origin.noStopsMessage(PLACE_RECORD).includes('Lorong'), false);
  });
});

describe('refusalCopy', () => {
  // Three distinct sentences, because the three outcomes call for three different
  // actions: change a setting, try again, or give up on location for now.
  it('explains a denial without repeating the button underneath it', () => {
    const { message } = origin.refusalCopy({ code: 1 });
    assert.equal(
      message,
      'Location is blocked for this site. Allow it in your browser settings.',
    );
    // The old wording ended "…, or search for a stop instead". That clause is now
    // the label on the primary button, so the prose must not duplicate it.
    assert.equal(/search for a stop/.test(message), false);
  });

  it('says nothing it cannot support when the position is unavailable', () => {
    assert.equal(origin.refusalCopy({ code: 2 }).message, "Couldn't get your location.");
  });

  it('admits the retry already happened on a timeout', () => {
    assert.equal(origin.refusalCopy({ code: 3 }).message, "Still can't get a fix on your location.");
  });

  // `getPosition` rejects with `new Error('unsupported')` when there is no
  // geolocation at all, which carries no `code`.
  it('falls back to the code-2 wording for an Error with no code', () => {
    assert.equal(
      origin.refusalCopy(new Error('unsupported')).message,
      "Couldn't get your location.",
    );
  });

  it('returns the same wording for undefined rather than throwing', () => {
    assert.equal(origin.refusalCopy(undefined).message, "Couldn't get your location.");
    assert.equal(origin.refusalCopy(null).message, "Couldn't get your location.");
  });
});

describe('gateState', () => {
  const ACT = { label: 'Enter a stop code', onClick: () => {} };
  const ALT = { label: 'Try location again', onClick: () => {} };

  it('hides both buttons for a message on its own', () => {
    const state = origin.gateState('Finding stops near you…');
    assert.equal(state.message, 'Finding stops near you…');
    assert.equal(state.primary.hidden, true);
    assert.equal(state.secondary.hidden, true);
  });

  it('shows only the primary when one action is given', () => {
    const state = origin.gateState('Could not load stops.', { label: 'Try again' });
    assert.equal(state.primary.hidden, false);
    assert.equal(state.primary.label, 'Try again');
    assert.equal(state.secondary.hidden, true);
  });

  // The slots are not interchangeable: the primary is the accented button, and a
  // refusal must lead with the door that works, not with the one that just failed.
  it('puts two actions in the right slots', () => {
    const state = origin.gateState('Blocked.', ACT, ALT);
    assert.equal(state.primary.hidden, false);
    assert.equal(state.primary.label, 'Enter a stop code');
    assert.equal(state.secondary.hidden, false);
    assert.equal(state.secondary.label, 'Try location again');
  });

  // A computed label that came out empty means "no button", not "a button with
  // nothing written on it" — the latter is invisible but still a focus stop.
  it('treats a falsy label as no button at all', () => {
    const state = origin.gateState('Blocked.', { label: '', onClick: () => {} }, ALT);
    assert.equal(state.primary.hidden, true);
    assert.equal(state.primary.label, '');
    assert.equal(state.secondary.hidden, false);
  });
});

describe('introVariant', () => {
  it('offers both doors on a secure context with geolocation', () => {
    assert.equal(origin.introVariant({ isSecureContext: true, hasGeolocation: true }), 'full');
  });

  it('names the insecure context when that is the blocker', () => {
    assert.equal(origin.introVariant({ isSecureContext: false, hasGeolocation: true }), 'insecure');
  });

  it('names the browser when geolocation is missing outright', () => {
    assert.equal(
      origin.introVariant({ isSecureContext: true, hasGeolocation: false }),
      'unsupported',
    );
  });

  // The common real case — a browser that withholds `navigator.geolocation`
  // outside a secure context reports both at once. Only one sentence may be shown,
  // and it should be the one the user can act on.
  it('prefers the insecure sentence when both are true', () => {
    assert.equal(origin.introVariant({ isSecureContext: false, hasGeolocation: false }), 'insecure');
  });
});

describe('dismissGate', () => {
  it('offers both doors, location first, on a full variant', () => {
    const copy = origin.dismissGate('full');
    assert.equal(copy.primary.door, 'gps');
    assert.equal(copy.secondary.door, 'code');
    assert.equal(copy.primary.label, 'Use my current location');
    assert.equal(copy.secondary.label, 'Enter an address');
  });

  // A dismissal lands on an empty page; the sentence's whole job is to say why,
  // rather than repeating what the buttons underneath it already say.
  it('says why the page is empty', () => {
    for (const variant of ['full', 'insecure', 'unsupported']) {
      assert.match(origin.dismissGate(variant).message, /Nothing to show yet/);
    }
  });

  // The remaining door is promoted rather than left as a lone secondary: with no
  // primary, the only action on the page renders as the quieter of the two styles.
  it('promotes the stop-code door and drops the second when location cannot work', () => {
    for (const variant of ['insecure', 'unsupported']) {
      const copy = origin.dismissGate(variant);
      assert.equal(copy.primary.door, 'code');
      assert.equal(copy.secondary, null);
    }
  });

  // It is handed straight to `gateState`, so the two have to agree on what an
  // absent button looks like.
  it('produces one visible button through gateState when location cannot work', () => {
    const copy = origin.dismissGate('unsupported');
    const state = origin.gateState(copy.message, copy.primary, copy.secondary);
    assert.equal(state.primary.hidden, false);
    assert.equal(state.primary.label, 'Enter an address');
    assert.equal(state.secondary.hidden, true);
  });

  // The same string on the intro's second button, the wait hatch and every
  // refusal, so the four sites cannot drift apart. `index.html` writes it out by
  // hand because static markup cannot import.
  it('uses the one shared label for the address door', () => {
    assert.equal(origin.ADDRESS_DOOR_LABEL, 'Enter an address');
    assert.equal(origin.dismissGate('full').secondary.label, origin.ADDRESS_DOOR_LABEL);
    assert.equal(origin.dismissGate('insecure').primary.label, origin.ADDRESS_DOOR_LABEL);
  });
});

describe('chipState', () => {
  it('says near you in gps mode', () => {
    assert.equal(origin.chipState(GPS_RECORD).label, 'Near you ▾');
  });

  it('shows the short label and the caret in place mode', () => {
    assert.equal(origin.chipState(PLACE_RECORD).label, 'Blk 155 ▾');
  });

  // The 360 px width decision, pinned as a test rather than left to a comment: the
  // chip shares one flex row with the h1 and `.ghost` does not wrap, so the full
  // address may only ever reach the screen reader. The postal goes with it — it is
  // the one thing a Singaporean can act on unambiguously.
  it('puts the full name and the postal in the aria-label and never in the label', () => {
    const { label, ariaLabel } = origin.chipState(PLACE_RECORD);
    assert.equal(
      ariaLabel,
      'Change stops shown. Currently: stops near 155 Lorong 1 Toa Payoh, Singapore 310155',
    );
    assert.equal(label.includes('Lorong'), false);
    assert.equal(label.includes('310155'), false);
  });

  // A migrated stop record and a road-only address have no postal. "Singapore
  // null" read aloud is worse than saying nothing.
  it('omits the postal from the aria-label when the record has none', () => {
    const noPostal = { ...PLACE_RECORD, postal: null, name: 'Stop 43179', label: 'Stop 43179' };
    const { ariaLabel } = origin.chipState(noPostal);
    assert.equal(ariaLabel, 'Change stops shown. Currently: stops near Stop 43179');
    assert.equal(ariaLabel.includes('Singapore'), false);
    assert.equal(ariaLabel.includes('null'), false);
  });

  // Before either door is chosen: during the intro, and after it is dismissed.
  it('stays neutral with no origin, with no "undefined" anywhere in it', () => {
    const { label, ariaLabel } = origin.chipState(null);
    assert.equal(label.includes('undefined'), false);
    assert.equal(ariaLabel.includes('undefined'), false);
    assert.equal(label.includes('Near you'), false);
    assert.ok(label.length > 1);
  });

  // The layout budget, closed end to end: whatever is in storage, the read caps
  // the label, so the chip's label is at most 18 characters plus a space and the
  // caret — and never carries a newline into a nowrap flex row.
  it('never exceeds 18 characters plus the caret for anything readOriginRecord returns', () => {
    const raws = [
      JSON.stringify({ ...PLACE_RECORD, label: 'A'.repeat(200), name: 'B'.repeat(200) }),
      JSON.stringify({ ...PLACE_RECORD, label: 'Blk 155\nOpp The Mall' }),
      JSON.stringify({ ...LEGACY_STOP_RECORD, description: 'D'.repeat(200) }),
      JSON.stringify(PLACE_RECORD),
      JSON.stringify(GPS_RECORD),
    ];
    for (const raw of raws) {
      const record = origin.readOriginRecord(raw);
      const { label } = origin.chipState(record);
      assert.ok(label.length <= 20, `chip label too long: ${label}`);
      assert.equal(label.includes('\n'), false);
      assert.equal(label.endsWith('▾'), true);
    }
  });
});

describe('commitDecision', () => {
  // Rows as `finderState` hands them over: each carries a ready `Place`, and the
  // unrankable ones were already dropped. Fixtures are local rather than the
  // shared PLACE_* constants below, which are declared later in the file.
  const row = (place: object) => ({ place });
  const BLK_155 = {
    mode: 'place',
    postal: '310155',
    code: null,
    label: 'Blk 155',
    name: '155 Lorong 1 Toa Payoh',
    lat: 1.33241,
    lon: 103.847,
  };
  const BLK_159 = { ...BLK_155, postal: '310159', label: 'Blk 159', name: '159 Lorong 1 Toa Payoh' };
  const STOP = {
    mode: 'place',
    postal: null,
    code: '43179',
    label: 'Woodlands Int',
    name: 'Woodlands Int, Woodlands Ave 5',
    lat: 1.438,
    lon: 103.7855,
  };
  const ROWS = [row(BLK_159), row(BLK_155)];
  const decide = (input: object) =>
    origin.commitDecision({ status: 'ok', activeIndex: -1, ...input });

  // By index, not by postal: the caller commits `searchRows[index].place`, and
  // 310155 is deliberately the *second* row so a decision that ignored the query
  // and took the top hit could not pass.
  it('commits six digits that match a row, by index', () => {
    assert.deepEqual(decide({ value: '310155', rows: ROWS }), { action: 'choose', index: 1 });
  });

  // `S310155` is how a Singaporean writes it. The strip has to happen at commit
  // time as well as in `finderState`, or Enter answers "no address" for a query
  // the server resolved perfectly.
  it('accepts the S prefix, with or without a space', () => {
    assert.deepEqual(decide({ value: 'S310155', rows: ROWS }), { action: 'choose', index: 1 });
    assert.deepEqual(decide({ value: 's 310155', rows: ROWS }), { action: 'choose', index: 1 });
    assert.deepEqual(decide({ value: '  310155 ', rows: ROWS }), { action: 'choose', index: 1 });
  });

  it('names the postal code it could not find', () => {
    const decision = decide({ value: '310999', rows: ROWS });
    assert.equal(decision.action, 'note');
    assert.equal(decision.message, 'No address at 310999.');
  });

  // The escape hatch: the address dump is a ~2020 scrape, so in a new estate the
  // code on the pole may be the only way in.
  it('commits a five-digit stop code against a row that carries one', () => {
    assert.deepEqual(decide({ value: '43179', rows: [row(BLK_155), row(STOP)] }), {
      action: 'choose',
      index: 1,
    });
    const missing = decide({ value: '43999', rows: [row(STOP)] });
    assert.equal(missing.action, 'note');
    assert.equal(missing.message, 'No stop with code 43999.');
  });

  // A user who typed six digits *and* arrowed down to a row means the row.
  it('lets a highlighted row outrank a six-digit query', () => {
    assert.deepEqual(decide({ value: '310155', rows: ROWS, activeIndex: 0 }), {
      action: 'choose',
      index: 0,
    });
  });

  it('commits a highlighted row on a text query', () => {
    assert.deepEqual(decide({ value: 'toa payoh', rows: ROWS, activeIndex: 1 }), {
      action: 'choose',
      index: 1,
    });
  });

  // An async result can be shorter than the list the highlight was set against.
  // `applyFinder` clamps it, and this is the second line of that defence.
  it('does not commit an activeIndex beyond the rows', () => {
    assert.deepEqual(decide({ value: 'toa payoh', rows: ROWS, activeIndex: 7 }), {
      action: 'wait',
    });
  });

  // The net for the flag that used to live in `app.js`: a failed request and a
  // query that matched nothing produce the same empty list, and only the status
  // tells them apart. Blaming the address for the network is the failure mode.
  it('waits and says nothing at all when the search itself failed', () => {
    for (const value of ['310155', '43179', 'toa payoh', 'x', '']) {
      assert.deepEqual(
        origin.commitDecision({ value, rows: [], status: 'offline', activeIndex: -1 }),
        { action: 'wait' },
        `offline must not answer for ${JSON.stringify(value)}`,
      );
    }
  });

  // One character asks for nothing — nothing below two ever reaches the request —
  // so the only honest answer is how much is needed, and in the new units.
  it('answers a single character with the six-digit hint', () => {
    const decision = decide({ value: '3', rows: ROWS });
    assert.equal(decision.action, 'note');
    assert.match(decision.message, /6-digit/);
    assert.deepEqual(decide({ value: '', rows: [] }), decision);
  });

  // Committing the top hit would be guessing between addresses the user can see
  // and has deliberately not tapped.
  it('waits when a text query has rows to tap', () => {
    assert.deepEqual(decide({ value: 'toa payoh', rows: ROWS }), { action: 'wait' });
  });

  // Byte-identical to the note `finderState` already put under the box: Enter
  // must not rephrase a fact the user is already reading.
  it('reuses the finder wording when a text query matched nothing', () => {
    const panel = origin.finderState({
      value: 'atlantis interchange',
      results: [],
      status: 'ok',
      recents: [],
    });
    assert.deepEqual(decide({ value: 'atlantis interchange', rows: [] }), {
      action: 'note',
      message: panel.note,
    });
    assert.equal(panel.note, 'No address matched.');
  });
});

// --- the postal-code finder ---------------------------------------------
//
// Everything below is added by Task 3 of docs/postal-code-finder.md and is
// unused by the running app until Task 6 wires it. Appended rather than slotted
// in beside related blocks, per the note at the top of the file.

const PLACE_A = {
  mode: 'place',
  postal: '310155',
  code: null,
  label: 'Blk 155',
  name: '155 Lorong 1 Toa Payoh',
  lat: 1.33241,
  lon: 103.847,
};
const PLACE_B = {
  mode: 'place',
  postal: '018956',
  code: null,
  label: 'Marina Bay Sands',
  name: 'Marina Bay Sands, 10 Bayfront Avenue',
  lat: 1.283761,
  lon: 103.860719,
};
// The stop-code escape hatch, which carries a code and no postal at all.
const PLACE_STOP = {
  mode: 'place',
  postal: null,
  code: '43179',
  label: 'Stop 43179',
  name: 'Stop 43179',
  lat: 1.3325,
  lon: 103.8475,
};

describe('placeFromRow', () => {
  it('builds label, name and postal from a block-and-road row', () => {
    assert.deepEqual(
      origin.placeFromRow({
        postal: '310155',
        code: null,
        building: '',
        block: '155',
        road: 'LORONG 1 TOA PAYOH',
        lat: 1.33241,
        lon: 103.847,
      }),
      PLACE_A,
    );
  });

  // A building name is what someone would say out loud, so it outranks the block
  // even though the block is shorter.
  it('prefers a building name for the label', () => {
    const place = origin.placeFromRow({
      postal: '018956',
      code: null,
      building: 'MARINA BAY SANDS',
      block: '10',
      road: 'BAYFRONT AVENUE',
      lat: 1.283761,
      lon: 103.860719,
    });
    assert.equal(place.label, 'Marina Bay Sands');
    assert.equal(place.name, 'Marina Bay Sands, 10 Bayfront Avenue');
  });

  it('falls back down the chain: road, then Stop {code}, then S{postal}', () => {
    const road = origin.placeFromRow({
      postal: null,
      code: null,
      building: '',
      block: '',
      road: 'BAYFRONT AVENUE',
      lat: 1.283761,
      lon: 103.860719,
    });
    assert.equal(road.label, 'Bayfront Avenue');

    assert.deepEqual(
      origin.placeFromRow({
        postal: null,
        code: '43179',
        building: '',
        block: '',
        road: '',
        lat: 1.3325,
        lon: 103.8475,
      }),
      PLACE_STOP,
    );

    const postalOnly = origin.placeFromRow({
      postal: '310155',
      code: null,
      building: '',
      block: '',
      road: '',
      lat: 1.33241,
      lon: 103.847,
    });
    assert.equal(postalOnly.label, 'S310155');
    // No street to describe, so the name is the label rather than an empty
    // tagline reading "Stops near , live from LTA".
    assert.equal(postalOnly.name, 'S310155');
  });

  // The Gulf of Guinea trap again, this time on a scraped address dump: a row
  // that cannot be ranked from must never reach the list, let alone the chip.
  it('returns null for 0,0, for a missing coordinate, and for nothing nameable', () => {
    assert.equal(
      origin.placeFromRow({ postal: '310155', building: 'X', block: '', road: '', lat: 0, lon: 0 }),
      null,
    );
    assert.equal(
      origin.placeFromRow({ postal: '310155', building: 'X', block: '', road: '' }),
      null,
    );
    assert.equal(
      origin.placeFromRow({
        postal: null,
        code: null,
        building: '',
        block: '',
        road: '',
        lat: 1.33,
        lon: 103.84,
      }),
      null,
    );
    assert.equal(origin.placeFromRow(null), null);
  });

  // The chip shares one nowrap flex row with the h1 at 360 px; the ellipsis is
  // inside the budget, because a cap that overflows by one is not a cap.
  it('caps the label at 18 characters with an ellipsis', () => {
    const place = origin.placeFromRow({
      postal: '018956',
      code: null,
      building: 'MARINA BAY SANDS HOTEL TOWER 3',
      block: '10',
      road: 'BAYFRONT AVENUE',
      lat: 1.283761,
      lon: 103.860719,
    });
    assert.equal(place.label.length, 18);
    assert.equal(place.label.endsWith('…'), true);
  });

  it('caps the name at 40 characters', () => {
    const place = origin.placeFromRow({
      postal: '018956',
      code: null,
      building: 'MARINA BAY SANDS HOTEL',
      block: '10',
      road: 'BAYFRONT AVENUE',
      lat: 1.283761,
      lon: 103.860719,
    });
    assert.equal(place.name.length, 40);
    assert.equal(place.name.endsWith('…'), true);
  });

  // A newline reaching the chip would break a one-line flex row silently, and
  // the source is a scrape rather than a curated list.
  it('collapses newlines, tabs and runs of spaces', () => {
    const place = origin.placeFromRow({
      postal: '310165',
      code: null,
      building: ' TOA\tPAYOH   HDB\nHUB ',
      block: '',
      road: '',
      lat: 1.3325,
      lon: 103.8475,
    });
    // `HDB` rather than `Hdb`: whitespace collapsing runs before the per-word
    // acronym check, so a tab inside a name cannot hide a word from the list.
    assert.equal(place.label, 'Toa Payoh HDB Hub');
    assert.equal(place.label.includes('\n'), false);
    assert.equal(place.label.includes('\t'), false);
  });

  // Number('018956') is 18956, which is a different place entirely.
  it('keeps a leading-zero postal as a string', () => {
    const place = origin.placeFromRow({
      postal: '018956',
      code: null,
      building: 'MARINA BAY SANDS',
      block: '',
      road: '',
      lat: 1.283761,
      lon: 103.860719,
    });
    assert.equal(typeof place.postal, 'string');
    assert.equal(place.postal, '018956');
  });

  // A malformed postal is not a reason to throw away a row that has a building
  // name and a usable coordinate — it is a reason to stop claiming a postal.
  it('nulls a 5-digit or non-string postal without dropping the row', () => {
    for (const postal of ['31015', 310155, null, undefined, '3101555', 'S310155']) {
      const place = origin.placeFromRow({
        postal,
        code: null,
        building: 'MARINA BAY SANDS',
        block: '',
        road: '',
        lat: 1.283761,
        lon: 103.860719,
      });
      assert.equal(place.postal, null);
      assert.equal(place.label, 'Marina Bay Sands');
    }
  });
});

describe('readRecents', () => {
  it('returns an empty list for anything that is not an array of places', () => {
    for (const raw of [null, '', '{', 'null', '{"postal":"310155"}', '[1,"x",null,{}]']) {
      assert.deepEqual(origin.readRecents(raw), []);
    }
  });

  it('keeps well-formed entries in order', () => {
    assert.deepEqual(origin.readRecents(JSON.stringify([PLACE_A, PLACE_B])), [PLACE_A, PLACE_B]);
  });

  // One bad entry costs the user one address, not the whole list — and there is
  // nothing they could have done about the bad one anyway.
  it('drops an unrankable entry rather than the whole list', () => {
    const raw = JSON.stringify([
      PLACE_A,
      { mode: 'place', postal: null, code: null, label: 'Nowhere', name: 'Nowhere', lat: 0, lon: 0 },
      { mode: 'place', postal: null, code: null, label: '', name: '', lat: 1.33, lon: 103.84 },
      PLACE_B,
    ]);
    assert.deepEqual(origin.readRecents(raw), [PLACE_A, PLACE_B]);
  });

  it('caps the list at five', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...PLACE_A, postal: `31015${i}` }));
    const recents = origin.readRecents(JSON.stringify(many));
    assert.equal(recents.length, 5);
    assert.equal(recents[4].postal, '310154');
  });

  // Re-capped on read, not only on write: the record may predate a change to
  // LABEL_MAX, or have been hand-edited in DevTools.
  it('re-caps an over-long stored label', () => {
    const raw = JSON.stringify([{ ...PLACE_A, label: 'A'.repeat(40) }]);
    const [place] = origin.readRecents(raw);
    assert.equal(place.label.length, 18);
    assert.equal(place.label.endsWith('…'), true);
  });
});

describe('rememberRecent', () => {
  it('puts the place first', () => {
    const list = origin.rememberRecent([PLACE_A], PLACE_B);
    assert.deepEqual(list, [PLACE_B, PLACE_A]);
  });

  // Moved, not added: five slots are few enough that a duplicate would evict a
  // different address the user still wants.
  it('dedupes by postal, moving the existing entry to the front', () => {
    const again = { ...PLACE_A, label: 'Blk 155 Toa' };
    const list = origin.rememberRecent([PLACE_A, PLACE_B], again);
    assert.equal(list.length, 2);
    assert.equal(list[0].label, 'Blk 155 Toa');
    assert.deepEqual(list[1], PLACE_B);
  });

  // A stop row and a road-only row have no postal, so the coordinate is the only
  // identity they have.
  it('dedupes by lat,lon when both postals are null', () => {
    const list = origin.rememberRecent([PLACE_STOP], { ...PLACE_STOP, label: 'Blk 155' });
    assert.equal(list.length, 1);
    assert.equal(list[0].label, 'Blk 155');
  });

  it('caps at five, dropping the oldest', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ ...PLACE_A, postal: `31015${i}` }));
    const list = origin.rememberRecent(five, PLACE_B);
    assert.equal(list.length, 5);
    assert.deepEqual(list[0], PLACE_B);
    assert.equal(list[4].postal, '310153');
    assert.equal(
      list.some((place: { postal: string }) => place.postal === '310154'),
      false,
    );
  });

  it('returns the list unchanged for a null place', () => {
    assert.deepEqual(origin.rememberRecent([PLACE_A, PLACE_B], null), [PLACE_A, PLACE_B]);
    assert.deepEqual(origin.rememberRecent([PLACE_A], undefined), [PLACE_A]);
  });

  // The caller keeps the old list in a module variable and writes the returned
  // one to storage. Mutating in place would make the two indistinguishable, so a
  // failed write would leave the UI claiming something storage does not hold.
  it('never mutates the input array', () => {
    const list = [PLACE_A, PLACE_B];
    const before = JSON.parse(JSON.stringify(list));
    const next = origin.rememberRecent(list, PLACE_STOP);
    assert.deepEqual(list, before);
    assert.equal(list.length, 2);
    assert.notEqual(next, list);
    assert.equal(next.length, 3);
  });
});

describe('moveActive', () => {
  it('moves from nothing highlighted to the first row on the way down', () => {
    assert.equal(origin.moveActive(-1, 1, 3), 0);
  });

  it('wraps the last row round to the first', () => {
    assert.equal(origin.moveActive(2, 1, 3), 0);
  });

  // Up from nothing highlighted lands on the last row, which is what makes one
  // key press reach the bottom of a short list.
  it('moves from nothing highlighted to the last row on the way up', () => {
    assert.equal(origin.moveActive(-1, -1, 3), 2);
    assert.equal(origin.moveActive(0, -1, 3), 2);
  });

  it('stays at nothing highlighted when there are no rows', () => {
    assert.equal(origin.moveActive(-1, 1, 0), -1);
    assert.equal(origin.moveActive(0, -1, 0), -1);
  });

  // A stale index left over from a longer list: the highlight the user was
  // looking at is gone, so start again rather than land on whatever took its place.
  it('clamps an out-of-range start', () => {
    assert.equal(origin.moveActive(9, 1, 3), 0);
    assert.equal(origin.moveActive(9, -1, 3), 2);
    assert.equal(origin.moveActive(NaN, 1, 3), 0);
  });
});

describe('finderState', () => {
  const RECENTS = [PLACE_A, PLACE_B];
  const RESULTS = [{ place: PLACE_A }, { place: PLACE_B }];

  // Recent moved out of the listbox and into `originsState`, which is what fixes
  // `#results` announcing "Search results" over the Recent list. An empty box now
  // collapses the listbox rather than filling it with rows nobody searched for.
  it('collapses the listbox for an empty box', () => {
    const panel = origin.finderState({ value: '', results: [], status: 'idle' });
    assert.equal(panel.state, 'idle');
    assert.deepEqual(panel.rows, []);
    assert.equal(panel.heading, '');
    assert.equal(panel.note, '');
    assert.equal(panel.busy, false);
    assert.equal(panel.expanded, false);
    assert.equal(panel.showClear, false);
  });

  it('asks for one more character at one character, with no rows', () => {
    const panel = origin.finderState({ value: 'T', results: [], status: 'idle' });
    assert.equal(panel.state, 'short');
    assert.deepEqual(panel.rows, []);
    assert.equal(panel.heading, '');
    assert.equal(panel.note, 'Keep typing — 2 letters, or a 6-digit postal code.');
    assert.equal(panel.busy, false);
    assert.equal(panel.expanded, false);
    assert.equal(panel.showClear, true);
  });

  // The list must not empty and refill on every keystroke, so a search in flight
  // keeps whatever is already on screen and says so with aria-busy instead.
  it('keeps the previous rows while a search is in flight', () => {
    const panel = origin.finderState({
      value: 'toa payoh',
      results: RESULTS,
      status: 'searching',
      recents: RECENTS,
    });
    assert.equal(panel.state, 'searching');
    assert.equal(panel.rows.length, 2);
    assert.deepEqual(panel.rows, RESULTS);
    assert.equal(panel.heading, '');
    assert.equal(panel.note, '');
    assert.equal(panel.busy, true);
    assert.equal(panel.expanded, true);
  });

  it('shows the hits when the search comes back with some', () => {
    const panel = origin.finderState({
      value: 'toa payoh',
      results: [{ place: PLACE_A }],
      status: 'ok',
      recents: RECENTS,
    });
    assert.equal(panel.state, 'results');
    assert.equal(panel.rows.length, 1);
    assert.equal(panel.rows[0].place.label, 'Blk 155');
    assert.equal(panel.heading, '');
    assert.equal(panel.note, '');
    assert.equal(panel.busy, false);
    assert.equal(panel.expanded, true);
  });

  it('says so when nothing matched, with no rows at all', () => {
    const panel = origin.finderState({
      value: 'atlantis interchange',
      results: [],
      status: 'ok',
      recents: RECENTS,
    });
    assert.equal(panel.state, 'empty');
    assert.equal(panel.rows.length, 0);
    assert.equal(panel.heading, '');
    assert.equal(panel.note, 'No address matched.');
    assert.equal(panel.busy, false);
    assert.equal(panel.expanded, false);
  });

  // This state used to be the one place Recent earned its keep, and that is now
  // true of every state: the destinations list sits above the box permanently, so
  // an unavailable search costs the note and nothing else.
  it('reports an unavailable search without borrowing rows', () => {
    const panel = origin.finderState({
      value: 'toa payoh',
      results: [],
      status: 'offline',
    });
    assert.equal(panel.state, 'offline');
    assert.deepEqual(panel.rows, []);
    assert.equal(panel.heading, '');
    assert.equal(panel.note, 'Search is unavailable right now.');
    assert.equal(panel.busy, false);
    assert.equal(panel.expanded, false);
  });

  it('asks for nothing below two characters and asks at exactly two', () => {
    const at = (value: string) =>
      origin.finderState({ value, results: [], status: 'idle', recents: [] }).shouldSearch;
    assert.equal(at(''), false);
    assert.equal(at('t'), false);
    assert.equal(at('to'), true);
    assert.equal(at('310155'), true);
  });

  // The S prefix is stripped here rather than at commit time, or the request
  // never carries the digits the server can resolve.
  it('normalises the query it hands back', () => {
    const query = (value: string) =>
      origin.finderState({ value, results: [], status: 'idle', recents: [] }).query;
    assert.equal(query('S310155'), '310155');
    assert.equal(query('s 310155'), '310155');
    assert.equal(query('  toa   payoh  '), 'toa payoh');
    assert.equal(query('310155'), '310155');
  });

  it('holds search results only, in every state', () => {
    const rowsFor = (value: string, status: string, results: unknown[]) =>
      origin.finderState({ value, results, status }).rows;
    for (const { value, status } of [
      { value: '', status: 'idle' },
      { value: 't', status: 'idle' },
      { value: 'toa payoh', status: 'offline' },
    ]) {
      assert.deepEqual(rowsFor(value, status, []), []);
    }
    assert.deepEqual(
      rowsFor('toa payoh', 'ok', [{ place: PLACE_B }]).map(
        (row: { place: { label: string } }) => row.place.label,
      ),
      ['Marina Bay Sands'],
    );
  });

  // The regression guard for the whole task: the argument is gone, so passing it
  // must make no difference. If this ever fails, a recents branch crept back in.
  it('ignores a recents argument entirely', () => {
    for (const { value, status } of [
      { value: '', status: 'idle' },
      { value: 't', status: 'idle' },
      { value: 'toa payoh', status: 'offline' },
      { value: 'toa payoh', status: 'searching' },
      { value: 'atlantis interchange', status: 'ok' },
    ]) {
      assert.deepEqual(
        origin.finderState({ value, results: [], status, recents: RECENTS }),
        origin.finderState({ value, results: [], status }),
      );
    }
  });

  // Filtered before render rather than refused on tap: a row that cannot become
  // an origin should never have been on screen in the first place.
  it('drops unrankable results out of the rows', () => {
    const panel = origin.finderState({
      value: 'toa payoh',
      status: 'ok',
      recents: [],
      results: [
        { place: null },
        { place: { ...PLACE_A, lat: 0, lon: 0 } },
        { place: PLACE_B },
        {},
      ],
    });
    assert.equal(panel.rows.length, 1);
    assert.equal(panel.rows[0].place.label, 'Marina Bay Sands');
  });

  it('shows the clear button exactly when there is something to clear', () => {
    const clear = (value: string) =>
      origin.finderState({ value, results: [], status: 'idle', recents: [] }).showClear;
    assert.equal(clear(''), false);
    assert.equal(clear('   '), false);
    assert.equal(clear('t'), true);
    assert.equal(clear('310155'), true);
  });

  // Enter must not rephrase a fact the user is already reading under the box.
  // `commitDecision` returns this same constant; the block above asserts the two
  // against each other, and this pins the exact bytes both have to carry.
  it('uses the exact no-match sentence Enter reuses', () => {
    const panel = origin.finderState({
      value: 'atlantis interchange',
      results: [],
      status: 'ok',
      recents: [],
    });
    assert.equal(panel.note, 'No address matched.');
  });
});

// The destinations list. Every case below is one of the rules in the plan's A1
// table, in that order, so a failure names the rule it broke.
describe('originsState', () => {
  const GPS = { mode: 'gps' };
  const supported = { geolocationSupported: true };

  it('offers the location door alone when nothing has been used yet', () => {
    const { rows } = origin.originsState({ origin: null, recents: [], ...supported });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'gps');
    assert.equal(rows[0].place, null);
    assert.equal(rows[0].primary, 'Near you');
    assert.equal(rows[0].current, false);
    assert.equal(rows[0].showUpdate, false);
    assert.equal(rows[0].detail, 'Uses your device location');
    assert.equal(rows[0].status, '');
  });

  // The whole point of the redesign: the row that says what the board is doing
  // is not also the button that re-does it.
  it('marks the gps row current and asks for the update affordance', () => {
    const { rows } = origin.originsState({ origin: GPS, recents: [], ...supported });
    assert.equal(rows[0].current, true);
    assert.equal(rows[0].showUpdate, true);
    assert.equal(rows[0].status, 'Showing now');
    assert.equal(rows[0].detail, '');
  });

  it('omits the gps row entirely when geolocation cannot work', () => {
    const { rows } = origin.originsState({
      origin: null,
      recents: [],
      geolocationSupported: false,
    });
    assert.deepEqual(rows, []);
  });

  it('still lists recents with no gps row', () => {
    const { rows } = origin.originsState({
      origin: null,
      recents: [PLACE_A, PLACE_B],
      geolocationSupported: false,
    });
    assert.equal(rows.length, 2);
    assert.equal(
      rows.some((row: { kind: string }) => row.kind === 'gps'),
      false,
    );
  });

  // A caller that forgets the flag loses the primary door, which one manual pass
  // catches. The lenient reading would ship a dead button to the devices that
  // cannot use it, which nothing catches.
  it('treats a missing flag as unsupported rather than guessing', () => {
    const { rows } = origin.originsState({ origin: GPS, recents: [] });
    assert.deepEqual(rows, []);
  });

  it('keeps recents in stored order under the gps row', () => {
    const third = { ...PLACE_A, postal: '310159', label: 'Blk 159' };
    const { rows } = origin.originsState({
      origin: GPS,
      recents: [PLACE_A, PLACE_B, third],
      ...supported,
    });
    assert.equal(rows.length, 4);
    assert.equal(rows[0].kind, 'gps');
    assert.deepEqual(
      rows.slice(1).map((row: { place: { postal: string } }) => row.place.postal),
      ['310155', '018956', '310159'],
    );
  });

  it('shows a current place once, not twice, when recents also hold it', () => {
    const current = { ...PLACE_A, label: 'Blk 155 Toa' };
    const { rows } = origin.originsState({
      origin: current,
      recents: [PLACE_A, PLACE_B],
      ...supported,
    });
    assert.equal(rows.length, 3);
    assert.equal(rows[1].place.label, 'Blk 155 Toa');
    assert.equal(rows[1].current, true);
    assert.equal(rows[1].status, 'Showing now');
    assert.equal(rows[2].current, false);
  });

  it('dedupes a stop row by its code', () => {
    const moved = { ...PLACE_STOP, lat: 1.4, lon: 103.9, label: 'Stop moved' };
    const { rows } = origin.originsState({
      origin: moved,
      recents: [PLACE_STOP],
      ...supported,
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[1].place.label, 'Stop moved');
  });

  it('dedupes a road-only row by its coordinate', () => {
    const road = { mode: 'place', postal: null, code: null, label: 'Lorong 1', name: 'Lorong 1 Toa Payoh', lat: 1.33241, lon: 103.847 };
    const { rows } = origin.originsState({
      origin: { ...road, label: 'Lor 1' },
      recents: [road],
      ...supported,
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[1].place.label, 'Lor 1');
  });

  it('inserts a current place that recents do not hold, directly under gps', () => {
    const { rows } = origin.originsState({
      origin: PLACE_STOP,
      recents: [PLACE_A, PLACE_B],
      ...supported,
    });
    assert.equal(rows.length, 4);
    assert.equal(rows[1].place.code, '43179');
    assert.equal(rows[1].current, true);
  });

  it('drops recents the board could not be ranked from', () => {
    const { rows } = origin.originsState({
      origin: null,
      recents: [
        { ...PLACE_A, lat: NaN },
        { ...PLACE_B, lat: 0, lon: 0 },
        { ...PLACE_A, postal: '310157', lon: undefined },
        PLACE_B,
      ],
      ...supported,
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[1].place.postal, '018956');
  });

  it('caps the place rows at five however many recents there are', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ ...PLACE_A, postal: `31015${i}` }));
    const { rows } = origin.originsState({ origin: GPS, recents: eight, ...supported });
    assert.equal(rows.filter((row: { kind: string }) => row.kind === 'place').length, 5);
  });

  it('names the list', () => {
    assert.equal(origin.originsState({ origin: null, recents: [], ...supported }).heading, 'Show stops near');
  });

  // The long name leads and the postal goes underneath, the same two lines
  // `renderRows` gives a search result — the two lists are one list split by a rule.
  it('leads with the name and details the postal, like a search row', () => {
    const { rows } = origin.originsState({ origin: null, recents: [PLACE_A], ...supported });
    assert.equal(rows[1].primary, '155 Lorong 1 Toa Payoh');
    assert.equal(rows[1].detail, 'Singapore 310155');
  });

  it('details a stop row by its code and a road-only row not at all', () => {
    const road = { mode: 'place', postal: null, code: null, label: 'Lorong 1', name: 'Lorong 1 Toa Payoh', lat: 1.33241, lon: 103.847 };
    const { rows } = origin.originsState({
      origin: null,
      recents: [PLACE_STOP, road],
      ...supported,
    });
    assert.equal(rows[1].detail, 'Stop 43179');
    assert.equal(rows[2].detail, '');
  });

  it('never offers a place row without a place to commit', () => {
    const { rows } = origin.originsState({
      origin: GPS,
      recents: [PLACE_A, null, undefined, PLACE_B],
      ...supported,
    });
    for (const row of rows.filter((r: { kind: string }) => r.kind === 'place')) {
      assert.ok(row.place);
      assert.equal(origin.isUsableCoord(row.place.lat, row.place.lon), true);
    }
  });
});

// Direct coverage, which this function did not have — it was only exercised
// through `placeFromRow`, which is why the acronym weakness survived to be a
// documented open issue rather than a failing assertion.
describe('titleCase', () => {
  it('keeps the acronyms that are said as letters', () => {
    assert.equal(origin.titleCase('HDB HUB'), 'HDB Hub');
    assert.equal(origin.titleCase('NTUC FAIRPRICE'), 'NTUC Fairprice');
    assert.equal(origin.titleCase('TOA PAYOH HDB HUB'), 'Toa Payoh HDB Hub');
    assert.equal(origin.titleCase('SMRT BUS DEPOT'), 'SMRT Bus Depot');
  });

  // The reason there is no "short and no vowels" heuristic: every one of these
  // would qualify for it, and every one of them is read as a word.
  it('title-cases the abbreviations a heuristic would have shouted', () => {
    assert.equal(origin.titleCase("ST. GEORGE'S ROAD"), "St. George's Road");
    assert.equal(origin.titleCase('BLK 155 LORONG 1 TOA PAYOH'), 'Blk 155 Lorong 1 Toa Payoh');
    assert.equal(origin.titleCase('JLN BESAR'), 'Jln Besar');
    assert.equal(origin.titleCase('WOODLANDS AVE 5'), 'Woodlands Ave 5');
    assert.equal(origin.titleCase('UPP THOMSON RD'), 'Upp Thomson Rd');
  });

  it('leaves ordinary names alone', () => {
    assert.equal(origin.titleCase('MARINA BAY SANDS'), 'Marina Bay Sands');
    assert.equal(origin.titleCase('ANG MO KIO AVENUE 3'), 'Ang Mo Kio Avenue 3');
  });

  // Found by looking at the rendered rows for `woodlands ave 5`, not by reasoning:
  // an acronym joined to a name by a hyphen is one space-delimited word and two
  // names, and a space-splitting implementation renders it `Hdb-Woodlands`. The
  // real index is full of these.
  it('finds an acronym joined to a name by punctuation', () => {
    assert.equal(origin.titleCase('HDB-WOODLANDS'), 'HDB-Woodlands');
    assert.equal(origin.titleCase('HDB-ST GEORGES RD'), 'HDB-St Georges Rd');
    assert.equal(origin.titleCase('MRT/LRT STATION'), 'MRT/LRT Station');
    assert.equal(origin.titleCase('(DBS)'), '(DBS)');
  });

  // The apostrophe has to stay inside the run: outside it, the trailing S becomes
  // its own run and capitalises to `George'S`.
  it('keeps a possessive lower-case', () => {
    assert.equal(origin.titleCase("GEORGE'S"), "George's");
    assert.equal(origin.titleCase("ST. GEORGE'S ROAD, BLK 10"), "St. George's Road, Blk 10");
  });

  // Every documented member round-trips. Cheaper to keep true than a sortedness
  // assertion, and it is the property that actually matters.
  it('capitalises every listed acronym, from either case', () => {
    for (const word of [
      'CPF', 'HDB', 'ITE', 'JTC', 'LRT', 'MRT', 'MSCP', 'NTU', 'NTUC',
      'NUS', 'PSA', 'SBS', 'SIT', 'SMRT', 'SMU', 'SUTD', 'URA',
    ]) {
      assert.equal(origin.titleCase(word), word);
      assert.equal(origin.titleCase(word.toLowerCase()), word);
    }
  });

  it('collapses whitespace and survives a non-string', () => {
    assert.equal(origin.titleCase('  TOA   PAYOH  '), 'Toa Payoh');
    assert.equal(origin.titleCase(null), '');
    assert.equal(origin.titleCase(undefined), '');
    assert.equal(origin.titleCase(42), '');
  });
});

/**
 * The rounding rule the board has always applied and never had under test —
 * docs/datamall-activation.md asks for it as a fixed offset table rather than a reading of
 * the source, because "floors" and "rounds down to the minute a rider can act on" are the
 * same sentence until one of them is off by a minute.
 */
describe('minutesUntil', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const at = (seconds: number) => new Date(now + seconds * 1_000).toISOString();

  it('rounds down, so a bus is never promised more time than it has', () => {
    assert.equal(origin.minutesUntil(at(59), now), 0);
    assert.equal(origin.minutesUntil(at(60), now), 1);
    assert.equal(origin.minutesUntil(at(119), now), 1);
    assert.equal(origin.minutesUntil(at(120), now), 2);
    assert.equal(origin.minutesUntil(at(239), now), 3);
  });

  // Both render as "Arr": the card has no third state for a bus that has already gone, and
  // the floor is what puts a half-minute-late timing on the right side of zero.
  it('goes negative for a timing already past', () => {
    assert.equal(origin.minutesUntil(at(-30), now), -1);
    assert.equal(origin.minutesUntil(at(0), now), 0);
  });

  it('is NaN for an unparseable timestamp rather than a wrong number', () => {
    assert.equal(Number.isNaN(origin.minutesUntil('not a date', now)), true);
  });
});

describe('isIncoming', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const bus = (seconds: number, monitored = true) => ({
    estimatedArrival: new Date(now + seconds * 1_000).toISOString(),
    monitored,
  });

  // The bounds are in displayed minutes, not seconds: the mark moves for exactly the rows
  // whose lead number reads 3, 2 or 1.
  it('covers 1 through 3 minutes and stops either side', () => {
    assert.equal(origin.isIncoming(bus(60), now), true); // "1 min"
    assert.equal(origin.isIncoming(bus(180), now), true); // "3 min"
    assert.equal(origin.isIncoming(bus(239), now), true); // still "3 min"
    assert.equal(origin.isIncoming(bus(240), now), false); // "4 min"
  });

  it('stops at Arr — the number stops counting, the mark stops moving', () => {
    assert.equal(origin.isIncoming(bus(59), now), false);
    assert.equal(origin.isIncoming(bus(0), now), false);
  });

  // A card whose refresh keeps failing holds its last timings, so a long-departed bus can
  // sit on screen reading "Arr" indefinitely. Nothing about it should be in motion.
  it('stays off for a stale timing', () => {
    assert.equal(origin.isIncoming(bus(-300), now), false);
  });

  // Trails claim a particular vehicle is approaching, which a timetable estimate cannot
  // support however close it says the bus is.
  it('refuses an untracked bus at any timing', () => {
    assert.equal(origin.isIncoming(bus(120, false), now), false);
    assert.equal(origin.isIncoming(bus(60, false), now), false);
  });

  it('refuses a missing bus, a missing timing and an unparseable one', () => {
    assert.equal(origin.isIncoming(null, now), false);
    assert.equal(origin.isIncoming(undefined, now), false);
    assert.equal(origin.isIncoming({ estimatedArrival: null, monitored: true }, now), false);
    assert.equal(origin.isIncoming({ estimatedArrival: 'not a date', monitored: true }, now), false);
  });
});

describe('readHintRecord', () => {
  it('reads a first visit from an absent or empty key', () => {
    assert.deepEqual(origin.readHintRecord(null), { shown: 0 });
    assert.deepEqual(origin.readHintRecord(undefined), { shown: 0 });
    assert.deepEqual(origin.readHintRecord(''), { shown: 0 });
  });

  // The cost of guessing wrong here is at most three showings of one sentence,
  // which is why every unrecognised shape reads as a first visit rather than as
  // a retired tip.
  it('degrades to a first visit for anything that is not an object with a count', () => {
    assert.deepEqual(origin.readHintRecord('not json'), { shown: 0 });
    assert.deepEqual(origin.readHintRecord('{}'), { shown: 0 });
    assert.deepEqual(origin.readHintRecord('[]'), { shown: 0 });
  });

  // Three shapes this app never writes, so each one is hand-edited or corrupt.
  // A string count would sail through `>=` comparisons; a fraction would count
  // up forever without ever reaching the threshold.
  it('rejects a stringy, negative or fractional count', () => {
    assert.deepEqual(origin.readHintRecord('{"shown":"2"}'), { shown: 0 });
    assert.deepEqual(origin.readHintRecord('{"shown":-1}'), { shown: 0 });
    assert.deepEqual(origin.readHintRecord('{"shown":1.5}'), { shown: 0 });
  });

  it('keeps a real count, including one already past the threshold', () => {
    assert.deepEqual(origin.readHintRecord('{"shown":2}'), { shown: 2 });
    assert.deepEqual(origin.readHintRecord('{"shown":99}'), { shown: 99 });
  });
});

describe('hintDecision', () => {
  it('counts up on each of the three showings and then retires', () => {
    assert.deepEqual(origin.hintDecision({ raw: null, boardHasCards: true }), {
      show: true,
      record: { shown: 1 },
    });
    assert.deepEqual(origin.hintDecision({ raw: '{"shown":1}', boardHasCards: true }), {
      show: true,
      record: { shown: 2 },
    });
    assert.deepEqual(origin.hintDecision({ raw: '{"shown":2}', boardHasCards: true }), {
      show: true,
      record: { shown: 3 },
    });
    assert.deepEqual(origin.hintDecision({ raw: '{"shown":3}', boardHasCards: true }), {
      show: false,
      record: null,
    });
  });

  // A count past the threshold can only come from a hand-edited key, but it
  // must not wrap round into a fourth showing.
  it('stays retired above the threshold', () => {
    assert.deepEqual(origin.hintDecision({ raw: '{"shown":99}', boardHasCards: true }), {
      show: false,
      record: null,
    });
  });

  // The gate, an empty board and a refusal are all moments with nothing to
  // point at. `record: null` at every rung is the part that matters: the caller
  // writes only what it is handed, so a suppressed tip cannot burn a showing.
  it('never shows and never writes on a board with no cards', () => {
    for (const raw of [null, '{"shown":1}', '{"shown":2}', '{"shown":3}']) {
      assert.deepEqual(origin.hintDecision({ raw, boardHasCards: false }), {
        show: false,
        record: null,
      });
    }
  });

  // Same reading `originsState` gives `geolocationSupported`: a caller that
  // forgets the flag loses the tip rather than teaching over a gate.
  it('treats a missing flag as no cards', () => {
    assert.deepEqual(origin.hintDecision({ raw: null }), { show: false, record: null });
  });

  // Decision 3: "Got it" is the rider saying the lesson landed, so it ends the
  // tip in one step from any count, not a "seen once" increment.
  it('is retired in one step by a dismissal, from any starting count', () => {
    for (const raw of [null, '{"shown":1}', '{"shown":2}']) {
      const before = origin.hintDecision({ raw, boardHasCards: true });
      assert.equal(before.show, true);

      const dismissed = JSON.stringify(origin.dismissedHintRecord());
      assert.deepEqual(origin.hintDecision({ raw: dismissed, boardHasCards: true }), {
        show: false,
        record: null,
      });
    }
  });
});

describe('dismissedHintRecord', () => {
  it('is the retired state itself, not one more than the last count', () => {
    assert.deepEqual(origin.dismissedHintRecord(), { shown: origin.HINT_MAX_SHOWINGS });
    assert.deepEqual(origin.dismissedHintRecord(), { shown: 3 });
  });

  // It is stringified into storage and read back by `readHintRecord`, so the
  // round trip has to survive its own JSON.
  it('survives a round trip through readHintRecord', () => {
    const raw = JSON.stringify(origin.dismissedHintRecord());
    assert.equal(raw, '{"shown":3}');
    assert.deepEqual(origin.readHintRecord(raw), { shown: 3 });
  });
});

// The copy has one source — `app.js` fills the markup from these, so `index.html`
// cannot drift the way it can for `ADDRESS_DOOR_LABEL`, which static markup has
// to write out by hand. Pinned verbatim all the same: this sentence is the only
// thing that teaches the bus-number door, and a well-meaning edit that drops its
// second half would remove that teaching silently.
describe('hint copy', () => {
  it('names both doors, verbatim', () => {
    assert.equal(
      origin.HINT_COPY,
      'Tap a stop for every bus that calls there. Tap a bus number for where it goes.',
    );
  });

  it('uses Got it on the dismiss control', () => {
    assert.equal(origin.HINT_DISMISS_LABEL, 'Got it');
  });

  it('retires after three showings', () => {
    assert.equal(origin.HINT_MAX_SHOWINGS, 3);
  });
});
