"""Profile loader: <profile dir>/profile.json -> a plain dict with every key filled in from its default.

    from jobcrawl.profile import load_profile
    p = load_profile("profiles/aerospace")        # a folder, or the profile.json file itself

Every key, its type and its default: profiles/schema.md. Errors raise ProfileError with the key that is wrong, e.g.
"profiles/x/profile.json: fields[2].keywords[0]: expected a string, got int". Standard library only.

The loader does not read the files the profile names (companies.json, labels.json, the statements and personas are inside
profile.json itself); it checks that the regular expressions compile. The loader adds one key of its own: "_dir", the
absolute profile folder, so that paths such as crawl.companies_file can be resolved by the caller.
"""
import copy
import json
import os
import re

LANGS = ('en', 'de')
ID_RE = re.compile(r'^[a-z][a-z0-9_]*$')

# Title rules for the board's seniority bands (levels). First matching pattern wins, in list order; the band whose pattern is
# None is the default. "rank" orders the filter (lowest first). These are the bands of the reference board.
DEFAULT_LEVELS = [
    {'code': 'student', 'rank': 0, 'label': {'en': 'Student & intern', 'de': 'Student & Praktikum'},
     'pattern': r'\b(intern(ship)?|praktik\w*|werkstudent\w*|working student|thesis|abschlussarbeit|bachelorarbeit|masterarbeit|'
                r'trainee|apprentice\w*|ausbildung|azubi|duales studium|dual student|student)\b'},
    {'code': 'lead', 'rank': 4, 'label': {'en': 'Lead & management', 'de': 'Leitung & Management'},
     # "management" alone is a field ("Quality Management Engineer"), not a rank; -leiter words that are things (Halbleiter,
     # Leiterplatte) and "lead" in lead-free / lead time are not leaders; German compounds (Projektmanager) are like "Project Manager"
     'pattern': r'\b(head of|director|vp|vice president|chief|cto|coo|ceo|manager|\w+manager(?:in)?|'
                r'(?!\w*(?:halb|supra|ab|blitz|strom|wärme|licht|isolier|über)leiter)(?!leiter(?:platt|bahn|techn|werkstoff|material))\w*leiter\w*|'
                r'team ?lead\w*|'
                r'lead(?![\s-]+(?:free|times?|generation|gen|qualification|scoring|nurturing|magnet\w*|conversion|sources?|capture|lists?|pipeline)\b)|'
                r'principal investigator|general manager|geschäftsführ\w*)\b'},
    {'code': 'senior', 'rank': 3, 'label': {'en': 'Senior & principal', 'de': 'Senior & Principal'},
     'pattern': r'\b(senior|sr\.?|principal|staff|expert\w*|experte|architect|fellow)\b'},
    {'code': 'entry', 'rank': 1, 'label': {'en': 'Entry level', 'de': 'Berufseinstieg'},
     'pattern': r'\b(junior|jr\.?|graduate|entry[- ]level|berufseinsteiger\w*|absolvent\w*|early career|associate)\b'},
    {'code': 'mid', 'rank': 2, 'label': {'en': 'Engineer & specialist', 'de': 'Ingenieur & Fachkraft'}, 'pattern': None},
]

DEFAULT_SCOPES = [{'id': 'worldwide', 'label': {'en': 'Worldwide', 'de': 'Weltweit'}, 'match': {'any': True}}]

DEFAULT_MAP = {'k': 15, 'layout_k': 45, 'min_dist': 0.25, 'even': 0.7, 'reps': 3, 'signature': 0.8, 'min_scope': 600,
               'labels_file': None, 'resolution': [1.6, 5.0]}
ACCENT_RE = re.compile(r'^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$')
DEFAULT_EMBED = {'model_repo': 'onnx-community/embeddinggemma-2-ONNX', 'prompt': 'search-query', 'max_tokens': 256, 'text_chars': 700}


class ProfileError(ValueError):
    """A profile that does not validate. The message starts with the file and names the key."""


class _Check:
    """Carries the file name and the dotted key path while validating."""

    def __init__(self, file):
        self.file = file

    def fail(self, path, msg):
        raise ProfileError(f'{self.file}: {path}: {msg}')

    def obj(self, v, path):
        if not isinstance(v, dict):
            self.fail(path, f'expected an object, got {_kind(v)}')
        return v

    def lst(self, v, path):
        if not isinstance(v, list):
            self.fail(path, f'expected a list, got {_kind(v)}')
        return v

    def text(self, v, path):
        if not isinstance(v, str):
            self.fail(path, f'expected a string, got {_kind(v)}')
        return v

    def boolean(self, v, path):
        if not isinstance(v, bool):
            self.fail(path, f'expected true or false, got {_kind(v)}')
        return v

    def integer(self, v, path, lo=None):
        if isinstance(v, bool) or not isinstance(v, int):
            self.fail(path, f'expected an integer, got {_kind(v)}')
        if lo is not None and v < lo:
            self.fail(path, f'must be at least {lo}, got {v}')
        return v

    def number(self, v, path, lo=None, hi=None):
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            self.fail(path, f'expected a number, got {_kind(v)}')
        if lo is not None and v < lo:
            self.fail(path, f'must be at least {lo}, got {v}')
        if hi is not None and v > hi:
            self.fail(path, f'must be at most {hi}, got {v}')
        return float(v)

    def strs(self, v, path):
        self.lst(v, path)
        for i, x in enumerate(v):
            self.text(x, f'{path}[{i}]')
        return list(v)

    def ident(self, v, path):
        self.text(v, path)
        if not ID_RE.match(v):
            self.fail(path, f'{v!r} is not an id: use lower case letters, digits and "_", starting with a letter')
        return v

    def regex(self, v, path, flags=0):
        self.text(v, path)
        try:
            re.compile(v, flags)
        except re.error as e:
            self.fail(path, f'does not compile as a regular expression ({e})')
        return v

    def label(self, v, path):
        """{en, de}: en required, de defaults to en."""
        self.obj(v, path)
        en = self.text(v.get('en'), f'{path}.en') if 'en' in v else self.fail(path, 'needs an "en" text')
        de = self.text(v['de'], f'{path}.de') if 'de' in v else en
        return {'en': en, 'de': de}

    def languages(self, v, path):
        self.lst(v, path)
        if not v:
            self.fail(path, 'needs at least one language')
        for i, x in enumerate(v):
            if x not in LANGS:
                self.fail(f'{path}[{i}]', f'{x!r} is not a language (use one of {", ".join(LANGS)})')
        return list(v)


def _kind(v):
    return {bool: 'bool', int: 'int', float: 'float', str: 'string', list: 'list', dict: 'object', type(None): 'null'}.get(type(v), type(v).__name__)


def _ids_unique(check, items, path, key='id'):
    seen = set()
    for i, it in enumerate(items):
        if it[key] in seen:
            check.fail(f'{path}[{i}].{key}', f'{it[key]!r} is listed twice')
        seen.add(it[key])


def _scope(check, s, path):
    check.obj(s, path)
    out = {'id': check.ident(s.get('id'), f'{path}.id') if 'id' in s else check.fail(path, 'needs an "id"'),
           'label': check.label(s.get('label'), f'{path}.label') if 'label' in s else check.fail(path, 'needs a "label"')}
    m = check.obj(s.get('match'), f'{path}.match') if 'match' in s else check.fail(path, 'needs a "match"')
    mp = f'{path}.match'
    extra = set(m) - {'any', 'continent', 'country', 'admin1'}
    if extra:
        check.fail(mp, f'unknown key {sorted(extra)[0]!r} (use any, continent, country or country + admin1)')
    if 'any' in m:
        if set(m) != {'any'} or m['any'] is not True:
            check.fail(mp, 'the "any" form is exactly {"any": true}')
        out['match'] = {'any': True}
    elif 'continent' in m:
        if set(m) != {'continent'}:
            check.fail(mp, 'the "continent" form is exactly {"continent": "EU"}')
        out['match'] = {'continent': check.text(m['continent'], f'{mp}.continent')}
    elif 'country' in m:
        out['match'] = {'country': check.text(m['country'], f'{mp}.country')}
        if 'admin1' in m:
            out['match']['admin1'] = check.text(m['admin1'], f'{mp}.admin1')
    elif 'admin1' in m:
        check.fail(mp, '"admin1" needs "country" next to it (e.g. {"country": "DE", "admin1": "Bavaria"})')
    else:
        check.fail(mp, 'needs one of "any": true, "continent", "country" (optionally with "admin1")')
    return out


def _field(check, f, path):
    check.obj(f, path)
    out = {'id': check.ident(f.get('id'), f'{path}.id') if 'id' in f else check.fail(path, 'needs an "id"'),
           'label': check.label(f.get('label'), f'{path}.label') if 'label' in f else check.fail(path, 'needs a "label"'),
           'keywords': check.strs(f.get('keywords', []), f'{path}.keywords'),
           'company_keywords': check.strs(f.get('company_keywords', []), f'{path}.company_keywords'),
           'pillar': check.boolean(f.get('pillar', False), f'{path}.pillar')}
    # the text the board writes into a role's tags (tg) and the web app shows the label for: the id, unless the board uses names
    out['tag'] = check.text(f['tag'], f'{path}.tag') if f.get('tag') is not None else out['id']
    for i, k in enumerate(out['keywords']):
        if k.strip() in ('', 'word:'):
            check.fail(f'{path}.keywords[{i}]', 'empty keyword')
    return out


def _level(check, b, path):
    check.obj(b, path)
    code = check.ident(b.get('code'), f'{path}.code') if 'code' in b else check.fail(path, 'needs a "code"')
    pattern = b.get('pattern')
    if pattern is not None:
        check.regex(pattern, f'{path}.pattern', re.I)
    return {'code': code, 'rank': check.integer(b.get('rank', 0), f'{path}.rank'),
            'label': check.label(b.get('label'), f'{path}.label') if 'label' in b else check.fail(path, 'needs a "label"'),
            'pattern': pattern}


def _domain(check, d, path):
    check.obj(d, path)
    pattern = d.get('pattern')
    if pattern is not None:
        check.regex(pattern, f'{path}.pattern', re.I)
    return {'id': check.ident(d.get('id'), f'{path}.id'), 'en': check.text(d.get('en', ''), f'{path}.en'), 'de': check.text(d.get('de', ''), f'{path}.de'),
            'hue': check.integer(d.get('hue', 0), f'{path}.hue'), 'color': check.text(d.get('color', ''), f'{path}.color'), 'pattern': pattern,
            'fallback': bool(d.get('fallback')), 'tags': [t.lower() for t in check.strs(d.get('tags', []), f'{path}.tags')]}


def _accent(check, v, path):
    check.text(v, path)
    if not ACCENT_RE.match(v):
        check.fail(path, f'{v!r} is not a hex colour (use #rgb or #rrggbb)')
    return v


def _links(check, v, path):
    """{"reference": [{"label": text, "url": http or https link}]}: the web app's footer, nothing else reads it."""
    check.obj(v, path)
    unknown = set(v) - {'reference'}
    if unknown:
        check.fail(path, f'unknown key {sorted(unknown)[0]!r} (only "reference")')
    out = {'reference': []}
    for i, item in enumerate(check.lst(v.get('reference', []), f'{path}.reference')):
        ip = f'{path}.reference[{i}]'
        check.obj(item, ip)
        label = check.text(item['label'], f'{ip}.label') if 'label' in item else check.fail(ip, 'needs a "label"')
        url = check.text(item['url'], f'{ip}.url') if 'url' in item else check.fail(ip, 'needs a "url"')
        if not re.match(r'^https?://\S+$', url):
            check.fail(f'{ip}.url', f'{url!r} is not an http or https link')
        out['reference'].append({'label': label, 'url': url})
    return out


WEB_STORAGE_KEYS = ('prefix', 'lang', 'model_cache', 'profile_kind', 'profile_file')
WEB_TEXT_KEYS = ('role_url', 'company_url', 'company_texts', 'default_scope', 'model_url', 'atlas_maps')


def _web(check, v, path, scope_ids):
    """The web app's site settings (config.json): link templates, default scope, model folder, browser storage names. All optional."""
    check.obj(v, path)
    unknown = set(v) - set(WEB_TEXT_KEYS) - {'storage'}
    if unknown:
        check.fail(path, f'unknown key {sorted(unknown)[0]!r} (use {", ".join(WEB_TEXT_KEYS + ("storage",))})')
    out = {k: check.text(v[k], f'{path}.{k}') for k in WEB_TEXT_KEYS if v.get(k) is not None}
    if 'role_url' in out and '{id}' not in out['role_url']:
        check.fail(f'{path}.role_url', 'needs the placeholder {id}, e.g. "job.html?id={id}"')
    if 'company_url' in out and '{slug}' not in out['company_url']:
        check.fail(f'{path}.company_url', 'needs the placeholder {slug}, e.g. "company-{slug}.html"')
    if 'default_scope' in out and out['default_scope'] not in scope_ids:
        check.fail(f'{path}.default_scope', f'{out["default_scope"]!r} is not one of the scopes ({", ".join(scope_ids)})')
    if 'atlas_maps' in out and out['atlas_maps'] not in ('worldwide', 'per_scope'):
        check.fail(f'{path}.atlas_maps', "use 'worldwide' (one map, filters hide what is outside) or 'per_scope' (a separate map per region filter)")
    st = check.obj(v.get('storage', {}), f'{path}.storage')
    unknown = set(st) - set(WEB_STORAGE_KEYS)
    if unknown:
        check.fail(f'{path}.storage', f'unknown key {sorted(unknown)[0]!r} (use {", ".join(WEB_STORAGE_KEYS)})')
    storage = {k: check.text(st[k], f'{path}.storage.{k}') for k in WEB_STORAGE_KEYS if st.get(k) is not None}
    if storage:
        out['storage'] = storage
    return out


def _board(check, v, path):
    """The board's settings (jobs-index.json, jobs.json): the order of the roles. All optional."""
    check.obj(v, path)
    order = check.text(v.get('order', 'first_seen'), f'{path}.order')
    if order not in ('first_seen', 'published'):
        check.fail(f'{path}.order', "use 'first_seen' (newest first by the day the crawler first saw a role) or 'published' (newest first by the posting date, or the first-seen day when the source gives none)")
    return {'order': order}


def _validate(raw, file):
    c = _Check(file)
    p = c.obj(raw, 'profile.json')
    out = {}
    out['name'] = c.text(p['name'], 'name') if 'name' in p else None
    out['title'] = c.text(p.get('title', ''), 'title')
    out['tagline'] = c.text(p.get('tagline', ''), 'tagline')
    out['languages'] = c.languages(p['languages'], 'languages') if 'languages' in p else ['en']
    out['data_dir'] = c.text(p['data_dir'], 'data_dir') if p.get('data_dir') is not None else None
    out['companies_catalogue'] = c.text(p['companies_catalogue'], 'companies_catalogue') if p.get('companies_catalogue') is not None else None
    out['functions_file'] = c.text(p['functions_file'], 'functions_file') if p.get('functions_file') is not None else None   # classify/functions.py
    out['domains'] = [_domain(c, d, f'domains[{i}]') for i, d in enumerate(c.lst(p.get('domains', []), 'domains'))]   # classify/domains.py
    _ids_unique(c, out['domains'], 'domains')
    out['accent'] = _accent(c, p['accent'], 'accent') if p.get('accent') is not None else None
    out['links'] = _links(c, p.get('links', {}), 'links')

    crawl = c.obj(p.get('crawl', {}), 'crawl')
    rel = c.obj(crawl.get('relevance', {}), 'crawl.relevance')
    out['crawl'] = {
        'companies_file': c.text(crawl.get('companies_file', 'companies.json'), 'crawl.companies_file'),
        'catalogue_file': c.text(crawl['catalogue_file'], 'crawl.catalogue_file') if crawl.get('catalogue_file') is not None else None,
        'relevance': {
            'keywords': c.strs(rel.get('keywords', []), 'crawl.relevance.keywords'),
            'negative': c.strs(rel.get('negative', []), 'crawl.relevance.negative'),
            'ssic_deeptech': c.strs(rel.get('ssic_deeptech', []), 'crawl.relevance.ssic_deeptech'),
        },
        'title_filter': c.obj(crawl['title_filter'], 'crawl.title_filter') if crawl.get('title_filter') is not None else None,
        'location_filter': c.obj(crawl['location_filter'], 'crawl.location_filter') if crawl.get('location_filter') is not None else None,
    }

    scopes = [_scope(c, s, f'scopes[{i}]') for i, s in enumerate(c.lst(p['scopes'], 'scopes'))] if 'scopes' in p else copy.deepcopy(DEFAULT_SCOPES)
    if not scopes:
        c.fail('scopes', 'needs at least one scope')
    _ids_unique(c, scopes, 'scopes')
    out['scopes'] = scopes

    fields = [_field(c, f, f'fields[{i}]') for i, f in enumerate(c.lst(p.get('fields', []), 'fields'))]
    _ids_unique(c, fields, 'fields')
    out['fields'] = fields
    out['max_field_tags'] = c.integer(p.get('max_field_tags', 5), 'max_field_tags', 1)

    levels = [_level(c, b, f'levels[{i}]') for i, b in enumerate(c.lst(p['levels'], 'levels'))] if 'levels' in p else copy.deepcopy(DEFAULT_LEVELS)
    _ids_unique(c, levels, 'levels', key='code')
    if sum(1 for b in levels if b['pattern'] is None) != 1:
        c.fail('levels', 'needs exactly one band with "pattern": null (the default band)')
    out['levels'] = levels
    out['web'] = _web(c, p.get('web', {}), 'web', [x['id'] for x in scopes])
    out['board'] = _board(c, p.get('board', {}), 'board')

    stm = []
    for i, s in enumerate(c.lst(p.get('statements', []), 'statements')):
        sp = f'statements[{i}]'
        c.obj(s, sp)
        stm.append({'id': c.ident(s.get('id'), f'{sp}.id') if 'id' in s else c.fail(sp, 'needs an "id"'),
                    'a': c.label(s.get('a'), f'{sp}.a') if 'a' in s else c.fail(sp, 'needs "a"'),
                    'b': c.label(s.get('b'), f'{sp}.b') if 'b' in s else c.fail(sp, 'needs "b"'),
                    'a_regex': c.regex(s.get('a_regex'), f'{sp}.a_regex', re.I) if 'a_regex' in s else c.fail(sp, 'needs "a_regex"'),
                    'b_regex': c.regex(s.get('b_regex'), f'{sp}.b_regex', re.I) if 'b_regex' in s else c.fail(sp, 'needs "b_regex"')})
    _ids_unique(c, stm, 'statements')
    out['statements'] = stm

    pers = []
    for i, s in enumerate(c.lst(p.get('personas', []), 'personas')):
        sp = f'personas[{i}]'
        c.obj(s, sp)
        flags = c.text(s.get('flags', 'i'), f'{sp}.flags')
        if not set(flags) <= set('imsu') or len(set(flags)) != len(flags):
            c.fail(f'{sp}.flags', f'{flags!r}: use letters from "imsu" (JavaScript flags), each once')
        pers.append({'id': c.ident(s.get('id'), f'{sp}.id') if 'id' in s else c.fail(sp, 'needs an "id"'),
                     'label': c.label(s.get('label'), f'{sp}.label') if 'label' in s else c.fail(sp, 'needs a "label"'),
                     'regex': c.regex(s.get('regex'), f'{sp}.regex', re.I if 'i' in flags else 0) if 'regex' in s else c.fail(sp, 'needs "regex"'),
                     'flags': flags})
    _ids_unique(c, pers, 'personas')
    out['personas'] = pers

    gl = []
    for i, pair in enumerate(c.lst(p.get('glossary', []), 'glossary')):
        if not (isinstance(pair, list) and len(pair) == 2 and all(isinstance(x, str) for x in pair)):
            c.fail(f'glossary[{i}]', 'expected a pair of strings [en, de]')
        gl.append([pair[0], pair[1]])
    out['glossary'] = gl

    m = c.obj(p.get('map', {}), 'map')
    mo = dict(DEFAULT_MAP)
    mo['k'] = c.integer(m.get('k', DEFAULT_MAP['k']), 'map.k', 2)
    mo['layout_k'] = c.integer(m.get('layout_k', DEFAULT_MAP['layout_k']), 'map.layout_k', 2)
    mo['min_dist'] = c.number(m.get('min_dist', DEFAULT_MAP['min_dist']), 'map.min_dist', 0)
    mo['even'] = c.number(m.get('even', DEFAULT_MAP['even']), 'map.even', 0, 1)
    mo['reps'] = c.integer(m.get('reps', DEFAULT_MAP['reps']), 'map.reps', 1)
    mo['signature'] = c.number(m.get('signature', DEFAULT_MAP['signature']), 'map.signature', 0, 1)
    mo['min_scope'] = c.integer(m.get('min_scope', DEFAULT_MAP['min_scope']), 'map.min_scope', 0)
    mo['labels_file'] = c.text(m['labels_file'], 'map.labels_file') if m.get('labels_file') is not None else None
    res = c.lst(m.get('resolution', DEFAULT_MAP['resolution']), 'map.resolution')
    if len(res) != 2:
        c.fail('map.resolution', 'needs two numbers: [coarse, fine]')
    mo['resolution'] = [c.number(res[0], 'map.resolution[0]', 0), c.number(res[1], 'map.resolution[1]', 0)]
    out['map'] = mo

    e = c.obj(p.get('embed', {}), 'embed')
    out['embed'] = {
        'model_repo': c.text(e.get('model_repo', DEFAULT_EMBED['model_repo']), 'embed.model_repo'),
        'prompt': c.text(e.get('prompt', DEFAULT_EMBED['prompt']), 'embed.prompt'),
        'max_tokens': c.integer(e.get('max_tokens', DEFAULT_EMBED['max_tokens']), 'embed.max_tokens', 0),
        'text_chars': c.integer(e.get('text_chars', DEFAULT_EMBED['text_chars']), 'embed.text_chars', 0),
    }
    return out


def profile_file(path):
    """A profile folder or its profile.json -> (folder, file)."""
    path = os.path.abspath(path)
    if os.path.isdir(path):
        return path, os.path.join(path, 'profile.json')
    return os.path.dirname(path), path


def load_profile(path):
    """Loads and validates a profile. Raises ProfileError (bad content) or OSError (no file)."""
    folder, file = profile_file(path)
    try:
        with open(file, encoding='utf-8') as fh:
            raw = json.load(fh)
    except ValueError as e:
        raise ProfileError(f'{file}: not valid JSON ({e})')
    out = _validate(raw, file)
    if out['name'] is None:
        out['name'] = os.path.basename(folder)
    out['_dir'] = folder
    return out
