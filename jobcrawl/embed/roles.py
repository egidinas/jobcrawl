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
    t = re.sub(r'\(R\d+\)|#\d+|\[\s*\d+\s*\]|\(\s*\d+\s*\)|\b\d{4,6}\b', '', t)
    t = re.sub(r'\b(1st|2nd|3rd|4th)\s+shift\b|\b(night|weekend|day)\s+shift\b|[-–]\s*shift\b', '', t, flags=re.I)
    return re.sub(r'\s+', ' ', t).strip(' -–,;[]()')



def role_rich_text(r, d, work_body, max_body_chars=2500):
    """Standardized, high-signal semantic representation for a job posting:
    - Clean Title, Seniority Level & Functional Archetype
    - Employer Name & Organization Sector Classification
    - Geographic Location & Regional Scope
    - Technical Topic Tags & Competencies
    - Substantive Mission Text (Responsibilities & Requirements) up to max_body_chars
    """
    parts = []
    title = clean_title(r[1])
    level = (d or {}).get('lv')
    func = (d or {}).get('a')
    title_str = title
    if level and level != 'general':
        title_str += f" ({level.capitalize()})"
    if func and func != 'general':
        title_str += f" · Function: {func.replace('_', ' ').title()}"
    parts.append(title_str)

    co_name = r[2]
    org_arch = (d or {}).get('oa')
    emp_str = f"Employer: {co_name}"
    if org_arch:
        emp_str += f" · Sector: {org_arch.replace('_', ' ').title()}"
    parts.append(emp_str)

    loc = (d or {}).get('l') or (r[5] if len(r) > 5 else '')
    reg = (d or {}).get('r')
    loc_parts = [p for p in (loc, reg) if p]
    if loc_parts:
        parts.append(f"Location: {' · '.join(loc_parts)}")

    tags = (d or {}).get('tg', [])
    if tags:
        parts.append(f"Technical Fields: {', '.join(tags)}")

    body = (work_body or '').strip()
    if max_body_chars and max_body_chars > 0 and len(body) > max_body_chars:
        body = body[:max_body_chars].rsplit(' ', 1)[0] + '…'
    if body:
        parts.append(f"Mission: {body}")

    return ' | '.join(parts)


def role_jobonly_text(r, work_body, max_body_chars=2500):
    """Sanitized job-description-only representation:
    Clean Title + Substantive Mission / Work text ONLY (no employer name, no company boilerplate, no sector, no logo).
    """
    title = clean_title(r[1])
    body = (work_body or '').strip()
    if max_body_chars and max_body_chars > 0 and len(body) > max_body_chars:
        body = body[:max_body_chars].rsplit(' ', 1)[0] + '…'
    return f"{title}. {body}" if body else title


def board_texts(site):
    """[(index row, description text, work text, desc_dict)] for every role on the board, in index order (as reembed_roles.board_texts)."""
    index, desc = read_site(site)
    by = collections.defaultdict(list)
    for r in index:
        by[r[2]].append((desc.get(r[0]) or {}).get('x') or '')
    boiler = wt.employer_boilerplate(by)
    out = []
    for r in index:
        d = desc.get(r[0]) or {}
        x = d.get('x') or ''
        raw = d.get('job_description_raw') or x
        if '=== JOB MISSION START ===' in raw:
            m = re.search(r'=== JOB MISSION START ===\s*(.*?)\s*=== JOB MISSION END ===', raw, re.DOTALL)
            raw = m.group(1).strip() if m else raw
        body = wt.work_text(r[1], raw, boiler.get(r[2], frozenset()), segment_sections)
        out.append((r, x, body, d))
    return out



def vector_paths(vectors, variant=''):
    prefix = f"{MATCH_VEC}-{variant}" if variant else MATCH_VEC
    return (os.path.join(vectors, prefix + '.bin'), os.path.join(vectors, prefix + '.json'))


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
    for r, x, body, d in random.sample(rows, min(n, len(rows))):
        rt = role_rich_text(r, d, body)
        jo = role_jobonly_text(r, body)
        log(f'--- {r[2]} | {r[1]}\n  rich:    {rt[:260]!r}\n  jobonly: {jo[:260]!r}')
    kept = sum(1 for _, _, b, _ in rows if len(b) >= MIN_CHARS)
    log(f'{kept} of {len(rows)} roles have {MIN_CHARS}+ characters of work text')


def embed_all(site, prompt, text_chars, max_tokens, model_dir, vectors, threads=4, log=print, encode_jobonly=True):
    """Full run: embeds both the rich standardized version and the sanitized job-only description."""
    import numpy as np
    rows = board_texts(site)
    keep = [(r, d, b) for r, _, b, d in rows if len(b) >= MIN_CHARS]
    if not keep:
        raise RoleVectorError(f'no role on the board has {MIN_CHARS}+ characters of work text (check the descriptions in {site})')

    # 1. Rich Standardized Encoding (Title + Level + Employer + Sector + Location + Tags + Mission + Multimodal Logo)
    texts_rich = [full_text(clean_title(r[1]), role_rich_text(r, d, b, max_body_chars=text_chars), prompt) for r, d, b in keep]
    base_assets = os.path.join(site, 'assets', 'company')
    if not os.path.exists(base_assets):
        base_assets = os.path.join(os.path.dirname(site), 'site', 'assets', 'company')
    images = []
    for r, d, _ in keep:
        slug = (d or {}).get('cs') or (r[4] if len(r) > 4 and r[4] else '')
        if not slug:
            slug = re.sub(r'[^a-z0-9]+', '-', r[2].lower()).strip('-')
        p = os.path.join(base_assets, f"{slug}.png")
        if not os.path.exists(p):
            p = os.path.join(base_assets, f"{slug}.webp")
        images.append(p if os.path.exists(p) else None)

    max_tokens = max(max_tokens, 384)
    texts_jobonly = None
    if encode_jobonly:
        texts_jobonly = [full_text(clean_title(r[1]), role_jobonly_text(r, b, max_body_chars=text_chars), prompt) for r, d, b in keep]

    if text_chars == 0:
        try:
            from tokenizers import Tokenizer
            tok_path = os.path.join(model_dir, 'tokenizer.json')
            if os.path.exists(tok_path):
                tok = Tokenizer.from_file(tok_path)
                check_texts = list(texts_rich)
                if texts_jobonly:
                    check_texts.extend(texts_jobonly)
                tok_lens = [len(tok.encode(t).ids) for t in check_texts]
                max_tokens = max(max(tok_lens), max_tokens)
                log(f'Dynamic maxlen set to {max_tokens} tokens (zero cutoff across all {len(keep)} roles)')
        except Exception:
            pass
    store = Store(os.path.join(vectors, '.embed-cache.npz'), model_dir, threads)
    E_rich = np.asarray(store.get(texts_rich, max_tokens, 'roles (rich multimodal)', images=images, log=log), np.float32)
    M_rich = E_rich[:, :DIM]; mean_rich = M_rich.mean(0); M_rich = unit_rows(M_rich - mean_rich)
    langs = np.array([langfix.language(r[1] + ' ' + b[:2000]) for r, _, b in keep])
    D_rich = langfix.directions(M_rich, langs); M_rich = langfix.project(M_rich, D_rich)

    os.makedirs(vectors, exist_ok=True)
    bin_path, json_path = vector_paths(vectors)
    write_int8(bin_path, M_rich)
    meta_rich = {'dim': DIM, 'max_tokens': max_tokens, 'text_chars': text_chars, 'mean': [round(float(x), 5) for x in mean_rich], 'ids': [r[0] for r, _, _ in keep], 'prompt': PROMPTS[prompt][0],
                 'text': f'rich standardized role text (title, level, employer, sector, location, tags, mission up to {text_chars} chars) + multimodal logo',
                 'lang_dirs': [[round(float(x), 6) for x in d] for d in D_rich], 'lang_dirs_from': {l: int((langs == l).sum()) for l in ('en', 'de', 'fr', 'es')}}
    with open(json_path, 'w', encoding='utf-8') as fh:
        json.dump(meta_rich, fh, separators=(',', ':'))
    log(f'{len(keep)} rich role vectors written to {bin_path} (multimodal logos: {sum(1 for im in images if im)})')

    # 2. Sanitized Job-Only Description Encoding (Clean Title + Substantive Mission ONLY, no employer, no logo)
    if encode_jobonly:
        if texts_jobonly is None:
            texts_jobonly = [full_text(clean_title(r[1]), role_jobonly_text(r, b, max_body_chars=text_chars), prompt) for r, d, b in keep]
        E_jobonly = np.asarray(store.get(texts_jobonly, max_tokens, 'roles (sanitized job-only)', images=None, log=log), np.float32)
        M_jobonly = E_jobonly[:, :DIM]; mean_jobonly = M_jobonly.mean(0); M_jobonly = unit_rows(M_jobonly - mean_jobonly)
        D_jobonly = langfix.directions(M_jobonly, langs); M_jobonly = langfix.project(M_jobonly, D_jobonly)

        bin_jobonly, json_jobonly = vector_paths(vectors, variant='jobonly')
        write_int8(bin_jobonly, M_jobonly)
        meta_jobonly = {'dim': DIM, 'max_tokens': max_tokens, 'text_chars': text_chars, 'mean': [round(float(x), 5) for x in mean_jobonly], 'ids': [r[0] for r, _, _ in keep], 'prompt': PROMPTS[prompt][0],
                        'text': f'sanitized job description only (title + mission up to {text_chars} chars, no company metadata, no logo)',
                        'lang_dirs': [[round(float(x), 6) for x in d] for d in D_jobonly], 'lang_dirs_from': {l: int((langs == l).sum()) for l in ('en', 'de', 'fr', 'es')}}
        with open(json_jobonly, 'w', encoding='utf-8') as fh:
            json.dump(meta_jobonly, fh, separators=(',', ':'))
        log(f'{len(keep)} sanitized job-only vectors written to {bin_jobonly}')

        # 3. Analyze semantic shift / boilerplate drift
        cos_sim = (M_rich * M_jobonly).sum(axis=1)
        mean_cos = float(cos_sim.mean())
        q10, q50, q90 = float(np.percentile(cos_sim, 10)), float(np.percentile(cos_sim, 50)), float(np.percentile(cos_sim, 90))
        analysis = {
            'total_roles': len(keep),
            'cosine_similarity': {
                'mean': round(mean_cos, 4),
                'median': round(q50, 4),
                'p10': round(q10, 4),
                'p90': round(q90, 4),
                'min': round(float(cos_sim.min()), 4),
                'max': round(float(cos_sim.max()), 4)
            }
        }
        analysis_path = os.path.join(vectors, 'rich_vs_jobonly_analysis.json')
        with open(analysis_path, 'w', encoding='utf-8') as fh:
            json.dump(analysis, fh, indent=2)
        log(f'Boilerplate vs Mission Drift Analysis: mean cosine similarity = {mean_cos:.4f} (median: {q50:.4f}, p10: {q10:.4f}, p90: {q90:.4f}) -> {analysis_path}')

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
    texts, keep_roles, images, todo = [], [], [], 0
    base_assets = os.path.join(site, 'assets', 'company')
    if not os.path.exists(base_assets):
        base_assets = os.path.join(os.path.dirname(site), 'site', 'assets', 'company')
    for r, _, body, d in board_texts(site):
        if r[0] in have:
            continue
        todo += 1
        if len(body) < MIN_CHARS:
            continue                                   # too little work text: keywords only, as in the main run
        texts.append(full_text(clean_title(r[1]), role_rich_text(r, d, body, max_body_chars=text_chars), prompt))
        keep_roles.append((r, body))
        slug = (d or {}).get('cs') or (r[4] if len(r) > 4 and r[4] else '')
        if not slug:
            slug = re.sub(r'[^a-z0-9]+', '-', r[2].lower()).strip('-')
        p = os.path.join(base_assets, f"{slug}.png")
        if not os.path.exists(p):
            p = os.path.join(base_assets, f"{slug}.webp")
        images.append(p if os.path.exists(p) else None)

    keep = [r[0] for r, _ in keep_roles]
    log(f'{todo} roles without a vector, {len(keep)} with enough text to embed')
    if not keep:
        return 0

    max_tokens = max(max_tokens, vj.get('max_tokens', 384))
    if text_chars == 0:
        try:
            from tokenizers import Tokenizer
            tok_path = os.path.join(model_dir, 'tokenizer.json')
            if os.path.exists(tok_path):
                tok = Tokenizer.from_file(tok_path)
                tok_lens = [len(tok.encode(t).ids) for t in texts]
                max_tokens = max([vj.get('max_tokens', 384)] + tok_lens)
                log(f'Dynamic maxlen set to {max_tokens} tokens for missing roles')
        except Exception:
            pass

    store = Store(os.path.join(vectors, '.embed-cache.npz'), model_dir, threads)
    E = store.get(texts, max_tokens, 'missing roles (rich multimodal)', images=images, log=log)
    M = np.asarray(E, np.float32)[:, :dim] - mean; M = unit_rows(M)
    if vj.get('lang_dirs'):                          # the stored vectors are language-neutral: so are the new ones
        M = langfix.project(M, np.array(vj['lang_dirs'], np.float32))
    write_int8(bin_path, M, mode='ab')
    vj['ids'] += keep
    vj['max_tokens'] = max_tokens
    with open(json_path, 'w', encoding='utf-8') as fh:
        json.dump(vj, fh, separators=(',', ':'))
    log(f'added {len(keep)} vectors; {len(vj["ids"])} rows in total')

    # Job-only variant update if match-vec-jobonly.json exists
    bin_jobonly, json_jobonly = vector_paths(vectors, variant='jobonly')
    if os.path.exists(json_jobonly):
        with open(json_jobonly, encoding='utf-8') as fh:
            vj_jobonly = json.load(fh)
        dim_jobonly = vj_jobonly['dim']
        mean_jobonly = np.array(vj_jobonly['mean'], np.float32)
        texts_jobonly = [full_text(clean_title(r[1]), role_jobonly_text(r, body, max_body_chars=text_chars), prompt) for r, body in keep_roles]

        max_tokens_jobonly = max(max_tokens, vj_jobonly.get('max_tokens', 384))
        if text_chars == 0:
            try:
                from tokenizers import Tokenizer
                tok_path = os.path.join(model_dir, 'tokenizer.json')
                if os.path.exists(tok_path):
                    tok = Tokenizer.from_file(tok_path)
                    tok_lens_jobonly = [len(tok.encode(t).ids) for t in texts_jobonly]
                    max_tokens_jobonly = max([vj_jobonly.get('max_tokens', max_tokens)] + tok_lens_jobonly)
            except Exception:
                pass

        E_jobonly = store.get(texts_jobonly, max_tokens_jobonly, 'missing roles (sanitized job-only)', images=None, log=log)
        M_jobonly = np.asarray(E_jobonly, np.float32)[:, :dim_jobonly] - mean_jobonly
        M_jobonly = unit_rows(M_jobonly)
        if vj_jobonly.get('lang_dirs'):
            M_jobonly = langfix.project(M_jobonly, np.array(vj_jobonly['lang_dirs'], np.float32))
        write_int8(bin_jobonly, M_jobonly, mode='ab')
        vj_jobonly['ids'] += keep
        vj_jobonly['max_tokens'] = max_tokens_jobonly
        with open(json_jobonly, 'w', encoding='utf-8') as fh:
            json.dump(vj_jobonly, fh, separators=(',', ':'))
        log(f'added {len(keep)} job-only vectors; {len(vj_jobonly["ids"])} rows in total')

    return len(keep)


def embed_roles(site, profile, model_dir, vectors, only_missing=False, threads=4, log=print):
    """profile: a loaded profile, or None for the schema defaults (embed.prompt "search-query", zero cutoff, dynamic maxlen)."""
    e = (profile or {}).get('embed') or {}
    prompt = e.get('prompt', 'search-query')
    raw_chars = e.get('text_chars', 0)
    text_chars = 0 if raw_chars == 0 else max(raw_chars, 2000)
    max_tokens = max(e.get('max_tokens', 0), 0)
    if prompt not in PROMPTS:
        raise RoleVectorError(f'embed.prompt {prompt!r}: unknown prompt')
    if only_missing:
        return embed_missing(site, prompt, text_chars, max_tokens, model_dir, vectors, threads, log)
    return embed_all(site, prompt, text_chars, max_tokens, model_dir, vectors, threads, log)

