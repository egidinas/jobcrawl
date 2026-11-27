// Conditional GET (ETag / Last-Modified revalidation) under the request-policy guard. OFF unless the profile turns it on
// (crawl.http_cache: { enabled: true, max_body_kb }); with it off nothing here runs and requests are exactly as before.
//
// How it works: a GET whose answer carried a validator (ETag or Last-Modified) and a text body (HTML, XML, JSON, RSS, plain text) of
// at most max_body_kb is stored (bytes as received, for at most 14 days) in <data>/http-cache/ (one small JSON file per URL + Accept). The next GET of that URL sends
// If-None-Match / If-Modified-Since; a 304 answer is turned back into a 200 with the stored body, so every provider, the sitemap
// cache and the profiler read it unchanged, at the cost of a few hundred bytes on the wire. A request that brings its own conditional
// headers, a body, or a method other than GET passes through untouched, as does every answer without a validator.
// A revalidated answer carries the header x-jobcrawl-cache: revalidated (counts in httpCacheStats()).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TEXTUAL = /^(?:text\/|application\/(?:[\w.+-]*\+)?(?:json|xml|javascript)|application\/rss|application\/atom)/i;
const stats = { stored: 0, revalidated: 0, sent: 0, savedBytes: 0 };
export const httpCacheStats = () => ({ ...stats });

const headerOf = (h, k) => {
  if (!h) return undefined;
  if (typeof h.get === 'function') return h.get(k) ?? undefined;
  if (Array.isArray(h)) return h.find(([n]) => String(n).toLowerCase() === k)?.[1];
  return Object.entries(h).find(([n]) => n.toLowerCase() === k)?.[1];
};
const withHeaders = (h, extra) => {
  const out = new Headers(h ?? {});
  for (const [k, v] of Object.entries(extra)) out.set(k, v);
  return out;
};

/**
 * A fetch that revalidates stored text answers. opts: { dir (required), maxBodyBytes = 5 MB }.
 * @param {typeof fetch} base
 */
export function makeConditionalFetch(base, { dir, maxBodyBytes = 5 * 1024 * 1024, maxAgeDays = 14 } = {}) {
  if (!dir) throw new Error('http cache: dir is required');
  mkdirSync(dir, { recursive: true });
  const keyOf = (url, accept) => createHash('sha1').update(`${url}\n${accept ?? ''}`).digest('hex');
  const pathOf = (k) => join(dir, k.slice(0, 2), `${k}.json`);
  // an entry older than maxAgeDays is not used (the next answer replaces it), so the store never serves a body from long ago
  const load = (k) => { try { const r = JSON.parse(readFileSync(pathOf(k), 'utf8')); return Date.now() - Date.parse(r.at) <= maxAgeDays * 864e5 ? r : null; } catch { return null; } };
  const save = (k, rec) => {
    try {
      const p = pathOf(k);
      mkdirSync(join(dir, k.slice(0, 2)), { recursive: true });
      writeFileSync(`${p}.tmp`, JSON.stringify(rec));
      renameSync(`${p}.tmp`, p);
      stats.stored++;
    } catch { /* a cache that cannot write is just no cache */ }
  };
  return async function conditionalFetch(input, init = {}) {
    const isReq = typeof input !== 'string' && !(input instanceof URL);
    const method = String(init.method ?? (isReq ? input.method : 'GET') ?? 'GET').toUpperCase();
    const hdrs = init.headers ?? (isReq ? input.headers : undefined);
    if (isReq || method !== 'GET' || init.body != null || headerOf(hdrs, 'if-none-match') || headerOf(hdrs, 'if-modified-since') || headerOf(hdrs, 'range')) return base(input, init);
    const url = String(input);
    const k = keyOf(url, headerOf(hdrs, 'accept'));
    const old = load(k);
    const cond = {};
    if (old?.etag) cond['if-none-match'] = old.etag;
    if (old?.lastModified) cond['if-modified-since'] = old.lastModified;
    if (Object.keys(cond).length) stats.sent++;
    const res = await base(url, Object.keys(cond).length ? { ...init, headers: withHeaders(hdrs, cond) } : init);
    if (res.status === 304 && old) {
      const bytes = Buffer.from(old.body64, 'base64');
      stats.revalidated++; stats.savedBytes += bytes.length;
      const out = new Response(bytes, { status: 200, statusText: 'OK', headers: withHeaders(old.headers, { 'x-jobcrawl-cache': 'revalidated' }) });
      Object.defineProperty(out, 'url', { value: old.url || url });
      return out;
    }
    const etag = res.headers.get('etag'), lastModified = res.headers.get('last-modified');
    const type = res.headers.get('content-type') ?? '';
    const len = Number(res.headers.get('content-length') ?? 0);
    if (res.status !== 200 || (!etag && !lastModified) || !TEXTUAL.test(type) || len > maxBodyBytes) return res;
    // store the body bytes as received (decoded transfer encoding, original charset: the caller decodes as before) and hand the
    // caller an equivalent response
    const bytes = Buffer.from(await res.arrayBuffer());
    const keep = { 'content-type': type };
    if (bytes.length <= maxBodyBytes) save(k, { url: res.url || url, etag, lastModified, headers: keep, body64: bytes.toString('base64'), at: new Date().toISOString() });
    const headers = new Headers(res.headers);
    headers.delete('content-encoding'); headers.delete('content-length');
    const out = new Response(bytes, { status: res.status, statusText: res.statusText, headers });
    Object.defineProperty(out, 'url', { value: res.url || url });
    if (res.redirected) Object.defineProperty(out, 'redirected', { value: true });
    return out;
  };
}
