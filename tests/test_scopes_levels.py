"""Scopes from places, the region label, and the seniority bands and ladder."""
import os
import unittest

from jobcrawl.classify.levels import compile_levels, level_of
from jobcrawl.classify.scopes import region_label, scope_ids
from jobcrawl.classify.seniority import level as ladder
from jobcrawl.geo import geo
from jobcrawl.profile import load_profile

PROFILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'profiles', 'aerospace')


class Scopes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scopes = load_profile(PROFILE)['scopes']

    def ids(self, location):
        return scope_ids(geo.resolve(location)['places'], self.scopes)

    def test_bavaria_belongs_to_all_wider_scopes(self):
        self.assertEqual(self.ids('München, BY, DEU, 80809'), ['bavaria', 'germany', 'europe', 'worldwide'])

    def test_other_german_place(self):
        self.assertEqual(self.ids('Berlin, Germany'), ['germany', 'europe', 'worldwide'])

    def test_other_european_place(self):
        self.assertEqual(self.ids('Paris, France'), ['europe', 'worldwide'])

    def test_elsewhere_is_worldwide_only(self):
        self.assertEqual(self.ids('Tokyo, Japan'), ['worldwide'])

    def test_no_place_is_worldwide(self):
        self.assertEqual(self.ids('Unspecified'), ['worldwide'])
        self.assertEqual(self.ids('Remote'), ['worldwide'])

    def test_several_places_take_the_narrowest(self):
        self.assertEqual(self.ids('Tokyo / Munich'), ['bavaria', 'germany', 'europe', 'worldwide'])

    def test_region_label(self):
        g = geo.resolve('Berlin, Germany')['places']
        self.assertEqual(region_label(g, self.scopes), 'Germany')
        self.assertEqual(region_label(g, self.scopes, 'de'), 'Deutschland')
        self.assertEqual(region_label([], self.scopes), 'Worldwide')
        self.assertEqual(region_label([], self.scopes, 'de'), 'Weltweit')


class Levels(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.compiled = compile_levels(load_profile(PROFILE)['levels'])

    def test_bands(self):
        cases = {
            'Working student, team lead assistant': 'student',   # student wins over lead
            'Lead Test Engineer': 'lead',
            'Project Manager': 'lead',
            'Senior Engineer': 'senior',
            'Junior Systems Engineer': 'entry',
            'Engineer': 'mid',
            'Teamleiter Fertigung': 'lead',
        }
        for title, code in cases.items():
            self.assertEqual(level_of(title, self.compiled), code, title)

    def test_no_default_band_gives_empty(self):
        compiled = compile_levels([{'code': 'a', 'pattern': r'\bsenior\b'}])
        self.assertEqual(level_of('Engineer', compiled), '')


class Ladder(unittest.TestCase):
    def test_rungs(self):
        self.assertEqual(ladder('Head of Test Engineering'), ('Head', ['Head']))
        self.assertEqual(ladder('Senior Systems Engineer')[0], 'Senior')
        self.assertEqual(ladder('Working Student Thermal')[0], 'Student')
        self.assertEqual(ladder('Doctoral Candidate Optics')[0], 'Doctoral')
        self.assertEqual(ladder('Engineer'), ('', []))

    def test_highest_rung_wins(self):
        self.assertEqual(ladder('Director, Principal Engineer')[0], 'Director')


if __name__ == '__main__':
    unittest.main()
