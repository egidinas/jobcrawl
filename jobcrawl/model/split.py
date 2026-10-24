"""Makes EmbeddingGemma 2 (q4) runnable in a browser's ONNX runtime.

Port of the reference implementation's split_model.py. The browser runtime has no kernel for the one GatherBlockQuantized node, which is the token-embedding
lookup. This cuts that node out, makes its output a graph input ("text_embeds", batch x tokens x 512) and writes the quantized table to
separate files; the page looks the rows up itself (tokens are few) and passes them in. Everything else in the graph is unchanged, and
the result is checked against the original model.

    python3 -m jobcrawl.model.split --model-dir models/eg2 --out models/eg2

Needs onnx (and onnxruntime + tokenizers for the check). Writes: model_text_q4.onnx (+ .onnx_data), embed_q4.bin (262144 x 256 bytes:
512 4-bit values per token, low nibble first), embed_scales.bin (262144 x 16 float16), embed_zp.bin (262144 x 8 bytes: 16 4-bit zero points),
embed_meta.json. scripts/fetch_model.py calls it after the download.
"""
import argparse
import json
import os
import sys

TEXTS = ['task: search result | query: thermal vacuum test engineer for satellites',
         'task: search result | query: Produktionsleiter Raumfahrt, Lieferantenqualifizierung und Serienanlauf',
         'task: search result | query: embedded flight software DO-178C']


def dequant(q, scales, zp, ids, dim=512, block=32):
    """Rows of the embedding table for the given token ids: (nibble - zero point) * scale, per block of 32 values."""
    import numpy as np
    qb = q[ids]; lo = qb & 15; hi = qb >> 4
    v = np.stack([lo, hi], -1).reshape(len(ids), dim).astype(np.float32)
    zb = zp[ids]; z = np.stack([zb & 15, zb >> 4], -1).reshape(len(ids), dim // block).astype(np.float32)
    s = scales[ids].astype(np.float32)
    return ((v.reshape(len(ids), dim // block, block) - z[..., None]) * s[..., None]).reshape(len(ids), dim)


def split(model_dir, out, check=True, log=print):
    import numpy as np
    import onnx
    from onnx import helper, TensorProto
    src = str(model_dir); out = str(out)
    os.makedirs(out, exist_ok=True)
    m = onnx.load(os.path.join(src, 'onnx', 'model_q4.onnx'))
    node = next(n for n in m.graph.node if n.op_type == 'GatherBlockQuantized')
    names = list(node.input[0:1]) + [node.input[2]] + [node.input[3]]               # quant, scales, zero points
    ts = {t.name: t for t in m.graph.initializer}
    q = np.frombuffer(onnx.numpy_helper.to_array(ts[names[0]]).tobytes(), np.uint8).reshape(ts[names[0]].dims[0], -1)
    sc = onnx.numpy_helper.to_array(ts[names[1]]).astype(np.float16); zp = onnx.numpy_helper.to_array(ts[names[2]]).astype(np.uint8)
    q.tofile(os.path.join(out, 'embed_q4.bin')); sc.tofile(os.path.join(out, 'embed_scales.bin')); zp.tofile(os.path.join(out, 'embed_zp.bin'))
    meta = {'rows': int(q.shape[0]), 'dim': 512, 'block': 32, 'bytes_per_row': int(q.shape[1]), 'scales_per_row': int(sc.shape[1]),
            'zp_bytes_per_row': int(zp.shape[1]), 'input': node.output[0]}
    with open(os.path.join(out, 'embed_meta.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh)
    keep_nodes = [n for n in m.graph.node if n is not node]
    del m.graph.node[:]; m.graph.node.extend(keep_nodes)
    keep_init = [t for t in m.graph.initializer if t.name not in names]
    del m.graph.initializer[:]; m.graph.initializer.extend(keep_init)
    m.graph.input.append(helper.make_tensor_value_info(node.output[0], TensorProto.FLOAT, ['batch_size', 'sequence_length', 512]))
    onnx.save_model(m, os.path.join(out, 'model_text_q4.onnx'), save_as_external_data=True, all_tensors_to_one_file=True,
                    location='model_text_q4.onnx_data', size_threshold=1024)
    for name in sorted(os.listdir(out)):
        log(f'  {name:<24} {os.path.getsize(os.path.join(out, name)) / 1e6:8.1f} MB')
    if not check:
        return meta
    import onnxruntime as ort
    from tokenizers import Tokenizer
    tok = Tokenizer.from_file(os.path.join(src, 'tokenizer.json'))
    full = ort.InferenceSession(os.path.join(src, 'onnx', 'model_q4.onnx'), providers=['CPUExecutionProvider'])
    new = ort.InferenceSession(os.path.join(out, 'model_text_q4.onnx'), providers=['CPUExecutionProvider'])
    z0 = {'image_features': np.zeros((0, 512), np.float32), 'video_features': np.zeros((0, 512), np.float32), 'audio_features': np.zeros((0, 512), np.float32)}
    new_inputs = [i.name for i in new.get_inputs()]
    for t in TEXTS:
        ids = np.array(tok.encode(t).ids, np.int64)[None]; am = np.ones_like(ids)
        ref = full.run(['sentence_embedding'], {'input_ids': ids, 'attention_mask': am, **z0})[0][0]
        emb = dequant(q, sc, zp, ids[0]).astype(np.float32)[None]
        feed = {meta['input']: emb, 'attention_mask': am, **z0, 'input_ids': ids} if 'input_ids' in new_inputs else {meta['input']: emb, 'attention_mask': am, **z0}
        got = new.run(['sentence_embedding'], feed)[0][0]
        log(f'  check: cosine with the original model {float(ref @ got / np.linalg.norm(ref) / np.linalg.norm(got)):.5f}  ({ids.shape[1]} tokens)')
    return meta


def main(argv=None):
    ap = argparse.ArgumentParser(description='Split EmbeddingGemma 2 (q4 ONNX) for the browser.')
    ap.add_argument('--model-dir', required=True, help='folder with onnx/model_q4.onnx and tokenizer.json')
    ap.add_argument('--out', required=True, help='folder to write the browser files to')
    ap.add_argument('--skip-check', action='store_true', help='do not compare with the original model (no onnxruntime needed)')
    a = ap.parse_args(argv)
    split(a.model_dir, a.out, check=not a.skip_check)
    return 0


if __name__ == '__main__':
    sys.exit(main())
