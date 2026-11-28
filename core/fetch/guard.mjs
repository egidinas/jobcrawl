// The engine-wide egress guard and abort plumbing, wrapped around a fetch (design §3.8 / §8, review item "one egress guard").
//   makeGuardedFetch(base, opts) returns a fetch that, for EVERY request and EVERY redirect hop:
//     * accepts only http(s) without credentials and refuses `localhost`, `*.localhost`, and any host whose addresses are not all public
//       (private, loopback, link-local, CGNAT, ULA, mapped/NAT64/6to4/Teredo forms, metadata). The WHATWG URL parser has already turned
//       decimal / octal / hex spellings (2130706433, 0177.0.0.1, 0x7f.1) into dotted form; the bytes check then refuses them.
//     * follows redirects itself (`redirect: 'manual'` towards `base`) and re-checks each hop; a caller's redirect 'manual' gets the 3xx
//       back (after the check), 'error' throws on a redirect.
//     * resolves the name AGAIN once the response headers are in and refuses when the answer now contains a non-public address, so a
//       rebinding name (public at the check, private at the connect) does not deliver its body. This narrows the window; it does not
//       pin the connection (that needs a connection-level hook the global fetch lacks; listed as an open risk).
//     * merges the board's ambient signal (core/fetch/context.mjs) into init.signal, so a board budget aborts requests in flight.
//   opts: allowPrivate (operator opt-out, default false), testAllowHosts (hosts exempt from the address check, TEST USE ONLY: it exists
//   so a local slow server can be reached; it never widens to a name that is not listed), lookupImpl, maxHops (10), recheck (true),
//   egress (false turns the address check off but keeps the signal merge).
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { currentSignal } from './context.mjs';
import { isPrivateAddress, SsrfError } from './ssrf.mjs';

const bare = (h) => String(h).replace(/^\[|\]$/g, '').toLowerCase();

export function makeGuardedFetch(base = globalThis.fetch, { allowPrivate = false, testAllowHosts = [], lookupImpl = lookup, maxHops = 10, recheck = true, egress = true } = {}) {
  const allow = new Set(testAllowHosts.map(bare));
  const check = egress && !allowPrivate;

  async function vet(u, phase) {
    if (!/^https?:$/.test(u.protocol)) throw new SsrfError(`only http and https are allowed: ${u.href}`);
    if (u.username || u.password) throw new SsrfError('URLs with credentials are refused');
    const host = bare(u.hostname);
    if (allow.has(host)) return;
    if (host === 'localhost' || host.endsWith('.localhost')) throw new SsrfError(`${host} is a loopback name`);
    const addrs = isIP(host) ? [{ address: host }] : await lookupImpl(host, { all: true, verbatim: true });
    if (!addrs?.length) throw new SsrfError(`${host} does not resolve`);
    for (const a of addrs) if (isPrivateAddress(a.address)) throw new SsrfError(`${host} resolves to a non-public address (${a.address})${phase ? ` ${phase}` : ''}`);
  }

  return async function guardedFetch(input, init = {}) {
    const isReq = typeof input !== 'string' && !(input instanceof URL);
    let cur;
    try { cur = new URL(isReq ? input.url : String(input)); } catch { if (check) throw new SsrfError(`not a URL: ${String(input)}`); return base(input, init); }
    const sigs = [init.signal ?? (isReq ? input.signal : null), currentSignal()].filter(Boolean);
    const signal = sigs.length > 1 ? AbortSignal.any(sigs) : sigs[0];
    const mode = init.redirect ?? (isReq ? input.redirect : 'follow') ?? 'follow';
    let method = String(init.method ?? (isReq ? input.method : 'GET')).toUpperCase();
    let o = { ...(isReq ? { method: input.method, headers: input.headers } : {}), ...init, ...(signal ? { signal } : {}) };
    if (!check) { signal?.throwIfAborted(); return base(isReq ? input.url : input, o); }
    for (let hop = 0; ; hop++) {
      signal?.throwIfAborted();
      await vet(cur, hop ? `(redirect hop ${hop})` : '');
      const res = await base(cur.href, { ...o, redirect: 'manual' });
      if (recheck && !isIP(bare(cur.hostname)) && !allow.has(bare(cur.hostname))) {
        try { await vet(cur, '(second resolution)'); }
        catch (e) { try { await res.body?.cancel(); } catch { /* dropped */ } throw e; }
      }
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc || mode === 'manual') return res;
      try { await res.body?.cancel(); } catch { /* dropped */ }
      if (mode === 'error') throw new TypeError(`redirect to ${loc} refused (redirect: error)`);
      if (hop >= maxHops) throw new SsrfError(`more than ${maxHops} redirects`);
      const next = new URL(loc, cur);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; const { body, ...rest } = o; o = { ...rest, method }; }
      if (next.origin !== cur.origin) {   // never carry credentials to another origin
        const h = new Headers(o.headers ?? {}); h.delete('authorization'); h.delete('cookie'); o = { ...o, headers: h };
      }
      cur = next;
    }
  };
}

let installed = null;
/**
 * Wraps globalThis.fetch once (idempotent). Returns the function that removes it. Used by the new engine paths (CLI, MCP, runBoard).
 * The legacy live crawl does not call this; it has its own switch (crawler/policy.mjs: JOBCRAWL_EGRESS_GUARD / crawl.egress_guard).
 */
export function installEngineFetch(opts = {}) {
  if (installed) return installed;
  const base = globalThis.fetch;
  const allowPrivate = opts.allowPrivate ?? /^(1|true|yes)$/i.test(process.env.JOBCRAWL_ALLOW_PRIVATE_TARGETS ?? '');
  globalThis.fetch = makeGuardedFetch(base, { ...opts, allowPrivate });
  installed = () => { globalThis.fetch = base; installed = null; };
  return installed;
}
