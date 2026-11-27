// Board identification from several signals, with a confidence per platform. Data: fingerprints.json (schema fingerprints-v1, JOBCRAWLX design) (one row per career platform).
//
// Signals over the pages the profiler fetched (and, optionally, the CNAME of the careers host), strongest first:
//   page_host    a fetched page (or the URL it was requested as, before redirects) is on the vendor's host        0.95
//   cname        the careers host is a CNAME to the vendor (careers.acme.com -> acme.teamtailor.com)              0.90
//   embed_host   a script, iframe or form on the page loads from the vendor's host                                0.80
//   link_host    a link on the page points at the vendor's host                                                    0.60
//   markup       class names, asset paths, footers only this platform writes                                       0.60
// Confidence = 1 - prod(1 - w) over the distinct kinds seen. The slug comes from the provider's own detect() on a vendor URL when one
// is there; otherwise, for platforms that serve boards on the employer's own host (fingerprints.json "slug": origin|host), from the
// careers page the markup or CNAME was seen on. Every candidate is still verified by the provider's fetch before the profiler uses it.
import { readFileSync } from 'node:fs';
import { providers } from '../providers.mjs';

const DATA = JSON.parse(readFileSync(new URL('./fingerprints.json', import.meta.url), 'utf8'));
const rx = (list = []) => list.map((s) => new RegExp(s, 'i'));
export const PLATFORMS = DATA.platforms.map((p) => ({ ...p, hostRx: rx(p.hosts), cnameRx: rx(p.cname), markupRx: rx(p.markup) }));
export const WEIGHTS = { page_host: 0.95, cname: 0.9, embed_host: 0.8, link_host: 0.6, markup: 0.6 };

const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };
const decodeAmp = (s) => String(s).replace(/&amp;/g, '&');
/** True when the host belongs to some platform's vendor hosts (a hosted board, not the employer's site). */
export const isVendorHost = (h) => PLATFORMS.some((p) => p.hostRx.some((r) => r.test(h)));

/** URLs a page loads (script/iframe/embed/form) and links to (a href), absolute. */
export function pageRefs(html = '', pageUrl = '') {
  const embeds = new Set(), links = new Set();
  const add = (set, raw) => { try { const u = new URL(decodeAmp(raw.trim()), pageUrl); if (/^https?:$/.test(u.protocol)) set.add(u.href); } catch {} };
  for (const m of html.matchAll(/<(script|iframe|embed|form|link)\b[^>]*?\b(?:src|action|href)\s*=\s*["']([^"'<>\s]{4,500})["']/gi)) add(m[1].toLowerCase() === 'link' ? links : embeds, m[2]);
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"'<>\s]{4,500})["']/gi)) add(links, m[1]);
  // URLs in inline scripts and JSON (widget configs, JSON-LD hiringOrganization.sameAs / url)
  for (const m of html.matchAll(/https?:\\?\/\\?\/[\w.-]+(?:\\?\/[^"'<>\s\\)]*)?/g)) add(links, m[0].replace(/\\\//g, '/'));
  return { embeds: [...embeds], links: [...links] };
}

/** A provider slug from a vendor URL via the provider's own detect(); null when it gives none. */
function slugFromUrl(provider, url) {
  const p = providers[provider];
  if (!p || typeof p.detect !== 'function') return null;
  try { const s = p.detect(url); return s && typeof s === 'string' && !/^(?:embed|js|job_board|jobs|careers|api|v\d+|www|app|static|assets|cdn|widget)$/i.test(s) ? s : null; } catch { return null; }
}

/**
 * Platforms behind a set of fetched pages.
 * @param {{ pages: { url: string, requested?: string, html?: string }[], cnames?: Record<string, string> }} input
 * @returns {{ id, provider, confidence, signals: { kind, value }[], slug: string|null, slugVia: string }[]} best first
 */
export function identifyPlatforms({ pages = [], cnames = {} } = {}) {
  const hits = new Map();
  const hit = (p, kind, value, url = '') => {
    const h = hits.get(p.id) ?? { p, kinds: new Map(), urls: new Set(), pagesSeen: new Set() };
    if (!h.kinds.has(kind)) h.kinds.set(kind, value);
    if (url) h.urls.add(url);
    hits.set(p.id, h);
    return h;
  };
  for (const pg of pages) {
    const html = pg.html ?? '';
    for (const [u, isReq] of [[pg.url, false], [pg.requested, true]]) {
      const h = hostOf(u);
      if (!h) continue;
      for (const p of PLATFORMS) if (p.hostRx.some((r) => r.test(h))) hit(p, 'page_host', isReq ? `requested ${h}` : h, u);
      const cn = cnames[h];
      if (cn) for (const p of PLATFORMS) if (p.cnameRx.some((r) => r.test(cn))) hit(p, 'cname', `${h} -> ${cn}`).pagesSeen.add(pg.url);
    }
    if (!html) continue;
    const { embeds, links } = pageRefs(html, pg.url);
    for (const [kind, list] of [['embed_host', embeds], ['link_host', links]]) {
      for (const u of list) {
        const h = hostOf(u);
        for (const p of PLATFORMS) if (p.hostRx.some((r) => r.test(h))) hit(p, kind, h, u);
      }
    }
    for (const p of PLATFORMS) {
      const r = p.markupRx.find((x) => x.test(html));
      if (r) hit(p, 'markup', r.source).pagesSeen.add(pg.url);
    }
  }
  const out = [];
  for (const { p, kinds, urls, pagesSeen } of hits.values()) {
    const confidence = 1 - [...kinds.keys()].reduce((acc, k) => acc * (1 - (WEIGHTS[k] ?? 0.5)), 1);
    let slug = null, slugVia = '';
    if (p.provider) {
      for (const u of urls) { slug = slugFromUrl(p.provider, u); if (slug) { slugVia = u; break; } }
      if (!slug && p.slug) {
        // the board sits on the employer's own host: the page the markup or CNAME was seen on names it
        const own = [...pagesSeen].find((u) => !isVendorHost(hostOf(u)));
        if (own) { const x = new URL(own); slug = p.slug === 'origin' ? x.origin : x.host; slugVia = `${p.slug} of ${own}`; }
      }
    }
    out.push({ id: p.id, provider: p.provider, confidence: +confidence.toFixed(3), signals: [...kinds].map(([kind, value]) => ({ kind, value })), slug, slugVia });
  }
  return out.sort((a, b) => b.confidence - a.confidence || (b.slug ? 1 : 0) - (a.slug ? 1 : 0));
}

/** CNAME target of a host ('' when none or on any DNS error); a short timeout so a slow resolver never holds a profile up. */
export async function cnameOf(host, timeoutMs = 3000) {
  if (!host) return '';
  try {
    const { resolveCname } = await import('node:dns/promises');
    const r = await Promise.race([resolveCname(host), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
    return String(r?.[0] ?? '').toLowerCase();
  } catch { return ''; }
}
