"""Build gazetteer.tsv.gz (next to this file), the place-name table behind jobcrawl/geo/geo.py, from GeoNames (CC BY 4.0, https://www.geonames.org).

Build time only: nothing here is shipped to the browser or called while crawling.

    # once: download into <dir>   (cities5000.zip, cities500.zip, admin1CodesASCII.txt from https://download.geonames.org/export/dump/)
    python -m jobcrawl.geo.build_gazetteer --dir <dir>

Kept: every place of 5,000+ inhabitants worldwide, plus every place of 500+ in the countries the board cares about most (DE AT CH LI LU SG).
Columns: ascii_name, name, country, admin1 (ASCII), population, lat, lon. Alternate names are left out on purpose: GeoNames mixes historical and
other-language names into them (Lemont, IL lists "Athens" and "Palmyra"); German and English spellings live in the hand tables of jobcrawl/geo/geo.py.
"""
import argparse, csv, gzip, io, unicodedata, zipfile
from pathlib import Path

DENSE = {'DE', 'AT', 'CH', 'LI', 'LU', 'SG'}
OUT = Path(__file__).resolve().parent / 'gazetteer.tsv.gz'


def fold(s):
    return unicodedata.normalize('NFKD', s.replace('ß', 'ss')).encode('ascii', 'ignore').decode('ascii').lower()


def rows(zpath):
    with zipfile.ZipFile(zpath) as z:
        name = next(n for n in z.namelist() if n.endswith('.txt') and 'readme' not in n.lower())
        for line in io.TextIOWrapper(z.open(name), encoding='utf-8'):
            yield line.rstrip('\n').split('\t')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', required=True)
    a = ap.parse_args()
    d = Path(a.dir)
    admin1 = {}
    for line in open(d / 'admin1CodesASCII.txt', encoding='utf-8'):
        code, name, *_ = line.rstrip('\n').split('\t')
        admin1[code] = name
    seen, out = set(), []
    for zname, keep in (('cities5000.zip', lambda cc: True), ('cities500.zip', lambda cc: cc in DENSE)):
        for r in rows(d / zname):
            gid, name, ascii_name, alts, lat, lon, fclass, fcode, cc, _cc2, a1 = r[:11]
            pop = int(r[14] or 0)
            if gid in seen or not keep(cc) or fclass != 'P':
                continue
            seen.add(gid)
            out.append((ascii_name, name, cc, admin1.get(f'{cc}.{a1}', ''), pop, round(float(lat), 3), round(float(lon), 3)))
    out.sort(key=lambda r: (-r[4], r[0]))
    with gzip.open(OUT, 'wt', encoding='utf-8', newline='') as fh:
        w = csv.writer(fh, delimiter='\t', lineterminator='\n')
        w.writerows(out)
    print(f'{len(out)} places -> {OUT} ({OUT.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
