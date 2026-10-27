"""geomap (jobcrawl geomap): the cartogram of two synthetic squares, the Natural Earth loader on a cache folder, and publish copying geo-map.json.

Two squares side by side with 3:1 roles: the area ratio is 3 +- 0.3, no cell folds, the total area is kept within 2 %, and the cartogram
error is below 5 %. The square case needs numpy (skipped with the reason otherwise); the loader and publish cases do not.
"""
import json
import os
import shutil
import tempfile
import unittest

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
