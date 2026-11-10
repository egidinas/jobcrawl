"""atlas_v3 vectors for the board (2026-11-10): the board's role vectors come from the Atlas v3 encoder (granite-311M-R2 multi-head, CLS pooling,
768-d, Matryoshka 256-d prefix), computed OUTSIDE the crawl: the bulk encode runs once on the GPU node, the daily increment on the NUC
(Jobsearch scripts/atlas/train/board_package_v3.py). This module only IMPORTS those vectors into the site's own format, so nothing heavy runs
on the crawl PC. EmbeddingGemma 2 stays the default until the profile is switched (see Jobsearch Research/BOARD_PACKAGE_v3.md).

A "model dir" is an atlas_v3 board package when it holds manifest.json with "package": "atlas_v3_board"; the package carries its own
match-vec.bin / match-vec.json (int8 = round(127 x L2(CLS[:256])), ids = the board's short ids, mean 0, no language directions: v3 is one
multilingual space, so the centring and the language projection of the EmbeddingGemma recipe are not applied).

    jobcrawl embed --site SITE --model-dir <package dir>                  full import (THE switch: every row replaced, model recorded)
    jobcrawl embed --site SITE --model-dir <package dir> --only-missing   appends the package rows the vectors folder lacks (same model only)

Company vectors (company-vec.*) and any other text the site embeds go through the NUC query service (ServiceEmbedder) when the model dir is
an http(s) URL of board_query_service_v3.py (loopback / LAN only), with the embed.prompt "none" (v3 was trained without a prompt).
"""
import json
import os

PACKAGE_KIND = 'atlas_v3_board'


def is_package(path):
    try:
        with open(os.path.join(path, 'manifest.json'), encoding='utf-8') as fh:
            return json.load(fh).get('package') == PACKAGE_KIND
    except (OSError, ValueError, TypeError):
        return False


def is_service(model_dir):
    return isinstance(model_dir, str) and model_dir.startswith(('http://', 'https://'))


def _read_pkg(pkg):
    import numpy as np
    with open(os.path.join(pkg, 'match-vec.json'), encoding='utf-8') as fh:
        pj = json.load(fh)
    with open(os.path.join(pkg, 'manifest.json'), encoding='utf-8') as fh:
        man = json.load(fh)
    M = np.fromfile(os.path.join(pkg, 'match-vec.bin'), dtype=np.int8).reshape(len(pj['ids']), pj['dim'])
    return pj, man, M


def _write(vectors, meta, M, mode='wb'):
    """match-vec and match-vec-jobonly hold the same rows: the site's neighbours / atlas code reads the job-only file when it exists, and v3 has
    one text recipe (no rich / job-only split)."""
    os.makedirs(vectors, exist_ok=True)
    for stem in ('match-vec', 'match-vec-jobonly'):
        with open(os.path.join(vectors, stem + '.bin'), mode) as fh:
            fh.write(M.tobytes())
        with open(os.path.join(vectors, stem + '.json'), 'w', encoding='utf-8') as fh:
            json.dump(meta, fh, separators=(',', ':'))


def import_package(pkg, site, vectors, only_missing=False, log=print):
    """Returns the number of rows written or added. Roles not on the board are kept (neighbours.build skips them, as for EmbeddingGemma)."""
    import numpy as np
    pj, man, M = _read_pkg(pkg)
    model = man.get('model_id') or pj.get('model')
    meta = {'dim': pj['dim'], 'ids': list(pj['ids']), 'mean': [0.0] * pj['dim'], 'lang_dirs': [], 'model': model, 'label_set': man.get('label_set'),
            'pooling': 'cls', 'prompt': '', 'max_tokens': pj.get('max_tokens'), 'text': pj.get('text'), 'vector': pj.get('vector'),
            'package_created': man.get('created'), 'checkpoint': (man.get('checkpoint') or {}).get('model_weights_sha256')}
    if pj.get('nb_params'):       # the space's own duplicate / employer thresholds for neighbours.build
        meta['nb_params'] = pj['nb_params']
    jpath = os.path.join(vectors, 'match-vec.json')
    if only_missing and os.path.exists(jpath):
        with open(jpath, encoding='utf-8') as fh:
            vj = json.load(fh)
        if vj.get('model') != model:
            raise ValueError(f'vectors folder holds model {vj.get("model") or "EmbeddingGemma 2"}, the package {model}: one space only; '
                             'run the full import (without --only-missing) to switch')
        have = set(vj['ids'])
        add = [i for i, rid in enumerate(pj['ids']) if rid not in have]
        if not add:
            log('atlas_v3: no package rows missing from the vectors folder')
            return 0
        vj['ids'] += [pj['ids'][i] for i in add]
        vj['package_created'] = meta['package_created']
        for stem in ('match-vec', 'match-vec-jobonly'):
            with open(os.path.join(vectors, stem + '.bin'), 'ab') as fh:
                fh.write(M[add].tobytes())
            with open(os.path.join(vectors, stem + '.json'), 'w', encoding='utf-8') as fh:
                json.dump(vj, fh, separators=(',', ':'))
        log(f'atlas_v3: {len(add)} rows appended from {pkg}; {len(vj["ids"])} in total')
        return len(add)
    _write(vectors, meta, M)
    log(f'atlas_v3: {len(pj["ids"])} rows imported from {pkg} (model {model}; full import, every earlier row replaced)')
    return len(pj['ids'])


class ServiceEmbedder:
    """Store-compatible embedder over the NUC query service (POST /embed, 768-d L2 vectors of the v3 CLS). Images are ignored (v3 is text only)."""

    def __init__(self, url, threads=4):
        self.url = url.rstrip('/')

    def __call__(self, texts, images=None, maxlen=2048, batch=16, log=None):
        import urllib.request
        import numpy as np
        out = np.zeros((len(texts), 768), np.float32)
        for s in range(0, len(texts), batch):
            body = json.dumps({'texts': texts[s:s + batch], 'dim': 768, 'kind': 'doc'}).encode('utf-8')
            req = urllib.request.Request(self.url + '/embed', data=body, headers={'Content-Type': 'application/json'})
            r = json.loads(urllib.request.urlopen(req, timeout=600).read())
            out[s:s + len(r['vectors'])] = np.array(r['vectors'], np.float32)
            if log and (s // batch) % 20 == 0:
                log(f'   [atlas_v3 service] {min(s + batch, len(texts))}/{len(texts)} texts')
        return out
