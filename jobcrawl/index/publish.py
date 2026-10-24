"""Writes the files the web app loads: SITE/match/ (the "Match me" and Atlas data) and SITE/config.json (the app's labels).

Port of the reference implementation's publish_match.py and the config part of the reference build. The match folder gets:
    match-bm25.json, match-attrs.json   always, built from the board's own files (match_index.py)
    match-vec.bin, match-vec.json       copied from the vectors folder, when it has them
    match-prefs.json                    statements (prefs.py), when there are vectors
    role-nb.bin, role-graph.json        neighbours and near-duplicates (neighbours.py), when there are vectors (needs numpy)
    atlas-layout.json                   copied when the map was built (jobcrawl map)
    company-vec.bin, company-vec.json   copied when the companies were embedded (jobcrawl embed with a companies_catalogue)
Without vectors the keyword index and config.json are still written; the Match me panel then runs on keywords alone.
Nothing personal is involved. Standard library only, except the neighbours step, which needs numpy.
"""
import json
import os
import shutil

from jobcrawl.index import match_index, neighbours, prefs

VECTOR_FILES = ('match-vec.bin', 'match-vec.json')
COPIED = ('atlas-layout.json', 'company-vec.bin', 'company-vec.json')


class PublishError(ValueError):
    pass


def web_config(profile):
    """config.json: the labels and lists the web app shows, from the profile (the statements' labels are in match-prefs.json)."""
    return {
        'name': profile['name'],
        'title': profile['title'],
        'tagline': profile['tagline'],
        'languages': profile['languages'],
        'scopes': [{'id': s['id'], 'label': s['label']} for s in profile['scopes']],
        'fields': [{'id': f['id'], 'label': f['label']} for f in profile['fields']],
        'levels': [{'code': b['code'], 'label': b['label'], 'rank': b['rank']} for b in profile['levels']],
        'personas': [{'id': p['id'], 'label': p['label'], 'regex': p['regex'], 'flags': p['flags']} for p in profile['personas']],
        'glossary': profile['glossary'],
        'statements_file': 'match/match-prefs.json',
    }


def has_vectors(vectors):
    return bool(vectors) and all(os.path.exists(os.path.join(vectors, f)) for f in VECTOR_FILES)


def publish(site, profile, vectors=None, log=print):
    """Writes SITE/match/ and SITE/config.json. Returns the files written, relative to SITE, sorted."""
    if not os.path.exists(os.path.join(site, 'jobs-index.json')):
        raise PublishError(f'no jobs-index.json in {site} (run jobcrawl build first)')
    out = os.path.join(site, 'match')
    os.makedirs(out, exist_ok=True)
    written = []
    if has_vectors(vectors):
        for name in VECTOR_FILES + COPIED:
            src = os.path.join(vectors, name)
            if os.path.exists(src):
                shutil.copyfile(src, os.path.join(out, name)); written.append(name)
        neighbours.build(site, vectors, out, log)
        written += ['role-nb.bin', 'role-graph.json']
        prefs.build(site, out, prefs.statements_of(profile), log)
        written.append('match-prefs.json')
    else:
        log(f'no match-vec files in {vectors}: vectors, neighbours and statements are not published (keywords only)')
    match_index.build(site, out, profile, log)
    written += ['match-bm25.json', 'match-attrs.json']
    with open(os.path.join(site, 'config.json'), 'w', encoding='utf-8') as fh:
        json.dump(web_config(profile), fh, ensure_ascii=False, indent=1)
        fh.write('\n')
    return sorted(os.path.join('match', n) for n in written) + ['config.json']
