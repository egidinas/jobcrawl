// SSRF guard for URLs that come from users or agents (detect, MCP tools): only http(s) to public addresses, every redirect hop checked,
// and the address checked at resolve time (a name that resolves to a private address is refused; the check is repeated per hop, which
// narrows DNS rebinding to the window between the lookup and the connect; pinning the connect to the checked address is planned in the
// FetchBackend). Setting `allow_private_targets: true` turns it off for an operator who wants to crawl an intranet.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SsrfError extends Error {}

/** True for loopback, private, link-local, CGNAT, multicast, unspecified and other non-public addresses (IPv4 and IPv6). */
export function isPrivateAddress(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (m) return isPrivateAddress(m[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true;
}

/** Throws SsrfError unless the URL is http(s) and every address its host resolves to is public. */
export async function assertPublicUrl(url, { lookupImpl = lookup } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new SsrfError(`not a URL: ${url}`); }
  if (!/^https?:$/.test(u.protocol)) throw new SsrfError(`only http and https are allowed: ${url}`);
  if (u.username || u.password) throw new SsrfError('URLs with credentials are refused');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookupImpl(host, { all: true, verbatim: true });
  if (!addrs.length) throw new SsrfError(`${host} does not resolve`);
  for (const a of addrs) if (isPrivateAddress(a.address)) throw new SsrfError(`${host} resolves to a non-public address (${a.address})`);
  return u;
}

/** GET with every redirect hop checked by assertPublicUrl. */
export async function safeFetch(url, init = {}, { maxHops = 5, fetchImpl = globalThis.fetch, lookupImpl } = {}) {
  let cur = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertPublicUrl(cur, { lookupImpl });
    const res = await fetchImpl(cur, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { cur = new URL(res.headers.get('location'), cur).href; continue; }
    return res;
  }
  throw new SsrfError(`more than ${maxHops} redirects`);
}
