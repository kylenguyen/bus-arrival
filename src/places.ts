import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { Place } from './types.js';

/**
 * Resolves to `<repo>/data/` from `dist/places.js` and to `/app/data/` inside
 * the image — the same relative trick `express.static` uses for `public/`.
 */
export const PLACES_PATH = path.join(import.meta.dirname, '..', 'data', 'sg-places.json.gz');

const POSTAL = /^\d{6}$/;

// Singapore's bounding box, generous at the edges, matching tools/build-places.mjs.
const LAT_MIN = 1.15;
const LAT_MAX = 1.5;
const LON_MIN = 103.55;
const LON_MAX = 104.15;

/** Ten rows already scroll at 375 px, and the payload is on cellular. */
const DEFAULT_LIMIT = 10;
/** Longer than any Singapore address; a longer query is a paste or an attack. */
const MAX_QUERY = 64;
/**
 * Ceiling on rows one query may score. A query whose only indexed token is
 * `ROAD` would otherwise walk tens of thousands of rows on a 250m-CPU pod.
 * Posting lists are built leading-token-first, so what truncation drops is the
 * rows where the token sits mid-name — the ones the ladder ranks last anyway.
 */
const MAX_CANDIDATES = 2000;
/** Shortest token worth *indexing*: a single character matches a third of the
 *  file. Queries still verify their one-character tokens against the row. */
const MIN_TOKEN = 2;

/**
 * The artefact's own shape, private to this file: `Place` is what leaves it.
 * Same boundary discipline as `RawStop` in `lta.ts` — map at the edge, never
 * let a stored field name reach a caller.
 */
interface PlaceRecord {
  postal: string;
  building: string;
  block: string;
  road: string;
  lat: number;
  lon: number;
}

type Rejection = 'postal' | 'coord' | 'box';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** `NIL` is how the source spells absent. Whitespace is collapsed so tokens are clean. */
const field = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text === 'NIL' ? '' : text;
};

/**
 * D2's rules again, after `tools/build-places.mjs` already applied them. The
 * duplication is deliberate: the artefact is committed data that a human can
 * hand-edit, and "no row that leaves here carries an unusable coordinate" is
 * the invariant that lets the client commit a tapped row as the board's origin
 * without re-checking it. A record that fails is dropped, not repaired.
 */
const toRecord = (value: unknown): PlaceRecord | Rejection => {
  if (!isObject(value)) return 'postal';

  const raw = value['postal'];
  const postal = typeof raw === 'string' ? raw.trim() : '';
  if (!POSTAL.test(postal)) return 'postal';

  const lat = Number(value['lat']);
  const lon = Number(value['lon']);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'coord';
  // The box subsumes the 0,0 test the stop feed needs, and also catches a row
  // whose latitude and longitude were written the wrong way round.
  if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) return 'box';

  return {
    postal,
    building: field(value['building']),
    block: field(value['block']),
    road: field(value['road']),
    lat,
    lon,
  };
};

interface Decoded {
  records: PlaceRecord[];
  byPostal: Map<string, number>;
  generatedAt: string | null;
  dropped: { postal: number; coord: number; box: number; duplicate: number };
}

/** Gunzip, parse, validate. Throws on an artefact that is malformed as a whole;
 *  a record that is merely invalid is counted and dropped. */
const decode = (gzipped: Uint8Array): Decoded => {
  const parsed: unknown = JSON.parse(gunzipSync(gzipped).toString('utf8'));
  if (!isObject(parsed)) throw new Error('places artefact is not an object');

  const places: unknown = parsed['places'];
  if (!Array.isArray(places)) throw new Error('places artefact has no places array');
  const entries: unknown[] = places;

  const records: PlaceRecord[] = [];
  const byPostal = new Map<string, number>();
  const dropped = { postal: 0, coord: 0, box: 0, duplicate: 0 };

  for (const entry of entries) {
    const record = toRecord(entry);
    if (typeof record === 'string') {
      dropped[record] += 1;
      continue;
    }
    // First of a duplicated postal wins, matching the build tool's preference
    // for the record that carries a building name.
    if (byPostal.has(record.postal)) {
      dropped.duplicate += 1;
      continue;
    }
    byPostal.set(record.postal, records.length);
    records.push(record);
  }

  const generatedAt = parsed['generatedAt'];
  return {
    records,
    byPostal,
    generatedAt: typeof generatedAt === 'string' ? generatedAt : null,
    dropped,
  };
};

const toPlace = (record: PlaceRecord): Place => ({
  postal: record.postal,
  code: null,
  building: record.building,
  block: record.block,
  road: record.road,
  lat: record.lat,
  lon: record.lon,
});

const ALNUM = /[A-Z0-9]/;

/** `A-Z` or `0-9` on an already-uppercased string. Character codes, not a regex:
 *  indexing runs this over every character of 121k records, twice. */
const isAlnum = (code: number) => (code >= 65 && code <= 90) || (code >= 48 && code <= 57);

/**
 * Walks the tokens of an already-uppercased string, telling the caller which one
 * is the field's first. Hand-rolled rather than `split(/[^A-Z0-9]+/)` so that
 * indexing does not allocate an array per field per record.
 */
const eachToken = (text: string, fn: (token: string, first: boolean) => void): void => {
  let start = -1;
  let first = true;
  for (let i = 0; i <= text.length; i += 1) {
    if (i < text.length && isAlnum(text.charCodeAt(i))) {
      if (start === -1) start = i;
      continue;
    }
    if (start === -1) continue;
    if (i - start >= MIN_TOKEN) {
      fn(text.slice(start, i), first);
      first = false;
    }
    start = -1;
  }
};

/**
 * The distinct index tokens of one record: either the leading token of each
 * field, or everything else. Only `building` and `road` are indexed — a block
 * number is short, repeated thousands of times and worth nothing as a filter, so
 * it is matched against the stored string at verification time and rewarded with
 * a scoring bonus instead. The visible consequence is that `155` alone finds
 * nothing, which is the trade, not a bug.
 *
 * Split in two so the index can be built leading-token-first without holding a
 * token list for all 121k records at once; each pass asks for the half it needs.
 */
const recordTokens = (record: PlaceRecord, want: 'lead' | 'rest'): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  const fields = [record.building, record.road];

  for (const text of fields) {
    eachToken(text, (token, first) => {
      if (!first || seen.has(token)) return;
      seen.add(token);
      if (want === 'lead') out.push(token);
    });
  }
  if (want === 'lead') return out;

  for (const text of fields) {
    eachToken(text, (token) => {
      if (seen.has(token)) return;
      seen.add(token);
      out.push(token);
    });
  }
  return out;
};

/**
 * Query words that say nothing about which address is meant, dropped before the
 * conjunction is applied.
 *
 * `BLK` is the one that earns this. Singaporeans write "Blk 155", LTA's own stop
 * descriptions say "Blk 869A", and this app's chip and Recent list both render
 * `Blk {block}` — so it is on screen, in the user's own words, in front of the
 * box. But no stored field spells it: the block is `"155"`, not `"BLK 155"`.
 * Under D3's strict AND, every query carrying it could therefore only ever match
 * nothing, which is a dead end reached by typing back what the app just showed.
 *
 * Dropped from the *query* rather than relaxing the AND: relaxing it would let
 * any one wrong word through and would quietly widen every other query too. And
 * not an index change either — 124 building names carry `(BLK 6 …)` as a
 * parenthetical, and those records stay reachable by every other word in them.
 *
 * Keep this list to words the data structurally cannot contain. It is not a
 * place to paper over ranking; a word that appears in real names belongs in the
 * index, not here.
 */
const STOP_WORDS = new Set(['BLK', 'BLOCK']);

/**
 * The query's tokens, single characters included. The index skips those, but a
 * user who typed `ang mo kio ave 3` means avenue 3 and not avenue 10, so a short
 * token still has to be matched against the stored strings.
 */
const queryTokens = (query: string): string[] => {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i <= query.length; i += 1) {
    if (i < query.length && isAlnum(query.charCodeAt(i))) {
      if (start === -1) start = i;
      continue;
    }
    if (start === -1) continue;
    out.push(query.slice(start, i));
    start = -1;
  }
  return out;
};

/**
 * Does `text` hold `token` as a word? Boundaries are "not alphanumeric" rather
 * than a space, which is what makes `GEORGE` find `ST. GEORGE'S ROAD` — the
 * apostrophe and the full stop are boundaries too.
 */
const wordMatch = (text: string, token: string, allowPrefix: boolean): boolean => {
  for (let from = 0; ; ) {
    const at = text.indexOf(token, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : text.charAt(at - 1);
    const after = text.charAt(at + token.length);
    if (!ALNUM.test(before) && (allowPrefix || !ALNUM.test(after))) return true;
    from = at + 1;
  }
};

/**
 * Every query token must match, in any order. Only the **last** token may match
 * as a prefix — it is the one still being typed. An earlier token the user has
 * finished typing is a whole word, which is why `toa pay` matches Toa Payoh and
 * `pay toa` does not.
 *
 * The haystack carries the block as well as the indexed fields, so a query that
 * names a block number is filtered by it even though it cannot be generated
 * from it.
 */
const matchesAll = (record: PlaceRecord, tokens: string[]): boolean => {
  const text = `${record.building} ${record.block} ${record.road}`;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (!wordMatch(text, token, i === tokens.length - 1)) return false;
  }
  return true;
};

/** D3's ladder. A row only reaches here having matched every token, hence the floor of 20. */
const scoreOf = (record: PlaceRecord, query: string, tokens: string[]): number => {
  const blockRoad = record.block && record.road ? `${record.block} ${record.road}` : record.road;

  let score = 20;
  if (record.building === query) score = 90;
  else if (record.building.startsWith(query)) score = 80;
  else if (record.road === query || blockRoad === query) score = 70;
  else if (record.building.includes(query)) score = 60;
  else if (record.road.startsWith(query) || blockRoad.startsWith(query)) score = 50;
  else if (record.road.includes(query)) score = 40;

  // What puts Blk 155 above its neighbours for "155 toa payoh": a query that
  // skips the middle of the road name prefix-matches nothing, so without this
  // the block the user actually named would rank on nothing at all.
  if (record.block !== '' && tokens.includes(record.block)) score += 15;
  return score;
};

const normaliseQuery = (query: string): string =>
  query.toUpperCase().replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);

/**
 * 121k Singapore addresses in memory, searched through an inverted index over
 * building and road names.
 *
 * The index is what makes this safe to put in front of arrivals: a linear scan
 * of the same rows costs 3–18 ms, and Node is single-threaded, so on a 250m-CPU
 * pod one keystroke would sit in front of every board request. The index answers
 * in well under a millisecond for about +9 MB of heap.
 *
 * **There is no refresh timer and no `stop()`**, deliberately, where `StopIndex`
 * has both: DataMall's stop list changes under a running pod, whereas this file
 * is baked into the image and served off a `readOnlyRootFilesystem`. Nothing can
 * change these bytes short of a new image, so a timer would re-read the same
 * file forever. If the artefact ever moves to a mounted volume, that reasoning
 * expires with it.
 */
export class PlaceIndex {
  #records: PlaceRecord[] = [];
  #byPostal = new Map<string, number>();
  #tokens = new Map<string, number[]>();
  #generatedAt: string | null = null;

  get size(): number {
    return this.#records.length;
  }

  /** How stale the *data* is. A `loadedAt` would only ever say "boot". */
  get generatedAt(): string | null {
    return this.#generatedAt;
  }

  /**
   * Synchronous on purpose: one code path, no half-loaded state and no promise
   * anyone can forget to await. It blocks the loop for ~200 ms, called after
   * `listen()`, which the readiness probe's initial delay covers.
   *
   * Swallows and logs like `StopIndex.reload()`, leaving `size` at 0 so callers
   * need no `try`. Nothing on this path ever logs a query.
   */
  load(filePath: string = PLACES_PATH): void {
    const started = Date.now();
    try {
      this.loadBuffer(readFileSync(filePath));
      console.log(
        `loaded ${this.size} places (generated ${this.#generatedAt ?? 'unknown'}) in ${
          Date.now() - started
        } ms`,
      );
    } catch (err) {
      console.error('place index load failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * The test seam, and the only place the artefact is decoded. Throws on an
   * artefact that is malformed as a whole; a record that is merely invalid is
   * counted and dropped.
   */
  loadBuffer(gzipped: Uint8Array): void {
    // Decoding sits in its own function so the 11 MB document and its 121k
    // parsed objects are unreachable before the index below starts allocating:
    // V8 then collects them under that pressure. Inline, they stay live to the
    // end of the method and the pod's resident heap peaks ~25 MB higher.
    const { records, byPostal, generatedAt, dropped } = decode(gzipped);

    const tokens = new Map<string, number[]>();
    const post = (token: string, at: number) => {
      const postings = tokens.get(token);
      if (postings) postings.push(at);
      else tokens.set(token, [at]);
    };

    // Two passes rather than one, so every posting list holds the rows where the
    // token leads a name before the rows where it sits in the middle of one.
    // That is what makes MAX_CANDIDATES safe to truncate against.
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      if (!record) continue;
      for (const token of recordTokens(record, 'lead')) post(token, i);
    }
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      if (!record) continue;
      for (const token of recordTokens(record, 'rest')) post(token, i);
    }

    // Assigned only once everything above has succeeded: a throw leaves the
    // previous index — on a cold start, an empty one — rather than half of a new.
    this.#records = records;
    this.#byPostal = byPostal;
    this.#tokens = tokens;
    this.#generatedAt = generatedAt;

    const total = dropped.postal + dropped.coord + dropped.box + dropped.duplicate;
    if (total > 0) {
      console.warn(
        `places artefact: dropped ${total} records (postal ${dropped.postal}, coord ${dropped.coord}, box ${dropped.box}, duplicate ${dropped.duplicate})`,
      );
    }
  }

  get(postal: string): Place | null {
    const at = this.#byPostal.get(postal.trim());
    if (at === undefined) return null;
    const record = this.#records[at];
    return record ? toPlace(record) : null;
  }

  search(query: string, limit: number = DEFAULT_LIMIT): Place[] {
    const q = normaliseQuery(query);
    if (q.length < 2) return [];

    // Six digits is a postal code and nothing else, so it never falls through to
    // the token search: no address is named "310155", and an empty result is
    // what lets the client say which postal code it could not find.
    if (POSTAL.test(q)) {
      const hit = this.get(q);
      return hit ? [hit] : [];
    }

    // A query of nothing but stop words leaves no tokens and so matches nothing,
    // which is the right answer: "blk" names no address.
    const tokens = queryTokens(q).filter((token) => !STOP_WORDS.has(token));
    if (tokens.length === 0) return [];

    const candidates = this.#candidates(tokens);
    if (!candidates) return [];

    const scored: Array<{ record: PlaceRecord; score: number }> = [];
    for (const at of candidates) {
      const record = this.#records[at];
      if (!record) continue;
      if (!matchesAll(record, tokens)) continue;
      scored.push({ record, score: scoreOf(record, q, tokens) });
    }

    return scored
      .sort((a, b) => b.score - a.score || a.record.postal.localeCompare(b.record.postal))
      .slice(0, limit)
      .map((entry) => toPlace(entry.record));
  }

  /**
   * The rows worth scoring: the shortest posting list among the query's tokens,
   * truncated. A token with no list is not a dead end — block numbers are not
   * indexed — it simply cannot generate candidates, and `matchesAll` still has
   * to be satisfied by it.
   */
  #candidates(tokens: string[]): number[] | null {
    let best: number[] | null = null;
    for (const token of tokens) {
      const list = this.#tokens.get(token);
      if (!list || list.length === 0) continue;
      if (!best || list.length < best.length) best = list;
    }

    const last = tokens[tokens.length - 1];
    // Only the last token is treated as a prefix; see `matchesAll`.
    if (last !== undefined && last.length >= MIN_TOKEN && !this.#tokens.has(last)) {
      const prefix = this.#prefixPostings(last);
      // A prefix union that hit the ceiling is an arbitrary slice of Singapore,
      // so it only generates candidates when no finished word in the query can:
      // `ang mo kio ave` must be generated from `KIO`, not from every road whose
      // name starts with AVE.
      const usable = prefix.length > 0 && prefix.length < MAX_CANDIDATES;
      if (!best || (usable && prefix.length < best.length)) best = prefix;
    }

    if (!best) return null;
    return best.length > MAX_CANDIDATES ? best.slice(0, MAX_CANDIDATES) : best;
  }

  /** The union of every posting list whose token starts with a half-typed word. */
  #prefixPostings(prefix: string): number[] {
    const seen = new Set<number>();
    for (const [token, postings] of this.#tokens) {
      if (!token.startsWith(prefix)) continue;
      for (const at of postings) {
        seen.add(at);
        if (seen.size >= MAX_CANDIDATES) return [...seen];
      }
    }
    return [...seen];
  }
}
