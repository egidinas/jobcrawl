"""Precise places for Singapore postings from the raw MyCareersFuture (MCF) records: a step of the place file (places.build_places extra).

Moved here from madenetwork.de tools/map_proto/sg_places.py (375f2a7879; the map agent's, folded in from the transitions agent's build_sg_places.py), same rules,
with the raw folder and the cache file as arguments (MADE_SG_RAW, MADE_SG_POSTAL_CACHE). No network calls: a code missing from the cache is skipped
and counted; a host without the raw files gets no placements (logged).

  mcf_postal:<postal>:nominatim            the posting itself is in the raw MCF file (matched on the 32-hex id of its URL) and has a postal code -> p postcode
  company_address_mcf:<postal>:nominatim   its employer has exactly one Singapore postal code in the raw MCF file                                -> p site
  company_address_mcf_choice:<n>:<postal>  several codes: one picked by a hash (a guess; places.build_places counts it as country-only)

Geocodes come from the cached OSM Nominatim answers (ODbL) in the cache file; a code missing from the cache is skipped and counted, never fetched."""
import collections, glob, gzip, hashlib, json, os, re

RAW = os.environ.get('MADE_SG_RAW') or os.path.expanduser('~/atlas/acq_v1/H/AtlasData/training/acq_v1/mcf_sg/')
CACHE = os.environ.get('MADE_SG_POSTAL_CACHE') or os.path.expanduser('~/work/map_proto/build/sg_postal_cache.json')
H32 = re.compile(r'([0-9a-f]{32})(?:[/?#]|$)')


def _norm(s):
    s = re.sub(r'\(via [^)]*\)', ' ', (s or '').casefold())
    s = re.sub(r'\b(pte|ltd|limited|private|singapore|sg|inc|llc|corp|co|the)\b', ' ', s)
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()


def sg_extra(sg_posts, cache_path=CACHE, raw=RAW, log=print):
    """sg_posts: {posting id: (url, company name)} of the Singapore postings. -> ({id: [lon, lat, basis, precision]}, stats)."""
    if not glob.glob(os.path.join(raw, 'part-*.jsonl.gz')) or not os.path.exists(cache_path):
        log(f'sg_places: no raw MCF files in {raw} or no cache {cache_path}; no Singapore placements'); return {}, {'sg_postings': len(sg_posts)}
    with open(cache_path, encoding='utf-8') as fh:
        cache = json.load(fh)
    ours, byco = {}, collections.defaultdict(list)
    for pid, (url, comp) in sg_posts.items():
        m = H32.search(url or '')
        if 'mycareersfuture' in (url or '') and m:
            ours[m.group(1)] = pid
        byco[_norm(comp)].append(pid)
    direct, coaddr, nraw = {}, collections.defaultdict(set), 0
    for f in sorted(glob.glob(os.path.join(raw, 'part-*.jsonl.gz'))):
        for line in gzip.open(f, 'rt', encoding='utf-8'):
            nraw += 1
            r = json.loads(line); sc = r.get('source_contact') or {}; a = sc.get('address') or {}; pc = str(a.get('postalCode') or '').strip()
            if not re.fullmatch(r'\d{6}', pc) or a.get('isOverseas'):
                continue
            m = H32.search(r.get('url') or '')
            if m and m.group(1) in ours:
                direct[ours[m.group(1)]] = pc
            for nm in {_norm(r.get('employer')), _norm((sc.get('postedCompany') or {}).get('name')), _norm((sc.get('hiringCompany') or {}).get('name'))}:
                if nm and nm in byco:
                    coaddr[nm].add(pc)
    out, st = {}, collections.Counter(raw_rows=nraw, sg_postings=len(sg_posts))
    for pid, (url, comp) in sg_posts.items():
        pc = direct.get(pid)
        if pc:
            if cache.get(pc):
                out[pid] = [cache[pc][0], cache[pc][1], f'mcf_postal:{pc}:nominatim', 'postcode']; st['mcf_postal'] += 1; continue
            st['postal_not_in_cache'] += 1
        cs = sorted(x for x in coaddr.get(_norm(comp), ()) if cache.get(x))
        if len(cs) == 1:
            out[pid] = [cache[cs[0]][0], cache[cs[0]][1], f'company_address_mcf:{cs[0]}:nominatim', 'site']; st['company_address'] += 1
        elif len(cs) > 1:
            x = cs[int(hashlib.sha256(pid.encode()).hexdigest(), 16) % len(cs)]
            out[pid] = [cache[x][0], cache[x][1], f'company_address_mcf_choice:{len(cs)}:{x}', 'site']; st['company_address_choice'] += 1
    log(f'sg_places: {dict(st)}')
    return out, dict(st)
