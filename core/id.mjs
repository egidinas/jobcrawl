// Stable posting ids (posting/v1 `jobcrawl.id`): "jc1_" + base32(sha256(canonical key))[0:32].
// The canonical key is the ATS posting key (crawler/postingkey.mjs: vendor, tenant namespace, posting id) when that key is globally
// unique or carries its namespace, else the normalised URL (lower-case host, no fragment, no tracking parameters, no trailing slash).
// So the id survives tracking parameters, locale path segments and http/https or www changes on the same posting.
import { createHash } from 'node:crypto';
import { postingKey } from '../crawler/postingkey.mjs';

export const ID_VERSION = 'jc1';
const TRACKING = /^(utm_[a-z]+|gh_src|gclid|fbclid|mc_[a-z]+|_hs[a-z]+|ref|refid|src|source|trk|lever-source(\[\])?|lever-origin)$/i;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** The normalised form of a posting URL (the fallback canonical key). Returns '' for an unparsable URL. */
export function normaliseUrl(url) {
  let u;
  try { u = new URL(String(url ?? '').trim()); } catch { return ''; }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = keep.length ? '?' + new URLSearchParams(keep).toString() : '';
  let path = u.pathname.replace(/\/+$/, '') || '/';
  return `${u.hostname}${u.port ? ':' + u.port : ''}${path}${u.search}`;
}

/** The canonical key of a posting URL: "pk:<vendor>:<ns>:<id>" or "url:<normalised url>". */
export function canonicalKey(url) {
  let k = null;
  try { k = postingKey(url); } catch { k = null; }
  if (k && (k.strong || k.ns)) return `pk:${k.vendor}:${k.ns}:${k.id}`;
  return `url:${normaliseUrl(url)}`;
}

/** The stable id of a posting URL. */
export function postingId(url) {
  return `${ID_VERSION}_${base32(createHash('sha256').update(canonicalKey(url)).digest()).slice(0, 32)}`;
}

/** sha256 hex of a string (content hashes in state and events). */
export const sha256 = (s) => createHash('sha256').update(String(s ?? '')).digest('hex');
