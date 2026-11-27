// Content-addressed artifact store (design §0.3): raw captures, texts, vectors move between machines as artifacts named by their hash,
// so a copy is verifiable and a duplicate upload is a no-op. Interface (adapters: this local directory; later R2/S3 and the fleet xfer
// route):
//   put(bytes, { type, meta? }) -> ref    ref (schema artifact-ref/v1): { sha256, bytes, type, enc: 'gzip'|null, uri }
//   get(ref | sha256) -> Buffer           verified against its hash on read
//   has(sha256) -> boolean
// The local layout is the raw-capture layout (<dir>/objects/ab/<sha256>.gz), so existing captures are already a store.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export const ARTIFACT_SCHEMA = 'artifact-ref/v1';
const SHA = /^[0-9a-f]{64}$/;
/** Only a 64-hex sha256 is ever turned into a path (a ref from another machine is untrusted). */
export function checkSha(sha) { if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error(`not a sha256: ${String(sha).slice(0, 80)}`); return sha; }

export class LocalArtifacts {
  constructor(dir) { this.dir = dir; }
  _path(sha) { checkSha(sha); return join(this.dir, 'objects', sha.slice(0, 2), `${sha}.gz`); }
  has(sha) { return existsSync(this._path(sha)); }
  put(bytes, { type = 'application/octet-stream', meta } = {}) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const sha = createHash('sha256').update(buf).digest('hex');
    const f = this._path(sha);
    if (!existsSync(f)) {
      mkdirSync(join(this.dir, 'objects', sha.slice(0, 2)), { recursive: true });
      writeFileSync(`${f}.${process.pid}.tmp`, gzipSync(buf));
      renameSync(`${f}.${process.pid}.tmp`, f);
    }
    return { schema: ARTIFACT_SCHEMA, sha256: sha, bytes: buf.length, type, enc: 'gzip', uri: `file:${f}`, ...(meta ? { meta } : {}) };
  }
  get(refOrSha) {
    const sha = typeof refOrSha === 'string' ? refOrSha : refOrSha.sha256;
    const buf = gunzipSync(readFileSync(this._path(sha)));
    if (createHash('sha256').update(buf).digest('hex') !== sha) throw new Error(`artifact ${sha}: content does not match its hash`);
    return buf;
  }
}

/** Vectors travel compressed: float32 -> float16 or int8 (per-vector scale). Returns { dtype, dim, scale?, data: Buffer }. */
export function packVector(vec, dtype = 'float16') {
  const v = Float32Array.from(vec);
  if (dtype === 'int8') {
    const max = v.reduce((m, x) => Math.max(m, Math.abs(x)), 0) || 1;
    const scale = max / 127;
    return { dtype, dim: v.length, scale, data: Buffer.from(Int8Array.from(v, (x) => Math.round(x / scale)).buffer) };
  }
  if (dtype === 'float16') {
    const out = new Uint16Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = toHalf(v[i]);
    return { dtype, dim: v.length, data: Buffer.from(out.buffer) };
  }
  return { dtype: 'float32', dim: v.length, data: Buffer.from(v.buffer) };
}
export function unpackVector(p) {
  if (p.dtype === 'int8') return Float32Array.from(new Int8Array(p.data.buffer, p.data.byteOffset, p.dim), (x) => x * p.scale);
  if (p.dtype === 'float16') return Float32Array.from(new Uint16Array(p.data.buffer.slice(p.data.byteOffset, p.data.byteOffset + p.dim * 2)), fromHalf);
  return new Float32Array(p.data.buffer.slice(p.data.byteOffset, p.data.byteOffset + p.dim * 4));
}
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function toHalf(x) {
  f32[0] = x; const b = u32[0];
  const s = (b >>> 16) & 0x8000, e = ((b >>> 23) & 0xff) - 112, m = b & 0x7fffff;
  if (e <= 0) return s;
  if (e >= 31) return s | 0x7c00;
  return s | (e << 10) | ((m + 0x1000) >>> 13);
}
function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >>> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}
