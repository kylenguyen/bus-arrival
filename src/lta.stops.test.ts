import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// `config` reads the environment once, at import time, and `request()` refuses
// to call out without an AccountKey. Both have to be in place before `lta.js`
// is evaluated, hence the dynamic import below rather than a static one. Each
// test file is its own process under `node --test`, so this leaks nowhere.
process.env.LTA_ACCOUNT_KEY = 'test-key';
process.env.LTA_BASE_URL = 'http://datamall.test/ltaodataservice';

const { fetchAllStops } = await import('./lta.js');

const stopRecord = (index: number) => ({
  BusStopCode: String(10001 + index),
  RoadName: 'Test Road',
  Description: `Test Stop ${10001 + index}`,
  Latitude: 1.3521,
  Longitude: 103.8198,
});

/**
 * Serves `total` stop records in pages of `pageSize`, recording the `$skip`
 * each call asked for. Stands in for global `fetch`; restore it yourself.
 */
const stubFeed = (total: number, pageSize: number) => {
  const skips: number[] = [];

  globalThis.fetch = (async (input: URL) => {
    const skip = Number(new URL(input).searchParams.get('$skip') ?? '0');
    skips.push(skip);

    const page = Array.from({ length: Math.max(0, Math.min(pageSize, total - skip)) }, (_, i) =>
      stopRecord(skip + i),
    );
    return new Response(JSON.stringify({ value: page }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return skips;
};

describe('fetchAllStops pagination', () => {
  const realFetch = globalThis.fetch;
  const restore = () => {
    globalThis.fetch = realFetch;
  };

  it('walks $skip by the records actually returned, not by an assumed page size', async () => {
    // The guide caps a call at 500 records but says the number "may be adjusted
    // from time to time". At 300 a page, terminating on a short page would have
    // stopped after the first call and served 300 of 700 stops.
    const skips = stubFeed(700, 300);
    try {
      const stops = await fetchAllStops();
      assert.equal(stops.length, 700);
      assert.deepEqual(skips, [0, 300, 600, 700]);
    } finally {
      restore();
    }
  });

  it('walks the documented 500-record page to the end of the feed', async () => {
    const skips = stubFeed(1200, 500);
    try {
      const stops = await fetchAllStops();
      assert.equal(stops.length, 1200);
      assert.deepEqual(skips, [0, 500, 1000, 1200]);
    } finally {
      restore();
    }
  });

  it('stops at the first empty page', async () => {
    const skips = stubFeed(0, 500);
    try {
      assert.deepEqual(await fetchAllStops(), []);
      assert.deepEqual(skips, [0]);
    } finally {
      restore();
    }
  });

  it('advances past records it rejects, so a bad row cannot stall the walk', async () => {
    // A record with no usable coordinate is dropped by `toStop`, but it still
    // occupies an offset upstream — advancing by accepted stops rather than by
    // returned records would re-request it forever.
    const skips: number[] = [];
    globalThis.fetch = (async (input: URL) => {
      const skip = Number(new URL(input).searchParams.get('$skip') ?? '0');
      skips.push(skip);
      const page = skip === 0 ? [stopRecord(0), { BusStopCode: '10002' }] : [];
      return new Response(JSON.stringify({ value: page }), { status: 200 });
    }) as typeof fetch;

    try {
      const stops = await fetchAllStops();
      assert.equal(stops.length, 1, 'the unusable record is dropped');
      assert.deepEqual(skips, [0, 2], 'but both records are skipped past');
    } finally {
      restore();
    }
  });
});
