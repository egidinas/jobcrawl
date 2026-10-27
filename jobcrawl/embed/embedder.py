"""The text embedder: EmbeddingGemma 2 (q4 ONNX) through onnxruntime, batched, plus a cache of its outputs.

Port of the Embedder class in the reference implementation's scope_prune.py and of the Store cache in its prompt_lab.py.
Changes: the prompt is no longer a global (the callers build the full string with full_text(), from the profile's embed.prompt),
the model path comes from the caller (models/eg2 after scripts/fetch_model.py), and the cache lives in the vectors folder.

    from jobcrawl.embed.embedder import Store, full_text
    store = Store(path_to_cache.npz, 'models/eg2', threads=4)
    vectors = store.get([full_text(title, body, 'search-query')], 256, 'roles')

Needs numpy, onnxruntime and tokenizers (requirements-embed.txt). The cache itself needs only numpy.
"""
import hashlib
import os
import sys
import time

# name -> (prefix, document style). Document style puts the entity's title into the prompt: "title: <title> | text: "
PROMPTS = {
    'similarity': ('task: sentence similarity | query: ', False),
    'classification': ('task: classification | query: ', False),
    'clustering': ('task: clustering | query: ', False),
    'search-query': ('task: search result | query: ', False),
    'document': ('title: {title} | text: ', True),
    'none': ('', False),
}

MODEL_DIM = 768            # size of the sentence embedding the model returns (before the 256 numbers the pipeline keeps)


def full_text(title, text, prompt):
    """The exact string the model sees for an entity with a title and a body text."""
    if prompt not in PROMPTS:
        raise ValueError(f'unknown embed prompt {prompt!r}; one of {", ".join(sorted(PROMPTS))}')
    prefix, doc = PROMPTS[prompt]
    if doc:
        return prefix.format(title=title or 'none') + text
    return prefix + (title + '. ' if title else '') + text


BOI_TOKEN_ID = 255999
IMAGE_TOKEN_ID = 258880
EOI_TOKEN_ID = 258882


class Embedder:
    """The q4 multimodal text and vision model in onnxruntime. Call it with complete model inputs (see full_text)
    and optional image paths to get one 768-number row each."""

    def __init__(self, model_dir, threads=4):
        import json
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer
        self.model_dir = model_dir
        self.tok = Tokenizer.from_file(os.path.join(model_dir, 'tokenizer.json'))
        so = ort.SessionOptions()
        so.intra_op_num_threads = min(threads, 4)
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        split_model = os.path.join(model_dir, 'model_text_q4.onnx')
        full_model = os.path.join(model_dir, 'onnx', 'model_q4.onnx')
        vision_model = os.path.join(model_dir, 'vision_encoder_q4.onnx')
        if os.path.exists(vision_model):
            self.vision_sess = ort.InferenceSession(vision_model, so, providers=['CPUExecutionProvider'])
        else:
            self.vision_sess = None
        if os.path.exists(split_model):
            self.split = True
            with open(os.path.join(model_dir, 'embed_meta.json'), 'r', encoding='utf-8') as fh:
                meta = json.load(fh)
            self.embed_input_name = meta['input']
            self.q = np.fromfile(os.path.join(model_dir, 'embed_q4.bin'), dtype=np.uint8).reshape(meta['rows'], -1)
            self.sc = np.fromfile(os.path.join(model_dir, 'embed_scales.bin'), dtype=np.float16).reshape(meta['rows'], -1)
            self.zp = np.fromfile(os.path.join(model_dir, 'embed_zp.bin'), dtype=np.uint8).reshape(meta['rows'], -1)
            self.sess = ort.InferenceSession(split_model, so, providers=['CPUExecutionProvider'])
        else:
            self.split = False
            self.sess = ort.InferenceSession(full_model, so, providers=['CPUExecutionProvider'])

    def encode_image(self, img_path, target_size=(48, 48)):
        """Extracts 512-dim visual patch features from a logo image file (e.g. PNG)."""
        if not self.vision_sess or not img_path or not os.path.exists(img_path):
            return None
        try:
            import numpy as np
            from PIL import Image
            im = Image.open(img_path).convert('RGB')
            im = im.resize(target_size, Image.Resampling.LANCZOS)
            arr = np.array(im, dtype=np.float32) / 255.0
            p = 16
            H, W, _ = arr.shape
            num_h, num_w = H // p, W // p
            patches = [arr[y*p:(y+1)*p, x*p:(x+1)*p, :].reshape(-1) for y in range(num_h) for x in range(num_w)]
            pos_ids = [[y, x] for y in range(num_h) for x in range(num_w)]
            return self.vision_sess.run(['image_features'], {
                'pixel_values': np.array([patches], dtype=np.float32),
                'pixel_position_ids': np.array([pos_ids], dtype=np.int64)
            })[0]
        except Exception:
            return None

    def __call__(self, texts, images=None, maxlen=320, batch=8, log=None):
        import numpy as np
        enc = []
        img_feats_list = []
        n_logos = 0
        t_prep_start = time.time()
        if log:
            log(f'[{maxlen} tokens, batch {batch}] Preprocessing & extracting vision patches for {len(texts)} items...')
        for i, t in enumerate(texts):
            tokens = list(self.tok.encode(t).ids)
            img_path = images[i] if images and i < len(images) else None
            feat = self.encode_image(img_path) if img_path else None
            if feat is not None:
                # Prepend multimodal vision tokens: [BOI, IMG*N, EOI]
                k = len(feat)
                tokens = [BOI_TOKEN_ID] + [IMAGE_TOKEN_ID] * k + [EOI_TOKEN_ID] + tokens
                img_feats_list.append(feat)
                n_logos += 1
            else:
                img_feats_list.append(np.zeros((0, 512), np.float32))
            enc.append(tokens)
            if log and ((i + 1) % 50 == 0 or (i + 1) == len(texts)):
                elapsed_prep = time.time() - t_prep_start
                rate_prep = (i + 1) / max(elapsed_prep, 1e-5)
                eta_prep = (len(texts) - (i + 1)) / rate_prep
                log(f'   [Preprocessing] {i + 1}/{len(texts)} ({ (i + 1) / len(texts):.1%}) prepared ({n_logos} logos) | {rate_prep:.1f} items/s | ETA: {eta_prep:.0f}s')

        lens = np.array([min(maxlen, len(e)) for e in enc]); order = np.argsort(lens)
        out = np.zeros((len(texts), MODEL_DIM), np.float32); t0 = last = time.time()
        total_batches = (len(order) + batch - 1) // batch
        if log:
            log(f'   [Inference] Launching {total_batches} batches on ONNX runtime (max {maxlen} tokens, batch {batch})...')

        for b in range(0, len(order), batch):
            batch_num = b // batch + 1
            idx = order[b:b + batch]; L = int(lens[idx].max())
            ids = np.zeros((len(idx), L), np.int64); am = np.zeros_like(ids)
            for j, i in enumerate(idx):
                n = int(lens[i]); ids[j, :n] = enc[i][:n]; am[j, :n] = 1
            batch_img_feats = [img_feats_list[i] for i in idx if len(img_feats_list[i]) > 0]
            cat_img_feats = np.concatenate(batch_img_feats, axis=0) if batch_img_feats else np.zeros((0, 512), np.float32)
            feed = {'input_ids': ids, 'attention_mask': am,
                    'image_features': cat_img_feats,
                    'video_features': np.zeros((0, 512), np.float32),
                    'audio_features': np.zeros((0, 512), np.float32)}
            if self.split:
                flat_ids = ids.ravel()
                qb = self.q[flat_ids]; lo = qb & 15; hi = qb >> 4
                v = np.stack([lo, hi], -1).reshape(len(flat_ids), 512).astype(np.float32)
                zb = self.zp[flat_ids]; z = np.stack([zb & 15, zb >> 4], -1).reshape(len(flat_ids), 16).astype(np.float32)
                s = self.sc[flat_ids].astype(np.float32)
                tok_emb = ((v.reshape(len(flat_ids), 16, 32) - z[..., None]) * s[..., None]).reshape(len(idx), L, 512)
                feed[self.embed_input_name] = tok_emb
            out[idx] = self.sess.run(['sentence_embedding'], feed)[0]
            done = min(b + batch, len(texts))
            if log and (time.time() - last >= 4 or done == len(texts)):
                last = time.time(); elapsed = last - t0; rate = done / max(elapsed, 1e-6)
                eta = (len(texts) - done) / max(rate, 1e-6)
                log(f'   [Inference] Batch {batch_num}/{total_batches} -> {done}/{len(texts)} ({done / len(texts):.1%}) | {rate:.1f} emb/s | Elapsed: {elapsed:.0f}s | ETA: {eta:.0f}s')
        return out


class Store:
    """Embeddings cached by (max length, full text, logo image), written after every chunk of 400 texts. The model loads only when a text is new."""

    def __init__(self, path, model_dir, threads=4):
        import numpy as np
        self.path = str(path); self.emb = None; self.model_dir, self.threads = model_dir, threads
        self.c = dict(np.load(self.path, allow_pickle=False)) if os.path.exists(self.path) else {}

    @staticmethod
    def key(t, maxlen, img_path=None):
        h = hashlib.sha1(f'{maxlen}|{t}'.encode('utf-8'))
        if img_path and os.path.exists(img_path):
            try:
                st = os.stat(img_path)
                h.update(f'|img:{os.path.basename(img_path)}:{st.st_size}:{st.st_mtime}'.encode('utf-8'))
            except Exception:
                pass
        return h.hexdigest()

    def get(self, texts, maxlen, label, images=None, log=print):
        import numpy as np
        imgs = images if images else [None] * len(texts)
        need_idx = [i for i, (t, im) in enumerate(zip(texts, imgs)) if self.key(t, maxlen, im) not in self.c]
        cached_count = len(texts) - len(need_idx)

        def flush_log(msg):
            log(msg)
            sys.stdout.flush()

        flush_log(f'[{label}] Total {len(texts)} embeddings: {cached_count} already cached in store ({cached_count/len(texts):.1%}), {len(need_idx)} new to compute (max {maxlen} tokens, {sum(1 for im in imgs if im)} with logos)')
        if need_idx:
            if self.emb is None:
                self.emb = Embedder(self.model_dir, self.threads)
            import gc
            chunk_size = 100
            total_chunks = (len(need_idx) + chunk_size - 1) // chunk_size
            for c0 in range(0, len(need_idx), chunk_size):
                chunk_num = c0 // chunk_size + 1
                chunk = need_idx[c0:c0 + chunk_size]
                part_texts = [texts[i] for i in chunk]
                part_imgs = [imgs[i] for i in chunk]
                flush_log(f'[{label}] === Chunk {chunk_num}/{total_chunks}: computing items {c0 + 1}..{c0 + len(chunk)} of {len(need_idx)} new embeddings ===')
                V = self.emb(part_texts, images=part_imgs, maxlen=maxlen, batch=8, log=lambda m: flush_log('   ' + m))
                for i, v in zip(chunk, V):
                    self.c[self.key(texts[i], maxlen, imgs[i])] = v.astype(np.float16)
                os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
                np.savez(self.path, **self.c)
                gc.collect()
                flush_log(f'[{label}] === Saved Chunk {chunk_num}/{total_chunks} to disk ({len(self.c)} total cached entries) ===')
        return np.stack([self.c[self.key(t, maxlen, im)].astype(np.float32) for t, im in zip(texts, imgs)]) if texts else np.zeros((0, MODEL_DIM), np.float32)
