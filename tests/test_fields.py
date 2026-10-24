"""Field tags: whole-word and substring keywords, accents, the pillar order and the cap (crawler/relevance.mjs syntax)."""
import os
import unittest

from jobcrawl.classify.fields import Matcher, field_tags
from jobcrawl.profile import load_profile

PROFILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'profiles', 'aerospace')


def fields_of(*specs):
    return [dict({'pillar': False, 'company_keywords': []}, **s) for s in specs]


class MatcherTest(unittest.TestCase):
    def test_word_entries_need_whole_words(self):
        m = Matcher(['word:cad'])
        self.assertTrue(m('CAD engineer'))
        self.assertTrue(m('Engineer (CAD-Konstruktion)'))
        self.assertFalse(m('cadence engineer'))

    def test_plain_entries_are_substrings(self):
        m = Matcher(['thermal'])
        self.assertTrue(m('thermally stable design'))

    def test_accents_are_removed_on_both_sides(self):
        self.assertTrue(Matcher(['prufer'])('Prüfer für Antennen'))
        self.assertTrue(Matcher(['pruf'])('Prüfstand'))

    def test_word_phrase_and_symbols(self):
        m = Matcher(['word:c++', 'word:launch vehicle'])
        self.assertTrue(m('Senior C++ developer'))
        self.assertTrue(m('Launch Vehicle avionics'))
        self.assertFalse(m('Launch vehicles and more'))

    def test_empty_text_matches_nothing(self):
        self.assertFalse(Matcher(['software'])(''))
        self.assertFalse(Matcher(['word:x'])(None))


class FieldTagsTest(unittest.TestCase):
    def test_keywords_text_and_company(self):
        fields = fields_of({'id': 'optics', 'keywords': ['word:laser']}, {'id': 'rf', 'keywords': ['word:radar']})
        self.assertEqual(field_tags('Laser engineer', 'radar nearby', '', fields), ['optics', 'rf'])

    def test_company_keywords_count_for_pillars_only_by_their_text_rule(self):
        fields = fields_of({'id': 'space', 'pillar': True, 'keywords': [], 'company_keywords': ['orbit']})
        self.assertEqual(field_tags('Engineer', '', 'Aster Orbital Ops', fields), ['space'])
        plain = fields_of({'id': 'x', 'keywords': [], 'company_keywords': ['orbit']})
        self.assertEqual(field_tags('Engineer', '', 'Aster Orbital Ops', plain), [])

    def test_pillars_come_first_then_title_then_text(self):
        fields = fields_of(
            {'id': 'prop', 'keywords': ['word:propulsion']},
            {'id': 'space', 'pillar': True, 'keywords': ['word:satellite']},
            {'id': 'sw', 'keywords': ['word:python']},
        )
        # the pillar matches on the description; propulsion matches on the title, python only on the description
        self.assertEqual(field_tags('Propulsion engineer', 'satellite and python code', '', fields), ['space', 'prop', 'sw'])

    def test_title_match_beats_text_match_under_the_cap(self):
        fields = fields_of(*[{'id': f'f{i}', 'keywords': [f'word:k{i}']} for i in range(4)])
        text = 'k0 k1 k2 k3'
        self.assertEqual(field_tags('k3 role', text, '', fields, max_tags=2), ['f3', 'f0'])

    def test_cap_and_no_duplicates(self):
        fields = fields_of({'id': 'a', 'keywords': ['word:x']}, {'id': 'b', 'keywords': ['word:x']}, {'id': 'c', 'keywords': ['word:x']})
        self.assertEqual(field_tags('x', 'x', '', fields, max_tags=2), ['a', 'b'])

    def test_no_match_is_empty(self):
        fields = fields_of({'id': 'a', 'keywords': ['word:laser']})
        self.assertEqual(field_tags('Accountant', 'bookkeeping', 'Foo', fields), [])


class AerospaceRulesTest(unittest.TestCase):
    """The keyword rules of the reference profile give the tags of the reference board (tools/update_jobs.py TAG_RULES)."""
    @classmethod
    def setUpClass(cls):
        cls.fields = load_profile(PROFILE)['fields']

    def tags(self, title, text='', company=''):
        return field_tags(title, text, company, self.fields, 5)

    def test_cases_checked_against_the_reference_board(self):
        cases = [
            ('Senior Structural Engineer (CAD, FEM) Munich', [], ['structures_cad']),
            ('Thermal vacuum test engineer for satellite payloads', [], ['ait_testing', 'space', 'thermal_tvac']),
            ('Software Engineer Python C++ backend', [], ['software_ai']),
            ('Optical lab technician laser photonics', [], ['deep_tech', 'optics_laser']),
            ('Cryogenic cooling rig', [], ['propulsion', 'thermal_tvac']),
            ('Workspace planner', [], []),
            ('Galaxy space mission agency', [], ['space']),
        ]
        for title, text, want in cases:
            self.assertEqual(sorted(self.tags(title, text)), sorted(want), title)

    def test_pillar_company_names(self):
        self.assertIn('defense', self.tags('Engineer', '', 'Hensoldt GmbH'))


if __name__ == '__main__':
    unittest.main()
