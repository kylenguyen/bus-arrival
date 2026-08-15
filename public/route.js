// Route page glue — /bus/:service, the "Approach Window". Elements, `fetch`,
// `localStorage`, `history` and event wiring only: every rule this file applies
// is decided in ./route-logic.js (pure, unit tested), the same split app.js
// keeps with origin.js. Keep new rules on that side of the line.
//
// One localStorage key of its own, plus two of the board's, read-only here
// except where noted:
//   bus-route.anchor.v1   remembered boarding stop per service (LRU ≤ 30) — the
//                         only key this page writes routinely
//   bus-board.origin.v1   which door the board is ranked from — read only
//   bus-board.loc.v1      the last GPS fix — read for the anchor ladder, and
//                         written on a successful fix from this page's location
//                         door, the same {lat, lon, at} shape app.js writes

import { formatMetres, isUsableCoord, originCoord, readOriginRecord } from './origin.js';
import {
  arrivalsParams,
  BUS_POSITION_LABEL,
  directionFor,
  filterServiceEta,
  foldPlan,
  haversineM,
  inferBusSegment,
  parseServicePath,
  readAnchors,
  rememberAnchor,
  resolveAnchor,
  searchStops,
  translateAnchor,
  UPSTREAM_WINDOW,
  windowFor,
} from './route-logic.js';

const ANCHOR_KEY = 'bus-route.anchor.v1';
const ORIGIN_KEY = 'bus-board.origin.v1';
const LOC_KEY = 'bus-board.loc.v1';

const REFRESH_MS = 30_000; // arrivals refetch — one batch of ≤ 5 codes
const TICK_MS = 10_000; // local re-render so minutes count down between fetches

const el = {
  head: document.getElementById('rt-head'),
  notices: document.getElementById('rt-notices'),
  body: document.getElementById('rt-body'),
  status: document.getElementById('status'),
};

// --- state ----------------------------------------------------------------

/** The service in the URL, or null for a path the API would 400 anyway. */
const serviceNo = parseServicePath(location.pathname);

/** The /api/route response body, once it lands. */
let route = null;
/** Index into route.directions — which direction the page is showing. */
let dirIndex = 0;
/** @type {'loading' | 'anchored' | 'picker' | 'guard' | 'missing' | 'failed'} */
let mode = 'loading';
/** Which hat the picker wears: bare, the guard's offer, or the Change morph. */
let hat = 'bare';
/** The committed anchor: its stop record, how it was chosen, its direction. */
let anchor = null;
/**
 * The direction toggle's auto-translated return stop — displayed, never
 * persisted. `anchor` keeps the stop the user actually chose, which is what
 * toggling back restores.
 */
let translated = null;
/** The guard's nearest-stop offer, held while the page asks instead of assuming. */
let guardSuggestion = null;
/** Stale-stop notices from the anchor ladder, cleared on the next real anchor. */
let notices = [];
/** One transient sentence for a direction toggle that found no return stop. */
let dirNotice = '';
/** Folds spliced open: startIndex → count. Cleared when the anchor or direction changes. */
let expanded = new Map();
/** The direction the Change morph must restore if the keep chip cancels it. */
let changeDirIndex = 0;

/** The last arrivals batch, code → response entry. */
let arrivalsByCode = new Map();
/** Whether any arrivals batch has landed for the current window. */
let arrivalsFresh = false;

/**
 * What the picker list is showing, row for row. Written in the same synchronous
 * block as the list's markup — the same invariant app.js keeps for its result
 * rows — so a `data-pick` index read off the DOM always addresses the array
 * that produced that DOM.
 */
let pickRows = [];

/** The remembered anchors, service → stop code, LRU order. */
let anchors = readAnchors(readRaw(ANCHOR_KEY));

let locBusy = false;
let locDenied = false;

// --- storage, guarded ------------------------------------------------------

/** Reading throws too with storage disabled outright, hence the try. */
function readRaw(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing with storage blocked: the page works, it just is not
    // remembered next time.
  }
}

function writeAnchors() {
  write(ANCHOR_KEY, Object.fromEntries(anchors));
}

/** The last fix, read exactly as app.js's readLoc reads it. */
function readFix() {
  try {
    const raw = JSON.parse(readRaw(LOC_KEY) ?? 'null');
    if (!raw || !Number.isFinite(raw.lat) || !Number.isFinite(raw.lon)) return null;
    return raw;
  } catch {
    return null;
  }
}

// --- helpers ----------------------------------------------------------------

// app.js's escape is unimportable (module-scope document), so this is its copy.
// EVERY interpolation of server data below goes through it.
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );

const LOAD_LABEL = { SEA: 'Seats', SDA: 'Standing', LSD: 'Crowded' };
const LOAD_TITLE = {
  SEA: 'Seats available',
  SDA: 'Standing room available',
  LSD: 'Limited standing — crowded',
};

/** Minutes until an ISO arrival, floored — the board's rule, same clock passed in. */
function minutesUntil(iso, now) {
  return Math.floor((new Date(iso).getTime() - now) / 60_000);
}

/** DataMall's HHMM ("0530") as a clock time ("05:30"); '' for anything else. */
function clockTime(hhmm) {
  return typeof hhmm === 'string' && /^\d{4}$/.test(hhmm)
    ? `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`
    : '';
}

function stamp(when) {
  el.status.textContent = `Updated ${new Date(when).toLocaleTimeString('en-SG', { hour12: false })}`;
}

/** The stop the window is drawn around: the translated return stop, or the anchor. */
function effectiveStop() {
  return translated ? translated.stop : anchor?.stop ?? null;
}

/** A stop's dense index in a direction's list. `seq` is 1-based and dense. */
function indexOfStop(stops, stop) {
  const bySeq = Number.isInteger(stop?.seq) ? stop.seq - 1 : -1;
  if (bySeq >= 0 && stops[bySeq]?.code === stop.code) return bySeq;
  return stops.findIndex((s) => s.code === stop?.code);
}

/**
 * Walking distance from the board's saved origin to a stop, or null with no
 * coordinate in hand. Display only — every ≤/> decision against the 2 km guard
 * is route-logic.js's, made inside resolveAnchor and translateAnchor.
 */
function userDistanceM(stop) {
  const coord = originCoord(readOriginRecord(readRaw(ORIGIN_KEY)), readFix());
  if (!coord || !isUsableCoord(coord.lat, coord.lon)) return null;
  if (!stop || !isUsableCoord(stop.lat, stop.lon)) return null;
  return Math.round(haversineM(coord.lat, coord.lon, stop.lat, stop.lon));
}

// --- boot -------------------------------------------------------------------

async function loadRoute() {
  try {
    const res = await fetch(`/api/route/${encodeURIComponent(serviceNo)}`);
    if (res.status === 404 || res.status === 400) {
      renderMissing(serviceNo);
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (!Array.isArray(data.directions) || data.directions.length === 0) {
      renderMissing(serviceNo);
      return;
    }
    route = data;
    applyLadder();
  } catch {
    renderFailed();
  }
}

/**
 * The anchor ladder, applied. resolveAnchor decides everything — this reads the
 * raw storage strings, hands them over, and assigns the outcome.
 */
function applyLadder() {
  const resolved = resolveAnchor({
    serviceNo,
    queryStop: new URLSearchParams(location.search).get('stop'),
    anchorsRaw: readRaw(ANCHOR_KEY),
    originRaw: readRaw(ORIGIN_KEY),
    locRaw: readRaw(LOC_KEY),
    directions: route.directions,
  });

  notices = resolved.notices;
  if (resolved.dropRemembered) {
    // A remembered stop the route no longer serves would re-raise the same
    // notice on every visit; drop it now that the notice has been shown once.
    anchors = new Map(anchors);
    anchors.delete(serviceNo);
    writeAnchors();
  }

  if (resolved.state === 'anchored') {
    setAnchor(resolved.stop, resolved.source);
    return;
  }
  if (resolved.state === 'guard') {
    guardSuggestion = resolved.suggestion;
    mode = 'guard';
    hat = 'guard';
    renderAll();
    return;
  }
  mode = 'picker';
  hat = 'bare';
  renderAll();
}

// --- anchoring ----------------------------------------------------------------

/**
 * The one place an anchor is committed: URL via replaceState, localStorage via
 * rememberAnchor, window redrawn, arrivals asked for. The translated return
 * stop never comes through here — it is displayed, not committed.
 */
function setAnchor(stop, source) {
  const dir = directionFor(route.directions, stop.code);
  dirIndex = Math.max(0, route.directions.indexOf(dir));
  anchor = { stop, source, dirNumber: dir?.direction ?? null };
  translated = null;
  guardSuggestion = null;
  dirNotice = '';
  mode = 'anchored';
  hat = 'bare';
  expanded = new Map();
  arrivalsByCode = new Map();
  arrivalsFresh = false;

  const url = new URL(location.href);
  url.searchParams.set('stop', stop.code);
  history.replaceState(null, '', url);

  anchors = rememberAnchor(anchors, serviceNo, stop.code);
  writeAnchors();

  renderAll();
  void refreshArrivals();
}

/** A stop chosen by hand — picker row, search result — clears old notices too. */
function anchorPicked(stop) {
  notices = [];
  setAnchor(stop, 'picked');
}

// --- arrivals ---------------------------------------------------------------

/** The window around the effective anchor, or null when nothing is anchored. */
function currentWindow() {
  const stop = effectiveStop();
  if (!stop || !route) return null;
  const stops = route.directions[dirIndex]?.stops ?? [];
  const anchorIdx = indexOfStop(stops, stop);
  if (anchorIdx < 0) return null;
  return { stops, anchorIdx, win: windowFor(stops, anchorIdx) };
}

/**
 * One /api/arrivals batch — the anchor plus its ≤ 4 upstream stops, so a route
 * page costs one ≤ 5-code call per 30 s and the picker states cost zero.
 */
async function refreshArrivals() {
  if (mode !== 'anchored' || document.visibilityState !== 'visible') return;
  const current = currentWindow();
  if (!current?.win) return;

  const params = arrivalsParams([...current.win.upstreamCodes, current.win.anchorCode]);
  if (!params) return;

  try {
    const res = await fetch(`/api/arrivals?${params}`);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    arrivalsByCode = new Map((data.arrivals ?? []).map((entry) => [entry.code, entry]));
    arrivalsFresh = true;
    stamp(data.fetchedAt);
    if (mode === 'anchored') renderBody();
  } catch {
    // Leave the last good timings on screen; the next tick tries again.
  }
}

// --- rendering ----------------------------------------------------------------

function renderAll() {
  renderHead();
  renderNotices();
  renderBody();
}

function renderHead() {
  if (!route) {
    el.head.innerHTML = '';
    return;
  }

  const dir = route.directions[dirIndex];
  const ends = route.loop
    ? `${escape(dir.origin.description)} — loop service`
    : `${escape(dir.origin.description)} → ${escape(dir.destination.description)}`;

  const first = clockTime(dir.firstBus?.wd);
  const last = clockTime(dir.lastBus?.wd);
  const meta = [`${dir.stops.length} stops`, first && last ? `runs ${first}–${last}` : '']
    .filter(Boolean)
    .join(' · ');

  const toggle = route.loop
    ? `<p class="loop-badge">⟲ Loop at ${escape(route.loopDesc ?? dir.destination.description)}</p>`
    : route.directions.length > 1
      ? `<div class="dir-toggle" role="group" aria-label="Direction of travel">${route.directions
          .map(
            (d, i) =>
              `<button type="button" data-act="dir" data-dir="${escape(d.direction)}"
                 class="${i === dirIndex ? 'on' : ''}" aria-pressed="${i === dirIndex}">
                 to ${escape(d.destination.description)}</button>`,
          )
          .join('')}</div>`
      : '';

  el.head.innerHTML = `
    <div class="rt-head">
      <span class="rt-no">${escape(route.serviceNo)}</span>
      <div class="rt-title">
        <span class="rt-ends">${ends}</span>
        <span class="rt-meta">${escape(meta)}</span>
      </div>
    </div>
    ${toggle}`;
}

function renderNotices() {
  const chips = [];

  for (const notice of notices) {
    chips.push(`<div class="note-chip">${escape(notice.message)}</div>`);
  }
  if (dirNotice) chips.push(`<div class="note-chip">${escape(dirNotice)}</div>`);

  if (mode === 'anchored') {
    const change = '<button type="button" class="chip-act" data-act="change">Change ›</button>';
    if (translated) {
      chips.push(
        `<div class="note-chip">↩ Return stop · ${escape(formatMetres(translated.distanceM))}
           from ${escape(anchor.stop.description)} ${change}</div>`,
      );
    } else if (anchor.source === 'remembered') {
      chips.push(`<div class="note-chip">Your usual stop on this route ${change}</div>`);
    } else if (anchor.source === 'nearest') {
      chips.push(`<div class="note-chip">📍 Nearest stop on this route to you ${change}</div>`);
    }
  }

  if (mode === 'picker' && hat === 'change') {
    const name = effectiveStop()?.description ?? '';
    chips.push(
      `<button type="button" class="keep-chip" data-act="keep">← Keep ${escape(name)}</button>`,
    );
  }

  el.notices.innerHTML = chips.join('');
}

function renderBody() {
  if (mode === 'anchored') renderWindow();
  else if (mode === 'picker' || mode === 'guard') renderPicker();
  // 'missing' and 'failed' write el.body themselves; 'loading' keeps the
  // skeleton spine the HTML shipped with.
}

// --- the approach window --------------------------------------------------------

/** One upstream stop's inline ETA: pulsing until the batch lands, then minutes. */
function etaInline(lead, now) {
  if (!arrivalsFresh) {
    return '<span class="eta-inline"><span class="sk sk-eta-in skeleton"></span></span>';
  }
  if (!lead || !lead.estimatedArrival) return '';
  const mins = minutesUntil(lead.estimatedArrival, now);
  if (mins <= 0) return '<span class="eta-inline">arr</span>';
  return `<span class="eta-inline">${mins}<span class="eta-unit">min</span></span>`;
}

/** One arrival cell in the anchor panel — renderEta's markup, minus the vehicle tags. */
function etaCell(bus, index, now) {
  const lead = index === 0;
  const classes = ['eta'];
  if (lead) classes.push('eta-lead');

  if (!bus || !bus.estimatedArrival) {
    return `<div class="${classes.join(' ')} eta-empty">
      <span class="eta-value">–</span>${lead ? '<span class="eta-load"></span>' : ''}
    </div>`;
  }

  const mins = minutesUntil(bus.estimatedArrival, now);
  if (mins <= 1) classes.push('arriving');
  if (!bus.monitored) classes.push('scheduled');

  const value =
    mins <= 0
      ? '<span class="eta-value">Arr</span>'
      : `<span class="eta-value">${mins}${lead ? '<span class="eta-unit">min</span>' : ''}</span>`;

  const label = lead && bus.load && LOAD_LABEL[bus.load] ? LOAD_LABEL[bus.load] : '';
  const load = label
    ? `<span class="eta-load load-${escape(bus.load.toLowerCase())}" title="${escape(
        LOAD_TITLE[bus.load],
      )}">${escape(label)}</span>`
    : lead
      ? '<span class="eta-load"></span>'
      : '';

  const title = bus.monitored ? '' : ' title="Scheduled timing — bus not currently tracked"';
  return `<div class="${classes.join(' ')}"${title}>${value}${load}</div>`;
}

/** The anchor panel's live rows: this service's next three buses, or why not. */
function panelServices(code, now) {
  if (!arrivalsFresh) {
    return `<div class="skeleton" aria-hidden="true">
      <div class="sk-row"><span class="sk sk-no"></span><span class="sk sk-eta"></span></div>
    </div>`;
  }
  const buses = filterServiceEta(arrivalsByCode.get(code), serviceNo);
  if (buses === null) return '<p class="card-msg">Timings unavailable — will retry.</p>';
  if (buses.length === 0) return '<p class="card-msg">No buses at this hour.</p>';

  return `<div class="services-head" aria-hidden="true">
      <span>Bus</span><span>Next</span><span>Then</span><span>After</span>
    </div>
    <ul class="services"><li class="service">
      <div class="service-id"><span class="service-no">${escape(serviceNo)}</span></div>
      ${etaCell(buses[0], 0, now)}${etaCell(buses[1], 1, now)}${etaCell(buses[2], 2, now)}
    </li></ul>`;
}

function renderWindow() {
  const current = currentWindow();
  if (!current?.win) return;
  const { stops, anchorIdx, win } = current;

  // The fold plan: the window's keeps plus whatever the user spliced open.
  const keep = new Set(win.keepIndices);
  for (const [start, count] of expanded) {
    for (let i = start; i < start + count; i += 1) keep.add(i);
  }
  const plan = foldPlan(stops, [...keep]);
  const from = anchorIdx - win.upstreamCodes.length;

  // One clock read for the whole spine, like the board's cards.
  const now = Date.now();
  const leads = [...win.upstreamCodes, win.anchorCode].map((code) => {
    const buses = filterServiceEta(arrivalsByCode.get(code), serviceNo);
    return Array.isArray(buses) ? (buses[0] ?? null) : null;
  });
  // The mark only when the timings support exactly one bus in one place;
  // inferBusSegment answers null for everything ambiguous, and null means no mark.
  const seg = arrivalsFresh ? inferBusSegment(leads, now) : null;
  const markIdx = seg === null ? -1 : from + seg + 1;

  const rowFor = (row) => {
    if (row.kind === 'fold') {
      return `<li class="fold"><button type="button" class="fold-btn"
        data-fold="${row.startIndex}" data-count="${row.count}">
        <b>${row.count} stops</b> — show</button></li>`;
    }
    const index = row.index;
    const stop = stops[index];
    const classes = [];
    if (index === 0 || index === stops.length - 1) classes.push('term');
    const inWin = index >= from && index < anchorIdx;
    const passed = seg !== null && inWin && index - from <= seg;
    if (passed) classes.push('passed');
    if (index === anchorIdx) classes.push('here');

    const mark =
      index === markIdx ? '<span class="bus-mark" aria-hidden="true">🚌</span>' : '';
    let right = '';
    if (inWin && !passed) right = etaInline(leads[index - from], now);
    else if (!inWin && index !== anchorIdx && index !== 0 && index !== stops.length - 1) {
      right = `<span class="stop-code">${escape(stop.code)}</span>`;
    }
    const name =
      index === anchorIdx
        ? `<strong>${escape(stop.description)}</strong>`
        : escape(stop.description);
    return `<li class="${classes.join(' ')}">${mark}${right}${name}</li>`;
  };

  // The spine splits at the anchor so the here-panel sits between the halves.
  const above = [];
  const below = [];
  let past = false;
  for (const row of plan) {
    // "Departs terminus": the window reaches the route's start, so the missing
    // upstream rows are replaced by the honest line about why they are missing.
    if (row.kind === 'stop' && row.index === anchorIdx && anchorIdx === 0) {
      above.push('<li class="depart">Departs terminus</li>');
    }
    (past ? below : above).push(rowFor(row));
    if (row.kind === 'stop' && row.index === 0 && anchorIdx > 0 && anchorIdx < UPSTREAM_WINDOW) {
      above.push('<li class="depart">Departs terminus</li>');
    }
    if (row.kind === 'stop' && row.index === anchorIdx) past = true;
  }

  const stop = effectiveStop();
  const distance = userDistanceM(stop);
  const hpName = `${translated ? 'Nearest return stop' : 'You board here'}${
    distance === null ? '' : ` · ${escape(formatMetres(distance))}`
  }`;
  const hpSub = [escape(stop.code), stop.roadName ? escape(stop.roadName) : '']
    .filter(Boolean)
    .join(' · ');

  el.body.innerHTML = `
    <p class="rt-sec">Approaching your stop</p>
    <ul class="spine">${above.join('')}</ul>
    <div class="here-panel">
      <div class="hp-head">
        <div class="hp-title">
          <span class="hp-name">${hpName}</span>
          <span class="hp-sub">${hpSub}</span>
        </div>
        <button type="button" class="hp-change" data-act="change">Change</button>
      </div>
      ${panelServices(stop.code, now)}
    </div>
    <ul class="spine">${below.join('')}</ul>
    <p class="honesty">${escape(BUS_POSITION_LABEL)}</p>`;
}

// --- the picker -------------------------------------------------------------------

/** Whether this page may offer the location door at all — originsState's rule. */
const geolocationSupported = window.isSecureContext && !!navigator.geolocation;

function renderPicker() {
  // The search box survives a re-render (direction toggle, guard dismissal):
  // its value is carried across because the input node itself is rebuilt.
  const held = el.body.querySelector('#rt-search')?.value ?? '';

  const heading = hat === 'change' ? 'Choose a new stop' : 'Where will you board?';
  const guard =
    hat === 'guard' && guardSuggestion
      ? `<div class="guard">This route doesn't pass near you — closest stop is
           ${escape(formatMetres(guardSuggestion.distanceM))}.
           <div class="g-actions">
             <button type="button" data-act="use-anyway">Use it anyway</button>
             <button type="button" data-act="dismiss-guard">Pick a stop below</button>
           </div></div>`
      : '';

  const locDoor = geolocationSupported
    ? `<button type="button" class="loc-door${locBusy ? ' busy' : ''}" data-act="loc"
         ${locBusy ? 'disabled' : ''}>📍 ${locBusy ? 'Locating…' : 'Use my location'}</button>
       <p id="door-note" class="door-note" ${locDenied ? '' : 'hidden'}>
         Location unavailable here — search above or tap your stop below instead.</p>`
    : '';

  el.body.innerHTML = `
    ${guard}
    <p class="rt-sec">${heading}</p>
    <div class="rt-search">
      <label class="visually-hidden" for="rt-search">Search stops on this route</label>
      <input id="rt-search" type="search" inputmode="search" enterkeyhint="search"
             autocomplete="off" spellcheck="false"
             placeholder="Search stops on this route" />
    </div>
    ${locDoor}
    <ul id="rt-list" class="spine"></ul>
    <ul id="rt-results" class="rt-results" hidden></ul>
    <p id="picker-note" class="honesty"></p>`;

  const input = el.body.querySelector('#rt-search');
  if (input && held) input.value = held;
  renderPickerList();
}

/**
 * The picker's list — full spine, or search results replacing it. `pickRows`
 * and the markup are written in this one synchronous block; rows commit by
 * `data-pick` index into that array and nothing else.
 */
function renderPickerList() {
  const list = el.body.querySelector('#rt-list');
  const results = el.body.querySelector('#rt-results');
  const note = el.body.querySelector('#picker-note');
  if (!list || !results || !note) return;

  const stops = route.directions[dirIndex]?.stops ?? [];
  const query = el.body.querySelector('#rt-search')?.value ?? '';
  const hits = searchStops(stops, query);

  const current = hat === 'change' ? effectiveStop() : null;
  const currentIdx = current ? indexOfStop(stops, current) : -1;

  if (hits === null) {
    // No query worth searching: the full route, every row tappable.
    pickRows = stops;
    list.hidden = false;
    results.hidden = true;
    results.innerHTML = '';
    list.innerHTML = stops
      .map((stop, index) => {
        if (index === currentIdx) {
          return `<li class="here pick" data-pick="${index}">
            <span class="cur-tag">current</span><strong>${escape(stop.description)}</strong></li>`;
        }
        const term = index === 0 || index === stops.length - 1 ? ' term' : '';
        return `<li class="pick${term}" data-pick="${index}">
          <span class="chev">›</span>${escape(stop.description)}</li>`;
      })
      .join('');
    note.textContent = 'Tap your stop to watch the bus approach it.';
    return;
  }

  list.innerHTML = '';
  list.hidden = true;

  if (hits.length === 0) {
    pickRows = [];
    results.hidden = true;
    results.innerHTML = '';
    const other = !route.loop && route.directions.length > 1
      ? ' — it may be on the other direction'
      : '';
    note.textContent = `No stop matching '${query.trim()}' on route ${serviceNo}${other}.`;
    return;
  }

  // Results replace the spine — they are the pick list, same tap behaviour.
  pickRows = hits.map((hit) => hit.stop);
  results.hidden = false;
  results.innerHTML = hits
    .map(({ stop, matches }, index) => {
      const range = (field) => matches.find((m) => m.field === field) ?? null;
      const sub = [
        highlight(stop.roadName, range('roadName')),
        highlight(stop.code, range('code')),
      ]
        .filter(Boolean)
        .join(' · ');
      return `<li class="pick" data-pick="${index}">
        <span class="r-name">${highlight(stop.description, range('description'))}</span>
        <span class="r-sub">${sub}</span>
      </li>`;
    })
    .join('');
  note.textContent = 'Matches stop name, code, or road. Tap to anchor.';
}

/**
 * A field with its matched range tinted. The range comes from searchStops, so
 * the match is never re-derived here against different casing rules; every
 * segment is escaped on its way in.
 */
function highlight(value, range) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return '';
  if (!range) return escape(text);
  return (
    escape(text.slice(0, range.start)) +
    `<mark>${escape(text.slice(range.start, range.end))}</mark>` +
    escape(text.slice(range.end))
  );
}

// --- terminal states ---------------------------------------------------------------

/** The "no such service" page — a real page, never a dead JSON error. */
function renderMissing(svc) {
  mode = 'missing';
  document.title = 'no such service · ezbus';
  el.head.innerHTML = '';
  el.notices.innerHTML = '';
  const name = svc ? `There's no bus service ${escape(svc)}.` : "That's not a bus service number.";
  el.body.innerHTML = `
    <p class="rt-sec">No such service</p>
    <div class="guard">${name} Check the number on the stop's pole or on the board.
      <div class="g-actions"><a href="/">← Back to board</a></div>
    </div>`;
}

function renderFailed() {
  mode = 'failed';
  el.head.innerHTML = '';
  el.notices.innerHTML = '';
  el.body.innerHTML = `
    <div class="guard">Could not load this route. Check your connection.
      <div class="g-actions"><button type="button" data-act="retry">Try again</button></div>
    </div>`;
}

// --- location door -----------------------------------------------------------------

/**
 * Asks for a position. Copied verbatim from app.js.
 *
 * **Deliberately not `async`, and do not make it so.** A `Promise` executor runs
 * synchronously, so `getCurrentPosition` below is reached in the same task as the
 * click that led here — which is the only reason iOS Safari shows the prompt at
 * all. Safari spends the click's transient activation on the first `await`, and a
 * `getCurrentPosition` called after that point silently never prompts. An `await`
 * inserted anywhere above this call — here or in a caller — therefore breaks
 * first-run location on iPhone while working perfectly in desktop Chrome, and no
 * test in this repository can catch it.
 */
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position.coords),
      reject,
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 5 * 60_000 },
    );
  });
}

/**
 * The location door. Synchronous down to `getPosition()` — the transient-
 * activation rule above governs this whole click path, so the busy state is a
 * targeted DOM write rather than a re-render, and nothing here awaits.
 */
function locateForAnchor() {
  if (locBusy) return;
  locBusy = true;
  locDenied = false;
  updateLocDoor();

  getPosition().then(
    (coords) => {
      locBusy = false;
      // The same {lat, lon, at} record app.js writes: a fresh fix is worth the
      // board's 12 h cached first paint too.
      write(LOC_KEY, { lat: coords.latitude, lon: coords.longitude, at: Date.now() });
      applyFix(coords.latitude, coords.longitude);
    },
    () => {
      // Denied, timed out, failed — all one honest line; the other two doors
      // still work and the button stays for retry.
      locBusy = false;
      locDenied = true;
      updateLocDoor();
    },
  );
}

/**
 * A fresh fix through the same ladder rung the load path uses: resolveAnchor
 * with a synthetic gps origin, so the ≤ 2 km anchor / > 2 km guard decision
 * stays in route-logic.js rather than growing a second copy here.
 */
function applyFix(lat, lon) {
  const resolved = resolveAnchor({
    serviceNo,
    queryStop: null,
    anchorsRaw: null,
    originRaw: '{"mode":"gps"}',
    locRaw: JSON.stringify({ lat, lon }),
    directions: route.directions,
  });
  if (resolved.state === 'anchored') {
    notices = [];
    setAnchor(resolved.stop, 'nearest');
    return;
  }
  if (resolved.state === 'guard') {
    guardSuggestion = resolved.suggestion;
    mode = 'guard';
    hat = 'guard';
    renderAll();
    return;
  }
  updateLocDoor();
}

/** The door's three states applied in place, so the search box keeps its focus. */
function updateLocDoor() {
  const door = el.body.querySelector('[data-act="loc"]');
  const note = el.body.querySelector('#door-note');
  if (!door) return;
  door.classList.toggle('busy', locBusy);
  door.disabled = locBusy;
  door.textContent = locBusy ? '📍 Locating…' : '📍 Use my location';
  if (note) note.hidden = !locDenied;
}

// --- the Change morph and the direction toggle ----------------------------------------

function enterChange() {
  changeDirIndex = dirIndex;
  mode = 'picker';
  hat = 'change';
  renderAll();
  // Pre-scrolled so the current row is in sight without hunting for it.
  el.body.querySelector('.cur-tag')?.closest('li')?.scrollIntoView({ block: 'center' });
}

/** The keep chip: back to the window exactly as it was, anchor untouched. */
function leaveChange() {
  mode = 'anchored';
  hat = 'bare';
  dirIndex = changeDirIndex;
  renderAll();
  void refreshArrivals();
}

function onDirTap(target) {
  if (!route || route.loop) return;
  const idx = route.directions.findIndex((d) => d.direction === target);
  if (idx < 0) return;
  const targetDir = route.directions[idx];
  dirNotice = '';

  if (mode === 'anchored') {
    if (idx === dirIndex) return;

    if (translated) {
      // Toggling back: the translated stop was never persisted, so restoring
      // the original is dropping the overlay.
      translated = null;
      dirIndex = route.directions.findIndex((d) => d.direction === anchor.dirNumber);
      if (dirIndex < 0) dirIndex = 0;
    } else {
      const t = translateAnchor(route.directions, anchor.stop, target);
      if (t) {
        translated = { stop: t.stop, distanceM: t.distanceM };
        dirIndex = idx;
      } else {
        // No return stop within reach: no fake anchor — the picker for that
        // direction, with the sentence saying why. The anchor and the URL keep
        // the original stop, so toggling back restores everything.
        dirNotice = `${serviceNo} doesn't stop near ${anchor.stop.description} on the way to ${targetDir.destination.description}.`;
        mode = 'picker';
        hat = 'bare';
        dirIndex = idx;
        renderAll();
        return;
      }
    }
    expanded = new Map();
    arrivalsByCode = new Map();
    arrivalsFresh = false;
    renderAll();
    void refreshArrivals();
    return;
  }

  if (mode === 'picker' || mode === 'guard') {
    // A picker reached by a failed translate: toggling back to the anchor's
    // own direction is the restore.
    if (hat !== 'change' && anchor && target === anchor.dirNumber) {
      translated = null;
      mode = 'anchored';
      hat = 'bare';
      dirIndex = idx;
      expanded = new Map();
      renderAll();
      void refreshArrivals();
      return;
    }
    dirIndex = idx;
    renderAll();
  }
}

// --- wiring -------------------------------------------------------------------------

function onAction(event) {
  const act = event.target.closest('[data-act]');
  if (act) {
    switch (act.dataset.act) {
      case 'dir':
        onDirTap(Number(act.dataset.dir));
        return;
      case 'change':
        enterChange();
        return;
      case 'keep':
        leaveChange();
        return;
      case 'use-anyway':
        if (guardSuggestion) {
          notices = [];
          setAnchor(guardSuggestion.stop, 'nearest');
        }
        return;
      case 'dismiss-guard':
        hat = 'bare';
        mode = 'picker';
        renderAll();
        return;
      // No `await` may sit between this click and getPosition — see the note
      // on getPosition; this handler is synchronous the whole way down.
      case 'loc':
        locateForAnchor();
        return;
      case 'retry':
        mode = 'loading';
        void loadRoute();
        return;
    }
  }

  const fold = event.target.closest('[data-fold]');
  if (fold) {
    expanded = new Map(expanded);
    expanded.set(Number(fold.dataset.fold), Number(fold.dataset.count));
    renderBody();
    return;
  }

  const pick = event.target.closest('[data-pick]');
  if (pick) {
    const stop = pickRows[Number(pick.dataset.pick)];
    if (stop) anchorPicked(stop);
  }
}

el.head.addEventListener('click', onAction);
el.notices.addEventListener('click', onAction);
el.body.addEventListener('click', onAction);

// The route's stops are already in hand, so search is a client-side filter —
// no debounce, no request, just the list redrawn per keystroke.
el.body.addEventListener('input', (event) => {
  if (event.target?.id === 'rt-search' && (mode === 'picker' || mode === 'guard')) {
    renderPickerList();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshArrivals();
});

setInterval(() => void refreshArrivals(), REFRESH_MS);
setInterval(() => {
  if (mode === 'anchored' && arrivalsFresh) renderBody();
}, TICK_MS);

// --- boot ------------------------------------------------------------------------------

if (!serviceNo) {
  renderMissing(null);
} else {
  document.title = `bus ${serviceNo} · ezbus`;
  void loadRoute();
}
