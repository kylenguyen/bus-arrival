// Pure decision logic for the stop page — /stop/:code, the "Flagboard". Same
// bargain as ./origin.js and ./route-logic.js: no DOM, no network, no storage
// access, and no reading the clock. `now` comes in as a parameter, plain data
// goes out; stop.js is the glue that owns the side effects. The split exists
// to be testable — src/stop-logic.test.ts imports this module the same
// computed-specifier way the other pure-module tests do — so do not inline any
// of it back into the glue.
//
// Distance for the flag plate's chip is `haversineM` from ./route-logic.js,
// reused rather than copied here: two haversine variants disagreeing about the
// same pair of coordinates would be an invisible bug, so the client keeps one.

/** 5-digit stop codes, as everywhere else in the app. */
const CODE_RE = /^\d{5}$/;

/**
 * DataMall HHMM: hours 00–23, minutes 00–59. The empty string — DataMall's
 * `-`, normalised by the server — fails this on purpose: "no data" must never
 * format as a time.
 */
const HHMM_RE = /^([01]\d|2[0-3])([0-5]\d)$/;

/**
 * The past-midnight convention, shared with the server's per-stop merge: a
 * last bus timed before 04:00 belongs to the previous day-type's span, not to
 * the calendar day printed on it. 04:00 is safely after the last NightRider
 * and safely before the first morning bus.
 */
const PAST_MIDNIGHT_MIN = 4 * 60;

/**
 * Whitespace runs collapsed to one space and trimmed; `''` for a non-string.
 * A copy of origin.js's private helper — three lines are cheaper than
 * exporting a utility whose whole value is being boring.
 *
 * @param {unknown} value
 * @returns {string}
 */
function collapseSpace(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

// --- the URL ----------------------------------------------------------------

/**
 * The stop code out of a /stop/:code pathname, or null for anything else. The
 * same lenient-shell / strict-client split as `parseServicePath` in
 * ./route-logic.js: the server serves the shell for any one-segment param, and
 * this is the strict half — a code this function rejects is one the API would
 * 400 anyway, so rejecting it here saves the round trip and earns the in-page
 * guard instead of a fetch.
 *
 * @param {unknown} pathname
 * @returns {string | null}
 */
export function parseStopPath(pathname) {
  const match = /^\/stop\/([^/]+)\/?$/.exec(typeof pathname === 'string' ? pathname : '');
  if (!match) return null;
  let raw = match[1];
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return CODE_RE.test(raw) ? raw : null;
}

// --- the schedule's calendar -------------------------------------------------

/**
 * Which schedule column a date falls under, in the en-SG week the timetable is
 * published for: Saturday, Sunday, or everything else as a weekday. Singapore
 * public holidays run Sunday schedules, and this function does not know that —
 * out of scope, accepted imprecision, and the reason the schedule table is a
 * user-switchable control rather than a single silent column. Anything that is
 * not a valid Date reads as a weekday, the commonest answer.
 *
 * @param {Date} date
 * @returns {'wd' | 'sat' | 'sun'}
 */
export function dayTypeFor(date) {
  const day = date instanceof Date ? date.getDay() : NaN;
  if (day === 0) return 'sun';
  if (day === 6) return 'sat';
  return 'wd';
}

// --- display formatting --------------------------------------------------------

/**
 * A DataMall HHMM string as the 24-hour clock the rest of the app speaks:
 * `'0530'` → `'05:30'`. `null` for the empty string, `-`, `2400`, or anything
 * else that is not a real time of day — the caller renders its en dash, and a
 * null here must never become the string `'null'` in a cell.
 *
 * @param {unknown} hhmm
 * @returns {string | null}
 */
export function fmtHHMM(hhmm) {
  const match = HHMM_RE.exec(collapseSpace(hhmm));
  return match ? `${match[1]}:${match[2]}` : null;
}

/**
 * A DataMall frequency string for display: `'06-08'` → `'6–8 min'` (en dash,
 * zero-padding dropped — a timetable range, not a code being matched against
 * a pole). A degenerate range collapses (`'08-08'` → `'8 min'`) and a bare
 * number passes through as one, because DataMall emits both. `null` for
 * anything else, the same bargain as `fmtHHMM`.
 *
 * @param {unknown} freq
 * @returns {string | null}
 */
export function fmtFreq(freq) {
  const raw = collapseSpace(freq);
  const range = /^(\d{1,3})-(\d{1,3})$/.exec(raw);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    return lo === hi ? `${lo} min` : `${lo}–${hi} min`;
  }
  return /^\d{1,3}$/.test(raw) ? `${Number(raw)} min` : null;
}

// --- is it still running? -------------------------------------------------------

/** Minutes since local midnight for an HHMM string, or null. */
function toMinutes(hhmm) {
  const match = HHMM_RE.exec(collapseSpace(hhmm));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Whether a service is inside its operating span at `now` — the honest label
 * on an arrivals row with nothing coming: "ended" and "no buses right now" are
 * different answers and only the schedule can tell them apart.
 *
 * `firstBus`/`lastBus` are the API's per-day-type maps (`{wd, sat, sun}`,
 * HHMM strings, `''` for no data); `dayType` is today's column, which the glue
 * computes once with `dayTypeFor(now)` and passes in so this function and the
 * schedule table can never disagree about what day it is.
 *
 * The one non-obvious rule is the 04:00 convention, shared with the server's
 * per-stop merge: before 04:00, a *previous* day whose last bus was itself
 * before 04:00 is still finishing its span, so the check runs against that
 * span alone — running until the previous day's last bus, ended after it (a
 * 00:30 check against Friday's 0010 last bus says ended, a 00:05 check says
 * running). The previous day's column is derived from `now` itself, so a
 * Monday morning correctly asks about Sunday's schedule. Everything beyond
 * that convention — a first bus before 04:00, holiday schedules — is accepted
 * imprecision. Missing or malformed times answer 'running': with no schedule
 * to cite, the page must not claim a service has ended, and the arrivals
 * fetch speaks for itself.
 *
 * @param {{now: Date, firstBus?: {wd?: string, sat?: string, sun?: string} | null,
 *   lastBus?: {wd?: string, sat?: string, sun?: string} | null,
 *   dayType?: 'wd' | 'sat' | 'sun'}} input
 * @returns {{state: 'running' | 'ended' | 'before-first'}}
 */
export function serviceStatus({ now, firstBus, lastBus, dayType }) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return { state: 'running' };
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const type = dayType === 'sat' || dayType === 'sun' ? dayType : 'wd';

  // Before 04:00, yesterday's past-midnight span owns the answer outright:
  // falling through to today's column would relabel "ended" (Friday's 0010 has
  // gone) as "before-first" (Saturday's 0530 has not come), and the first is
  // the truthful one. Noon anchors the constructed date clear of any DST edge.
  if (nowMin < PAST_MIDNIGHT_MIN) {
    const prevType = dayTypeFor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12));
    const prevLast = toMinutes(lastBus?.[prevType]);
    if (prevLast !== null && prevLast < PAST_MIDNIGHT_MIN) {
      return { state: nowMin <= prevLast ? 'running' : 'ended' };
    }
  }

  const firstMin = toMinutes(firstBus?.[type]);
  const lastMin = toMinutes(lastBus?.[type]);
  if (firstMin === null || lastMin === null) return { state: 'running' };

  if (nowMin < firstMin) return { state: 'before-first' };
  // Today's own last bus past midnight: the span crosses into tomorrow, so
  // today it can only be running — tomorrow's early hours settle "ended".
  if (lastMin < PAST_MIDNIGHT_MIN) return { state: 'running' };
  return { state: nowMin > lastMin ? 'ended' : 'running' };
}

// --- sharing ------------------------------------------------------------------

/**
 * What the share sheet says and where it points:
 * `{title: '54261 · Blk 331, Ang Mo Kio Ave 1', url: origin + '/stop/54261'}`.
 * The title is plain text for `navigator.share`, not markup — server data
 * passes through untouched, and HTML-escaping stays the renderer's job at the
 * `innerHTML` boundary, exactly as everywhere else. Absent fields drop out of
 * the title rather than printing `undefined`; the code is URI-encoded into the
 * URL as a belt-and-braces move, invisible for the five digits it always is.
 *
 * @param {{code?: unknown, description?: unknown, roadName?: unknown} | null | undefined} stop
 * @param {unknown} origin e.g. `location.origin` — no trailing slash expected,
 *   but one is tolerated
 * @returns {{title: string, url: string}}
 */
export function sharePayload(stop, origin) {
  const code = collapseSpace(stop?.code);
  const name = [collapseSpace(stop?.description), collapseSpace(stop?.roadName)]
    .filter(Boolean)
    .join(', ');
  const base = typeof origin === 'string' ? origin.replace(/\/+$/, '') : '';
  return {
    title: name ? `${code} · ${name}` : code,
    url: `${base}/stop/${encodeURIComponent(code)}`,
  };
}
