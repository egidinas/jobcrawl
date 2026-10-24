"""Keyword index and filter attributes of the "Match me" panel, built from the board's own files.

Port of the keyword stage of the reference implementation's build_match_index.py. Pure Python (no numpy): it runs wherever the site is published.
Writes into the match folder:
    match-bm25.json   keyword postings: n, avgdl, ids, len, idf, post (term -> [role index, weight, ...])
    match-attrs.json  per role, in board order: [scope bits, level index, has description, region index, field bits, language index]
                      with the lists scopes (profile order, narrowest first), levels ("" then the codes by rank), regions, fields, langs

The scopes and levels come from the profile (scopes[].id, levels[].code and rank). The languages are the four that
jobcrawl/text/langfix.py can tell apart; the fields and regions are whatever the board wrote into the role (tg, r).
Role id: the board's (first 8 hex digits of sha1(url)). The role's text is its title (weight 3 per word) and the first
3,000 characters of its description (weight 1), as in the reference.
"""
import collections
import json
import math
import os
import re

from jobcrawl.site import read_site
from jobcrawl.text import langfix

TOK = re.compile(r"[a-zäöüß0-9][a-zäöüß0-9+#.\-]+")
BODY_CHARS = 3000
LANGS = ['en', 'de', 'fr', 'es']


def tokens(t):
    out = []
    for w in TOK.findall(t.lower()):
        w = w.strip('.-')
        if len(w) < 2 or len(w) > 26:
            continue
        out.append(w)
        if '-' in w:
            out += [p for p in w.split('-') if len(p) > 1]       # "do-178c" is found as itself and by its parts
    return out


def scope_ids_of(profile):
    return [s['id'] for s in profile['scopes']]


def level_codes_of(profile):
    """"" (no band) followed by the band codes ordered by rank: the index the attributes refer to."""
    bands = sorted(enumerate(profile['levels']), key=lambda x: (x[1]['rank'], x[0]))
    return [''] + [b['code'] for _, b in bands]


def build(site, out, profile, log=print):
    """Writes match-bm25.json and match-attrs.json into out (a match folder). Returns the number of roles."""
    index, desc = read_site(site)
    SCOPES = scope_ids_of(profile); LEVELS = level_codes_of(profile)
    n = len(index); tf = []; df = collections.Counter(); lens = []
    for r in index:
        d = desc.get(r[0]) or {}; c = collections.Counter()
        for w in tokens(r[1]):
            c[w] += 3
        for w in tokens((d.get('x') or '')[:BODY_CHARS]):
            c[w] += 1
        tf.append(c); lens.append(sum(c.values()))
        for w in c:
            df[w] += 1
    keep = {w for w, k in df.items() if 2 <= k <= 0.4 * n}
    idf = {w: round(math.log(1 + (n - df[w] + .5) / (df[w] + .5)), 3) for w in keep}
    post = collections.defaultdict(list)
    for i, c in enumerate(tf):
        for w, k in c.items():
            if w in keep:
                post[w] += [i, k]
    with open(os.path.join(out, 'match-bm25.json'), 'w', encoding='utf-8') as fh:
        json.dump({'n': n, 'avgdl': round(sum(lens) / max(n, 1), 2), 'ids': [r[0] for r in index], 'len': lens, 'idf': idf, 'post': post}, fh, separators=(',', ':'))
    at = []; rix = {}; fx = {}
    for r in index:
        d = desc.get(r[0]) or {}; sc = d.get('sc') if isinstance(d.get('sc'), list) else []
        lv = d.get('lv') or ''
        at.append([sum(1 << k for k, s in enumerate(SCOPES) if s in sc), LEVELS.index(lv) if lv in LEVELS else 0, 1 if (d.get('x') or '') else 0,
                   rix.setdefault(d.get('r') or '', len(rix)), sum(1 << fx.setdefault(t, len(fx)) for t in (d.get('tg') or [])),
                   LANGS.index(langfix.language(r[1] + ' ' + (d.get('x') or '')[:2000]))])
    with open(os.path.join(out, 'match-attrs.json'), 'w', encoding='utf-8') as fh:
        json.dump({'scopes': SCOPES, 'levels': LEVELS, 'regions': sorted(rix, key=rix.get), 'fields': sorted(fx, key=fx.get), 'langs': LANGS, 'a': at},
                  fh, separators=(',', ':'))
    log(f'{n} roles, {len(keep)} terms -> match-bm25.json, match-attrs.json')
    return n
