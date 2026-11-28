// Detector v2 (JOBCRAWLX row 2A.5): which job-board source reads a careers page, from fingerprints as data plus content signals.
//
//   detect({ url, html?, finalUrl?, headers?, cname?, fetch?, follow? })  ->  Promise<{ url, candidates, fetched[] }>
//   detectOffline({ url, html, finalUrl, headers, cname })                 ->  { url, candidates }   (no network, no DNS)
//
// candidates: [{ provider, slug, confidence, kind, evidence: [{ kind, value, url? }], platform?, config? }], best first.
//   * ATS / site readers come from core/detect/fingerprints.json (one row per source of the provider registry). Each signal kind seen
//     (url, redirect, cname, iframe_src, script_src, form_action, api, meta_generator, jsonld, header, markup, link_href, inline) adds
//     its weight: confidence = 1 - prod(1 - w). The slug comes from the row's slug rules over the strongest evidence URL.
//   * Custom boards (no ATS): content signals (core/detect/content.mjs) propose a generic source (jsonld_direct, sitemap, paginated_list)
//     with a config the crawler can verify.
// Offline when html is given. With `fetch` (an egress-guarded fetch, core/fetch/guard.mjs, is used when none is passed) and no html,
// the careers page is fetched; then at most `follow` (default 1) further page: the vendor iframe, or the careers link when the page
// itself named no source.
import { readFileSync } from 'node:fs';
import { providers } from '../../crawler/providers.mjs';
import { regDomain, hostOf, decode } from '../../crawler/profiler/detect.mjs';
import { contentCandidates } from './content.mjs';

const DATA = JSON.parse(readFileSync(new URL('./fingerprints.json', import.meta.url), 'utf8'));
export const SCHEMA = DATA.schema;
export const WEIGHTS = DATA.weights;
const rx = (list = []) => list.map((s) => new RegExp(s, 'i'));
// path words and vendor hosts that are never a tenant (app.teamtailor.com, /embed/, /jobs/)
const NOT_SLUG = /^(?:embed|js|job_board|jobs?|careers?|api|v\d+|www|app|static|assets|cdn|widget|null|undefined)$/i;

/** API endpoint templates as regexes: the host must be literal; {slug} becomes a capture. Junk templates (slug glued to a host) drop. */
function apiRx(templates = []) {
  const out = [];
  for (const t of templates) {
    const m = t.match(/^https?:\/\/([^/]+)(\/.*)?$/);
    if (!m || /\{slug\}\w|\w\{slug\}(?!\.)/.test(m[1]) || /\.\w+\{slug\}/.test(t)) continue;
    const src = t.replace(/^https?:\/\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{slug\\\}/g, '([\\w.-]+)');
    if (src.replace(/\(\[\\w\.-\]\+\)/g, '').length < 12) continue;
    out.push(new RegExp(src, 'i'));
  }
  return out;
}

export const FINGERPRINTS = DATA.providers.map((p) => ({
  ...p,
  id: p.provider ?? p.platform,
  hostRx: rx(p.hosts), urlRx: rx(p.url), cnameRx: rx(p.cname), apiRx: p.kind === 'site' ? [] : apiRx(p.api),
  htmlRx: Object.fromEntries(Object.entries(p.html ?? {}).map(([k, v]) => [k, rx(v)])),
  headerRx: (p.headers ?? []).map((h) => ({ name: String(h.name).toLowerCase(), rx: new RegExp(h.pattern, 'i') })),
}));
const ACTIVE = FINGERPRINTS.filter((p) => p.kind !== 'generic');
// final tie-break: the order of fingerprints.json (registry order; the widely used ATSs come first)
const ORDER = new Map(FINGERPRINTS.map((p, i) => [p.id, i]));
const anyOf = (list) => (list.length ? new RegExp(list.map((r) => `(?:${r.source})`).join('|'), 'i') : null);
for (const p of ACTIVE) { p.hostAny = anyOf(p.hostRx); p.urlAny = anyOf(p.urlRx); }
// one pre-filter over every host and URL pattern, so most page references cost two regex tests instead of one per source
const ALL_HOST = anyOf(ACTIVE.flatMap((p) => p.hostRx));
const ALL_URL = anyOf(ACTIVE.flatMap((p) => p.urlRx));
const ALL_API = anyOf(ACTIVE.flatMap((p) => p.apiRx));
const ALL_EXTRA = anyOf(ACTIVE.flatMap((p) => Object.entries(p.htmlRx).filter(([k]) => k !== 'markup' && k !== 'meta_generator' && k !== 'jsonld').flatMap(([, v]) => v)));
const SLUG_RX = new Map();
const slugRx = (pattern) => { let r = SLUG_RX.get(pattern); if (!r) { r = new RegExp(pattern, 'i'); SLUG_RX.set(pattern, r); } return r; };

/** True when the host is one of some source's vendor hosts (a hosted board, not the employer's own site). */
export const isVendorHost = (h) => !!h && ACTIVE.some((p) => p.kind !== 'site' && p.hostRx.some((r) => r.test(h)));

/** The slug for a source from one evidence URL (or markup text), by the row's slug rules; null when none applies. */
export function slugFor(fp, evidenceUrl, { pageUrl = '' } = {}) { return slugRule(fp, evidenceUrl, pageUrl)?.slug ?? null; }

// { slug, from } of the first rule that applies. 'url' / 'detect' read the tenant from a board URL (strong); 'origin' / 'host' / 'page'
// name the employer's own host and apply only when the evidence is NOT on a vendor host (or there is no URL: markup, CNAME).
function slugRule(fp, evidenceUrl, pageUrl) {
  for (const rule of fp.slug ?? []) {
    let s = null;
    try {
      if (rule.from === 'url' && evidenceUrl) s = evidenceUrl.match(slugRx(rule.pattern))?.[rule.group ?? 1] ?? null;
      else if (rule.from === 'detect' && evidenceUrl && fp.provider && typeof providers[fp.provider]?.detect === 'function') s = providers[fp.provider].detect(evidenceUrl) || null;
      else if (rule.from === 'const') s = rule.value ?? null;
      else if (rule.from === 'ref' && evidenceUrl && /[?&]company=[A-Za-z0-9_-]+/.test(evidenceUrl)) s = evidenceUrl;
      else if (['origin', 'host', 'page'].includes(rule.from)) {
        const base = evidenceUrl ? (isVendorHost(hostOf(evidenceUrl)) ? '' : evidenceUrl) : (pageUrl && !isVendorHost(hostOf(pageUrl)) ? pageUrl : '');
        if (base) { const x = new URL(base); s = rule.from === 'origin' ? x.origin : rule.from === 'page' ? x.href.split('#')[0] : x.host; }
      }
    } catch { s = null; }
    if (s && typeof s === 'string' && !NOT_SLUG.test(s)) return { slug: s, from: rule.from };
  }
  return null;
}

/** Everything a page references, by the tag that references it, plus meta generator values and JSON-LD blocks. */
export function pageFeatures(html = '', pageUrl = '') {
  const refs = [];
  const seen = new Set();
  const add = (kind, raw) => {
    try {
      const u = new URL(decode(String(raw).trim()), pageUrl || undefined);
      if (!/^https?:$/.test(u.protocol)) return;
      const k = kind + ' ' + u.href;
      if (!seen.has(k)) { seen.add(k); refs.push({ kind, url: u.href }); }
    } catch { /* not a URL */ }
  };
  for (const m of html.matchAll(/<(script|iframe|frame|embed|object|form|link|a|img)\b([^>]*)>/gi)) {
    const tag = m[1].toLowerCase(), attrs = m[2];
    const attr = (n) => attrs.match(new RegExp(`\\b${n}\\s*=\\s*["']([^"'<>]{4,800})["']`, 'i'))?.[1];
    if (tag === 'script') { const s = attr('src'); if (s) add('script_src', s); }
    else if (tag === 'iframe' || tag === 'frame' || tag === 'embed') { const s = attr('src') ?? attr('data-src'); if (s) add('iframe_src', s); }
    else if (tag === 'object') { const s = attr('data'); if (s) add('iframe_src', s); }
    else if (tag === 'form') { const s = attr('action'); if (s) add('form_action', s); }
    else if (tag === 'link') { const s = attr('href'); if (s && !/\bstylesheet\b|\bicon\b|preconnect|dns-prefetch/i.test(attrs)) add('link_href', s); else if (s) add('inline', s); }
    else if (tag === 'a') { const s = attr('href'); if (s) add('link_href', s); }
    for (const d of attrs.matchAll(/\bdata-[\w-]*(?:url|src|href)[\w-]*\s*=\s*["']([^"'<>\s]{4,500})["']/gi)) add('inline', d[1]);
  }
  // absolute URLs in inline scripts and JSON (widget configs); JSON-LD URLs are counted separately below
  const noLd = html.replace(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi, ' ');
  for (const m of noLd.matchAll(/https?:\\?\/\\?\/[\w.-]+(?:\\?\/[^"'<>\s\\)]*)?/g)) add('inline', m[0].replace(/\\\//g, '/'));
  const jsonld = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    jsonld.push(m[1]);
    for (const u of m[1].matchAll(/https?:\\?\/\\?\/[\w.-]+(?:\\?\/[^"'<>\s\\)]*)?/g)) add('jsonld', u[0].replace(/\\\//g, '/'));
  }
  const generator = [...html.matchAll(/<meta\b[^>]*\bname\s*=\s*["']generator["'][^>]*>/gi)].map((m) => m[0].match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1] ?? '').filter(Boolean);
  return { refs, jsonld, generator };
}

/**
 * Detection without network. url: the careers URL as given; finalUrl: where it redirected (defaults to url); html: that page;
 * headers: response headers (object or Headers); cname: CNAME target of the careers host.
 */
export function detectOffline({ url = '', finalUrl = '', html = '', headers = null, cname = '', content = true } = {}) {
  const pageUrl = finalUrl || url;
  const pageDom = regDomain(hostOf(pageUrl));
  const ownDoms = new Set([regDomain(hostOf(url)), pageDom].filter(Boolean));
  const hits = new Map();
  const hit = (fp, kind, value, evUrl = '', captured = null) => {
    let h = hits.get(fp.id);
    if (!h) { h = { fp, kinds: new Map(), slugs: new Map(), count: 0 }; hits.set(fp.id, h); }
    h.count++;
    if (!h.kinds.has(kind)) h.kinds.set(kind, { kind, value: String(value).slice(0, 200), ...(evUrl ? { url: evUrl.slice(0, 300) } : {}) });
    // a pattern's own capture (an API path, an embed's ?for=) names the tenant directly
    const sr = captured && !NOT_SLUG.test(captured) ? { slug: captured, from: 'url' } : slugRule(fp, evUrl || (kind === 'markup' || kind === 'cname' || kind === 'meta_generator' || kind === 'header' ? '' : value), pageUrl);
    if (sr) {
      const w = WEIGHTS[kind] ?? 0.5;
      h.slugs.set(sr.slug, (h.slugs.get(sr.slug) ?? 0) + w);
      if (sr.from === 'url' || sr.from === 'detect' || sr.from === 'const') h.boardUrl = true;
    }
  };
  const matchesUrl = (fp, u, h) => !!(fp.hostAny?.test(h) || fp.urlAny?.test(u));
  // 1. the careers URL and its redirect target
  for (const [u, kind] of [[url, 'url'], [finalUrl && finalUrl !== url ? finalUrl : '', 'redirect']]) {
    const h = hostOf(u);
    if (!h) continue;
    for (const fp of ACTIVE) if (matchesUrl(fp, u, h)) hit(fp, kind, u, u);
  }
  // 2. CNAME of the careers host
  if (cname) for (const fp of ACTIVE) if (fp.cnameRx.some((r) => r.test(cname))) hit(fp, 'cname', `${hostOf(url)} -> ${cname}`);
  // 3. response headers
  if (headers) {
    const get = (n) => (typeof headers.get === 'function' ? headers.get(n) : headers[n] ?? headers[n.toLowerCase()]) ?? '';
    for (const fp of ACTIVE) for (const { name, rx } of fp.headerRx) { const v = get(name); if (v && rx.test(v)) hit(fp, 'header', `${name}: ${String(v).slice(0, 80)}`); }
  }
  // 4. the page
  let features = null;
  if (html) {
    features = pageFeatures(html, pageUrl);
    for (const ref of features.refs) {
      const h = hostOf(ref.url);
      if (!h) continue;
      const bare = ref.url.replace(/^https?:\/\//i, '');
      // an API endpoint of a source named in the page (a widget's data URL) is a signal of its own, wherever it sits
      if (ALL_API?.test(bare)) for (const fp of ACTIVE) { for (const r of fp.apiRx) { const m = bare.match(r); if (m) { hit(fp, 'api', h, ref.url, m[1] ?? null); break; } } }
      const vendorHost = !!ALL_HOST?.test(h);
      if (!(vendorHost || ALL_URL?.test(ref.url) || ALL_EXTRA?.test(ref.url))) continue;
      for (const fp of ACTIVE) {
        if (fp.page_refs === false) continue;
        // a single-employer reader counts only on the page's own domain (bwi.de linked from elsewhere is not this board)
        if (fp.kind === 'site' && !ownDoms.has(regDomain(h))) continue;
        let extra = false, cap = null;
        for (const r of fp.htmlRx[ref.kind] ?? []) { const m = ref.url.match(r); if (m) { extra = true; cap = m[1] ?? null; break; } }
        const onHost = !!fp.hostAny?.test(h);
        // a URL-pattern match off the vendor's hosts (a tenant's custom domain, a /jobs/1234567-title path) counts only on a vendor host
        // or the page's own domain, never on a link to some other site (v1's rule)
        const onUrl = !onHost && !!fp.urlAny?.test(ref.url) && (vendorHost || ownDoms.has(regDomain(h)));
        if (extra || onHost || onUrl) hit(fp, ref.kind, h, ref.url, cap);
      }
    }
    for (const fp of ACTIVE) {
      const mk = fp.htmlRx.markup?.find((r) => r.test(html));
      if (mk) hit(fp, 'markup', mk.source);
      const gen = fp.htmlRx.meta_generator && features.generator.find((g) => fp.htmlRx.meta_generator.some((r) => r.test(g)));
      if (gen) hit(fp, 'meta_generator', gen);
      const jl = fp.htmlRx.jsonld && features.jsonld.find((b) => fp.htmlRx.jsonld.some((r) => r.test(b)));
      if (jl) hit(fp, 'jsonld', 'JSON-LD');
    }
    // providers whose detect() reads markup (BITE embeds carry the tenant in a data attribute)
    const bite = ACTIVE.find((p) => p.provider === 'bite');
    if (bite) { try { const s = providers.bite.detect(html); if (s) { hit(bite, 'markup', 'data-bite-jobs-api-listing'); hits.get('bite').slugs.set(s, 9); } } catch { /* no */ } }
  }
  const out = [];
  for (const { fp, kinds, slugs, count, boardUrl } of hits.values()) {
    const mult = (k) => fp.weights?.[k] ?? 1;
    let conf = 1 - [...kinds.keys()].reduce((acc, k) => acc * (1 - Math.min(0.99, (WEIGHTS[k] ?? 0.5) * mult(k))), 1);
    const strong = [...kinds.keys()].some((k) => !['link_href', 'inline', 'jsonld'].includes(k));
    // a vendor reached only through ordinary links (a footer "jobs on Personio" link, a partner's board) is weaker than an embed
    if (!strong) conf *= 0.9;
    // a recognisable board URL (the source's own pattern names a tenant) is worth more than a bare vendor host
    if (boardUrl) conf = 1 - (1 - conf) * 0.85;
    const slug = [...slugs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    out.push({ provider: fp.provider, ...(fp.platform ? { platform: fp.platform } : {}), kind: fp.kind, slug, confidence: +conf.toFixed(3), hits: count, order: ORDER.get(fp.id) ?? 999, evidence: [...kinds.values()] });
  }
  if (html && content) out.push(...contentCandidates({ html, pageUrl, features, ats: out }));
  out.sort(byRank);
  return { url, candidates: out };
}

// Ranking: a named source (ATS or single-employer reader) at or above ATS_FLOOR outranks every generic proposal (the page's own job
// cards are usually that board rendered: the generic readers are the fallback cascade), then confidence, then a known slug, then hits.
export const ATS_FLOOR = 0.4;
// A named source without a slug (an unsupported tenant UI, a platform with no reader) is reported but is not a readable answer.
const tierOf = (c) => (c.kind !== 'generic' && c.provider && c.slug && c.confidence >= ATS_FLOOR ? 1 : 0);
export const byRank = (a, b) => tierOf(b) - tierOf(a) || b.confidence - a.confidence || (b.slug ? 1 : 0) - (a.slug ? 1 : 0) || (a.order ?? 999) - (b.order ?? 999) || (b.hits ?? 0) - (a.hits ?? 0);

/** The one answer for a page: the first readable candidate in rank order at or above minConfidence, else null. */
export function best(candidates, { minConfidence = ATS_FLOOR } = {}) {
  return candidates.find((c) => c.provider && c.slug && c.confidence >= minConfidence) ?? null;
}

/**
 * Detection with an optional fetch. Without html and with a fetch (or allowFetch), the careers page is fetched through the egress guard
 * (core/fetch/guard.mjs wraps whatever fetch is passed; lookupImpl is its DNS hook, for tests); then at most `follow` more pages: the
 * vendor iframe of the page, or its careers link when the page named no source.
 */
export async function detect({ url, html, finalUrl, headers, cname = '', fetch: fetchImpl, lookupImpl, allowFetch = false, follow = 1, timeoutMs = 20000, userAgent } = {}) {
  if (!url && !html) throw new TypeError('detect needs url or html');
  if (html || (!fetchImpl && !allowFetch)) return { ...detectOffline({ url, finalUrl, html: html ?? '', headers, cname }), fetched: [] };
  // every request goes through the egress guard, a caller's fetch too: the follow URL comes from page HTML (untrusted)
  const { makeGuardedFetch } = await import('../fetch/guard.mjs');
  const f = makeGuardedFetch(fetchImpl ?? globalThis.fetch, lookupImpl ? { lookupImpl } : {});
  const ua = userAgent ?? (await import('../../crawler/useragent.mjs')).UA;
  const fetched = [];
  const get = async (u) => {
    const r = await f(u, { headers: { 'user-agent': ua, accept: 'text/html,application/xhtml+xml,*/*' }, signal: AbortSignal.timeout(timeoutMs) });
    const body = /html|xml|text|json/i.test(r.headers?.get?.('content-type') ?? 'text/html') ? (await r.text()).slice(0, 3_000_000) : '';
    fetched.push({ url: u, final: r.url || u, status: r.status, bytes: body.length });
    return { final: r.url || u, html: body, headers: r.headers };
  };
  let page;
  try { page = await get(url); } catch (e) { return { ...detectOffline({ url, cname }), fetched, error: String(e?.message ?? e) }; }
  let res = detectOffline({ url, finalUrl: page.final, html: page.html, headers: page.headers, cname });
  const top = best(res.candidates.filter((c) => c.kind !== 'generic'), { minConfidence: 0.8 });
  if (follow > 0 && !top) {
    // one follow: the iframe that carries a board, else the page's careers link
    const feats = pageFeatures(page.html, page.final);
    const iframe = feats.refs.find((r) => r.kind === 'iframe_src' && /job|career|karriere|stellen|recruit|bewerb|vacanc/i.test(r.url));
    const careers = !res.candidates.some((c) => c.kind !== 'generic') && feats.refs.find((r) => r.kind === 'link_href' && regDomain(hostOf(r.url)) === regDomain(hostOf(page.final)) && r.url !== page.final
      && /\/(?:karriere|careers?|jobs?|stellen(?:angebote)?|vacancies|offene-stellen|join-us|work-with-us)(?:[/?#]|$)/i.test(new URL(r.url).pathname + '/'));
    const next = iframe?.url ?? (careers ? careers.url : null);
    if (next) {
      try {
        const p2 = await get(next);
        const r2 = detectOffline({ url: next, finalUrl: p2.final, html: p2.html, headers: p2.headers });
        const merged = new Map(res.candidates.map((c) => [`${c.provider}\t${c.slug}`, c]));
        for (const c of r2.candidates) {
          const k = `${c.provider}\t${c.slug}`;
          const cur = merged.get(k);
          if (!cur || c.confidence > cur.confidence) merged.set(k, { ...c, evidence: [...c.evidence, { kind: 'follow', value: next }] });
        }
        res = { url, candidates: [...merged.values()].sort(byRank) };
      } catch (e) { fetched.push({ url: next, error: String(e?.message ?? e) }); }
    }
  }
  return { ...res, fetched };
}

/** Rows for docs and the coverage test: every registry provider must have a fingerprint row. */
export function coverage() {
  const ids = new Set(FINGERPRINTS.map((p) => p.provider).filter(Boolean));
  return { providers: Object.keys(providers).length, covered: Object.keys(providers).filter((k) => ids.has(k)).length, missing: Object.keys(providers).filter((k) => !ids.has(k)) };
}
