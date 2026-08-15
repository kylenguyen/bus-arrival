import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MOCK_STOPS, mockArrivals, mockRoutes, mockServiceInfo } from './mock.js';

// Any fixed instant: mockArrivals only uses the clock to phase timings, and the
// service list per stop is what these tests read.
const NOW = new Date('2026-08-15T04:00:00Z');

test('mock routes are the exact inverse of the per-stop service lists', () => {
  const listedAt = new Map(
    MOCK_STOPS.map((stop) => [stop.code, new Set(mockArrivals(stop.code, NOW).map((s) => s.serviceNo))]),
  );

  const routedAt = new Map<string, Set<string>>(MOCK_STOPS.map((stop) => [stop.code, new Set()]));
  for (const record of mockRoutes()) {
    const services = routedAt.get(record.code);
    assert.ok(services, `route for ${record.serviceNo} visits ${record.code}, which is not a mock stop`);
    services.add(record.serviceNo);
  }

  assert.deepEqual(routedAt, listedAt);
});

test('exactly one loop service: single direction, one stop visited twice', () => {
  const loops = mockServiceInfo().filter((s) => s.loopDesc !== '');
  assert.equal(loops.length, 1);

  const loop = loops[0];
  assert.ok(loop);
  const records = mockRoutes().filter((r) => r.serviceNo === loop.serviceNo);
  assert.ok(records.length > 0);
  assert.ok(records.every((r) => r.direction === 1));

  const visits = new Map<string, number>();
  for (const r of records) visits.set(r.code, (visits.get(r.code) ?? 0) + 1);
  assert.deepEqual([...visits.values()].sort().reverse(), [2, ...Array(visits.size - 1).fill(1)]);
});

test('sequences are contiguous from 1 and carry first/last bus on seq 1 only', () => {
  const byLeg = new Map<string, number[]>();
  for (const r of mockRoutes()) {
    const key = `${r.serviceNo}:${r.direction}`;
    byLeg.set(key, [...(byLeg.get(key) ?? []), r.seq]);
    assert.equal(r.firstBus !== undefined, r.seq === 1, `firstBus placement on ${key} seq ${r.seq}`);
    assert.equal(r.lastBus !== undefined, r.seq === 1, `lastBus placement on ${key} seq ${r.seq}`);
    if (r.firstBus) assert.match(r.firstBus.wd, /^\d{4}$/);
  }
  for (const [key, seqs] of byLeg) {
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), `sequence gap in ${key}`);
  }
});
