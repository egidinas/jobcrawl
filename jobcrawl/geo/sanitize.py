"""Canonical places for crawled positions. Runs after every crawl cycle (crawler/run.mjs, step "geo"), so new positions are sanitized when they arrive.

    python -m jobcrawl.geo.sanitize --data <crawl data dir>

Reads <data>/scan-history.tsv (all open and new rows) and writes:
  <data>/places.json    {raw location text: {"label", "places": [[city, state, country], ...], "level", "remote"}}  one entry per distinct text,
                        so a cycle only resolves texts it has not seen; delete the file to re-resolve everything (after a gazetteer change)
  <data>/last-new.json  each new row gets "place" (the canonical label) and "places"; other fields are untouched
The label rules and the gazetteer (GeoNames, gazetteer.tsv.gz next to this file) are those of jobcrawl.geo.geo; the board build
(jobcrawl/board.py) uses the same code, so the crawl output and the board always agree. Nothing here calls a network service.
"""
import argparse
import csv
import json
import sys
from pathlib import Path

from jobcrawl.geo import geo


def entry(raw):
    g = geo.resolve(raw if raw.strip().lower() != 'unspecified' else '')
    return {'label': geo.display(g), 'places': [[p['city'], p['state'], p['country']] for p in g['places']], 'level': g['level'], 'remote': g['remote']}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    a = ap.parse_args()
    data = Path(a.data)
    cache_path = data / 'places.json'
    cache = json.loads(cache_path.read_text(encoding='utf-8')) if cache_path.exists() else {}
    hist = data / 'scan-history.tsv'
    if not hist.exists():
        print('geo: no scan-history.tsv, nothing to do')
        return 0
    texts = set()
    with open(hist, encoding='utf-8', newline='') as fh:
        for r in csv.DictReader(fh, delimiter='\t'):
            if r.get('status') in ('open', 'dup') and r.get('location'):
                texts.add(r['location'])
    new = [t for t in texts if t not in cache]
    for t in new:
        cache[t] = entry(t)
    live = {t: cache[t] for t in texts | set(cache) if t in cache and (t in texts)}   # keep the cache to texts that are still open
    cache_path.write_text(json.dumps(live, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    fresh = data / 'last-new.json'
    tagged = 0
    if fresh.exists():
        d = json.loads(fresh.read_text(encoding='utf-8'))
        for row in d.get('rows', []):
            e = live.get(row.get('location', '')) or entry(row.get('location', ''))
            row['place'], row['places'] = e['label'], e['places']
            tagged += 1
        fresh.write_text(json.dumps(d, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    coarse = sum(1 for t in texts if live[t]['level'] in ('none', 'continent'))
    print(f'geo: {len(texts)} distinct location texts ({len(new)} new), {coarse} without a place, {tagged} new positions tagged')
    return 0


if __name__ == '__main__':
    sys.exit(main())
