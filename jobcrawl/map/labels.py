"""Names of the atlas groups: hand-written names from the profile's map.labels_file, applied to a built layout.

The labels file (same shape as the reference implementation's atlas-labels.json):
    {"roles": {"<scope id>" or "worldwide": {"regions": [{"en", "de", "sample": [role ids]}], "hoods": [...]}},
     "companies": [{"en", "de", "sample": [company slugs]}]}
Each name goes to the group that now holds most of its sample members (at least 40 %), so a rebuild keeps a name where the groups
barely moved. Groups without a name keep their generated word list. No labels file: nothing is named.
"""
import collections
import json
import os


def load_labels(profile, log=print):
    """The parsed labels file of the profile, or None (not set, or missing: the groups keep their word labels)."""
    rel = (profile.get('map') or {}).get('labels_file')
    if not rel:
        return None
    path = os.path.join(profile['_dir'], rel)
    if not os.path.exists(path):
        log(f'map.labels_file not found ({path}): the groups keep their word labels')
        return None
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def apply_labels(out, lab):
    """Adds "label": [en, de] to the groups of a layout (out = the atlas dict). Returns the number of groups named."""
    if not lab:
        return 0
    named = 0

    def assign(groups, members_of, stored):
        nonlocal named
        for g in groups:
            g.pop('label', None)
        taken = set()
        for st in sorted(stored, key=lambda x: -len(x['sample'])):
            sample = set(st['sample']); best, share = None, 0.0
            for k, mem in members_of.items():
                sh = len(sample & mem) / max(1, len(sample))
                if sh > share and k not in taken:
                    best, share = k, sh
            if best is not None and share >= 0.4:
                groups[best]['label'] = [st['en'], st['de']]; taken.add(best); named += 1
    for scope, R in [('worldwide', out['roles'])] + list((out.get('scopes') or {}).items()):
        for kind, key in (('regions', 'c1'), ('hoods', 'c2')):
            mem = collections.defaultdict(set)
            for i, g in zip(R['ids'], R[key]):
                mem[g].add(i)
            assign(R[kind], mem, lab.get('roles', {}).get(scope, {}).get(kind, []))
    if out.get('companies') and out['companies'].get('slugs'):
        C = out['companies']; mem = collections.defaultdict(set)
        for sl, g in zip(C['slugs'], C['c1']):
            mem[g].add(sl)
        assign(C['regions'], mem, lab.get('companies', []))
    return named
