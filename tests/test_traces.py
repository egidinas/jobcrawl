"""Role traces and trends (jobcrawl traces), and publish copying only role-trends.json.

The boards are hand-made (a few roles, with the fields the board writes) and the vectors are 16-number vectors on named axes, so every
expected count can be checked by hand. The trace cases need numpy (skipped with the reason otherwise); the publish case does not.
Run times: 2026-10-07 is in ISO week 41 (Monday 2026-10-05), 2026-10-28 in week 44 (Monday 2026-10-26). A date alone is midnight UTC.
"""
import contextlib
import io
import copy
import json
import os
import shutil
import struct
import tempfile
import unittest
from unittest import mock

from synthetic import HAVE_NUMPY, NUMPY_REASON
from jobcrawl.cli import main
from jobcrawl.index import publish, traces
from jobcrawl.profile import load_profile

HERE = os.path.dirname(os.path.abspath(__file__))
PROFILE = os.path.join(os.path.dirname(HERE), 'profiles', 'aerospace')
DIM = 16
need_numpy = unittest.skipUnless(HAVE_NUMPY, NUMPY_REASON)


def silent(message):
    pass


def axis(k, sign=1.0):
    v = [0.0] * DIM
    v[k] = sign
    return v


E0, E1 = axis(0), axis(1)


def write_site(site, roles):
    """A board folder: roles = [{id, t, c, fs, d, sc, tg, lv}], written as jobs-index.json and the description shards."""
    import shutil as sh
    sh.rmtree(site, ignore_errors=True)
    os.makedirs(site)
    index, shards = [], {}
    for r in roles:
        index.append([r['id'], r['t'], r['c'], 'https://example.test/' + r['id'], r['c'].lower()])
        shards.setdefault(r['id'][:2], {})[r['id']] = {
            't': r['t'], 'c': r['c'], 'cs': r['c'].lower(), 'u': 'https://example.test/' + r['id'], 'r': '',
            'sc': r['sc'], 'lv': r.get('lv', ''), 'd': r['d'], 'fs': r['fs'], 'tg': r.get('tg') or [], 'x': 'Work text for the role.',
            'l': r.get('l', 'Berlin, DEU')}
    with open(os.path.join(site, 'jobs-index.json'), 'w', encoding='utf-8') as fh:
        json.dump(index, fh)
    for prefix, shard in shards.items():
        with open(os.path.join(site, 'jobs-desc-%s.json' % prefix), 'w', encoding='utf-8') as fh:
            json.dump(shard, fh)


def write_vectors(vectors, vecs):
    """match-vec.bin/json for {id: 16 numbers}, unit length and int8, as jobcrawl embed writes them."""
    import numpy as np
    os.makedirs(vectors, exist_ok=True)
    M = np.array(list(vecs.values()), np.float32)
    M = M / np.maximum(np.linalg.norm(M, axis=1, keepdims=True), 1e-9)
    with open(os.path.join(vectors, 'match-vec.bin'), 'wb') as fh:
        fh.write(np.clip(np.round(M * 127), -127, 127).astype(np.int8).tobytes())
    with open(os.path.join(vectors, 'match-vec.json'), 'w', encoding='utf-8') as fh:
        json.dump({'dim': DIM, 'mean': [0.0] * DIM, 'ids': list(vecs), 'prompt': 'x', 'text': 'synthetic', 'lang_dirs': []}, fh)


def write_layout(vectors, ids, c1, words, xy=None):
    """atlas-layout.json with the roles part only: ids, c1, positions and one region per word list."""
    regions = [{'n': 1, 'words': w, 'xy': [0, 0]} for w in words]
    xy = xy or [(0.25, 0.5), (0.75, 0.5)][:len(ids)]
    with open(os.path.join(vectors, 'atlas-layout.json'), 'w', encoding='utf-8') as fh:
        json.dump({'version': 2, 'roles': {'ids': ids, 'x': [p[0] for p in xy], 'y': [p[1] for p in xy], 'c1': c1, 'regions': regions}}, fh)


def role(rid, t, fs, sc, d=None, l='Berlin, DEU', tg=None):
    return {'id': rid, 't': t, 'c': 'Acme GmbH', 'fs': fs, 'd': d or fs, 'sc': sc, 'l': l, 'tg': tg or []}


def unpack_timeline(vectors):
    with open(os.path.join(vectors, 'role-timeline.json'), encoding='utf-8') as fh:
        meta = json.load(fh)
    with open(os.path.join(vectors, 'role-timeline.bin'), 'rb') as fh:
        raw = fh.read()
    size = struct.calcsize('<HHBBHII')
    return meta, [struct.unpack_from('<HHBBHII', raw, i * size) for i in range(len(raw) // size)]


# the roles of the scenario: a (in region 0, worldwide), b (region 1, Germany and worldwide), z (no vector, worldwide), c (region 0, new later)
RUN1 = [role('a1a1a1a1', 'Alpha engineer', '2026-09-28', ['worldwide']),
        role('b2b2b2b2', 'Beta engineer', '2026-10-06', ['germany', 'worldwide']),
        role('c3c3c3c3', 'Zeta technician', '2026-10-01', ['worldwide'])]
VECS1 = {'a1a1a1a1': E0, 'b2b2b2b2': E1}                 # z has no vector
LAYOUT1 = (['a1a1a1a1', 'b2b2b2b2'], [0, 1], [['alpha'], ['beta']])


@need_numpy
class TracesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='jc-traces-')
        self.site = os.path.join(self.tmp, 'site')
        self.vectors = os.path.join(self.tmp, 'vectors')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_on(self, roles, date, vecs=None, layout=None, profile=None):
        from jobcrawl.index import traces
        write_site(self.site, roles)
        if vecs is not None:
            write_vectors(self.vectors, vecs)
        if layout is not None:
            write_layout(self.vectors, *layout)
        traces.build(self.site, self.vectors, date, profile, log=silent)
        with open(os.path.join(self.vectors, 'role-traces.json'), encoding='utf-8') as fh:
            tr = json.load(fh)
        with open(os.path.join(self.vectors, 'role-trends.json'), encoding='utf-8') as fh:
            trends = json.load(fh)
        return tr, trends

    def test_first_run_traces_every_board_role(self):
        from jobcrawl.index import traces
        tr, trends = self.run_on(RUN1, '2026-10-07', VECS1, LAYOUT1)
        self.assertEqual(tr['ids'], ['a1a1a1a1', 'b2b2b2b2', 'c3c3c3c3'])
        self.assertEqual(tr['fa'], ['2026-09-28T00:00Z', '2026-10-06T00:00Z', '2026-10-01T00:00Z'])   # the backfill: the shards' days at midnight
        self.assertEqual(tr['la'], ['2026-10-07T00:00Z'] * 3)
        self.assertEqual(tr['c1'], [0, 1, -1])                                           # the zero-vector role: no region
        self.assertEqual(tr['regions'], 2)
        size = os.path.getsize(os.path.join(self.vectors, 'role-traces.bin'))
        self.assertEqual(size, 3 * traces.DIM)
        with open(os.path.join(self.vectors, 'role-traces.bin'), 'rb') as fh:
            rows = fh.read()
        self.assertEqual(rows[2 * traces.DIM:], bytes(traces.DIM))                      # the zero row of the role without a vector
        self.assertEqual(trends['weeks'][0], '2026-W40')

    def test_second_run_adds_updates_and_keeps(self):
        tr1, _ = self.run_on(RUN1, '2026-10-07', VECS1, LAYOUT1)
        first_seen = dict(zip(tr1['ids'], tr1['fa']))
        retitled = [role('a1a1a1a1', 'Alpha engineer', '2026-09-28', ['worldwide']),
                    role('b2b2b2b2', 'Beta engineer (senior)', '2026-10-06', ['germany', 'worldwide']),
                    role('d4d4d4d4', 'New role', '2026-10-21', ['worldwide'])]
        vecs = dict(VECS1, d4d4d4d4=E0)
        tr2, _ = self.run_on(retitled, '2026-10-28', vecs, LAYOUT1)
        # c3 left the board: it keeps its ls; d4 is appended; a and b are seen on the run date; fs never changes
        self.assertEqual(tr2['ids'], ['a1a1a1a1', 'b2b2b2b2', 'c3c3c3c3', 'd4d4d4d4'])
        self.assertEqual(tr2['la'], ['2026-10-28T00:00Z', '2026-10-28T00:00Z', '2026-10-07T00:00Z', '2026-10-28T00:00Z'])
        self.assertEqual(tr2['t'][1], 'Beta engineer (senior)')
        self.assertEqual(tr2['fa'][:2], [first_seen['a1a1a1a1'], first_seen['b2b2b2b2']])
        self.assertEqual(tr2['fa'][3], '2026-10-28T00:00Z')                    # a new role in a later run: the run's time

    def test_a_returning_role_keeps_its_first_seen_day(self):
        self.run_on(RUN1, '2026-10-07', VECS1, LAYOUT1)
        back = [role('b2b2b2b2', 'Beta engineer', '2026-10-06', ['germany', 'worldwide']),
                role('c3c3c3c3', 'Zeta technician', '2026-10-01', ['worldwide'])]
        # a is off the board for this run; in the next run it is back, with a later first-seen day in the shard
        self.run_on(back, '2026-10-14', dict(VECS1), LAYOUT1)
        again = [role('a1a1a1a1', 'Alpha engineer', '2026-11-02', ['worldwide'])]
        tr, _ = self.run_on(again, '2026-11-04', VECS1, LAYOUT1)
        i = tr['ids'].index('a1a1a1a1')
        self.assertEqual(tr['fa'][i], '2026-09-28T00:00Z')
        self.assertEqual(tr['la'][i], '2026-11-04T00:00Z')
        self.assertEqual(tr['ids'].count('a1a1a1a1'), 1)

    def test_a_gone_role_gets_the_nearest_region_after_the_layout_is_rebuilt(self):
        self.run_on(RUN1, '2026-10-07', VECS1, LAYOUT1)              # a is in region 0 (axis 0), b in region 1 (axis 1)
        # the layout is rebuilt with the regions in the other order, and a is not on the board any more
        # on the new board e5 (axis 0) is the axis-0 role of the rebuilt layout: region 1 holds it, region 0 holds b (axis 1)
        board = [role('b2b2b2b2', 'Beta engineer', '2026-10-06', ['germany', 'worldwide']), role('e5e5e5e5', 'Epsilon', '2026-10-21', ['worldwide'])]
        rebuilt = (['b2b2b2b2', 'e5e5e5e5'], [0, 1], [['beta'], ['alpha']])
        tr, _ = self.run_on(board, '2026-10-28', dict(VECS1, e5e5e5e5=E0), rebuilt)
        i = tr['ids'].index('a1a1a1a1')
        self.assertEqual(tr['c1'][i], 1)                             # a is not in the layout: the nearest region centre is region 1 (axis 0)
        self.assertEqual(tr['c1'][tr['ids'].index('b2b2b2b2')], 0)
        self.assertEqual(tr['c1'][tr['ids'].index('c3c3c3c3')], -1)  # gone, with no vector
        self.assertEqual(tr['regions'], 2)

    def test_trends_by_hand(self):
        self.run_on(RUN1, '2026-10-07', VECS1, LAYOUT1)
        # run 2: a is gone (last seen 10-07, more than a week before the run); b stays; d (axis 0) is new on the run day, 10-28
        board2 = [role('b2b2b2b2', 'Beta engineer', '2026-10-06', ['germany', 'worldwide']),
                  role('d4d4d4d4', 'New role', '2026-10-21', ['worldwide'])]
        _, trends = self.run_on(board2, '2026-10-28', dict(VECS1, d4d4d4d4=E0), LAYOUT1)
        self.assertEqual(trends['weeks'], ['2026-W40', '2026-W41', '2026-W42', '2026-W43', '2026-W44'])
        self.assertEqual(trends['regions'], 2)
        self.assertEqual(trends['scopes'], ['germany', 'worldwide'])
        ww = trends['series']['worldwide']
        self.assertEqual(ww['new'], [[1, 0], [0, 1], [0, 0], [0, 0], [1, 0]])          # a (W40, r0), b (W41, r1), d (W44, r0: the run day)
        self.assertEqual(ww['gone'], [[0, 0], [1, 0], [0, 0], [0, 0], [0, 0]])          # a, last seen in W41, is more than a week old
        self.assertEqual(ww['open'], [[1, 0], [0, 1], [0, 1], [0, 1], [1, 1]])          # a open at the end of W40 only; b from W41; d from W44
        de = trends['series']['germany']
        self.assertEqual(de['new'], [[0, 0], [0, 1], [0, 0], [0, 0], [0, 0]])
        self.assertEqual(de['gone'], [[0, 0]] * 5)
        self.assertEqual(de['open'], [[0, 0], [0, 1], [0, 1], [0, 1], [0, 1]])

    def test_a_role_off_the_board_counts_as_no_longer_seen(self):
        self.run_on(RUN1, '2026-10-07', VECS1, LAYOUT1)
        # a is not on the board on 10-14: it counts as no longer seen in the week of its last seen day (10-07, W41)
        _, trends = self.run_on([role('b2b2b2b2', 'Beta engineer', '2026-10-06', ['germany', 'worldwide'])], '2026-10-14', VECS1, LAYOUT1)
        ww = trends['series']['worldwide']
        self.assertEqual(sum(sum(x) for x in ww['gone']), 1)
        self.assertEqual(sum(ww['gone'][1]), 1)                       # W41
        self.assertEqual(sum(ww['open'][2]), 1)                       # only b is open at the end of W42

    def test_a_run_time_with_minutes_and_the_default(self):
        tr, _ = self.run_on(RUN1, '2026-10-07T09:30', VECS1, LAYOUT1)
        self.assertEqual(tr['la'][0], '2026-10-07T09:30Z')
        self.assertEqual(tr['fa'][0], '2026-09-28T00:00Z')                    # the first run: the backfill stays at midnight
        tr, _ = self.run_on(RUN1 + [role('e5e5e5e5', 'Epsilon', '2026-10-07', ['worldwide'])], '2026-10-07T15:05',
                            dict(VECS1, e5e5e5e5=E0), LAYOUT1)
        self.assertEqual(tr['fa'][tr['ids'].index('e5e5e5e5')], '2026-10-07T15:05Z')   # a later run: the run time
        self.assertEqual(tr['la'][tr['ids'].index('a1a1a1a1')], '2026-10-07T15:05Z')
        for bad in ('2026-10-07 09:30', '2026-13-01', '2026-10-07T25:00', 'tomorrow'):
            with self.assertRaises(traces.TraceError, msg=bad):
                traces.build(self.site, self.vectors, bad, None, log=silent)
        tr, _ = self.run_on(RUN1, None, VECS1, LAYOUT1)                       # no date: now, UTC, to the minute
        self.assertRegex(tr['run'], r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$')

    def test_the_timeline_round_trips_and_holds_no_names(self):
        self.run_on(RUN1, '2026-10-07', VECS1, LAYOUT1)
        meta, recs = unpack_timeline(self.vectors)
        self.assertEqual(meta['n'], 3)
        self.assertEqual(len(recs), 3)
        self.assertEqual(meta['t0'], '2026-09-28T00:00Z')
        self.assertEqual(meta['unit'], 'minute')
        self.assertEqual(meta['scopes'], ['germany', 'worldwide'])
        self.assertEqual(meta['fields'], [])
        self.assertIn('layout', meta)
        a, b, z = recs
        self.assertEqual((a[0], a[1]), (round(0.25 * 65535), round(0.5 * 65535)))
        self.assertEqual((a[2], a[3]), (0, 2))                                 # region 0; worldwide bit
        self.assertEqual(a[5], 0)                                              # first seen 2026-09-28 is the epoch
        self.assertEqual(b[5], 8 * 1440)                                       # 2026-10-06 is 8 days later, in minutes
        self.assertEqual(b[6], 9 * 1440)                                       # last seen on the run day, 2026-10-07
        self.assertEqual((z[0], z[1], z[2]), (0xFFFF, 0xFFFF, 255))           # zero vector: no place, no region
        with open(os.path.join(self.vectors, 'role-timeline.bin'), 'rb') as fh:
            self.assertEqual(len(fh.read()), 3 * 16)
        with open(os.path.join(self.vectors, 'role-timeline.json'), encoding='utf-8') as fh:
            text = fh.read()
        for name in ('Alpha', 'Beta', 'Acme', 'a1a1a1a1'):
            self.assertNotIn(name, text)

    def test_the_timeline_keeps_the_roles_last_seen_within_365_days(self):
        old = [role('a1a1a1a1', 'Alpha engineer', '2024-12-01', ['worldwide']), role('b2b2b2b2', 'Beta engineer', '2024-12-01', ['worldwide'])]
        self.run_on(old, '2025-01-01', VECS1, LAYOUT1)
        tr, _ = self.run_on([role('b2b2b2b2', 'Beta engineer', '2024-12-01', ['worldwide'])], '2026-10-28', VECS1, LAYOUT1)
        self.assertEqual(sorted(tr['ids']), ['a1a1a1a1', 'b2b2b2b2'])          # the trace keeps a
        meta, recs = unpack_timeline(self.vectors)
        self.assertEqual(meta['n'], 1)                                         # a was last seen 2025-01-01: more than 365 days before
        self.assertEqual(len(recs), 1)
        self.assertEqual((recs[0][0], recs[0][1]), (round(0.75 * 65535), round(0.5 * 65535)))   # b, the one kept, sits where the layout puts it
        self.assertEqual(meta['t0'], '2024-12-01T00:00Z')

    def test_raw_facts_are_kept_across_runs(self):
        first = [role('a1a1a1a1', 'Alpha engineer', '2026-09-28', ['worldwide'], d='2026-09-27', l='Munich, DEU'),
                 role('b2b2b2b2', 'Beta engineer', '2026-10-06', ['germany', 'worldwide'])]
        self.run_on(first, '2026-10-07', VECS1, LAYOUT1)
        tr, _ = self.run_on([role('b2b2b2b2', 'Beta engineer (senior)', '2026-10-06', ['germany', 'worldwide'], l='Hamburg, DEU')],
                            '2026-10-28', VECS1, LAYOUT1)
        a = tr['ids'].index('a1a1a1a1')
        self.assertEqual((tr['t'][a], tr['c'][a], tr['cs'][a], tr['l'][a]), ('Alpha engineer', 'Acme GmbH', 'acme gmbh', 'Munich, DEU'))
        self.assertEqual(tr['u'][a], 'https://example.test/a1a1a1a1')                 # the URL is kept for a role off the board
        self.assertEqual(tr['p'][a], '2026-09-27')                                    # the posted day, where it differs from first seen
        b = tr['ids'].index('b2b2b2b2')
        self.assertEqual((tr['t'][b], tr['l'][b], tr['u'][b], tr['p'][b]), ('Beta engineer (senior)', 'Hamburg, DEU', 'https://example.test/b2b2b2b2', ''))
        self.assertEqual(tr['conv']['scopes'], ['germany', 'worldwide'])
        self.assertEqual(set(tr['conv']), {'scopes', 'fields', 'levels'})

    def test_a_changed_field_list_rederives_the_tags_of_roles_off_the_board(self):
        base = load_profile(PROFILE)
        board1 = [role('f1f1f1f1', 'Propulsion engineer', '2026-10-01', ['worldwide'], tg=['propulsion'])]
        tr1, _ = self.run_on(board1, '2026-10-07', None, None, base)
        self.assertEqual([x for x in tr1['conv']['fields'] if x == 'propulsion'], ['propulsion'])
        # the new profile lists the fields in reverse and adds one that the title matches; the role is off the board on the next run
        changed = copy.deepcopy(base)
        changed['fields'] = list(reversed(base['fields'])) + [{'id': 'probe', 'label': {'en': 'Probe'}, 'keywords': ['word:engineer']}]
        tr2, _ = self.run_on([role('c2c2c2c2', 'Quality engineer', '2026-10-01', ['worldwide'])], '2026-10-28', None, None, changed)
        self.assertEqual(tr2['conv']['fields'][-1], 'probe')
        p = tr2['ids'].index('f1f1f1f1')
        tags = {tr2['conv']['fields'][k] for k in range(len(tr2['conv']['fields'])) if tr2['tg'][p] >> k & 1}
        self.assertEqual(tags, {'propulsion', 'probe'})                               # the old tag still decodes; the title's new one is added
        scopes = {tr2['conv']['scopes'][k] for k in range(len(tr2['conv']['scopes'])) if tr2['sc'][p] >> k & 1}
        self.assertIn('germany', scopes)                                              # re-derived from the location, Berlin
        self.assertEqual(tr2['t'][p], 'Propulsion engineer')

    def test_name_shards_align_with_the_records(self):
        with mock.patch.object(traces, 'NAMES_SHARD', 2):
            self.run_on(RUN1, '2026-10-07', VECS1, LAYOUT1)
        meta, recs = unpack_timeline(self.vectors)
        self.assertEqual(meta['names_shard'], 2)
        with open(os.path.join(self.vectors, 'role-timeline-names-000.json'), encoding='utf-8') as fh:
            s0 = json.load(fh)
        with open(os.path.join(self.vectors, 'role-timeline-names-001.json'), encoding='utf-8') as fh:
            s1 = json.load(fh)
        self.assertEqual((len(s0), len(s1)), (2, 1))
        self.assertEqual(s0 + s1, [['Alpha engineer', 'Acme GmbH'], ['Beta engineer', 'Acme GmbH'], ['Zeta technician', 'Acme GmbH']])
        self.assertEqual(len(s0 + s1), len(recs))
        text = json.dumps(s0 + s1)
        self.assertNotIn('example.test', text)
        self.assertNotIn('Berlin', text)

    def test_name_shards_that_leave_the_window_are_removed(self):
        with mock.patch.object(traces, 'NAMES_SHARD', 2):
            self.run_on(RUN1, '2026-10-07', VECS1, LAYOUT1)
            self.assertTrue(os.path.exists(os.path.join(self.vectors, 'role-timeline-names-001.json')))
            # a year later only b is on the board and seen within the window; a and c were last seen more than 365 days before
            self.run_on([role('b2b2b2b2', 'Beta engineer', '2026-10-06', ['germany', 'worldwide'])], '2027-10-30', VECS1, LAYOUT1)
        meta, recs = unpack_timeline(self.vectors)
        self.assertEqual(meta['n'], 1)
        self.assertTrue(os.path.exists(os.path.join(self.vectors, 'role-timeline-names-000.json')))
        self.assertFalse(os.path.exists(os.path.join(self.vectors, 'role-timeline-names-001.json')))

    def test_trends_are_all_integers_and_dense(self):
        _, trends = self.run_on(RUN1, '2026-10-07', VECS1, LAYOUT1)
        for sid, s in trends['series'].items():
            for kind in ('new', 'gone', 'open'):
                self.assertEqual(len(s[kind]), len(trends['weeks']), (sid, kind))
                for week in s[kind]:
                    self.assertEqual(len(week), trends['regions'])
                    self.assertTrue(all(isinstance(x, int) for x in week))

    def test_a_missing_layout_keeps_the_last_regions(self):
        self.run_on(RUN1, '2026-10-07', VECS1, LAYOUT1)
        os.remove(os.path.join(self.vectors, 'atlas-layout.json'))
        tr, _ = self.run_on(RUN1[:2], '2026-10-14', VECS1)
        self.assertEqual(tr['regions'], 2)
        self.assertEqual(tr['c1'][tr['ids'].index('a1a1a1a1')], 0)

    def test_the_cli_runs_and_refuses_a_bad_date(self):
        write_site(self.site, RUN1)
        write_vectors(self.vectors, VECS1)
        write_layout(self.vectors, *LAYOUT1)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(main(['traces', '--site', self.site, '--vectors', self.vectors, '--date', '2026-10-07']), 0)
            self.assertEqual(main(['traces', '--site', self.site, '--vectors', self.vectors, '--date', '7 Oct']), 2)
        self.assertIn('not YYYY-MM-DD or YYYY-MM-DDTHH:MM', err.getvalue())
        self.assertTrue(os.path.exists(os.path.join(self.vectors, 'role-trends.json')))


class PublishCopiesTrendsOnly(unittest.TestCase):
    def test_the_trends_are_copied_and_the_traces_are_not(self):
        tmp = tempfile.mkdtemp(prefix='jc-traces-pub-')
        try:
            site = os.path.join(tmp, 'site')
            vectors = os.path.join(tmp, 'vectors')
            write_site(site, RUN1)
            os.makedirs(vectors)
            for name, body in (('role-traces.json', '{}'), ('role-traces.bin', 'x'), ('role-trends.json', '{"version": 1}'),
                               ('role-timeline.json', '{"version": 1}'), ('role-timeline.bin', 'y'),
                               ('role-timeline-names-000.json', '[["Alpha", "Acme"]]')):
                with open(os.path.join(vectors, name), 'w', encoding='utf-8') as fh:
                    fh.write(body)
            files = publish.publish(site, load_profile(PROFILE), vectors, log=silent)
            self.assertIn(os.path.join('match', 'role-trends.json'), files)
            self.assertTrue(os.path.exists(os.path.join(site, 'match', 'role-trends.json')))
            self.assertIn(os.path.join('match', 'role-timeline.bin'), files)
            self.assertTrue(os.path.exists(os.path.join(site, 'match', 'role-timeline.json')))
            self.assertTrue(os.path.exists(os.path.join(site, 'match', 'role-timeline.bin')))
            self.assertIn(os.path.join('match', 'role-timeline-names-000.json'), files)
            for root, _, names in os.walk(site):
                self.assertFalse([n for n in names if n.startswith('role-traces')], root)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_a_separate_traces_folder(self):
        tmp = tempfile.mkdtemp(prefix='jc-traces-pub-')
        try:
            site, vectors, tr = (os.path.join(tmp, x) for x in ('site', 'vectors', 'traces'))
            write_site(site, RUN1)
            os.makedirs(vectors); os.makedirs(tr)
            with open(os.path.join(tr, 'role-trends.json'), 'w', encoding='utf-8') as fh:
                fh.write('{"version": 1}')
            files = publish.publish(site, load_profile(PROFILE), vectors, log=silent, traces=tr)
            self.assertIn(os.path.join('match', 'role-trends.json'), files)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
