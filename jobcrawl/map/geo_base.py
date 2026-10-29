"""Natural Earth base map for the geographic cartogram (jobcrawl geomap): country and state polygons, downloaded once and cached.

    shapes = load(cache, state_countries=('DE',))  -> {'countries': [...], 'states': [...], 'unmatched': [...]}

Reads from the network (raw.githubusercontent.com, nvkelso/natural-earth-vector) the files that are not in CACHE yet:
    ne_110m_admin_0_countries.geojson         countries (ISO_A2, or ISO_A2_EH where ISO_A2 is -99: France, Norway, Kosovo)
    ne_10m_admin_1_states_provinces.geojson   first-level divisions of the countries in state_countries (Germany's Lander)
The 50m states file has no Germany, so the 10m one is used for the states. Writes the downloaded files into CACHE.
The rivers (load_rivers): ne_10m_rivers_lake_centerlines.geojson, and for Europe ne_10m_rivers_europe.geojson, from the same place.
Each shape: {'id': 'FR' or 'DE-BY', 'cc': 'FR', 'name': English name, 'match': names the gazetteer may call it by, 'kind': 'country' |
'state', 'rings': [[(lon, lat), ...], ...]} (outer rings and holes, as in the GeoJSON). Natural Earth is public domain.
"""
import json
import os
import urllib.request

BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/'
COUNTRIES_FILE = 'ne_110m_admin_0_countries.geojson'
STATES_FILE = 'ne_10m_admin_1_states_provinces.geojson'


class BaseMapError(ValueError):
    pass


def _fetch(cache, name, log):
    """The file from CACHE, or downloaded into it. Returns the path."""
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, name)
    if not os.path.exists(path):
        log(f'downloading {name} (Natural Earth, public domain)')
        try:
            with urllib.request.urlopen(BASE + name, timeout=120) as resp, open(path + '.part', 'wb') as fh:
                while True:
                    chunk = resp.read(1 << 16)
                    if not chunk:
                        break
                    fh.write(chunk)
            os.replace(path + '.part', path)
        except OSError as e:
            raise BaseMapError(f'cannot download {BASE + name}: {e} (put the file into {cache} by hand to work offline)')
    return path


def _rings(geometry):
    """[[(lon, lat), ...], ...] of a Polygon or MultiPolygon."""
    if geometry['type'] == 'Polygon':
        polys = [geometry['coordinates']]
    elif geometry['type'] == 'MultiPolygon':
        polys = geometry['coordinates']
    else:
        return []
    return [[(float(x), float(y)) for x, y in ring] for poly in polys for ring in poly]


def _names(props, *keys):
    return [props.get(k) for k in keys if props.get(k) and props.get(k) != '-99']


def load(cache, state_countries=('DE',), log=print):
    """The country and state shapes (see the module docstring). State names that the gazetteer does not know are listed in 'unmatched'."""
    from jobcrawl.geo import geo
    with open(_fetch(cache, COUNTRIES_FILE, log), encoding='utf-8') as fh:
        countries = []
        for f in json.load(fh)['features']:
            p = f['properties']
            cc = p.get('ISO_A2') if p.get('ISO_A2') not in (None, '-99') else p.get('ISO_A2_EH')
            if not cc or cc == '-99' or cc in state_countries:
                continue                      # no code (Somaliland, N. Cyprus), or a country whose states are shapes of their own
            rings = _rings(f['geometry'])
            if rings:
                countries.append({'id': cc, 'cc': cc, 'name': p.get('NAME') or cc, 'match': [], 'kind': 'country', 'rings': rings})
    states, unmatched = [], []
    with open(_fetch(cache, STATES_FILE, log), encoding='utf-8') as fh:
        feats = json.load(fh)['features']
    for f in feats:
        p = f['properties']
        cc = p.get('iso_a2')
        if cc not in state_countries:
            continue
        names = _names(p, 'name', 'name_en', 'name_de', 'woe_name')
        # the gazetteer's English name for this state (Bavaria, Hesse, ...), when one of the names is in its table
        known = {en for (c, en) in geo.STATE if c == cc}
        en = next((n for n in names if n in known), None)
        if en is None:
            unmatched.append(names[0] if names else '?')
            en = names[0] if names else '?'
        sid = p.get('iso_3166_2') or f'{cc}-{en}'
        rings = _rings(f['geometry'])
        if rings:
            states.append({'id': sid, 'cc': cc, 'name': en, 'match': names, 'kind': 'state', 'rings': rings})
    if unmatched:
        log(f'states the gazetteer does not name (kept under their Natural Earth name): {", ".join(unmatched)}')
    snapped = snap_borders(countries, states)
    log(f'borders: {snapped[0]} vertices of neighbouring countries moved onto the outline of the states (mean move {snapped[1]:.3f} deg)')
    return {'countries': countries, 'states': states, 'unmatched': unmatched}


def snap_borders(countries, states, tol=0.3, step=0.01):
    """The countries are 1:110m and the states 1:10m, so a neighbour's border and the states' outline do not meet (gaps and overlaps). Every vertex of a country
    within tol degrees of a state's outline moves onto that outline (its nearest point, the outline sampled every step degrees): corresponding border points
    are put together, and they move together afterwards because the cartogram displaces equal points equally. Returns (vertices moved, mean move in degrees)."""
    import numpy as np
    pts = []
    for st in states:
        for ring in st['rings']:
            r = np.asarray(ring, float)
            for a, b in zip(r[:-1], r[1:]):
                n = max(1, int(np.hypot(*(b - a)) / step))
                pts.append(a + (b - a) * (np.arange(n)[:, None] / n))
    if not pts:
        return 0, 0.0
    P = np.vstack(pts); cell = tol
    grid = {}
    for i, (x, y) in enumerate(P):
        grid.setdefault((int(x // cell), int(y // cell)), []).append(i)
    moved, dist = 0, 0.0
    x0, y0, x1, y1 = P[:, 0].min() - 0.5, P[:, 1].min() - 0.5, P[:, 0].max() + 0.5, P[:, 1].max() + 0.5
    for co in countries:                      # the neighbours' long straight edges near the states get vertices every 0.02 degrees, so the border can follow the outline
        for ring in co['rings']:
            dense = []
            for a_, b_ in zip(ring[:-1], ring[1:]):
                dense.append(a_)
                mx, my = (a_[0] + b_[0]) / 2, (a_[1] + b_[1]) / 2
                if x0 <= mx <= x1 and y0 <= my <= y1:
                    n = int(np.hypot(b_[0] - a_[0], b_[1] - a_[1]) / 0.02)
                    dense += [(a_[0] + (b_[0] - a_[0]) * q / (n + 1), a_[1] + (b_[1] - a_[1]) * q / (n + 1)) for q in range(1, n + 1)]
            dense.append(ring[-1])
            ring[:] = dense
    for co in countries:
        for ring in co['rings']:
            for k, (x, y) in enumerate(ring):
                cx, cy = int(x // cell), int(y // cell)
                idx = [i for dx in (-1, 0, 1) for dy in (-1, 0, 1) for i in grid.get((cx + dx, cy + dy), ())]
                if not idx:
                    continue
                q = P[idx]; d = np.hypot(q[:, 0] - x, q[:, 1] - y); j = int(d.argmin())
                if d[j] <= tol and d[j] > 0:
                    ring[k] = (float(q[j, 0]), float(q[j, 1])); moved += 1; dist += float(d[j])
    return moved, (dist / moved if moved else 0.0)


# ---- Eurostat GISCO outlines, one level of detail per scope ------------------------------------------------------------------------------------------
# The countries and the NUTS regions come from one family of files, so their borders meet (no gaps between a state and its neighbour country), and every scale is
# available: the world is drawn from the 1:10M countries, Europe from 1:3M with the German Laender, Germany from 1:1M with the Laender, and Bavaria from 1:1M with
# its 96 districts (71 Landkreise and the independent cities, NUTS 3) between the other Laender and the neighbouring countries. (c) EuroGeographics for the boundaries.
# (Version 2 of the cartogram: each level one step finer than before, 20M -> 10M, 10M -> 3M, 3M -> 1M for the Laender and the districts.)
GISCO = 'https://gisco-services.ec.europa.eu/distribution/v2/'
GISCO_ISO = {'EL': 'GR', 'UK': 'GB'}                     # GISCO's country codes that differ from ISO 3166-1 alpha-2


def _fetch_url(cache, url, log):
    path = os.path.join(cache, os.path.basename(url))
    if not os.path.exists(path):
        os.makedirs(cache, exist_ok=True)
        log(f'downloading {os.path.basename(url)} ...')
        req = urllib.request.Request(url, headers={'User-Agent': 'jobcrawl-geomap'})
        with urllib.request.urlopen(req, timeout=120) as r, open(path + '.part', 'wb') as out:
            out.write(r.read())
        os.replace(path + '.part', path)
    return path


def detail_of(scope):
    """The level of detail of a profile scope: 'world' (any), 'europe' (continent EU), 'states' (a country, with its states), 'districts' (a state, with its districts)."""
    m = scope['match']
    if 'any' in m:
        return 'world'
    if 'continent' in m:
        return 'europe'
    return 'districts' if 'admin1' in m else 'states'


def _district_name(n):
    n = (n or '').strip()
    for suffix, fmt in ((', Landkreis', 'LK {}'), (', Kreisfreie Stadt', '{} (city)'), (', Stadtkreis', '{} (city)'), (', Landeshauptstadt', '{} (city)'), (', Stadt', '{} (city)')):
        if n.endswith(suffix):
            return fmt.format(n[:-len(suffix)])
    return n


def load_scope(cache, scope, state_country='DE', log=print):
    """The shapes of one scope at its level of detail, as geo_base.load returns them ({'countries', 'states', 'unmatched'}); the 'states' of a 'districts' scope are the
    districts of the scope's state (kind 'district', parent: the state) plus the other states as context (kind 'state')."""
    level = detail_of(scope)
    res = {'world': ('10M', '10M', ()), 'europe': ('03M', '03M', (state_country,)), 'states': ('01M', '01M', (state_country,)), 'districts': ('01M', '01M', (state_country,))}[level]
    cres, nres, stc = res
    with open(_fetch_url(cache, f'{GISCO}countries/geojson/CNTR_RG_{cres}_2020_4326.geojson', log), encoding='utf-8') as fh:
        countries = []
        for f in json.load(fh)['features']:
            p = f['properties']; cc = GISCO_ISO.get(p.get('CNTR_ID'), p.get('CNTR_ID'))
            rings = _rings(f['geometry'])
            if cc and cc not in stc and rings:
                countries.append({'id': cc, 'cc': cc, 'name': p.get('NAME_ENGL') or cc, 'match': [], 'kind': 'country', 'rings': rings})
    states = []
    if stc:
        en_of = {}                                         # the German name of a state (NUTS) -> its English name, from the Natural Earth state names
        with open(_fetch(cache, STATES_FILE, log), encoding='utf-8') as fh:
            for f in json.load(fh)['features']:
                q = f['properties']
                if q.get('iso_a2') in stc and q.get('name_de') and (q.get('name_en') or q.get('name')):
                    en_of[q['name_de']] = q.get('name_en') or q['name']
        with open(_fetch_url(cache, f'{GISCO}nuts/geojson/NUTS_RG_{nres}_2021_4326_LEVL_1.geojson', log), encoding='utf-8') as fh:
            lands = [f for f in json.load(fh)['features'] if f['properties'].get('CNTR_CODE') in stc]
        keep = None
        if level == 'districts':
            want = scope['match'].get('admin1')
            keep = next((f['properties']['NUTS_ID'] for f in lands if want in (en_of.get(f['properties'].get('NAME_LATN')), f['properties'].get('NAME_LATN'), f['properties'].get('NUTS_NAME'))), None)
        for f in lands:
            p = f['properties']
            if keep and p['NUTS_ID'] == keep:
                continue                                   # the scope's own state is drawn as its districts
            rings = _rings(f['geometry'])
            if rings:
                states.append({'id': p['NUTS_ID'], 'cc': p['CNTR_CODE'], 'name': en_of.get(p.get('NAME_LATN')) or p.get('NAME_LATN'), 'de': p.get('NAME_LATN'),
                               'match': [n for n in (p.get('NAME_LATN'), p.get('NUTS_NAME')) if n], 'kind': 'state', 'rings': rings})
        if keep:
            with open(_fetch_url(cache, f'{GISCO}nuts/geojson/NUTS_RG_{nres}_2021_4326_LEVL_3.geojson', log), encoding='utf-8') as fh:
                for f in json.load(fh)['features']:
                    p = f['properties']
                    if p['NUTS_ID'].startswith(keep):
                        rings = _rings(f['geometry'])
                        if rings:
                            nm = _district_name(p.get('NAME_LATN'))
                            states.append({'id': p['NUTS_ID'], 'cc': p['CNTR_CODE'], 'name': nm, 'de': nm, 'match': [p.get('NAME_LATN') or nm], 'kind': 'district',
                                           'parent': scope['match'].get('admin1'), 'rings': rings})
    log(f'shapes for scope {scope["id"]} ({level}, countries 1:{cres}): {len(countries)} countries, {len(states)} states/districts')
    return {'countries': countries, 'states': states, 'unmatched': []}


# ---- Natural Earth rivers (optional: rivers are drawn when the files are there, and the build goes on without them) -----------------------------------
RIVERS_FILE = 'ne_10m_rivers_lake_centerlines.geojson'       # the world's rivers and lake centre lines; scalerank 0 (the largest) to 10
RIVERS_EUROPE_FILE = 'ne_10m_rivers_europe.geojson'          # Europe's finer rivers; its scalerank is 10 to 12 on its own scale (detail: True)


def load_rivers(cache, europe=False, log=print):
    """The rivers as [{'name', 'rank' (scalerank), 'lines': [[[lon, lat], ...], ...], 'detail': bool}], from the cache or downloaded into it. europe: the
    Europe file's rivers are added too (detail True: they carry their own scalerank and are not limited by the scope's rank). A file that cannot be
    read is logged and skipped; when the world file is missing the result is [] (the cartogram is then drawn without rivers)."""
    out = []
    for name, detail in ((RIVERS_FILE, False), (RIVERS_EUROPE_FILE, True)) if europe else ((RIVERS_FILE, False),):
        try:
            with open(_fetch(cache, name, log), encoding='utf-8') as fh:
                feats = json.load(fh)['features']
        except (BaseMapError, OSError, ValueError, KeyError) as e:
            log(f'rivers: {name} not available, drawn without it ({e})')
            if not detail:
                return []
            continue
        for f in feats:
            geom, p = f.get('geometry') or {}, f.get('properties') or {}
            if geom.get('type') == 'LineString':
                lines = [geom['coordinates']]
            elif geom.get('type') == 'MultiLineString':
                lines = geom['coordinates']
            else:
                continue
            lines = [[[float(x), float(y)] for x, y in line] for line in lines if len(line) >= 2]
            if lines:
                rank = p.get('scalerank')
                out.append({'name': p.get('name') or '', 'rank': int(rank) if rank is not None else 99, 'lines': lines, 'detail': detail})
    log(f'rivers: {len(out)} lines read')
    return out
