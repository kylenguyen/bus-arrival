/**
 * Rate-limiting state machines shared by the upstream paths.
 *
 * They live apart from the code that uses them because both are pure state plus
 * a clock: no HTTP, no DataMall, no knowledge of what a "key" means. That is
 * what makes them testable without sleeping, and it keeps `TtlCache` a generic
 * TTL cache that merely composes one.
 *
 * `now` is injectable everywhere here, matching `TtlCache` and `RollingCounter`.
 */

interface ClockOptions {
  /** Defaults to `Date.now`; tests pass a hand-driven clock instead. */
  now?: () => number;
}

/** First window a failure opens. */
const BASE_MS = 2_000;

/**
 * Ceiling on the window. Long enough that a four-hour outage costs a couple of
 * hundred calls rather than tens of thousands, short enough that recovery is
 * noticed within a minute.
 */
const MAX_MS = 60_000;

/**
 * Per-key exponential backoff: 2 s, 4 s, 8 s, 16 s, 32 s, 60 s, 60 s …, reset
 * to 2 s by the first success.
 *
 * Per key rather than global because one stop failing says nothing about the
 * others — DataMall answers per stop code, and a whole board must not be held
 * back by one bad entry.
 */
export class Backoff {
  readonly #windows = new Map<string, { ms: number; until: number }>();
  readonly #now: () => number;

  constructor({ now = Date.now }: ClockOptions = {}) {
    this.#now = now;
  }

  /**
   * Records a consecutive failure and returns the length of the window it
   * opens, which the caller needs in order to expire anything it serves in the
   * meantime on the same deadline.
   */
  recordFailure(key: string): number {
    const current = this.#windows.get(key);
    const ms = current === undefined ? BASE_MS : Math.min(current.ms * 2, MAX_MS);
    this.#windows.set(key, { ms, until: this.#now() + ms });
    return ms;
  }

  /** Forgets the key entirely, so the next failure starts again at 2 s. */
  recordSuccess(key: string): void {
    this.#windows.delete(key);
  }

  /** True while the key is inside a window, i.e. must not be retried yet. */
  isBlocked(key: string): boolean {
    const window = this.#windows.get(key);
    return window !== undefined && window.until > this.#now();
  }

  /**
   * Length of the window the last failure opened, 0 for a key that has not
   * failed. The window is deliberately still readable after it has elapsed:
   * failures are consecutive, and the doubling has to survive the gap between
   * one window closing and the next attempt failing.
   */
  windowMs(key: string): number {
    return this.#windows.get(key)?.ms ?? 0;
  }
}
