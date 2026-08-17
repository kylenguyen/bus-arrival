// Pure decision logic for the route page — /bus/:service, the "Approach
// Window". Same bargain as ./origin.js, which this imports from: no DOM, no
// network, no storage access, and no reading the clock. Raw storage strings
// come in as parameters, `now` comes in as a parameter, and plain data goes
// out; route.js is the glue that owns the side effects. The split exists to be
// testable — src/route-logic.test.ts imports this module the same
// computed-specifier way src/origin.test.ts imports origin.js — so do not
// inline any of it back into the glue.

import { isUsableCoord, originCoord, readOriginRecord } from './origin.js';

// --- contract constants ---------------------------------------------------

/**
 * How far the nearest on-route stop may be before auto-anchoring stops being a
 * convenience and becomes a claim: past 2 km "nearest stop on this route to
 * you" is not a stop anyone is walking to, so the page asks instead of
 * assuming. The same bound caps a direction-toggle translation — a "return
 * stop" 2 km from where the user boards is not the return stop.
 */
export const GUARD_DISTANCE_M = 2000;

/**
 * Upstream stops that carry a live ETA — the approach window. Four, so the
 * arrivals batch stays at ≤ 5 codes with the anchor included: one call per
 * 30 s on the existing /api/arrivals route, no new quota pressure.
 */
export const UPSTREAM_WINDOW = 4;

/** Downstream stops kept visible after the anchor — context, never fetched. */
export const DOWNSTREAM_SHOWN = 2;

/**
 * A fold hiding fewer stops than this never renders: "⋯ 2 stops" costs the
 * same tap and the same row as just showing the two stops it hides.
 */
export const FOLD_MIN = 3;

/**
 * Remembered anchors kept, least-recently-used out first. Thirty is more
 * routes than anyone rides; past that the record is a log, not a memory.
 */
export const ANCHOR_LRU_MAX = 30;

/**
 * The honesty label under the bus mark. The mark is inferred from the timings
 * each stop reports (`inferBusSegment`), not from telemetry, so the page must
 * say so — a refresh that re-reads the timings can legitimately move the mark
 * backwards, and an unlabelled mark doing that reads as a broken app rather
 * than an honest estimate.
 */
export const BUS_POSITION_LABEL =
  'Bus position is read from timings at each stop, not GPS — it can jump.';

/** The service-number rule the server enforces on /api/route/:service. */
const SERVICE_RE = /^[A-Za-z0-9]{1,5}$/;

/** 5-digit stop codes, as everywhere else in the app. */
const CODE_RE = /^\d{5}$/;

// --- small shared helpers ---------------------------------------------------

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

/**
 * Service numbers normalised for use as a record key: `972m` and `972M` are
 * the same service, and the anchors record must not hold both.
 *
 * @param {unknown} serviceNo
 * @returns {string | null}
 */
function normaliseService(serviceNo) {
  const svc = typeof serviceNo === 'string' ? serviceNo.trim().toUpperCase() : '';
  return SERVICE_RE.test(svc) ? svc : null;
}

/**
 * The last-fix record parsed exactly as origin.js's private `parseLastFix`
 * reads it. Duplicated rather than imported because it is private there on
 * purpose — and the duplication is the contract: "does this user hold a fix?"
 * must answer identically to the key's own reader, not to a stricter reading.
 *
 * @param {string | null | undefined} raw
 */
function parseFix(raw) {
  try {
    const loc = JSON.parse(raw ?? 'null');
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return null;
    return loc;
  } catch {
    return null;
  }
}

// --- the URL ----------------------------------------------------------------

/**
 * The service number out of a /bus/:service pathname, or null for anything
 * else. Uppercased on the way out so every consumer — the API call, the
 * anchors record, the page title — sees the one spelling of `972M` whatever
 * the link carried. The rule mirrors the server's param validation: a name
 * this function rejects is one the API would 400 anyway, so rejecting it here
 * saves the round trip.
 *
 * @param {unknown} pathname
 * @returns {string | null}
 */
export function parseServicePath(pathname) {
  const match = /^\/bus\/([^/]+)\/?$/.exec(typeof pathname === 'string' ? pathname : '');
  if (!match) return null;
  let raw = match[1];
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return SERVICE_RE.test(raw) ? raw.toUpperCase() : null;
}

// --- distance ----------------------------------------------------------------

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in metres. A copy of the server's (module-private in
 * src/stops.ts) because no client copy exists and the guard threshold has to
 * be measured with the same yardstick the board's rankings use — two haversine
 * variants disagreeing at the 2 km boundary would be an invisible bug.
 *
 * @param {number} aLat
 * @param {number} aLon
 * @param {number} bLat
 * @param {number} bLon
 * @returns {number}
 */
export function haversineM(aLat, aLon, bLat, bLon) {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// --- remembered anchors -------------------------------------------------------

/**
 * The `bus-route.anchor.v1` record read back as a Map, service → stop code.
 * Corrupt input reads as absent — the same bargain `readOriginRecord` makes: a
 * broken key must cost a convenience, never the page. A single bad entry drops
 * itself rather than the whole record, because the other 29 anchors are still
 * one visit away from being useful.
 *
 * Map insertion order is the LRU order, oldest first. One honest caveat,
 * inherited from the contract's `{svc: code}` shape: JSON objects put
 * integer-like keys ("61", "196") in numeric order regardless of how they were
 * written, so recency is exact within a session and approximate across a
 * reload. It only matters at eviction — the 31st service a user anchors — and
 * mis-evicting one anchor costs one chip on one revisit.
 *
 * @param {string | null | undefined} raw
 * @returns {Map<string, string>}
 */
export function readAnchors(raw) {
  try {
    const parsed = JSON.parse(raw ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    const anchors = new Map();
    for (const [svc, code] of Object.entries(parsed)) {
      const key = normaliseService(svc);
      if (!key || typeof code !== 'string' || !CODE_RE.test(code)) continue;
      anchors.set(key, code);
    }
    // Trim from the front — with more than the cap stored, the front is the
    // least recent and the overflow is whatever an older, larger cap left.
    while (anchors.size > ANCHOR_LRU_MAX) {
      anchors.delete(anchors.keys().next().value);
    }
    return anchors;
  } catch {
    return new Map();
  }
}

/**
 * The anchors map with `serviceNo → code` moved to the most-recent end,
 * evicting the least recent past the cap.
 *
 * Always a new Map — the same reasoning as origin.js's `rememberRecent`: the
 * caller holds the old one and writes the returned one to storage, so mutating
 * in place would make a failed write invisible. An invalid service or code
 * returns a copy unchanged rather than throwing, because a bad argument is a
 * caller bug and losing the user's 30 anchors over it would punish the wrong
 * party.
 *
 * @param {Map<string, string> | null | undefined} map
 * @param {unknown} serviceNo
 * @param {unknown} code
 * @returns {Map<string, string>}
 */
export function rememberAnchor(map, serviceNo, code) {
  const next = new Map(map instanceof Map ? map : []);
  const key = normaliseService(serviceNo);
  if (!key || typeof code !== 'string' || !CODE_RE.test(code)) return next;
  // Delete-then-set is the move-to-end: Map keeps first-insertion order, so a
  // plain set() would leave a re-anchored service looking least recent.
  next.delete(key);
  next.set(key, code);
  while (next.size > ANCHOR_LRU_MAX) next.delete(next.keys().next().value);
  return next;
}

// --- the anchor ladder ---------------------------------------------------------

/** First stop carrying this code across the route's directions, or null. */
function stopByCode(directions, code) {
  for (const dir of Array.isArray(directions) ? directions : []) {
    for (const stop of Array.isArray(dir?.stops) ? dir.stops : []) {
      if (stop?.code === code) return stop;
    }
  }
  return null;
}

/** Nearest usable-coordinate stop to a point, with its distance, or null. */
function nearestStop(stops, lat, lon) {
  let best = null;
  let bestD = Infinity;
  for (const stop of stops) {
    if (!stop || !isUsableCoord(stop.lat, stop.lon)) continue;
    const d = haversineM(lat, lon, stop.lat, stop.lon);
    if (d < bestD) {
      bestD = d;
      best = stop;
    }
  }
  return best ? { stop: best, distanceM: bestD } : null;
}

/**
 * The whole anchor ladder, decided in one place so route.js applies it as
 * assignments with no rung logic left in the glue.
 *
 * The order is the content: (1) a `?stop=` on the URL is the most explicit
 * statement of intent there is — a tapped board card or a shared link — so it
 * wins outright when it is on the route; (2) the remembered anchor is a choice
 * the user made on this route before, and explicit beats inferred, which is
 * also why a remembered stop is **never** distance-checked — being far from a
 * stop you deliberately chose is not staleness; (3) only with no stated choice
 * does the saved origin get to infer one, and past `GUARD_DISTANCE_M` even
 * that becomes a question (`state: 'guard'`) rather than an answer; (4) with
 * nothing at all, the picker, and zero arrivals until anchored.
 *
 * Stale rungs fall through rather than dead-ending: a `?stop=` or a remembered
 * code that is no longer on the route earns a notice the page can show and the
 * ladder continues, because the user's question — "where does this bus stop
 * for me?" — still deserves the next-best answer. A stale remembered code also
 * sets `dropRemembered`, telling the glue to delete the key: leaving it would
 * re-raise the same notice on every visit. A malformed `queryStop` (not five
 * digits) is skipped *silently* — it was never a stop this app wrote into a
 * URL, and naming mangled-link junk in a chip helps nobody.
 *
 * `serviceNo` is an addition to the planned signature, not scope creep: the
 * anchors record is keyed by service, so without it rung 2 cannot look
 * anything up.
 *
 * @param {{serviceNo?: unknown, queryStop?: unknown,
 *   anchorsRaw?: string | null, originRaw?: string | null,
 *   locRaw?: string | null, directions?: Array<object> | null}} input
 * @returns {{state: 'anchored', source: 'query' | 'remembered' | 'nearest',
 *     code: string, stop: object, direction: number | null, distanceM?: number,
 *     notices: Array<{reason: string, code: string, message: string}>,
 *     dropRemembered: boolean}
 *   | {state: 'guard', suggestion: {code: string, stop: object, distanceM: number},
 *     notices: Array<object>, dropRemembered: boolean}
 *   | {state: 'picker', notices: Array<object>, dropRemembered: boolean}}
 */
export function resolveAnchor({ serviceNo, queryStop, anchorsRaw, originRaw, locRaw, directions }) {
  const dirs = Array.isArray(directions) ? directions : [];
  const svc = normaliseService(serviceNo);
  const notices = [];
  let dropRemembered = false;

  const anchored = (source, stop, extra) => ({
    state: 'anchored',
    source,
    code: stop.code,
    stop,
    direction: directionFor(dirs, stop.code)?.direction ?? null,
    notices,
    dropRemembered,
    ...extra,
  });

  // Rung 1 — ?stop= on the URL. The notice names the service, not "any more":
  // a fresh link's stop was never this user's stop on this route, so there is
  // no history to have gone stale — "any more" belongs to rung 2 alone.
  const query = collapseSpace(queryStop);
  if (CODE_RE.test(query)) {
    const stop = stopByCode(dirs, query);
    if (stop) return anchored('query', stop);
    notices.push({
      reason: 'stale-query',
      code: query,
      message: svc
        ? `Stop ${query} isn't on route ${svc}.`
        : `Stop ${query} isn't on this route.`,
    });
  }

  // Rung 2 — the remembered anchor for this service.
  const remembered = readAnchors(anchorsRaw).get(svc ?? '');
  if (remembered) {
    const stop = stopByCode(dirs, remembered);
    if (stop) return anchored('remembered', stop);
    dropRemembered = true;
    notices.push({
      reason: 'stale-remembered',
      code: remembered,
      message: `Your usual stop (${remembered}) isn't on this route any more.`,
    });
  }

  // Rung 3 — infer from the board's saved origin, both doors: a place record
  // carries its own coordinate, gps mode reads the last fix, and originCoord
  // is the one arbiter of which — the same function the board ranks by, so the
  // route page can never anchor from a different door than the board shows.
  const coord = originCoord(readOriginRecord(originRaw), parseFix(locRaw));
  if (coord && isUsableCoord(coord.lat, coord.lon)) {
    const all = [];
    for (const dir of dirs) for (const stop of Array.isArray(dir?.stops) ? dir.stops : []) all.push(stop);
    const nearest = nearestStop(all, coord.lat, coord.lon);
    if (nearest) {
      const distanceM = Math.round(nearest.distanceM);
      // The comparison uses the unrounded distance: the guard is a rule about
      // the world, not about the label, and rounding first would let 2000.4 m
      // anchor as "2000".
      if (nearest.distanceM <= GUARD_DISTANCE_M) {
        return anchored('nearest', nearest.stop, { distanceM });
      }
      return {
        state: 'guard',
        suggestion: { code: nearest.stop.code, stop: nearest.stop, distanceM },
        notices,
        dropRemembered,
      };
    }
  }

  // Rung 4 — nothing to go on: the picker, and no arrivals until anchored.
  return { state: 'picker', notices, dropRemembered };
}

/**
 * The direction entry a stop code belongs to, or null. First match wins: a
 * code appearing in both directions (a loop's far end, a shared interchange
 * berth) is the same physical stop, and direction 1 is the one the page opens
 * on anyway.
 *
 * @param {Array<object> | null | undefined} directions
 * @param {unknown} code
 * @returns {object | null}
 */
export function directionFor(directions, code) {
  for (const dir of Array.isArray(directions) ? directions : []) {
    for (const stop of Array.isArray(dir?.stops) ? dir.stops : []) {
      if (stop?.code === code) return dir;
    }
  }
  return null;
}

/**
 * The direction toggle's auto-translate: the stop in the target direction
 * nearest to the anchor's own coordinate — the pole across the road, found by
 * geometry because route data carries no "opposite stop" link. Null when the
 * target direction has no candidate within `GUARD_DISTANCE_M`: past that the
 * translation would be a guess, and the caller shows the picker with a notice
 * instead. The result is the caller's to *display*, never to persist — the
 * remembered anchor stays the stop the user actually chose, so toggling back
 * restores it.
 *
 * @param {Array<object> | null | undefined} directions
 * @param {{lat?: unknown, lon?: unknown} | null | undefined} anchorStop
 * @param {unknown} targetDirection
 * @returns {{stop: object, distanceM: number} | null}
 */
export function translateAnchor(directions, anchorStop, targetDirection) {
  if (!anchorStop || !isUsableCoord(anchorStop.lat, anchorStop.lon)) return null;
  const dir = (Array.isArray(directions) ? directions : []).find(
    (entry) => entry?.direction === targetDirection,
  );
  if (!dir) return null;

  const nearest = nearestStop(
    Array.isArray(dir.stops) ? dir.stops : [],
    anchorStop.lat,
    anchorStop.lon,
  );
  if (!nearest || nearest.distanceM > GUARD_DISTANCE_M) return null;
  return { stop: nearest.stop, distanceM: Math.round(nearest.distanceM) };
}

// --- the picker's search ---------------------------------------------------------

/**
 * Below this, no search: one character matches half the spine, and a list that
 * is nearly the full route is noise wearing a result's clothes. Two mirrors
 * the board finder's threshold, so the two search boxes feel like one rule.
 */
const SEARCH_MIN = 2;

/**
 * Case-insensitive substring search over description, code and road name.
 *
 * `null` for an empty or too-short query — deliberately distinct from `[]`,
 * which means "searched and nothing matched": the first keeps the full spine
 * on screen, the second earns the no-match copy that mentions the other
 * direction. Every matching field is reported with its `[start, end)` range so
 * the glue can wrap exactly the matched characters in the accent tint without
 * re-running the match against different casing rules.
 *
 * @param {Array<{description?: string, code?: string, roadName?: string}> | null | undefined} stops
 * @param {unknown} query
 * @returns {Array<{stop: object, matches: Array<{field: 'description' | 'code' | 'roadName',
 *   start: number, end: number}>}> | null}
 */
export function searchStops(stops, query) {
  const needle = collapseSpace(query).toLowerCase();
  if (needle.length < SEARCH_MIN) return null;

  const results = [];
  for (const stop of Array.isArray(stops) ? stops : []) {
    if (!stop) continue;
    const matches = [];
    for (const field of ['description', 'code', 'roadName']) {
      const value = typeof stop[field] === 'string' ? stop[field] : '';
      const at = value.toLowerCase().indexOf(needle);
      if (at >= 0) matches.push({ field, start: at, end: at + needle.length });
    }
    if (matches.length > 0) results.push({ stop, matches });
  }
  return results;
}

// --- the approach window ------------------------------------------------------------

/**
 * The anchored view's window: which stops carry a live ETA, and which rows the
 * fold plan must keep. Upstream codes come back in route order — furthest
 * first — which is the order the spine draws and the order `inferBusSegment`
 * expects its ETAs in, so no caller ever re-sorts.
 *
 * `keepIndices` is the anchored fold rule stated as data: origin terminus,
 * the ≤ 4 upstream, the anchor, ≤ 2 downstream, destination terminus. Feed it
 * to `foldPlan` unchanged.
 *
 * @param {Array<{code: string}> | null | undefined} stops one direction's stops, in order
 * @param {unknown} anchorIdx index of the anchor within `stops`
 * @returns {{anchorCode: string, upstreamCodes: string[], keepIndices: number[]} | null}
 */
export function windowFor(stops, anchorIdx) {
  const list = Array.isArray(stops) ? stops : [];
  if (!Number.isInteger(anchorIdx) || anchorIdx < 0 || anchorIdx >= list.length) return null;

  const from = Math.max(0, anchorIdx - UPSTREAM_WINDOW);
  const last = list.length - 1;

  const keep = new Set([0, last]);
  for (let i = from; i <= Math.min(last, anchorIdx + DOWNSTREAM_SHOWN); i += 1) keep.add(i);

  return {
    anchorCode: list[anchorIdx].code,
    upstreamCodes: list.slice(from, anchorIdx).map((stop) => stop.code),
    keepIndices: [...keep].sort((a, b) => a - b),
  };
}

/**
 * The /api/arrivals query string — the `boardParams` idiom: with no codes the
 * param is omitted rather than sent empty, because `stops=` is a request for
 * stop `''` and only absence reads as "nothing to ask". One place composes it
 * so no call site can invent its own separator.
 *
 * @param {Array<string> | null | undefined} codes anchor first or last, caller's choice —
 *   the server answers per code either way
 * @returns {string}
 */
export function arrivalsParams(codes) {
  const params = new URLSearchParams();
  const list = (Array.isArray(codes) ? codes : []).filter(
    (code) => typeof code === 'string' && code.length > 0,
  );
  if (list.length > 0) params.set('stops', list.join(','));
  return String(params);
}

// --- folding --------------------------------------------------------------------------

/**
 * The spine's row plan: kept stops as `{kind: 'stop', index}` rows, runs of
 * hidden stops as `{kind: 'fold', count, startIndex}` rows. Expansion is a
 * splice by construction — a fold row names the exact indices it hides
 * (`startIndex` for `count`), so the glue re-plans with those indices added to
 * `keepIndices` and nothing else on the page moves.
 *
 * Both termini are always kept whatever `keepIndices` says: a route with no
 * visible start or end is not a route, it is a list. A run shorter than
 * `FOLD_MIN` renders as its stops instead of a fold — which is also the whole
 * "short routes stay unfolded" rule, falling out of the arithmetic rather than
 * needing a length check.
 *
 * @param {Array<object> | null | undefined} stops one direction's stops, in order
 * @param {Array<number> | null | undefined} keepIndices indices that must render as rows
 * @returns {Array<{kind: 'stop', index: number} | {kind: 'fold', count: number, startIndex: number}>}
 */
export function foldPlan(stops, keepIndices) {
  const len = Array.isArray(stops) ? stops.length : 0;
  if (len === 0) return [];

  const keep = new Set([0, len - 1]);
  for (const index of Array.isArray(keepIndices) ? keepIndices : []) {
    if (Number.isInteger(index) && index >= 0 && index < len) keep.add(index);
  }

  const rows = [];
  let prev = -1;
  for (const index of [...keep].sort((a, b) => a - b)) {
    const hidden = index - prev - 1;
    if (hidden >= FOLD_MIN) {
      rows.push({ kind: 'fold', count: hidden, startIndex: prev + 1 });
    } else {
      for (let i = prev + 1; i < index; i += 1) rows.push({ kind: 'stop', index: i });
    }
    rows.push({ kind: 'stop', index });
    prev = index;
  }
  return rows;
}

// --- arrivals -----------------------------------------------------------------------------

/**
 * One service's buses out of an /api/arrivals entry. The two absences stay
 * distinguishable, exactly as `BoardStop.services` documents them: `null`
 * means the stop's fetch failed and the row should say so, `[]` means the
 * fetch worked and this service has nothing running — outside operating
 * hours, or a service that skips this stop today. Collapsing them would make
 * a DataMall outage read as "no buses tonight".
 *
 * @param {{code?: string, services?: Array<{serviceNo?: string, buses?: Array<object>}> | null}
 *   | null | undefined} entry one element of the response's `arrivals` array
 * @param {unknown} serviceNo
 * @returns {Array<object> | null}
 */
export function filterServiceEta(entry, serviceNo) {
  if (!entry || !Array.isArray(entry.services)) return null;
  const want = normaliseService(serviceNo);
  if (!want) return [];
  const service = entry.services.find(
    (svc) => typeof svc?.serviceNo === 'string' && svc.serviceNo.toUpperCase() === want,
  );
  if (!service) return [];
  return Array.isArray(service.buses) ? service.buses : [];
}

/**
 * Rises smaller than this are noise, not a bus: adjacent stops can report the
 * same vehicle a few seconds apart in opposite directions, and DataMall
 * refreshes per stop rather than atomically. Anything past 90 s is a genuinely
 * different bus.
 */
const JUMP_TOLERANCE_MS = 90_000;

/**
 * Where the lead bus sits in the approach window, or null.
 *
 * `windowEtas` is each window stop's lead timing (`buses[0]` after
 * `filterServiceEta`), in route order: furthest upstream first, the anchor
 * last. The physics being read: a bus reaches upstream stops first, so the
 * stops it has *not yet* passed report the same vehicle with ETAs that
 * shrink walking upstream from the anchor — until, at the stops it has
 * already passed, the "lead" bus is suddenly the *next* vehicle and the ETA
 * jumps up. That single jump is the bus's position: it sits between the two
 * stops the jump straddles, and the returned index `i` means "between
 * `windowEtas[i]` and `windowEtas[i + 1]`".
 *
 * Everything ambiguous is null rather than a guess, because the mark claims a
 * physical position and `BUS_POSITION_LABEL` only excuses jumpiness, not
 * fiction: no jump means the lead bus has not entered the window; two or more
 * jumps means two buses or noisy data and no way to tell which; any missing,
 * unparseable or unmonitored timing means part of the picture is a timetable
 * rather than a tracked vehicle; and a timing more than the tolerance in the
 * past means the data has gone stale under us. Rises within
 * `JUMP_TOLERANCE_MS` are tolerated inside a run and never counted as jumps.
 *
 * @param {Array<{estimatedArrival?: string | null, monitored?: boolean} | null | undefined>
 *   | null | undefined} windowEtas
 * @param {number} now epoch milliseconds — a parameter, never a clock read
 * @returns {number | null}
 */
export function inferBusSegment(windowEtas, now) {
  const list = Array.isArray(windowEtas) ? windowEtas : [];
  if (list.length < 2) return null;

  const times = [];
  for (const lead of list) {
    if (!lead || lead.monitored !== true || !lead.estimatedArrival) return null;
    const ts = new Date(lead.estimatedArrival).getTime();
    if (!Number.isFinite(ts)) return null;
    if (ts - now < -JUMP_TOLERANCE_MS) return null;
    times.push(ts);
  }

  // Walk upstream from the anchor (the array's end), counting rises past the
  // tolerance. Exactly one is a position; any other count is an admission.
  let jumpAt = -1;
  for (let k = times.length - 1; k >= 1; k -= 1) {
    if (times[k - 1] - times[k] > JUMP_TOLERANCE_MS) {
      if (jumpAt !== -1) return null;
      jumpAt = k;
    }
  }
  return jumpAt === -1 ? null : jumpAt - 1;
}

/**
 * One lead timing's epoch milliseconds, or null if it cannot support a claim
 * about a physical vehicle: absent, unparseable, a timetable estimate
 * (`monitored !== true`), or more than the tolerance in the past and so stale.
 *
 * These are the same four gates `inferBusSegment` spells out inline. It keeps
 * its own copy on purpose — it is the load-bearing function here and stays
 * byte-identical — so this one exists to stop the *ladder* growing a third and
 * fourth spelling: `busMarkPlacement` asks it about the anchor and about every
 * window lead, and the tests below pin the two readings against each other.
 *
 * @param {{estimatedArrival?: string | null, monitored?: boolean} | null | undefined} lead
 * @param {number} now epoch milliseconds — a parameter, never a clock read
 * @returns {number | null}
 */
function leadTimestamp(lead, now) {
  if (!lead || lead.monitored !== true || !lead.estimatedArrival) return null;
  const ts = new Date(lead.estimatedArrival).getTime();
  if (!Number.isFinite(ts)) return null;
  if (ts - now < -JUMP_TOLERANCE_MS) return null;
  return ts;
}

/**
 * Where the route page draws its bus mark, as data — the ladder decided here
 * rather than in the glue, so the one hard question (what the mark is allowed
 * to claim) is testable without a DOM.
 *
 * `leads` is the window's lead buses in route order, furthest upstream first,
 * anchor **last** — the array `renderWindow` already builds. Rungs are tried
 * top-down and the first match wins:
 *
 * 1. Nothing to read (not an array, or empty) — no mark.
 * 2. The **anchor** lead fails the validity gates — no mark. The mark's whole
 *    subject is the bus about to reach the highlighted stop, so if that timing
 *    is missing, scheduled or stale there is no bus to draw and no row honest
 *    enough to draw it on; a clean window upstream cannot rescue it.
 * 3. The anchor lead is at "Arr" (ETA at or before `now`) — `{kind:'anchor'}`.
 *    This deliberately outranks the segment reading below: a bus reported as
 *    arriving *is* at the stop, and a mark one segment upstream would argue
 *    with the "Arr" printed on the same row.
 * 4. `inferBusSegment` finds exactly one jump — `{kind:'segment', seg}`, the
 *    only rung that claims a position between two named stops, and the only
 *    one that licenses dimming the stops behind it.
 * 5. Every lead passes the gates and there is no jump at all — the bus has not
 *    entered the window yet, so `{kind:'beyond'}` puts the mark upstream of it.
 *    This is computed rather than inferred from `inferBusSegment`'s null,
 *    which covers both "no jump" and "two jumps" and cannot tell them apart.
 * 6. Anything else with a live anchor — two jumps, or a missing, unmonitored
 *    or stale lead somewhere upstream — is `{kind:'approx'}`: the bus is
 *    coming and the window cannot say from where. Admitting that on the anchor
 *    row is honest; picking the likelier of two jumps would be fiction.
 *
 * A single-element `leads` (anchor only — the terminus case, where
 * `inferBusSegment` bails on `length < 2`) falls through rung 5 with no pair
 * to compare, which is the right answer: an anchor at "Arr", otherwise a bus
 * still somewhere upstream of the one stop we can see.
 *
 * @param {Array<{estimatedArrival?: string | null, monitored?: boolean} | null | undefined>
 *   | null | undefined} leads
 * @param {number} now epoch milliseconds — a parameter, never a clock read
 * @returns {{kind: 'anchor'} | {kind: 'segment', seg: number} | {kind: 'beyond'}
 *   | {kind: 'approx'} | null}
 */
export function busMarkPlacement(leads, now) {
  if (!Array.isArray(leads) || leads.length === 0) return null;

  const times = leads.map((lead) => leadTimestamp(lead, now));
  const anchorTs = times[times.length - 1];
  if (anchorTs === null || anchorTs === undefined) return null;
  if (anchorTs - now <= 0) return { kind: 'anchor' };

  const seg = inferBusSegment(leads, now);
  if (seg !== null) return { kind: 'segment', seg };

  // Not a segment: either nothing rose past the tolerance, or too much did, or
  // part of the window was never readable. Only the first of those is "beyond".
  if (times.every((ts) => ts !== null)) {
    let jumps = 0;
    for (let k = times.length - 1; k >= 1; k -= 1) {
      if (times[k - 1] - times[k] > JUMP_TOLERANCE_MS) jumps += 1;
    }
    if (jumps === 0) return { kind: 'beyond' };
  }
  return { kind: 'approx' };
}
