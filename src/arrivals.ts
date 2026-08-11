import { TtlCache } from './cache.js';
import { config, mockMode } from './config.js';
import { fetchArrivals } from './lta.js';
import { mockArrivals } from './mock.js';
import type { ArrivalService } from './types.js';

const cache = new TtlCache<ArrivalService[]>(config.arrivalTtlMs);

export const arrivalsFor = (code: string): Promise<ArrivalService[]> =>
  cache.fetch(code, () => (mockMode ? Promise.resolve(mockArrivals(code)) : fetchArrivals(code)));

// DataMall is one request per stop, so a full 8-stop board is 8 requests. Run
// them a few at a time rather than all at once: the TTL cache absorbs repeat
// viewers, and a burst of sockets at one host is what gets an account throttled.
const CONCURRENCY = 5;

/**
 * Arrivals for several stops. A stop whose upstream call fails maps to `null`
 * rather than failing the whole board — one bad stop should not blank the page.
 */
export const arrivalsForMany = async (
  codes: string[],
): Promise<Map<string, ArrivalService[] | null>> => {
  const out = new Map<string, ArrivalService[] | null>();

  for (let i = 0; i < codes.length; i += CONCURRENCY) {
    const chunk = codes.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      chunk.map(async (code) => {
        try {
          return [code, await arrivalsFor(code)] as const;
        } catch (err) {
          console.error(`arrivals for ${code} failed:`, err instanceof Error ? err.message : err);
          return [code, null] as const;
        }
      }),
    );
    for (const [code, services] of settled) out.set(code, services);
  }

  return out;
};
