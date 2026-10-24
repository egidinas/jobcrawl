// Zero-dependency JD-content fingerprinting using 64-bit SimHash over 3-token shingles.
// Ported from career-ops/fingerprint-core.mjs (MIT).
// Used to deduplicate job postings cross-listed across direct ATS feeds and aggregators.

import { createHash } from 'node:crypto';

export const FINGERPRINT_MIN_TEXT = 200;
export const CROSSLIST_THRESHOLD = 0.92; // At most 5 of 64 SimHash bits differ (~93.7% match)

const FINGERPRINT_RE = /^[0-9a-f]{16}$/;

/**
 * Normalize JD text for shingling: strip tags/entities/URLs, lowercase,
 * collapse everything non-alphanumeric (unicode-aware) to single spaces.
 */
export function normalizeJdText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * 64-bit SimHash of a text, as 16 lowercase hex chars (or '' when too short).
 */
export function fingerprintText(text) {
  const normalized = normalizeJdText(text);
  if (normalized.length < FINGERPRINT_MIN_TEXT) return '';
  const tokens = normalized.split(' ');
  if (tokens.length < 3) return '';
  const weights = new Array(64).fill(0);
  for (let i = 0; i <= tokens.length - 3; i++) {
    const shingle = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
    const digest = createHash('sha1').update(shingle).digest();
    for (let bit = 0; bit < 64; bit++) {
      const byte = digest[bit >> 3];
      weights[bit] += (byte >> (7 - (bit & 7))) & 1 ? 1 : -1;
    }
  }
  let hash = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (weights[bit] > 0) hash |= 1n << BigInt(63 - bit);
  }
  return hash.toString(16).padStart(16, '0');
}

// 16-bit popcount lookup table for fast 64-bit Hamming distance calculation.
const POPCOUNT16 = (() => {
  const table = new Uint8Array(1 << 16);
  for (let i = 1; i < table.length; i++) table[i] = table[i >> 1] + (i & 1);
  return table;
})();

function popcount32(x) {
  return POPCOUNT16[x & 0xffff] + POPCOUNT16[(x >>> 16) & 0xffff];
}

function splitFingerprint(fp) {
  const s = String(fp);
  return { hi: parseInt(s.slice(0, 8), 16) | 0, lo: parseInt(s.slice(8, 16), 16) | 0 };
}

/**
 * Similarity of two fingerprints: 1 - hammingDistance/64.
 * Returns 0 if either is invalid or empty.
 */
export function similarity(a, b) {
  if (!FINGERPRINT_RE.test(a || '') || !FINGERPRINT_RE.test(b || '')) return 0;
  const x = splitFingerprint(a);
  const y = splitFingerprint(b);
  return 1 - (popcount32(x.hi ^ y.hi) + popcount32(x.lo ^ y.lo)) / 64;
}

/** Check if two fingerprints indicate a duplicate posting. */
export function isDuplicate(a, b, threshold = CROSSLIST_THRESHOLD) {
  return similarity(a, b) >= threshold;
}
