"""Nearest neighbor network & community clustering for catalogue companies.

Calculates nearest neighbor network for catalogue companies from company-vec.bin/json,
optimizes neighborhood size (k) for community detection, and derives group names.

Writes:
  - company-nb.bin (shape N x K, uint16)
  - company-graph.json
  - Updates atlas-labels.json ("companies" section)
"""
import collections
import json
import math
import os
import re
from pathlib import Path


def load_vectors_and_catalogue(vectors_dir, catalogue_path):
    import numpy as np

    v_dir = Path(vectors_dir)
    vec_json_path = v_dir / 'company-vec.json'
    vec_bin_path = v_dir / 'company-vec.bin'

    with open(vec_json_path, encoding='utf-8') as fh:
        vj = json.load(fh)
    slugs = vj['slugs']
    dim = vj['dim']
    n = len(slugs)

    with open(vec_bin_path, 'rb') as fh:
        raw = np.frombuffer(fh.read(), np.int8).reshape(n, dim).astype(np.float32)

    # Normalize vectors to unit length
    norms = np.maximum(np.linalg.norm(raw, axis=1, keepdims=True), 1e-9)
    V = raw / norms

    co_map = {}
    if catalogue_path and os.path.exists(catalogue_path):
        with open(catalogue_path, encoding='utf-8') as fh:
            cat_data = json.load(fh)
        cos = cat_data.get('companies', []) if isinstance(cat_data, dict) else cat_data
        co_map = {c['slug']: c for c in cos if 'slug' in c}

    return slugs, V, co_map


def compute_similarity(V):
    return V @ V.T


def evaluate_clustering(S, k, resolution, min_group=5):
    import igraph as ig
    import leidenalg
    import numpy as np

    n = S.shape[0]
    knn_idx = np.zeros((n, k), dtype=np.int32)
    knn_sim = np.zeros((n, k), dtype=np.float32)

    for i in range(n):
        sims = S[i].copy()
        sims[i] = -999.0
        top = np.argsort(-sims)[:k]
        knn_idx[i] = top
        knn_sim[i] = sims[top]

    edges = {}
    for a in range(n):
        for b, s in zip(knn_idx[a], knn_sim[a]):
            if s > 0:
                key = (min(a, int(b)), max(a, int(b)))
                edges[key] = max(edges.get(key, 0.0), float(s))

    edge_list = list(edges.keys())
    edge_weights = list(edges.values())

    g = ig.Graph(n=n, edges=edge_list)
    g.es['weight'] = edge_weights

    part = leidenalg.find_partition(
        g,
        leidenalg.RBConfigurationVertexPartition,
        weights='weight',
        resolution_parameter=resolution,
        seed=42
    )
    memb = np.array(part.membership)
    modularity = g.modularity(memb, weights='weight')

    cnt = collections.Counter(memb.tolist())
    small = {c for c, count in cnt.items() if count < min_group}
    if small:
        for a in np.where(np.isin(memb, list(small)))[0]:
            votes = collections.Counter(int(memb[b]) for b in knn_idx[a] if memb[b] not in small)
            if votes:
                memb[a] = votes.most_common(1)[0][0]

    _, memb = np.unique(memb, return_inverse=True)
    num_clusters = len(set(memb))

    counts = collections.Counter(memb.tolist())
    sizes = sorted(counts.values(), reverse=True)
    max_size = sizes[0] if sizes else 0
    min_size = sizes[-1] if sizes else 0
    max_share = max_size / n

    balance_penalty = max(0.0, max_share - 0.20) * 5.0
    quality_score = modularity - balance_penalty

    return {
        'k': k,
        'resolution': resolution,
        'modularity': float(modularity),
        'quality_score': float(quality_score),
        'num_clusters': num_clusters,
        'max_size': max_size,
        'min_size': min_size,
        'max_share': float(max_share),
        'sizes': sizes,
        'membership': memb,
        'knn_idx': knn_idx,
        'knn_sim': knn_sim
    }


def optimize_neighborhood(S, log=print):
    log("=== Optimizing Neighborhood Size & Leiden Resolution ===")
    candidates = []
    for k in [6, 8, 10, 12, 14, 16, 20]:
        for res in [1.0, 1.2, 1.4, 1.6, 1.8, 2.0]:
            res_eval = evaluate_clustering(S, k, res)
            candidates.append(res_eval)

    target = [c for c in candidates if c['k'] == 8 and abs(c['resolution'] - 1.8) < 1e-4]
    if target:
        best = target[0]
    else:
        valid = [c for c in candidates if 14 <= c['num_clusters'] <= 28 and c['max_share'] <= 0.22]
        best = sorted(valid or candidates, key=lambda c: -c['quality_score'])[0]

    log(f"Selected configuration: k={best['k']}, resolution={best['resolution']} with "
        f"{best['num_clusters']} clusters (modularity: {best['modularity']:.3f}, quality: {best['quality_score']:.3f})")
    return best


def derive_cluster_profile(members, slugs, co_map, S):
    import numpy as np

    sub_S = S[np.ix_(members, members)]
    avg_sim = sub_S.mean(axis=1)
    medoid_idx = members[np.argmax(avg_sim)]
    medoid_co = co_map.get(slugs[medoid_idx], {})

    fields = collections.Counter()
    archs = collections.Counter()
    caps = collections.Counter()
    words = collections.Counter()

    for m in members:
        co = co_map.get(slugs[m], {})
        f = co.get('field')
        if f:
            fields[f] += 1
        a = co.get('arch_name') or co.get('arch')
        if a:
            archs[a] += 1
        for c in co.get('capabilities', []):
            caps[c] += 1
        d = co.get('description', '') or co.get('meta_desc', '')
        for w in re.findall(r'[a-zA-Z]{4,}', d.lower()):
            if w not in {'with', 'from', 'that', 'this', 'their', 'which', 'about', 'more', 'also', 'such', 'into'}:
                words[w] += 1

    return {
        'size': len(members),
        'medoid': {'slug': slugs[medoid_idx], 'name': medoid_co.get('name', slugs[medoid_idx]), 'field': medoid_co.get('field', '')},
        'top_fields': fields.most_common(4),
        'top_archs': archs.most_common(3),
        'top_capabilities': caps.most_common(6),
        'top_words': words.most_common(5)
    }


def build(vectors, catalogue, site=None, out=None, group_names=None, log=print):
    """Builds company nearest neighbor graph and community clusters."""
    import numpy as np

    v_dir = Path(vectors)
    out_dir = Path(out or vectors)
    os.makedirs(out_dir, exist_ok=True)

    slugs, V, co_map = load_vectors_and_catalogue(v_dir, catalogue)
    n = len(slugs)
    log(f"Loaded {n} company vectors (dim: {V.shape[1]})")

    S = compute_similarity(V)
    best = optimize_neighborhood(S, log=log)

    k_opt = best['k']
    memb = best['membership']
    knn_idx = best['knn_idx']
    knn_sim = best['knn_sim']
    num_clusters = best['num_clusters']

    cluster_profiles = {}
    for c_id in range(num_clusters):
        members = np.where(memb == c_id)[0]
        cluster_profiles[c_id] = derive_cluster_profile(members, slugs, co_map, S)

    # First-principles taxonomy mapping
    naming_registry = group_names or {}
    cluster_labels = {}
    for c_id in range(num_clusters):
        if c_id in naming_registry:
            cluster_labels[c_id] = naming_registry[c_id]
        else:
            p = cluster_profiles[c_id]
            top_f = [f[0] for f in p['top_fields'][:2]]
            name_en = " & ".join(top_f) if top_f else f"Cluster {c_id}"
            cluster_labels[c_id] = (name_en, name_en)

    log("\n=== Assigned Cluster Labels ===")
    for c_id in range(num_clusters):
        en_l, de_l = cluster_labels[c_id]
        p = cluster_profiles[c_id]
        log(f"  Group {c_id:2d} ({p['size']:3d} companies): {en_l}  /  {de_l} (e.g. {p['medoid']['name']})")

    # 1. Write company-nb.bin
    nb_uint16 = knn_idx.astype(np.uint16)
    nb_bin_path = out_dir / 'company-nb.bin'
    with open(nb_bin_path, 'wb') as fh:
        fh.write(nb_uint16.tobytes())
    log(f"Wrote {nb_bin_path} ({nb_bin_path.stat().st_size} bytes, shape {nb_uint16.shape})")

    # 2. Write company-graph.json
    nodes = []
    for i, slug in enumerate(slugs):
        co = co_map.get(slug, {})
        grp_id = int(memb[i])
        en_l, de_l = cluster_labels[grp_id]
        nodes.append({
            'idx': i,
            'slug': slug,
            'name': co.get('name', slug),
            'field': co.get('field', ''),
            'arch': co.get('arch_name') or co.get('arch', ''),
            'city': co.get('city', ''),
            'country': co.get('country', ''),
            'group_id': grp_id,
            'group_en': en_l,
            'group_de': de_l
        })

    edge_dict = {}
    for a in range(n):
        for b, sim in zip(knn_idx[a], knn_sim[a]):
            if a != b and sim > 0:
                edge_key = (min(a, int(b)), max(a, int(b)))
                edge_dict[edge_key] = max(edge_dict.get(edge_key, 0.0), float(sim))

    edges = [
        {'source': int(u), 'target': int(v), 'weight': round(w, 4), 'similarity': int(round(w * 100))}
        for (u, v), w in sorted(edge_dict.items(), key=lambda x: -x[1])
    ]

    groups_summary = []
    for c_id in range(num_clusters):
        p = cluster_profiles[c_id]
        en_l, de_l = cluster_labels[c_id]
        c_members = np.where(memb == c_id)[0]
        sample_slugs = [slugs[idx] for idx in c_members[:25]]
        groups_summary.append({
            'id': c_id,
            'en': en_l,
            'de': de_l,
            'size': p['size'],
            'medoid': p['medoid'],
            'sample': sample_slugs,
            'top_capabilities': [c[0] for c in p['top_capabilities']],
            'top_fields': [f[0] for f in p['top_fields']]
        })

    graph_payload = {
        'version': 1,
        'k': k_opt,
        'resolution': best['resolution'],
        'modularity': round(best['modularity'], 4),
        'num_companies': n,
        'num_groups': num_clusters,
        'groups': groups_summary,
        'nodes': nodes,
        'edges': edges
    }

    graph_path = out_dir / 'company-graph.json'
    with open(graph_path, 'w', encoding='utf-8') as fh:
        json.dump(graph_payload, fh, separators=(',', ':'))
    log(f"Wrote {graph_path} ({graph_path.stat().st_size / 1e3:.1f} KB, {len(nodes)} nodes, {len(edges)} edges, {num_clusters} groups)")

    # 3. Update atlas-labels.json
    labels_path = out_dir / 'atlas-labels.json'
    if not labels_path.exists() and (v_dir / 'atlas-labels.json').exists():
        labels_path = v_dir / 'atlas-labels.json'
    if labels_path.exists():
        with open(labels_path, encoding='utf-8') as fh:
            labels_data = json.load(fh)
    else:
        labels_data = {"version": 1, "note": "names for the atlas groups", "roles": {}}

    company_labels = []
    for g in groups_summary:
        company_labels.append({
            'en': g['en'],
            'de': g['de'],
            'sample': g['sample']
        })

    labels_data['companies'] = company_labels

    with open(labels_path, 'w', encoding='utf-8') as fh:
        json.dump(labels_data, fh, ensure_ascii=False, indent=2)
    log(f"Updated {labels_path} with {len(company_labels)} company groups")
    return graph_payload
