"""Functions (classify/functions.py) and domains (classify/domains.py): fit, assign, continuity, hybrids, the title-only cap, retired ids."""
import json
import os
import tempfile
import unittest

import numpy as np

from jobcrawl.classify import domains, functions

TAX = {'version': 1,
       'families': [{'id': 'software', 'en': 'Software', 'de': 'Software', 'hue': 250}, {'id': 'quality', 'en': 'Quality', 'de': 'Qualität', 'hue': 160}],
       'functions': [{'id': 'software.engineering', 'en': 'Software Engineering', 'de': 'Softwareentwicklung', 'seed': r'\bsoftware engineer\b'},
                     {'id': 'software.data', 'en': 'Data', 'de': 'Daten', 'seed': r'\bdata (engineer|scientist)\b'},
                     {'id': 'quality.assurance', 'en': 'Quality', 'de': 'Qualität', 'seed': r'\bquality (engineer|manager)\b'}],
       'retired': {'software.backend': 'software.engineering'}}


def toy(n=60, seed=0):
    """Three groups of roles: vectors around three directions, titles that name them (a few senior and director titles mixed in)."""
    rng = np.random.default_rng(seed)
    base = np.eye(3, 16)
    rows, X = [], []
    names = [('Software Engineer', 'Senior Software Engineer', 'Director Software'), ('Data Engineer', 'Senior Data Scientist', 'Head of Data'),
             ('Quality Engineer', 'Senior Quality Manager', 'Director Quality')]
    for g in range(3):
        for i in range(n):
            rows.append((f'{g}-{i}', names[g][i % 3], 'Acme GmbH'))
            v = base[g] + 0.15 * rng.normal(size=16)
            X.append(v / np.linalg.norm(v))
    return rows, np.array(X, np.float32)


class FunctionsTest(unittest.TestCase):
    def test_fit_assigns_by_meaning_and_title(self):
        rows, X = toy()
        model, out = functions.fit(rows, X, np.ones(len(rows), bool), TAX, log=lambda m: None)
        want = {'0': 'software.engineering', '1': 'software.data', '2': 'quality.assurance'}
        ok = sum(out[r[0]][0] == want[r[0][0]] for r in rows)
        self.assertGreaterEqual(ok / len(rows), 0.95)
        self.assertEqual(model['functions'], [f['id'] for f in TAX['functions']])

    def test_assign_matches_fit_and_keeps_groups(self):
        rows, X = toy()
        has = np.ones(len(rows), bool)
        model, out = functions.fit(rows, X, has, TAX, log=lambda m: None)
        again = functions.assign(json.loads(json.dumps(model)), rows, X, has, TAX)      # through JSON, as stored
        same = sum(again[k][0] == out[k][0] for k in out)
        self.assertGreaterEqual(same / len(out), 0.98)
        # a refit seeded from the last assignment keeps it
        prev = {k: v[0] for k, v in out.items()}
        _, refit = functions.fit(rows, X, has, TAX, previous=prev, log=lambda m: None)
        self.assertGreaterEqual(sum(refit[k][0] == out[k][0] for k in out) / len(out), 0.98)

    def test_title_only_is_capped(self):
        rows, X = toy()
        model, _ = functions.fit(rows, X, np.ones(len(rows), bool), TAX, log=lambda m: None)
        out = functions.assign(model, [('x', 'Software Engineer', 'Other')], np.zeros((1, X.shape[1]), np.float32), np.zeros(1, bool))
        self.assertEqual(out['x'][0], 'software.engineering')
        self.assertLessEqual(out['x'][2], functions.TITLE_ONLY_CAP)

    def test_employer_name_is_no_evidence(self):
        self.assertNotIn('quantum', functions.tokens('Production Manager - Quantum Frontline', 'Quantum Systems'))
        self.assertIn('production', functions.tokens('Production Manager', 'Quantum Systems'))

    def test_retired_ids_resolve(self):
        self.assertEqual(functions.resolve(TAX, 'software.backend'), 'software.engineering')
        self.assertEqual(functions.resolve(TAX, 'gone.away'), '')

    def test_functions_file_checks(self):
        with tempfile.TemporaryDirectory() as d:
            bad = dict(TAX, functions=TAX['functions'] + [dict(TAX['functions'][0])])
            with open(os.path.join(d, 'f.json'), 'w') as fh:
                json.dump(bad, fh)
            with self.assertRaises(functions.FunctionsError):
                functions.load_functions({'_dir': d, 'functions_file': 'f.json'})


class DomainsTest(unittest.TestCase):
    DOMS = [{'id': 'space', 'pattern': r'\b(satellit\w*|spacecraft)\b', 'tags': ['space']},
            {'id': 'defence', 'pattern': r'\b(defen[cs]e|military)\b', 'tags': ['defense']},
            {'id': 'industry', 'pattern': r'\b(food|construction)\b', 'fallback': True}]

    def test_own_text_then_employer(self):
        rows = [('a', 'Satellite Engineer', '', 'orbital'), ('b', 'Accountant', '', 'orbital'), ('c', 'Accountant', '', 'nobody'),
                ('d', 'Military Systems Engineer', 'spacecraft and defence programmes', 'orbital')]
        cat = {'orbital': {'tags': ['space']}}
        out = domains.classify(rows, self.DOMS, cat)
        self.assertEqual(out['a'][0], 'space')
        self.assertEqual(out['b'][0], 'space')          # the employer's catalogue tag
        self.assertEqual(out['c'], ['industry', ''])     # no evidence: the fallback
        self.assertEqual(out['d'][0], 'defence')
        self.assertEqual(out['d'][1], 'space')          # a second domain when it is close


if __name__ == '__main__':
    unittest.main()
