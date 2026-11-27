// SSRF guard for URLs that come from users or agents (detect, MCP tools, webhooks): only http(s) to public addresses, every redirect
// hop checked, every resolved address checked. Addresses are parsed to BYTES and checked against ranges (never by string pattern), so
// every spelling of an address is caught: IPv4-mapped IPv6 in either form ([::ffff:127.0.0.1] and the normalised [::ffff:7f00:1]),
// IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::/96 and 6to4 2002::/16 (their embedded IPv4 is checked), site-local fec0::/10, ULA fc00::/7,
// link-local fe80::/10, multicast, documentation and discard prefixes, Teredo 2001::/32 (refused: its IPv4 is obfuscated).
// The check runs at resolve time and again per redirect hop; pinning the connection to the checked address (closing the DNS-rebinding
// window between lookup and connect) is planned in the FetchBackend. `allow_private_targets: true` turns the guard off for an operator
// who wants to crawl an intranet.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SsrfError extends Error {}

/** IPv4 string -> 4 bytes, or null. */
export function parseIPv4(s) {
  const p = String(s).split('.');
  if (p.length !== 4) return null;
  const b = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return b.every((x) => x >= 0 && x <= 255) ? b : null;
}

/** IPv6 string (with ::, embedded dotted IPv4, optional zone) -> 16 bytes, or null. */
export function parseIPv6(s) {
  let str = String(s).replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  let tail = [];
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(str);
  if (dotted) {
    const v4 = parseIPv4(dotted[1]);
    if (!v4) return null;
    tail = [((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16)];
    str = str.slice(0, -dotted[1].length) + tail.join(':');
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const grp = (h) => (h === '' ? [] : h.split(':'));
  const head = grp(halves[0]), rest = halves.length === 2 ? grp(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const words = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (words.length !== 8 || words.some((w) => !/^[0-9a-f]{1,4}$/.test(w))) return null;
  const bytes = [];
  for (const w of words) { const n = parseInt(w, 16); bytes.push(n >> 8, n & 255); }
  return bytes;
}

function v4Private(b) {
  const [a, c] = b;
  return a === 0 || a === 10 || a === 127 || (a === 100 && c >= 64 && c <= 127) || (a === 169 && c === 254) || (a === 172 && c >= 16 && c <= 31)
    || (a === 192 && c === 168) || (a === 192 && c === 0 && b[2] === 0) || (a === 192 && c === 0 && b[2] === 2) || (a === 198 && (c === 18 || c === 19))
    || (a === 198 && c === 51 && b[2] === 100) || (a === 203 && c === 0 && b[2] === 113) || a >= 224;
}

const prefix = (b, bytes, bits) => {
  for (let i = 0; i < bits; i++) {
    const bit = (x) => (x[i >> 3] >> (7 - (i & 7))) & 1;
    if (bit(b) !== bit(bytes)) return false;
  }
  return true;
};
const P6 = (s) => parseIPv6(s);

function v6Private(b) {
  const zero12 = b.slice(0, 12).every((x) => x === 0);
  if (zero12) {                                              // :: , ::1 and IPv4-compatible ::a.b.c.d
    const v4 = b.slice(12);
    if (v4.every((x) => x === 0) || (v4.slice(0, 3).every((x) => x === 0) && v4[3] === 1)) return true;
    return v4Private(v4);
  }
  if (prefix(b, P6('::ffff:0:0'), 96)) return v4Private(b.slice(12));          // IPv4-mapped
  if (prefix(b, P6('64:ff9b::'), 96)) return v4Private(b.slice(12));           // NAT64 well-known prefix
  if (prefix(b, P6('64:ff9b:1::'), 48)) return true;                           // local-use NAT64
  if (prefix(b, P6('2002::'), 16)) return v4Private(b.slice(2, 6));            // 6to4: embedded IPv4 in bytes 2-5
  if (prefix(b, P6('2001::'), 32)) return true;                                // Teredo (obfuscated IPv4): refused
  if (prefix(b, P6('2001:db8::'), 32)) return true;                            // documentation
  if (prefix(b, P6('100::'), 64)) return true;                                 // discard
  if (prefix(b, P6('fc00::'), 7)) return true;                                 // ULA
  if (prefix(b, P6('fe80::'), 10)) return true;                                // link-local
  if (prefix(b, P6('fec0::'), 10)) return true;                                // site-local (deprecated)
  if (prefix(b, P6('ff00::'), 8)) return true;                                 // multicast
  return false;
}

/** True for every non-public address (IPv4 or IPv6, any spelling). Unparsable input counts as non-public. */
export function isPrivateAddress(ip) {
  const s = String(ip ?? '').replace(/^\[|\]$/g, '');
  const v = isIP(s.replace(/%.*$/, ''));
  if (v === 4) return v4Private(parseIPv4(s));
  if (v === 6) { const b = parseIPv6(s); return !b || v6Private(b); }
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
  if (!addrs?.length) throw new SsrfError(`${host} does not resolve`);
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
