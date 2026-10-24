"""General statements for "Match me" and the Atlas ("independent work or clear guidelines?"), as directions in the role meaning space.

Port of the reference implementation's prefs.py. The statements come from the profile (`statements`): each has two poles, a and b, with labels in English
and German, and two regular expressions: the words roles use about themselves (matched on the lower-cased title and the first
3,000 characters of the description). A role belongs to a pole when it uses at least two of its words and none of the other pole's.
The direction is the difference of the two groups' mean vectors, computed on one half of the roles (split by role id) and checked
on the other half: AUC = how often a held-out role of pole A projects further along the direction than one of pole B. Statements
whose AUC is below MIN_AUC are not published. The AUC only shows that the direction separates roles that use the words; whether
the two ends read as the statement is for a person to check by reading sample titles at both ends.
Pure Python, no numpy: runs wherever the site is published.

Output: <out>/match-prefs.json  {dim, prefs: [{id, a: [en, de], b: [en, de], v: [dim numbers], mu, sd, auc, n: [na, nb]}]}
A visitor's answer v in -2..2 (towards a .. towards b) tilts each role's score by v/2 * (projection - mu) / sd * a small weight.
"""
import array
import json
import os
import re
import zlib

from jobcrawl.site import read_site

MIN_AUC = 0.75           # statements that separate their held-out roles less well are not published
MIN_ROLES = 15           # per pole and half: fewer roles and the statement is skipped


def statements_of(profile):
    """The profile's statements as plain dicts: {id, a: [en, de], b: [en, de], a_regex, b_regex}."""
    out = []
    for s in profile.get('statements') or []:
        out.append({'id': s['id'], 'a': [s['a']['en'], s['a']['de']], 'b': [s['b']['en'], s['b']['de']],
                    'a_regex': s['a_regex'], 'b_regex': s['b_regex']})
    return out


def auc(pos, neg):
    """Probability that a random pos value exceeds a random neg value (ties count half)."""
    allv = sorted([(x, 1) for x in pos] + [(x, 0) for x in neg]); r = 0.0; rank_sum = 0.0; i = 0
    while i < len(allv):
        j = i
        while j < len(allv) and allv[j][0] == allv[i][0]:
            j += 1
        avg = (i + j + 1) / 2
        rank_sum += avg * sum(1 for k in range(i, j) if allv[k][1] == 1); i = j
    return (rank_sum - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)) if pos and neg else 0.5


def build(site, out, statements, log=print):
    """Writes match-prefs.json into out (needs match-vec.json and match-vec.bin there). Returns the statements published."""
    with open(os.path.join(out, 'match-vec.json'), encoding='utf-8') as fh:
        vj = json.load(fh)
    dim = vj['dim']
    q = array.array('b')
    with open(os.path.join(out, 'match-vec.bin'), 'rb') as fh:
        q.frombytes(fh.read())
    row = {rid: k for k, rid in enumerate(vj['ids'])}
    index, desc = read_site(site)
    roles = []
    for r in index:
        if r[0] not in row:
            continue
        k = row[r[0]]; v = [q[k * dim + d] / 127 for d in range(dim)]; n = sum(x * x for x in v) ** 0.5 or 1
        roles.append((r[0], [x / n for x in v], (r[1] + ' ' + ((desc.get(r[0]) or {}).get('x') or '')[:3000]).lower()))
    half = lambda rid: zlib.crc32(rid.encode()) & 1
    prefs = []
    for s in statements:
        sid = s['id']; a_lab, b_lab = s['a'], s['b']
        A, B = re.compile(s['a_regex'], re.I), re.compile(s['b_regex'], re.I); ga, gb = [], []
        for rid, v, text in roles:
            na, nb = len(A.findall(text)), len(B.findall(text))
            if na >= 2 and nb == 0: ga.append((rid, v))
            elif nb >= 2 and na == 0: gb.append((rid, v))
        def mean(g):
            m = [0.0] * dim
            for _, v in g:
                for d in range(dim): m[d] += v[d] / len(g)
            return m
        tr_a, tr_b = [x for x in ga if half(x[0]) == 0], [x for x in gb if half(x[0]) == 0]
        te_a, te_b = [x for x in ga if half(x[0]) == 1], [x for x in gb if half(x[0]) == 1]
        if min(len(tr_a), len(tr_b), len(te_a), len(te_b)) < MIN_ROLES:
            log(f'  prefs: {sid} skipped, too few roles ({len(ga)} / {len(gb)})'); continue
        ma, mb = mean(tr_a), mean(tr_b); d_ = [x - y for x, y in zip(ma, mb)]; n = sum(x * x for x in d_) ** 0.5 or 1; d_ = [x / n for x in d_]
        proj = lambda v: sum(x * y for x, y in zip(v, d_))
        score = auc([proj(v) for _, v in te_a], [proj(v) for _, v in te_b])
        # final direction from all labelled roles; spread of all roles along it, for a z-score in the browser
        ma, mb = mean(ga), mean(gb); d_ = [x - y for x, y in zip(ma, mb)]; n = sum(x * x for x in d_) ** 0.5 or 1; d_ = [x / n for x in d_]
        ps = [proj(v) for _, v, _ in roles]; mu = sum(ps) / len(ps); sd = (sum((p - mu) ** 2 for p in ps) / len(ps)) ** 0.5 or 1
        ok = score >= MIN_AUC
        log(f'  prefs: {sid:<9} AUC {score:.3f} on held-out roles ({len(ga)} / {len(gb)} labelled){"" if ok else "  -> not published"}')
        if ok:
            prefs.append({'id': sid, 'a': list(a_lab), 'b': list(b_lab), 'v': [round(x, 5) for x in d_], 'mu': round(mu, 5), 'sd': round(sd, 5),
                          'auc': round(score, 3), 'n': [len(ga), len(gb)]})
    with open(os.path.join(out, 'match-prefs.json'), 'w', encoding='utf-8') as fh:
        json.dump({'dim': dim, 'prefs': prefs}, fh, ensure_ascii=False, separators=(',', ':'))
    return prefs
