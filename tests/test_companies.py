"""Company types (classify/companies.py): stage from facts, the academic check, evidence and gating, retired ids."""
import unittest
from datetime import date

from jobcrawl.classify import companies as co

TAX = {'types': [{'id': 'prime_integrator', 'seed': r'\bsystem integrator\b'}, {'id': 'product_developer', 'seed': r'\b(launch vehicles?|robotics)\b'},
                 {'id': 'research_institute', 'seed': r'\buniversit\w*\b', 'gated': True}, {'id': 'software_data', 'seed': r'\bsoftware\b', 'gated': True}],
       'name_rules': [{'type': 'research_institute', 'pattern': r'\b(universit\w*|institut\w*)\b'}],
       'retired': {'frontier_scaleup': 'product_developer'}, 'gate_all': True}


class CompaniesTest(unittest.TestCase):
    def test_stage_from_facts_only(self):
        today = date(2026, 10, 31)
        self.assertEqual(co.stage_of({'founded': '2022'}, 'product_developer', today), 'startup')
        self.assertEqual(co.stage_of({'founded': '2014', 'employees_range': '201-500'}, 'product_developer', today), 'scaleup')
        self.assertEqual(co.stage_of({'founded': '1970'}, 'component_supplier', today), 'established')
        self.assertEqual(co.stage_of({}, 'prime_integrator', today), 'established')
        self.assertEqual(co.stage_of({}, 'research_institute', today), 'academic')
        self.assertEqual(co.stage_of({}, 'component_supplier', today), 'unknown')

    def test_academic_entity_needs_an_academic_name(self):
        self.assertTrue(co._academic(TAX, {'entity_type': 'university_chair', 'name': 'TUM Department of Aerospace'}))
        self.assertTrue(co._academic(TAX, {'entity_type': 'research_institute', 'name': 'Leibniz-Institut für Festkörperforschung'}))
        self.assertFalse(co._academic(TAX, {'entity_type': 'university_chair', 'name': 'Quantum Motion'}))

    def test_evidence_reads_curated_fields_only(self):
        cat = {'a': {'slug': 'a', 'name': 'Rocketeers', 'field': 'Launch vehicles', 'capabilities': ['Avionics & Flight Software']},
               'b': {'slug': 'b', 'name': 'Vague GmbH', 'profile': {'en': 'We build software and more.'}},
               'c': {'slug': 'c', 'name': 'Old Scaleup', 'arch': 'frontier_scaleup'}}
        ev = co._evidence(TAX, cat, [(s, co.text_of(c), c['name']) for s, c in cat.items()])
        self.assertIn('product_developer', ev['a'])
        self.assertNotIn('software_data', ev['a'])          # the generated capability list is no evidence
        self.assertEqual(ev['b'] - {''}, set())               # the profile prose is no evidence either: unclassified
        self.assertIn('product_developer', ev['c'])          # a retired catalogue type resolves

    def test_retired_resolve(self):
        self.assertEqual(co.resolve(TAX, 'frontier_scaleup'), 'product_developer')
        self.assertEqual(co.resolve(TAX, 'nope'), '')


if __name__ == '__main__':
    unittest.main()
