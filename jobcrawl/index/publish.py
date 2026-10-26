"""Writes the files the web app loads: SITE/match/ (the "Match me" and Atlas data) and SITE/config.json (the app's labels).

Port of the reference implementation's publish_match.py and the config part of the reference build. The match folder gets:
    match-bm25.json, match-attrs.json   always, built from the board's own files (match_index.py)
    match-vec.bin, match-vec.json       copied from the vectors folder, when it has them
    match-prefs.json                    statements (prefs.py), when there are vectors
    role-nb.bin, role-graph.json        neighbours and near-duplicates: copied when the vectors folder has them (built offline,
                                        `jobcrawl neighbours`), else built here (neighbours.py, needs numpy)
    atlas-layout.json                   copied when the map was built (jobcrawl map)
    company-vec.bin, company-vec.json   copied when the companies were embedded (jobcrawl embed with a companies_catalogue)
    role-trends.json, role-timeline.*   copied when the traces were built (jobcrawl traces); the traces themselves stay in the vectors folder
    role-timeline-names-NNN.json        the timeline's title and company names, 2000 records per shard (copied with the timeline)
Without vectors the keyword index and config.json are still written; the Match me panel then runs on keywords alone.
Nothing personal is involved. Standard library only, except building the neighbours here, which needs numpy: a machine without
numpy publishes from a vectors folder that already holds role-nb.bin and role-graph.json.
"""
import json
import os
import re
import shutil

from jobcrawl.index import match_index, neighbours, prefs
from jobcrawl.site import read_site

VECTOR_FILES = ('match-vec.bin', 'match-vec.json')
COPIED = ('atlas-layout.json', 'company-vec.bin', 'company-vec.json')
NEIGHBOUR_FILES = ('role-nb.bin', 'role-graph.json')
TRENDS = ('role-trends.json', 'role-timeline.json', 'role-timeline.bin')     # built by jobcrawl traces; copied when present
NAMES = re.compile(r'^role-timeline-names-\d{3}\.json$')


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
        'fields': [{'id': f.get('tag', f['id']), 'label': f['label']} for f in profile['fields']],
        'levels': [{'code': b['code'], 'label': b['label'], 'rank': b['rank']} for b in profile['levels']],
        'personas': [{'id': p['id'], 'label': p['label'], 'regex': p['regex'], 'flags': p['flags']} for p in profile['personas']],
        'glossary': profile['glossary'],
        'statements_file': 'match/match-prefs.json',
        'accent': profile['accent'],
        'links': profile['links'],
        **profile.get('web', {}),
    }


def has_vectors(vectors):
    return bool(vectors) and all(os.path.exists(os.path.join(vectors, f)) for f in VECTOR_FILES)


def publish(site, profile, vectors=None, log=print, text_from=None, traces=None):
    """Writes SITE/match/ and SITE/config.json. Returns the files written, relative to SITE, sorted.

    text_from: a folder written by jobcrawl build with the full descriptions. When given, the keyword index and the statements read
    their text from it, and SITE's own descriptions (which may be excerpts) are not used for text. Every role of SITE must be in it.
    """
    if not os.path.exists(os.path.join(site, 'jobs-index.json')):
        raise PublishError(f'no jobs-index.json in {site} (run jobcrawl build first)')
    if text_from:
        if not os.path.exists(os.path.join(text_from, 'jobs-index.json')):
            raise PublishError(f'--text-from: no jobs-index.json in {text_from} (run jobcrawl build first)')
        ids = {r[0] for r in read_site(site)[0]}
        missing = ids - set(read_site(text_from)[1])
        if missing:
            raise PublishError(f'--text-from {text_from} lacks {len(missing)} of the {len(ids)} roles of {site}')
    out = os.path.join(site, 'match')
    os.makedirs(out, exist_ok=True)
    written = []
    if has_vectors(vectors):
        for name in VECTOR_FILES + COPIED:
            src = os.path.join(vectors, name)
            if os.path.exists(src):
                shutil.copyfile(src, os.path.join(out, name)); written.append(name)
        if all(os.path.exists(os.path.join(vectors, n)) for n in NEIGHBOUR_FILES):
            for n in NEIGHBOUR_FILES:
                shutil.copyfile(os.path.join(vectors, n), os.path.join(out, n))
        else:
            neighbours.build(site, vectors, out, log)
        written += list(NEIGHBOUR_FILES)
        prefs.build(site, out, prefs.statements_of(profile), log, text_from=text_from)
        written.append('match-prefs.json')
    else:
        log(f'no match-vec files in {vectors}: vectors, neighbours and statements are not published (keywords only)')
    src = traces or vectors        # the traces folder (jobcrawl traces --traces), else the vectors folder
    listed = sorted(f for f in os.listdir(src) if NAMES.match(f)) if src and os.path.isdir(src) else []
    for name in TRENDS + tuple(listed):
        if src and os.path.exists(os.path.join(src, name)):
            shutil.copyfile(os.path.join(src, name), os.path.join(out, name)); written.append(name)
    match_index.build(site, out, profile, log, text_from=text_from)
    written += ['match-bm25.json', 'match-attrs.json']
    with open(os.path.join(site, 'config.json'), 'w', encoding='utf-8') as fh:
        json.dump(web_config(profile), fh, ensure_ascii=False, indent=1)
        fh.write('\n')
    return sorted(os.path.join('match', n) for n in written) + ['config.json']
