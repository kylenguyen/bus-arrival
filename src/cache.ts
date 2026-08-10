import { Backoff } from './limiter.js';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * TTL cache with three properties that matter here:
 *
 * - in-flight de-duplication: ten people opening the same stop at once
 *   produce one upstream call, not ten.
 * - stale-on-error: if DataMall hiccups we serve the last known arrivals
 *   rather than an error page. Slightly wrong beats blank.
 * - backoff on failure: a failing key is not retried until its `Backoff`
 *   window elapses, so a four-hour outage costs a few hundred upstream calls
 *   instead of four hours at full rate. Without it the `.catch` below served
 *   the stale value but left the entry expired, and the very next request went
 *   upstream again.
 *
 * All three are load-bearing. The cache stays generic: it knows a `Backoff`
 * and a clock, nothing about HTTP, DataMall or what a key stands for.
 */
export class TtlCache<T> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #inflight = new Map<string, Promise<T>>();
  /** Last failure per key, replayed to callers that have nothing stale to read. */
  readonly #errors = new Map<string, unknown>();

  /**
   * `now` is injectable so the TTL can be tested without sleeping; production
   * call sites pass one argument and get `Date.now` plus a `Backoff` on the
   * same clock. The backoff belongs to this cache — the invariant in `fetch`
   * assumes only these entries record failures against it, so do not share one
   * between caches.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly backoff: Backoff = new Backoff({ now }),
  ) {}

  async fetch(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.#entries.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const pending = this.#inflight.get(key);
    if (pending) return pending;

    // Inside a backoff window, so do not open a socket. Only a key that has
    // never loaded successfully gets here: the re-stamp below always expires a
    // cached entry no earlier than the window it opened, so a key with a value
    // is still fresh above and never reaches this line. Serving stale is that
    // one mechanism's job, and duplicating it here would hide a re-stamp that
    // had drifted. The caller gets the failure back; upstream gets nothing.
    if (this.backoff.isBlocked(key)) {
      throw this.#errors.get(key) ?? new Error(`no cached value for ${key}`);
    }

    const request = loader()
      .then((value) => {
        // Any resolved value is a success, empty ones included: `[]` is "no
        // buses are running", which is what a healthy DataMall answers at
        // 01:30. It must clear the backoff, not extend it.
        this.backoff.recordSuccess(key);
        this.#errors.delete(key);
        this.#entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
        return value;
      })
      .catch((err: unknown) => {
        this.#errors.set(key, err);
        // Re-stamp the stale entry so it is served without a fresh upstream
        // call, and expire it exactly when the backoff window does rather than
        // after some separate "short" TTL. One deadline means the two
        // mechanisms agree: the first request after the window is the one that
        // retries, and nothing in between can slip past either of them.
        const windowMs = this.backoff.recordFailure(key);
        if (cached) {
          this.#entries.set(key, { value: cached.value, expiresAt: this.now() + windowMs });
          return cached.value;
        }
        throw err;
      })
      .finally(() => {
        this.#inflight.delete(key);
      });

    this.#inflight.set(key, request);
    return request;
  }
}
