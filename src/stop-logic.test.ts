import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Unit tests for [public/stop-logic.js](../public/stop-logic.js) — the pure
 * half of the stop page. Plain input/output assertions: no timers, no network,
 * no DOM.
 *
 * The specifier below is computed on purpose; leave it that way. It is the
 * same bargain [origin.test.ts](./origin.test.ts) and
 * [route-logic.test.ts](./route-logic.test.ts) document: a literal
 * `'../public/stop-logic.js'` trips TS2307 and TS6059 under `rootDir: "src"`,
 * while a URL built at runtime is never resolved by tsc, types as `any`, and
 * compiles clean under `strict`.
 */
const stopUrl = new URL('../public/stop-logic.js', import.meta.url);
const stop = await import(stopUrl.href);

// August 2026, the fixture week: Mon 10 … Fri 14, Sat 15, Sun 16. Every date
// is built from components, so the tests are local-time and timezone-proof.
const AUG = 7;
const at = (day: number, hh: number, mm: number): Date => new Date(2026, AUG, day, hh, mm);

/** serviceStatus with the contract's example service unless overridden. */
const status = (over: object): any =>
  stop.serviceStatus({
    now: at(11, 12, 0), // Tuesday noon
    firstBus: { wd: '0530', sat: '0530', sun: '0545' },
    lastBus: { wd: '2330', sat: '2330', sun: '2315' },
    dayType: 'wd',
    ...over,
  });

/**
 * The purity tripwire, mirrored from route-logic.test.ts: the plan states the
 * module holds no DOM, storage, network or clock access, and nothing else
 * enforces it. Comments are stripped first.
 */
describe('stop-logic.js module contract', () => {
  it('has no DOM, storage, network or clock access', () => {
    const source = readFileSync(stopUrl, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (const forbidden of ['Date.now', 'document', 'localStorage', 'fetch(']) {
      assert.equal(source.includes(forbidden), false, `stop-logic.js must not use ${forbidden}`);
    }
  });

  // The plan's "reuse if present" rule: the client-side haversine lives in
  // route-logic.js, so this module must not grow a second one.
  it('does not duplicate the client haversine', () => {
    assert.equal(stop.distanceMeters, undefined);
    assert.equal(stop.haversineM, undefined);
  });
});

describe('parseStopPath', () => {
  it('accepts a 5-digit code', () => {
    assert.equal(stop.parseStopPath('/stop/54261'), '54261');
  });

  it('accepts a trailing slash', () => {
    assert.equal(stop.parseStopPath('/stop/54261/'), '54261');
  });

  it('decodes URL-encoding before validating', () => {
    assert.equal(stop.parseStopPath('/stop/%35%34261'), '54261');
  });

  it('rejects a non-numeric code', () => {
    assert.equal(stop.parseStopPath('/stop/abc'), null);
  });

  it('rejects a 6-digit code', () => {
    assert.equal(stop.parseStopPath('/stop/123456'), null);
  });

  it('rejects a 4-digit code', () => {
    assert.equal(stop.parseStopPath('/stop/5426'), null);
  });

  it('rejects an encoded non-digit even when it decodes to five characters', () => {
    assert.equal(stop.parseStopPath('/stop/542%2061'), null);
  });

  it('rejects malformed percent-encoding rather than throwing', () => {
    assert.equal(stop.parseStopPath('/stop/54%ZZ1'), null);
  });

  it('rejects other paths, empty params and non-strings', () => {
    assert.equal(stop.parseStopPath('/bus/54261'), null);
    assert.equal(stop.parseStopPath('/stop/'), null);
    assert.equal(stop.parseStopPath('/stop/54261/x'), null);
    assert.equal(stop.parseStopPath('/stop/54261//'), null);
    assert.equal(stop.parseStopPath(undefined), null);
    assert.equal(stop.parseStopPath(42), null);
  });
});

describe('dayTypeFor', () => {
  it('classifies every day of an en-SG week', () => {
    const expected: Array<[number, string]> = [
      [10, 'wd'], // Mon
      [11, 'wd'], // Tue
      [12, 'wd'], // Wed
      [13, 'wd'], // Thu
      [14, 'wd'], // Fri
      [15, 'sat'],
      [16, 'sun'],
    ];
    for (const [day, type] of expected) {
      assert.equal(stop.dayTypeFor(at(day, 12, 0)), type, `2026-08-${day}`);
    }
  });

  it('reads an invalid or missing date as a weekday', () => {
    assert.equal(stop.dayTypeFor(new Date('nonsense')), 'wd');
    assert.equal(stop.dayTypeFor(null), 'wd');
  });
});

describe('fmtHHMM', () => {
  it('formats a DataMall HHMM string', () => {
    assert.equal(stop.fmtHHMM('0530'), '05:30');
    assert.equal(stop.fmtHHMM('0000'), '00:00');
    assert.equal(stop.fmtHHMM('2359'), '23:59');
  });

  it('returns null for empty — the server\'s "no data"', () => {
    assert.equal(stop.fmtHHMM(''), null);
  });

  it('returns null for anything that is not a time of day', () => {
    assert.equal(stop.fmtHHMM('2400'), null);
    assert.equal(stop.fmtHHMM('0560'), null);
    assert.equal(stop.fmtHHMM('530'), null);
    assert.equal(stop.fmtHHMM('05:30'), null);
    assert.equal(stop.fmtHHMM('-'), null);
    assert.equal(stop.fmtHHMM(null), null);
    assert.equal(stop.fmtHHMM(530), null);
  });
});

describe('fmtFreq', () => {
  it('formats a range with an en dash and no zero-padding', () => {
    assert.equal(stop.fmtFreq('06-08'), '6–8 min');
    assert.equal(stop.fmtFreq('10-15'), '10–15 min');
  });

  it('collapses a degenerate range and passes a bare number through', () => {
    assert.equal(stop.fmtFreq('08-08'), '8 min');
    assert.equal(stop.fmtFreq('12'), '12 min');
  });

  it('returns null for null, empty and junk', () => {
    assert.equal(stop.fmtFreq(null), null);
    assert.equal(stop.fmtFreq(''), null);
    assert.equal(stop.fmtFreq('-'), null);
    assert.equal(stop.fmtFreq('6-8min'), null);
    assert.equal(stop.fmtFreq(8), null);
  });
});

describe('serviceStatus', () => {
  it('runs through the middle of the span', () => {
    assert.deepEqual(status({}), { state: 'running' });
  });

  it('is before-first until the first bus, running from it', () => {
    assert.deepEqual(status({ now: at(11, 5, 29) }), { state: 'before-first' });
    assert.deepEqual(status({ now: at(11, 5, 30) }), { state: 'running' });
  });

  it('runs at the last bus and ends only after it', () => {
    assert.deepEqual(status({ now: at(11, 23, 30) }), { state: 'running' });
    assert.deepEqual(status({ now: at(11, 23, 31) }), { state: 'ended' });
  });

  it('respects the day-type column it is given', () => {
    // Sunday 05:40 — before Sunday's 0545 first bus, after the weekday 0530.
    assert.deepEqual(status({ now: at(16, 5, 40), dayType: 'sun' }), { state: 'before-first' });
    assert.deepEqual(status({ now: at(16, 5, 45), dayType: 'sun' }), { state: 'running' });
  });

  // The 04:00 convention, as the plan pins it: Friday's 0010 last bus is
  // Friday's span finishing on Saturday's clock. A 00:05 check is running, a
  // 00:10 check is still running, and 00:30 is ended — never "before-first",
  // even though Saturday's own first bus has not come either.
  it('checks a past-midnight window against the previous day-type span', () => {
    const lastBus = { wd: '0010', sat: '0010', sun: '2315' };
    assert.deepEqual(status({ now: at(15, 0, 5), dayType: 'sat', lastBus }), { state: 'running' });
    assert.deepEqual(status({ now: at(15, 0, 10), dayType: 'sat', lastBus }), { state: 'running' });
    assert.deepEqual(status({ now: at(15, 0, 30), dayType: 'sat', lastBus }), { state: 'ended' });
  });

  it('derives the previous day-type from now — Monday 00:30 asks about Sunday', () => {
    const lastBus = { wd: '2330', sat: '2330', sun: '0015' };
    assert.deepEqual(status({ now: at(17, 0, 10), dayType: 'wd', lastBus }), { state: 'running' });
    assert.deepEqual(status({ now: at(17, 0, 30), dayType: 'wd', lastBus }), { state: 'ended' });
  });

  it('falls to today\'s span before 04:00 when yesterday ended before midnight', () => {
    // Saturday 00:30, Friday's last bus was 2330: that span is over, so the
    // honest answer is Saturday's — before its 0530 first bus.
    assert.deepEqual(status({ now: at(15, 0, 30), dayType: 'sat' }), { state: 'before-first' });
  });

  it("never ends a span that crosses midnight on its own day", () => {
    // Friday 23:50, weekday last bus 0010 next morning: still running.
    const lastBus = { wd: '0010', sat: '0010', sun: '2315' };
    assert.deepEqual(status({ now: at(14, 23, 50), dayType: 'wd', lastBus }), { state: 'running' });
  });

  it('answers running when the schedule has no usable times', () => {
    // '' is the server's "no data" — with nothing to cite, the page must not
    // claim a service has ended; the arrivals fetch speaks for itself.
    assert.deepEqual(status({ firstBus: { wd: '', sat: '', sun: '' } }), { state: 'running' });
    assert.deepEqual(status({ lastBus: null }), { state: 'running' });
    assert.deepEqual(status({ now: 1_760_000_000_000 }), { state: 'running' });
    assert.deepEqual(status({ now: new Date('nonsense') }), { state: 'running' });
  });
});

describe('sharePayload', () => {
  const STOP = { code: '54261', description: 'Blk 331', roadName: 'Ang Mo Kio Ave 1' };

  it('builds the plan\'s exact title and URL', () => {
    assert.deepEqual(stop.sharePayload(STOP, 'https://ezbus.sg'), {
      title: '54261 · Blk 331, Ang Mo Kio Ave 1',
      url: 'https://ezbus.sg/stop/54261',
    });
  });

  it('drops absent fields from the title instead of printing undefined', () => {
    assert.equal(stop.sharePayload({ code: '54261', description: 'Blk 331' }, 'x').title, '54261 · Blk 331');
    assert.equal(stop.sharePayload({ code: '54261' }, 'x').title, '54261');
  });

  it('tolerates a trailing slash on the origin', () => {
    assert.equal(stop.sharePayload(STOP, 'https://ezbus.sg/').url, 'https://ezbus.sg/stop/54261');
  });

  it('keeps the title plain text — escaping is the renderer\'s job at the innerHTML boundary', () => {
    const payload = stop.sharePayload({ code: '54261', description: '<b>Blk & 331</b>' }, 'x');
    assert.equal(payload.title, '54261 · <b>Blk & 331</b>');
  });

  it('URI-encodes the code into the URL', () => {
    assert.equal(stop.sharePayload({ code: 'a b' }, '').url, '/stop/a%20b');
  });
});
