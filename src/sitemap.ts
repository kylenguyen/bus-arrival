/**
 * The sitemap as a pure function, exported so tests can feed hand-written
 * lists — the same bargain as `buildRoutes`. One `<urlset>` covers the whole
 * site (~5,400 URLs against the format's 50,000 cap).
 *
 * No `<lastmod>`: the pages' stable facts change rarely and a wrong date is
 * worse than none. No XML escaping either — every code and service number
 * arriving here has passed the route guards (`STOP_CODE`, `SERVICE_NO` in
 * `index.ts`), so the inputs are plain alphanumerics by construction.
 */

const ORIGIN = 'https://ezbus.sg';

export function buildSitemap(stopCodes: string[], serviceNos: string[]): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `<url><loc>${ORIGIN}/</loc></url>`,
    `<url><loc>${ORIGIN}/buses</loc></url>`,
  ];
  for (const code of stopCodes) lines.push(`<url><loc>${ORIGIN}/stop/${code}</loc></url>`);
  for (const serviceNo of serviceNos) lines.push(`<url><loc>${ORIGIN}/bus/${serviceNo}</loc></url>`);
  lines.push('</urlset>');
  return lines.join('\n') + '\n';
}
