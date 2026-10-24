"""Role vectors: every board role embedded from its work text, made language-neutral, written as int8 rows.

Port of the reference implementation's reembed_roles.py (full run) and embed_missing.py (only the roles without a vector yet), merged.

    jobcrawl embed --site SITE --model-dir models/eg2                 full run: writes VECTORS/match-vec.bin and .json
    jobcrawl embed --site SITE --model-dir models/eg2 --only-missing  appends the roles that have no vector yet

Recipe (unchanged from the reference): the prompt of profile embed.prompt (default "search-query"), 256 tokens, the clean title plus the
first embed.text_chars (700) characters of the work text (jobcrawl/text/work_text.py). Roles with less than 150 characters of work
text keep no vector: they take part through their keywords. The 256 numbers kept are the first of the 768 the model returns, centred
on the mean of the run and scaled to unit length; the language directions (German, French, Spanish minus English) are then removed.
The mean and the directions are stored in match-vec.json, so later additions use the same space.
"""
import collections
import json
import os
import re

from jobcrawl.site import read_site
from jobcrawl.embed.embedder import PROMPTS, Store, full_text
from jobcrawl.text import langfix
from jobcrawl.text import work_text as wt
from jobcrawl.text.sections import segment_sections

DIM = 256                   # numbers kept from the model output (the first 256 of its 768)
MIN_CHARS = 150             # work text shorter than this gets no vector
MATCH_VEC = 'match-vec'


class RoleVectorError(ValueError):
    pass


def clean_title(t):
    """Title without gender notation, requisition numbers and shift words (the reference implementation's clean_title)."""
    t = re.sub(r'\((?:\s*[mwfdxn]\s*[/|]\s*)+[mwfdxn*]\s*\)|\(\s*all genders\s*\)|\(\s*gn\s*\)|\bm[ /]w[ /]d\b|\bw[ /]m[ /]d\b|\bm/f/d\b', '', t, flags=re.I)
    t = re.sub(r'\(R\d+\)|#\d+|\b\d{4,6}\b', '', t)
    t = re.sub(r'\b(1st|2nd|3rd|4th)\s+shift\b|\b(night|weekend|day)\s+shift\b|[-–]\s*shift\b', '', t, flags=re.I)
    return re.sub(r'\s+', ' ', t).strip(' -–,;')


def board_texts(site):
    """[(index row, description text, work text)] for every role on the board, in index order (as reembed_roles.board_texts)."""
    index, desc = read_site(site)
    by = collections.defaultdict(list)
    for r in index:
        by[r[2]].append((desc.get(r[0]) or {}).get('x') or '')
    boiler = wt.employer_boilerplate(by)
    out = []
    for r in index:
        x = (desc.get(r[0]) or {}).get('x') or ''
        body = wt.work_text(r[1], x, boiler.get(r[2], frozenset()), segment_sections)
        out.append((r, x, body))
    return out


def vector_paths(vectors):
    return (os.path.join(vectors, MATCH_VEC + '.bin'), os.path.join(vectors, MATCH_VEC + '.json'))


def write_int8(path, M, mode='wb'):
    import numpy as np
    with open(path, mode) as fh:
        fh.write(np.clip(np.round(M * 127), -127, 127).astype(np.int8).tobytes())


def unit_rows(M):
    import numpy as np
    return M / np.maximum(np.linalg.norm(M, axis=1, keepdims=True), 1e-9)


def sample(site, n, log=print):
    """Prints n random roles with the text before and after the work-text recipe; no model needed."""
    import random
    rows = board_texts(site)
    random.seed(4)
    for r, x, body in random.sample(rows, min(n, len(rows))):
        log(f'--- {r[2]} | {r[1]}\n  before: {x[:260]!r}\n  after:  {body[:260]!r}')
    kept = sum(1 for _, _, b in rows if len(b) >= MIN_CHARS)
    log(f'{kept} of {len(rows)} roles have {MIN_CHARS}+ characters of work text')


def embed_all(site, prompt, text_chars, max_tokens, model_dir, vectors, threads=4, log=print):
    """Full run: every role with enough work text is embedded afresh; the vector files are replaced."""
    import numpy as np
    rows = board_texts(site)
    keep = [(r, b) for r, _, b in rows if len(b) >= MIN_CHARS]
    if not keep:
        raise RoleVectorError(f'no role on the board has {MIN_CHARS}+ characters of work text (check the descriptions in {site})')
    texts = [full_text(clean_title(r[1]), b[:text_chars], prompt) for r, b in keep]
    E = np.asarray(Store(os.path.join(vectors, '.embed-cache.npz'), model_dir, threads).get(texts, max_tokens, 'roles (work text)', log=log), np.float32)
    M = E[:, :DIM]; mean = M.mean(0); M = unit_rows(M - mean)
    langs = np.array([langfix.language(r[1] + ' ' + b[:2000]) for r, b in keep])
    D = langfix.directions(M, langs); M = langfix.project(M, D)
    os.makedirs(vectors, exist_ok=True)
    bin_path, json_path = vector_paths(vectors)
    write_int8(bin_path, M)
    meta = {'dim': DIM, 'mean': [round(float(x), 5) for x in mean], 'ids': [r[0] for r, _ in keep], 'prompt': PROMPTS[prompt][0],
            'text': f'clean title + first {text_chars} characters of the work text (jobcrawl/text/work_text.py)',
            'lang_dirs': [[round(float(x), 6) for x in d] for d in D], 'lang_dirs_from': {l: int((langs == l).sum()) for l in ('en', 'de', 'fr', 'es')}}
    with open(json_path, 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, separators=(',', ':'))
    log(f'{len(keep)} role vectors written (language directions removed: {len(D)})')
    return len(keep)


def embed_missing(site, prompt, text_chars, max_tokens, model_dir, vectors, threads=4, log=print):
    """Adds vectors for the board roles that have none; the stored rows, mean and directions stay as they are."""
    import numpy as np
    bin_path, json_path = vector_paths(vectors)
    if not os.path.exists(json_path):
        raise RoleVectorError(f'no vectors in {vectors} yet: run jobcrawl embed without --only-missing first')
    with open(json_path, encoding='utf-8') as fh:
        vj = json.load(fh)
    have = set(vj['ids']); dim = vj['dim']; mean = np.array(vj['mean'], np.float32)
    texts, keep, todo = [], [], 0
    for r, _, body in board_texts(site):
        if r[0] in have:
            continue
        todo += 1
        if len(body) < MIN_CHARS:
            continue                                   # too little work text: keywords only, as in the main run
        texts.append(full_text(clean_title(r[1]), body[:text_chars], prompt)); keep.append(r[0])
    log(f'{todo} roles without a vector, {len(keep)} with enough text to embed')
    if not keep:
        return 0
    E = Store(os.path.join(vectors, '.embed-cache.npz'), model_dir, threads).get(texts, max_tokens, 'missing roles', log=log)
    M = np.asarray(E, np.float32)[:, :dim] - mean; M = unit_rows(M)
    if vj.get('lang_dirs'):                          # the stored vectors are language-neutral: so are the new ones
        M = langfix.project(M, np.array(vj['lang_dirs'], np.float32))
    write_int8(bin_path, M, mode='ab')
    vj['ids'] += keep
    with open(json_path, 'w', encoding='utf-8') as fh:
        json.dump(vj, fh, separators=(',', ':'))
    log(f'added {len(keep)} vectors; {len(vj["ids"])} rows in total')
    return len(keep)


def embed_roles(site, profile, model_dir, vectors, only_missing=False, threads=4, log=print):
    """profile: a loaded profile, or None for the schema defaults (embed.prompt "search-query", 700 characters, 256 tokens)."""
    e = (profile or {}).get('embed') or {}
    prompt = e.get('prompt', 'search-query'); text_chars = e.get('text_chars', 700); max_tokens = e.get('max_tokens', 256)
    if prompt not in PROMPTS:
        raise RoleVectorError(f'embed.prompt {prompt!r}: unknown prompt')
    if only_missing:
        return embed_missing(site, prompt, text_chars, max_tokens, model_dir, vectors, threads, log)
    return embed_all(site, prompt, text_chars, max_tokens, model_dir, vectors, threads, log)
