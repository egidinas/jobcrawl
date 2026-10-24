"""Invented data for the Phase 3 tests and the acceptance runs: roles, descriptions, vectors. No model, no network, no real employer.

    python3 tests/synthetic.py --out DIR --roles 300      writes DIR/site (board files) and DIR/vectors (match-vec, company-vec)

Descriptions carry one of two themes ("independent ownership" or "procedures compliance") so that a role's vector can lean the same
way; a tenth of the roles are copies of another role at another location (the near-duplicates of the neighbours step).
Vectors: a base vector per distinct text (so copies are identical), a theme offset, and noise; numpy is needed for them.
"""
import argparse
import json
import os
import random
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

try:
    import numpy  # noqa: F401
    HAVE_NUMPY = True
    NUMPY_REASON = ''
except ImportError:                 # the tests that need vectors are skipped with this reason
    HAVE_NUMPY = False
    NUMPY_REASON = 'numpy is not installed in this interpreter (pip install -r requirements-embed.txt)'

COMPANIES = ['Nordlicht Satellite Systems GmbH', 'Vertex Quantum Works (via Example Job Board)', 'Alpha Orbital Labs', 'Beta Photonics AG',
             'Gamma Propulsion GmbH', 'Delta Test Labs', 'Epsilon Launch Services']
TITLES = ['Thermal Vacuum Test Engineer', 'Software Engineer, Mission Operations', 'Production Lead', 'Research Scientist Optics',
          'Working Student Embedded Software (m/w/d)', 'Systems Engineer Propulsion', 'Quality Engineer', 'Integration Technician']
LOCATIONS = ['München, BY, DEU, 80809', 'Berlin, DEU', 'Paris, FRA', 'Toulouse, FRA', 'Bremen, HB, DEU', 'Remote']
THEMES = {   # each theme says its keyword twice (the statements count two words), and a role takes one theme only
    'a': ['You work independently and take independent ownership of the campaign.', 'Greenfield work from scratch, self-driven and independent.'],
    'b': ['You follow procedures and quality management, with procedures audited each year.', 'Compliance with work instructions and certification rules is part of the job.'],
    'n': ['You run the test bench, support the integration and document the results.', 'Analysis of telemetry data and reports for the review board.'],
}
THEME_WORDS = {'a': 'independent', 'b': 'procedures'}


def make_catalog(n, seed=1, companies=None):
    """n roles (the catalogue shape of crawler/catalog.mjs); board.build orders them."""
    companies = companies or COMPANIES
    rng = random.Random(seed)
    items = []
    for i in range(n):
        theme = rng.choice('abn')
        sentences = THEMES[theme] + [rng.choice(THEMES['n'])]
        desc = 'Your tasks: ' + ' '.join(sentences) + f' Role number {i} in the programme.'
        items.append({'title': rng.choice(TITLES), 'url': f'https://careers.example.com/board/job-{i:04d}',
                      'company': companies[i % len(companies)], 'location': LOCATIONS[i % len(LOCATIONS)], 'source': 'ats_direct',
                      'posted': f'2026-10-{1 + i % 20:02d}', 'first_seen': f'2026-10-{1 + i % 20:02d}', 'last_seen': '2026-10-24',
                      'description': desc})
    # near-duplicates: the same posting for another location, another URL
    for k in range(max(1, n // 10)):
        src = dict(items[k * 7 % n])
        src['url'] = f'https://careers.example.com/board/dup-{k:04d}'
        src['location'] = LOCATIONS[(k + 3) % len(LOCATIONS)]
        items.append(src)
    return items


def role_vector(text, dim, seed_salt=''):
    """Base vector of a text (identical texts give identical vectors), a theme offset, and noise."""
    import numpy as np
    base = np.random.default_rng(zlib.crc32((seed_salt + text).encode('utf-8'))).normal(size=dim)
    v = 0.3 * base
    if THEME_WORDS['a'] in text.lower():
        v[0] += 2.0
    if THEME_WORDS['b'] in text.lower():
        v[0] -= 2.0
    return v


def write_match_vectors(vectors, board_ids_texts, dim=16):
    """Writes match-vec.bin/json for (id, text) pairs: centred (mean zero here), unit length, int8, as jobcrawl embed writes them."""
    import numpy as np
    os.makedirs(vectors, exist_ok=True)
    M = np.array([role_vector(t, dim) for _, t in board_ids_texts], np.float32)
    M = M / np.maximum(np.linalg.norm(M, axis=1, keepdims=True), 1e-9)
    q = np.clip(np.round(M * 127), -127, 127).astype(np.int8)
    with open(os.path.join(vectors, 'match-vec.bin'), 'wb') as fh:
        fh.write(q.tobytes())
    with open(os.path.join(vectors, 'match-vec.json'), 'w', encoding='utf-8') as fh:
        json.dump({'dim': dim, 'mean': [0.0] * dim, 'ids': [i for i, _ in board_ids_texts], 'prompt': 'task: search result | query: ',
                   'text': 'synthetic', 'lang_dirs': []}, fh, separators=(',', ':'))


def write_company_vectors(vectors, slugs, dim=16):
    import numpy as np
    M = np.array([role_vector(s, dim, 'company') for s in slugs], np.float32)
    M = M / np.maximum(np.linalg.norm(M, axis=1, keepdims=True), 1e-9)
    with open(os.path.join(vectors, 'company-vec.bin'), 'wb') as fh:
        fh.write(np.clip(np.round(M * 127), -127, 127).astype(np.int8).tobytes())
    with open(os.path.join(vectors, 'company-vec.json'), 'w', encoding='utf-8') as fh:
        json.dump({'dim': dim, 'slugs': slugs, 'text': 'synthetic', 'lang_dirs': []}, fh, separators=(',', ':'))


def board_for(items, profile, out):
    """Builds a site folder from invented items with jobcrawl's own board code. Returns (index rows, [(id, text)])."""
    from jobcrawl import board
    entries = board.build_entries(items, profile)
    board.write_board(entries, out)
    index = [[rid, e['t'], e['c'], e['u'], e['cs']] for rid, e in entries]
    return index, [(rid, e['x']) for rid, e in entries]


def main(argv=None):
    from jobcrawl.profile import load_profile
    ap = argparse.ArgumentParser(description='Write a synthetic site and vector folder for the tests.')
    ap.add_argument('--out', required=True); ap.add_argument('--roles', type=int, default=300); ap.add_argument('--dim', type=int, default=16)
    a = ap.parse_args(argv)
    profile = load_profile(os.path.join(os.path.dirname(HERE), 'profiles', 'aerospace'))
    site = os.path.join(a.out, 'site'); vectors = os.path.join(a.out, 'vectors')
    os.makedirs(site, exist_ok=True)
    index, pairs = board_for(make_catalog(a.roles), profile, site)
    write_match_vectors(vectors, pairs, a.dim)
    write_company_vectors(vectors, sorted({r[4] for r in index if r[4]}), a.dim)
    print(f"{len(index)} roles (about --roles, plus duplicates) -> {site}; vectors -> {vectors}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
