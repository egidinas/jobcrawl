"""Neighbours and near-duplicates for every role with a vector (needs numpy).

Port of the reference implementation's build_neighbours.py. Near-duplicates: two postings whose titles share at least 80 % of their words and whose work
texts are almost the same (cosine >= 0.97; at the same employer >= 0.8, since the same posting for another city differs in its
location paragraphs), ignoring "(m/w/d)" and the like. Mostly the same job posted for several locations, or listed again by a job board
or recruiter. They form groups; the first of each group (preferring an employer with a company page) stands for it.
Neighbours: the 10 most similar roles, at most 2 from the same employer and one per duplicate group, never a duplicate of the role itself.

Written into the match folder: role-nb.bin (uint16, 10 per role, in the order of match-vec.json ids; 65535 = none) and
role-graph.json ({k, ids_from: 'match-vec.json', sim: 10 per role (0..100), dup: [[i, j, ...], ...]}).
"""
import collections
import json
import os
import re

K, DUP_COS, DUP_TITLE, PER_EMPLOYER, SAME_EMPLOYER_COS = 10, 0.97, 0.8, 2, 0.8
GENDER = re.compile(r'\((?:[mwfdx]|all|gender|genders|human)[^)]*\)', re.I)


def title_words(t):
    return set(re.findall(r'[a-zäöüß0-9]+', GENDER.sub('', t.lower())))


def build(site, vectors, out, log=print, use_jobonly=True):
    """Reads match-vec.bin/json (or match-vec-jobonly.bin/json) from vectors and the board from site; writes role-nb.bin and role-graph.json into out."""
    import numpy as np
    from jobcrawl.site import read_site
    jobonly_json = os.path.join(vectors, 'match-vec-jobonly.json')
    jobonly_bin = os.path.join(vectors, 'match-vec-jobonly.bin')
    if use_jobonly and os.path.exists(jobonly_json) and os.path.exists(jobonly_bin):
        log("neighbours: using sanitized job-only vectors (compensating for company brand bias)")
        json_file, bin_file = jobonly_json, jobonly_bin
    else:
        json_file = os.path.join(vectors, 'match-vec.json')
        bin_file = os.path.join(vectors, 'match-vec.bin')

    with open(json_file, encoding='utf-8') as fh:
        vj = json.load(fh)
    ids = vj['ids']; n = len(ids)
    with open(bin_file, 'rb') as fh:
        V = np.frombuffer(fh.read(), np.int8).reshape(n, vj['dim']).astype(np.float32)
    V /= np.maximum(np.linalg.norm(V, axis=1, keepdims=True), 1e-9)
    index, desc = read_site(site)
    rows = {r[0]: r for r in index}

    target_json = os.path.join(vectors, 'match-vec.json')
    if os.path.exists(target_json):
        with open(target_json, encoding='utf-8') as fh:
            target_vj = json.load(fh)
        target_ids = target_vj['ids']
    else:
        target_ids = ids

    if target_ids != ids:
        log(f"neighbours: aligning {len(ids)} JD-only vectors to {len(target_ids)} target match-vec rows for exact browser indexing")
        id_to_idx = {rid: i for i, rid in enumerate(ids)}
        V_aligned = np.zeros((len(target_ids), V.shape[1]), dtype=np.float32)
        on = np.zeros(len(target_ids), dtype=bool)
        for t_idx, rid in enumerate(target_ids):
            if rid in id_to_idx and rid in rows:
                V_aligned[t_idx] = V[id_to_idx[rid]]
                on[t_idx] = True
            else:
                on[t_idx] = False
        V = V_aligned
        ids = target_ids
        n = len(ids)
    else:
        # a vector whose role is no longer on this board (closed since it was embedded) is nobody's neighbour, joins no duplicate group
        # and gets no neighbours: the page could not show it
        on = np.array([i in rows for i in ids])
    emp = [rows[i][2] if i in rows else '?' + i for i in ids]; slug = [rows[i][4] if i in rows else '' for i in ids]
    tw = [title_words(rows[i][1]) if i in rows else set() for i in ids]
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    cand = []
    for s in range(0, n, 1024):
        S = V[s:s + 1024] @ V.T
        for r in range(S.shape[0]):
            S[r, s + r] = -9
        S[:, ~on] = -9
        top = np.argsort(-S, 1)[:, :40]
        for r in range(S.shape[0]):
            i = s + r
            if not on[i]:
                cand.append([]); continue
            cand.append([(int(j), float(S[r, j])) for j in top[r] if on[j]])
            for j, c in cand[-1]:
                if c < SAME_EMPLOYER_COS:
                    break
                u = len(tw[i] & tw[j]) / max(1, len(tw[i] | tw[j]))
                # the same job: nearly the same title, and nearly the same text (or, at the same employer, a similar text:
                # the same posting for another city differs in its location paragraphs)
                if u >= DUP_TITLE and (c >= DUP_COS or emp[i] == emp[j]):
                    parent[find(i)] = find(j)
    # the same title at the same employer is the same job listed again (other city, other shift), however its text differs
    same = collections.defaultdict(list)
    for i in range(n):
        same[(emp[i], frozenset(tw[i]))].append(i)
    for members in same.values():
        for j in members[1:]:
            parent[find(j)] = find(members[0])
    groups = collections.defaultdict(list)
    for i in range(n):
        groups[find(i)].append(i)
    dup = [sorted(g, key=lambda i: (slug[i] == '', i)) for g in groups.values() if len(g) > 1]
    nb = np.full((n, K), 65535, np.uint16); sim = np.zeros((n, K), np.uint8)
    for i in range(n):
        per = collections.Counter(); k = 0; seen = {find(i)}
        for j, c in cand[i]:
            if find(j) in seen or per[emp[j]] >= PER_EMPLOYER:      # one per duplicate group, a few per employer
                continue
            seen.add(find(j)); per[emp[j]] += 1; nb[i, k] = j; sim[i, k] = max(0, min(100, round(c * 100))); k += 1
            if k == K:
                break
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, 'role-nb.bin'), 'wb') as fh:
        fh.write(nb.tobytes())
    with open(os.path.join(out, 'role-graph.json'), 'w', encoding='utf-8') as fh:
        json.dump({'k': K, 'ids_from': 'match-vec.json', 'sim': sim.flatten().tolist(), 'dup': dup}, fh, separators=(',', ':'))
    log(f'{n} roles: {len(dup)} duplicate groups covering {sum(len(g) for g in dup)} postings ({sum(len(g) - 1 for g in dup)} would be folded); '
        f'neighbours {K} per role')
    return n
