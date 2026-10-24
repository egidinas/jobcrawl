#!/usr/bin/env python3
"""Builds the demo data folder (demo/site) from a reference board: one scope of it, in the formats jobcrawl writes.

    python3 scripts/make_demo.py --source-site DIR --source-vectors DIR --work DIR [--scope bavaria] [--out demo/site]
        [--python EXE] [--map-python EXE] [--write-labels profiles/aerospace/labels.json]

--source-site     a board's site folder (jobs-index.json, jobs-desc-XX.json). Read only.
--source-vectors  a vectors folder (match-vec.bin/json, company-vec.bin/json, atlas-labels.json). Read only.
--work            scratch folder for the full-text site, the vectors and the demo profile. Not published. Must be outside this repository,
                  because it holds the full job texts.
--out             the demo folder to write (replaced). Default: demo/site in this repository.
--python          interpreter for jobcrawl publish (needs numpy for the neighbours). Default: this one.
--map-python      interpreter for jobcrawl map (needs the map extra: umap-learn, leidenalg, igraph, scipy). Default: --python.
--write-labels    also write the scope's group names of the labels file (--labels-from) into this profile labels file.

Steps:
 1. The roles whose scope list (sc) holds --scope. Their description texts (x) are kept in full in the work folder only.
 2. Each role keeps the contract keys (t, c, cs, u, l, r, sc, lv, d, tg, x) and nothing else. Field labels in tg become field ids.
    sc keeps the scopes of the demo profile. Descriptions: the first 300 characters of the work text (jobcrawl.text.work_text,
    with the employer boilerplate of this subset removed); the full text is never written to --out.
 3. Vectors: the rows of the roles that have one, copied as they are (int8, same mean and language directions); the company vectors of
    the companies with roles in the subset.
 4. The demo profile: profiles/aerospace with its scopes narrowed to the demo scope and worldwide (the atlas needs the any scope), a title
    for the demo, a companies catalogue made from the subset's company names, and the Bavaria group names as labels.
 5. jobcrawl publish --text-from (the keyword index and statements read the full text), jobcrawl map (with the labels), then publish
    again so the atlas layout is copied into the match folder.
"""
import argparse
import collections
import hashlib
import json
import os
import shutil
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from jobcrawl import board                      # noqa: E402  (after sys.path)
from jobcrawl.profile import load_profile       # noqa: E402
from jobcrawl.text import langfix              # noqa: E402
from jobcrawl.text import work_text as wt      # noqa: E402
from jobcrawl.text.sections import segment_sections  # noqa: E402

EXCERPT = 300
CONTRACT = ('t', 'c', 'cs', 'u', 'l', 'r', 'sc', 'lv', 'd', 'tg', 'x')
DEMO_TITLE = 'Aerospace and deep tech: demo (Bavaria)'
DEMO_TAGLINE = 'A demo subset of the reference profile: public aerospace roles in Bavaria, crawled October 2026. Excerpts only.'
DESC_RE = 'jobs-desc-'


def read_board(site):
    with open(os.path.join(site, 'jobs-index.json'), encoding='utf-8') as fh:
        index = json.load(fh)
    desc = {}
    for name in sorted(os.listdir(site)):
        if name.startswith(DESC_RE) and name.endswith('.json'):
            with open(os.path.join(site, name), encoding='utf-8') as fh:
                desc.update(json.load(fh))
    return index, desc


def fail(msg):
    print(f'make_demo: {msg}', file=sys.stderr)
    sys.exit(2)


def select(index, desc, scope):
    """The index rows whose scope list holds the scope, in the board's order (newest first)."""
    rows = []
    for r in index:
        d = desc.get(r[0])
        if d is None:
            continue
        sc = d.get('sc')
        if not isinstance(sc, list):
            fail(f'{r[0]}: sc is not a list in the source')
        if scope in sc:
            rows.append(r)
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description='Build the demo data folder from a reference board (see the module doc).')
    ap.add_argument('--source-site', required=True, metavar='DIR')
    ap.add_argument('--source-vectors', required=True, metavar='DIR')
    ap.add_argument('--work', required=True, metavar='DIR')
    ap.add_argument('--scope', default='bavaria')
    ap.add_argument('--out', default=os.path.join(REPO, 'demo', 'site'), metavar='DIR')
    ap.add_argument('--profile', default=os.path.join(REPO, 'profiles', 'aerospace'), metavar='DIR')
    ap.add_argument('--labels-from', metavar='FILE', help='labels file of the source (default: SOURCE_VECTORS/atlas-labels.json)')
    ap.add_argument('--write-labels', metavar='FILE', help='write the scope group names into this profile labels file')
    ap.add_argument('--python', default=sys.executable)
    ap.add_argument('--map-python', default=None)
    args = ap.parse_args(argv)
    map_python = args.map_python or args.python

    work = os.path.abspath(args.work); out = os.path.abspath(args.out)
    if os.path.commonpath([work, REPO]) == REPO:
        fail('--work must be outside this repository (it holds the full job texts)')
    profile = load_profile(args.profile)
    scopes = [s for s in profile['scopes'] if s['id'] == args.scope or (s.get('match') or {}).get('any')]
    if not any(s['id'] == args.scope for s in scopes):
        fail(f'scope {args.scope!r} is not in the profile')
    scope_ids = {s['id'] for s in scopes}
    field_by_label = {f['label']['en']: f['id'] for f in profile['fields']}
    level_codes = {b['code'] for b in profile['levels']}

    # 1. the subset, with the full text
    index, desc = read_board(args.source_site)
    rows = select(index, desc, args.scope)
    if not rows:
        fail(f'no role of {args.source_site} has the scope {args.scope!r}')
    ids = [r[0] for r in rows]
    full = {}; tags_lost = collections.Counter()
    for r in rows:
        d = desc[r[0]]
        if d['lv'] not in level_codes:
            fail(f'{r[0]}: level {d["lv"]!r} is not a level of the profile')
        tg = []
        for label in d['tg']:
            if label in field_by_label:
                tg.append(field_by_label[label])
            else:
                tags_lost[label] += 1
        if hashlib.sha1(d['u'].encode('utf-8')).hexdigest()[:8] != r[0]:
            fail(f'{r[0]}: id is not sha1(url)[:8]; the demo keeps the board ids')
        full[r[0]] = {'t': d['t'], 'c': d['c'], 'cs': d['cs'], 'u': d['u'], 'l': d['l'], 'r': d['r'],
                      'sc': [s for s in d['sc'] if s in scope_ids], 'lv': d['lv'], 'd': d['d'], 'tg': tg, 'x': d['x'] or ''}

    # 2. work texts (the employer boilerplate of this subset), then the excerpt
    by_company = collections.defaultdict(list)
    for rid in ids:
        by_company[full[rid]['c']].append(full[rid]['x'])
    boiler = wt.employer_boilerplate(by_company)
    work_by_id = {}
    for rid in ids:
        e = full[rid]
        work_by_id[rid] = wt.work_text(e['t'], e['x'], boiler.get(e['c'], frozenset()), segment_sections)
    cut = {}
    for rid in ids:
        e = dict(full[rid]); e['x'] = work_by_id[rid][:EXCERPT].rstrip()
        cut[rid] = e

    def entries(source):
        out_list = [(rid, source[rid]) for rid in ids]
        out_list.sort(key=lambda x: (x[1]['c'].lower(), x[1]['t'].lower()))
        out_list.sort(key=lambda x: x[1]['d'], reverse=True)       # newest first, as jobcrawl build
        return out_list

    if os.path.exists(work):
        shutil.rmtree(work)
    os.makedirs(os.path.join(work, 'full'))
    board.write_board(entries(full), os.path.join(work, 'full'))  # the full-text site: never published
    if os.path.exists(out):
        shutil.rmtree(out)
    board.write_board(entries(cut), out)

    # 3. vectors
    vdir = os.path.join(work, 'vectors'); os.makedirs(vdir)
    import numpy as np
    src_v = args.source_vectors
    with open(os.path.join(src_v, 'match-vec.json'), encoding='utf-8') as fh:
        vj = json.load(fh)
    dim = vj['dim']
    M = np.fromfile(os.path.join(src_v, 'match-vec.bin'), dtype=np.int8).reshape(-1, dim)
    row = {rid: k for k, rid in enumerate(vj['ids'])}
    vec_ids = [rid for rid in ids if rid in row]
    rows_bin = M[[row[rid] for rid in vec_ids]]
    with open(os.path.join(vdir, 'match-vec.bin'), 'wb') as fh:
        fh.write(rows_bin.tobytes())
    counts_lang = collections.Counter(langfix.language(full[rid]['t'] + ' ' + work_by_id[rid][:2000]) for rid in vec_ids)
    new_vj = dict(vj)
    new_vj['ids'] = vec_ids
    new_vj['lang_dirs_from'] = {l: int(counts_lang.get(l, 0)) for l in ('en', 'de', 'fr', 'es')}
    with open(os.path.join(vdir, 'match-vec.json'), 'w', encoding='utf-8') as fh:
        json.dump(new_vj, fh, separators=(',', ':'))

    companies = {}
    for rid in ids:
        if full[rid]['cs']:
            companies.setdefault(full[rid]['cs'], collections.Counter())[full[rid]['c']] += 1
    with open(os.path.join(src_v, 'company-vec.json'), encoding='utf-8') as fh:
        cj = json.load(fh)
    Pc = np.fromfile(os.path.join(src_v, 'company-vec.bin'), dtype=np.int8).reshape(-1, cj['dim'])
    crow = {slug: k for k, slug in enumerate(cj['slugs'])}
    slugs = [s for s in cj['slugs'] if s in companies]
    with open(os.path.join(vdir, 'company-vec.bin'), 'wb') as fh:
        fh.write(Pc[[crow[s] for s in slugs]].tobytes())
    new_cj = dict(cj); new_cj['slugs'] = slugs
    with open(os.path.join(vdir, 'company-vec.json'), 'w', encoding='utf-8') as fh:
        json.dump(new_cj, fh, separators=(',', ':'))
    with open(os.path.join(work, 'companies.json'), 'w', encoding='utf-8') as fh:
        json.dump({'companies': [{'slug': s, 'name': companies[s].most_common(1)[0][0]} for s in slugs]}, fh, ensure_ascii=False, indent=1)

    # 4. labels and the demo profile
    labels_from = args.labels_from or os.path.join(src_v, 'atlas-labels.json')
    if args.write_labels:
        with open(labels_from, encoding='utf-8') as fh:
            lab = json.load(fh)
        if args.scope not in lab.get('roles', {}):
            fail(f'{labels_from} has no roles of scope {args.scope!r}')
        ref = lab['roles'][args.scope]
        on_board = {r[0] for r in index}
        stale = 0
        for g in ref.get('regions', []) + ref.get('hoods', []):
            kept = [rid for rid in g.get('sample', []) if rid in on_board]
            stale += len(g.get('sample', [])) - len(kept)
            g['sample'] = kept
        sample_ids = {rid for g in ref.get('regions', []) + ref.get('hoods', []) for rid in g['sample']}
        if not sample_ids <= set(ids):
            fail(f'{len(sample_ids - set(ids))} label samples are on the board but not in the subset')
        print(f'make_demo: labels: {stale} sample ids that are no longer on the board were dropped')
        with open(args.write_labels, 'w', encoding='utf-8') as fh:
            json.dump({'roles': {args.scope: {'regions': ref.get('regions', []), 'hoods': ref.get('hoods', [])}}}, fh, ensure_ascii=False, indent=1)
            fh.write('\n')
    labels_src = args.write_labels or os.path.join(args.profile, 'labels.json')
    wp = os.path.join(work, 'profile'); os.makedirs(wp)
    if os.path.exists(labels_src):
        shutil.copyfile(labels_src, os.path.join(wp, 'labels.json'))
    with open(os.path.join(args.profile, 'profile.json'), encoding='utf-8') as fh:
        raw = json.load(fh)
    raw['title'] = DEMO_TITLE
    raw['tagline'] = DEMO_TAGLINE
    raw['scopes'] = scopes
    raw['companies_catalogue'] = 'companies.json'
    raw['map']['labels_file'] = 'labels.json'
    shutil.copyfile(os.path.join(work, 'companies.json'), os.path.join(wp, 'companies.json'))
    with open(os.path.join(wp, 'profile.json'), 'w', encoding='utf-8') as fh:
        json.dump(raw, fh, ensure_ascii=False, indent=1)
    load_profile(wp)                                     # the demo profile validates

    # 5. publish with the full text for the index, the map, publish again for the atlas layout
    def run(cmd):
        print('+ ' + ' '.join(cmd), flush=True)
        subprocess.run(cmd, cwd=REPO, check=True)
    publish = [args.python, '-m', 'jobcrawl', 'publish', '--site', out, '--profile', wp, '--vectors', vdir, '--text-from', os.path.join(work, 'full')]
    run(publish)
    run([map_python, '-m', 'jobcrawl', 'map', '--site', out, '--profile', wp, '--vectors', vdir])
    run(publish)

    # summary
    with open(os.path.join(out, 'jobs-index.json'), encoding='utf-8') as fh:
        n_index = len(json.load(fh))
    print(f'make_demo: {n_index} roles in {out}; {len(vec_ids)} role vectors; {len(slugs)} company vectors ({len(companies)} companies with roles)')
    print(f'make_demo: {sum(1 for rid in ids if full[rid]["x"])} roles with a description; excerpts of {EXCERPT} characters at most; '
          f'longest x {max(len(v["x"]) for v in cut.values())} characters')
    if tags_lost:
        print(f'make_demo: field labels without a profile field, dropped: {dict(tags_lost)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
