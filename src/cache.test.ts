import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TtlCache } from './cache.js';

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
