#!/usr/bin/env node
/**
 * End-to-end crawl verification for the SEO surface (T8 of
 * docs/seo-implementation-plan.md). Points at a running server and checks the
 * whole discovery story a search engine would follow:
 *
 *   1. /robots.txt names a sitemap; the sitemap parses and its URL count is
 *      exactly 2 + healthz.stops + healthz.routes.
 *   2. Every sitemap URL serves 200; every /stop/ page carries an <h1> and
 *      parseable JSON-LD; every /bus/ page carries at least one <ol> and
 *      parseable JSON-LD; every page carries exactly one canonical tag whose
 *      href is its own canonical URL.
 *   3. A BFS over internal hrefs from `/` reaches every sitemap URL within
 *      depth 3 (home → /buses → /bus/N → /stop/C).
 *
 * No dependencies beyond `node:` builtins, on purpose: it has to run from a
 * clean checkout without touching package.json.
 *
 *   node dist/index.js &                       # mock mode, or the stub pair
 *   node tools/crawl-check.mjs                 # default http://localhost:8080
 *   node tools/crawl-check.mjs http://localhost:8080
 *   BASE_URL=http://localhost:8080 node tools/crawl-check.mjs
 *
 * Waits for /healthz to report stops > 0 && routes > 0 before starting (the
 * route feed loads after the port binds, and /sitemap.xml is deliberately 503
 * until both indexes are in). Exits 0 printing `crawl-check: N pages OK` plus
 * a depth histogram, or non-zero listing every failure.
 */

const BASE = (process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');

/** The public origin every canonical/sitemap URL is written against. */
const CANONICAL_ORIGIN = 'https://ezbus.sg';

const READY_TIMEOUT_MS = 30_000;
const FETCH_CONCURRENCY = 10;

/** @type {string[]} */
const failures = [];
const fail = (message) => failures.push(message);

/** Canonical-origin URL → local pathname ('https://ezbus.sg/stop/1' → '/stop/1'). */
const toPath = (url) => {
  if (url === CANONICAL_ORIGIN || url === `${CANONICAL_ORIGIN}/`) return '/';
  if (!url.startsWith(`${CANONICAL_ORIGIN}/`)) return null;
  return url.slice(CANONICAL_ORIGIN.length);
};

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.text() };
};

/** Poll /healthz until both indexes have loaded. Readiness for the *crawl* is
 * stops and routes — /healthz's own `ok` also gates on the address index,
 * which the crawl does not touch. */
const waitReady = async () => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      const body = await res.json();
      if (body.stops > 0 && body.routes > 0) return body;
    } catch {
      // Server not up yet; keep polling.
    }
    if (Date.now() > deadline) throw new Error(`healthz never reported stops>0 && routes>0 within ${READY_TIMEOUT_MS}ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

/** All parseable JSON-LD payloads in the page; a parse failure records a failure. */
const jsonLdBlocks = (path, html) => {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  const parsed = [];
  for (const [, raw] of blocks) {
    try {
      parsed.push(JSON.parse(raw));
    } catch (err) {
      fail(`${path}: JSON-LD does not parse (${err.message})`);
    }
  }
  return { count: blocks.length, parsed };
};

/** Every canonical href on the page, however formatted the tag is. */
const canonicals = (html) =>
  [...html.matchAll(/<link\s+rel="canonical"\s+href="([^"]*)"[^>]*>/g)].map((m) => m[1]);

/** Internal page-like hrefs ('/', '/buses', '/bus/N', '/stop/C'), query/hash stripped. */
const internalLinks = (html) => {
  const seen = new Set();
  for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
    if (!href.startsWith('/') || href.startsWith('//')) continue;
    const path = href.split(/[?#]/)[0];
    if (path === '/' || path === '/buses' || path.startsWith('/bus/') || path.startsWith('/stop/')) {
      seen.add(path);
    }
  }
  return [...seen];
};

/** Run `worker` over `items` with bounded concurrency, preserving nothing. */
const eachLimit = async (items, limit, worker) => {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
};

// --- 0. Readiness ----------------------------------------------------------

const health = await waitReady();
console.log(`ready: stops=${health.stops} routes=${health.routes} (${BASE})`);

// --- 1. robots.txt → sitemap -----------------------------------------------

const robots = await get('/robots.txt');
if (robots.status !== 200) fail(`/robots.txt: expected 200, got ${robots.status}`);
const sitemapLine = robots.body.match(/^Sitemap:\s*(\S+)/m);
if (!sitemapLine) fail('/robots.txt: no Sitemap: line');

// The robots line names the public origin; rewrite it to the server under test.
const sitemapDeclared = sitemapLine ? sitemapLine[1] : `${CANONICAL_ORIGIN}/sitemap.xml`;
const sitemapPath = toPath(sitemapDeclared);
if (sitemapPath === null) fail(`/robots.txt: sitemap URL ${sitemapDeclared} is not on ${CANONICAL_ORIGIN}`);

const sitemap = await get(sitemapPath ?? '/sitemap.xml');
if (sitemap.status !== 200) fail(`${sitemapPath}: expected 200, got ${sitemap.status}`);

const locs = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const expectedCount = 2 + health.stops + health.routes;
if (locs.length !== expectedCount) {
  fail(`sitemap: ${locs.length} URLs, expected 2 + ${health.stops} stops + ${health.routes} routes = ${expectedCount}`);
}

/** @type {Map<string, string>} local pathname → canonical URL, from the sitemap. */
const pages = new Map();
for (const loc of locs) {
  const path = toPath(loc);
  if (path === null) fail(`sitemap: <loc> ${loc} is not on ${CANONICAL_ORIGIN}`);
  else pages.set(path, loc === CANONICAL_ORIGIN ? `${CANONICAL_ORIGIN}/` : loc);
}

// --- 2. Every sitemap URL: 200, canonical, h1/ol, JSON-LD ------------------

let fetched = 0;
await eachLimit([...pages.entries()], FETCH_CONCURRENCY, async ([path, canonicalUrl]) => {
  const page = await get(path);
  if (page.status !== 200) {
    fail(`${path}: expected 200, got ${page.status}`);
    return;
  }
  fetched += 1;

  const tags = canonicals(page.body);
  if (tags.length !== 1) fail(`${path}: expected exactly 1 canonical tag, found ${tags.length}`);
  else if (tags[0] !== canonicalUrl) fail(`${path}: canonical is ${tags[0]}, expected ${canonicalUrl}`);

  if (path.startsWith('/stop/')) {
    if (!/<h1[\s>]/.test(page.body)) fail(`${path}: no <h1>`);
    const { count } = jsonLdBlocks(path, page.body);
    if (count === 0) fail(`${path}: no JSON-LD block`);
  } else if (path.startsWith('/bus/')) {
    if (!/<ol[\s>]/.test(page.body)) fail(`${path}: no <ol>`);
    const { count } = jsonLdBlocks(path, page.body);
    if (count === 0) fail(`${path}: no JSON-LD block`);
  }
});

// --- 3. BFS from / — every sitemap URL within depth 3 ----------------------

/** @type {Map<string, number>} pathname → depth first reached. */
const reached = new Map([['/', 0]]);
let frontier = ['/'];
for (let depth = 0; depth < 3 && frontier.length > 0; depth += 1) {
  /** @type {string[]} */
  const nextFrontier = [];
  await eachLimit(frontier, FETCH_CONCURRENCY, async (path) => {
    const page = await get(path);
    if (page.status !== 200) {
      fail(`BFS ${path} (depth ${depth}): expected 200, got ${page.status}`);
      return;
    }
    for (const link of internalLinks(page.body)) {
      if (!reached.has(link)) {
        reached.set(link, depth + 1);
        nextFrontier.push(link);
      }
    }
  });
  frontier = nextFrontier;
}

const histogram = new Map();
for (const path of pages.keys()) {
  const depth = reached.get(path);
  if (depth === undefined) fail(`unreachable within depth 3 of /: ${path}`);
  else histogram.set(depth, (histogram.get(depth) ?? 0) + 1);
}

// --- Report -----------------------------------------------------------------

if (failures.length > 0) {
  console.error(`crawl-check: ${failures.length} failure(s)`);
  for (const message of failures) console.error(`  FAIL ${message}`);
  process.exit(1);
}

console.log(`crawl-check: ${fetched} pages OK`);
for (const depth of [...histogram.keys()].sort()) {
  console.log(`  depth ${depth}: ${histogram.get(depth)} page(s)`);
}
