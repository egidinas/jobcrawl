"""Atlas layout: a network map of the board's roles and companies, in the way maps of science are drawn.

    jobcrawl map --profile P --site SITE [--vectors DIR] [--labels-only]     (needs the map extra: umap-learn, leidenalg, igraph, scipy)

Port of the reference implementation's build_atlas.py. Algorithms and constants are the reference's; the values that belong to a field come from the
profile's map block (k, layout_k, min_dist, even, reps, signature, min_scope, resolution, labels_file) and the profile's scopes.

1. Language: the model places postings partly by their language (a German posting sits near other German postings whatever the
   work). The directions German, French and Spanish minus English are removed from the vectors before anything else (jobcrawl/text/langfix).
2. Employers: a quarter of a role's nearest roles come from the same employer (0.4 % by chance): shared wording of one employer's
   postings. For the map, the signature share (map.signature, 0.8) of each employer's average direction is removed (employers with 3+ roles).
3. Graph: every role is linked to its k nearest roles by meaning (cosine of the 256-number vectors).
4. Groups: Leiden community detection on that graph, at two resolutions (regions and neighbourhoods; about n^0.35 regions).
5. Placement: UMAP, relaxed onto the plane, so groups that share many links sit next to each other.
6. Names: each group is named by its most distinctive title words (class-based TF-IDF), its leading board fields, and the statements it
   leans to (match-prefs.json), unless the labels file names it.
7. Links: for the finer groups, the share of neighbour links that cross from one group to another.
Big employers are represented by at most map.reps roles per company and group; the others sit next to their representative.
Scopes with at least map.min_scope roles get a map of their own; the worldwide map always covers every role.
Companies (from the companies_catalogue, embedded by jobcrawl embed) get their own map from the centre of their roles.

Output: VECTORS/atlas-layout.json (publish copies it into SITE/match/).
"""
import ast
import collections
import json
import math
import os
import re

import numpy as np

from jobcrawl.site import read_site
from jobcrawl.map.labels import apply_labels, load_labels
from jobcrawl.text import langfix

STOP = set('''engineer engineering manager senior junior specialist gmbh all gender genders und für the and for with lead head expert technician
intern working student praktikum werkstudent mitarbeiter unit team der die das von bei m/f/d w/m/d f/m/d m/w/d f/m/x m/f/x m/w/x mwd mfd
you your our will are this that have from experience work role position job ihre wir sie mit eine einen ein auf als oder zur zum bzw
strong ability skills knowledge degree years related required preferred including within across about other more new can based
etc using such well must also both able good very their them they who what which where when how all any each into over under
und oder sowie nach durch wie sind wird werden haben hast bist dein deine unsere unser unseren ihr ihre ihren kenntnisse erfahrung
aufgaben profil bieten'''.split())
WORD = re.compile(r"[a-zäöüß][a-zäöüß0-9+#-]{2,}")

LAYOUT_NEIGHBOURS_COMPANIES = 20    # UMAP neighbours for the company map (the roles use map.layout_k)
COMPANY_KNN = 12                    # neighbours in the company grouping graph
COMPANY_RESOLUTION = 1.5
COMPANY_MIN_GROUP = 5
EMPLOYER_RESOLUTION = 4.0           # the coarse neighbourhoods that pick the representatives
EMPLOYER_MIN_GROUP = 12
REGION_EXPONENT = 0.35              # regions ~ n^0.35 (23 for 8,000 representatives, 11 for 900), neighbourhoods three times as many


class MapError(ValueError):
    pass


def load(site, vectors):
    """(board rows that have a vector, their normalised vectors, description entries)."""
    with open(os.path.join(vectors, 'match-vec.json'), encoding='utf-8') as fh:
        vj = json.load(fh)
    dim = vj['dim']
    with open(os.path.join(vectors, 'match-vec.bin'), 'rb') as fh:
        V = np.frombuffer(fh.read(), np.int8).reshape(-1, dim).astype(np.float32)
    V /= np.maximum(np.linalg.norm(V, axis=1, keepdims=True), 1e-9)
    index, desc = read_site(site)
    row = {rid: k for k, rid in enumerate(vj['ids'])}
    keep = [r for r in index if r[0] in row]
    X = V[[row[r[0]] for r in keep]]
    return keep, X, desc, vj


def knn(X, k):
    idx = np.zeros((len(X), k), np.int32); sim = np.zeros((len(X), k), np.float32)
    for a in range(0, len(X), 1024):
        S = X[a:a + 1024] @ X.T
        for j in range(S.shape[0]):
            S[j, a + j] = -9
        part = np.argpartition(-S, k, axis=1)[:, :k]
        ps = np.take_along_axis(S, part, 1); o = np.argsort(-ps, 1)
        idx[a:a + 1024] = np.take_along_axis(part, o, 1); sim[a:a + 1024] = np.take_along_axis(ps, o, 1)
    return idx, sim


def leiden(idx, sim, resolution, seed=1):
    import igraph as ig
    import leidenalg
    n = len(idx); edges = {}
    for a in range(n):
        for b, s in zip(idx[a], sim[a]):
            key = (min(a, int(b)), max(a, int(b))); edges[key] = max(edges.get(key, 0), float(max(s, 0.01)))
    g = ig.Graph(n=n, edges=list(edges.keys())); g.es['weight'] = list(edges.values())
    part = leidenalg.find_partition(g, leidenalg.RBConfigurationVertexPartition, weights='weight', resolution_parameter=resolution, seed=seed)
    return np.array(part.membership)


def relabel_small(memb, idx, min_size):
    """Groups smaller than min_size join the group most of their members' neighbours belong to."""
    for _ in range(3):
        cnt = collections.Counter(memb.tolist())
        small = {c for c, n in cnt.items() if n < min_size}
        if not small:
            break
        for a in np.where(np.isin(memb, list(small)))[0]:
            votes = collections.Counter(int(memb[b]) for b in idx[a] if memb[b] not in small)
            if votes:
                memb[a] = votes.most_common(1)[0][0]
    _, memb = np.unique(memb, return_inverse=True)
    return memb


def describe(memb, titles, fields_of, X, prefs, n_words=3):
    """Per group: distinctive title words (share in the group against share on the whole board, at least twice as common),
    leading board fields, and the statements the group leans to."""
    groups = sorted(set(memb.tolist())); n = len(memb)
    words_of = [set(w for w in WORD.findall(t) if w not in STOP and not w.isdigit()) for t in titles]
    total = collections.Counter(w for ws in words_of for w in ws)
    P = np.array([p['v'] for p in prefs], np.float32) if prefs else None
    z_all = ((X @ P.T) - np.array([p['mu'] for p in prefs])) / np.array([p['sd'] for p in prefs]) if prefs else None
    fl_all = collections.Counter(f for fs in fields_of for f in set(fs))
    out = []
    for g in groups:
        members = np.where(memb == g)[0]; size = len(members)
        c = collections.Counter(w for i in members for w in words_of[i])
        score = {}
        for w, k in c.items():
            share, lift = k / size, (k / size) / (total[w] / n)
            if k >= max(3, size * 0.04) and lift >= 2:
                score[w] = share * math.log(lift)
        words = [w for w, _ in sorted(score.items(), key=lambda x: -x[1])[:n_words]]
        fc = collections.Counter(f for i in members for f in set(fields_of[i]))
        fields = [f for f, k in sorted(fc.items(), key=lambda x: -(x[1] / size - fl_all[x[0]] / n)) if k / size - fl_all[f] / n > 0.1][:2]
        lean = []
        if prefs:
            z = z_all[members].mean(0)
            for p, v in zip(prefs, z):
                if abs(v) >= 0.6:
                    lean.append([p['id'], 1 if v > 0 else -1, round(float(v), 2)])
        out.append({'n': int(size), 'words': words, 'fields': fields, 'lean': lean})
    return out


def links(memb, idx, k, top=3):
    cnt = collections.Counter(); size = collections.Counter(memb.tolist())
    for a in range(len(idx)):
        for b in idx[a]:
            if memb[a] != memb[b]:
                cnt[tuple(sorted((int(memb[a]), int(memb[b]))))] += 1
    best = collections.defaultdict(list)
    for (a, b), c in cnt.items():
        w = c / math.sqrt(size[a] * size[b]) / k
        best[a].append((w, b)); best[b].append((w, a))
    keep = set()
    for a, l in best.items():
        for w, b in sorted(l, reverse=True)[:top]:
            keep.add((min(a, b), max(a, b), round(w, 4)))
    return sorted(keep)


def representatives(companies, groups, X, reps):
    """Per (company, group): the medoid first, then farthest-point picks, up to reps. Returns rep_of[i] = index of i's representative."""
    rep_of = np.arange(len(X)); cells = collections.defaultdict(list)
    for i, (c, g) in enumerate(zip(companies, groups)):
        cells[(c, int(g))].append(i)
    for members in cells.values():
        if len(members) <= reps:
            continue
        M = X[members]; cen = M.mean(0); picks = [int(np.argmax(M @ cen))]
        while len(picks) < reps:
            sims = (M @ M[picks].T).max(1); sims[picks] = 9; picks.append(int(np.argmin(sims)))
        P = M[picks]
        for k, i in enumerate(members):
            if k not in picks:
                rep_of[i] = members[picks[int(np.argmax(P @ M[k]))]]
    return rep_of


def remove_employer(X, keys, signature):
    by = collections.defaultdict(list)
    for i, k in enumerate(keys):
        by[k].append(i)
    g = X.mean(0); Y = X.copy()
    for l in by.values():
        if len(l) >= 3:
            Y[l] -= signature * (X[l].mean(0) - g)
    return Y / np.maximum(np.linalg.norm(Y, axis=1, keepdims=True), 1e-9)


def relax(Y, dmin, even, iters=60):
    """Even out the plane: a radial redistribution (each point keeps its direction from the centre; its distance moves `even` (0.7) of
    the way to the place that gives every ring the same density, so no dense core and no escaped points), then a short-range push
    between points closer than dmin. Measured on 4,000 roles against plain UMAP: the arrangement of groups follows their true distances
    better (rank correlation 0.52 -> 0.59), at some cost to the closest neighbours (25 % -> 18 % kept)."""
    from scipy.spatial import cKDTree
    Y = Y.astype(np.float64).copy(); c = np.median(Y, 0); d = np.linalg.norm(Y - c, axis=1)
    F = (np.argsort(np.argsort(d)) + 0.5) / len(d); rmax = np.percentile(d, 99.5)
    r = (1 - even) * np.minimum(d / rmax, 1.02) + even * np.sqrt(F)
    Y = c + (Y - c) / np.maximum(d, 1e-9)[:, None] * r[:, None]
    Y = (Y - Y.min(0)) / np.maximum(Y.max(0) - Y.min(0), 1e-9)
    for it in range(iters):
        pairs = cKDTree(Y).query_pairs(dmin, output_type='ndarray')
        if not len(pairs):
            break
        a, b = pairs[:, 0], pairs[:, 1]; diff = Y[a] - Y[b]; dist = np.linalg.norm(diff, axis=1)
        zero = dist < 1e-9; diff[zero] = np.random.default_rng(it).normal(size=(zero.sum(), 2)) * 1e-4; dist[zero] = np.linalg.norm(diff[zero], axis=1)
        push = (diff / dist[:, None]) * ((dmin - dist) / 4)[:, None]
        np.add.at(Y, a, push); np.add.at(Y, b, -push)
    lo, hi = Y.min(0), Y.max(0)
    return 0.03 + 0.94 * (Y - lo) / np.maximum(hi - lo, 1e-9)


def layout(X, n_neighbors, min_dist, even, seed=1):
    """UMAP with n_neighbors (map.layout_k for roles: more than the grouping graph, the global arrangement improves), then relax()."""
    import umap
    Y = umap.UMAP(n_neighbors=min(n_neighbors, len(X) - 1), min_dist=min_dist, metric='cosine', random_state=seed, init='spectral').fit_transform(X)
    return relax(Y, dmin=0.6 / math.sqrt(len(Y)), even=even)


def centres(Y, memb):
    return [[round(float(x), 4) for x in np.median(Y[memb == g], 0)] for g in sorted(set(memb.tolist()))]


def leiden_target(idx, sim, target, min_size):
    lo, hi, best = 0.05, 20.0, None
    for _ in range(14):
        mid = math.sqrt(lo * hi); m = relabel_small(leiden(idx, sim, mid), idx, min_size); n = m.max() + 1
        if best is None or abs(n - target) < abs(best.max() + 1 - target):
            best = m
        if n == target:
            break
        lo, hi = (mid, hi) if n < target else (lo, mid)
    return best


def role_map(keep, X, employer, titles, fields_of, prefs, cfg, log=print):
    k = cfg['k']
    idx0, sim0 = knn(X, k)
    rep_of = representatives(employer, relabel_small(leiden(idx0, sim0, EMPLOYER_RESOLUTION), idx0, EMPLOYER_MIN_GROUP), X, cfg['reps'])      # neighbourhoods of all roles, only to pick representatives
    reps = np.where(rep_of == np.arange(len(keep)))[0]; pos_in = {int(i): j for j, i in enumerate(reps)}
    XR = X[reps]; idx, sim = knn(XR, k)
    # group counts shrink slowly with the map: about n^0.35 regions and three times as many neighbourhoods; the Leiden resolution is searched to hit them
    nreg = round(len(reps) ** REGION_EXPONENT)
    coarse_r = leiden_target(idx, sim, nreg, max(8, len(reps) // 300))
    fine_r = leiden_target(idx, sim, 3 * nreg, max(5, len(reps) // 1000))
    log(f'  {len(reps)} representatives, {coarse_r.max() + 1} regions, {fine_r.max() + 1} neighbourhoods')
    YR = layout(XR, cfg['layout_k'], cfg['min_dist'], cfg['even'])
    tr = [titles[i] for i in reps]; fr = [fields_of[i] for i in reps]
    rng = np.random.default_rng(3); jit = 0.25 / math.sqrt(len(reps))
    ri = np.array([pos_in[int(rep_of[i])] for i in range(len(keep))])
    Y = YR[ri] + np.where((rep_of == np.arange(len(keep)))[:, None], 0, rng.normal(scale=jit, size=(len(keep), 2)))
    return {'ids': [r[0] for r in keep], 'x': [round(float(v), 4) for v in Y[:, 0]], 'y': [round(float(v), 4) for v in Y[:, 1]],
            'c1': coarse_r[ri].tolist(), 'c2': fine_r[ri].tolist(), 'rep': [int(pos_in[int(rep_of[i])]) if rep_of[i] != i else -1 for i in range(len(keep))],
            'regions': [dict(d, xy=c) for d, c in zip(describe(coarse_r, tr, fr, XR, prefs, 3), centres(YR, coarse_r))],
            'hoods': [dict(d, xy=c) for d, c in zip(describe(fine_r, tr, fr, XR, prefs, 3), centres(YR, fine_r))],
            'links': links(fine_r, idx, k)}


def company_map(slugs, P, X0, keep, by, cat, titles, fields_of, prefs, cfg, log=print):
    """The companies' own map: each company's catalogue vector, moved towards the centre of its open roles where it has any."""
    C = P.copy(); nroles = []
    for kk, slug in enumerate(slugs):
        l = by.get(slug, []); nroles.append(len(l))
        if l:
            rc = X0[l].mean(0); rc /= np.linalg.norm(rc); C[kk] = P[kk] + min(1.5, len(l) / 3) * rc      # more roles, more say: up to 1.5 times the profile
    C /= np.linalg.norm(C, axis=1, keepdims=True)
    cidx, csim = knn(C, COMPANY_KNN)
    cm = relabel_small(leiden(cidx, csim, COMPANY_RESOLUTION), cidx, COMPANY_MIN_GROUP)
    ctexts = [' '.join([(cat.get(s_) or {}).get('field') or '', (cat.get(s_) or {}).get('arch_name') or ''] + [titles[i] for i in by.get(s_, [])[:40]]).lower()
              for s_ in slugs]
    cfields = [[f for i in by.get(s_, []) for f in fields_of[i]] for s_ in slugs]
    CY = layout(C, LAYOUT_NEIGHBOURS_COMPANIES, cfg['min_dist'], cfg['even'])

    def about(c):
        pr = c.get('profile')
        if isinstance(pr, str):
            try:
                pr = ast.literal_eval(pr)
            except (ValueError, SyntaxError):
                pr = {'en': pr}
        t = (pr or {}).get('en', '') if isinstance(pr, dict) else ''
        return t[:240].rsplit(' ', 1)[0] + '…' if len(t) > 240 else t
    return {'names': [(cat.get(s_) or {}).get('name', s_) for s_ in slugs], 'about': [about(cat.get(s_) or {}) for s_ in slugs],
            'field': [(cat.get(s_) or {}).get('field') or '' for s_ in slugs], 'slugs': slugs,
            'x': [round(float(v), 4) for v in CY[:, 0]], 'y': [round(float(v), 4) for v in CY[:, 1]], 'c1': cm.tolist(), 'roles': nroles,
            'regions': [dict(d, xy=c) for d, c in zip(describe(cm, ctexts, cfields, C, prefs, 3), centres(CY, cm))]}


EMPTY_COMPANIES = {'names': [], 'about': [], 'field': [], 'slugs': [], 'x': [], 'y': [], 'c1': [], 'roles': [], 'regions': []}


def build(site, vectors, profile, log=print):
    """Builds the layout and writes VECTORS/atlas-layout.json. Returns the file's path."""
    from jobcrawl.embed.companies import catalogue_path, load_catalogue
    m = profile['map']
    cfg = {'k': m['k'], 'layout_k': m['layout_k'], 'min_dist': m['min_dist'], 'even': m['even'], 'reps': m['reps'], 'signature': m['signature']}
    keep, X, desc, vj = load(site, vectors)
    if len(keep) <= cfg['k'] + 1:
        raise MapError(f'{len(keep)} roles with vectors: a map needs more than {cfg["k"] + 1}')
    prefs_file = os.path.join(site, 'match', 'match-prefs.json')
    prefs = []
    if os.path.exists(prefs_file):
        with open(prefs_file, encoding='utf-8') as fh:
            prefs = json.load(fh)['prefs']
    if not vj.get('lang_dirs'):        # the stored vectors already have the directions removed (jobcrawl embed); otherwise remove them here
        langs = np.array([langfix.language(r[1] + ' ' + ((desc.get(r[0]) or {}).get('x') or '')[:2000]) for r in keep])
        X = langfix.project(X, langfix.directions(X, langs))
    X0 = X.copy()                                                   # language-neutral, employer signature still in (for company centres)
    employer = [r[4] or r[2] for r in keep]                        # the company page slug, or the name for employers without a page
    X = remove_employer(X, employer, cfg['signature'])
    titles = [r[1].lower() for r in keep]
    fields_of = [(desc.get(r[0]) or {}).get('tg') or [] for r in keep]
    scope_of = [set((desc.get(r[0]) or {}).get('sc') or []) for r in keep]
    any_scopes = {s['id'] for s in profile['scopes'] if (s.get('match') or {}).get('any')}
    roles = role_map(keep, X, employer, titles, fields_of, prefs, cfg, log)
    log(f'worldwide: {len(keep)} roles, {len(roles["regions"])} regions')
    maps = {}
    for s in reversed(profile['scopes']):                           # widest first, as the reference's SCOPES list
        sid = s['id']
        if sid in any_scopes:
            continue                                                 # the worldwide map is the one above
        sel = [i for i in range(len(keep)) if sid in scope_of[i]]
        if len(sel) < m['min_scope']:
            log(f'  {sid}: {len(sel)} roles, too few for a map of its own'); continue
        log(f'{sid}: {len(sel)} roles')
        maps[sid] = role_map([keep[i] for i in sel], X[sel], [employer[i] for i in sel], [titles[i] for i in sel], [fields_of[i] for i in sel], prefs, cfg, log)
    # companies: every catalogue company, from its own vector (companies.py), combined with the centre of its open roles where it has any
    companies = dict(EMPTY_COMPANIES)
    cpath = os.path.join(vectors, 'company-vec.json')
    if os.path.exists(cpath):
        with open(cpath, encoding='utf-8') as fh:
            cj = json.load(fh)
        with open(os.path.join(vectors, 'company-vec.bin'), 'rb') as fh:
            P = np.frombuffer(fh.read(), np.int8).reshape(-1, cj['dim']).astype(np.float32)
        P /= np.linalg.norm(P, axis=1, keepdims=True)
        cat_path = catalogue_path(profile)
        cat = {c['slug']: c for c in load_catalogue(cat_path)} if cat_path and os.path.exists(cat_path) else {}
        by = collections.defaultdict(list)
        for i, r in enumerate(keep):
            if r[4]:
                by[r[4]].append(i)
        slugs = cj['slugs']
        if len(slugs) > COMPANY_KNN + 1:
            companies = company_map(slugs, P, X0, keep, by, cat, titles, fields_of, prefs, cfg, log)
        else:
            log(f'  {len(slugs)} companies: too few for a companies map')
    out = {'version': 2, 'k': cfg['k'], 'layout_k': cfg['layout_k'], 'scopes': maps, 'resolution': m['resolution'], 'language_removed': ['de', 'fr', 'es'],
           'reps_per_company_and_group': cfg['reps'], 'roles': roles, 'companies': companies}
    named = apply_labels(out, load_labels(profile, log))
    log(f'  {named} groups named from the labels file')
    path = os.path.join(vectors, 'atlas-layout.json')
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    log(f'  wrote {path} ({os.path.getsize(path) / 1e6:.2f} MB)')
    return path


def labels_only(vectors, profile, log=print):
    """Applies the profile's labels to the layout already built, without rebuilding it."""
    path = os.path.join(vectors, 'atlas-layout.json')
    if not os.path.exists(path):
        raise MapError(f'no atlas-layout.json in {vectors}: run jobcrawl map without --labels-only first')
    with open(path, encoding='utf-8') as fh:
        out = json.load(fh)
    n = apply_labels(out, load_labels(profile, log))
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    log(f'{n} groups named')
    return n
