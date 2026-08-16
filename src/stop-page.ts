import type { BusStop, NearbyStop, StopService } from './types.js';

/**
 * The stop page's server-rendered static body — everything stable about a stop
 * (name, road, schedule, neighbours, structured data) rendered to HTML at
 * request time so a crawler's fetch of /stop/:code is a complete page, not a
 * stencil. Live arrivals are deliberately absent: they would be stale lies in
 * any cache, and the board stays 100% client-rendered.
 *
 * Everything here is a pure function — hand-written records in, HTML string
 * out — so the tests can feed fixtures without the server, the same bargain
 * `buildRoutes` strikes in routes.ts.
 *
 * The three *_TARGET constants are the body-region swap anchors, verbatim from
 * public/stop.html — the same exact-string whole-region pattern as the head-tag
 * constants in index.ts: the shell served unreplaced (unknown code, or
 * /stop.html via express.static) is already valid, sensibly generic HTML. Edit
 * a target in the shell and its constant here in the same commit;
 * stop-page.test.ts pins the pairing.
 */

/** Escapes text bound for HTML — attribute values included, hence the quotes.
 *  Shared with index.ts's meta injection (it imports this one). */
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  );

/** The 0,0 "unknown coordinate" a handful of real stops carry — the same test
 *  stops.ts applies privately. Gates the nearby block and the JSON-LD geo:
 *  neighbours of Null Island and a geo pointing at the Gulf of Guinea are both
 *  worse than omission. */
export const hasUsableCoord = (stop: Pick<BusStop, 'lat' | 'lon'>): boolean =>
  Number.isFinite(stop.lat) && Number.isFinite(stop.lon) && (stop.lat !== 0 || stop.lon !== 0);

// --- the swap targets, verbatim from public/stop.html ------------------------

/** The plate's skeleton — today's wait state, kept for unknown codes. */
export const STOP_PLATE_TARGET =
  '<div id="sp-plate"><div class="card sp-plate skeleton" aria-hidden="true"><div class="card-head"><div class="card-title"><span class="sk sk-code"></span><span class="sk sk-name"></span><span class="sk sk-sub"></span></div></div></div></div>';

/** Empty in the shell, exactly as the client expects to find it. */
export const STOP_SCHED_TARGET = '<section id="sp-sched" aria-label="Today at this stop"></section>';

/** The generic invite to the board — the no-JS sentence for a shell served
 *  unreplaced. Known stops swap it for the nearby-stops block plus JSON-LD. */
export const STOP_NEARBY_TARGET =
  '<section id="sp-nearby"><p class="card-msg">Looking for live bus arrival times? <a href="/">Open the ezbus board</a> to see every stop near you.</p></section>';

// --- display formatting -------------------------------------------------------

/** DataMall HHMM: hours 00-23, minutes 00-59 — the same rule the client's
 *  fmtHHMM applies, so '' and '-' render as the en dash, never as a time. */
const HHMM_RE = /^([01]\d|2[0-3])([0-5]\d)$/;

const fmtHHMM = (hhmm: string): string | null => {
  const match = HHMM_RE.exec(hhmm.trim());
  return match ? `${match[1]}:${match[2]}` : null;
};

/** One day-type's cell: "05:40 – 23:11", or an en dash when no data. */
const daySpan = (service: StopService, day: 'wd' | 'sat' | 'sun'): string => {
  const first = fmtHHMM(service.firstBus[day]);
  const last = fmtHHMM(service.lastBus[day]);
  if (!first && !last) return '–';
  return `${first ?? '–'} – ${last ?? '–'}`;
};

// --- the plate ----------------------------------------------------------------

/**
 * The flag plate, server-rendered — the exact markup stop.js's renderPlate
 * builds (minus the distance chip and pin state, which only the client can
 * know), with the title block as the page's real `<h1>`. **The two must stay
 * in step**: this is the plate the reader sees at first paint, and the client's
 * rewrite on /api/stop landing must be pixel-identical or hydration flashes.
 * Edit this and renderPlate in public/stop.js together.
 *
 * The stencilled code is aria-hidden and restated in the visually-hidden span,
 * so the heading reads as one clean string — "Blk 101 (10001), Demo Ave 1" —
 * to a screen reader and to anything extracting text, while the visible plate
 * keeps the code-leads layout the style guide mandates.
 */
export const buildStopPlate = (
  stop: BusStop,
  opposite: Pick<BusStop, 'code' | 'description'> | null,
): string => {
  const code = escapeHtml(stop.code);
  const name = escapeHtml(stop.description);
  const road = escapeHtml(stop.roadName);
  const flip = opposite
    ? `<a class="sp-act" href="/stop/${escapeHtml(opposite.code)}">⇄ Opposite · ${escapeHtml(opposite.description)}</a>`
    : '';
  return (
    `<div id="sp-plate"><div class="card sp-plate">` +
    `<div class="card-head">` +
    `<h1 class="card-title">` +
    `<span class="meta-code" aria-hidden="true">${code}</span>` +
    `<span class="card-name">${name}<span class="visually-hidden"> (${code})${stop.roadName ? ', ' : ''}</span></span>` +
    `<span class="card-sub">${stop.roadName ? `<span class="meta-where">${road}</span>` : ''}</span>` +
    `</h1>` +
    `<button class="pin" type="button" data-act="pin" aria-pressed="false" aria-label="Pin ${name}" title="Keep this stop at the top">☆</button>` +
    `</div>` +
    `<div class="sp-acts"><button type="button" class="sp-act" data-act="share">Share</button>${flip}</div>` +
    `</div></div>`
  );
};

// --- the schedule table ---------------------------------------------------------

/**
 * The static first/last-bus table: every service calling here, all three
 * day-types at once — the whole schedule in one crawlable read, where the
 * client's interactive version shows one day with a toggle. It is rendered
 * into #sp-sched, so the client's own renderSched replaces it wholesale as
 * soon as /api/stop lands; with no services (or a cold route index) the
 * section stays as empty as the shell's.
 */
export const buildStopSched = (services: StopService[]): string => {
  if (services.length === 0) return STOP_SCHED_TARGET;
  const rows = services
    .map((service) => {
      const no = escapeHtml(service.serviceNo);
      return (
        `<tr><th scope="row"><a class="service-no" href="/bus/${no}">${no}</a></th>` +
        `<td>${daySpan(service, 'wd')}</td>` +
        `<td>${daySpan(service, 'sat')}</td>` +
        `<td>${daySpan(service, 'sun')}</td></tr>`
      );
    })
    .join('');
  return (
    `<section id="sp-sched" aria-label="Today at this stop">` +
    `<p class="rt-sec">First &amp; last bus</p>` +
    `<div class="card"><table class="sp-week">` +
    `<caption class="visually-hidden">First and last bus at this stop, by day of week</caption>` +
    `<thead><tr><th scope="col">Bus</th><th scope="col">Weekdays</th><th scope="col">Saturday</th><th scope="col">Sunday</th></tr></thead>` +
    `<tbody>${rows}</tbody>` +
    `</table></div></section>`
  );
};

// --- nearby stops ----------------------------------------------------------------

/**
 * The neighbour links — the stop-to-stop edges of the crawl graph, and a
 * genuinely useful block for a commuter (the next kerb over may have the
 * better bus). The caller passes the list already minus the stop itself, and
 * empty for a 0,0 coordinate; empty renders a bare section so the client's
 * page carries no dangling heading.
 */
export const buildStopNearby = (nearby: NearbyStop[]): string => {
  if (nearby.length === 0) return '<section id="sp-nearby"></section>';
  const rows = nearby
    .map(
      (stop) =>
        `<li><a href="/stop/${escapeHtml(stop.code)}">` +
        `<span class="nb-name">${escapeHtml(stop.description)}</span>` +
        `<span class="nb-sub">${escapeHtml(stop.roadName)}${stop.roadName ? ' · ' : ''}${Math.round(stop.distanceM)} m</span>` +
        `</a></li>`,
    )
    .join('');
  return (
    `<section id="sp-nearby" aria-label="Nearby stops">` +
    `<p class="rt-sec">Nearby stops</p>` +
    `<div class="card"><ul class="sp-nearby">${rows}</ul></div>` +
    `</section>`
  );
};

// --- structured data ----------------------------------------------------------------

/**
 * JSON-LD: a BusStop and the Home → stop BreadcrumbList, built as objects and
 * serialised with JSON.stringify — never string-concatenated — then every `<`
 * escaped to the JSON escape (backslash-u003c), which neutralises a `</script` smuggled through a stop
 * description while leaving the script body parseable JSON (an `&lt;` would
 * not). `geo` is omitted for the 0,0 stops rather than placing them in the
 * Gulf of Guinea.
 */
export const buildStopJsonLd = (stop: BusStop): string => {
  const url = `https://ezbus.sg/stop/${stop.code}`;
  const busStop: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'BusStop',
    name: stop.description,
    identifier: stop.code,
    url,
    address: {
      '@type': 'PostalAddress',
      ...(stop.roadName ? { streetAddress: stop.roadName } : {}),
      addressLocality: 'Singapore',
      addressCountry: 'SG',
    },
  };
  if (hasUsableCoord(stop)) {
    busStop.geo = { '@type': 'GeoCoordinates', latitude: stop.lat, longitude: stop.lon };
  }
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'ezbus', item: 'https://ezbus.sg/' },
      { '@type': 'ListItem', position: 2, name: `${stop.description} (${stop.code})`, item: url },
    ],
  };
  const json = JSON.stringify([busStop, breadcrumb]).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
};
