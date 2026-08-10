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

/** Consecutive trip-worthy failures that open the breaker. */
const TRIP_THRESHOLD = 5;

/** How long the breaker stays open when upstream names no deadline of its own. */
const OPEN_MS = 60_000;

/**
 * Ceiling on an upstream-supplied `Retry-After`. DataMall could otherwise wedge
 * the board for as long as it liked with one header.
 */
const MAX_OPEN_MS = 120_000;

/**
 * Global circuit breaker for the upstream path that uses it: five consecutive
 * failures open it for 60 s, then one probe decides whether it closes or waits
 * another 60 s.
 *
 * Global rather than per key, unlike `Backoff`, because it answers a different
 * question. `Backoff` asks "is this stop code failing"; the breaker asks "is
 * DataMall telling the account to stop", which is true of every stop at once —
 * a 429 is charged against the key, not the stop.
 *
 * It counts only what the caller passes it. Deciding which HTTP statuses mean
 * "stop" is the client's job; this class knows counts, deadlines and a clock.
 */
export class CircuitBreaker {
  #failures = 0;
  /** 0 while closed; otherwise the moment the next probe may be admitted. */
  #openUntil = 0;
  /** True from admitting a probe until that probe reports back. */
  #probing = false;
  readonly #now: () => number;

  constructor({ now = Date.now }: ClockOptions = {}) {
    this.#now = now;
  }

  /**
   * Admission decision, and the only mutating one: half-open admits exactly one
   * probe, so this claims the slot rather than merely reporting on it. Callers
   * that get `true` must report back through `recordSuccess`/`recordFailure`,
   * or a half-open breaker never closes.
   *
   * Being synchronous is what makes the single probe safe: the board fans out
   * five stops at once, and on one thread only one of the five can observe
   * `#probing` as false.
   */
  tryAcquire(): boolean {
    if (this.#openUntil === 0) return true;
    if (this.#openUntil > this.#now()) return false;
    if (this.#probing) return false;
    this.#probing = true;
    return true;
  }

  /**
   * Upstream answered. Closes the breaker if this was the probe, and resets the
   * consecutive count either way, so an isolated blip never accumulates towards
   * a trip.
   *
   * A success arriving while the breaker is open and unprobed is a request that
   * was already in flight when the trip happened. It is stale news and does not
   * cancel the wait — the deadline stands until a probe proves recovery.
   */
  recordSuccess(): void {
    if (this.#openUntil !== 0 && !this.#probing) return;
    this.#failures = 0;
    this.#openUntil = 0;
    this.#probing = false;
  }

  /**
   * A failure that means "upstream is refusing". `retryAfterMs` is upstream's
   * own deadline when it sent one; it replaces the 60 s default and is clamped
   * to 120 s. Anything absent, negative or not finite falls back to 60 s rather
   * than producing a NaN deadline that would never elapse.
   */
  recordFailure(retryAfterMs?: number): void {
    const openMs =
      retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.min(retryAfterMs, MAX_OPEN_MS)
        : OPEN_MS;

    if (this.#probing) {
      // The probe failed: wait again from now.
      this.#probing = false;
      this.#openUntil = this.#now() + openMs;
      return;
    }

    // Already tripped, and not the probe: another request that was in flight at
    // the trip. It cannot extend the window, or five concurrent stops failing
    // together would each push the deadline out. In practice these all land
    // within the 8 s upstream timeout, far inside the window.
    if (this.#openUntil !== 0) return;

    this.#failures += 1;
    if (this.#failures >= TRIP_THRESHOLD) {
      this.#failures = 0;
      this.#openUntil = this.#now() + openMs;
    }
  }

  /**
   * True from the trip until a probe closes it again — half-open included,
   * since recovery is unproven until the probe reports. This is what `/healthz`
   * shows, where "not yet known to be healthy" is the honest reading.
   */
  isOpen(): boolean {
    return this.#openUntil !== 0;
  }
}
