"""The board: a catalog (crawler/catalog.mjs output) -> the static files the web app reads.

    jobs-index.json     [[id, title, company, url, company_slug], ...]            newest first
    jobs-desc-XX.json   {id: {t, c, cs, u, l, r, sc, lv, d, tg, x}, ...}           XX = first two hex digits of the id (256 shards)
    jobs.json           the first 500 roles of the order above, each with its id

id = first 8 hex digits of sha1(url), as in the reference board. t title, c company, cs company slug, u posting URL,
l location text as the posting gives it, r region label (country of the first place, else the narrowest scope),
sc scope ids (profile order), lv seniority band code, d published date (the source's posted date, YYYY-MM-DD; the first-seen
day when the source gives none), fs first-seen date (YYYY-MM-DD), tg field ids, x description text.

Order: newest first by fs, then company and title; with board.order 'published', newest first by d. Standard library only,
plus the geo module (also standard library).
"""
import datetime
import hashlib
import json
import os
import re

from jobcrawl.classify.fields import field_matchers, field_tags, fold
from jobcrawl.classify.levels import compile_levels, level_of
from jobcrawl.classify.scopes import region_label, scope_ids
from jobcrawl.geo import geo

FEED_SIZE = 500
ORDERS = ('first_seen', 'published')                           # board.order: the sort key of jobs-index.json and jobs.json
DATE = re.compile(r'\d{4}-\d{2}-\d{2}')


class BoardError(ValueError):
    pass


def role_id(url):
    return hashlib.sha1(url.encode('utf-8')).hexdigest()[:8]


def company_slug(company):
    """Lower-case ASCII slug of the employer name without a trailing "(via X)"."""
    name = re.sub(r'\s*\(via [^)]*\)\s*$', '', company or '').strip().lower()
    name = re.sub(r'[^a-z0-9]+', '-', fold(name.replace('ß', 'ss')))
    return name.strip('-')


def _day(s):
    """s cut to 10 characters when it is a real YYYY-MM-DD date, else ''."""
    s = str(s or '').strip()[:10]
    if not DATE.fullmatch(s):
        return ''
    try:
        datetime.date.fromisoformat(s)
    except ValueError:
        return ''
    return s


def read_catalog(path):
    """The catalog's items: a list, or an object with an "items" list."""
    with open(path, encoding='utf-8') as fh:
        raw = json.load(fh)
    if isinstance(raw, dict) and isinstance(raw.get('items'), list):
        raw = raw['items']
    if not isinstance(raw, list):
        raise BoardError(f'{path}: expected a list of roles (crawler/catalog.mjs output)')
    return raw


def _roles(items):
    """Usable items (url and title), one per url, the first occurrence wins."""
    seen, out = set(), []
    for it in items:
        url = str(it.get('url') or '').strip()
        title = str(it.get('title') or '').strip()
        if not url or not title or url in seen:
            continue
        seen.add(url)
        out.append((it, url, title))
    return out


def build_entries(items, profile, excerpt=None):
    """[(id, entry)] for the catalog items, newest first (by fs, or by d when board.order is 'published')."""
    order = profile.get('board', {}).get('order', 'first_seen')
    if order not in ORDERS:
        raise BoardError(f'board.order {order!r} is not one of {", ".join(ORDERS)}')
    fields = profile['fields']
    matchers = field_matchers(fields)
    levels = compile_levels(profile['levels'])
    max_tags = profile['max_field_tags']
    entries = []
    for it, url, title in _roles(items):
        company = str(it.get('company') or '').strip()
        location = str(it.get('location') or '').strip()
        text = str(it.get('description') or '')
        if excerpt is not None:
            text = text[:excerpt]
        g = geo.resolve(location if location.lower() not in ('', 'unspecified') else '')
        places = [dict(p) for p in g['places']]
        first_seen = str(it.get('first_seen') or '').strip()[:10]
        posted = _day(it.get('posted'))
        entries.append((role_id(url), {
            't': title,
            'c': company,
            'cs': company_slug(company),
            'u': url,
            'l': '' if location.lower() == 'unspecified' else location,
            'r': region_label(places, profile['scopes'], 'en'),
            'sc': scope_ids(places, profile['scopes']),
            'lv': level_of(title, levels),
            'd': posted or first_seen,
            'fs': first_seen,
            'tg': field_tags(title, text, company, fields, max_tags, matchers),
            'x': text,
        }))
    entries.sort(key=lambda e: (e[1]['c'].lower(), e[1]['t'].lower()))
    entries.sort(key=lambda e: e[1]['d' if order == 'published' else 'fs'], reverse=True)
    ids = {}
    for rid, e in entries:
        if rid in ids:
            raise BoardError(f'role id collision on {rid}: {ids[rid]} and {e["u"]}; lengthen role_id()')
        ids[rid] = e['u']
    return entries


def _dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':')) + '\n'


def write_board(entries, out_dir):
    """Writes jobs-index.json, the jobs-desc shards and jobs.json into out_dir. Removes shards that no role fills any more."""
    os.makedirs(out_dir, exist_ok=True)
    index = [[rid, e['t'], e['c'], e['u'], e['cs']] for rid, e in entries]
    _write(os.path.join(out_dir, 'jobs-index.json'), _dump(index))
    shards = {}
    for rid, e in entries:
        shards.setdefault(rid[:2], {})[rid] = e
    written = set()
    for prefix, shard in sorted(shards.items()):
        name = f'jobs-desc-{prefix}.json'
        _write(os.path.join(out_dir, name), _dump(shard))
        written.add(name)
    for name in os.listdir(out_dir):
        if re.match(r'^jobs-desc-[0-9a-f]{2}\.json$', name) and name not in written:
            os.remove(os.path.join(out_dir, name))
    feed = [dict(id=rid, **e) for rid, e in entries[:FEED_SIZE]]
    _write(os.path.join(out_dir, 'jobs.json'), _dump(feed))
    return {'roles': len(entries), 'shards': len(shards), 'feed': len(feed)}


def _write(path, text):
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(text)


def build(profile, catalog_path, out_dir, excerpt=None):
    """Catalog file -> board files. Returns the counts written."""
    entries = build_entries(read_catalog(catalog_path), profile, excerpt)
    return write_board(entries, out_dir)
