interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * TTL cache with two properties that matter here:
 *
 * - in-flight de-duplication: ten people opening the same stop at once
 *   produce one upstream call, not ten.
 * - stale-on-error: if DataMall hiccups we serve the last known arrivals
 *   rather than an error page. Slightly wrong beats blank.
 */
export class TtlCache<T> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #inflight = new Map<string, Promise<T>>();

  /**
   * `now` is injectable so the TTL can be tested without sleeping; production
   * call sites pass one argument and get `Date.now`.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async fetch(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.#entries.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const pending = this.#inflight.get(key);
    if (pending) return pending;

    const request = loader()
      .then((value) => {
        this.#entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
        return value;
      })
      .catch((err: unknown) => {
        if (cached) return cached.value;
        throw err;
      })
      .finally(() => {
        this.#inflight.delete(key);
      });

    this.#inflight.set(key, request);
    return request;
  }
}
