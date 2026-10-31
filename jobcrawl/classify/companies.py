"""Companies on the same three axes as roles: what the company does (its type, the company counterpart of a role's function), what its work
is for (the same domains as roles) and how far along it is (its stage, the counterpart of a role's level).

    jobcrawl companies --profile P --site SITE [--vectors DIR] [--fit]

The nomenclature is the profile's company types file (profile key `company_types_file`, profiles/schema.md): types with stable ids,
English and German names, a code, a hue and colour and a seed pattern, the stages, and `retired` ({old id: id that took its companies}).

Type: like the role functions (classify/functions.py), a meaning centroid per type from the company vectors (VECTORS/company-vec.*) and a
word model over the catalogue text (name, field, tags, capabilities, segments, the first lines of the profile and snippet; unlike a role's
title, a company's own name is evidence: "University", "Consulting", "National Laboratory") and over what it hires for (the function
families of its roles on the board, as words "hires_<family>"),
seeded from the previous assignment, then the profile's name rules (`name_rules`: a pattern over the name that settles the type, before the
catalogue's own `arch`, which is wrong now and then), the catalogue's own `arch` (through `retired`), its entity type and kind, and each
type's seed pattern. Every company of the catalogue gets a type, a second one when it is close, and a confidence.
Stage: from the catalogue's facts only (entity type, founding year, employee range); `unknown` where there are none.
Domain: the domains (classify/domains.py) of the company's roles on the board when it has at least three, else of its catalogue text.
Hiring: the function family most of its roles on the board belong to (VECTORS/role-functions.json), or nothing.

Output: VECTORS/company-type-model.json (the fitted model) and VECTORS/company-types.json ({version, fields, ids: {slug: [type, type 2,
confidence, domain, domain 2, stage, hiring family, open roles]}}); publish copies company-types.json into SITE/match/. Needs numpy.
"""
import collections
import json
import os
import re
from datetime import date

try:
    import numpy as np
except ImportError:          # publish reads the types file without numpy
    np = None

from jobcrawl.classify import domains as dom
from jobcrawl.classify import functions as fx

MODEL_FILE = 'company-type-model.json'
ASSIGN_FILE = 'company-types.json'
FIELDS = ['type', 'type2', 'confidence', 'domain', 'domain2', 'stage', 'hiring', 'roles']


class CompaniesError(Exception):
    pass


def load_types(profile):
    """The parsed company types file of the profile, or None."""
    rel = profile.get('company_types_file')
    if not rel:
        return None
    path = os.path.join(profile['_dir'], rel)
    if not os.path.exists(path):
        raise CompaniesError(f'company_types_file not found: {path}')
    with open(path, encoding='utf-8') as fh:
        tax = json.load(fh)
    ids = [t['id'] for t in tax['types']]
    if len(set(ids)) != len(ids) or set(ids) & set(tax.get('retired') or {}):
        raise CompaniesError(f'{path}: a type id is listed twice or is also retired (ids are never reused)')
    return tax


def resolve(tax, tid):
    live = {t['id'] for t in tax['types']}
    retired = tax.get('retired') or {}
    for _ in range(10):
        if tid in live or not tid:
            return tid
        tid = retired.get(tid, '')
    return ''


def seed_text(c):
    """The curated fields of a catalogue entry (name, field, tags, organisation type): what the seed patterns and the gating
    evidence read. Not the profile prose, where nearly every company mentions "software" or "AI" somewhere, and not the generated
    capability and segment lists ("Avionics & Flight Software", "Technology and product consulting" on companies that are neither)."""
    lst = lambda v: ' '.join(map(str, v)) if isinstance(v, list) else str(v or '')
    return ' '.join(p for p in [c.get('name') or '', c.get('field') or '', lst(c.get('tags')), str(c.get('org_type_ra') or '')] if p)   # entity type: _academic()


def text_of(c):
    prof = c.get('profile') or {}
    prof = (prof.get('en') or '') if isinstance(prof, dict) else str(prof or '')
    parts = [c.get('name') or '', c.get('field') or '', ' '.join(c.get('tags') or []), ' '.join(map(str, c.get('capabilities') or [])) if isinstance(c.get('capabilities'), list) else str(c.get('capabilities') or ''),
             ' '.join(map(str, c.get('segments') or [])) if isinstance(c.get('segments'), list) else str(c.get('segments') or ''),
             str(c.get('org_type_ra') or ''), str(c.get('entity_type') or ''), prof[:400], (c.get('google_snippet') or '')[:200]]
    return ' '.join(p for p in parts if p)


# ---- stage: facts only
def _employees(c):
    for k in ('employees_range', 'employee_range', 'employees_space'):
        v = c.get(k)
        if v:
            n = [int(x) for x in re.findall(r'\d+', str(v).replace('.', '').replace(',', ''))]
            if n:
                return max(n)
    return None


def stage_of(c, ctype, today=None):
    """academic, startup, scaleup, established or unknown, from the catalogue's entity type, founding year and employee range."""
    if ctype == 'research_institute':
        return 'academic'
    year = None
    try:
        year = int(str(c.get('founded') or '')[:4])
    except ValueError:
        pass
    age = ((today or date.today()).year - year) if year else None
    emp = _employees(c)
    if (emp is not None and emp > 2000) or (age is not None and age > 20) or ctype == 'prime_integrator':
        return 'established'
    if c.get('arch') == 'frontier_scaleup' or (emp is not None and emp >= 50 and (age is None or age <= 20)):
        return 'scaleup'
    if age is not None and age <= 8 and (emp is None or emp < 50):
        return 'startup'
    if age is not None:
        return 'established' if age > 15 else 'scaleup'
    return 'unknown'


def _academic(tax, c):
    """The catalogue's entity type says research institute or university chair, and the name agrees (the research name rule, or TUM):
    the entity type alone is wrong now and then (quantum companies listed as university chairs)."""
    if c.get('entity_type') not in ('research_institute', 'university_chair'):
        return False
    rule = next((r for r in tax.get('name_rules') or [] if r['type'] == 'research_institute'), None)
    name = c.get('name') or ''
    return bool(re.search(r'\b(tum|technische universit\w*|technical university)\b', name, re.I) or (rule and re.search(rule['pattern'], name, re.I)))


def _seeds(tax, cat, rows, previous):
    """{type: set(row index)}: the previous assignment, else the catalogue's own type, entity type and kind, else one matching seed pattern."""
    members = collections.defaultdict(set)
    pats = {t['id']: re.compile(t['seed'], re.I) for t in tax['types'] if t.get('seed')}
    names = [(r['type'], re.compile(r['pattern'], re.I)) for r in tax.get('name_rules') or []]
    for i, (slug, _, _) in enumerate(rows):
        c = cat[slug]
        text = seed_text(c)
        t = resolve(tax, (previous or {}).get(slug, ''))
        if not t:
            t = next((k for k, rx in names if rx.search(c.get('name') or '')), '')
        if not t and _academic(tax, c):
            t = 'research_institute'
        if not t and c.get('kind') == 'board':
            t = 'board'
        if not t:                                       # the company's own words, when they name one type, before the catalogue's older keyword type
            hit = [k for k, rx in pats.items() if rx.search(text)]
            t = hit[0] if len(hit) == 1 else ''
        if not t:
            t = resolve(tax, c.get('arch') or '')
        if t and t in {x['id'] for x in tax['types']}:
            members[t].add(i)
    return members


def _evidence(tax, cat, rows):
    """{slug: set of types the company shows explicit evidence for}: a name rule, a seed pattern, its catalogue type, entity type or kind."""
    pats = {t['id']: re.compile(t['seed'], re.I) for t in tax['types'] if t.get('seed')}
    names = [(r['type'], re.compile(r['pattern'], re.I)) for r in tax.get('name_rules') or []]
    out = {}
    for slug, _, name in rows:
        c = cat[slug]
        text = seed_text(c)
        e = {k for k, rx in pats.items() if rx.search(text)} | {k for k, rx in names if rx.search(name or '')}
        e.add(resolve(tax, c.get('arch') or ''))
        if _academic(tax, c):
            e.add('research_institute')
        if c.get('kind') == 'board':
            e.add('board')
        out[slug] = e
    return out


def run(site, vectors, profile, refit=False, log=print):
    """Classifies every catalogue company and writes the files. Returns the assignment document."""
    from jobcrawl.site import read_site
    tax = load_types(profile)
    if not tax:
        raise CompaniesError('the profile names no company_types_file')
    cat = {}
    for slug, c in fx._catalogue(profile).items():
        if c.get('slug'):
            cat[c['slug']] = c
    if not cat:
        raise CompaniesError('no company catalogue (profile companies_catalogue)')
    with open(os.path.join(vectors, 'company-vec.json'), encoding='utf-8') as fh:
        vj = json.load(fh)
    with open(os.path.join(vectors, 'company-vec.bin'), 'rb') as fh:
        V = np.frombuffer(fh.read(), np.int8).reshape(-1, vj['dim']).astype(np.float32)
    vrow = {s: i for i, s in enumerate(vj['slugs'])}
    slugs = sorted(cat)
    rows = [(s, text_of(cat[s]), cat[s].get('name') or s) for s in slugs]
    X = np.zeros((len(rows), vj['dim']), np.float32); has = np.zeros(len(rows), bool)
    for i, s in enumerate(slugs):
        j = vrow.get(s)
        if j is not None and np.abs(V[j]).sum() > 0:
            X[i] = V[j] / max(np.linalg.norm(V[j]), 1e-9); has[i] = True
    fids = [t['id'] for t in tax['types']]
    # the company's roles on the board: their function families (hiring words), domains (below); by the company slug of jobs-index
    index, desc = read_site(site)
    rf = (fx.read_assignment(vectors) or {}).get('ids') or {}
    by_co = collections.defaultdict(list)
    for r in index:
        if len(r) > 4 and r[4] and r[0] in rf:
            by_co[r[4]].append(rf[r[0]])
    def hires(s):
        fam = collections.Counter(v[0].split('.')[0] for v in by_co.get(s, []) if v and v[0])
        n = sum(fam.values())
        return [f'hires_{f}' for f, k in fam.items() if n >= 3 and k >= 0.3 * n]
    toks = [fx.tokens(r[1], '') + hires(r[0]) for r in rows]
    prev_doc = _read(vectors, ASSIGN_FILE)
    previous = {s: v[0] for s, v in ((prev_doc or {}).get('ids') or {}).items() if v[2] >= fx.CONFIDENT * 100}
    mpath = os.path.join(vectors, MODEL_FILE)
    if refit or not os.path.exists(mpath):
        members = _seeds(tax, cat, rows, previous)
        empty = [t for t in fids if not members.get(t)]
        if empty:
            log(f'  company types without seeds: {", ".join(empty)}')
        C, words, tot = fx._fit(X, toks, members, fids)
        P = fx._probs(X, has, toks, C, words, tot)
        top, conf = P.argmax(1), P.max(1)
        again = collections.defaultdict(set, {k: set(v) for k, v in members.items()})
        for i in np.where(conf > fx.CONFIDENT)[0]:
            again[fids[top[i]]].add(int(i))
        C, words, tot = fx._fit(X, toks, again, fids)
        model = {'version': 1, 'types_version': tax.get('version', 1), 'functions': fids, 'dim': int(X.shape[1]),
                 'centroids': fx._b64(np.round(C * 127).astype(np.int8)), 'totals': [round(float(x), 1) for x in tot],
                 'words': {w: [[int(k), int(v[k])] for k in np.nonzero(v)[0]] for w, v in words.items()}}
        with open(mpath, 'w', encoding='utf-8') as fh:
            json.dump(model, fh, ensure_ascii=False, separators=(',', ':'))
        log(f'  fitted {len(fids)} company types on {int(has.sum())} companies')
    else:
        with open(mpath, encoding='utf-8') as fh:
            model = json.load(fh)
        C = fx._unb64(model['centroids'], np.int8).astype(np.float32).reshape(len(model['functions']), model['dim'])
        C /= np.maximum(np.linalg.norm(C, axis=1, keepdims=True), 1e-9)
        words = {}
        for w, pairs in model['words'].items():
            v = np.zeros(len(model['functions']), np.float32)
            for k, n in pairs:
                v[k] = n
            words[w] = v
        tot = np.array(model['totals'], np.float32); fids = model['functions']
    P = fx._probs(X, has, toks, C, words, tot)
    # gated types (job boards, consulting, investors, research, outside the field) need explicit evidence: the name rules, the type's seed
    # pattern, the catalogue's own type or entity type. Their profiles are generic, so the word model would otherwise pull every vague
    # company into them.
    # with gate_all, every type needs evidence and a company with none stays unclassified (type ''), instead of falling into whichever type
    # happens to be the default: its catalogue entry does not say what it does, and a guess would be presented as a fact
    gated = set(fids) if tax.get('gate_all') else {t['id'] for t in tax['types'] if t.get('gated')}
    none = np.zeros(len(slugs), bool)
    if gated:
        ev = _evidence(tax, cat, rows)
        for i, s in enumerate(slugs):
            for k, t in enumerate(fids):
                if t in gated and t not in ev[s]:
                    P[i, k] = 0
        none = P.sum(1) <= 0
        P /= np.maximum(P.sum(1, keepdims=True), 1e-12)
    verdict = fx._verdicts([(s,) for s in slugs], P, fids, has)
    for i in np.where(none)[0]:
        verdict[slugs[i]] = ['', '', 0]
    cdom = dom.classify([(s, cat[s].get('field') or '', text_of(cat[s]), s) for s in slugs], profile.get('domains') or [], cat)
    out = {}
    for s in slugs:
        t1, t2, cf = verdict[s]
        t1, t2 = resolve(tax, t1) or t1, (resolve(tax, t2) if t2 else '')
        roles = by_co.get(s, [])
        if len(roles) >= 3 and len(roles[0]) > 3:
            dc = collections.Counter(v[3] for v in roles if v[3])
            top2 = [d for d, _ in dc.most_common(2)]
            d1 = top2[0] if top2 else cdom.get(s, ['', ''])[0]
            d2 = top2[1] if len(top2) > 1 and dc[top2[1]] >= 0.25 * len(roles) else ''
        else:
            d1, d2 = cdom.get(s, ['', ''])
        hire = collections.Counter(v[0].split('.')[0] for v in roles if v and v[0])
        out[s] = [t1, t2 if cf else '', cf, d1, d2, stage_of(cat[s], t1), hire.most_common(1)[0][0] if hire else '', len(roles)]
    doc = {'version': 1, 'types_version': tax.get('version', 1), 'fields': FIELDS, 'ids': out}
    with open(os.path.join(vectors, ASSIGN_FILE), 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(',', ':'))
    c = collections.Counter(v[0] or '(unclassified)' for v in out.values())
    log(f'  {len(out)} companies: ' + ', '.join(f'{t} {n}' for t, n in c.most_common()))
    log('  stages: ' + ', '.join(f'{t} {n}' for t, n in collections.Counter(v[5] for v in out.values()).most_common()))
    return doc


def _read(vectors, name):
    path = os.path.join(vectors, name)
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def read_assignment(vectors):
    return _read(vectors, ASSIGN_FILE)
