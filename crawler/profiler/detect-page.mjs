// `jobcrawl detect <url> [--page]` as a function, so it can be tested on replayed answers: the URL's own provider match, then (page) the
// careers page fetched through the SSRF guard (core/fetch/ssrf.mjs: http(s) to public addresses only, every redirect hop checked), the
// link fingerprints (atsFingerprints) and detector v2 (platforms.mjs over fingerprints.json, with the careers host's CNAME).
// Injection points for tests and other runtimes: fetchImpl, lookupImpl (DNS A/AAAA for the SSRF check), cnameImpl.
import { resolve as resolveEntry } from '../providers.mjs';
import { atsFingerprints } from './detect.mjs';
import { detectHits, cnameOf } from './platforms.mjs';
import { UA } from '../useragent.mjs';

/** { url, hits: [{ provider, slug, evidence[] , platform?, confidence? }], page?: { status, bytes } | { error } } */
export async function detectPage(url, { page = false, fetchImpl = globalThis.fetch, lookupImpl, cnameImpl = cnameOf, timeoutMs = 20000 } = {}) {
  const hit = resolveEntry({ careers_url: url });
  const res = { url, hits: hit ? [{ provider: hit.provider, slug: hit.slug, evidence: [{ type: 'url' }] }] : [] };
  if (!page) return res;
  const { safeFetch } = await import('../../core/fetch/ssrf.mjs');
  try {
    const r = await safeFetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs) }, { fetchImpl, ...(lookupImpl ? { lookupImpl } : {}) });
    const html = await r.text();
    const finalUrl = r.url || url;
    for (const f of atsFingerprints(html, finalUrl) ?? []) res.hits.push({ provider: f.provider, slug: f.slug, evidence: [{ type: 'page', via: f.via, hits: f.hits }] });
    // detector v2: adds what the links did not give (a board on the employer's own host, an unsupported platform with provider null)
    const seen = new Set(res.hits.map((h) => `${h.provider}\t${h.slug}`));
    for (const h of detectHits({ url, finalUrl, html, cname: await cnameImpl(new URL(url).hostname) })) {
      if (h.provider && seen.has(`${h.provider}\t${h.slug}`)) continue;
      res.hits.push(h);
    }
    res.page = { status: r.status, bytes: html.length };
  } catch (e) { res.page = { error: String(e?.message ?? e), ...(e?.name ? { kind: e.constructor?.name ?? e.name } : {}) }; }
  return res;
}
