import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Backoff } from './limiter.js';

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
