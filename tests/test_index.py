"""Keyword index, statements ("Match me" prefs) and neighbours. The keyword index runs on the fixture; the vector parts on
synthetic roles (tests/synthetic.py): no model, no network. The vector tests need numpy and are skipped without it."""
import json
import os
import shutil
import tempfile
import unittest

from synthetic import HAVE_NUMPY, NUMPY_REASON, board_for, make_catalog, write_match_vectors
from jobcrawl import board
from jobcrawl.index import match_index, neighbours, prefs
from jobcrawl.profile import load_profile
from jobcrawl.site import read_site

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, 'fixtures', 'catalog.json')
PROFILE = os.path.join(os.path.dirname(HERE), 'profiles', 'aerospace')
need_numpy = unittest.skipUnless(HAVE_NUMPY, NUMPY_REASON)


class KeywordIndexOnFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profile = load_profile(PROFILE)
        cls.tmp = tempfile.mkdtemp(prefix='jc-kw-')
        cls.site = os.path.join(cls.tmp, 'site')
        board.build(cls.profile, FIXTURE, cls.site)
        cls.out = os.path.join(cls.site, 'match')
        os.makedirs(cls.out)
        cls.n = match_index.build(cls.site, cls.out, cls.profile, log=lambda m: None)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def load(self, name):
        with open(os.path.join(self.out, name), encoding='utf-8') as fh:
            return json.load(fh)

    def test_postings_cover_the_board(self):
        bm = self.load('match-bm25.json')
        self.assertEqual(bm['n'], 5)
        self.assertEqual(len(bm['ids']), 5)
        self.assertEqual(len(bm['len']), 5)
        self.assertTrue(all(len(v) % 2 == 0 for v in bm['post'].values()))
        self.assertIn('test', bm['post'])                              # in two roles: the postings keep terms that two or more roles share

    def test_attributes_use_profile_scopes_and_levels(self):
        at = self.load('match-attrs.json')
        self.assertEqual(at['scopes'], [s['id'] for s in self.profile['scopes']])
        self.assertEqual(at['levels'], ['', 'student', 'entry', 'mid', 'senior', 'lead'])
        self.assertEqual(at['langs'], ['en', 'de', 'fr', 'es'])
        self.assertEqual(len(at['a']), 5)
        self.assertTrue(all(len(row) == 6 for row in at['a']))

    def test_attribute_codes_point_at_the_lists(self):
        at = self.load('match-attrs.json')
        for row in at['a']:
            self.assertLess(row[1], len(at['levels']))
            self.assertLess(row[3], len(at['regions']))
            self.assertLess(row[5], len(at['langs']))
        self.assertEqual(sorted(at['regions']), sorted(set(r['r'] for r in read_site(self.site)[1].values())))


class LevelOrderFromProfile(unittest.TestCase):
    def test_codes_follow_rank_not_list_order(self):
        profile = {'levels': [{'code': 'b', 'rank': 2}, {'code': 'a', 'rank': 0}, {'code': 'c', 'rank': 1}]}
        self.assertEqual(match_index.level_codes_of(profile), ['', 'a', 'c', 'b'])


@need_numpy
class StatementsOnSynthetic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='jc-prefs-')
        cls.site = os.path.join(cls.tmp, 'site')
        cls.out = os.path.join(cls.site, 'match')
        cls.profile = load_profile(PROFILE)
        index, pairs = board_for(make_catalog(160, seed=5), cls.profile, cls.site)
        os.makedirs(cls.out)
        write_match_vectors(cls.out, pairs, dim=16)                     # the match folder holds the vectors (publish copies them there)
        cls.statements = [
            {'id': 'autonomy', 'a': ['Independent work', 'Selbstständig'], 'b': ['Procedures', 'Verfahren'],
             'a_regex': 'independent', 'b_regex': 'procedures'},
            {'id': 'nothing', 'a': ['No', 'Nein'], 'b': ['Never', 'Nie'], 'a_regex': 'zzzz', 'b_regex': 'qqqq'},
        ]

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_separating_statement_is_published_with_its_direction(self):
        prefs.build(self.site, self.out, self.statements, log=lambda m: None)
        with open(os.path.join(self.out, 'match-prefs.json'), encoding='utf-8') as fh:
            doc = json.load(fh)
        self.assertEqual(doc['dim'], 16)
        ids = [p['id'] for p in doc['prefs']]
        self.assertEqual(ids, ['autonomy'])
        p = doc['prefs'][0]
        self.assertGreaterEqual(p['auc'], prefs.MIN_AUC)
        self.assertEqual(p['a'], ['Independent work', 'Selbstständig'])
        self.assertEqual(len(p['v']), 16)
        self.assertGreater(p['sd'], 0)

    def test_statement_without_roles_is_skipped_not_fatal(self):
        logged = []
        prefs.build(self.site, self.out, self.statements, log=logged.append)
        self.assertTrue(any('nothing skipped' in m for m in logged))

    def test_auc_helper(self):
        self.assertEqual(prefs.auc([3, 4], [1, 2]), 1.0)
        self.assertEqual(prefs.auc([1], [1]), 0.5)
        self.assertEqual(prefs.auc([], [1]), 0.5)

    def test_statements_of_profile_turns_labels_into_pairs(self):
        profile = load_profile(PROFILE)
        st = prefs.statements_of(profile)
        self.assertEqual(len(st), 5)
        self.assertEqual(st[0]['id'], 'autonomy')
        self.assertEqual(len(st[0]['a']), 2)


@need_numpy
class NeighboursOnSynthetic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='jc-nb-')
        cls.site = os.path.join(cls.tmp, 'site')
        cls.vectors = os.path.join(cls.tmp, 'vectors')
        cls.out = os.path.join(cls.tmp, 'out')
        cls.profile = load_profile(PROFILE)
        cls.items = make_catalog(60, seed=3)
        cls.index, cls.pairs = board_for(cls.items, cls.profile, cls.site)
        write_match_vectors(cls.vectors, cls.pairs, dim=16)
        os.makedirs(cls.out)
        cls.n = neighbours.build(cls.site, cls.vectors, cls.out, log=lambda m: None)
        with open(os.path.join(cls.out, 'role-graph.json'), encoding='utf-8') as fh:
            cls.graph = json.load(fh)
        import numpy as np
        with open(os.path.join(cls.out, 'role-nb.bin'), 'rb') as fh:
            cls.nb = np.frombuffer(fh.read(), np.uint16).reshape(cls.n, neighbours.K)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_file_shapes(self):
        self.assertEqual(self.n, len(self.index))
        self.assertEqual(self.nb.shape, (self.n, 10))
        self.assertEqual(self.graph['k'], 10)
        self.assertEqual(self.graph['ids_from'], 'match-vec.json')
        self.assertEqual(len(self.graph['sim']), self.n * 10)

    def test_no_self_neighbour_and_employer_cap(self):
        ids = [r[0] for r in self.index]
        emp = {r[0]: r[2] for r in self.index}
        for i in range(self.n):
            row = [int(x) for x in self.nb[i] if x != 65535]
            self.assertNotIn(i, row)
            companies = [emp[ids[j]] for j in row]
            for c in set(companies):
                self.assertLessEqual(companies.count(c), neighbours.PER_EMPLOYER)

    def test_closed_roles_take_no_neighbour_slot(self):
        """Vectors of roles no longer on the board (closed since they were embedded) are nobody's neighbour and get none."""
        import numpy as np
        vectors = os.path.join(self.tmp, 'vectors-closed'); out = os.path.join(self.tmp, 'out-closed')
        # the same texts again under ids the board does not have: the most similar vector of every role is a closed copy of it
        closed = [('c%07d' % k, t) for k, (_, t) in enumerate(self.pairs)]
        write_match_vectors(vectors, self.pairs + closed, dim=16)
        n = neighbours.build(self.site, vectors, out, log=lambda m: None)
        with open(os.path.join(out, 'role-nb.bin'), 'rb') as fh:
            nb = np.frombuffer(fh.read(), np.uint16).reshape(n, neighbours.K)
        on = len(self.pairs)
        self.assertTrue(all(j == 65535 or j < on for j in nb[:on].flatten()), 'a closed role is someone\'s neighbour')
        self.assertTrue((nb[on:] == 65535).all(), 'a closed role got neighbours')
        with open(os.path.join(out, 'role-graph.json'), encoding='utf-8') as fh:
            self.assertTrue(all(i < on for g in json.load(fh)['dup'] for i in g))

    def test_planted_duplicates_are_grouped(self):
        ids = [r[0] for r in self.index]
        pos = {rid: k for k, rid in enumerate(ids)}
        grouped = 0
        for k in range(len(self.items) // 10):
            src = self.items[k * 7 % len(self.items)]
            dup = [it for it in self.items if it['url'] == f'https://careers.example.com/board/dup-{k:04d}'][0]
            a, b = pos[board.role_id(src['url'])], pos[board.role_id(dup['url'])]
            if any(a in g and b in g for g in self.graph['dup']):
                grouped += 1
        self.assertGreater(grouped, 0)

    def test_roles_without_board_rows_are_their_own_group(self):
        logged = []
        import jobcrawl.index.neighbours as nbm
        vdir = os.path.join(self.tmp, 'other')
        os.makedirs(vdir)
        write_match_vectors(vdir, [('ffffffff', 'x' * 50)] + self.pairs[:3], dim=16)
        out2 = os.path.join(self.tmp, 'out2'); os.makedirs(out2)
        nbm.build(self.site, vdir, out2, log=logged.append)
        with open(os.path.join(out2, 'role-graph.json'), encoding='utf-8') as fh:
            g = json.load(fh)
        self.assertFalse(any(0 in grp for grp in g['dup']))


if __name__ == '__main__':
    unittest.main()
