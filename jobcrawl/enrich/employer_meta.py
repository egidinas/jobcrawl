"""Facts about the employers themselves, from sources that are public and licensed for reuse; nothing is typed by hand.

    python -m jobcrawl.enrich.employer_meta [--registry crawler/registry/companies.jsonl] [--out crawler/registry/employer-meta.json] [--only-hiring] [--limit N] [--no-web] [--no-wikidata]

Sources (every field is {v, src, conf, ts}):
  site       the company's own home page: JSON-LD Organization (legal name, description, founding date, employees, address, sameAs links, logo) and the head tags.
             robots.txt is honoured, one GET per domain, identifying User-Agent.
  ats-board  the employer text its applicant-tracking board publishes (Greenhouse board name and about text, Workable account description).
  wikidata   CC0 statements found by the company's website: inception, employees, headquarters, country, industry, legal form, parent, LEI, ticker.
Cached by company, refetched after --max-age days, so a rerun only fetches what is new or stale. No personal data is read (contact e-mails and phone numbers are ignored).
"""
import argparse
import concurrent.futures as cf
from datetime import date
import html
import json
import os
from pathlib import Path
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
import urllib.robotparser

ctx = ssl.create_default_context()
UA = 'jobcrawl-research/0.1 (+https://github.com/egidinas/jobcrawl; builds short company profiles from public pages)'
TODAY = date.today().isoformat()
GENERIC_SUFFIX = re.compile(r'\b(gmbh|ag|se|kg|ug|llc|inc|corp|corporation|ltd|limited|holdings?|group|co)\b', re.I)


def norm_name(n):
    n = re.sub(r'\(via[^)]*\)', '', (n or '').lower())
    return re.sub(r'[^a-z0-9]', '', GENERIC_SUFFIX.sub('', n))


def dom(u):
    return re.sub(r'^www\.', '', re.sub(r'^https?://', '', (u or '').strip().lower()).split('/')[0])


def clean(x):
    return html.unescape(re.sub(r'\s+', ' ', x or '')).strip()


def get(url, timeout=12, maxb=600000):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en,de;q=0.8'})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        ct = r.headers.get('Content-Type', '')
        if 'html' not in ct and 'text' not in ct:
            return None
        return r.read(maxb).decode(r.headers.get_content_charset() or 'utf-8', 'ignore')


def allowed(base):
    try:
        rp = urllib.robotparser.RobotFileParser()
        rp.parse((get(base + '/robots.txt', 8, 100000) or '').splitlines())
        return rp.can_fetch(UA, base + '/')
    except Exception:
        return True


def metas(h):
    out = {}
    for m in re.finditer(r'<meta\s+([^>]+)>', h, re.I):
        a = dict((k.lower(), clean(v)) for k, _, v in re.findall(r'([\w:-]+)\s*=\s*(["\'])(.*?)\2', m.group(1), re.S))
        key = (a.get('name') or a.get('property') or a.get('itemprop') or '').lower()
        val = a.get('content', '')
        if key in (
            'keywords', 'description', 'og:type', 'og:site_name', 'og:title', 'og:description',
            'article:tag', 'application-name', 'twitter:description', 'twitter:title', 'classification',
            'category', 'subject', 'topic', 'dc.subject', 'dc.description', 'dc.type', 'news_keywords',
            'author', 'og:locale', 'geo.region', 'business:contact_data:country_name'
        ) and val:
            out.setdefault(key, val)
    return out


def f(v, src, conf):
    return {'v': v, 'src': src, 'conf': conf, 'ts': TODAY}


def plain(h):
    return html.unescape(re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', h or ''))).strip()


def jget(url, timeout=20, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers={'User-Agent': UA, 'Accept': 'application/json', **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        return json.loads(r.read(2_000_000).decode('utf-8', 'ignore'))


def org_nodes(h):
    """All JSON-LD organisation-like nodes of a page, with the fields this registry wants."""
    out = []
    for m in re.finditer(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', h, re.I | re.S):
        try:
            d = json.loads(m.group(1).strip())
        except Exception:
            continue
        stack = [d]
        while stack:
            x = stack.pop()
            if isinstance(x, list):
                stack += x
            elif isinstance(x, dict):
                if '@graph' in x:
                    stack += x['@graph']
                t = x.get('@type')
                t = t if isinstance(t, list) else [t]
                if any(isinstance(y, str) and re.search(r'Organi[sz]ation|Corporation|Company|Manufacturer|ResearchOrganization|EducationalOrganization|GovernmentOrganization|NGO', y) for y in t):
                    out.append(x)
    return out


def num(v):
    if isinstance(v, dict):
        v = v.get('value') or v.get('maxValue') or v.get('minValue')
    try:
        return int(str(v).replace(',', '').split('-')[-1].strip())
    except Exception:
        return None


def from_site(domain):
    res, base = {}, None
    for b in (f'https://{domain}', f'https://www.{domain}'):
        try:
            if not allowed(b):
                return {}, 'robots'
            h = get(b + '/')
            if h:
                base = b
                break
        except Exception:
            continue
    if not base:
        return {}, 'unreachable'
    mt = metas(h)
    if mt.get('og:site_name'):
        res['brand_name'] = f(mt['og:site_name'][:120], 'site:og', 0.6)
    desc = mt.get('description') or mt.get('og:description')
    if desc:
        res['description'] = f(clean(desc)[:600], 'site:meta', 0.7)
    if mt.get('keywords'):
        res['keywords'] = f([k.strip() for k in mt['keywords'].split(',') if k.strip()][:15], 'site:meta', 0.6)
    nodes = org_nodes(h)
    for n in nodes[:3]:
        if n.get('legalName') and 'legal_name' not in res:
            res['legal_name'] = f(str(n['legalName'])[:160], 'site:jsonld', 0.85)
        if n.get('description') and len(str(n['description'])) > 40:
            res['description'] = f(clean(str(n['description']))[:600], 'site:jsonld', 0.85)
        if n.get('foundingDate'):
            y = re.match(r'(\d{4})', str(n['foundingDate']))
            if y:
                res.setdefault('founded', f(int(y.group(1)), 'site:jsonld', 0.85))
        e = num(n.get('numberOfEmployees'))
        if e:
            res.setdefault('employees', f(e, 'site:jsonld', 0.7))
        a = n.get('address')
        a = a[0] if isinstance(a, list) and a else a
        if isinstance(a, dict):
            city = ', '.join(str(a[k]) for k in ('addressLocality', 'addressRegion') if a.get(k))
            ctry = a.get('addressCountry')
            ctry = ctry.get('name') if isinstance(ctry, dict) else ctry
            if city or ctry:
                res.setdefault('hq', f(', '.join(x for x in (city, str(ctry or '')) if x), 'site:jsonld', 0.8))
        sa = n.get('sameAs')
        sa = [sa] if isinstance(sa, str) else sa
        if sa:
            res.setdefault('links', f([u for u in sa if isinstance(u, str)][:8], 'site:jsonld', 0.8))
        k = n.get('knowsAbout') or n.get('keywords')
        if k and 'keywords' not in res:
            ks = k if isinstance(k, list) else str(k).split(',')
            res['keywords'] = f([clean(str(x)) for x in ks if x][:15], 'site:jsonld', 0.8)
        lg = n.get('logo')
        lg = lg.get('url') if isinstance(lg, dict) else lg
        if isinstance(lg, str) and lg.startswith('http'):
            res.setdefault('logo', f(lg, 'site:jsonld', 0.8))
    res['website'] = f(base + '/', 'site', 0.9)
    return res, 'ok'


def from_ats(crawl):
    prov, slug = (crawl or {}).get('provider'), (crawl or {}).get('slug')
    try:
        if prov == 'greenhouse' and slug:
            d = jget(f'https://boards-api.greenhouse.io/v1/boards/{slug}')
            out = {}
            if d.get('name'):
                out['brand_name'] = f(d['name'][:120], 'ats-board:greenhouse', 0.75)
            t = plain(d.get('content', ''))
            if len(t) > 40:
                out['description'] = f(t[:600], 'ats-board:greenhouse', 0.75)
            return out
        if prov == 'workable' and slug:
            d = jget(f'https://apply.workable.com/api/v1/widget/accounts/{slug}?details=false')
            out = {}
            if d.get('name'):
                out['brand_name'] = f(d['name'][:120], 'ats-board:workable', 0.75)
            t = plain(d.get('description', ''))
            if len(t) > 40:
                out['description'] = f(t[:600], 'ats-board:workable', 0.75)
            return out
    except Exception:
        return {}
    return {}


def wikidata(domains):
    """{domain: fields} for the domains Wikidata knows by official website (P856)."""
    out = {}
    doms = sorted(domains)
    for i in range(0, len(doms), 40):
        batch = doms[i:i + 40]
        vals = ' '.join(f'<{p}{d}{s}>' for d in batch for p in ('https://', 'http://', 'https://www.', 'http://www.') for s in ('/', ''))
        q = f'''SELECT ?site ?item ?itemLabel ?inc ?emp ?hqLabel ?cLabel ?indLabel ?formLabel ?parentLabel ?lei ?tick WHERE {{
  VALUES ?site {{ {vals} }}
  ?item wdt:P856 ?site .
  OPTIONAL {{ ?item wdt:P571 ?inc }} OPTIONAL {{ ?item wdt:P1128 ?emp }} OPTIONAL {{ ?item wdt:P159 ?hq }} OPTIONAL {{ ?item wdt:P17 ?c }}
  OPTIONAL {{ ?item wdt:P452 ?ind }} OPTIONAL {{ ?item wdt:P1454 ?form }} OPTIONAL {{ ?item wdt:P749 ?parent }} OPTIONAL {{ ?item wdt:P1278 ?lei }} OPTIONAL {{ ?item wdt:P249 ?tick }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,de". }} }}'''
        try:
            d = jget(
                'https://query.wikidata.org/sparql?format=json',
                data=urllib.parse.urlencode({'query': q}).encode(),
                headers={'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/sparql-results+json'},
                timeout=60
            )
        except Exception as e:
            print('wikidata batch failed', i, str(e)[:80], flush=True)
            time.sleep(5)
            continue
        for b in d['results']['bindings']:
            host = re.sub(r'^www\.', '', re.sub(r'^https?://', '', b['site']['value']).split('/')[0])
            r = out.setdefault(host, {'inds': set(), 'emps': []})
            g = lambda k: b.get(k, {}).get('value', '')
            r['qid'] = g('item').rsplit('/', 1)[-1]
            r['label'] = g('itemLabel')
            for k, key in (('inc', 'inc'), ('hqLabel', 'hq'), ('cLabel', 'country'), ('formLabel', 'form'), ('parentLabel', 'parent'), ('lei', 'lei'), ('tick', 'ticker')):
                if g(k):
                    r.setdefault(key, g(k))
            if g('indLabel'):
                r['inds'].add(g('indLabel'))
            if g('emp'):
                try:
                    r['emps'].append(int(float(g('emp'))))
                except ValueError:
                    pass
        time.sleep(2)
        print('wikidata', min(i + 40, len(doms)), '/', len(doms), flush=True)
    res = {}
    for host, r in out.items():
        x = {'wikidata_id': f(r['qid'], 'wikidata', 0.8)}
        if r.get('inc'):
            y = re.match(r'(\d{4})', r['inc'])
            if y and 1500 < int(y.group(1)) <= int(TODAY[:4]):
                x['founded'] = f(int(y.group(1)), 'wikidata', 0.7)
        if r['emps']:
            x['employees'] = f(max(r['emps']), 'wikidata', 0.6)
        if r.get('hq'):
            x['hq'] = f(r['hq'], 'wikidata', 0.7)
        if r.get('country'):
            x['country'] = f(r['country'], 'wikidata', 0.7)
        if r['inds']:
            x['industry_declared'] = f(sorted(r['inds'])[:6], 'wikidata', 0.7)
        if r.get('form'):
            x['legal_form'] = f(r['form'], 'wikidata', 0.7)
        if r.get('parent'):
            x['parent'] = f(r['parent'], 'wikidata', 0.7)
        if r.get('lei'):
            x['lei'] = f(r['lei'], 'wikidata', 0.9)
        if r.get('ticker'):
            x['ticker'] = f(r['ticker'], 'wikidata', 0.8)
        res[host] = x
    return res


def harvest(registry_path, out_path, only_hiring=False, limit=0, max_age=45, workers=6, no_web=False, no_wikidata=False):
    reg = [json.loads(line) for line in open(registry_path, encoding='utf-8')]
    if only_hiring:
        reg = [r for r in reg if r.get('hiring')]
    outp = Path(out_path)
    db = json.loads(outp.read_text(encoding='utf-8')) if outp.exists() else {'by_key': {}, 'fetched': {}}
    fresh = lambda k: k in db['fetched'] and (date.fromisoformat(TODAY) - date.fromisoformat(db['fetched'][k])).days < max_age
    todo = [r for r in reg if not fresh(norm_name(r['name']))]
    if limit:
        todo = todo[:limit]
    print(f'{len(reg)} companies, {len(todo)} to fetch', flush=True)

    def work(r):
        k = norm_name(r['name'])
        fields, why = {}, 'skipped'
        if not no_web and r.get('domain'):
            fields, why = from_site(r['domain'])
        for kk, v in from_ats(r.get('crawl')).items():
            if kk not in fields or v['conf'] > fields[kk]['conf']:
                fields.setdefault(kk, v)
        return k, fields, why

    t0 = time.time()
    with cf.ThreadPoolExecutor(workers) as ex:
        for i, (k, fields, why) in enumerate(ex.map(work, todo)):
            if fields:
                db['by_key'].setdefault(k, {}).update(fields)
            db['fetched'][k] = TODAY
            if (i + 1) % 25 == 0 or (i + 1) == len(todo):
                print(f'{i + 1}/{len(todo)} done in {time.time() - t0:.0f}s', flush=True)
                os.makedirs(outp.parent, exist_ok=True)
                outp.write_text(json.dumps(db, ensure_ascii=False, indent=2), encoding='utf-8')

    if not no_wikidata:
        domains = {r['domain'] for r in reg if r.get('domain')}
        w_data = wikidata(domains)
        for r in reg:
            d = r.get('domain')
            if d in w_data:
                k = norm_name(r['name'])
                db['by_key'].setdefault(k, {}).update(w_data[d])
        outp.write_text(json.dumps(db, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Finished employer metadata harvest.')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', default='companies.jsonl')
    ap.add_argument('--out', default='employer-meta.json')
    ap.add_argument('--only-hiring', action='store_true')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--max-age', type=int, default=45)
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--no-web', action='store_true')
    ap.add_argument('--no-wikidata', action='store_true')
    a = ap.parse_args()
    harvest(a.registry, a.out, a.only_hiring, a.limit, a.max_age, a.workers, a.no_web, a.no_wikidata)


if __name__ == '__main__':
    main()
