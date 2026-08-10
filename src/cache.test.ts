import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TtlCache } from './cache.js';
import { Backoff } from './limiter.js';

/**
 * Every test drives the clock by hand. A sleeping test for a 15 s TTL is either
 * slow or flaky, and usually both.
 */
const clock = (start = 1_000_000) => {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

/** A loader whose settlement this test controls, for the concurrency cases. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('TtlCache', () => {
  it('serves the cached value within the TTL without re-entering the loader', async () => {
    const time = clock();
    const cache = new TtlCache<string>(15_000, time.now);
    let calls = 0;

    const loader = async () => {
      calls += 1;
      return `value-${calls}`;
    };

    assert.equal(await cache.fetch('10001', loader), 'value-1');
    time.advance(14_999);
    assert.equal(await cache.fetch('10001', loader), 'value-1');
    assert.equal(calls, 1);
  });

  it('re-fetches once the entry has expired', async () => {
    const time = clock();
    const cache = new TtlCache<string>(15_000, time.now);
    let calls = 0;

    const loader = async () => {
      calls += 1;
      return `value-${calls}`;
    };

    assert.equal(await cache.fetch('10001', loader), 'value-1');
    time.advance(15_000); // expiresAt is exclusive: equal is already stale.
    assert.equal(await cache.fetch('10001', loader), 'value-2');
    assert.equal(calls, 2);
  });

  it('keys the cache separately per stop code', async () => {
    const time = clock();
    const cache = new TtlCache<string>(15_000, time.now);
    let calls = 0;

    const loader = async () => {
      calls += 1;
      return `value-${calls}`;
    };

    assert.equal(await cache.fetch('10001', loader), 'value-1');
    assert.equal(await cache.fetch('10002', loader), 'value-2');
    assert.equal(calls, 2);
  });

  it('de-duplicates concurrent fetches into one loader call', async () => {
    const time = clock();
    const cache = new TtlCache<string>(15_000, time.now);
    let calls = 0;
    const gate = deferred<string>();

    const loader = () => {
      calls += 1;
      return gate.promise;
    };

    // Both start before either can finish: ten viewers of one stop, one call.
    const first = cache.fetch('10001', loader);
    const second = cache.fetch('10001', loader);
    gate.resolve('value-1');

    assert.deepEqual(await Promise.all([first, second]), ['value-1', 'value-1']);
    assert.equal(calls, 1);
  });

  it('clears the in-flight entry so a later miss can load again', async () => {
    const time = clock();
    const cache = new TtlCache<string>(15_000, time.now);
    let calls = 0;

    const loader = async () => {
      calls += 1;
      return `value-${calls}`;
    };

    await Promise.all([cache.fetch('10001', loader), cache.fetch('10001', loader)]);
    time.advance(20_000);
    assert.equal(await cache.fetch('10001', loader), 'value-2');
    assert.equal(calls, 2);
  });

  it('serves the stale value when the loader rejects after a successful load', async () => {
    const time = clock();
    const cache = new TtlCache<string>(15_000, time.now);

    assert.equal(await cache.fetch('10001', async () => 'fresh'), 'fresh');
    time.advance(20_000);

    const failing = async () => {
      throw new Error('DataMall BusArrival returned 500');
    };
    assert.equal(await cache.fetch('10001', failing), 'fresh');
  });

  it('propagates the failure when there is nothing stale to serve', async () => {
    const time = clock();
    const cache = new TtlCache<string>(15_000, time.now);

    await assert.rejects(
      cache.fetch('10001', async () => {
        throw new Error('DataMall BusArrival returned 500');
      }),
      /returned 500/,
    );
  });

  it('defaults to Date.now when no clock is injected', async () => {
    const cache = new TtlCache<string>(15_000);
    let calls = 0;

    const loader = async () => {
      calls += 1;
      return `value-${calls}`;
    };

    assert.equal(await cache.fetch('10001', loader), 'value-1');
    assert.equal(await cache.fetch('10001', loader), 'value-1');
    assert.equal(calls, 1);
  });
});

/** A loader that always rejects, counting how many times it was entered. */
const failing = () => {
  const state = { calls: 0 };
  return {
    state,
    loader: async (): Promise<never> => {
      state.calls += 1;
      throw new Error('DataMall v3/BusArrival returned 500');
    },
  };
};

describe('TtlCache backoff', () => {
  it('serves the stale value for the whole backoff window without re-entering the loader', async () => {
    const time = clock();
    const cache = new TtlCache<string>(15_000, time.now);
    const { state, loader } = failing();

    assert.equal(await cache.fetch('10001', async () => 'fresh'), 'fresh');
    time.advance(15_000);

    // The window doubles per consecutive failure and caps at 60 s. Each pass
    // asserts one upstream attempt, then that nothing goes upstream again
    // until the last millisecond of that window has elapsed.
    let expected = 0;
    for (const window of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      expected += 1;
      assert.equal(await cache.fetch('10001', loader), 'fresh');
      assert.equal(state.calls, expected);

      time.advance(window - 1);
      assert.equal(await cache.fetch('10001', loader), 'fresh');
      assert.equal(state.calls, expected, `retried inside the ${window}ms window`);

      time.advance(1);
    }
  });

  it('resets the window to 2 s after a success', async () => {
    const time = clock();
    const cache = new TtlCache<string>(15_000, time.now);
    const { state, loader } = failing();

    assert.equal(await cache.fetch('10001', async () => 'fresh'), 'fresh');
    time.advance(15_000);

    for (const window of [2_000, 4_000, 8_000]) {
      await cache.fetch('10001', loader);
      time.advance(window);
    }
    assert.equal(state.calls, 3);

    assert.equal(await cache.fetch('10001', async () => 'recovered'), 'recovered');
    time.advance(15_000);

    // Back to the base window, not the 16 s the escalation had reached.
    assert.equal(await cache.fetch('10001', loader), 'recovered');
    time.advance(1_999);
    assert.equal(await cache.fetch('10001', loader), 'recovered');
    assert.equal(state.calls, 4);
    time.advance(1);
    assert.equal(await cache.fetch('10001', loader), 'recovered');
    assert.equal(state.calls, 5);
  });

  it('backs off a key with no cached value without re-entering the loader', async () => {
    const time = clock();
    const cache = new TtlCache<string>(15_000, time.now);
    const { state, loader } = failing();

    await assert.rejects(cache.fetch('10001', loader), /returned 500/);
    assert.equal(state.calls, 1);

    // The caller still gets the failure, but no socket is opened for it.
    await assert.rejects(cache.fetch('10001', loader), /returned 500/);
    time.advance(1_999);
    await assert.rejects(cache.fetch('10001', loader), /returned 500/);
    assert.equal(state.calls, 1);

    time.advance(1);
    await assert.rejects(cache.fetch('10001', loader), /returned 500/);
    assert.equal(state.calls, 2);
  });

  it('backs off per key: one failing stop does not block another', async () => {
    const time = clock();
    const cache = new TtlCache<string>(15_000, time.now);
    const { state, loader } = failing();

    await assert.rejects(cache.fetch('10001', loader), /returned 500/);
    assert.equal(state.calls, 1);

    // 10002 is untouched by 10001's window: it loads immediately.
    assert.equal(await cache.fetch('10002', async () => 'other'), 'other');
    await assert.rejects(cache.fetch('10001', loader), /returned 500/);
    assert.equal(state.calls, 1);
  });

  it('counts an empty result as a success, so the 01:30 no-buses case never backs off', async () => {
    const time = clock();
    const cache = new TtlCache<string[]>(15_000, time.now);
    let calls = 0;

    // DataMall answers with no body outside operating hours, which lta.ts maps
    // to `[]`. That is a healthy API, not an outage: four minutes of it must
    // stay at the plain cache-miss rate — one call per TTL, evenly spaced —
    // and must never reject. If `[]` were treated as a failure this loop would
    // reject on the second pass and the call count would collapse to the
    // 2/4/8/16 s progression.
    const empty = async () => {
      calls += 1;
      return [];
    };

    for (let i = 0; i < 16; i += 1) {
      assert.deepEqual(await cache.fetch('10001', empty), []);
      time.advance(15_000);
    }
    assert.equal(calls, 16);
  });

  it('clears an existing backoff when the loader resolves with an empty result', async () => {
    const time = clock();
    const backoff = new Backoff({ now: time.now });
    const cache = new TtlCache<string[]>(15_000, time.now, backoff);
    const { loader } = failing();

    await assert.rejects(cache.fetch('10001', loader), /returned 500/);
    assert.equal(backoff.windowMs('10001'), 2_000);
    time.advance(2_000);

    assert.deepEqual(await cache.fetch('10001', async () => []), []);
    assert.equal(backoff.isBlocked('10001'), false);
    assert.equal(backoff.windowMs('10001'), 0);

    // The next failure starts again at 2 s rather than resuming at 4 s.
    time.advance(15_000);
    await cache.fetch('10001', loader).catch(() => undefined);
    assert.equal(backoff.windowMs('10001'), 2_000);
  });
});
