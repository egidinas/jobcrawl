"""Builds jobcrawl/geo/geo_coords.json: latitude and longitude of every city in the gazetteer (jobcrawl.geo.geo), from the GeoNames dump.

GeoNames data (https://www.geonames.org/) is licensed CC BY 4.0. Download cities1000.zip and admin1CodesASCII.txt into an empty directory:

    python -m jobcrawl.geo.geo_coords <dir with cities1000.txt and admin1CodesASCII.txt>

A gazetteer city is matched on country, then on its name or one of its aliases against the GeoNames name, ASCII name and alternate names; where
the gazetteer gives a state, the GeoNames first-level division must agree. The most populous candidate wins. Cities that find no match are
listed and left out of the table (they sort after all located places; no country or state centre is invented).
"""
import json
import sys
import unicodedata
from pathlib import Path

from jobcrawl.geo import geo


def fold(s):
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower()
    return ''.join(ch for ch in s if ch.isalnum())


# Localities and launch or test sites that GeoNames lists as districts or not at all (approximate, to about 1 km; enough to rank by distance).
MANUAL = {'DE|Oberpfaffenhofen': (48.08, 11.28), 'DE|Parsdorf': (48.14, 11.80), 'DE|Martinsried': (48.11, 11.46), 'DE|Stockdorf': (48.09, 11.40),
          'DE|Lampoldshausen': (49.30, 9.41), 'FR|Kourou': (5.16, -52.65), 'US|Starbase': (25.99, -97.18), 'US|Wallops Island': (37.94, -75.47),
          'US|Stennis Space Center': (30.38, -89.60), 'US|Edwards': (34.92, -117.88), 'US|Quonset': (41.60, -71.41), 'US|McHenry': (30.80, -89.10),
          'NZ|Mahia': (-39.09, 177.90), 'NZ|Waikato': (-37.80, 175.30), 'CA|Canso': (45.34, -61.00), 'GB|Shetland Islands': (60.35, -1.28)}


def main(src):
    src = Path(src)
    admin1 = {}
    for line in (src / 'admin1CodesASCII.txt').read_text(encoding='utf-8').splitlines():
        code, name, ascii_name, _ = line.split('\t')
        admin1[code] = fold(ascii_name)
    by_name = {}   # (country, folded name) -> [(population, lat, lon, admin1 name, display name)]
    for line in (src / 'cities1000.txt').read_text(encoding='utf-8').splitlines():
        f = line.split('\t')
        cc, a1 = f[8], admin1.get(f[8] + '.' + f[10], '')
        rec = (int(f[14] or 0), float(f[4]), float(f[5]), a1, f[1])
        for n in {f[1], f[2], *f[3].split(',')}:
            k = fold(n)
            if k:
                by_name.setdefault((cc, k), []).append(rec)
    # the aliases of each gazetteer city, as written in tools/geo.py
    aliases = {}
    for alias, (city, state, cc) in geo._CITY_ALIAS.items():
        aliases.setdefault((cc, city), set()).add(alias)
    out, missed = {}, []
    for (cc, city), state in sorted(geo.CITY.items()):
        names = {city} | aliases.get((cc, city), set())
        want = fold(state)
        cands = []
        for n in names:
            cands += by_name.get((cc, fold(n)), [])
        # the first-level division must agree when both sides name one (state names differ in spelling: Baden-Wuerttemberg and the like)
        agree = [c for c in cands if not want or not c[3] or c[3] == want or want in c[3] or c[3] in want]
        pool = agree or ([] if want and cc in ('US', 'CA', 'AU', 'GB') else cands)
        if not pool:
            missed.append(f'{cc}|{state}|{city}')
            continue
        best = max(pool, key=lambda c: c[0])
        out[f'{cc}|{city}'] = [round(best[1], 2), round(best[2], 2)]
    for k, v in MANUAL.items():
        if k not in out:
            out[k] = list(v)
    missed = [m for m in missed if m.split('|')[0] + '|' + m.split('|')[2] not in out]
    dest = Path(__file__).parent / 'geo_coords.json'
    dest.write_text(json.dumps(out, ensure_ascii=False, sort_keys=True, separators=(',', ':')), encoding='utf-8')
    print(f'{len(out)} of {len(geo.CITY)} gazetteer cities located; wrote {dest}')
    if missed:
        print('not located:', '; '.join(missed[:60]), '...' if len(missed) > 60 else '')


if __name__ == '__main__':
    main(sys.argv[1])
