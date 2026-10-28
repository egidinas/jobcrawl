"""geomap (jobcrawl geomap): the cartogram of two synthetic squares, the Natural Earth loader on a cache folder, and publish copying geo-map.json.

Two squares side by side with 3:1 roles: the area ratio is 3 +- 0.3, no cell folds, the total area is kept within 2 %, and the cartogram
error is below 5 %. The square case needs numpy (skipped with the reason otherwise); the loader and publish cases do not.
"""
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from synthetic import HAVE_NUMPY, NUMPY_REASON
from jobcrawl import board
from jobcrawl.index import publish
from jobcrawl.profile import load_profile
from jobcrawl.map import geo_base

HERE = os.path.dirname(os.path.abspath(__file__))
PROFILE = os.path.join(os.path.dirname(HERE), 'profiles', 'aerospace')
FIXTURE = os.path.join(HERE, 'fixtures', 'catalog.json')
need_numpy = unittest.skipUnless(HAVE_NUMPY, NUMPY_REASON)


def silent(message):
    pass


class SquaresCartogram(unittest.TestCase):
    """Two squares in the unit extent; the masses 3 (left, one role cluster) and 1 (right)."""

    @need_numpy
    def test_area_follows_roles(self):
        import numpy as np
        from jobcrawl.map import geomap as g
        left = np.array([[0, 0], [0.5, 0], [0.5, 1], [0, 1]], float)
        right = np.array([[0.5, 0], [1, 0], [1, 1], [0.5, 1]], float)
        points = np.array([[0.25, 0.5, 3.0], [0.75, 0.5, 1.0]])
        res = g.cartogram({'A': [left], 'B': [right]}, points, 1.0, 1.0, grid=256, log=silent)
        carto = res['map']

        def area(ring):
            return g.poly_area(carto.apply(g.densify(ring, 0.25 / 256)))     # edges cut finely: the transform bends them
        a, b = area(left), area(right)
        self.assertAlmostEqual(a / b, 3.0, delta=0.3)
        self.assertGreater(res['folds'], 0.0)                                 # no cell is folded (its area stays positive)
        self.assertLess(abs(a + b - 1.0), 0.02)                               # the total area is kept
        self.assertLess(res['error'], 0.05)

    @need_numpy
    def test_moderate_distorts_less_than_full(self):
        import numpy as np
        from jobcrawl.map import geomap as g
        left = np.array([[0, 0], [0.5, 0], [0.5, 1], [0, 1]], float)
        right = np.array([[0.5, 0], [1, 0], [1, 1], [0.5, 1]], float)
        points = np.array([[0.25, 0.5, 3.0], [0.75, 0.5, 1.0]])

        def left_share(gamma):
            carto = g.cartogram({'A': [left], 'B': [right]}, points, 1.0, 1.0, grid=128, log=silent, gamma=gamma)['map']
            def area(ring):
                return g.poly_area(carto.apply(g.densify(ring, 0.25 / 128)))
            a, b = area(left), area(right)
            return a / (a + b)
        true_share = 0.5                                                      # the squares have equal area in the plane
        full = left_share(1.0)
        moderate = left_share(g.MODERATE)
        self.assertLess(true_share, moderate)                                 # the densest square grows, but
        self.assertLess(moderate, full)                                       # less than under the full cartogram


class AnnealedNested(unittest.TestCase):
    """A small dense shape inside a big sparse one (with a hole): the staged map gives it its share, and a diverging stage falls back."""

    def setUp(self):
        import numpy as np
        self.outer = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], float)
        self.hole = np.array([[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]], float)
        self.rings = {'BIG': [self.outer, self.hole], 'SMALL': [self.hole.copy()]}
        self.roles = {'BIG': 1.0, 'SMALL': 2.0}

    def shares(self, carto, grid):
        from jobcrawl.map import geomap as g
        def area(rings):
            return sum(g.poly_area(carto.apply(g.densify(r, 0.25 / grid))) * (1 if i == 0 else -1) for i, r in enumerate(rings))
        big, sm = area([self.outer, self.hole]), area([self.hole])
        return sm / (big + sm)

    @need_numpy
    def test_small_dense_shape_inside_big_sparse_one_reaches_its_share(self):
        from jobcrawl.map import geomap as g
        res = g.cartogram_staged(self.rings, self.roles, 1.0, 1.0, (8.0, 4.0, 2.0, 1.0), grid=128, log=silent)
        self.assertTrue(res['ok'])
        self.assertGreater(res['folds'], 0.0)
        self.assertAlmostEqual(self.shares(res['map'], 128), 2.0 / 3.0, delta=0.2 * 2.0 / 3.0)

    @need_numpy
    def test_diverging_stage_falls_back_to_the_single_stage(self):
        from jobcrawl.map import geomap as g
        import numpy as np
        pts = np.array([[0.2, 0.5, 1.0], [0.5, 0.5, 2.0]])                   # the roles' places: one per shape
        res, method = g.annealed(self.rings, pts, self.roles, 1.0, 1.0, km_per_cell=5.0, grid=128, log=silent)
        self.assertEqual(method, 'staged')
        res, method = g.annealed(self.rings, pts, self.roles, 1.0, 1.0, km_per_cell=5.0, grid=128, log=silent, stage_limit=1e-9)
        self.assertEqual(method, 'single')                                    # every stage "diverges" under the tiny limit
        self.assertGreater(res['folds'], 0.0)
        self.assertLess(res["error"], 0.05)                                  # the single stage converges (its share is the known leak)


class ScopeMapOutput(unittest.TestCase):
    """scope_map on two synthetic countries (3:1 roles): rings carry true, full and moderate positions, places and companies carry mx, my,
    and the scope records its moderate map."""

    @need_numpy
    def test_output_has_the_moderate_positions(self):
        from jobcrawl.map import geomap as g
        square = lambda x0: [[x0, 0.0], [x0 + 1.0, 0.0], [x0 + 1.0, 1.0], [x0, 1.0]]     # (lon, lat), 1 degree squares
        shapes = {'countries': [{'id': 'A', 'name': 'Alpha', 'kind': 'country', 'cc': 'AA', 'rings': [square(0.0)]},
                                {'id': 'B', 'name': 'Beta', 'kind': 'country', 'cc': 'BB', 'rings': [square(1.0)]}], 'states': []}
        table = {'AA|Alpha': {'key': 'AA|Alpha', 'name': 'Alpha', 'cc': 'AA', 'n': 3, 'share': 3.0, 'll': (0.5, 0.5), 'shape': 'A'},
                 'BB|Beta': {'key': 'BB|Beta', 'name': 'Beta', 'cc': 'BB', 'n': 1, 'share': 1.0, 'll': (0.5, 1.5), 'shape': 'B'}}
        companies = [('acme', (0.5, 0.5))]
        real = g.annealed
        small = lambda *a, **k: real(*a, **dict({'grid': 128}, **k))                       # a coarse grid keeps the test fast
        with mock.patch.object(g, 'GRID', 128), mock.patch.object(g, 'annealed', small):
            out = g.scope_map({'id': 'test'}, (0.0, 0.0, 2.0, 1.0), 1.0, shapes, table, companies, {'A': 3.0, 'B': 1.0}, log=silent)
        self.assertEqual(out['moderate']['gamma'], g.MODERATE)
        self.assertIn(out['moderate']['method'], ('staged', 'single'))
        self.assertIn('error', out['moderate'])
        rings = [r for sh in out['shapes'] for r in sh['rings']]
        self.assertTrue(rings)
        for ring in rings:
            for pt in ring:
                self.assertEqual(len(pt), 6)                                  # x, y, cx, cy, mx, my
        self.assertEqual(len(out['places']), 2)
        for place in out['places']:
            self.assertIn('mx', place)
            self.assertIn('my', place)
        self.assertEqual(len(out['companies']), 1)
        self.assertIn('mx', out['companies'][0])
        self.assertIn('my', out['companies'][0])


class NaturalEarthCache(unittest.TestCase):
    """geo_base.load reads the two files from the cache folder (no download) and keeps the countries other than the states' country."""

    def test_loads_countries_and_states_from_cache(self):
        tmp = tempfile.mkdtemp(prefix='jc-geomap-')
        try:
            poly = {'type': 'Polygon', 'coordinates': [[[8, 47], [9, 47], [9, 48], [8, 48], [8, 47]]]}
            countries = {'type': 'FeatureCollection', 'features': [
                {'geometry': poly, 'properties': {'ISO_A2': '-99', 'ISO_A2_EH': 'FR', 'NAME': 'France'}},
                {'geometry': poly, 'properties': {'ISO_A2': 'DE', 'ISO_A2_EH': 'DE', 'NAME': 'Germany'}},
                {'geometry': poly, 'properties': {'ISO_A2': '-99', 'ISO_A2_EH': '-99', 'NAME': 'Somaliland'}}]}
            states = {'type': 'FeatureCollection', 'features': [
                {'geometry': poly, 'properties': {'iso_a2': 'DE', 'iso_3166_2': 'DE-BY', 'name': 'Bayern', 'name_en': 'Bavaria',
                                                  'name_de': 'Bayern', 'woe_name': 'Bayern'}},
                {'geometry': poly, 'properties': {'iso_a2': 'US', 'iso_3166_2': 'US-CA', 'name': 'California', 'name_en': 'California'}}]}
            for name, data in ((geo_base.COUNTRIES_FILE, countries), (geo_base.STATES_FILE, states)):
                with open(os.path.join(tmp, name), 'w', encoding='utf-8') as fh:
                    json.dump(data, fh)
            shapes = geo_base.load(tmp, ('DE',), log=silent)
            self.assertEqual([s['id'] for s in shapes['countries']], ['FR'])
            self.assertEqual([(s['id'], s['name']) for s in shapes['states']], [('DE-BY', 'Bavaria')])
            self.assertEqual(shapes['unmatched'], [])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class PublishGeomap(unittest.TestCase):
    """publish copies VECTORS/geo-map.json into SITE/match/ and names it in config.json (no numpy needed)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='jc-geomap-publish-')
        cls.profile = load_profile(PROFILE)
        cls.site = os.path.join(cls.tmp, 'site')
        board.build(cls.profile, FIXTURE, cls.site)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_copies_geomap_and_names_it_in_config(self):
        vectors = os.path.join(self.tmp, 'vectors-geo')
        os.makedirs(vectors)
        with open(os.path.join(vectors, 'geo-map.json'), 'w', encoding='utf-8') as fh:
            json.dump({'version': 1, 'scopes': {}}, fh)
        site = os.path.join(self.tmp, 'site-geo')
        shutil.copytree(self.site, site)
        files = publish.publish(site, self.profile, vectors, log=silent)
        self.assertIn('match/geo-map.json', files)
        self.assertTrue(os.path.exists(os.path.join(site, 'match', 'geo-map.json')))
        with open(os.path.join(site, 'config.json'), encoding='utf-8') as fh:
            self.assertEqual(json.load(fh)['geomap'], 'match/geo-map.json')

    def test_without_geomap_the_config_has_no_key(self):
        vectors = os.path.join(self.tmp, 'vectors-none')
        os.makedirs(vectors)
        site = os.path.join(self.tmp, 'site-none')
        shutil.copytree(self.site, site)
        publish.publish(site, self.profile, vectors, log=silent)
        self.assertFalse(os.path.exists(os.path.join(site, 'match', 'geo-map.json')))
        with open(os.path.join(site, 'config.json'), encoding='utf-8') as fh:
            self.assertNotIn('geomap', json.load(fh))


if __name__ == '__main__':
    unittest.main()
