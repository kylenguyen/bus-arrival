// Stop page glue — /stop/:code, the "Flagboard". Elements, `fetch`,
// `localStorage` and event wiring only: every rule this file applies is decided
// in ./stop-logic.js (pure, unit tested), the same split app.js keeps with
// origin.js and route.js with route-logic.js. Keep new rules on that side of
// the line.
//
// No storage key of its own — two of the board's, and the bargain is stated:
//   bus-board.pins.v1   the pinned stops. The plate's ★ reads and toggles it,
//                       writing the same {code, description, roadName} rows
//                       app.js writes — bookmark on this page IS pin on the
//                       board, one key, one meaning.
//   bus-board.loc.v1    the last GPS fix — read-only, for the distance chip.
//                       This page never prompts for a location: a fix fresh
//                       inside the board's 12 h window draws the chip, anything
//                       else omits it, and there is no second first-run.

import { distanceLabel, isUsableCoord } from './origin.js';
import { haversineM } from './route-logic.js';
import {
  dayTypeFor,
  fmtFreq,
  fmtHHMM,
  parseStopPath,
  serviceStatus,
  sharePayload,
} from './stop-logic.js';

const PINS_KEY = 'bus-board.pins.v1';
const LOC_KEY = 'bus-board.loc.v1';

/** app.js's cached-paint ceiling: a fix older than this no longer places the user. */
const LOC_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const REFRESH_MS = 30_000; // arrivals refetch — one single-code call
const TICK_MS = 10_000; // local re-render so minutes count down between fetches

/** How long the Share verb reads "Copied ✓" after the clipboard fallback. */
const COPIED_MS = 2_000;

/** The stop-logic past-midnight convention, needed here for "first bus next". */
const PAST_MIDNIGHT_MIN = 4 * 60;

const el = {
  plate: document.getElementById('sp-plate'),
  arrivals: document.getElementById('sp-arrivals'),
  sched: document.getElementById('sp-sched'),
  status: document.getElementById('status'),
};

// --- state ----------------------------------------------------------------

/** The code in the URL, or null for a path the API would 400 anyway. */
const code = parseStopPath(location.pathname);

/** The /api/stop response body, once it lands. */
let data = null;
/** @type {'loading' | 'ready' | 'missing' | 'badcode' | 'failed'} */
let mode = 'loading';
/** Which schedule column the day control shows. Defaults to today's. */
let dayType = dayTypeFor(new Date());
/** The pinned stops — the same rows app.js holds. */
let pins = readPins();
/** This stop's last arrivals batch: array, [] for none running, null for failed. */
let liveServices = null;
/** Whether any arrivals batch has landed. */
let arrivalsFresh = false;
/** Pending "Copied ✓" reset, so rapid taps do not stack timers. */
let copiedTimer = 0;

// --- storage, guarded ------------------------------------------------------

/** Reading throws too with storage disabled outright, hence the try. */
function readPins() {
  try {
    const raw = JSON.parse(localStorage.getItem(PINS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((s) => s && typeof s.code === 'string') : [];
  } catch {
    return [];
  }
}

/** The last fix, read exactly as app.js's readLoc reads it. */
function readFix() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOC_KEY) ?? 'null');
    if (!raw || !Number.isFinite(raw.lat) || !Number.isFinite(raw.lon)) return null;
    return raw;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing with storage blocked: the pin works for this page view,
    // it just is not remembered next time.
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

function stamp(when) {
  el.status.textContent = `Updated ${new Date(when).toLocaleTimeString('en-SG', { hour12: false })}`;
}

// --- boot -------------------------------------------------------------------

async function loadStop() {
  try {
    const res = await fetch(`/api/stop/${encodeURIComponent(code)}`);
    if (res.status === 404 || res.status === 400) {
      renderMissing();
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    if (!body || !body.stop) {
      renderMissing();
      return;
    }
    data = body;
    mode = 'ready';
    // The same string the server injected into <title> — usually a no-op, but
    // a shell served by the static fallback still ends up correctly named.
    document.title = plateTitle();
    renderAll();
    void refreshArrivals();
  } catch {
    renderFailed();
  }
}

/** `{code} · {description}, {roadName}` — the share title and the tab title. */
function plateTitle() {
  const s = data.stop;
  const name = [s.description, s.roadName].filter(Boolean).join(', ');
  return name ? `${s.code} · ${name}` : s.code;
}

// --- the plate ----------------------------------------------------------------

function isPinned() {
  return pins.some((p) => p.code === data.stop.code);
}

/**
 * The distance chip, or '' — never a disabled or apologetic one. Drawn only
 * from a fix fresh inside the board's 12 h window; the distance itself is the
 * shared haversine, and the "Here" rule under 30 m is distanceLabel's, told
 * the truth that loc.v1 is always a gps fix.
 */
function distanceChip() {
  const fix = readFix();
  if (!fix || typeof fix.at !== 'number' || Date.now() - fix.at > LOC_MAX_AGE_MS) return '';
  const s = data.stop;
  if (!isUsableCoord(fix.lat, fix.lon) || !isUsableCoord(s.lat, s.lon)) return '';
  const metres = Math.round(haversineM(fix.lat, fix.lon, s.lat, s.lon));
  const label = distanceLabel({ distanceM: metres }, { mode: 'gps' });
  return label ? `<span class="meta-dist">${escape(label)}</span>` : '';
}

function renderPlate() {
  const s = data.stop;
  const pinned = isPinned();
  const opposite = data.opposite;

  // The opposite chip exists only when the server found a confident pair —
  // plain navigation, never a disabled control.
  const flip = opposite
    ? `<a class="sp-act" href="/stop/${encodeURIComponent(opposite.code)}">⇄ Opposite · ${escape(
        opposite.description,
      )}</a>`
    : '';

  el.plate.innerHTML = `
    <div class="card sp-plate">
      <div class="card-head">
        <div class="card-title">
          <span class="meta-code">${escape(s.code)}</span>
          <span class="card-name">${escape(s.description)}</span>
          <span class="card-sub">
            ${s.roadName ? `<span class="meta-where">${escape(s.roadName)}</span>` : ''}
            ${distanceChip()}
          </span>
        </div>
        <button class="pin" type="button" data-act="pin"
                aria-pressed="${pinned}"
                aria-label="${pinned ? 'Unpin' : 'Pin'} ${escape(s.description)}"
                title="${pinned ? 'Pinned to your board' : 'Keep this stop at the top'}">${
                  pinned ? '★' : '☆'
                }</button>
      </div>
      <div class="sp-acts">
        <button type="button" class="sp-act" data-act="share">Share</button>
        ${flip}
      </div>
    </div>`;
}

/** Pin here is pin on the board: the same key, the same row shape app.js writes. */
function togglePin() {
  const s = data.stop;
  if (isPinned()) {
    pins = pins.filter((p) => p.code !== s.code);
  } else {
    pins = [...pins, { code: s.code, description: s.description, roadName: s.roadName }];
  }
  write(PINS_KEY, pins);
  clearTimeout(copiedTimer);
  renderPlate();
}

/**
 * Share. **Nothing may be awaited between the click and `navigator.share`** —
 * the same transient-activation rule as geolocation (see getPosition in
 * route.js and AGENTS.md): iOS Safari spends the click's activation on the
 * first `await`, and a share sheet requested after that point silently never
 * opens. The payload is built synchronously and the call is the next statement.
 */
function onShare(button) {
  const payload = sharePayload(data.stop, location.origin);
  if (window.isSecureContext && navigator.share) {
    navigator.share({ title: payload.title, url: payload.url }).catch(() => {
      // A dismissed sheet is a decision, not an error.
    });
    return;
  }
  copyUrl(button, payload.url);
}

/** The clipboard fallback: desktop, or a browser with no share sheet. */
function copyUrl(button, url) {
  const flash = () => {
    button.textContent = 'Copied ✓';
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      button.textContent = 'Share';
    }, COPIED_MS);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(flash, () => {});
    return;
  }
  // Insecure context (a bare LAN IP): no async clipboard API at all. The
  // selection dance still works there, and the verb only claims "Copied ✓"
  // when the copy actually reported success.
  const holder = document.createElement('textarea');
  holder.value = url;
  holder.setAttribute('readonly', '');
  holder.style.position = 'fixed';
  holder.style.opacity = '0';
  document.body.append(holder);
  holder.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    // Left false: the label must not claim a copy that did not happen.
  }
  holder.remove();
  if (copied) flash();
}

// --- arrivals ---------------------------------------------------------------

/** One single-code /api/arrivals call per 30 s — the board's refresh idiom. */
async function refreshArrivals() {
  if (mode !== 'ready' || document.visibilityState !== 'visible') return;
  try {
    const res = await fetch(`/api/arrivals?stops=${encodeURIComponent(code)}`);
    if (!res.ok) throw new Error(String(res.status));
    const batch = await res.json();
    const entry = (batch.arrivals ?? []).find((e) => e.code === code) ?? null;
    liveServices = entry ? entry.services : null;
    arrivalsFresh = true;
    stamp(batch.fetchedAt);
    if (mode === 'ready') renderArrivals();
  } catch {
    // Leave the last good timings on screen; the next tick tries again.
  }
}

/** One arrival cell — route.js's etaCell, verbatim: the board's markup, no tags. */
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

/** The service number cell, linking through to the route page anchored here. */
function serviceLink(serviceNo) {
  return `<div class="service-id">
      <a class="service-no" href="/bus/${encodeURIComponent(serviceNo)}?stop=${escape(code)}">${escape(serviceNo)}</a>
    </div>`;
}

/**
 * When an ended service runs again: tomorrow's first bus — except inside the
 * past-midnight window, where "ended" came from yesterday's span and the next
 * first bus is this very morning's. Null when the column has no data; the row
 * then says "Ended" alone rather than inventing a time.
 */
function nextFirstBus(sched, nowDate, today) {
  const nowMin = nowDate.getHours() * 60 + nowDate.getMinutes();
  const type =
    nowMin < PAST_MIDNIGHT_MIN
      ? today
      : dayTypeFor(new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1, 12));
  return fmtHHMM(sched.firstBus?.[type]);
}

/**
 * One arrivals row. Live timings when the batch has any; otherwise the honest
 * schedule answer — "Ended · first bus HH:MM" or "First bus HH:MM" — because
 * "ended" and "no buses right now" are different facts and only the schedule
 * (via serviceStatus) can tell them apart. A running service the batch has
 * nothing for renders the board's own empty en-dash cells.
 */
function serviceRow(serviceNo, live, sched, nowDate, today, now) {
  const buses = live?.buses ?? [];
  if (buses.length > 0) {
    return `<li class="service">${serviceLink(serviceNo)}
      ${etaCell(buses[0], 0, now)}${etaCell(buses[1], 1, now)}${etaCell(buses[2], 2, now)}
    </li>`;
  }

  if (sched) {
    const { state } = serviceStatus({
      now: nowDate,
      firstBus: sched.firstBus,
      lastBus: sched.lastBus,
      dayType: today,
    });
    if (state === 'ended') {
      const first = nextFirstBus(sched, nowDate, today);
      const text = first ? `Ended · first bus ${escape(first)}` : 'Ended';
      return `<li class="service sp-off">${serviceLink(serviceNo)}
        <div class="sp-svc-status">${text}</div>
      </li>`;
    }
    if (state === 'before-first') {
      // serviceStatus only answers before-first off a real first-bus time, so
      // fmtHHMM cannot come back null here.
      const first = fmtHHMM(sched.firstBus?.[today]);
      return `<li class="service sp-off">${serviceLink(serviceNo)}
        <div class="sp-svc-status">First bus ${escape(first)}</div>
      </li>`;
    }
  }

  return `<li class="service">${serviceLink(serviceNo)}
    ${etaCell(null, 0, now)}${etaCell(null, 1, now)}${etaCell(null, 2, now)}
  </li>`;
}

function arrivalsBody() {
  if (!arrivalsFresh) {
    return `<div class="skeleton" aria-hidden="true">
      <div class="sk-row"><span class="sk sk-no"></span><span class="sk sk-eta"></span></div>
      <div class="sk-row"><span class="sk sk-no"></span><span class="sk sk-eta"></span></div>
    </div>`;
  }
  if (liveServices === null) {
    return '<p class="card-msg">Timings unavailable — will retry.</p>';
  }
  // Nothing running at all — outside operating hours — is the board's own
  // sentence, whole-card; the per-service rows below are for the evening
  // shoulder, where some services have ended and others are still coming.
  if (liveServices.length === 0) {
    return '<p class="card-msg">No buses at this hour.</p>';
  }

  // One clock read for the whole card, like the board's, so no two rows can
  // disagree about the minute — or about what day it is.
  const now = Date.now();
  const nowDate = new Date(now);
  const today = dayTypeFor(nowDate);

  // The schedule's services are the rows, so a service that has ended for the
  // day still has a row saying so; a live service the schedule does not know
  // (the two feeds can drift for a day) is appended rather than dropped.
  const live = new Map(liveServices.map((svc) => [svc.serviceNo, svc]));
  const rows = [];
  for (const svc of data.services) {
    rows.push(serviceRow(svc.serviceNo, live.get(svc.serviceNo) ?? null, svc, nowDate, today, now));
    live.delete(svc.serviceNo);
  }
  for (const svc of live.values()) rows.push(serviceRow(svc.serviceNo, svc, null, nowDate, today, now));

  return `<div class="services-head" aria-hidden="true">
      <span>Bus</span><span>Next</span><span>Then</span><span>After</span>
    </div>
    <ul class="services">${rows.join('')}</ul>`;
}

function renderArrivals() {
  el.arrivals.innerHTML = `
    <p class="rt-sec">Next buses</p>
    <div class="card">${arrivalsBody()}</div>`;
}

// --- the schedule table --------------------------------------------------------

const DAY_TYPES = ['wd', 'sat', 'sun'];
const DAY_LABEL = { wd: 'Weekdays', sat: 'Saturday', sun: 'Sunday' };

function schedRows() {
  return data.services
    .map((svc) => {
      const first = fmtHHMM(svc.firstBus?.[dayType]);
      const last = fmtHHMM(svc.lastBus?.[dayType]);
      const peak = fmtFreq(svc.freq?.peak);
      const offpeak = fmtFreq(svc.freq?.offpeak);
      return `<li class="sp-sched-row">
        ${serviceLink(svc.serviceNo)}
        <span class="sp-time">${first ? escape(first) : '–'}</span>
        <span class="sp-time">${last ? escape(last) : '–'}</span>
        <span class="sp-freq">${peak ? escape(peak) : '–'}${
          // The headway itself is unbreakable, so a narrow cell wraps after
          // "off-peak" instead of orphaning the unit onto its own line.
          offpeak ? `<span class="sp-offpeak">off-peak <b>${escape(offpeak)}</b></span>` : ''
        }</span>
      </li>`;
    })
    .join('');
}

function renderSched() {
  if (data.services.length === 0) {
    el.sched.innerHTML = '';
    return;
  }

  const seg = DAY_TYPES.map(
    (type) =>
      `<button type="button" data-day="${type}" class="${type === dayType ? 'on' : ''}"
         aria-pressed="${type === dayType}">${DAY_LABEL[type]}</button>`,
  ).join('');

  el.sched.innerHTML = `
    <p class="rt-sec">Today at this stop</p>
    <div class="dir-toggle sp-seg" role="group" aria-label="Day of week">${seg}</div>
    <div class="card">
      <div class="sp-sched-head" aria-hidden="true">
        <span>Bus</span><span>First</span><span>Last</span><span>Every</span>
      </div>
      <ul class="services sp-sched-list">${schedRows()}</ul>
    </div>`;
}

/** The day control applied in place, so the tapped button keeps keyboard focus. */
function onDayTap(type) {
  if (!DAY_TYPES.includes(type) || type === dayType) return;
  dayType = type;
  for (const button of el.sched.querySelectorAll('[data-day]')) {
    const on = button.dataset.day === dayType;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  }
  const list = el.sched.querySelector('.sp-sched-list');
  if (list) list.innerHTML = schedRows();
}

// --- terminal states ---------------------------------------------------------------

/** The way back in when the URL's code is wrong: type the 5 digits off the pole. */
function codeEntry() {
  return `<form class="sp-code-entry" data-act="code-entry">
      <label class="visually-hidden" for="sp-code-input">Stop code</label>
      <input id="sp-code-input" type="text" inputmode="numeric" autocomplete="off"
             spellcheck="false" maxlength="5" pattern="[0-9]{5}" required
             placeholder="5-digit stop code" />
      <button type="submit" class="ghost">Go</button>
    </form>`;
}

function renderGuard(sentence) {
  document.title = 'no such stop · ezbus';
  el.plate.innerHTML = '';
  el.sched.innerHTML = '';
  el.arrivals.innerHTML = `
    <p class="rt-sec">No such stop</p>
    <div class="guard">${sentence} Check the 5-digit code on the stop's pole or on the board.
      ${codeEntry()}
      <div class="g-actions"><a href="/">← Back to board</a></div>
    </div>`;
}

/** The "no such stop" page — a real page with a way in, never a bare 404. */
function renderMissing() {
  mode = 'missing';
  renderGuard(`No stop with code ${escape(code)}.`);
}

/** A path that is not a stop code at all: same guard, no fetch spent on it. */
function renderBadCode() {
  mode = 'badcode';
  renderGuard("That's not a stop code.");
}

function renderFailed() {
  mode = 'failed';
  el.plate.innerHTML = '';
  el.sched.innerHTML = '';
  el.arrivals.innerHTML = `
    <div class="guard">Could not load this stop. Check your connection.
      <div class="g-actions"><button type="button" data-act="retry">Try again</button></div>
    </div>`;
}

// --- rendering ----------------------------------------------------------------

function renderAll() {
  renderPlate();
  renderArrivals();
  renderSched();
}

// --- wiring -------------------------------------------------------------------------

function onAction(event) {
  const act = event.target.closest('[data-act]');
  if (act) {
    switch (act.dataset.act) {
      case 'pin':
        togglePin();
        return;
      // No `await` may sit between this click and navigator.share — see the
      // note on onShare; this handler is synchronous the whole way down.
      case 'share':
        onShare(act);
        return;
      case 'retry':
        mode = 'loading';
        void loadStop();
        return;
    }
  }

  const day = event.target.closest('[data-day]');
  if (day) onDayTap(day.dataset.day);
}

el.plate.addEventListener('click', onAction);
el.arrivals.addEventListener('click', onAction);
el.sched.addEventListener('click', onAction);

// The guard's code entry. `pattern` + `required` let the browser refuse junk
// natively before this fires; the regex here is the same strict rule the
// parser applies, so nothing invalid can navigate.
document.addEventListener('submit', (event) => {
  const form = event.target.closest?.('[data-act="code-entry"]');
  if (!form) return;
  event.preventDefault();
  const value = form.querySelector('input')?.value.trim() ?? '';
  if (/^\d{5}$/.test(value)) location.href = `/stop/${value}`;
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshArrivals();
});

setInterval(() => void refreshArrivals(), REFRESH_MS);
setInterval(() => {
  if (mode === 'ready' && arrivalsFresh) renderArrivals();
}, TICK_MS);

// --- boot ------------------------------------------------------------------------------

if (!code) {
  renderBadCode();
} else {
  void loadStop();
}
