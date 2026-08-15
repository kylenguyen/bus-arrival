import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// `config` reads the environment once, at import time, and `request()` refuses
// to call out without an AccountKey. Both have to be in place before `lta.js`
// is evaluated, hence the dynamic import below rather than a static one. Each
// test file is its own process under `node --test`, so this leaks nowhere.
process.env.LTA_ACCOUNT_KEY = 'test-key';
process.env.LTA_BASE_URL = 'http://datamall.test/ltaodataservice';

const { fetchAllRoutes, fetchAllServices } = await import('./lta.js');

const routeRecord = (index: number) => ({
  ServiceNo: '61',
  Operator: 'SBST',
  Direction: 1,
  StopSequence: index + 1,
  BusStopCode: String(10001 + index),
  Distance: index * 0.4,
  WD_FirstBus: '0530',
  WD_LastBus: '2345',
  SAT_FirstBus: '0535',
  SAT_LastBus: '2340',
  SUN_FirstBus: '0620',
  SUN_LastBus: '2330',
});

/**
 * Serves `total` route records in pages of `pageSize`, recording the `$skip`
 * each call asked for. Stands in for global `fetch`; restore it yourself.
 */
const stubFeed = (total: number, pageSize: number) => {
  const skips: number[] = [];

  globalThis.fetch = (async (input: URL) => {
    const skip = Number(new URL(input).searchParams.get('$skip') ?? '0');
    skips.push(skip);

    const page = Array.from({ length: Math.max(0, Math.min(pageSize, total - skip)) }, (_, i) =>
      routeRecord(skip + i),
    );
    return new Response(JSON.stringify({ value: page }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return skips;
};

describe('fetchAllRoutes pagination', () => {
  const realFetch = globalThis.fetch;
  const restore = () => {
    globalThis.fetch = realFetch;
  };

  it('walks $skip by the records actually returned, not by an assumed page size', async () => {
    // Same rule the stop walk pins: the guide says the 500-record cap "may be
    // adjusted from time to time", so a short page must not read as the last.
    const skips = stubFeed(700, 300);
    try {
      const routes = await fetchAllRoutes();
      assert.equal(routes.length, 700);
      assert.deepEqual(skips, [0, 300, 600, 700]);
    } finally {
      restore();
    }
  });

  it('stops at the first empty page', async () => {
    const skips = stubFeed(0, 500);
    try {
      assert.deepEqual(await fetchAllRoutes(), []);
      assert.deepEqual(skips, [0]);
    } finally {
      restore();
    }
  });

  it('warns and truncates at the route-request ceiling instead of walking forever', async () => {
    // A feed that never serves an empty page. 80 is MAX_ROUTE_REQUESTS; the
    // walk must give up there, keep what it has, and say so on the console.
    const skips: number[] = [];
    globalThis.fetch = (async (input: URL) => {
      const skip = Number(new URL(input).searchParams.get('$skip') ?? '0');
      skips.push(skip);
      const page = Array.from({ length: 5 }, (_, i) => routeRecord(skip + i));
      return new Response(JSON.stringify({ value: page }), { status: 200 });
    }) as typeof fetch;

    const realWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: string) => {
      warnings.push(message);
    };

    try {
      const routes = await fetchAllRoutes();
      assert.equal(skips.length, 80, 'exactly MAX_ROUTE_REQUESTS calls');
      assert.equal(routes.length, 400, 'keeps everything fetched before the ceiling');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? '', /80-request ceiling/);
    } finally {
      console.warn = realWarn;
      restore();
    }
  });

  it('throws on an empty body — the route feed has no non-operating hours', async () => {
    globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch;
    try {
      await assert.rejects(fetchAllRoutes(), /BusRoutes returned an empty body/);
      await assert.rejects(fetchAllServices(), /BusServices returned an empty body/);
    } finally {
      restore();
    }
  });

  it('sends the AccountKey header on every page request', async () => {
    const headers: Array<Record<string, string>> = [];
    globalThis.fetch = (async (input: URL, init?: RequestInit) => {
      headers.push({ ...(init?.headers as Record<string, string>) });
      const skip = Number(new URL(input).searchParams.get('$skip') ?? '0');
      const page = skip === 0 ? [routeRecord(0)] : [];
      return new Response(JSON.stringify({ value: page }), { status: 200 });
    }) as typeof fetch;

    try {
      await fetchAllRoutes();
      assert.equal(headers.length, 2);
      for (const sent of headers) assert.equal(sent['AccountKey'], 'test-key');
    } finally {
      restore();
    }
  });
});

describe('field mapping', () => {
  const realFetch = globalThis.fetch;
  const restore = () => {
    globalThis.fetch = realFetch;
  };

  const servePages = (pages: unknown[][]) => {
    let call = 0;
    globalThis.fetch = (async () => {
      const page = pages[call] ?? [];
      call += 1;
      return new Response(JSON.stringify({ value: page }), { status: 200 });
    }) as typeof fetch;
  };

  it('maps a BusRoutes record to RouteStop and drops upstream field names', async () => {
    servePages([
      [
        {
          ServiceNo: ' 107M ',
          Operator: 'SBST',
          Direction: '2', // upstream sends numbers, but a string 2 is still a 2
          StopSequence: 28,
          BusStopCode: '01219',
          Distance: 10.3,
          WD_FirstBus: '2025',
          WD_LastBus: '2352',
          SAT_FirstBus: '1427',
          SAT_LastBus: '2349',
          SUN_FirstBus: '0620',
          SUN_LastBus: '2349',
        },
      ],
    ]);

    try {
      const routes = await fetchAllRoutes();
      assert.deepEqual(routes, [
        {
          serviceNo: '107M',
          direction: 2,
          seq: 28,
          code: '01219',
          firstBus: { wd: '2025', sat: '1427', sun: '0620' },
          lastBus: { wd: '2352', sat: '2349', sun: '2349' },
        },
      ]);
    } finally {
      restore();
    }
  });

  it('omits firstBus/lastBus when DataMall writes "-" across the board', async () => {
    servePages([
      [
        {
          ServiceNo: '61',
          Direction: 1,
          StopSequence: 1,
          BusStopCode: '84009',
          WD_FirstBus: '-',
          WD_LastBus: '-',
          SAT_FirstBus: '-',
          SAT_LastBus: '-',
          SUN_FirstBus: '-',
          SUN_LastBus: '-',
        },
      ],
    ]);

    try {
      const routes = await fetchAllRoutes();
      assert.equal(routes.length, 1);
      assert.equal(routes[0]?.firstBus, undefined);
      assert.equal(routes[0]?.lastBus, undefined);
    } finally {
      restore();
    }
  });

  it('drops a record with no usable direction but still advances past it', async () => {
    servePages([
      [
        routeRecord(0),
        { ServiceNo: '61', Direction: 3, StopSequence: 2, BusStopCode: '10002' },
      ],
      [routeRecord(2)],
    ]);

    try {
      const routes = await fetchAllRoutes();
      // The bad record is dropped from the result, but it occupied an offset
      // upstream, so the third record still arrives — the walk did not stall.
      assert.deepEqual(
        routes.map((r) => r.code),
        ['10001', '10003'],
      );
    } finally {
      restore();
    }
  });

  it('maps a BusServices record to ServiceInfo, loop and non-loop alike', async () => {
    servePages([
      [
        {
          ServiceNo: '107M',
          Operator: 'SBST',
          Direction: 1,
          Category: 'TRUNK',
          OriginCode: '64009',
          DestinationCode: '64009',
          AM_Peak_Freq: '14-17',
          LoopDesc: 'Raffles Blvd',
        },
        {
          ServiceNo: '61',
          Operator: 'SBST',
          Direction: 1,
          Category: 'TRUNK',
          OriginCode: '84009',
          DestinationCode: '43009',
          // `-` is DataMall's "no data", the same convention the times use;
          // AM_Offpeak_Freq missing entirely must land in the same place.
          AM_Peak_Freq: '-',
          LoopDesc: '',
        },
      ],
    ]);

    try {
      const services = await fetchAllServices();
      assert.deepEqual(services, [
        {
          serviceNo: '107M',
          operator: 'SBST',
          category: 'TRUNK',
          loopDesc: 'Raffles Blvd',
          freq: { peak: '14-17', offpeak: null },
        },
        {
          serviceNo: '61',
          operator: 'SBST',
          category: 'TRUNK',
          loopDesc: '',
          freq: { peak: null, offpeak: null },
        },
      ]);
    } finally {
      restore();
    }
  });
});
