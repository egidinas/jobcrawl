"""Company vectors: one vector per company of the optional catalogue, from its own text, in the role space.

Port of the reference implementation's embed_companies.py. The catalogue is the profile key companies_catalogue (a JSON file, see profiles/schema.md):
{"companies": [{"slug", "name", "field", "arch_name", "profile": {"en": "..."} or "text"}, ...]}. The text is the name, the field,
the archetype and the profile text (English), with the same prompt and length as the role vectors, so companies and roles share one
space (same mean, the first 256 numbers, unit length, language directions removed). Written as VECTORS/company-vec.bin and .json.
The atlas combines each company's vector with the centre of its open roles where it has any (jobcrawl/map/atlas.py).

    jobcrawl embed --site SITE --model-dir models/eg2 --profile P     (companies run when the profile names a catalogue)
"""
import ast
import json
import os

from jobcrawl.embed.embedder import Store, full_text
from jobcrawl.embed.roles import vector_paths, unit_rows, write_int8
from jobcrawl.text import langfix


class CompanyError(ValueError):
    pass


def catalogue_path(profile):
    rel = profile.get('companies_catalogue')
    if not rel:
        return None
    return os.path.join(profile['_dir'], rel)


def profile_text(c):
    """Name-free description of an employer: field, archetype and English profile text, in that order."""
    p = c.get('profile')
    if isinstance(p, str):
        try:
            p = ast.literal_eval(p)
        except (ValueError, SyntaxError):
            p = {'en': p}
    en = (p or {}).get('en', '') if isinstance(p, dict) else ''
    return ' '.join(x for x in (c.get('field') or '', c.get('arch_name') or '', en) if x)


def load_catalogue(path):
    with open(path, encoding='utf-8') as fh:
        cos = json.load(fh).get('companies')
    if not isinstance(cos, list):
        raise CompanyError(f'{path}: expected an object with a "companies" list')
    for i, c in enumerate(cos):
        if not isinstance(c, dict) or not c.get('slug') or not c.get('name'):
            raise CompanyError(f'{path}: companies[{i}] needs "slug" and "name"')
    return cos


def embed_companies(profile, model_dir, vectors, threads=4, log=print):
    import numpy as np
    path = catalogue_path(profile)
    if path is None:
        raise CompanyError('the profile has no companies_catalogue: nothing to embed')
    if not os.path.exists(path):
        raise CompanyError(f'companies_catalogue not found: {path}')
    bin_path, json_path = vector_paths(vectors)
    if not os.path.exists(json_path):
        raise CompanyError(f'no role vectors in {vectors} yet (run jobcrawl embed for the roles first; companies share their space)')
    with open(json_path, encoding='utf-8') as fh:
        vj = json.load(fh)
    dim = vj['dim']; mean = np.array(vj['mean'], np.float32)
    e = profile.get('embed') or {}
    prompt = e.get('prompt', 'search-query'); max_tokens = e.get('max_tokens', 256)
    cos = load_catalogue(path)
    texts = [full_text(c['name'], profile_text(c)[:900], prompt) for c in cos]
    E = Store(os.path.join(vectors, '.company-cache.npz'), model_dir, threads).get(texts, max_tokens, 'companies', log=log)
    M = np.asarray(E, np.float32)[:, :dim] - mean; M = unit_rows(M)
    if vj.get('lang_dirs'):
        M = langfix.project(M, np.array(vj['lang_dirs'], np.float32))
    write_int8(os.path.join(vectors, 'company-vec.bin'), M)
    with open(os.path.join(vectors, 'company-vec.json'), 'w', encoding='utf-8') as fh:
        json.dump({'dim': dim, 'slugs': [c['slug'] for c in cos], 'text': 'name + field + archetype + profile (en)', 'lang_dirs': vj.get('lang_dirs')},
                  fh, separators=(',', ':'))
    log(f'{len(cos)} company vectors; {sum(1 for c in cos if len(profile_text(c)) > 40)} with a profile text')
    return len(cos)
