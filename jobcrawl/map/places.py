"""The place file of a surface (places-v1.json): ONE source for every place map (map-proto, the transitions page, atlas-geography).

Built from the site resolver's role-sites.json (Atlas scripts/atlas/geo/resolve_site.py, version 1: {role id: {p, lat, lon, b, ...}}) and the
list of open postings of the surface (the public board's jobs, or a board bundle's in-scope members), so every page counts the same postings by
the same rule (owner/coordinator 2026-11-14: "the numbers must come from ONE source").

    {"version": 1, "built": iso, "role_sites_built": iso, "surface": "public" | "board:<bundle id>",
     "precisions": ["site", "postcode", "city", "region", "country"], "bases": [...],
     "cols": ["id", "co", "cc", "p", "b", "lon", "lat"],
     "rows": [[id, company id, country code, precision index, basis index, lon | null, lat | null], ...],
     "counts": {"rows", "located", "country_only", "none", "not_in_role_sites"}}

Category (the pages apply it; written here into "counts" so a build log shows it):
    located       p in {site, postcode, city} with a point, and the basis is not one of NOT_LOCATED_BASES
    country-only  otherwise, with a country code
    none          no country code
A posting the resolver does not know keeps the surface's own country code (if any) with p = country, basis "surface".
"""
import datetime as _dt
import json
import os

PRECISIONS = ['site', 'postcode', 'city', 'region', 'country']
LOCATED_P = {'site', 'postcode', 'city'}
# resolver bases whose point is a guess between several places (an ambiguous city name, an employer's default site among several): such a
# posting counts as country-only, never as a point (the place map shows a figure on its country instead)
NOT_LOCATED_BASES = ('city_ambiguous', 'single_site_default')


def located(p, basis, lon, lat):
    return p in LOCATED_P and lon is not None and lat is not None and not any(t in (basis or '') for t in NOT_LOCATED_BASES)


def role_key(url):
    """The resolver's key of a role: the first 8 hex digits of sha1(url), as the board's role ids."""
    import hashlib
    return hashlib.sha1(url.encode('utf-8')).hexdigest()[:8]


def read_role_sites(path):
    """All roles of role-sites.json version 1 (with or without a point) and its build time."""
    with open(path, encoding='utf-8') as fh:
        d = json.load(fh)
    if d.get('version') != 1:
        raise ValueError(f'{path}: role-sites version {d.get("version")!r}, expected 1')
    return d.get('roles') or {}, d.get('built', '')


def build_places(roles, jobs, surface, role_sites_built=''):
    """roles: read_role_sites()[0]; jobs: iterable of (id, company id, country code or '', role key or None) of the surface's open postings.
    The role key is the posting's key in role-sites.json (the resolver keys roles by role_key(url)); None = the id itself."""
    bases, bidx, rows = [], {}, []
    counts = {'rows': 0, 'located': 0, 'country_only': 0, 'none': 0, 'not_in_role_sites': 0}

    def b_of(name):
        if name not in bidx:
            bidx[name] = len(bases)
            bases.append(name)
        return bidx[name]

    seen = set()
    for jid, co, cc, rk in jobs:
        if jid in seen:
            continue
        seen.add(jid)
        r = roles.get(rk or jid)
        if r is None:
            counts['not_in_role_sites'] += 1
            p, basis, lon, lat = 'country', 'surface', None, None
        else:
            p, basis, lon, lat = r.get('p') or 'country', r.get('b') or '', r.get('lon'), r.get('lat')
            cc = r.get('cc') or cc
        if p not in PRECISIONS:
            p = 'country'
        loc = located(p, basis, lon, lat)
        if not loc:
            lon = lat = None
        rows.append([jid, co or '', cc or '', PRECISIONS.index(p), b_of(basis), None if lon is None else round(float(lon), 5), None if lat is None else round(float(lat), 5)])
        counts['rows'] += 1
        counts['located' if loc else ('country_only' if cc else 'none')] += 1
    return {'version': 1, 'built': _dt.datetime.now(_dt.timezone.utc).isoformat(timespec='seconds'), 'role_sites_built': role_sites_built,
            'surface': surface, 'precisions': PRECISIONS, 'bases': bases, 'not_located_bases': list(NOT_LOCATED_BASES),
            'cols': ['id', 'co', 'cc', 'p', 'b', 'lon', 'lat'], 'rows': rows, 'counts': counts}


def write_places(path, doc):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, path)
    return path
