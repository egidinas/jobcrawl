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


class Embedder:
    """The q4 text model in onnxruntime. Call it with complete model inputs (see full_text) and get one 768-number row each."""

    def __init__(self, model_dir, threads=4):
        import onnxruntime as ort
        from tokenizers import Tokenizer
        self.tok = Tokenizer.from_file(os.path.join(model_dir, 'tokenizer.json'))
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        self.sess = ort.InferenceSession(os.path.join(model_dir, 'onnx', 'model_q4.onnx'), so, providers=['CPUExecutionProvider'])

    def __call__(self, texts, maxlen=320, batch=16, log=None):
        import numpy as np
        enc = [self.tok.encode(t) for t in texts]
        lens = np.array([min(maxlen, len(e.ids)) for e in enc]); order = np.argsort(lens)
        out = np.zeros((len(texts), MODEL_DIM), np.float32); t0 = last = time.time()
        if log:
            log(f'embedding {len(texts)} texts (max {maxlen} tokens, batch {batch})')
        for b in range(0, len(order), batch):
            idx = order[b:b + batch]; L = int(lens[idx].max())
            ids = np.zeros((len(idx), L), np.int64); am = np.zeros_like(ids)
            for j, i in enumerate(idx):
                n = int(lens[i]); ids[j, :n] = enc[i].ids[:n]; am[j, :n] = 1
            out[idx] = self.sess.run(['sentence_embedding'], {'input_ids': ids, 'attention_mask': am, 'image_features': np.zeros((0, 512), np.float32),
                                                              'video_features': np.zeros((0, 512), np.float32), 'audio_features': np.zeros((0, 512), np.float32)})[0]
            if log and time.time() - last >= 10:
                last = time.time(); rate = (b + batch) / (last - t0)
                # texts are processed shortest first, so the ETA is optimistic: the last batches are the longest
                log(f'  embedded {min(b + batch, len(texts))}/{len(texts)} ({(b + batch) / len(texts):.0%}), {rate:.1f} texts/s, {last - t0:.0f}s elapsed, '
                    f'ETA about {(len(texts) - b - batch) / rate:.0f}s')
        return out


class Store:
    """Embeddings cached by (max length, full text), written after every chunk of 400 texts. The model loads only when a text is new."""

    def __init__(self, path, model_dir, threads=4):
        import numpy as np
        self.path = str(path); self.emb = None; self.model_dir, self.threads = model_dir, threads
        self.c = dict(np.load(self.path, allow_pickle=False)) if os.path.exists(self.path) else {}

    @staticmethod
    def key(t, maxlen):
        return hashlib.sha1(f'{maxlen}|{t}'.encode('utf-8')).hexdigest()

    def get(self, texts, maxlen, label, log=print):
        import numpy as np
        need = sorted({t for t in texts if self.key(t, maxlen) not in self.c})
        log(f'[{label}] {len(texts)} texts, {len(need)} to embed (max {maxlen} tokens)')
        if need:
            if self.emb is None:
                self.emb = Embedder(self.model_dir, self.threads)
            for c0 in range(0, len(need), 400):
                part = need[c0:c0 + 400]
                V = self.emb(part, maxlen=maxlen, log=lambda m: log('   ' + m))
                for t, v in zip(part, V):
                    self.c[self.key(t, maxlen)] = v.astype(np.float16)
                os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
                np.savez(self.path, **self.c)
        return np.stack([self.c[self.key(t, maxlen)].astype(np.float32) for t in texts]) if texts else np.zeros((0, MODEL_DIM), np.float32)
