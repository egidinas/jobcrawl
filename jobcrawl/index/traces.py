"""Role traces, weekly trends and the atlas timeline: a small permanent record of every role that was ever on the board (needs numpy).

Reads: SITE/jobs-index.json and SITE/jobs-desc-XX.json (the roles on the board now: t, c, cs, u, l, fs, d, sc, tg, lv); VECTORS/match-vec.bin
and match-vec.json (the role vectors); VECTORS/atlas-layout.json, when the map was built (roles: ids, x, y, c1; regions); and the traces of the
earlier runs, VECTORS/role-traces.json and role-traces.bin, which this run extends.
Run time: --date, a UTC day (YYYY-MM-DD, midnight) or a UTC minute (YYYY-MM-DDTHH:MM); default now, to the minute. The step runs once per
crawl round, so several runs can share a day.
Writes into VECTORS (private, publish does not copy them):
    role-traces.json   the memory, one entry per role ever on the board: {version, dim, run, layout, regions, conv, ids, t, c, cs, l, u, p,
                       fa, la, sc, tg, lv, c1, x, y}. The lists run in the same order. t title, c company, cs company slug, l location text
                       as posted, u posting URL, p the posted day where the board has one apart from fs ('' otherwise): the raw facts, kept
                       for roles off the board. fa and la are the first and last seen times, "YYYY-MM-DDTHH:MMZ". sc and tg are bit sets,
                       lv an index, all over conv = {scopes, fields, levels}: the lists the bits refer to (levels[0] is "" for no band).
                       When the profile's lists change, the roles off the board get sc and lv re-derived from l and t, and tg from the old
                       tags plus the title and company (the description is not kept). c1 is the region (-1 for none), x and y the map
                       position (layout units 0..1, -1 for a role with no vector).
    role-traces.bin    int8, 128 numbers per role in the order of ids: the first 128 numbers of the role's vector, unit length, quantised
                       as jobcrawl/embed/roles.py writes them. A role without a vector has a zero row.
    role-trends.json   derived from the traces on every run: {version, weeks, regions, scopes, series: {scope: {new, gone, open}}}.
                       new, gone and open are counts per week (ISO week) and region, by the days of fa and la.
    role-timeline.json, role-timeline.bin   for the atlas's time scrubber: the traces last seen within 365 days of the run time.
                       json: {version, t0, unit: "minute", n, scopes, fields, layout, names_shard: 2000}. bin: n records of 16 bytes,
                       little-endian, struct format '<HHBBHII': x uint16 (x * 65535; 65535 = none), y uint16 (same), c1 uint8 (255 = none),
                       sc uint8 (scope bits), tg uint16 (field bits), fa uint32 and la uint32 (minutes since t0). No ids, URLs, locations
                       or descriptions.
    role-timeline-names-NNN.json   [[title, company], ...] for records NNN*2000 .. NNN*2000+1999, in the order of the .bin.
Publish copies role-trends.json, role-timeline.* and the name shards into the match folder, and nothing else of these; the traces stay private.
"""
import datetime
import hashlib
import json
import os
import re
import struct

from jobcrawl.classify.fields import field_matchers, field_tags
from jobcrawl.classify.levels import compile_levels, level_of
from jobcrawl.classify.scopes import scope_ids
from jobcrawl.geo import geo
from jobcrawl.index.match_index import level_codes_of
from jobcrawl.site import read_site

DIM = 128                       # numbers kept per role
LISTED_DAYS = 0                 # a role is still listed when it is on the board on the run date; otherwise it counts as no longer seen
WINDOW_DAYS = 365               # the timeline holds the roles last seen within this many days of the run
NEAREST = 8                     # the layout roles whose mean position a trace without a place in the layout takes
VERSION = 1
TRACES_JSON, TRACES_BIN, TRENDS_JSON = 'role-traces.json', 'role-traces.bin', 'role-trends.json'
TIMELINE_JSON, TIMELINE_BIN = 'role-timeline.json', 'role-timeline.bin'
RAW = ('t', 'c', 'cs', 'l', 'u', 'p')         # the facts as the board has them (kept for later display conventions)
LISTS = ('ids', 'fa', 'la', 'sc', 'tg', 'lv', 'c1', 'x', 'y') + RAW
NAMES_SHARD = 2000              # the timeline's title and company names: role-timeline-names-NNN.json, this many records each
NAMES_FILE = 'role-timeline-names-%03d.json'
NAMES_RE = re.compile(r'^role-timeline-names-\d{3}\.json$')
RECORD = struct.Struct('<HHBBHII')
STAMP = re.compile(r'(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})Z?)?')
FMT = '%Y-%m-%dT%H:%MZ'


class TraceError(ValueError):
    pass


def _day(s):
    """The date of a YYYY-MM-DD string (or of the day part of a stamp), or None."""
    try:
        return datetime.date.fromisoformat(s[:10]) if isinstance(s, str) else None
    except ValueError:
        return None


def _stamp(s):
    """A run time: YYYY-MM-DD (midnight UTC) or YYYY-MM-DDTHH:MM (UTC) as a naive datetime, or None when it is neither."""
    m = STAMP.fullmatch(s) if isinstance(s, str) else None
    if not m:
        return None
    try:
        d = datetime.date.fromisoformat(m.group(1))
    except ValueError:
        return None
    hh, mm = int(m.group(2) or 0), int(m.group(3) or 0)
    if hh > 23 or mm > 59:
        return None
    return datetime.datetime(d.year, d.month, d.day, hh, mm)


def _text(dt):
    return dt.strftime(FMT)


def _monday(d):
    return d - datetime.timedelta(days=d.weekday())


def _week_label(monday):
    y, w, _ = monday.isocalendar()
    return f'{y}-W{w:02d}'


def _extend(known, new):
    """known, then the names of new it does not hold yet: the bit positions stay the same from one run to the next."""
    out = list(known)
    for x in new:
        if x not in out:
            out.append(x)
    return out


def _layout_hash(regions):
    """A short hash of the layout's regions (their sizes and words): a rebuilt layout gives another hash; the labels do not change it."""
    text = json.dumps([[r.get('n'), r.get('words')] for r in regions], ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha1(text.encode('utf-8')).hexdigest()[:12]


def _unit_rows(M):
    import numpy as np
    return M / np.maximum(np.linalg.norm(M, axis=1, keepdims=True), 1e-9)


def _vector_rows(vectors, wanted):
    """{id: int8 row of 128 numbers} for the wanted roles that have a vector in VECTORS. A role without one has no entry."""
    import numpy as np
    path = os.path.join(vectors, 'match-vec.json')
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as fh:
        vj = json.load(fh)
    dim, ids = vj['dim'], vj['ids']
    with open(os.path.join(vectors, 'match-vec.bin'), 'rb') as fh:
        V = np.frombuffer(fh.read(), np.int8).reshape(len(ids), dim)[:, :DIM].astype(np.float32)
    if dim < DIM:                                  # a short vector (tests): the missing numbers are zero
        V = np.pad(V, ((0, 0), (0, DIM - dim)))
    Q = np.clip(np.round(_unit_rows(V) * 127), -127, 127).astype(np.int8)
    want = set(wanted)
    return {rid: Q[k] for k, rid in enumerate(ids) if rid in want and Q[k].any()}


def _load_previous(vectors):
    """The traces of the earlier runs as lists plus B (the int8 rows), or None when there are none yet."""
    import numpy as np
    path = os.path.join(vectors, TRACES_JSON)
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as fh:
        old = json.load(fh)
    if old.get('version') != VERSION or old.get('dim') != DIM:
        raise TraceError(f'{TRACES_JSON}: not a version {VERSION} file with {DIM} numbers per role')
    n = len(old['ids'])
    if any(len(old[k]) != n for k in LISTS):
        raise TraceError(f'{TRACES_JSON}: the lists have different lengths')
    bin_path = os.path.join(vectors, TRACES_BIN)
    if not os.path.exists(bin_path):
        raise TraceError(f'{TRACES_JSON} has no {TRACES_BIN} next to it in {vectors}')
    with open(bin_path, 'rb') as fh:
        raw = fh.read()
    if len(raw) != n * DIM:
        raise TraceError(f'{TRACES_BIN} holds {len(raw) // DIM} rows, {TRACES_JSON} lists {n} roles')
    old['B'] = np.frombuffer(raw, np.int8).reshape(n, DIM).copy()
    return old


def _assign(B, rows, members, member_regions, R):
    """For each row (a position in B): the region whose centre (the mean direction of its layout roles) is nearest by cosine.
    -1 for a zero row, or when there are no regions with members."""
    import numpy as np
    if R == 0 or not members:
        return np.full(len(rows), -1)
    unit = _unit_rows(B[members].astype(np.float32))
    regions = np.asarray(member_regions)
    C = np.zeros((R, DIM), np.float32)
    for r in range(R):
        sel = regions == r
        if sel.any():
            C[r] = unit[sel].sum(0)
    C = _unit_rows(C)
    ok = np.linalg.norm(C, axis=1) > 0
    F = _unit_rows(B[rows].astype(np.float32))
    S = F @ C.T
    S[:, ~ok] = -9
    out = S.argmax(1) if ok.any() else np.full(len(rows), -1)
    return np.where(np.linalg.norm(F, axis=1) > 0, out, -1)


def _near_xy(B, rows, members, xy, k=NEAREST):
    """For each row: the mean layout position (xy, one [x, y] per member) of its k nearest members by cosine. Zero rows get 0,0
    here; the caller sets them to -1."""
    import numpy as np
    out = np.full((len(rows), 2), -1.0)
    if not members or not len(rows):
        return out
    unit = _unit_rows(B[members].astype(np.float32))
    F = _unit_rows(B[rows].astype(np.float32))
    kk = min(k, len(members))
    for a in range(0, len(rows), 2048):
        S = F[a:a + 2048] @ unit.T
        idx = np.argpartition(-S, kk - 1, axis=1)[:, :kk]
        out[a:a + 2048] = xy[idx].mean(1)
    return out


def _bits(names, index):
    """A bit set over index (the position of each name in its list); names not in the list are left out."""
    return sum(1 << index[n] for n in set(names) if n in index)


def _names(bits, names):
    """The names of a bit set, in list order."""
    return [n for k, n in enumerate(names) if bits >> k & 1]


def _classifiers(profile):
    return {'levels': compile_levels(profile['levels']), 'matchers': field_matchers(profile['fields'])}


def _derive(profile, cache, t, c, l):
    """(scope ids, level code, field tags) of a role from its raw facts, with the board's own classifiers. The field tags are taken
    from the title and company only: the traces keep no description text (the board's tags for roles on the board use it)."""
    loc = '' if l.lower() in ('', 'unspecified') else l
    places = geo.resolve(loc)['places']
    return (scope_ids(places, profile['scopes']), level_of(t, cache['levels']),
            field_tags(t, '', c, profile['fields'], profile['max_field_tags'], cache['matchers']))


def _grid(W, R):
    return [[0] * R for _ in range(W)]


def _trends(fa, la, sc, c1, scopes, R, run):
    """The weekly counts per scope: new (first seen that week), gone (last seen that week, and not on the board on the run date), open (on the board
    at the end of the week: first seen by then, and still listed or last seen on or after the week's Sunday). Roles with no region are
    skipped. Counts by the days of fa and la."""
    fs_d = [_day(x) for x in fa]
    ls_d = [_day(x) for x in la]
    starts = [_monday(d) for d in fs_d if d]
    first = min(starts, default=_monday(run))
    last = max(_monday(run), first)
    W = (last - first).days // 7 + 1
    mondays = [first + datetime.timedelta(weeks=w) for w in range(W)]
    ends = [m + datetime.timedelta(days=6) for m in mondays]
    cut = run - datetime.timedelta(days=LISTED_DAYS)
    series = {}
    for k, sid in enumerate(scopes):
        new, gone, opn = _grid(W, R), _grid(W, R), _grid(W, R)
        for i in range(len(c1)):
            reg = c1[i]
            if not (0 <= reg < R) or not (sc[i] >> k) & 1 or fs_d[i] is None or ls_d[i] is None:
                continue
            f, l = fs_d[i], ls_d[i]
            wf = (_monday(f) - first).days // 7
            if not 0 <= wf < W:
                continue
            new[wf][reg] += 1
            if l < cut:
                wl = (_monday(l) - first).days // 7
                if 0 <= wl < W:
                    gone[wl][reg] += 1
            listed = l >= cut
            for w in range(wf, W):
                if listed or l >= ends[w]:
                    opn[w][reg] += 1
        series[sid] = {'new': new, 'gone': gone, 'open': opn}
    return {'version': VERSION, 'weeks': [_week_label(m) for m in mondays], 'regions': R, 'scopes': list(scopes), 'series': series}


def _timeline(rec, scopes, fields, R, layout, run):
    """(json dict, bytes, names) of the traces last seen within WINDOW_DAYS of the run: 16-byte records, see the module doc; names is
    [title, company] per record, in the same order (the public name shards)."""
    if len(scopes) > 8 or len(fields) > 16 or R > 254:
        raise TraceError(f'the timeline holds 8 scopes, 16 fields and 254 regions: this board has {len(scopes)}, {len(fields)} and {R}')
    window = run - datetime.timedelta(days=WINDOW_DAYS)
    keep = [i for i in range(len(rec['ids'])) if _stamp(rec['la'][i]) and _stamp(rec['la'][i]) >= window]
    fa = {i: _stamp(rec['fa'][i]) for i in keep}
    t0 = min([fa[i] for i in keep], default=run)
    body = bytearray()
    for i in keep:
        x, y = rec['x'][i], rec['y'][i]
        xi = 0xFFFF if x < 0 else min(65535, round(x * 65535))
        yi = 0xFFFF if y < 0 else min(65535, round(y * 65535))
        c = rec['c1'][i]
        la = max(_stamp(rec['la'][i]), fa[i])           # a last seen before its first seen (a run dated before the shard's day) is not packed
        body += RECORD.pack(xi, yi, 255 if c < 0 else c, rec['sc'][i], rec['tg'][i],
                            int((fa[i] - t0).total_seconds() // 60), int((la - t0).total_seconds() // 60))
    meta = {'version': VERSION, 't0': _text(t0), 'unit': 'minute', 'n': len(keep), 'scopes': list(scopes), 'fields': list(fields),
            'layout': layout, 'names_shard': NAMES_SHARD}
    names = [[rec['t'][i], rec['c'][i]] for i in keep]
    return meta, bytes(body), names


def build(site, vectors, date=None, profile=None, log=print, traces=None):
    """Extends the traces in VECTORS with the board of SITE as of the run time DATE (UTC: YYYY-MM-DD or YYYY-MM-DDTHH:MM; default now)
    and writes role-traces.json, role-traces.bin, role-trends.json, role-timeline.json/.bin and the name shards there.
    profile (optional) gives the order of the scopes, fields and levels; without it they follow the board. When the lists differ from
    the last run's (profile given), the roles not on the board are re-derived from their raw facts. traces: another folder for the
    traces, trends and timeline (default VECTORS), e.g. one kept out of version control. Returns {'traced', 'board', 'new'}."""
    import numpy as np
    if date is None:
        run = datetime.datetime.now(datetime.timezone.utc).replace(second=0, microsecond=0, tzinfo=None)
    else:
        run = _stamp(date)
        if run is None:
            raise TraceError(f'--date {date!r}: not YYYY-MM-DD or YYYY-MM-DDTHH:MM (UTC)')
    run_s, today = _text(run), run.date()
    tdir = traces or vectors
    os.makedirs(tdir, exist_ok=True)
    index, desc = read_site(site)
    board = []
    for r in index:
        e = desc.get(r[0]) or {}
        posted = e.get('d') if isinstance(e.get('d'), str) else ''
        fs_text = e.get('fs') if isinstance(e.get('fs'), str) else ''
        board.append({'id': r[0], 't': r[1], 'c': r[2], 'u': r[3], 'cs': r[4] if len(r) > 4 else '',
                      'l': e.get('l') or '',
                      'p': posted if posted and posted != fs_text else '',       # the posted day, where the board has one apart from fs
                      # first seen: the shard's fs, else its published day d (older boards have no fs), else the run's day
                      'fs': _day(fs_text) or _day(e.get('d')) or today,
                      'sc': [x for x in e.get('sc') or [] if isinstance(x, str)], 'tg': [x for x in e.get('tg') or [] if isinstance(x, str)],
                      'lv': e.get('lv') or ''})
    prev = _load_previous(tdir)
    pc = prev['conv'] if prev else {}
    empty = prev is None or not prev['ids']          # the very first run: the roles get their shard's first-seen day as the backfill
    p_scopes = [s['id'] for s in profile['scopes']] if profile else []
    p_fields = [f.get('tag', f['id']) for f in profile['fields']] if profile else []
    p_levels = level_codes_of(profile) if profile else ['']
    scopes = _extend(p_scopes if profile else pc.get('scopes', []), sorted({x for b in board for x in b['sc']}))
    fields = _extend(p_fields if profile else pc.get('fields', []), sorted({x for b in board for x in b['tg']}))
    levels = _extend(p_levels if profile else pc.get('levels', ['']), sorted({b['lv'] for b in board if b['lv']}))
    changed = prev is not None and (scopes, fields, levels) != (pc.get('scopes'), pc.get('fields'), pc.get('levels'))
    rederive = changed and profile is not None
    sbit = {x: k for k, x in enumerate(scopes)}
    fbit = {x: k for k, x in enumerate(fields)}
    lcode = {x: k for k, x in enumerate(levels)}
    vec = _vector_rows(vectors, [b['id'] for b in board])

    # the memory: the stored roles keep their first-seen time, their vector and their place in the list
    rec = {k: list(prev[k]) for k in LISTS} if prev else {k: [] for k in LISTS}
    B = prev['B'] if prev else np.zeros((0, DIM), np.int8)
    n0 = len(rec['ids'])
    pos = {rid: k for k, rid in enumerate(rec['ids'])}
    for k in range(n0):                             # a role traced without a vector takes its vector once it has one
        if not B[k].any() and rec['ids'][k] in vec:
            B[k] = vec[rec['ids'][k]]
    board_ids = {b['id'] for b in board}
    if rederive:                                    # the lists changed: the roles off the board get their bits from their raw facts
        cache = _classifiers(profile)
        for k, rid in enumerate(rec['ids']):
            if rid in board_ids:
                continue
            old_tg = _names(rec['tg'][k], pc['fields'])
            sc_names, lv, tg_names = _derive(profile, cache, rec['t'][k], rec['c'][k], rec['l'][k])
            rec['sc'][k] = _bits(sc_names, sbit)
            rec['lv'][k] = lcode.get(lv, 0)
            rec['tg'][k] = _bits(old_tg + tg_names, fbit)         # the old tags stay (the text is not kept), with the title's new ones
    added = []
    for b in board:
        bits = (_bits(b['sc'], sbit), _bits(b['tg'], fbit), lcode[b['lv']])
        if b['id'] in pos:
            k = pos[b['id']]
            rec['la'][k] = run_s
            for key in RAW:
                rec[key][k] = b[key]
            rec['sc'][k], rec['tg'][k], rec['lv'][k] = bits
        else:
            pos[b['id']] = len(rec['ids'])
            added.append(b['id'])
            fa = _text(datetime.datetime.combine(b['fs'], datetime.time(0))) if empty else run_s
            values = {'ids': b['id'], 'fa': fa, 'la': run_s, 'sc': bits[0], 'tg': bits[1], 'lv': bits[2], 'c1': -1, 'x': -1.0, 'y': -1.0}
            values.update({key: b[key] for key in RAW})
            for key in LISTS:
                rec[key].append(values[key])
    B = np.vstack([B, np.array([vec.get(rid, np.zeros(DIM, np.int8)) for rid in added], np.int8).reshape(-1, DIM)])
    zero = [not B[k].any() for k in range(len(rec['ids']))]

    # the layout: its own c1 and position for the roles it holds; for the others (gone, or the layout was rebuilt) the nearest region
    # (c1) and the mean position of the 8 nearest layout roles (x, y)
    lay_path = os.path.join(vectors, 'atlas-layout.json')
    prev_hash = prev['layout'] if prev else ''
    if os.path.exists(lay_path):
        with open(lay_path, encoding='utf-8') as fh:
            lay = json.load(fh).get('roles') or {}
        regions = lay.get('regions') or []
        R, lhash = len(regions), _layout_hash(regions)
        same = lhash == prev_hash
        lay_c1 = dict(zip(lay.get('ids') or [], lay.get('c1') or []))
        lay_xy = {rid: (float(x), float(y)) for rid, x, y in zip(lay.get('ids') or [], lay.get('x') or [], lay.get('y') or [])}
        need_c1, need_xy = [], []
        for k, rid in enumerate(rec['ids']):
            if rid in lay_c1:
                rec['c1'][k] = int(lay_c1[rid])
            elif not (same and rec['c1'][k] >= 0):
                need_c1.append(k)
            if rid in lay_xy:
                rec['x'][k], rec['y'][k] = lay_xy[rid]
            elif not zero[k] and not (same and rec['x'][k] >= 0):
                need_xy.append(k)
        if need_c1:
            members = [k for k, rid in enumerate(rec['ids']) if rid in lay_c1 and 0 <= rec['c1'][k] < R]
            near = _assign(B, need_c1, members, [rec['c1'][k] for k in members], R)
            for k, r in zip(need_c1, near):
                rec['c1'][k] = int(r)
        if need_xy:
            members = [k for k, rid in enumerate(rec['ids']) if rid in lay_xy and not zero[k]]
            xy = np.array([lay_xy[rec['ids'][k]] for k in members], np.float32).reshape(-1, 2)
            near = _near_xy(B, need_xy, members, xy)
            for k, (x, y) in zip(need_xy, near):
                rec['x'][k], rec['y'][k] = float(x), float(y)
    else:
        R, lhash = (prev['regions'] if prev else 0), prev_hash
        log('no atlas-layout.json in the vectors folder: the regions of the last run are kept, new roles have none')
    for k in range(len(rec['ids'])):
        if zero[k]:
            rec['x'][k] = rec['y'][k] = -1.0
        rec['x'][k], rec['y'][k] = round(float(rec['x'][k]), 5), round(float(rec['y'][k]), 5)

    out = {'version': VERSION, 'dim': DIM, 'run': run_s, 'layout': lhash, 'regions': R,
           'conv': {'scopes': scopes, 'fields': fields, 'levels': levels}}
    out.update(rec)
    bin_path, json_path = os.path.join(tdir, TRACES_BIN), os.path.join(tdir, TRACES_JSON)
    with open(bin_path, 'wb') as fh:
        fh.write(B.tobytes())
    with open(json_path, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    trends = _trends(rec['fa'], rec['la'], rec['sc'], rec['c1'], scopes, R, today)
    trends_path = os.path.join(tdir, TRENDS_JSON)
    with open(trends_path, 'w', encoding='utf-8') as fh:
        json.dump(trends, fh, separators=(',', ':'))
        fh.write('\n')
    meta, body, names = _timeline(rec, scopes, fields, R, lhash, run)
    tl_json, tl_bin = os.path.join(tdir, TIMELINE_JSON), os.path.join(tdir, TIMELINE_BIN)
    with open(tl_bin, 'wb') as fh:
        fh.write(body)
    with open(tl_json, 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, separators=(',', ':'))
    written = set()
    for s0 in range(0, len(names), NAMES_SHARD):
        fname = NAMES_FILE % (s0 // NAMES_SHARD)
        with open(os.path.join(tdir, fname), 'w', encoding='utf-8') as fh:
            json.dump(names[s0:s0 + NAMES_SHARD], fh, ensure_ascii=False, separators=(',', ':'))
        written.add(fname)
    for f in os.listdir(vectors):                   # shards of records that have left the window
        if NAMES_RE.match(f) and f not in written:
            os.remove(os.path.join(tdir, f))
    n = len(rec['ids'])
    size = os.path.getsize(json_path) + os.path.getsize(bin_path)
    tl_size = os.path.getsize(tl_json) + os.path.getsize(tl_bin) + sum(os.path.getsize(os.path.join(tdir, f)) for f in written)
    log(f'{n} roles traced ({len(added)} new, {len(board)} on the board at {run_s}{", re-derived" if rederive else ""}); {R} regions; '
        f'{size / max(n, 1):.0f} bytes per role on disk (json + bin); {TRACES_JSON} + {TRACES_BIN} {size / 1e3:.1f} KB; '
        f'{TRENDS_JSON} {os.path.getsize(trends_path) / 1e3:.1f} KB, {len(trends["weeks"])} weeks; '
        f'timeline {meta["n"]} records, {tl_size / 1e3:.1f} KB with {len(written)} name shards')
    return {'traced': n, 'board': len(board), 'new': len(added)}
