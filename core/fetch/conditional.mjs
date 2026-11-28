// Conditional-request cache (design §0.1 "byte win first", phase 1d). For hosts switched on in the profile, a GET is sent with the
// validators of the last 200 answer (If-None-Match / If-Modified-Since). A 304 is turned back into the cached 200 for the caller, with the
// original final URL (res.url) and the stored response headers, so source code parses the same bytes: the read is exactly as complete as
// the answer it validates (Fable 5).
// Off unless the profile lists hosts: crawl.conditional_cache = { "hosts": ["api.ashbyhq.com", "*.teamtailor.com"], "max_mb": 20,
// "total_mb": 500, "dir": "<path outside the data folder>" }. Hosts are switched on only after bench/analyse.mjs shows real 304s.
// Correctness rules (phase-1 review):
//   * Vary: the request headers a response varies on are part of the cache key (Vary: * or a Cookie/Authorization vary = not cached)
//   * an answer that sets cookies is never cached (cookie/CSRF flows need fresh cookies), and neither is one over max_mb (checked from
//     Content-Length before buffering, and again after)
//   * a hit keeps the final URL and the stored headers (minus hop-by-hop and length/encoding headers)
//   * a corrupt cached body drops the entry and the request is sent again WITHOUT validators
//   * total size cap with eviction of the least recently used entries
//   * only plain GETs given as a URL string or URL (a Request object is passed through untouched): no body, no caller-set conditional
//     headers; nothing in dry runs (the caller does not install it then)
//   * an entry older than max_age_days (default 7) is not revalidated: the request goes out unconditionally and refreshes it
//   * anything that goes wrong while serving a 304 (an unreadable or undeletable entry, a stored header Response refuses) drops the
//     entry when it can and sends the request again WITHOUT validators: a bare 304 never reaches the caller
//   * temp files are per process (<name>.<pid>.tmp), so several crawls can share one cache folder
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const stats = { revalidated: 0, stored: 0, refreshed: 0, bypass: 0, uncacheable: 0, corrupt: 0, expired: 0, recovered: 0, evicted: 0, errors: 0, savedBytes: 0 };
export const conditionalSummary = () => `conditional cache: ${stats.revalidated} served from cache after a 304 (${(stats.savedBytes / 1e6).toFixed(1)} MB not downloaded), ${stats.stored} stored, ${stats.refreshed} refreshed, ${stats.expired} expired (full fetch), ${stats.uncacheable} not cacheable, ${stats.corrupt} corrupt + ${stats.recovered} recovered (refetched without validators), ${stats.evicted} evicted, ${stats.bypass} passed through, ${stats.errors} errors`;
export const conditionalStats = () => ({ ...stats });
const DROP_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie', 'date', 'age']);
const NO_CACHE_VARY = new Set(['*', 'cookie', 'authorization']);

export function hostMatcher(patterns = []) {
  const exact = new Set(), suffix = [];
  for (const p of patterns) { const s = String(p).toLowerCase().trim(); if (s.startsWith('*.')) suffix.push(s.slice(1)); else if (s) exact.add(s); }
  return (host) => { const h = String(host).toLowerCase(); return exact.has(h) || suffix.some((x) => h.endsWith(x)); };
}

const reqHeader = (init, name) => {
  const h = init?.headers;
  if (!h) return undefined;
  if (typeof h.get === 'function') return h.get(name) ?? undefined;
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return v;
  return undefined;
};
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 40);

export function makeConditionalFetch(base, { dir, hosts = [], maxBytes = 20e6, totalBytes = 500e6, maxAgeMs = 7 * 864e5, onServed = null, now = Date.now } = {}) {
  const match = hostMatcher(hosts);
  mkdirSync(dir, { recursive: true });
  let index = null;   // key -> { bytes, used } (lazy)
  const loadIndex = () => {
    if (index) return index;
    index = new Map();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json') || f.endsWith('.vary.json')) continue;
      try { const m = JSON.parse(readFileSync(join(dir, f), 'utf8')); index.set(f.slice(0, -5), { bytes: m.stored_bytes ?? 0, used: Date.parse(m.used ?? m.at) || 0 }); } catch {}
    }
    return index;
  };
  const drop = (key) => { for (const ext of ['.json', '.gz']) { try { rmSync(join(dir, `${key}${ext}`), { force: true }); } catch { stats.errors++; } } index?.delete(key); };
  const tmpOf = (f) => `${f}.${process.pid}.tmp`;
  const evict = () => {
    const idx = loadIndex();
    let total = [...idx.values()].reduce((s, x) => s + x.bytes, 0);
    if (total <= totalBytes) return;
    for (const [k, x] of [...idx.entries()].sort((a, b) => a[1].used - b[1].used)) { if (total <= totalBytes) break; drop(k); total -= x.bytes; stats.evicted++; }
  };
  const keyFor = (url, init, varyNames) => sha([url, reqHeader(init, 'accept') ?? '', ...varyNames.map((n) => `${n}=${reqHeader(init, n) ?? ''}`)].join('\u0000'));

  return async function conditionalFetch(input, init = {}) {
    if (typeof input !== 'string' && !(input instanceof URL)) { stats.bypass++; return base(input, init); }   // a Request object: untouched
    const url = String(input);
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' || init?.body != null || !match(host) || reqHeader(init, 'if-none-match') || reqHeader(init, 'if-modified-since')) { stats.bypass++; return base(input, init); }
    const baseKey = sha(`${url}\u0000${reqHeader(init, 'accept') ?? ''}`);
    let varyNames = [];
    try { if (existsSync(join(dir, `${baseKey}.vary.json`))) varyNames = JSON.parse(readFileSync(join(dir, `${baseKey}.vary.json`), 'utf8')); } catch {}
    const key = varyNames.length ? keyFor(url, init, varyNames) : baseKey;
    const metaF = join(dir, `${key}.json`), bodyF = join(dir, `${key}.gz`);
    let meta = null;
    try { if (existsSync(metaF) && existsSync(bodyF)) meta = JSON.parse(readFileSync(metaF, 'utf8')); } catch { meta = null; }
    if (meta && maxAgeMs > 0 && now() - (Date.parse(meta.at) || 0) > maxAgeMs) { stats.expired++; meta = null; }   // too old: full fetch
    const headers = new Headers(init?.headers ?? {});
    if (meta?.etag) headers.set('if-none-match', meta.etag);
    if (meta?.lm) headers.set('if-modified-since', meta.lm);
    const res = await base(input, { ...init, headers });
    try {
      if (res.status === 304 && meta) {
        let body;
        try { body = gunzipSync(readFileSync(bodyF)); if (meta.sha && createHash('sha256').update(body).digest('hex') !== meta.sha) throw new Error('hash'); }
        catch { stats.corrupt++; drop(key); return base(input, init); }      // corrupt entry: dropped (best effort), asked again without validators
        stats.revalidated++; stats.savedBytes += body.length;
        const out = new Response(body, { status: 200, headers: { ...(meta.headers ?? {}), 'x-jobcrawl-cache': 'revalidated' } });
        Object.defineProperty(out, 'url', { value: meta.final_url ?? url });
        Object.defineProperty(out, 'redirected', { value: Boolean(meta.redirected) });
        if (onServed) { try { onServed({ url, ct: meta.headers?.['content-type'] ?? '', body }); } catch {} }
        const nowIso = new Date(now()).toISOString();
        try { writeFileSync(metaF, JSON.stringify({ ...meta, used: nowIso })); loadIndex().set(key, { bytes: meta.stored_bytes ?? 0, used: Date.parse(nowIso) }); } catch {}
        return out;
      }
      if (res.status === 200 && (res.headers.get('etag') || res.headers.get('last-modified'))) {
        const vary = String(res.headers.get('vary') ?? '').toLowerCase().split(',').map((s) => s.trim()).filter((s) => s && s !== 'accept-encoding' && s !== 'accept');
        const clen = Number(res.headers.get('content-length'));
        if (vary.some((v) => NO_CACHE_VARY.has(v)) || res.headers.get('set-cookie') || (Number.isFinite(clen) && clen > maxBytes)) { stats.uncacheable++; return res; }
        const buf = Buffer.from(await res.clone().arrayBuffer());
        if (buf.length > maxBytes) { stats.uncacheable++; return res; }
        const storeKey = vary.length ? keyFor(url, init, vary) : baseKey;
        if (vary.length) writeFileSync(join(dir, `${baseKey}.vary.json`), JSON.stringify(vary));
        const gz = gzipSync(buf);
        const keep = {};
        for (const [k, v] of res.headers) if (!DROP_HEADERS.has(k)) keep[k] = v;
        const sf = join(dir, `${storeKey}`);
        writeFileSync(tmpOf(`${sf}.gz`), gz); renameSync(tmpOf(`${sf}.gz`), `${sf}.gz`);
        const stamp = new Date(now()).toISOString();
        writeFileSync(tmpOf(`${sf}.json`), JSON.stringify({ url, final_url: res.url || url, redirected: res.redirected, etag: res.headers.get('etag'), lm: res.headers.get('last-modified'),
          headers: keep, vary, at: stamp, used: stamp, bytes: buf.length, stored_bytes: gz.length, sha: createHash('sha256').update(buf).digest('hex') }));
        renameSync(tmpOf(`${sf}.json`), `${sf}.json`);
        loadIndex().set(storeKey, { bytes: gz.length, used: Date.parse(stamp) });
        if (meta) stats.refreshed++; else stats.stored++;
        evict();
      }
    } catch {
      stats.errors++;
      if (res.status === 304) {   // never hand a bare 304 to the caller: drop the entry (best effort) and ask again without validators
        stats.recovered++;
        drop(key);
        return base(input, init);
      }
    }
    return res;
  };
}

let installed = false;
/** Wraps globalThis.fetch (outermost, after the crawl policy guard). Returns false when no host is switched on. */
export function installConditionalCache({ dir, hosts = [], maxMb = 20, totalMb = 500, maxAgeDays = 7, onServed = null } = {}) {
  if (installed || !hosts.length) return installed;
  globalThis.fetch = makeConditionalFetch(globalThis.fetch, { dir, hosts, maxBytes: maxMb * 1e6, totalBytes: totalMb * 1e6, maxAgeMs: maxAgeDays * 864e5, onServed });
  installed = true;
  return true;
}
