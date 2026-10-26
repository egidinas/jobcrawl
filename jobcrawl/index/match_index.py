"""Keyword index and filter attributes of the "Match me" panel, built from the board's own files.

Port of the keyword stage of the reference implementation's build_match_index.py. Pure Python (no numpy): it runs wherever the site is published.
Writes into the match folder:
    match-bm25.json   keyword postings: n, avgdl, ids, len, idf, post (term -> [role index, weight, ...])
    match-attrs.json  per role, in board order: [scope bits, level index, has description, region index, field bits, language index]
                      with the lists scopes (profile order, narrowest first), levels ("" then the codes by rank), regions, fields, langs
                      and dates: {base, ago}: base is the newest date (d) of the roles, ago[i] the whole days role i's date
                      is before it (0 = same day, -1 = no valid date), in board order

The scopes and levels come from the profile (scopes[].id, levels[].code and rank). The languages are the four that
jobcrawl/text/langfix.py can tell apart; the fields and regions are whatever the board wrote into the role (tg, r).
Role id: the board's (first 8 hex digits of sha1(url)). The role's text is its title (weight 3 per word) and the first
3,000 characters of its description (weight 1), as in the reference.
"""
import array
import collections
import datetime
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


DATE = re.compile(r'\d{4}-\d{2}-\d{2}')


def _day(s):
    """The date of a "YYYY-MM-DD" string, or None."""
    if not isinstance(s, str) or not DATE.fullmatch(s):
        return None
    try:
        return datetime.date.fromisoformat(s)
    except ValueError:
        return None


SHARD = re.compile(r'^jobs-desc-[0-9a-f]{2}\.json$')          # the shard names read_site() reads


def _shards(folder):
    return [os.path.join(folder, name) for name in sorted(os.listdir(folder)) if SHARD.match(name)]


def _load(path):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def build(site, out, profile, log=print, text_from=None):
    """Writes match-bm25.json and match-attrs.json into out (a match folder). Returns the number of roles.

    text_from: a site folder whose descriptions (x) are the ones to index and to detect the language of, instead of site's own.
    The demo uses it: the keyword index is built from the full descriptions while the published folder carries excerpts.

    Memory: the description shards are read one at a time (a later shard's entry for a role wins, as read_site's update does),
    and each role is kept as two arrays of term numbers and counts. The output is the same bytes as building from read_site().
    """
    with open(os.path.join(site, 'jobs-index.json'), encoding='utf-8') as fh:
        index = json.load(fh)
    n = len(index)
    where = collections.defaultdict(list)                  # role id -> its positions in the index (ids should be unique; a repeat is kept)
    for i, r in enumerate(index):
        where[r[0]].append(i)
    SCOPES = scope_ids_of(profile); LEVELS = level_codes_of(profile)
    shards = _shards(text_from or site)
    owner = {}                                             # role id -> number of the last shard that holds its entry
    for f, path in enumerate(shards):
        for k in _load(path):
            if k in where:
                owner[k] = f
    vocab = {}; words = []; df = array.array('L')
    rows = [None] * n; lens = [0] * n; small = [None] * n; days = [None] * n

    def add(i, d):
        title = index[i][1]; text = d.get('x') or ''
        c = collections.Counter()
        for w in tokens(title):
            c[w] += 3
        for w in tokens(text[:BODY_CHARS]):
            c[w] += 1
        ids = array.array('L'); ks = array.array('L')
        for w, k in c.items():
            j = vocab.get(w)
            if j is None:
                j = vocab[w] = len(words); words.append(w); df.append(0)
            df[j] += 1; ids.append(j); ks.append(k)
        rows[i] = (ids, ks); lens[i] = sum(c.values()); days[i] = _day(d.get('d'))
        sc = d.get('sc') if isinstance(d.get('sc'), list) else []
        lv = d.get('lv') or ''
        small[i] = (sum(1 << s for s, sid in enumerate(SCOPES) if sid in sc), LEVELS.index(lv) if lv in LEVELS else 0, 1 if text else 0,
                    d.get('r') or '', tuple(d.get('tg') or ()), LANGS.index(langfix.language(title + ' ' + text[:2000])))

    for f, path in enumerate(shards):
        shard = _load(path)
        for k in list(shard):
            if owner.get(k) == f:
                d = shard.pop(k) or {}
                for i in where[k]:
                    add(i, d)
        del shard
    for i in range(n):
        if rows[i] is None:
            add(i, {})                                     # a role without a description still takes part through its title
    # the terms in the order the first role that has them meets them (the order the Counter-based build inserted them in)
    seen = bytearray(len(words)); order = []
    for i in range(n):
        for j in rows[i][0]:
            if not seen[j]:
                seen[j] = 1; order.append(j)
    keep = {words[j] for j in order if 2 <= df[j] <= 0.4 * n}
    keepid = bytearray(len(words))
    for j in order:
        if 2 <= df[j] <= 0.4 * n:
            keepid[j] = 1
    idf = {w: round(math.log(1 + (n - df[vocab[w]] + .5) / (df[vocab[w]] + .5)), 3) for w in keep}
    post = collections.defaultdict(list)
    for i in range(n):
        ids, ks = rows[i]
        for j, k in zip(ids, ks):
            if keepid[j]:
                post[words[j]] += [i, k]
    with open(os.path.join(out, 'match-bm25.json'), 'w', encoding='utf-8') as fh:
        json.dump({'n': n, 'avgdl': round(sum(lens) / max(n, 1), 2), 'ids': [r[0] for r in index], 'len': lens, 'idf': idf, 'post': post}, fh, separators=(',', ':'))
    at = []; rix = {}; fx = {}
    for sc_bits, lv_i, hasx, reg, tg, lang in small:
        at.append([sc_bits, lv_i, hasx, rix.setdefault(reg, len(rix)), sum(1 << fx.setdefault(t, len(fx)) for t in tg), lang])
    base = max((x for x in days if x is not None), default=None)
    dates = {'base': base.isoformat() if base else '', 'ago': [(base - x).days if x is not None else -1 for x in days]}
    with open(os.path.join(out, 'match-attrs.json'), 'w', encoding='utf-8') as fh:
        json.dump({'scopes': SCOPES, 'levels': LEVELS, 'regions': sorted(rix, key=rix.get), 'fields': sorted(fx, key=fx.get), 'langs': LANGS, 'a': at,
                   'dates': dates},
                  fh, separators=(',', ':'))
    log(f'{n} roles, {len(keep)} terms -> match-bm25.json, match-attrs.json')
    return n
