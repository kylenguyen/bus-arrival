import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Backoff, CircuitBreaker } from './limiter.js';

/** Hand-driven clock, same convention as `cache.test.ts`: no test may sleep. */
const clock = (start = 1_000_000) => {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe('Backoff', () => {
  it('doubles from 2 s and caps at 60 s', () => {
    const time = clock();
    const backoff = new Backoff({ now: time.now });

    const windows = [];
    for (let i = 0; i < 7; i += 1) {
      windows.push(backoff.recordFailure('10001'));
      time.advance(windows[i] ?? 0); // Let each window elapse before failing again.
    }

    assert.deepEqual(windows, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });

  it('reports the current window length as well as returning it', () => {
    const time = clock();
    const backoff = new Backoff({ now: time.now });

    assert.equal(backoff.windowMs('10001'), 0);
    backoff.recordFailure('10001');
    assert.equal(backoff.windowMs('10001'), 2_000);
    backoff.recordFailure('10001');
    assert.equal(backoff.windowMs('10001'), 4_000);
  });

  it('blocks for the length of the window and no longer', () => {
    const time = clock();
    const backoff = new Backoff({ now: time.now });

    assert.equal(backoff.isBlocked('10001'), false);
    backoff.recordFailure('10001');

    assert.equal(backoff.isBlocked('10001'), true);
    time.advance(1_999);
    assert.equal(backoff.isBlocked('10001'), true);
    time.advance(1); // The window is exclusive: elapsed means retryable.
    assert.equal(backoff.isBlocked('10001'), false);
  });

  it('resets to 2 s on the first success', () => {
    const time = clock();
    const backoff = new Backoff({ now: time.now });

    for (const expected of [2_000, 4_000, 8_000]) {
      assert.equal(backoff.recordFailure('10001'), expected);
      time.advance(expected);
    }

    backoff.recordSuccess('10001');
    assert.equal(backoff.isBlocked('10001'), false);
    assert.equal(backoff.windowMs('10001'), 0);
    assert.equal(backoff.recordFailure('10001'), 2_000);
  });

  it('keeps escalating across consecutive failures even when the window has elapsed', () => {
    const time = clock();
    const backoff = new Backoff({ now: time.now });

    assert.equal(backoff.recordFailure('10001'), 2_000);
    time.advance(600_000); // A long idle gap is not a success.
    assert.equal(backoff.recordFailure('10001'), 4_000);
  });

  it('backs off per key: one failing stop does not hold up another', () => {
    const time = clock();
    const backoff = new Backoff({ now: time.now });

    backoff.recordFailure('10001');
    backoff.recordFailure('10001');

    assert.equal(backoff.isBlocked('10001'), true);
    assert.equal(backoff.windowMs('10001'), 4_000);
    assert.equal(backoff.isBlocked('10002'), false);
    assert.equal(backoff.windowMs('10002'), 0);

    // And a success on one key leaves the other's window alone.
    assert.equal(backoff.recordFailure('10002'), 2_000);
    backoff.recordSuccess('10002');
    assert.equal(backoff.isBlocked('10001'), true);
  });

  it('defaults to Date.now when no clock is injected', () => {
    const backoff = new Backoff();

    assert.equal(backoff.recordFailure('10001'), 2_000);
    assert.equal(backoff.isBlocked('10001'), true); // 2 s has not passed in-process.
  });
});

/** Drives the breaker to the trip. Returns it open, with nothing in flight. */
const tripped = (breaker: CircuitBreaker, retryAfterMs?: number) => {
  for (let i = 0; i < 5; i += 1) {
    assert.equal(breaker.tryAcquire(), true, `attempt ${i} should still be admitted`);
    breaker.recordFailure(retryAfterMs);
  }
  assert.equal(breaker.isOpen(), true);
  return breaker;
};

describe('CircuitBreaker', () => {
  it('stays closed for four consecutive failures and opens on the fifth', () => {
    const time = clock();
    const breaker = new CircuitBreaker({ now: time.now });

    for (let i = 0; i < 4; i += 1) {
      assert.equal(breaker.tryAcquire(), true);
      breaker.recordFailure();
      assert.equal(breaker.isOpen(), false, `still closed after ${i + 1} failures`);
    }

    assert.equal(breaker.tryAcquire(), true);
    breaker.recordFailure();
    assert.equal(breaker.isOpen(), true);
    assert.equal(breaker.tryAcquire(), false);
  });

  it('never trips on a blip, because a success resets the run', () => {
    const time = clock();
    const breaker = new CircuitBreaker({ now: time.now });

    // Four failures then a success, twenty times over: eighty failures, no trip.
    for (let round = 0; round < 20; round += 1) {
      for (let i = 0; i < 4; i += 1) breaker.recordFailure();
      breaker.recordSuccess();
      time.advance(1_000);
    }

    assert.equal(breaker.isOpen(), false);
    assert.equal(breaker.tryAcquire(), true);
  });

  it('rejects for 60 s and no longer', () => {
    const time = clock();
    const breaker = tripped(new CircuitBreaker({ now: time.now }));

    time.advance(59_999);
    assert.equal(breaker.tryAcquire(), false);
    time.advance(1); // The window is exclusive, matching Backoff.
    assert.equal(breaker.tryAcquire(), true);
  });

  it('admits exactly one probe when five callers arrive at once', () => {
    const time = clock();
    const breaker = tripped(new CircuitBreaker({ now: time.now }));
    time.advance(60_000);

    // The board fans out five stops at a time; all five reach the breaker
    // before any of them has a result to report.
    const admitted = [0, 1, 2, 3, 4].map(() => breaker.tryAcquire());

    assert.deepEqual(admitted, [true, false, false, false, false]);
    assert.equal(breaker.isOpen(), true, 'half-open is not yet recovered');
  });

  it('closes on a successful probe, and needs five fresh failures to trip again', () => {
    const time = clock();
    const breaker = tripped(new CircuitBreaker({ now: time.now }));
    time.advance(60_000);

    assert.equal(breaker.tryAcquire(), true);
    breaker.recordSuccess();

    assert.equal(breaker.isOpen(), false);
    assert.deepEqual(
      [0, 1, 2, 3, 4].map(() => breaker.tryAcquire()),
      [true, true, true, true, true],
      'closed means everyone is admitted, not one at a time',
    );

    for (let i = 0; i < 4; i += 1) breaker.recordFailure();
    assert.equal(breaker.isOpen(), false, 'the earlier trip did not leave a count behind');
    breaker.recordFailure();
    assert.equal(breaker.isOpen(), true);
  });

  it('re-opens for another 60 s when the probe fails, and probes again after it', () => {
    const time = clock();
    const breaker = tripped(new CircuitBreaker({ now: time.now }));
    time.advance(60_000);

    assert.equal(breaker.tryAcquire(), true);
    breaker.recordFailure();

    time.advance(59_999);
    assert.equal(breaker.tryAcquire(), false, 'a failed probe buys a full new window');
    time.advance(1);

    assert.deepEqual(
      [0, 1, 2].map(() => breaker.tryAcquire()),
      [true, false, false],
      'and the new window ends in one probe, not a stampede',
    );
    breaker.recordSuccess();
    assert.equal(breaker.isOpen(), false);
  });

  it('honours Retry-After in place of the 60 s default', () => {
    const time = clock();
    const breaker = tripped(new CircuitBreaker({ now: time.now }), 5_000);

    time.advance(4_999);
    assert.equal(breaker.tryAcquire(), false);
    time.advance(1);
    assert.equal(breaker.tryAcquire(), true);
  });

  it('clamps Retry-After to 120 s so upstream cannot wedge us', () => {
    const time = clock();
    const breaker = tripped(new CircuitBreaker({ now: time.now }), 86_400_000); // "come back tomorrow"

    time.advance(119_999);
    assert.equal(breaker.tryAcquire(), false);
    time.advance(1);
    assert.equal(breaker.tryAcquire(), true);
  });

  it('falls back to 60 s for a Retry-After it could not use', () => {
    // What a malformed or past HTTP-date reaches the breaker as. A NaN deadline
    // would compare false against every clock reading and never elapse.
    for (const unusable of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY]) {
      const time = clock();
      const breaker = tripped(new CircuitBreaker({ now: time.now }), unusable);

      time.advance(59_999);
      assert.equal(breaker.tryAcquire(), false, `${unusable} should hold for 60 s`);
      time.advance(1);
      assert.equal(breaker.tryAcquire(), true, `${unusable} should not hold past 60 s`);
    }
  });

  it('ignores results from calls that were already in flight when it tripped', () => {
    const time = clock();
    const breaker = tripped(new CircuitBreaker({ now: time.now }));

    // A straggler success must not cancel the wait...
    breaker.recordSuccess();
    assert.equal(breaker.isOpen(), true);
    assert.equal(breaker.tryAcquire(), false);

    // ...and a straggler failure must not extend it, or five stops failing
    // together would each push the deadline out by another minute.
    time.advance(30_000);
    breaker.recordFailure();
    time.advance(30_000);
    assert.equal(breaker.tryAcquire(), true, 'still 60 s from the trip, not from the straggler');
  });

  it('reports open through half-open and closed only once a probe succeeds', () => {
    const time = clock();
    const breaker = new CircuitBreaker({ now: time.now });

    assert.equal(breaker.isOpen(), false);
    tripped(breaker);
    assert.equal(breaker.isOpen(), true);

    time.advance(60_000);
    assert.equal(breaker.isOpen(), true, 'half-open: recovery is unproven');
    breaker.tryAcquire();
    assert.equal(breaker.isOpen(), true, 'probe in flight: still unproven');

    breaker.recordSuccess();
    assert.equal(breaker.isOpen(), false);
  });

  it('defaults to Date.now when no clock is injected', () => {
    const breaker = tripped(new CircuitBreaker());

    assert.equal(breaker.tryAcquire(), false); // 60 s has not passed in-process.
  });
});
