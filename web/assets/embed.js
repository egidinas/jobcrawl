// Runs EmbeddingGemma 2 (4-bit) in the visitor's browser: the text never leaves the device.
// Files: the split model made by jobcrawl/model/split.py (scripts/fetch_model.py runs it) plus tokenizer.json, all in the model folder.
// The model folder is config.json's model_url (default models/eg2/, relative to the web root). Without it, loadModel rejects with
// "model not found" and the keyword, rating and atlas parts of the app keep working.
// The token-embedding lookup is done here (the browser runtime has no kernel for it); the rest of the network runs in ONNX Runtime Web (WebAssembly).

const F16 = (h) => { const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; return e === 0 ? s * Math.pow(2, -14) * (m / 1024) : e === 31 ? (m ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + m / 1024); };
export const PREFIX = 'task: search result | query: ';
export const MODEL_FILES = ['embed_meta.json', 'tokenizer_config.json', 'model_text_q4.onnx', 'model_text_q4.onnx_data', 'embed_q4.bin', 'embed_scales.bin', 'embed_zp.bin', 'tokenizer.json'];

async function getBytes(url, onChunk, cacheName) {
  let cache = null; try { cache = await caches.open(cacheName); } catch (e) { /* private window: no cache, download every time */ }
  let res = cache ? await cache.match(url) : null;
  if (!res) {
    res = await fetch(url); if (!res.ok) throw new Error(url + ' ' + res.status);
    if (cache) { try { await cache.put(url, res.clone()); } catch (e) { /* quota */ } }
  }
  const reader = res.body.getReader(), parts = []; let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); n += value.length; onChunk(value.length); }
  const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}

/** Downloads (once, then from the browser cache) and starts the model. onProgress(fraction 0..1, label). */
const HERE = import.meta.url;
export async function loadModel({ modelUrl = 'models/eg2/', ortBase = new URL('vendor/ort/', HERE).href, tokenizerModule = new URL('vendor/tokenizers.min.js', HERE).href, cacheName = 'jobcrawl-eg2-v1', onProgress = () => {} } = {}) {
  const WEB_ROOT = new URL('../', HERE);
  const base = new URL(modelUrl.endsWith('/') ? modelUrl : modelUrl + '/', WEB_ROOT).href;
  const probe = await fetch(base + 'embed_meta.json', { method: 'HEAD' }).catch(() => null);
  if (!probe || !probe.ok) throw new Error(`model not found at ${base} (keyword matching, ratings and the atlas work without it)`);
  const sizes = await Promise.all(MODEL_FILES.map((f) => fetch(base + f, { method: 'HEAD' }).then((r) => (r.ok ? +r.headers.get('content-length') || 0 : 0)).catch(() => 0)));
  const total = sizes.reduce((a, b) => a + b, 0) || 1; let got = 0;
  const bytes = {}; for (const f of MODEL_FILES) bytes[f] = await getBytes(base + f, (k) => { got += k; onProgress(Math.min(0.97, got / total), f); }, cacheName);
  onProgress(0.97, 'starting');
  const [{ Tokenizer }, ort] = await Promise.all([import(tokenizerModule), import(ortBase + 'ort.wasm.min.js')]);
  // the vendor modules end in .js: some servers send .mjs with a non-JavaScript type, which browsers refuse for a module
  ort.env.wasm.wasmPaths = { mjs: ortBase + 'ort-wasm-simd-threaded.js', wasm: ortBase + 'ort-wasm-simd-threaded.wasm' }; ort.env.wasm.numThreads = (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  const dec = new TextDecoder(), meta = JSON.parse(dec.decode(bytes['embed_meta.json']));
  const tok = new Tokenizer(JSON.parse(dec.decode(bytes['tokenizer.json'])), JSON.parse(dec.decode(bytes['tokenizer_config.json'])));
  const session = await ort.InferenceSession.create(bytes['model_text_q4.onnx'], { executionProviders: ['wasm'], externalData: [{ path: 'model_text_q4.onnx_data', data: bytes['model_text_q4.onnx_data'] }] });
  const Q = bytes['embed_q4.bin'], S = new Uint16Array(bytes['embed_scales.bin'].buffer, bytes['embed_scales.bin'].byteOffset, bytes['embed_scales.bin'].byteLength / 2), Z = bytes['embed_zp.bin'];
  const BPR = meta.bytes_per_row, SPR = meta.scales_per_row, ZPR = meta.zp_bytes_per_row, BL = meta.block;
  const row = (id, dst, off) => { for (let b = 0; b < SPR; b++) { const s = F16(S[id * SPR + b]), zb = Z[id * ZPR + (b >> 1)], z = (b & 1) ? (zb >> 4) : (zb & 15); for (let k = 0; k < BL; k++) { const j = b * BL + k, qb = Q[id * BPR + (j >> 1)]; dst[off + j] = (((j & 1) ? (qb >> 4) : (qb & 15)) - z) * s; } } };
  onProgress(1, 'ready');
  return {
    tokenize: (text, maxTokens = 512) => tok.encode(PREFIX + text).ids.slice(0, maxTokens),
    /** 768 numbers, unit length; the same recipe as the vectors in the index. */
    async embed(text, maxTokens = 512) {
      const ids = this.tokenize(text, maxTokens), L = ids.length, emb = new Float32Array(L * meta.dim); ids.forEach((id, i) => row(id, emb, i * meta.dim));
      const T = (type, data, dims) => new ort.Tensor(type, data, dims);
      const r = await session.run({ [meta.input]: T('float32', emb, [1, L, meta.dim]), attention_mask: T('int64', new BigInt64Array(L).fill(1n), [1, L]), input_ids: T('int64', BigInt64Array.from(ids, BigInt), [1, L]),
        image_features: T('float32', new Float32Array(0), [0, meta.dim]), video_features: T('float32', new Float32Array(0), [0, meta.dim]), audio_features: T('float32', new Float32Array(0), [0, meta.dim]) });
      const v = Float32Array.from(r.sentence_embedding.data); let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; for (let i = 0; i < v.length; i++) v[i] /= n; return v;
    },
  };
}
