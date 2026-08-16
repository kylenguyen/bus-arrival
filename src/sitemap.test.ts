import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSitemap } from './sitemap.js';

/**
 * `buildSitemap` fails by omitting pages or emitting malformed XML, both of
 * which a crawler swallows silently — a missing stop is a perfectly healthy
 * sitemap that just never gets that page indexed.
 */
describe('buildSitemap', () => {
  const xml = buildSitemap(['10001', '10009'], ['52', '972M']);

  it('emits one URL per stop and service, plus home and /buses', () => {
    const locs = xml.match(/<loc>/g) ?? [];
    assert.equal(locs.length, 2 + 2 + 2);
  });

  it('emits the exact <loc> strings, service numbers in DataMall spelling', () => {
    assert.ok(xml.includes('<loc>https://ezbus.sg/</loc>'));
    assert.ok(xml.includes('<loc>https://ezbus.sg/buses</loc>'));
    assert.ok(xml.includes('<loc>https://ezbus.sg/stop/10001</loc>'));
    assert.ok(xml.includes('<loc>https://ezbus.sg/stop/10009</loc>'));
    assert.ok(xml.includes('<loc>https://ezbus.sg/bus/52</loc>'));
    assert.ok(xml.includes('<loc>https://ezbus.sg/bus/972M</loc>'));
  });

  it('starts with the XML declaration and balances its tags', () => {
    assert.ok(xml.startsWith('<?xml'));
    assert.equal((xml.match(/<urlset[ >]/g) ?? []).length, 1);
    assert.equal((xml.match(/<\/urlset>/g) ?? []).length, 1);
    assert.equal((xml.match(/<url>/g) ?? []).length, (xml.match(/<\/url>/g) ?? []).length);
    assert.equal((xml.match(/<loc>/g) ?? []).length, (xml.match(/<\/loc>/g) ?? []).length);
  });

  it('carries no <lastmod> — a wrong date is worse than none', () => {
    assert.ok(!xml.includes('<lastmod>'));
  });

  it('holds just the two fixed URLs when both lists are empty', () => {
    const empty = buildSitemap([], []);
    assert.equal((empty.match(/<loc>/g) ?? []).length, 2);
  });
});
