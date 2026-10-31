"""Domains: what a role's work is for (space, defence, energy ...), from the profile's `domains` list. Separate from the function (what the
person does) and the level (how senior), so the three can be filtered and sorted independently.

Each domain has an id, English and German names, a hue and colour, a pattern for the words that mark it, and the company catalogue tags
that mark it. A role's own text decides first:
its title counts three times, the first 2,000 characters of its description once. Its employer adds a prior: the catalogue entry (name, field,
tags, profile; twice, and twice more for a catalogue tag the domain lists, still below one title mention) and the employer's other roles on the board. A role gets its best domain, and a second one when that scores at least
0.6 of the first; a role with no evidence at all takes the profile's fallback (the domain with "fallback": true). Standard library only.
"""
import collections
import re

TITLE_WEIGHT, DESC_WEIGHT, CATALOGUE_WEIGHT, EMPLOYER_WEIGHT = 3.0, 1.0, 2.0, 0.5
SECOND = 0.6
DESC_CHARS = 2000


def compile_domains(domains):
    return [(d['id'], re.compile(d['pattern'], re.I) if d.get('pattern') else None) for d in domains]


def _hits(text, compiled):
    return {d: len(rx.findall(text)) for d, rx in compiled if rx is not None and text}


def score(title, desc, compiled):
    s = collections.Counter()
    for d, n in _hits(title or '', compiled).items():
        s[d] += TITLE_WEIGHT * n
    for d, n in _hits((desc or '')[:DESC_CHARS], compiled).items():
        s[d] += DESC_WEIGHT * min(n, 4)                 # a long description that repeats a word is no stronger evidence than four mentions
    return s


def company_text(entry):
    if not entry:
        return ''
    prof = entry.get('profile') or {}
    return ' '.join([entry.get('field') or '', ' '.join(entry.get('tags') or []),        # not the name: "Faculty" is an AI company
                     (prof.get('en') or '') if isinstance(prof, dict) else str(prof or '')])


def classify(rows, domains, catalogue=None):
    """rows: [(id, title, description, company key)]; catalogue: {company key: catalogue entry}. Returns {id: [domain, second domain or '']}."""
    if not domains:
        return {}
    compiled = compile_domains(domains)
    tagged = [(d['id'], {t.lower() for t in d.get('tags') or []}) for d in domains if d.get('tags')]
    fallback = next((d['id'] for d in domains if d.get('fallback')), domains[-1]['id'])
    own = {r[0]: score(r[1], r[2], compiled) for r in rows}
    by_co = collections.defaultdict(collections.Counter)
    for r in rows:
        if r[3]:
            by_co[r[3]].update(own[r[0]])
    prior = {}
    for co, c in by_co.items():
        t = sum(c.values()) or 1.0
        p = collections.Counter({d: EMPLOYER_WEIGHT * 10 * v / t for d, v in c.items()})       # the employer's roles, as shares
        entry = (catalogue or {}).get(co)
        for d, n in _hits(company_text(entry), compiled).items():
            p[d] += CATALOGUE_WEIGHT * min(n, 3)
        ctags = {t.lower() for t in (entry or {}).get('tags') or []}
        for d, tags in tagged:                          # the catalogue's own tags, matched exactly ("space" is a tag there, not an idiom)
            if ctags & tags:
                p[d] += CATALOGUE_WEIGHT                # below one title mention (TITLE_WEIGHT): the role's own text decides first
        prior[co] = p
    out = {}
    for r in rows:
        s = own[r[0]] + prior.get(r[3], collections.Counter())
        best = [d for d, v in s.most_common(2) if v > 0]
        if not best:
            out[r[0]] = [fallback, '']
            continue
        second = best[1] if len(best) > 1 and best[1] != fallback and s[best[1]] >= SECOND * s[best[0]] else ''   # the fallback is never a second domain
        out[r[0]] = [best[0], second]
    return out
