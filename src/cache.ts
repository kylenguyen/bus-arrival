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

  constructor(private readonly ttlMs: number) {}

  async fetch(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.#entries.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const pending = this.#inflight.get(key);
    if (pending) return pending;

    const request = loader()
      .then((value) => {
        this.#entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
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
