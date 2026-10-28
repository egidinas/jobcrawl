"""Atlas layout: a network map of the board's roles and companies, in the way maps of science are drawn.

    jobcrawl map --profile P --site SITE [--vectors DIR] [--labels-only | --companies-only]     (needs the map extra: umap-learn, leidenalg, igraph, scipy)

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
Companies (from the companies_catalogue, embedded by jobcrawl embed) get their own map from the centre of their roles. When
VECTORS/company-graph.json exists and covers the same companies (the madenetwork company graph), its groups are the company regions
(no new Leiden run), named by the labels file's companies section (matched by group id), and the links are the edge counts between
groups. Their positions are graph_layout(): a UMAP on the company vectors with the graph's own neighbours (company-nb.bin) and the
groups as a semi-supervised target.

Output: VECTORS/atlas-layout.json (publish copies it into SITE/match/). --companies-only rebuilds just the companies section of that
file and keeps its roles and scopes sections as they are.
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
COMPANY_KNN = 8                     # neighbours in the company grouping graph (optimized for modularity & separation)
COMPANY_RESOLUTION = 1.8            # optimized resolution parameter separating EO and Consulting
COMPANY_MIN_GROUP = 5
COMPANY_GRAPH_WEIGHT = 0.3          # the company graph's groups pull the positions (UMAP target_weight); 0.3 keeps the most graph neighbours among the
                                    # settings with 0.75+ coherence (sweep on madenetwork: 0.975 mean coherence, 0.39 of the 8 graph neighbours in the 15 nearest)
EMPLOYER_RESOLUTION = 4.0           # the coarse neighbourhoods that pick the representatives
EMPLOYER_MIN_GROUP = 12
REGION_EXPONENT = 0.35              # regions ~ n^0.35 (23 for 8,000 representatives, 11 for 900), neighbourhoods three times as many


class MapError(ValueError):
    pass


def retired_rows(traces, vj, on_board):
    """Index rows [id, title, company, url, slug] and desc entries ({sc, tg, off}) for the roles that have a vector but are no longer on the
    board, from role-traces.json (jobcrawl traces). Their bit sets are decoded over the traces' own lists. Empty without the traces."""
    path = os.path.join(traces or '', 'role-traces.json')
    if not traces or not os.path.exists(path):
        return [], {}
    with open(path, encoding='utf-8') as fh:
        t = json.load(fh)
    scopes, fields = t['conv']['scopes'], t['conv']['fields']
    have = set(vj['ids']); rows, extra = [], {}
    for k, rid in enumerate(t['ids']):
        if rid in have and rid not in on_board:
            rows.append([rid, t['t'][k], t['c'][k], t['u'][k], t['cs'][k]])
            extra[rid] = {'sc': [n for b, n in enumerate(scopes) if t['sc'][k] >> b & 1], 'tg': [n for b, n in enumerate(fields) if t['tg'][k] >> b & 1], 'off': True}
    return rows, extra


def load(site, vectors, use_jobonly=True, traces=None):
    """(board rows that have a vector, their normalised vectors, description entries). With traces (a jobcrawl traces folder), the roles that
    left the board follow the board's, marked {'off': True} in the entries: they stay in the map as context, shaping it, and are not selectable."""
    jobonly_json = os.path.join(vectors, 'match-vec-jobonly.json')
    jobonly_bin = os.path.join(vectors, 'match-vec-jobonly.bin')
    if use_jobonly and os.path.exists(jobonly_json) and os.path.exists(jobonly_bin):
        json_file, bin_file = jobonly_json, jobonly_bin
    else:
        json_file = os.path.join(vectors, 'match-vec.json')
        bin_file = os.path.join(vectors, 'match-vec.bin')

    with open(json_file, encoding='utf-8') as fh:
        vj = json.load(fh)
    dim = vj['dim']
    with open(bin_file, 'rb') as fh:
        V = np.frombuffer(fh.read(), np.int8).reshape(-1, dim).astype(np.float32)
    V /= np.maximum(np.linalg.norm(V, axis=1, keepdims=True), 1e-9)
    index, desc = read_site(site)
    row = {rid: k for k, rid in enumerate(vj['ids'])}
    keep = [r for r in index if r[0] in row]
    old, extra = retired_rows(traces, vj, {r[0] for r in index})
    old = [r for r in old if np.abs(V[row[r[0]]]).sum() > 0]               # a zero row is a role that never had a vector
    desc = dict(desc, **{r[0]: extra[r[0]] for r in old})
    keep = keep + old
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


FOREIGN_TITLE = re.compile(r'\(\s*(?:m/w/d|w/m/d|d/w/m|m/w/x|h/f|f/h)|[äöüß]|\b(?:für|und|der|die|das|mit|zur|zum|bei|von|als|oder|pour|et|les|des|une|para|los|las|con|del)\b')


def describe(memb, titles, fields_of, X, prefs, n_words=3, allowed=None):
    """Per group: distinctive title words (share in the group against share on the whole board, at least twice as common),
    leading board fields, and the statements the group leans to."""
    groups = sorted(set(memb.tolist())); n = len(memb)
    words_of = [set(w for w in WORD.findall(t) if w not in STOP and not w.isdigit() and (allowed is None or w in allowed)) for t in titles]
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
    return top_links(cnt, size, k, top)


def group_links(memb, pairs, k, top=3):
    """Links from an edge list (pairs of member indices) instead of neighbour lists: the same weights as links()."""
    cnt = collections.Counter(); size = collections.Counter(memb.tolist())
    for a, b in pairs:
        if memb[a] != memb[b]:
            cnt[tuple(sorted((int(memb[a]), int(memb[b]))))] += 1
    return top_links(cnt, size, k, top)


def top_links(cnt, size, k, top):
    """Per group, its `top` strongest links; a link's weight is its count over the groups' sizes and k."""
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


def layout(X, n_neighbors, min_dist, even, seed=1, init=None):
    """UMAP with n_neighbors (map.layout_k for roles: more than the grouping graph, the global arrangement improves), then relax()."""
    import umap
    Y = umap.UMAP(n_neighbors=min(n_neighbors, len(X) - 1), min_dist=min_dist, metric='cosine', random_state=seed, init='spectral' if init is None else init).fit_transform(X)
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


def previous_layout(vectors):
    """The layout already built in vectors (parsed atlas-layout.json), or None."""
    try:
        with open(os.path.join(vectors, 'atlas-layout.json'), encoding='utf-8') as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def previous_positions(layout):
    """{role id: (x, y)} of a previous layout, or {} (the next layout starts from these so a rebuild reshapes the map slightly
    instead of rotating or mirroring it)."""
    try:
        r = layout['roles']
        return {i: (x, y) for i, x, y in zip(r['ids'], r['x'], r['y'])}
    except (TypeError, KeyError):
        return {}


def start_from(prev, ids, X, k=8):
    """UMAP start positions for the rows (ids, X): the previous place of a role that had one, else the mean of its k most similar placed roles. None when
    fewer than half the roles had a place before (then the usual spectral start is better)."""
    have = np.array([i in prev for i in ids])
    if have.sum() < len(ids) / 2:
        return None
    Y = np.zeros((len(ids), 2), np.float32)
    Y[have] = [prev[i] for i, h in zip(ids, have) if h]
    P = X[have]
    for a in np.where(~have)[0]:
        s = P @ X[a]; top = np.argpartition(-s, min(k, len(s) - 1))[:k]
        Y[a] = Y[have][top].mean(0)
    return Y


def role_map(keep, X, employer, titles, fields_of, prefs, cfg, log=print, base_coords=None, prev=None):
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
    if base_coords is not None:
        # Reprojecting local excerpt with the exact same relative positions from the global network
        YR = np.array(base_coords[reps], dtype=np.float64)
        lo, hi = YR.min(0), YR.max(0)
        YR = 0.03 + 0.94 * (YR - lo) / np.maximum(hi - lo, 1e-9)
        YR = relax(YR, dmin=0.6 / math.sqrt(len(YR)), even=cfg['even'])
    else:
        init = start_from(prev, [keep[i][0] for i in reps], XR) if prev else None
        YR = layout(XR, cfg['layout_k'], cfg['min_dist'], cfg['even'], init=init)
    tr = [titles[i] for i in reps]; fr = [fields_of[i] for i in reps]
    rng = np.random.default_rng(3); jit = 0.25 / math.sqrt(len(reps))
    ri = np.array([pos_in[int(rep_of[i])] for i in range(len(keep))])
    Y = YR[ri] + np.where((rep_of == np.arange(len(keep)))[:, None], 0, rng.normal(scale=jit, size=(len(keep), 2)))
    return {'ids': [r[0] for r in keep], 'x': [round(float(v), 4) for v in Y[:, 0]], 'y': [round(float(v), 4) for v in Y[:, 1]],
            'c1': coarse_r[ri].tolist(), 'c2': fine_r[ri].tolist(), 'rep': [int(pos_in[int(rep_of[i])]) if rep_of[i] != i else -1 for i in range(len(keep))],
            'regions': [dict(d, xy=c) for d, c in zip(describe(coarse_r, tr, fr, XR, prefs, 3, cfg.get('en_vocab')), centres(YR, coarse_r))],
            'hoods': [dict(d, xy=c) for d, c in zip(describe(fine_r, tr, fr, XR, prefs, 3, cfg.get('en_vocab')), centres(YR, fine_r))],
            'links': links(fine_r, idx, k)}


def role_map_excerpt(sel, global_roles, cfg):
    """Local excerpt: reshapes coordinates slightly via relax() to fit the viewport, but does NOT recluster into new relationships."""
    ids = [global_roles['ids'][i] for i in sel]
    c1 = [global_roles['c1'][i] for i in sel]
    c2 = [global_roles['c2'][i] for i in sel]

    # Reshape coordinates slightly to relax the local network without re-clustering
    Y_glob = np.column_stack([[global_roles['x'][i] for i in sel], [global_roles['y'][i] for i in sel]])
    lo, hi = Y_glob.min(0), Y_glob.max(0)
    Y_norm = 0.03 + 0.94 * (Y_glob - lo) / np.maximum(hi - lo, 1e-9)
    Y_relaxed = relax(Y_norm, dmin=0.6 / math.sqrt(len(Y_norm)), even=cfg['even'])

    # Map global representative indices to local subset
    sel_set = set(sel)
    global_to_local = {g_idx: l_idx for l_idx, g_idx in enumerate(sel)}
    rep_local = []
    for i in sel:
        g_rep = global_roles['rep'][i]
        if g_rep in sel_set:
            rep_local.append(global_to_local[g_rep])
        else:
            rep_local.append(-1)

    # Maintain existing global cluster relationships: update centroids to local median coordinates
    c1_arr = np.array(c1)
    c2_arr = np.array(c2)

    active_regions = []
    for g_id, r in enumerate(global_roles['regions']):
        mask = (c1_arr == g_id)
        if np.any(mask):
            r_copy = dict(r)
            r_copy['xy'] = [round(float(v), 4) for v in np.median(Y_relaxed[mask], axis=0)]
            active_regions.append(r_copy)

    active_hoods = []
    for h_id, h in enumerate(global_roles['hoods']):
        mask = (c2_arr == h_id)
        if np.any(mask):
            h_copy = dict(h)
            h_copy['xy'] = [round(float(v), 4) for v in np.median(Y_relaxed[mask], axis=0)]
            active_hoods.append(h_copy)

    active_hood_ids = set(c2)
    active_links = [
        link for link in global_roles.get('links', [])
        if link[0] in active_hood_ids and link[1] in active_hood_ids
    ]

    return {
        'ids': ids,
        'x': [round(float(v), 4) for v in Y_relaxed[:, 0]],
        'y': [round(float(v), 4) for v in Y_relaxed[:, 1]],
        'c1': c1,
        'c2': c2,
        'rep': rep_local,
        'regions': active_regions,
        'hoods': active_hoods,
        'links': active_links
    }


def company_graph(vectors, slugs, log=print):
    """The companies' groups and edges from VECTORS/company-graph.json (madenetwork's tools/embed/build_company_network.py), or None.

    Used only when its nodes are the same companies as the company vectors (same slugs, no duplicates); otherwise logged and None.
    Returns {'memb': group index per slug (0..G-1, in the order of the graph's group ids), 'orig': the graph's group id per index,
    'pairs': edges as (slug index, slug index), 'groups': the graph's group records by id, 'group_of': the graph's group id per slug}."""
    path = os.path.join(vectors, 'company-graph.json')
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as fh:
        g = json.load(fh)
    nodes = g.get('nodes') or []
    if len(set(slugs)) != len(slugs) or sorted(n['slug'] for n in nodes) != sorted(slugs):
        log(f'  company-graph.json covers {len(nodes)} companies, not the {len(slugs)} company vectors: the companies keep their own groups')
        return None
    pos = {s_: i for i, s_ in enumerate(slugs)}
    slug_of = {int(n['idx']): n['slug'] for n in nodes}
    group_of = {n['slug']: int(n['group_id']) for n in nodes}
    orig = sorted(set(group_of.values())); new = {o: j for j, o in enumerate(orig)}
    memb = np.array([new[group_of[s_]] for s_ in slugs], np.int64)
    pairs = []
    for e in g.get('edges') or []:
        a, b = pos[slug_of[int(e['source'])]], pos[slug_of[int(e['target'])]]
        if a != b:
            pairs.append((a, b))
    nb = None
    nb_path = os.path.join(vectors, 'company-nb.bin')
    if os.path.exists(nb_path) and os.path.getsize(nb_path) == len(slugs) * COMPANY_KNN * 2:      # the graph's own neighbour lists, in slug order
        with open(nb_path, 'rb') as fh:
            nb = np.frombuffer(fh.read(), np.uint16).reshape(len(slugs), COMPANY_KNN).astype(np.int64)
    return {'memb': memb, 'orig': orig, 'pairs': pairs, 'groups': {int(x['id']): x for x in g.get('groups') or []}, 'group_of': group_of, 'nb': nb}


def company_group_names(graph, lab):
    """[en, de] per group (in the order of graph['orig']): the labels file's companies entry for the group, else the graph's own names.
    An entry belongs to a group by its "id" if it has one, else by its "en" name, else by the group most of its sample holds."""
    entries = {}
    for entry in (lab or {}).get('companies') or []:
        gid = entry.get('id')
        if gid is None:
            gid = next((x['id'] for x in graph['groups'].values() if x.get('en') == entry.get('en')), None)
        if gid is None:
            votes = collections.Counter(graph['group_of'][sl] for sl in entry.get('sample') or [] if sl in graph['group_of'])
            gid = votes.most_common(1)[0][0] if votes else None
        if gid is not None:
            entries.setdefault(int(gid), entry)
    names = []
    for gid in graph['orig']:
        e = entries.get(gid) or graph['groups'].get(gid) or {}
        names.append([e.get('en') or f'Group {gid}', e.get('de') or f'Gruppe {gid}'])
    return names


def graph_layout(C, P, groups, graph, cfg, seed=1):
    """The company positions when the company graph is used: UMAP on the company vectors, with the graph's own 8 neighbours (company-nb.bin,
    cosine distances on the company vectors) and the graph's groups as a semi-supervised target (COMPANY_GRAPH_WEIGHT), then relax().
    Without company-nb.bin UMAP builds its own 8 neighbours."""
    import umap
    kw = dict(n_neighbors=COMPANY_KNN, min_dist=cfg['min_dist'], metric='cosine', random_state=seed, init='spectral',
              target_metric='categorical', target_weight=COMPANY_GRAPH_WEIGHT)
    if graph.get('nb') is not None:
        nb = graph['nb']
        dist = np.clip(1 - np.sum(P[:, None, :] * P[nb], axis=2), 0, 2).astype(np.float32)
        kw['precomputed_knn'] = (nb.astype(np.int32), dist, None)
    Y = umap.UMAP(**kw).fit_transform(C, y=np.asarray(groups))
    return relax(Y, dmin=0.6 / math.sqrt(len(Y)), even=cfg['even'])


def company_map(slugs, P, X0, keep, by, cat, titles, fields_of, prefs, cfg, log=print, graph=None):
    """The companies' own map: each company's catalogue vector, moved towards the centre of its open roles where it has any.
    With a graph (company_graph) the groups and links come from it, and the positions from graph_layout."""
    C = P.copy(); nroles = []
    for kk, slug in enumerate(slugs):
        l = by.get(slug, []); nroles.append(len(l))
        if l:
            rc = X0[l].mean(0); rc /= np.linalg.norm(rc); C[kk] = P[kk] + min(1.5, len(l) / 3) * rc      # more roles, more say: up to 1.5 times the profile
    C /= np.linalg.norm(C, axis=1, keepdims=True)
    if graph is None:
        cidx, csim = knn(C, COMPANY_KNN)
        cm = relabel_small(leiden(cidx, csim, COMPANY_RESOLUTION), cidx, COMPANY_MIN_GROUP)
        cl = links(cm, cidx, COMPANY_KNN)
    else:
        cm = graph['memb']
        cl = group_links(cm, graph['pairs'], COMPANY_KNN)
    ctexts = [' '.join([(cat.get(s_) or {}).get('field') or '', (cat.get(s_) or {}).get('arch_name') or ''] + [titles[i] for i in by.get(s_, [])[:40]]).lower()
              for s_ in slugs]
    cfields = [[f for i in by.get(s_, []) for f in fields_of[i]] for s_ in slugs]
    if graph is None:
        CY = layout(C, LAYOUT_NEIGHBOURS_COMPANIES, cfg['min_dist'], cfg['even'])
    else:
        CY = graph_layout(C, P, cm, graph, cfg)

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
            'regions': [dict(d, xy=c) for d, c in zip(describe(cm, ctexts, cfields, C, prefs, 3), centres(CY, cm))],
            'links': cl}


EMPTY_COMPANIES = {'names': [], 'about': [], 'field': [], 'slugs': [], 'x': [], 'y': [], 'c1': [], 'roles': [], 'regions': []}


def prepare(site, vectors, profile):
    """The inputs of the layout, read from the site and the vectors: (cfg, keep, X, X0, desc, prefs, employer, titles, fields_of, scope_of).
    X is the role vectors without the employer signature (the worldwide map), X0 the language-neutral ones (the company centres)."""
    m = profile['map']
    cfg = {'k': m['k'], 'layout_k': m['layout_k'], 'min_dist': m['min_dist'], 'even': m['even'], 'reps': m['reps'], 'signature': m['signature']}
    keep, X, desc, vj = load(site, vectors, traces=os.environ.get('JOBCRAWL_TRACES'))
    cfg['n_live'] = sum(1 for r in keep if not (desc.get(r[0]) or {}).get('off'))
    if len(keep) <= cfg['k'] + 1:
        raise MapError(f'{len(keep)} roles with vectors: a map needs more than {cfg["k"] + 1}')
    prefs_file = os.path.join(site, 'match', 'match-prefs.json')
    prefs = []
    if os.path.exists(prefs_file):
        with open(prefs_file, encoding='utf-8') as fh:
            prefs = json.load(fh)['prefs']
    langs = np.array([langfix.language(r[1] + ' ' + ((desc.get(r[0]) or {}).get('x') or '')[:2000]) for r in keep])
    if not vj.get('lang_dirs'):        # the stored vectors already have the directions removed (jobcrawl embed); otherwise remove them here
        X = langfix.project(X, langfix.directions(X, langs))
    # the words that name a group are English: a title word counts when at least three titles that look English use it and it is more than
    # twice as common there as in titles that look German, French or Spanish ("manager" is, "teamleiter" is not). The language detector sees
    # the posting's text, which is often English under a German title, so the title's own markers decide here.
    en_count, other = collections.Counter(), collections.Counter()
    for r in keep:
        t = r[1].lower()
        (other if FOREIGN_TITLE.search(t) else en_count).update(set(WORD.findall(t)))
    cfg['en_vocab'] = {w for w, n in en_count.items() if n >= 3 and n > 2 * other.get(w, 0)}
    X0 = X.copy()                                                   # language-neutral, employer signature still in (for company centres)
    employer = [r[4] or r[2] for r in keep]                        # the company page slug, or the name for employers without a page
    X = remove_employer(X, employer, cfg['signature'])
    titles = [r[1].lower() for r in keep]
    fields_of = [(desc.get(r[0]) or {}).get('tg') or [] for r in keep]
    scope_of = [set((desc.get(r[0]) or {}).get('sc') or []) for r in keep]
    return cfg, keep, X, X0, desc, prefs, employer, titles, fields_of, scope_of


def companies_layout(vectors, profile, keep, X0, titles, fields_of, prefs, cfg, lab, log=print):
    """(companies section, region names or None). The names are None unless company-graph.json groups the companies (then the names
    are the labels file's, by group id, and must be set on the regions after apply_labels)."""
    from jobcrawl.embed.companies import catalogue_path, load_catalogue
    cpath = os.path.join(vectors, 'company-vec.json')
    if not os.path.exists(cpath):
        return dict(EMPTY_COMPANIES), None
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
    if len(slugs) <= COMPANY_KNN + 1:
        log(f'  {len(slugs)} companies: too few for a companies map')
        return dict(EMPTY_COMPANIES), None
    graph = company_graph(vectors, slugs, log)
    if graph is None:
        return company_map(slugs, P, X0, keep, by, cat, titles, fields_of, prefs, cfg, log), None
    names = company_group_names(graph, lab)
    log(f'  companies: {len(graph["orig"])} groups from company-graph.json')
    return company_map(slugs, P, X0, keep, by, cat, titles, fields_of, prefs, cfg, log, graph=graph), names


def name_companies(companies, names):
    """Sets each company region's label to its name from the companies_layout (the labels file's, by group id)."""
    if names:
        for r, nm in zip(companies['regions'], names):
            r['label'] = nm


def field_names(profile):
    """{English label or tag of a board field: (English, German label)} from the profile."""
    out = {}
    for f in (profile or {}).get('fields') or []:
        lb = f.get('label') or {}
        en = lb.get('en') or f.get('tag') or f.get('id'); de = lb.get('de') or en
        for k in {en, f.get('tag'), f.get('id')}:
            if k:
                out[k] = (en, de)
    return out


def previous_namer(prev, fields=None):
    """A namer without any model: names a group after the group of the previous layout (prev, the parsed atlas-layout.json) that holds most
    of its roles, by the whole membership and not only the 25 sample ids of the labels file. When several new groups descend from one old group
    (it split), the largest keeps the name and the others get it with their own distinguishing board field or key words added ("Systems
    Engineering . Thermal"); the German name takes the German label of the same board field (fields: {English label: (en, de)}, from the profile) and the same key words. A group with less than 30 % of its roles in a named old group stays unnamed."""
    old = {}
    for scope, R in [('worldwide', (prev or {}).get('roles'))] + list(((prev or {}).get('scopes') or {}).items()):
        if not R:
            continue
        for kind, key in (('regions', 'c1'), ('hoods', 'c2')):
            mem = collections.defaultdict(set)
            for i, g in zip(R['ids'], R[key]):
                mem[g].add(i)
            old[(scope, kind)] = [(mem.get(g, set()), grp['label']) for g, grp in enumerate(R[kind]) if grp.get('label')]

    pair = lambda x: tuple((fields or {}).get(x) or (x, x))                  # a board field as (English, German); key words stay as they are

    def namer(requests):
        used, out, cand = collections.defaultdict(set), {}, []
        for r in requests:
            used[(r['scope'], r['kind'])] |= r.get('taken', set())
        for r in requests:
            best, share, ov = None, 0.0, 0
            for m, lb in old.get((r['scope'], r['kind']), []):
                n = len(r['members'] & m)
                if n / max(1, len(r['members'])) > share:
                    best, share, ov = lb, n / max(1, len(r['members'])), n
            if best and share >= 0.3:
                cand.append((ov, r, best))
        taken = set()
        for ov, r, lb in sorted(cand, key=lambda c: -c[0]):                 # the group with most roles from an old group keeps its name as it is
            scope = (r['scope'], r['kind'])
            if tuple(lb) not in taken and lb[0].lower() not in used[scope]:
                taken.add(tuple(lb)); out[r['key']] = tuple(lb); used[scope].add(lb[0].lower()); continue
            base = [x.split(' · ')[0] for x in lb]
            extra = [pair(x) for x in r['fields'] + [w.title() for w in r['words']] if x.lower() not in base[0].lower()]
            for take in (1, 2, 3):
                if not extra:
                    break
                cand_name = tuple(f'{b} · {" & ".join(e[k] for e in extra[:take])}' for k, b in enumerate(base))
                if cand_name[0].lower() not in used[scope]:
                    out[r['key']] = cand_name; used[scope].add(cand_name[0].lower()); break
        for r in requests:                                                  # a topic new since the last map: named by what sets it apart
            if r['key'] in out:
                continue
            parts = []
            for x in r['fields'][:1] + [w.title() for w in r['words']]:
                if x.lower() not in [p[0].lower() for p in parts] and not any(x.lower() in p[0].lower() or p[0].lower() in x.lower() for p in parts):
                    parts.append(pair(x))
            parts = parts[:3]
            for take in (len(parts), 2, 3, 1):
                nm = ' & '.join(p[0] for p in parts[:take]) if parts else ''
                if nm and nm.lower() not in used[(r['scope'], r['kind'])]:
                    out[r['key']] = (nm, ' & '.join(p[1] for p in parts[:take])); used[(r['scope'], r['kind'])].add(nm.lower()); break
        return out
    namer.batch = None
    namer.auto = True
    return namer


def name_missing(out, lab, lab_path, titles_of, namer, log=print, batch=12):
    """Names the groups apply_labels left without a name. namer(requests) -> {key: (en, de)}; a request is {key, scope, kind, words, fields, titles}
    (titles: up to 30 distinct member titles; members: the ids of all members; the namer decides what to use). The names go into the labels file with 25 member ids as the sample, so
    the next rebuild carries them over like the hand-written ones; groups the namer does not answer keep their word list. Returns the number named."""
    if not (lab and namer and lab_path):
        return 0
    todo = []
    for scope, R in [('worldwide', out['roles'])] + list((out.get('scopes') or {}).items()):
        for kind, key in (('regions', 'c1'), ('hoods', 'c2')):
            taken = {grp['label'][0].lower() for grp in R[kind] if grp.get('label')}       # names the namer must not repeat in this map
            mem = collections.defaultdict(list)
            for i, g in zip(R['ids'], R[key]):
                mem[g].append(i)
            for g, grp in enumerate(R[kind]):
                if grp.get('label') or not mem.get(g):
                    continue
                ids = mem[g]; seen, titles = set(), []
                for i in ids:
                    t = titles_of.get(i)
                    if t and t.lower() not in seen:
                        seen.add(t.lower()); titles.append(t)
                    if len(titles) == 30:
                        break
                todo.append({'key': f'{scope}/{kind}/{g}', 'scope': scope, 'kind': kind, 'words': grp.get('words') or [], 'fields': grp.get('fields') or [],
                             'titles': titles, 'members': set(ids), 'taken': taken, 'sample': ids[:25]})
    if not todo:
        return 0
    answers = {}
    step = getattr(namer, 'batch', batch) or len(todo)                      # a namer that needs to see all groups at once sets .batch = None
    for a in range(0, len(todo), step):
        try:
            answers.update(namer([{k: v for k, v in t.items() if k != 'sample'} for t in todo[a:a + step]]) or {})
        except Exception as e:
            log(f'  naming: a request failed ({type(e).__name__}: {e}); those groups keep their word list')
    added = 0
    for t in todo:
        nm = answers.get(t['key'])
        if nm and all(isinstance(x, str) and 2 <= len(x.strip()) <= 70 for x in nm):
            lab.setdefault('roles', {}).setdefault(t['scope'], {}).setdefault(t['kind'], []).append(dict({'en': nm[0].strip(), 'de': nm[1].strip(), 'sample': t['sample']}, **({'auto': True} if getattr(namer, 'auto', False) else {})))
            added += 1
    if added:
        with open(lab_path, 'w', encoding='utf-8') as fh:
            json.dump(lab, fh, ensure_ascii=False, indent=2)
        apply_labels(out, lab)
    log(f'  naming: {added} of {len(todo)} unnamed groups named')
    return added


def build(site, vectors, profile, log=print, namer=None):
    """Builds the layout and writes VECTORS/atlas-layout.json. Returns the file's path."""
    cfg, keep, X, X0, desc, prefs, employer, titles, fields_of, scope_of = prepare(site, vectors, profile)
    m = profile['map']
    any_scopes = {s['id'] for s in profile['scopes'] if (s.get('match') or {}).get('any')}
    prev_layout = previous_layout(vectors)
    roles = role_map(keep, X, employer, titles, fields_of, prefs, cfg, log, prev=previous_positions(prev_layout))
    global_coords = np.column_stack([roles['x'], roles['y']])
    log(f'worldwide: {len(keep)} roles ({len(keep) - cfg["n_live"]} no longer on the board, kept as context), {len(roles["regions"])} regions')
    maps = {}
    for s in reversed(profile['scopes']):                           # widest first, as the reference's SCOPES list
        sid = s['id']
        if sid in any_scopes:
            continue                                                 # the worldwide map is the one above
        sel = [i for i in range(len(keep)) if sid in scope_of[i]]
        if len(sel) < m['min_scope']:
            log(f'  {sid}: {len(sel)} roles, too few for a map of its own'); continue
        log(f'{sid}: {len(sel)} roles (reshaping with relaxed coordinates, preserving global cluster relationships)')
        maps[sid] = role_map_excerpt(sel, roles, cfg)
    # companies: every catalogue company, from its own vector (companies.py), combined with the centre of its open roles where it has any
    lab = load_labels(profile, log)
    nl = cfg['n_live']                                              # the roles that left the board shape the role map, not the companies' centres or counts
    companies, names = companies_layout(vectors, profile, keep[:nl], X0[:nl], titles[:nl], fields_of[:nl], prefs, cfg, lab, log)
    out = {'version': 2, 'k': cfg['k'], 'layout_k': cfg['layout_k'], 'scopes': maps, 'resolution': m['resolution'], 'language_removed': ['de', 'fr', 'es'],
           'reps_per_company_and_group': cfg['reps'], 'roles': roles, 'companies': companies}
    named = apply_labels(out, lab)
    name_companies(companies, names)
    log(f'  {named} groups named from the labels file')
    if lab:
        lab_path, titles_of = os.path.join(profile['_dir'], m['labels_file']), {r[0]: r[1] for r in keep}
        name_missing(out, lab, lab_path, titles_of, previous_namer(prev_layout, field_names(profile)), log)
        if namer:
            name_missing(out, lab, lab_path, titles_of, namer, log)
        name_companies(companies, names)                # apply_labels ran again: the company regions' names from the company graph are set again
    path = os.path.join(vectors, 'atlas-layout.json')
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    log(f'  wrote {path} ({os.path.getsize(path) / 1e6:.2f} MB)')
    return path


def add_new(site, vectors, profile, log=print, k=8):
    """Puts the roles on the board that the layout does not have yet on the map, without rebuilding it: each at the mean position of its k most
    similar roles that are already placed (in the worldwide map, and in every scope map the role belongs to), in the most common group of those
    neighbours. Roles without a vector wait for one. The next full rebuild (jobcrawl map) places them properly. Returns how many were added."""
    path = os.path.join(vectors, 'atlas-layout.json')
    if not os.path.exists(path):
        return 0
    with open(path, encoding='utf-8') as fh:
        out = json.load(fh)
    cfg, keep, X, X0, desc, prefs, employer, titles, fields_of, scope_of = prepare(site, vectors, profile)
    nl = cfg['n_live']
    X = X / np.maximum(np.linalg.norm(X, axis=1, keepdims=True), 1e-9)
    row_of = {r[0]: i for i, r in enumerate(keep)}
    has_vec = np.abs(X).sum(1) > 0
    added = 0
    for sid, R in [(None, out['roles'])] + list((out.get('scopes') or {}).items()):
        have = set(R['ids'])
        base = [row_of[i] for i in R['ids'] if i in row_of and has_vec[row_of[i]]]
        pos = [n for n, i in enumerate(R['ids']) if i in row_of and has_vec[row_of[i]]]
        new = [i for i in range(nl) if keep[i][0] not in have and has_vec[i] and (sid is None or sid in scope_of[i])]
        if not new or len(base) < k:
            continue
        sims = X[new] @ X[base].T
        near = np.argpartition(-sims, k - 1, axis=1)[:, :k]
        for q, i in enumerate(new):
            nb = [pos[j] for j in near[q]]
            R['ids'].append(keep[i][0])
            R['x'].append(round(float(np.mean([R['x'][n] for n in nb])), 4)); R['y'].append(round(float(np.mean([R['y'][n] for n in nb])), 4))
            for key, groups in (('c1', R['regions']), ('c2', R['hoods'])):
                g = collections.Counter(R[key][n] for n in nb).most_common(1)[0][0]
                R[key].append(g)
                if isinstance(groups[g].get('n'), int):
                    groups[g]['n'] += 1
            R['rep'].append(-1)
            added += 1
    if added:
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    log(f'  {added} new role placements added to the layout (worldwide and scope maps), without a rebuild')
    return added


def add_new_companies(vectors, profile, log=print, k=8):
    """Puts the companies that have a vector but no place in the layout on the companies map without rebuilding it: each at the mean position
    of its k most similar placed companies, in their most common group (the next full rebuild places them properly). Returns how many."""
    from jobcrawl.embed import companies as co
    path = os.path.join(vectors, 'atlas-layout.json')
    vpath = os.path.join(vectors, 'company-vec.json')
    if not (os.path.exists(path) and os.path.exists(vpath)):
        return 0
    with open(path, encoding='utf-8') as fh:
        out = json.load(fh)
    C = out.get('companies') or {}
    if not C.get('slugs'):
        return 0
    with open(vpath, encoding='utf-8') as fh:
        vj = json.load(fh)
    dim = vj['dim']
    M = np.fromfile(os.path.join(vectors, 'company-vec.bin'), dtype=np.int8).reshape(-1, dim).astype(np.float32)
    M /= np.maximum(np.linalg.norm(M, axis=1, keepdims=True), 1e-9)
    row = {s: i for i, s in enumerate(vj['slugs'])}
    if len(row) != len(M):
        return 0
    cat = {c['slug']: c for c in co.load_catalogue(co.catalogue_path(profile))}
    have = set(C['slugs'])
    new = [s for s in vj['slugs'] if s not in have and s in cat]
    base = [n for n, s in enumerate(C['slugs']) if s in row]
    if not new or len(base) < k:
        return 0
    B = M[[row[C['slugs'][n]] for n in base]]
    near = np.argpartition(-(M[[row[s] for s in new]] @ B.T), k - 1, axis=1)[:, :k]
    for q, s in enumerate(new):
        nb = [base[j] for j in near[q]]
        c = cat[s]
        C['slugs'].append(s); C['names'].append(c.get('name') or s); C['field'].append(c.get('field') or '')
        pr = c.get('profile'); t = (pr or {}).get('en', '') if isinstance(pr, dict) else ''
        C['about'].append(t[:240].rsplit(' ', 1)[0] + '…' if len(t) > 240 else t)
        C['x'].append(round(float(np.mean([C['x'][n] for n in nb])), 4)); C['y'].append(round(float(np.mean([C['y'][n] for n in nb])), 4))
        g = collections.Counter(C['c1'][n] for n in nb).most_common(1)[0][0]
        C['c1'].append(g); C['roles'].append(0)
        if isinstance(C['regions'][g].get('n'), int):
            C['regions'][g]['n'] += 1
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    log(f'  {len(new)} new companies added to the companies map, without a rebuild')
    return len(new)


def companies_only(site, vectors, profile, log=print):
    """Rebuilds only the companies section of VECTORS/atlas-layout.json (roles and scopes stay as they are, byte for byte)."""
    path = os.path.join(vectors, 'atlas-layout.json')
    if not os.path.exists(path):
        raise MapError(f'no atlas-layout.json in {vectors}: run jobcrawl map first')
    with open(path, encoding='utf-8') as fh:
        out = json.load(fh)
    cfg, keep, X, X0, desc, prefs, employer, titles, fields_of, scope_of = prepare(site, vectors, profile)
    # the company centres use the roles the kept roles section has (the board may have moved on since): the same roles on both sides
    ids = set(out['roles']['ids']); sel = [i for i, r in enumerate(keep) if r[0] in ids and not (desc.get(r[0]) or {}).get('off')]
    if len(sel) != len(keep):
        log(f'  {len(keep) - len(sel)} board roles are not in the layout and are left out of the company centres; '
            f'{len(ids) - len(sel)} layout roles are not on the board')
    keep = [keep[i] for i in sel]; X0 = X0[sel]; titles = [titles[i] for i in sel]; fields_of = [fields_of[i] for i in sel]
    lab = load_labels(profile, log)
    companies, names = companies_layout(vectors, profile, keep, X0, titles, fields_of, prefs, cfg, lab, log)
    out['companies'] = companies
    # names for the companies only: the roles and scopes are left out of apply_labels, so their labels stay as they are
    apply_labels({'roles': {'ids': [], 'c1': [], 'c2': [], 'regions': [], 'hoods': []}, 'scopes': {}, 'companies': companies}, lab)
    name_companies(companies, names)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    log(f'  companies: {len(companies["slugs"])} companies, {len(companies["regions"])} regions, {len(companies["links"])} links; wrote {path}')
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
