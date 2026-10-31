"""Job functions: what a role does, on a stable two-level nomenclature (family.function), discovered from the roles' meaning and kept.

    jobcrawl functions --profile P --site SITE [--vectors DIR] [--fit]

The nomenclature is the profile's functions file (profile key `functions_file`, profiles/schema.md): families and functions with stable ids
("electronics.rf"), English and German names, one colour per family, and a title pattern per function that seeds it. Ids are never reused:
a function that is merged or split is listed under `retired` with the id that took its roles, so old links and filters still resolve.

Fit (--fit, with a map rebuild): the roles' vectors without language and employer signatures (map/atlas.prepare) and without the seniority
directions (the class means of the title's seniority rung, classify/seniority.py: a director and an engineer in the same work sit together)
teach each function a meaning centroid and a title-word model (words of the employer's own name removed first). The seeds are the roles the
previous assignment placed with confidence, so a refit keeps the groups where they were, plus the roles whose title matches exactly one
function's pattern. One round of self-training on the confident roles follows. Roles that fit no function well are grouped and listed as
candidates in the log: the occasional new function is added to the functions file by hand, with a new id.

Assign (every run): each role gets the function where meaning and title agree best, with its confidence; a hybrid role also gets the
runner-up when that is at least half as likely (fn2). A role without a vector is assigned from its title alone.

Output (vectors folder): function-model.json (the fitted model) and role-functions.json ({version, functions file version, ids: {role id:
[function, function 2 or "", confidence 0-100]}}); publish copies role-functions.json into SITE/match/. Needs numpy.
"""
import base64
import collections
import json
import os
import re

try:
    import numpy as np
except ImportError:          # publish reads the functions file and the assignment without numpy; fitting and assigning need it
    np = None

from jobcrawl.classify import seniority

MODEL_FILE = 'function-model.json'
ASSIGN_FILE = 'role-functions.json'
ALPHA = 0.42            # weight of the meaning vector against the title words (the title is the sharper signal; the description can be about the employer)
TAU = 0.04              # temperature of the cosine softmax
SMOOTH = 8.0            # Dirichlet smoothing of the title words towards their share over all functions (an unseen word costs every function the same)
HYBRID = (0.5, 0.2)     # a second function when its probability is at least half the first's and above 0.2
CONFIDENT = 0.6         # roles above this confidence seed the next fit
TRIM = 0.75             # the share of a function's seeds nearest its centroid that fit it (the rest are dropped as outliers)
RUNGS = {'Chief': 'exec', 'Director': 'exec', 'Head': 'lead', 'Lead': 'lead', 'Manager': 'manager', 'Principal': 'senior', 'Senior': 'senior',
         'Junior': 'early', 'Doctoral': 'early', 'Student': 'student', '': 'none'}
TOKEN = re.compile(r"[a-zäöüßéèàç0-9+#&/.-]{2,}")
NOISE = re.compile(r'\b(m/w/d|w/m/d|m/f/d|f/m/d|d/f/m|m/w/x|w/m/x|f/m/x|all genders?|alle geschlechter|h/f|f/h|mfd|mwd|[a-z]?\d{3,})\b')
KEEP_COMPANY_WORDS = {'group', 'gmbh', 'systems', 'system', 'technologies', 'technology', 'space', 'aerospace', 'defence', 'defense',
                      'engineering', 'solutions', 'robotics', 'research'}


class FunctionsError(Exception):
    pass


# ---- the nomenclature
def load_functions(profile):
    """The parsed functions file of the profile ({families, functions, retired, version}), or None when the profile names none."""
    rel = profile.get('functions_file')
    if not rel:
        return None
    path = os.path.join(profile['_dir'], rel)
    if not os.path.exists(path):
        raise FunctionsError(f'functions_file not found: {path}')
    with open(path, encoding='utf-8') as fh:
        tax = json.load(fh)
    fams = {f['id'] for f in tax['families']}
    seen = set()
    for f in tax['functions']:
        if f['id'] in seen or f['id'] in (tax.get('retired') or {}):
            raise FunctionsError(f'{path}: function id {f["id"]} listed twice (ids are never reused)')
        seen.add(f['id'])
        if f['id'].split('.')[0] not in fams:
            raise FunctionsError(f'{path}: function {f["id"]} has no family {f["id"].split(".")[0]}')
    return tax


def resolve(tax, fid):
    """The current id for a function id (a retired id follows its `retired` chain), or '' when unknown."""
    live = {f['id'] for f in tax['functions']}
    retired = tax.get('retired') or {}
    for _ in range(10):
        if fid in live or not fid:
            return fid
        fid = retired.get(fid, '')
    return ''


# ---- text
def strip_employer(title, company):
    """The title without the employer's own name and the distinctive words of it: "Quantum Systems" is a drone maker, its name is no evidence."""
    co = re.sub(r'\s*[\(\[].*$', '', (company or '').lower()).strip()
    t = (title or '').lower()
    if len(co) > 3:
        t = t.replace(co, ' ')
    for w in set(re.findall(r'[a-zäöüß]{3,}', co)) - KEEP_COMPANY_WORDS:
        t = re.sub(r'\b' + re.escape(w) + r'\b', ' ', t)
    return t


def tokens(title, company=''):
    """Title words and word pairs, without gender markers, reference numbers and the employer's name."""
    t = NOISE.sub(' ', strip_employer(title, company))
    w = [x.strip('.-/') for x in TOKEN.findall(t)]
    w = [x for x in w if len(x) > 1]
    return w + [a + '_' + b for a, b in zip(w, w[1:])]


def rung_class(title):
    return RUNGS[seniority.level(title)[0]]


# ---- vectors
def seniority_directions(X, titles):
    """An orthonormal basis (dim x r) of the seniority directions: the mean of each rung's roles minus the mean of all roles."""
    cls = np.array([rung_class(t) for t in titles])
    g = X.mean(0)
    D = [X[cls == c].mean(0) - g for c in ('exec', 'lead', 'manager', 'senior', 'early', 'student') if (cls == c).sum() >= 5]
    if not D:
        return np.zeros((X.shape[1], 0), np.float32)
    Q, _ = np.linalg.qr(np.stack(D).T)
    return Q.astype(np.float32)


def project(X, Q):
    Y = X - (X @ Q) @ Q.T if Q.shape[1] else X.copy()
    return Y / np.maximum(np.linalg.norm(Y, axis=1, keepdims=True), 1e-9)


# ---- the model
def _fit(Xs, toks, members, fids):
    K, dim = len(fids), Xs.shape[1]
    C = np.zeros((K, dim), np.float32)
    for k, f in enumerate(fids):
        m = list(members.get(f) or ())
        if not m:
            continue
        c = Xs[m].mean(0); c /= max(np.linalg.norm(c), 1e-9)
        if len(m) > 12:      # the seeds farthest from the centroid are dropped and the centroid fitted again
            d = Xs[m] @ c
            m = [m[j] for j in np.argsort(-d)[:max(8, int(len(m) * TRIM))]]
            c = Xs[m].mean(0); c /= max(np.linalg.norm(c), 1e-9)
        C[k] = c
    words = collections.defaultdict(lambda: np.zeros(K, np.float32)); tot = np.zeros(K, np.float32)
    for k, f in enumerate(fids):
        for i in members.get(f) or ():
            for w in set(toks[i]):
                words[w][k] += 1
            tot[k] += 1
    words = {w: v for w, v in words.items() if v.sum() >= 2}       # a word seen once is noise
    return C, words, tot


def _probs(Xs, has_vec, toks, C, words, tot):
    N, K = len(toks), len(C)
    LT = np.zeros((N, K), np.float32)
    bg = {w: float(v.sum()) / max(float(tot.sum()), 1.0) for w, v in words.items()}
    for i in range(N):
        for w in set(toks[i]):
            v = words.get(w)
            if v is None:
                continue
            LT[i] += np.log((v + SMOOTH * bg[w]) / (tot + SMOOTH)) - np.log(bg[w])
    LT += np.log((tot + 1) / (tot.sum() + K))
    LT -= LT.max(1, keepdims=True); LT -= np.log(np.exp(LT).sum(1, keepdims=True))
    LT = np.maximum(LT, -12)
    LV = (Xs @ C.T) / TAU
    LV -= LV.max(1, keepdims=True); LV -= np.log(np.exp(LV).sum(1, keepdims=True))
    L = np.where(has_vec[:, None], ALPHA * LV + (1 - ALPHA) * LT, LT)      # no vector: the title alone
    P = np.exp(L - L.max(1, keepdims=True))
    return P / P.sum(1, keepdims=True)


def _seed_patterns(tax):
    return {f['id']: re.compile(f['seed'], re.I) for f in tax['functions'] if f.get('seed')}


def fit(rows, X, has_vec, tax, previous=None, log=print):
    """rows: [(id, title, company)], X: the cleaned vectors (zero rows where has_vec is False). previous: {id: function id} of the last
    assignment (resolved through `retired`). Returns (model dict, assignment {id: [fn, fn2, confidence]})."""
    titles = [r[1] or '' for r in rows]
    Q = seniority_directions(X[has_vec], [t for t, h in zip(titles, has_vec) if h])
    Xs = project(X, Q) * has_vec[:, None]
    toks = [tokens(r[1], r[2]) for r in rows]
    fids = [f['id'] for f in tax['functions']]
    members = collections.defaultdict(set)
    if previous:
        for i, r in enumerate(rows):
            f = resolve(tax, previous.get(r[0], ''))
            if f:
                members[f].add(i)
    pats = _seed_patterns(tax)
    hit = collections.defaultdict(list)
    for i, t in enumerate(titles):
        for f, rx in pats.items():
            if rx.search(t):
                hit[i].append(f)
    for i, fs in hit.items():
        if len(fs) == 1 and not (previous and rows[i][0] in previous):      # a title that names one function only, and no earlier verdict
            members[fs[0]].add(i)
    empty = [f for f in fids if not members.get(f)]
    if empty:
        log(f'  functions without seeds (their title pattern matches no role): {", ".join(empty)}')
    C, words, tot = _fit(Xs, toks, members, fids)
    P = _probs(Xs, has_vec, toks, C, words, tot)
    top, conf = P.argmax(1), P.max(1)
    again = collections.defaultdict(set)
    for f in members:
        again[f] |= members[f]
    for i in np.where(conf > CONFIDENT)[0]:
        again[fids[top[i]]].add(int(i))
    C, words, tot = _fit(Xs, toks, again, fids)
    model = {'version': 1, 'functions_version': tax.get('version', 1), 'functions': fids, 'dim': int(X.shape[1]),
             'alpha': ALPHA, 'tau': TAU, 'smooth': SMOOTH, 'hybrid': list(HYBRID),
             'seniority': _b64(Q.astype(np.float16)), 'seniority_shape': list(Q.shape),
             'centroids': _b64(np.round(C * 127).astype(np.int8)),
             'totals': [round(float(x), 1) for x in tot],
             'words': {w: [[int(k), int(v[k])] for k in np.nonzero(v)[0]] for w, v in words.items()}}
    P = _probs(Xs, has_vec, toks, C, words, tot)
    out = _verdicts(rows, P, fids, has_vec)
    candidates(rows, Xs, has_vec, P, log)
    return model, out


TITLE_ONLY_CAP = 59     # a verdict from the title alone is weaker (about 5 in 6 right against 9 in 10): it is capped below CONFIDENT, so it never seeds a fit


def _verdicts(rows, P, fids, has_vec):
    o = np.argsort(-P, 1)
    out = {}
    for i, r in enumerate(rows):
        a, b = o[i, 0], o[i, 1]
        p1, p2 = float(P[i, a]), float(P[i, b])
        c = int(round(100 * p1))
        out[r[0]] = [fids[a], fids[b] if (p2 >= HYBRID[0] * p1 and p2 > HYBRID[1]) else '', c if has_vec[i] else min(c, TITLE_ONLY_CAP)]
    return out


def candidates(rows, Xs, has_vec, P, log=print, below=0.45, min_size=25):
    """Logs groups among the roles no function fits well: material for a new function in the functions file."""
    low = [i for i in np.where(P.max(1) < below)[0] if has_vec[i]]
    if len(low) < min_size:
        return []
    Y = Xs[low]; S = Y @ Y.T; np.fill_diagonal(S, -1)
    k = min(8, len(low) - 1); nb = np.argpartition(-S, k, axis=1)[:, :k]
    seen, groups = set(), []
    for a in range(len(low)):                                   # connected groups of mutual near neighbours (simple, no Leiden needed)
        if a in seen:
            continue
        stack, g = [a], []
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x); g.append(x)
            stack += [int(y) for y in nb[x] if x in nb[y] and y not in seen]
        if len(g) >= min_size:
            groups.append(g)
    for g in sorted(groups, key=len, reverse=True)[:5]:
        w = collections.Counter(x for i in g for x in set(tokens(rows[low[i]][1], rows[low[i]][2])) if '_' not in x)
        log(f'  candidate group of {len(g)} roles no function fits well: {", ".join(x for x, _ in w.most_common(6))}')
    return groups


def assign(model, rows, X, has_vec, tax=None):
    """{id: [fn, fn2, confidence]} for rows with the fitted model; X the cleaned vectors (language and employer removed) or zeros."""
    Q = _unb64(model['seniority'], np.float16).astype(np.float32).reshape(model['seniority_shape'])
    Xs = project(X, Q) * has_vec[:, None]
    fids = model['functions']; K = len(fids)
    C = _unb64(model['centroids'], np.int8).astype(np.float32).reshape(K, model['dim'])
    C /= np.maximum(np.linalg.norm(C, axis=1, keepdims=True), 1e-9)
    words = {}
    for w, pairs in model['words'].items():
        v = np.zeros(K, np.float32)
        for k, c in pairs:
            v[k] = c
        words[w] = v
    tot = np.array(model['totals'], np.float32)
    P = _probs(Xs, has_vec, [tokens(r[1], r[2]) for r in rows], C, words, tot)
    out = _verdicts(rows, P, fids, has_vec)
    if tax:
        out = {i: [resolve(tax, a) or a, resolve(tax, b) if b else '', c] for i, (a, b, c) in out.items()}
    return out


def _b64(a):
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode('ascii')


def _unb64(s, dtype):
    return np.frombuffer(base64.b64decode(s), dtype)


# ---- files
def read_assignment(vectors):
    path = os.path.join(vectors, ASSIGN_FILE)
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def run(site, vectors, profile, refit=False, log=print):
    """Assigns every role of the site (fits the model first with refit, or when there is none) and writes the files. Returns the assignment."""
    from jobcrawl.map import atlas
    from jobcrawl.site import read_site
    tax = load_functions(profile)
    if not tax:
        raise FunctionsError('the profile names no functions_file')
    index, _ = read_site(site)
    rows = [(r[0], r[1], r[2]) for r in index]
    cfg, keep, X, X0, desc, prefs, employer, titles, fields_of, scope_of = atlas.prepare(site, vectors, profile)
    row = {r[0]: i for i, r in enumerate(keep)}
    V = np.zeros((len(rows), X.shape[1]), np.float32)
    has = np.zeros(len(rows), bool)
    for i, r in enumerate(rows):
        j = row.get(r[0])
        if j is not None and np.abs(X[j]).sum() > 0:
            V[i] = X[j]; has[i] = True
    mpath = os.path.join(vectors, MODEL_FILE)
    prev = read_assignment(vectors)
    if refit or not os.path.exists(mpath):
        previous = {i: v[0] for i, v in ((prev or {}).get('ids') or {}).items() if v[2] >= CONFIDENT * 100}
        model, out = fit(rows, V, has, tax, previous, log)
        with open(mpath, 'w', encoding='utf-8') as fh:
            json.dump(model, fh, ensure_ascii=False, separators=(',', ':'))
        log(f'  fitted {len(model["functions"])} functions on {int(has.sum())} roles with vectors ({len(rows) - int(has.sum())} from the title alone)')
    else:
        with open(mpath, encoding='utf-8') as fh:
            model = json.load(fh)
        known = set(model['functions'])
        missing = [f['id'] for f in tax['functions'] if f['id'] not in known]
        if missing:
            log(f'  the model does not know {", ".join(missing)} yet: run jobcrawl functions --fit')
        out = assign(model, rows, V, has, tax)
    # the other two axes of a role, beside its function: the domain (classify/domains.py, with the employer's catalogue entry as a prior) and
    # the level (the profile's levels): one record per role, so the board, the atlas and the map read the same verdicts
    from jobcrawl.classify import domains as dom, levels as lev
    cat = _catalogue(profile)
    _, desc = read_site(site)
    dv = dom.classify([(r[0], r[1], (desc.get(r[0]) or {}).get('x') or '', r4 or r[2]) for r, r4 in zip(rows, [x[4] if len(x) > 4 else '' for x in index])],
                      profile.get('domains') or [], cat)
    lx = lev.compile_levels(profile['levels']) if profile.get('levels') else None
    for r in rows:
        d1, d2 = dv.get(r[0], ['', ''])
        out[r[0]] = list(out[r[0]][:3]) + [d1, d2, lev.level_of(r[1], lx) if lx else '']
    doc = {'version': 2, 'functions_version': tax.get('version', 1), 'fields': ['function', 'function2', 'confidence', 'domain', 'domain2', 'level'], 'ids': out}
    with open(os.path.join(vectors, ASSIGN_FILE), 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(',', ':'))
    c = collections.Counter(v[0].split('.')[0] for v in out.values())
    log(f'  {len(out)} roles: ' + ', '.join(f'{f} {n}' for f, n in c.most_common()) + f'; {sum(1 for v in out.values() if v[1])} hybrids')
    if profile.get('domains'):
        c = collections.Counter(v[3] for v in out.values())
        log('  domains: ' + ', '.join(f'{d} {n}' for d, n in c.most_common()))
    return doc


def _catalogue(profile):
    """{company slug or name: catalogue entry} from the profile's companies_catalogue, or {}."""
    rel = profile.get('companies_catalogue')
    path = os.path.join(profile['_dir'], rel) if rel else ''
    if not path or not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as fh:
        d = json.load(fh)
    out = {}
    for c in d.get('companies', d) if isinstance(d, dict) else d:
        if isinstance(c, dict):
            for k in [c.get('slug'), c.get('name')] + list(c.get('aliases') or []):
                if k:
                    out[k] = c
    return out
