// Conditional-request cache (design §0.1 "byte win first", phase 1d). For hosts switched on in the profile, a GET is sent with the
// validators of the last 200 answer (If-None-Match / If-Modified-Since). A 304 is turned back into the cached 200 body for the caller, so
// the source code is unchanged and parses the same bytes: the read is exactly as complete as the answer it validates (Fable 5).
// Off unless the profile lists hosts: crawl.conditional_cache = { "hosts": ["api.ashbyhq.com", "*.teamtailor.com"], "max_mb": 20 }.
// Which hosts honour validators is measured first (bench/analyse.mjs: probe 304 rate per host), then switched on host by host.
// Only plain GETs: no body, no caller-set conditional headers. Responses over max_mb are not cached. Cache: <data>/http-cache/.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const stats = { revalidated: 0, stored: 0, refreshed: 0, bypass: 0, errors: 0, savedBytes: 0 };
export const conditionalStats = () => ({ ...stats });

export function hostMatcher(patterns = []) {
  const exact = new Set(), suffix = [];
  for (const p of patterns) { const s = String(p).toLowerCase().trim(); if (s.startsWith('*.')) suffix.push(s.slice(1)); else if (s) exact.add(s); }
  return (host) => { const h = String(host).toLowerCase(); return exact.has(h) || suffix.some((x) => h.endsWith(x)); };
}

const hdr = (init, name) => {
  const h = init?.headers;
  if (!h) return undefined;
  if (typeof h.get === 'function') return h.get(name) ?? undefined;
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return v;
  return undefined;
};

export function makeConditionalFetch(base, { dir, hosts = [], maxBytes = 20e6 } = {}) {
  const match = hostMatcher(hosts);
  mkdirSync(dir, { recursive: true });
  return async function conditionalFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' || init?.body != null || !match(host) || hdr(init, 'if-none-match') || hdr(init, 'if-modified-since')) { stats.bypass++; return base(input, init); }
    const key = createHash('sha256').update(`${url}\u0000${hdr(init, 'accept') ?? ''}`).digest('hex').slice(0, 40);
    const metaF = join(dir, `${key}.json`), bodyF = join(dir, `${key}.gz`);
    let meta = null;
    try { if (existsSync(metaF) && existsSync(bodyF)) meta = JSON.parse(readFileSync(metaF, 'utf8')); } catch { meta = null; }
    const headers = new Headers(init?.headers ?? {});
    if (meta?.etag) headers.set('if-none-match', meta.etag);
    if (meta?.lm) headers.set('if-modified-since', meta.lm);
    const res = await base(input, { ...init, headers });
    try {
      if (res.status === 304 && meta) {
        const body = gunzipSync(readFileSync(bodyF));
        stats.revalidated++; stats.savedBytes += body.length;
        return new Response(body, { status: 200, headers: { 'content-type': meta.ct || 'application/octet-stream', 'x-jobcrawl-cache': 'revalidated', ...(meta.etag ? { etag: meta.etag } : {}), ...(meta.lm ? { 'last-modified': meta.lm } : {}) } });
      }
      if (res.status === 200 && (res.headers.get('etag') || res.headers.get('last-modified'))) {
        const buf = Buffer.from(await res.clone().arrayBuffer());
        if (buf.length <= maxBytes) {
          writeFileSync(`${bodyF}.tmp`, gzipSync(buf)); renameSync(`${bodyF}.tmp`, bodyF);
          writeFileSync(`${metaF}.tmp`, JSON.stringify({ url, etag: res.headers.get('etag'), lm: res.headers.get('last-modified'), ct: res.headers.get('content-type'), at: new Date().toISOString(), bytes: buf.length }));
          renameSync(`${metaF}.tmp`, metaF);
          if (meta) stats.refreshed++; else stats.stored++;
        }
      }
    } catch { stats.errors++; }
    return res;
  };
}

let installed = false;
/** Wraps globalThis.fetch (outermost, after the crawl policy guard). Returns false when no host is switched on. */
export function installConditionalCache({ dir, hosts = [], maxMb = 20 } = {}) {
  if (installed || !hosts.length) return installed;
  globalThis.fetch = makeConditionalFetch(globalThis.fetch, { dir, hosts, maxBytes: maxMb * 1e6 });
  installed = true;
  return true;
}
