import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RollingCounter } from './lta.js';

/** Same hand-driven clock as cache.test.ts: a 60 s window must not be slept through. */
const clock = (start = 1_000_000) => {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe('RollingCounter', () => {
  it('counts every recorded call cumulatively', () => {
    const counter = new RollingCounter(clock().now);
    for (let i = 0; i < 4; i += 1) counter.record();
    assert.equal(counter.total, 4);
  });

  it('reports calls made inside the trailing minute', () => {
    const time = clock();
    const counter = new RollingCounter(time.now);

    counter.record();
    time.advance(30_000);
    counter.record();

    assert.equal(counter.perMinute(), 2);
  });

  it('drops calls once they fall out of the window, without losing the total', () => {
    const time = clock();
    const counter = new RollingCounter(time.now);

    counter.record();
    time.advance(30_000);
    counter.record();

    time.advance(30_000); // first call is now 60 s old, second is 30 s old
    assert.equal(counter.perMinute(), 1);

    time.advance(30_000);
    assert.equal(counter.perMinute(), 0);
    assert.equal(counter.total, 2, 'the window decays; the cumulative count does not');
  });

  it('stays bounded under sustained traffic', () => {
    const time = clock();
    const counter = new RollingCounter(time.now);

    // Ten calls a second for five minutes: 3000 calls, but never more than 60
    // buckets retained, so the window reports the last minute and not the lot.
    for (let tick = 0; tick < 300; tick += 1) {
      if (tick > 0) time.advance(1_000);
      for (let i = 0; i < 10; i += 1) counter.record();
    }

    assert.equal(counter.total, 3_000);
    assert.equal(counter.perMinute(), 600);
  });

  it('defaults to Date.now when no clock is injected', () => {
    const counter = new RollingCounter();
    counter.record();
    assert.equal(counter.total, 1);
    assert.equal(counter.perMinute(), 1);
  });
});
