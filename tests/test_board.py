"""The board on the 5-role fixture catalog (tests/fixtures/catalog.json): files, formats, order, excerpt and the CLI."""
import contextlib
import hashlib
import io
import json
import os
import shutil
import tempfile
import unittest

from jobcrawl import board
from jobcrawl.cli import main
from jobcrawl.profile import load_profile

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG = os.path.join(HERE, 'fixtures', 'catalog.json')
PROFILE = os.path.join(os.path.dirname(HERE), 'profiles', 'aerospace')


class BoardOnFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profile = load_profile(PROFILE)
        cls.items = board.read_catalog(CATALOG)
        cls.entries = board.build_entries(cls.items, cls.profile)
        cls.out = tempfile.mkdtemp(prefix='jc-board-')
        cls.counts = board.write_board(cls.entries, cls.out)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.out, ignore_errors=True)

    def load(self, name):
        with open(os.path.join(self.out, name), encoding='utf-8') as fh:
            return json.load(fh)

    def test_counts(self):
        self.assertEqual(self.counts, {'roles': 5, 'shards': 5, 'feed': 5})

    def test_index_is_newest_first_with_slugs(self):
        index = self.load('jobs-index.json')
        self.assertEqual([r[1] for r in index], [
            'Lead Propulsion Engineer', 'Senior Thermal Vacuum Test Engineer', 'Working Student Embedded Software (m/w/d)',
            'Quantum Optics Technician', 'Software Engineer, Mission Operations'])
        self.assertEqual(index[2][4], 'fenwick-photonics-labs')
        self.assertEqual(index[3][2], 'Vertex Quantum Works (via Example Job Board)')

    def test_ids_are_sha1_of_the_url(self):
        index = self.load('jobs-index.json')
        for rid, title, company, url, slug in index:
            self.assertEqual(rid, hashlib.sha1(url.encode('utf-8')).hexdigest()[:8])

    def test_shards_hold_the_role_fields(self):
        seen = {}
        for name in os.listdir(self.out):
            if name.startswith('jobs-desc-'):
                self.assertRegex(name, r'^jobs-desc-[0-9a-f]{2}\.json$')
                shard = self.load(name)
                for rid, e in shard.items():
                    self.assertTrue(rid.startswith(name[len('jobs-desc-'):-5]))
                    seen[rid] = e
        self.assertEqual(len(seen), 5)
        keys = {'t', 'c', 'cs', 'u', 'l', 'r', 'sc', 'lv', 'd', 'fs', 'tg', 'x'}
        for e in seen.values():
            self.assertEqual(set(e), keys)

    def test_tvac_role(self):
        rid = hashlib.sha1('https://careers.example.com/nordlicht/tvac-senior-munich'.encode('utf-8')).hexdigest()[:8]
        shard = self.load('jobs-desc-%s.json' % rid[:2])
        e = shard[rid]
        self.assertEqual(e['r'], 'Germany')
        self.assertEqual(e['sc'], ['bavaria', 'germany', 'europe', 'worldwide'])
        self.assertEqual(e['lv'], 'senior')
        self.assertEqual(e['d'], '2026-10-19')                       # the posted date (the catalog's posted); fs is the first-seen day
        self.assertEqual(e['fs'], '2026-10-20')
        self.assertEqual(e['tg'][0], 'space')
        self.assertIn('thermal_tvac', e['tg'])
        self.assertTrue(e['x'].startswith('Your tasks: plan and run thermal vacuum'))

    def test_location_and_unspecified(self):
        by_title = {e['t']: e for e in self.entries_by_title()}
        self.assertEqual(by_title['Software Engineer, Mission Operations']['l'], '')
        self.assertEqual(by_title['Software Engineer, Mission Operations']['x'], '')
        self.assertEqual(by_title['Software Engineer, Mission Operations']['sc'], ['worldwide'])
        self.assertEqual(by_title['Quantum Optics Technician']['r'], 'Japan')
        self.assertEqual(by_title['Working Student Embedded Software (m/w/d)']['lv'], 'student')
        self.assertEqual(by_title['Lead Propulsion Engineer']['lv'], 'lead')
        self.assertEqual(by_title['Lead Propulsion Engineer']['sc'], ['europe', 'worldwide'])

    def entries_by_title(self):
        return [e for _, e in self.entries]

    def test_feed_is_the_order_with_ids(self):
        feed = self.load('jobs.json')
        self.assertEqual(len(feed), 5)
        self.assertEqual(feed[0]['t'], 'Lead Propulsion Engineer')
        self.assertIn('id', feed[0])

    def test_full_description_by_default(self):
        self.assertTrue(any(len(e['x']) > 200 for e in self.entries_by_title()))

    def test_excerpt_cuts_text(self):
        entries = board.build_entries(self.items, self.profile, excerpt=40)
        self.assertTrue(all(len(e['x']) <= 40 for _, e in entries))

    def test_stale_shards_are_removed(self):
        out = tempfile.mkdtemp(prefix='jc-board-stale-')
        try:
            with open(os.path.join(out, 'jobs-desc-ff.json'), 'w') as fh:
                fh.write('{}')
            board.write_board(self.entries, out)
            self.assertFalse(os.path.exists(os.path.join(out, 'jobs-desc-ff.json')))
        finally:
            shutil.rmtree(out, ignore_errors=True)

    def test_duplicate_urls_count_once(self):
        items = self.items + [dict(self.items[0])]
        self.assertEqual(len(board.build_entries(items, self.profile)), 5)

    def test_company_slug(self):
        self.assertEqual(board.company_slug('Vertex Quantum Works (via Example Job Board)'), 'vertex-quantum-works')
        self.assertEqual(board.company_slug('Straße & Söhne GmbH'), 'strasse-sohne-gmbh')


class DatesAndOrder(unittest.TestCase):
    """d is the posted date when it is a real date, else the first-seen day; fs is the first-seen day; board.order picks the sort key."""
    ITEMS = [
        {'url': 'https://jobs.example.com/a', 'title': 'Alpha Engineer', 'company': 'Zeta', 'first_seen': '2026-03-01', 'posted': '2026-03-09'},
        {'url': 'https://jobs.example.com/b', 'title': 'Beta Engineer', 'company': 'Alpha', 'first_seen': '2026-03-05'},
        {'url': 'https://jobs.example.com/c', 'title': 'Gamma Engineer', 'company': 'Mid', 'first_seen': '2026-03-03', 'posted': 'soon'},
        {'url': 'https://jobs.example.com/d', 'title': 'Delta Engineer', 'company': 'Beta', 'first_seen': '2026-03-04T10:00:00Z',
         'posted': '2026-03-04'},
    ]

    @classmethod
    def setUpClass(cls):
        cls.profile = load_profile(PROFILE)

    def titles(self, entries):
        return [e['t'] for _, e in entries]

    def by_title(self, entries):
        return {e['t']: e for _, e in entries}

    def test_d_is_posted_when_valid_else_first_seen(self):
        by = self.by_title(board.build_entries(self.ITEMS, self.profile))
        self.assertEqual(by['Alpha Engineer']['d'], '2026-03-09')
        self.assertEqual(by['Beta Engineer']['d'], '2026-03-05')           # no posted key
        self.assertEqual(by['Gamma Engineer']['d'], '2026-03-03')          # posted is not a date
        self.assertEqual(by['Delta Engineer']['d'], '2026-03-04')

    def test_fs_is_the_first_seen_day_cut_to_ten_characters(self):
        by = self.by_title(board.build_entries(self.ITEMS, self.profile))
        self.assertEqual(by['Alpha Engineer']['fs'], '2026-03-01')
        self.assertEqual(by['Delta Engineer']['fs'], '2026-03-04')

    def test_impossible_dates_are_not_posted_dates(self):
        items = [dict(self.ITEMS[1], posted='2026-02-30')]
        self.assertEqual(board.build_entries(items, self.profile)[0][1]['d'], '2026-03-05')

    def test_default_order_is_first_seen_even_when_posted_dates_differ(self):
        entries = board.build_entries(self.ITEMS, self.profile)
        self.assertEqual(self.titles(entries), ['Beta Engineer', 'Delta Engineer', 'Gamma Engineer', 'Alpha Engineer'])

    def test_published_order_sorts_by_d(self):
        profile = dict(self.profile, board={'order': 'published'})
        entries = board.build_entries(self.ITEMS, profile)
        self.assertEqual(self.titles(entries), ['Alpha Engineer', 'Beta Engineer', 'Delta Engineer', 'Gamma Engineer'])

    def test_unknown_order_is_refused(self):
        profile = dict(self.profile, board={'order': 'random'})
        with self.assertRaises(board.BoardError):
            board.build_entries(self.ITEMS, profile)


class Cli(unittest.TestCase):
    def run_cli(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_build_writes_files(self):
        out = tempfile.mkdtemp(prefix='jc-cli-')
        try:
            code, stdout, _ = self.run_cli(['build', '--profile', PROFILE, '--catalog', CATALOG, '--out', out])
            self.assertEqual(code, 0)
            self.assertIn('5 roles', stdout)
            for name in ('jobs-index.json', 'jobs.json'):
                self.assertTrue(os.path.exists(os.path.join(out, name)), name)
        finally:
            shutil.rmtree(out, ignore_errors=True)

    def test_build_with_excerpt(self):
        out = tempfile.mkdtemp(prefix='jc-cli-')
        try:
            code, _, _ = self.run_cli(['build', '--profile', PROFILE, '--catalog', CATALOG, '--out', out, '--excerpt', '30'])
            self.assertEqual(code, 0)
            with open(os.path.join(out, 'jobs.json'), encoding='utf-8') as fh:
                feed = json.load(fh)
            self.assertTrue(all(len(r['x']) <= 30 for r in feed))
        finally:
            shutil.rmtree(out, ignore_errors=True)

    def test_bad_profile_names_the_key(self):
        folder = tempfile.mkdtemp(prefix='jc-cli-bad-')
        try:
            with open(os.path.join(folder, 'profile.json'), 'w') as fh:
                json.dump({'fields': [{'id': 'a', 'label': {'en': 'A'}, 'keywords': [1]}]}, fh)
            code, _, err = self.run_cli(['build', '--profile', folder, '--catalog', CATALOG, '--out', folder])
            self.assertEqual(code, 2)
            self.assertIn('fields[0].keywords[0]', err)
        finally:
            shutil.rmtree(folder, ignore_errors=True)

    def test_missing_catalog(self):
        out = tempfile.mkdtemp(prefix='jc-cli-')
        try:
            code, _, err = self.run_cli(['build', '--profile', PROFILE, '--catalog', os.path.join(out, 'missing.json'), '--out', out])
            self.assertEqual(code, 2)
            self.assertIn('catalog not found', err)
        finally:
            shutil.rmtree(out, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
