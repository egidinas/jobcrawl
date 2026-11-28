// Detector v1 as it ships today (CLI `detect --page` and MCP `detect_board`), offline, for the benchmark baseline and the default path:
// the careers URL's own provider match (providers.resolve), then the page's ATS link fingerprints (profiler atsFingerprints), then the
// platform fingerprints (profiler identifyPlatforms over crawler/profiler/fingerprints.json), in that order; the first hit is the answer.
import { resolve as resolveEntry } from '../../crawler/providers.mjs';
import { atsFingerprints } from '../../crawler/profiler/detect.mjs';
import { detectHits } from '../../crawler/profiler/platforms.mjs';

/** hits in the CLI/MCP shape: [{ provider, slug, evidence[], platform?, confidence? }], in v1's order. */
export function detectV1({ url = '', finalUrl = '', html = '', cname = '' } = {}) {
  const hits = [];
  if (url) { const h = resolveEntry({ careers_url: url }); if (h) hits.push({ provider: h.provider, slug: h.slug, evidence: [{ type: 'url' }] }); }
  if (html) {
    const base = finalUrl || url || 'https://page.invalid/';
    for (const f of atsFingerprints(html, base) ?? []) hits.push({ provider: f.provider, slug: f.slug, evidence: [{ type: 'page', via: f.via, hits: f.hits }] });
    const seen = new Set(hits.map((h) => `${h.provider}\t${h.slug}`));
    for (const h of detectHits({ url: url || base, finalUrl: base, html, cname })) if (!(h.provider && seen.has(`${h.provider}\t${h.slug}`))) hits.push(h);
  }
  return hits;
}
