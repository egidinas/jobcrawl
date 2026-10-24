"""The atlas: the layout on a synthetic set of roles, and the group names from a labels file.

The layout needs the map extra (umap-learn, leidenalg, igraph, scipy); without it those tests are skipped with the reason.
The labels tests need nothing beyond the standard library and numpy-free data, so they always run.
"""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest

from synthetic import HAVE_NUMPY, NUMPY_REASON, board_for, make_catalog, write_company_vectors, write_match_vectors
from jobcrawl.map import labels
from jobcrawl.profile import load_profile

HERE = os.path.dirname(os.path.abspath(__file__))
PROFILE = os.path.join(os.path.dirname(HERE), 'profiles', 'aerospace')
MISSING = [m for m in ('umap', 'leidenalg', 'igraph', 'scipy') if importlib.util.find_spec(m) is None]
need_map = unittest.skipUnless(HAVE_NUMPY and not MISSING,
                               NUMPY_REASON if not HAVE_NUMPY else 'the map extra is not installed (missing: %s; pip install -r requirements-map.txt)' % ', '.join(MISSING))
COMPANIES = ['Company %02d GmbH' % k for k in range(20)]


class LabelsNeedNoLibraries(unittest.TestCase):
    def layout(self):
        return {'roles': {'ids': ['r1', 'r2', 'r3', 'r4'], 'c1': [0, 0, 1, 1], 'c2': [0, 0, 1, 1],
                          'regions': [{'n': 2, 'words': []}, {'n': 2, 'words': []}], 'hoods': [{'n': 2}, {'n': 2}]},
                'scopes': {}, 'companies': {'slugs': ['a', 'b', 'c'], 'c1': [0, 0, 1], 'regions': [{'n': 2}, {'n': 1}]}}

    def test_a_name_goes_to_the_group_that_holds_its_sample(self):
        out = self.layout()
        lab = {'roles': {'worldwide': {'regions': [{'en': 'First', 'de': 'Erste', 'sample': ['r1', 'r2']},
                                                    {'en': 'Second', 'de': 'Zweite', 'sample': ['r3']}],
                                       'hoods': []}}, 'companies': [{'en': 'Firms', 'de': 'Firmen', 'sample': ['a', 'b']}]}
        n = labels.apply_labels(out, lab)
        self.assertEqual(out['roles']['regions'][0]['label'], ['First', 'Erste'])
        self.assertEqual(out['roles']['regions'][1]['label'], ['Second', 'Zweite'])
        self.assertEqual(out['companies']['regions'][0]['label'], ['Firms', 'Firmen'])
        self.assertEqual(n, 3)

    def test_a_small_share_is_not_a_name(self):
        out = self.layout()
        lab = {'roles': {'worldwide': {'regions': [{'en': 'Mixed', 'de': 'Gemischt', 'sample': ['r1', 'r3', 'x', 'y', 'z']}], 'hoods': []}}}   # 1 in 5 per group: below 40 %
        self.assertEqual(labels.apply_labels(out, lab), 0)
        self.assertNotIn('label', out['roles']['regions'][0])

    def test_no_labels_names_nothing(self):
        out = self.layout()
        self.assertEqual(labels.apply_labels(out, None), 0)

    def test_missing_labels_file_falls_back_to_word_labels(self):
        logged = []
        profile = {'map': {'labels_file': 'nope.json'}, '_dir': tempfile.gettempdir()}
        self.assertIsNone(labels.load_labels(profile, logged.append))
        self.assertTrue(any('word labels' in m for m in logged))
        self.assertIsNone(labels.load_labels({'map': {'labels_file': None}, '_dir': '.'}))


@need_map
class AtlasOnSynthetic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from jobcrawl.map import atlas
        cls.atlas = atlas
        cls.tmp = tempfile.mkdtemp(prefix='jc-atlas-')
        cls.site = os.path.join(cls.tmp, 'site')
        cls.vectors = os.path.join(cls.tmp, 'vectors')
        profile = load_profile(PROFILE)
        cls.index, pairs = board_for(make_catalog(300, seed=11, companies=COMPANIES), profile, cls.site)
        write_match_vectors(cls.vectors, pairs, dim=16)
        write_company_vectors(cls.vectors, sorted({r[4] for r in cls.index if r[4]}), dim=16)
        with open(os.path.join(cls.tmp, 'labels.json'), 'w', encoding='utf-8') as fh:
            json.dump({'roles': {}, 'companies': []}, fh)
        cls.profile = dict(profile, _dir=cls.tmp, map=dict(profile['map'], min_scope=60, labels_file='labels.json'))
        logged = []
        cls.path = atlas.build(cls.site, cls.vectors, cls.profile, log=logged.append)
        with open(cls.path, encoding='utf-8') as fh:
            cls.out = json.load(fh)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_layout_covers_every_role_and_company(self):
        R = self.out['roles']
        n = len(self.index)
        self.assertEqual(self.out['version'], 2)
        self.assertEqual(len(R['ids']), n)
        self.assertEqual(len(R['x']), n)
        self.assertEqual(len(R['c1']), n)
        self.assertEqual(len(self.out['companies']['slugs']), 20)
        self.assertTrue(all(0 <= v <= 1 for v in R['x']))

    def test_scope_maps_use_the_profile_scopes(self):
        ids = {s['id'] for s in self.profile['scopes'] if not (s.get('match') or {}).get('any')}
        self.assertTrue(set(self.out['scopes']) <= ids)
        for sid, m in self.out['scopes'].items():
            self.assertLessEqual(len(m['ids']), 300)
            self.assertGreaterEqual(len(m['ids']), 60)

    def test_profile_map_settings_are_recorded(self):
        self.assertEqual(self.out['k'], 15)
        self.assertEqual(self.out['layout_k'], 45)
        self.assertEqual(self.out['resolution'], [1.6, 5.0])
        self.assertEqual(self.out['reps_per_company_and_group'], 3)

    def test_regions_and_links_have_their_shape(self):
        regions = self.out['roles']['regions']
        representatives = sum(1 for r in self.out['roles']['rep'] if r == -1)      # region sizes count the representatives, not every role
        self.assertEqual(sum(g['n'] for g in regions), representatives)
        self.assertLess(representatives, len(self.index))
        for g in regions:
            self.assertIn('xy', g)
            self.assertEqual(len(g['xy']), 2)
        self.assertIsInstance(self.out['roles']['links'], list)

    def test_the_labels_file_names_a_group(self):
        with open(os.path.join(self.tmp, 'labels.json'), 'w', encoding='utf-8') as fh:
            json.dump({'roles': {'worldwide': {'regions': [{'en': 'Named', 'de': 'Benannt',
                                                              'sample': [i for i, c in zip(self.out['roles']['ids'], self.out['roles']['c1']) if c == 0]}],
                                               'hoods': []}}}, fh)
        self.atlas.labels_only(self.vectors, self.profile, log=lambda m: None)
        with open(self.path, encoding='utf-8') as fh:
            again = json.load(fh)
        self.assertEqual(again['roles']['regions'][0].get('label'), ['Named', 'Benannt'])


if __name__ == '__main__':
    unittest.main()
