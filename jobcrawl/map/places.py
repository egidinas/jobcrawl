"""The place file of a surface (places-v1.json): ONE source for every place map (map-proto, the transitions page, atlas-geography).

Built from the site resolver's role-sites.json (Atlas scripts/atlas/geo/resolve_site.py, version 1: {role id: {p, lat, lon, b, ...}}) and the
list of open postings of the surface (the public board's jobs, or a board bundle's in-scope members), so every page counts the same postings by
the same rule (owner/coordinator 2026-11-14: "the numbers must come from ONE source").

    {"version": 1, "built": iso, "role_sites_built": iso, "surface": "public" | "board:<bundle id>",
     "precisions": ["site", "postcode", "city", "region", "country", "county"], "bases": [...],
     "cols": ["id", "co", "cc", "p", "b", "lon", "lat", "n3"],   (n3: the county code of a located row, or null)
     "rows": [[id, company id, country code, precision index, basis index, lon | null, lat | null], ...],
     "counts": {"rows", "located", "country_only", "none", "not_in_role_sites"}}

Category (the pages apply it; written here into "counts" so a build log shows it):
    located       p in {site, postcode, city, county} with a point, and the basis is not one of NOT_LOCATED_BASES (county: a NUTS3 county
                  the source names, its point a spot inside the county, its code given in the role entry as n3; never a city or a pin)
    country-only  otherwise, with a country code
    none          no country code
A posting the resolver does not know keeps the surface's own country code (if any) with p = country, basis "surface".
"""
import datetime as _dt
import json
import os

PRECISIONS = ['site', 'postcode', 'city', 'region', 'country', 'county']   # appended last: the indices of the older five stay
LOCATED_P = {'site', 'postcode', 'city', 'county'}
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


# ---- the country check (review 2026-11-14: a site rule placed Singapore postings in California and Munich; the place map must never put a
# posting in a country other than its own). A point counts as located only if it lies in the posting's country, or within TOL_KM of its outline
# (coarse coastlines); otherwise the posting falls back to country-only. A country without an outline in the file is not checked.
TOL_KM = 25.0


class CountryTest:
    """Point-in-country from a jobcrawl geo-map scope file (geo-map-worldwide.json: shapes {id: ISO code, kind 'country', rings [[x, y, ...]]} in
    the scope's plane; box + w map the plane to Web Mercator 0..1)."""
    def __init__(self, path):
        import math
        with open(path, encoding='utf-8') as fh:
            d = json.load(fh)
        k = (d['box'][2] - d['box'][0]) / d['w']
        self.poly = {}
        for s in d['shapes']:
            if s.get('kind', 'country') != 'country':
                continue
            rings = []
            for r in s['rings']:
                pts = []
                for v in r:
                    mx, my = d['box'][0] + v[0] * k, d['box'][1] + v[1] * k
                    pts.append((mx * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * my))))))
                xs = [q[0] for q in pts]; ys = [q[1] for q in pts]
                rings.append((pts, (min(xs), min(ys), max(xs), max(ys))))
            self.poly.setdefault(s['id'], []).extend(rings)

    @staticmethod
    def _in(rings, x, y):
        c = False
        for pts, bb in rings:
            if x < bb[0] or x > bb[2] or y < bb[1] or y > bb[3]:
                continue
            j = len(pts) - 1
            for i in range(len(pts)):
                xi, yi = pts[i]; xj, yj = pts[j]
                if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                    c = not c
                j = i
        return c

    def __call__(self, cc, lon, lat):
        """True (in or near the country), False (clearly outside), None (no outline for cc)."""
        import math
        rings = self.poly.get(cc)
        if not rings:
            return None
        if self._in(rings, lon, lat):
            return True
        # near the outline: the shortest distance to any edge (equirectangular km), for rings whose box (grown by TOL_KM) holds the point
        kx = 111.32 * max(0.2, math.cos(math.radians(lat))); ky = 110.57; gx = TOL_KM / kx; gy = TOL_KM / ky
        for pts, bb in rings:
            if lon < bb[0] - gx or lon > bb[2] + gx or lat < bb[1] - gy or lat > bb[3] + gy:
                continue
            for i in range(len(pts)):
                (x1, y1), (x2, y2) = pts[i - 1], pts[i]
                ax, ay = (x1 - lon) * kx, (y1 - lat) * ky; bx, by = (x2 - lon) * kx, (y2 - lat) * ky
                vx, vy = bx - ax, by - ay; L2 = vx * vx + vy * vy
                t = 0.0 if L2 == 0 else max(0.0, min(1.0, -(ax * vx + ay * vy) / L2))
                if (ax + t * vx) ** 2 + (ay + t * vy) ** 2 <= TOL_KM * TOL_KM:
                    return True
        return False


class CountyIndex:
    """The county shapes of the shared place module (levels_l3.json: NUTS3; levels_extra.json: Singapore's planning areas) for point lookups.
    Each located row gets the code of the shape holding its point (even-odd over the shape's rings, as the pages fill them), assigned ONCE here so
    no page recomputes it: a state is the first three characters of the code, so a state's count is the sum of its counties' counts in every
    phase of every page. A point in no shape (coast, lake and border gaps) has no code and counts at country level only."""
    CELL = 0.5

    def __init__(self, paths):
        self.shapes, self.grid = [], {}
        for path in paths:
            if not path or not os.path.exists(path):
                continue
            with open(path, encoding='utf-8') as fh:
                for sh in json.load(fh).get('shapes') or []:
                    rings = [[(flat[i] / 1e4, flat[i + 1] / 1e4) for i in range(0, len(flat) - 1, 2)] for flat in sh.get('r') or []]
                    rings = [r for r in rings if len(r) >= 3]
                    if not rings:
                        continue
                    xs = [x for r in rings for x, _ in r]; ys = [y for r in rings for _, y in r]
                    k = len(self.shapes)
                    self.shapes.append((sh['id'], rings, (min(xs), min(ys), max(xs), max(ys))))
                    for gx in range(int(min(xs) // self.CELL), int(max(xs) // self.CELL) + 1):
                        for gy in range(int(min(ys) // self.CELL), int(max(ys) // self.CELL) + 1):
                            self.grid.setdefault((gx, gy), []).append(k)

    def __len__(self):
        return len(self.shapes)

    def code(self, lon, lat):
        """The id of the shape holding the point, or None."""
        for k in self.grid.get((int(lon // self.CELL), int(lat // self.CELL)), ()):
            sid, rings, bb = self.shapes[k]
            if not (bb[0] <= lon <= bb[2] and bb[1] <= lat <= bb[3]):
                continue
            inside = False
            for r in rings:
                j = len(r) - 1
                for i in range(len(r)):
                    xi, yi = r[i]; xj, yj = r[j]
                    if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                        inside = not inside
                    j = i
            if inside:
                return sid
        return None


def build_places(roles, jobs, surface, role_sites_built='', in_country=None, enforce=True, extra=None, counties=None):
    """roles: read_role_sites()[0]; jobs: iterable of (id, company id, country code or '', role key or None) of the surface's open postings.
    The role key is the posting's key in role-sites.json (the resolver keys roles by role_key(url)); None = the id itself.
    in_country: CountryTest (or any (cc, lon, lat) -> True/False/None); every located point outside its posting's country is counted in
    counts['wrong_country'] by country, and with enforce it falls back to country-only (lon/lat null, basis '<basis>|wrong_country').
    extra: {id: [lon, lat, basis, precision]} precise placements from other steps (Singapore MCF postal codes, single company addresses); they
    replace the resolver's point when present. A basis with '_choice' (one picked among several) is a guess and counts as country-only.
    counties: a CountyIndex for the county code column n3 (None: n3 stays null)."""
    bases, bidx, rows = [], {}, []
    counts = {'rows': 0, 'located': 0, 'country_only': 0, 'none': 0, 'not_in_role_sites': 0, 'extra_used': 0, 'wrong_country': {}, 'wrong_country_total': 0}

    def b_of(name):
        if name not in bidx:
            bidx[name] = len(bases)
            bases.append(name)
        return bidx[name]

    seen = set()
    for jid, co, cc, rk in jobs:
        n3_given = None
        if jid in seen:
            continue
        seen.add(jid)
        r = roles.get(rk or jid)
        x = (extra or {}).get(jid)
        if x is not None and '_choice' not in x[2]:
            lon, lat, basis, p = x[0], x[1], x[2], (x[3] if len(x) > 3 else 'postcode')
            counts['extra_used'] += 1
        elif r is None:
            counts['not_in_role_sites'] += 1
            p, basis, lon, lat = 'country', 'surface', None, None
        else:
            p, basis, lon, lat = r.get('p') or 'country', r.get('b') or '', r.get('lon'), r.get('lat')
            cc = r.get('cc') or cc
            n3_given = r.get('n3')                                                                # a county entry names its county itself
        if p not in PRECISIONS:
            p = 'country'
        loc = located(p, basis, lon, lat)
        if loc and in_country is not None and cc and in_country(cc, float(lon), float(lat)) is False:
            counts['wrong_country'][cc] = counts['wrong_country'].get(cc, 0) + 1
            counts['wrong_country_total'] += 1
            if enforce:
                loc, basis, p = False, basis + '|wrong_country', 'country'
        if not loc:
            lon = lat = None
        lon = None if lon is None else round(float(lon), 5)
        lat = None if lat is None else round(float(lat), 5)
        n3 = (n3_given if p == 'county' else None) if loc else None
        if loc and not n3 and counties:
            n3 = counties.code(lon, lat)
        if n3:
            counts['with_county'] = counts.get('with_county', 0) + 1
        rows.append([jid, co or '', cc or '', PRECISIONS.index(p), b_of(basis), lon, lat, n3])
        counts['rows'] += 1
        counts['located' if loc else ('country_only' if cc else 'none')] += 1
    counts['wrong_country'] = dict(sorted(counts['wrong_country'].items(), key=lambda kv: -kv[1]))
    return {'version': 1, 'rev': 2, 'built': _dt.datetime.now(_dt.timezone.utc).isoformat(timespec='seconds'), 'role_sites_built': role_sites_built,
            'surface': surface, 'precisions': PRECISIONS, 'bases': bases, 'not_located_bases': list(NOT_LOCATED_BASES),
            'country_check': {'enforced': bool(in_country is not None and enforce), 'tol_km': TOL_KM},
            'cols': ['id', 'co', 'cc', 'p', 'b', 'lon', 'lat', 'n3'], 'rows': rows, 'counts': counts}


def write_places(path, doc):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, path)
    return path
