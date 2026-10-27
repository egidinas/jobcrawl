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


def company_rich_text(c):
    """Rich, standard semantic document for a company catalogue entry at full quality:
    - Sector & Archetype classification
    - Geographic headquarters & regional scope
    - Technical capabilities & domain competencies taxonomy
    - Standard executive summary & Google search snippet
    - Detailed operational descriptions (bilingual English and German)
    - Corporate / market status (stock listing, parent corporation, ownership)
    - Inception year & Research Organization Registry (ROR) identifier
    """
    sections = []

    # 1. Classification & Geo
    meta_parts = []
    if c.get('field'):
        meta_parts.append(c['field'])
    if c.get('arch_name') or c.get('arch'):
        meta_parts.append(f"Classification: {c.get('arch_name') or c.get('arch')}")
    loc_parts = [c.get('city'), c.get('region'), c.get('country')]
    loc_str = ', '.join(p for p in loc_parts if p)
    if loc_str:
        meta_parts.append(f"Location: {loc_str}")
    if meta_parts:
        sections.append(' · '.join(meta_parts))

    # 2. Technical Capabilities Taxonomy
    caps = c.get('capabilities', [])
    if caps:
        sections.append(f"Capabilities: {', '.join(caps)}")

    # 3. Google Search Snippet Overview
    snippet = (c.get('google_snippet') or '').strip()
    if snippet:
        sections.append(f"Overview: {snippet}")

    # 4. Comprehensive Operational Profiles (Bilingual EN & DE)
    prof = c.get('profile', {})
    if isinstance(prof, str):
        try:
            prof = ast.literal_eval(prof)
        except Exception:
            prof = {'en': prof}
    en = (prof or {}).get('en', '').strip()
    de = (prof or {}).get('de', '').strip()
    if en:
        sections.append(f"Profile (EN): {en}")
    if de and de != en:
        sections.append(f"Profil (DE): {de}")

    # 5. Corporate Status, Stock, Founded, ROR
    corp = []
    stock = c.get('stock', {})
    if stock:
        status = stock.get('status', 'Enterprise')
        ticker = stock.get('ticker')
        exchange = stock.get('exchange')
        parent = stock.get('parent')
        ownership = stock.get('ownership')
        s_parts = [status]
        if ticker:
            s_parts.append(f"Ticker: {ticker} ({exchange or 'Public'})")
        if parent:
            s_parts.append(f"Parent: {parent}")
        if ownership:
            s_parts.append(f"Ownership: {ownership}")
        corp.append('; '.join(s_parts))
    if c.get('founded'):
        corp.append(f"Founded: {c['founded']}")
    if c.get('ror_id'):
        corp.append(f"ROR: {c['ror_id']}")
    if corp:
        sections.append(' | '.join(corp))

    return ' | '.join(sections)


def profile_text(c):
    return company_rich_text(c)



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
    prompt = e.get('prompt', 'search-query')
    max_tokens = max(e.get('max_tokens', 256), 384)
    cos = load_catalogue(path)
    texts = [full_text(c['name'], company_rich_text(c), prompt) for c in cos]
    base_assets = os.path.join(os.path.dirname(os.path.dirname(path)), 'assets', 'company')
    images = []
    for c in cos:
        logo_path = c.get('logo')
        full_logo = None
        if logo_path:
            full_logo = os.path.join(os.path.dirname(os.path.dirname(path)), logo_path.lstrip('/'))
        if not full_logo or not os.path.exists(full_logo):
            p = os.path.join(base_assets, f"{c['slug']}.png")
            if os.path.exists(p):
                full_logo = p
        images.append(full_logo)
    E = Store(os.path.join(vectors, '.company-cache.npz'), model_dir, threads).get(texts, max_tokens, 'companies', images=images, log=log)
    M = np.asarray(E, np.float32)[:, :dim] - mean; M = unit_rows(M)
    if vj.get('lang_dirs'):
        M = langfix.project(M, np.array(vj['lang_dirs'], np.float32))
    write_int8(os.path.join(vectors, 'company-vec.bin'), M)
    with open(os.path.join(vectors, 'company-vec.json'), 'w', encoding='utf-8') as fh:
        json.dump({'dim': dim, 'slugs': [c['slug'] for c in cos], 'text': 'name + field + archetype + capabilities + snippet + profiles (en+de) + stock + multimodal logo', 'lang_dirs': vj.get('lang_dirs')},
                  fh, separators=(',', ':'))
    log(f'{len(cos)} company vectors; {sum(1 for c in cos if len(company_rich_text(c)) > 40)} with a rich profile text ({sum(1 for im in images if im)} with logo)')
    return len(cos)

