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

describe('isUsableStopCoord', () => {
  it('accepts a normal Singapore coordinate', () => {
    assert.equal(origin.isUsableStopCoord(1.29684825, 103.85253591), true);
  });

  it('rejects 0,0 — the stops search() keeps but nearby() drops', () => {
    assert.equal(origin.isUsableStopCoord(0, 0), false);
  });

  it('accepts lat 0 with a non-zero lon, which is a real place', () => {
    assert.equal(origin.isUsableStopCoord(0, 103.85), true);
    assert.equal(origin.isUsableStopCoord(1.29, 0), true);
  });

  it('rejects NaN, undefined and strings', () => {
    assert.equal(origin.isUsableStopCoord(NaN, 103.85), false);
    assert.equal(origin.isUsableStopCoord(1.29, NaN), false);
    assert.equal(origin.isUsableStopCoord(undefined, undefined), false);
    assert.equal(origin.isUsableStopCoord('1.29', '103.85'), false);
    assert.equal(origin.isUsableStopCoord(Infinity, 103.85), false);
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
const STOP_RECORD = {
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

  // Intact, not normalised: `description` and `roadName` are what the chip's
  // aria-label is built from later, so the guard must not strip them.
  it('returns a valid stop record intact', () => {
    assert.deepEqual(origin.readOriginRecord(JSON.stringify(STOP_RECORD)), STOP_RECORD);
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

  it('returns null for a stop record with no coordinates', () => {
    assert.equal(origin.readOriginRecord('{"mode":"stop","code":"43179"}'), null);
  });

  it('returns null for a 4-digit code', () => {
    assert.equal(
      origin.readOriginRecord('{"mode":"stop","code":"4317","lat":1.33,"lon":103.84}'),
      null,
    );
  });

  it('returns null for a 6-digit code', () => {
    assert.equal(
      origin.readOriginRecord('{"mode":"stop","code":"431790","lat":1.33,"lon":103.84}'),
      null,
    );
  });

  // The Gulf of Guinea trap: search() keeps 0,0 stops findable, so this record
  // is reachable. Accepting it would rank all of Singapore ~1,300 km away.
  it('returns null for a stop record at 0,0', () => {
    assert.equal(origin.readOriginRecord('{"mode":"stop","code":"43179","lat":0,"lon":0}'), null);
  });

  it('returns null for a non-numeric lat', () => {
    assert.equal(
      origin.readOriginRecord('{"mode":"stop","code":"43179","lat":"1.33","lon":103.84}'),
      null,
    );
  });

  // The property that makes it safe to write the code into the chip. Anything
  // accepted here is a 5-digit string, so no escaping decision is needed.
  it('only ever accepts a stop code that is a 5-digit string', () => {
    const candidates = [
      '{"mode":"stop","code":"43179","lat":1.33,"lon":103.84}',
      '{"mode":"stop","code":43179,"lat":1.33,"lon":103.84}',
      '{"mode":"stop","code":" 43179 ","lat":1.33,"lon":103.84}',
      '{"mode":"stop","code":"431a9","lat":1.33,"lon":103.84}',
      '{"mode":"stop","code":"<script>","lat":1.33,"lon":103.84}',
      '{"mode":"stop","code":null,"lat":1.33,"lon":103.84}',
      JSON.stringify(STOP_RECORD),
    ];
    let accepted = 0;
    for (const raw of candidates) {
      const record = origin.readOriginRecord(raw);
      if (record === null) continue;
      accepted += 1;
      assert.equal(typeof record.code, 'string');
      assert.match(record.code, /^\d{5}$/);
    }
    assert.equal(accepted, 2); // the two well-formed ones, and only those
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

  it('sends a valid stop record to the stop journey and hands back the record', () => {
    const decision = origin.decideBoot({
      originRaw: JSON.stringify(STOP_RECORD),
      locRaw: null,
      pinCount: 0,
      now: NOW,
    });
    assert.equal(decision.journey, 'stop');
    assert.deepEqual(decision.origin, STOP_RECORD);
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

  it('shows the intro for a stop record whose code is valid but sits at 0,0', () => {
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

  it('returns the stop record’s own coordinate, ignoring the last fix', () => {
    assert.deepEqual(origin.originCoord(STOP_RECORD, FIX), { lat: 1.3325, lon: 103.8475 });
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

  it('sends the stop record’s coordinate in stop mode', () => {
    const params = parse(
      origin.boardParams({ origin: STOP_RECORD, lastLoc: FIX, pins: [], limit: 8 }),
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
  // the plan: a stop-mode user usually holds no fix, so a listener testing
  // `lastLoc` alone asks for their location on every tab focus.
  it('never re-locates in stop mode with no fix', () => {
    assert.equal(origin.shouldRelocateOnFocus(STOP_RECORD, null, NOW), false);
  });

  it('never re-locates in stop mode however ancient the fix', () => {
    const ancient = fixAgedMinutes(60 * 24 * 30);
    assert.equal(origin.shouldRelocateOnFocus(STOP_RECORD, ancient, NOW), false);
  });

  it('never re-locates with no origin', () => {
    assert.equal(origin.shouldRelocateOnFocus(null, null, NOW), false);
  });
});

describe('taglineFor', () => {
  it('says nearest you in gps mode', () => {
    assert.equal(origin.taglineFor(GPS_RECORD), 'Stops nearest you, live from LTA');
    assert.equal(origin.taglineFor(null), 'Stops nearest you, live from LTA');
  });

  it('names the stop code in stop mode', () => {
    assert.equal(origin.taglineFor(STOP_RECORD), 'Stops near 43179, live from LTA');
    assert.match(origin.taglineFor(STOP_RECORD), /43179/);
  });

  // The mock warning and the tagline make contradictory claims, so only `app.js`
  // — which knows whether mock mode is on — may choose between them. This pins
  // that this function can never be the one that clobbers the warning.
  it('never returns the mock-mode warning', () => {
    const MOCK = 'Demo data — no LTA API key configured yet';
    for (const record of [GPS_RECORD, STOP_RECORD, null]) {
      assert.notEqual(origin.taglineFor(record), MOCK);
      assert.match(origin.taglineFor(record), /live from LTA$/);
    }
  });
});

describe('gateMessageFor', () => {
  it('names you in gps mode and the code in stop mode', () => {
    assert.equal(origin.gateMessageFor(GPS_RECORD), 'Finding stops near you…');
    assert.equal(origin.gateMessageFor(null), 'Finding stops near you…');
    assert.equal(origin.gateMessageFor(STOP_RECORD), 'Finding stops near 43179…');
  });
});

describe('delistedNote', () => {
  it('names the code in stop mode and says nothing otherwise', () => {
    assert.equal(
      origin.delistedNote(STOP_RECORD),
      'Stop 43179 is no longer in service. Showing stops near it.',
    );
    // Empty rather than "Stop undefined …", so a caller that forgets
    // shouldShowDelistedNote renders nothing instead of nonsense.
    assert.equal(origin.delistedNote(GPS_RECORD), '');
    assert.equal(origin.delistedNote(null), '');
  });
});

describe('shouldShowDelistedNote', () => {
  const nearbyStop = (code: string) => ({ code, pinned: false });
  const pinnedStop = (code: string) => ({ code, pinned: true });

  it('stays hidden while the origin stop is on the board', () => {
    const board = [nearbyStop('43179'), nearbyStop('43171')];
    assert.equal(origin.shouldShowDelistedNote(STOP_RECORD, board), false);
  });

  it('shows when the origin is absent and the board holds nearby stops', () => {
    const board = [nearbyStop('43171'), nearbyStop('43189')];
    assert.equal(origin.shouldShowDelistedNote(STOP_RECORD, board), true);
  });

  // The 8-pin false positive. Pins are pushed first and the board is cut to 8
  // before the fan-out, so a user with 8 pins gets no nearby slots at all and the
  // origin stop is missing for a reason that is not delisting.
  it('stays hidden when every stop on the board is pinned', () => {
    const board = Array.from({ length: 8 }, (_, i) => pinnedStop(`1000${i}`));
    assert.equal(origin.shouldShowDelistedNote(STOP_RECORD, board), false);
  });

  it('stays hidden for an empty board — that is a failed load, not a delisting', () => {
    assert.equal(origin.shouldShowDelistedNote(STOP_RECORD, []), false);
  });

  it('stays hidden in gps mode whatever the board holds', () => {
    assert.equal(origin.shouldShowDelistedNote(GPS_RECORD, [nearbyStop('43171')]), false);
    assert.equal(origin.shouldShowDelistedNote(null, [nearbyStop('43171')]), false);
  });

  // The boundary: one non-pinned stop is enough to prove nearby ranking ran.
  it('shows on exactly one non-pinned stop among pins', () => {
    const board = [pinnedStop('10001'), pinnedStop('10002'), nearbyStop('43171')];
    assert.equal(origin.shouldShowDelistedNote(STOP_RECORD, board), true);
  });
});

describe('distanceLabel', () => {
  const card = (code: string, distanceM: unknown) => ({ code, distanceM });

  it('shows the walk from the user in gps mode', () => {
    assert.equal(origin.distanceLabel(card('43171', 420), GPS_RECORD), '420 m · 5 min walk');
  });

  it('marks the origin card in stop mode', () => {
    assert.equal(origin.distanceLabel(card('43179', 0), STOP_RECORD), '(This stop)');
  });

  // No walking time in stop mode: the board may be ranked from a stop the user is
  // nowhere near, so minutes of *their* walking would be unsupported.
  it('shows metres only on the other cards in stop mode', () => {
    const label = origin.distanceLabel(card('43171', 60), STOP_RECORD);
    assert.equal(label, '60 m');
    assert.equal(label.includes('walk'), false);
  });

  // Matched by code, not by distance: a stop across the road can also be 0 m away
  // and is still a different stop.
  it('does not claim "(This stop)" for a co-located stop that is not the origin', () => {
    assert.equal(origin.distanceLabel(card('43171', 0), STOP_RECORD), '0 m');
  });

  it('returns an empty string when the server sent no distance', () => {
    assert.equal(origin.distanceLabel(card('43171', null), STOP_RECORD), '');
    assert.equal(origin.distanceLabel(card('43171', null), GPS_RECORD), '');
  });

  it('returns an empty string when distanceM is missing entirely', () => {
    assert.equal(origin.distanceLabel({ code: '43171' }, GPS_RECORD), '');
    assert.equal(origin.distanceLabel({ code: '43171' }, STOP_RECORD), '');
  });

  it('returns an empty string with no origin at all', () => {
    assert.equal(origin.distanceLabel(card('43171', 420), null), '');
  });

  // Belt and braces on the one cell that is interpolated into innerHTML: the
  // label never carries a stop code through, so there is nothing to escape.
  // `escape()` in renderShells is the braces.
  it('never puts a raw < in the label, whatever the stop code contains', () => {
    const nasty = card('<script>alert(1)</script>', 60);
    for (const record of [GPS_RECORD, STOP_RECORD, null]) {
      assert.equal(origin.distanceLabel(nasty, record).includes('<'), false);
    }
  });
});

describe('noStopsMessage', () => {
  it('says near you in gps mode', () => {
    assert.equal(origin.noStopsMessage(GPS_RECORD), 'No bus stops found near you.');
    assert.equal(origin.noStopsMessage(null), 'No bus stops found near you.');
  });

  // "near you" would misdescribe a board ranked from a stop the user may be
  // nowhere near — the wording item 5 left behind for this item to fix.
  it('names the stop in stop mode', () => {
    assert.equal(origin.noStopsMessage(STOP_RECORD), 'No bus stops found near 43179.');
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

describe('chipState', () => {
  it('says near you in gps mode', () => {
    assert.equal(origin.chipState(GPS_RECORD).label, 'Near you ▾');
  });

  it('names the stop code in stop mode', () => {
    const { label } = origin.chipState(STOP_RECORD);
    assert.equal(label, 'Stop 43179 ▾');
    assert.match(label, /43179/);
  });

  // The 360 px width decision, pinned as a test rather than left to a comment: the
  // chip shares one flex row with the h1 and `.ghost` does not wrap, so the
  // description may only ever reach the screen reader.
  it('puts the description in the aria-label and never in the label', () => {
    const { label, ariaLabel } = origin.chipState(STOP_RECORD);
    assert.match(ariaLabel, /Blk 155/);
    assert.equal(label.includes('Blk 155'), false);
    assert.match(ariaLabel, /^Change stops shown/);
  });

  // Before either door is chosen: during the intro, and after it is dismissed.
  it('stays neutral with no origin, with no "undefined" anywhere in it', () => {
    const { label, ariaLabel } = origin.chipState(null);
    assert.equal(label.includes('undefined'), false);
    assert.equal(ariaLabel.includes('undefined'), false);
    assert.equal(label.includes('Near you'), false);
    assert.ok(label.length > 1);
  });

  it('keeps newlines and the road name out of the visible label', () => {
    const messy = { ...STOP_RECORD, description: 'Blk 155\nOpp The Mall' };
    const { label } = origin.chipState(messy);
    assert.equal(label, 'Stop 43179 ▾');
    assert.equal(label.includes('\n'), false);
    assert.equal(label.includes('Lor 1 Toa Payoh'), false);
  });
});

describe('commitDecision', () => {
  const result = (code: string, lat: number, lon: number) => ({
    code,
    description: `Blk ${code.slice(0, 3)}`,
    roadName: 'Lor 1 Toa Payoh',
    lat,
    lon,
  });
  const RESULTS = [result('43179', 1.3325, 103.8475), result('43171', 1.3319, 103.8468)];

  it('commits five digits that match a result exactly', () => {
    assert.deepEqual(origin.commitDecision('43179', RESULTS), { action: 'choose', code: '43179' });
  });

  it('names the code it could not find', () => {
    const decision = origin.commitDecision('43999', RESULTS);
    assert.equal(decision.action, 'note');
    assert.equal(decision.message, 'No stop with code 43999.');
  });

  // One character asks for nothing — `runSearch` will not query below two, because
  // /api/stops answers 400 — so the only honest answer is how much is needed.
  it('answers a single character with the five-digit hint', () => {
    const decision = origin.commitDecision('4', RESULTS);
    assert.equal(decision.action, 'note');
    assert.match(decision.message, /5-digit/);
  });

  it('answers an empty box with the same hint', () => {
    assert.deepEqual(origin.commitDecision('', []), origin.commitDecision('4', RESULTS));
  });

  // Committing the top hit would be guessing between stops the user can see and
  // has deliberately not tapped.
  it('waits when a name query has hits to tap', () => {
    assert.deepEqual(origin.commitDecision('Toa Payoh', RESULTS), { action: 'wait' });
  });

  it('reuses the search wording when a name query has no hits', () => {
    assert.deepEqual(origin.commitDecision('Atlantis Interchange', []), {
      action: 'note',
      message: 'No stops matched.',
    });
  });

  // The Gulf of Guinea trap on the commit path. search() keeps 0,0 stops findable
  // while nearby() drops them, so five digits matching one is a refusal, not a
  // commit — and it refuses in the same words as an unknown code, because the
  // difference is not one the user can see.
  it('refuses five digits matching a stop at 0,0', () => {
    const decision = origin.commitDecision('99999', [
      { code: '99999', description: 'Nowhere', roadName: '', lat: 0, lon: 0 },
    ]);
    assert.equal(decision.action, 'note');
    assert.equal(decision.message, 'No stop with code 99999.');
  });

  it('trims whitespace around five digits and still commits', () => {
    assert.deepEqual(origin.commitDecision('  43179 ', RESULTS), {
      action: 'choose',
      code: '43179',
    });
  });
});
