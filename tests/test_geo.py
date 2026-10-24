"""Regression test for jobcrawl/geo/geo.py (ported from the reference board's tools/test_geo.py): python -m unittest tests.test_geo

The golden strings are real location texts from the feed plus the usual traps (state codes that are also countries, cities that exist in
several countries, text that merely contains a place name). If a change moves any of them, the diff shows which."""
import sys
import unittest

from jobcrawl.geo import geo

# raw text -> list of (city, state, country); '' where not known
GOLDEN = {
    'München, DE': [('Munich', 'Bavaria', 'DE')],
    'MÜNCHEN, Bavaria, Germany': [('Munich', 'Bavaria', 'DE')],
    'Munich / Bavaria / Germany': [('Munich', 'Bavaria', 'DE')],
    'Munich (Unterföhring), DE': [('Munich', 'Bavaria', 'DE')],
    'Garching b. München (DE)': [('Garching', 'Bavaria', 'DE')],
    'Gräfelfing / Munich / Germany': [('Gräfelfing', 'Bavaria', 'DE')],
    'München, BY, DEU, 80809': [('Munich', 'Bavaria', 'DE')],
    '28359, Bremen': [('Bremen', 'Bremen', 'DE')],
    'Munich | Amsterdam, NL': [('Munich', 'Bavaria', 'DE'), ('Amsterdam', '', 'NL')],
    'Rockville, MD or Hawthorne, CA': [('Rockville', 'Maryland', 'US'), ('Hawthorne', 'California', 'US')],
    'Dublin, CA': [('Dublin', 'California', 'US')],
    'Dublin, Ireland': [('Dublin', '', 'IE')],
    'Lemont, IL USA': [('Lemont', 'Illinois', 'US')],
    'Santa Rosa, CA USA': [('Santa Rosa', 'California', 'US')],
    'USA Saint Louis MO (Customer Site)': [('Saint Louis', 'Missouri', 'US')],
    'US-NY-Farmingdale (Sensors)': [('Farmingdale', 'New York', 'US')],
    'Springfield, IL': [('Springfield', 'Illinois', 'US')],
    'Hsinchu': [('Hsinchu', '', 'TW')],
    'Taichung': [('Taichung', '', 'TW')],
    'Singapore': [('', '', 'SG')],   # a city-state: country level
    'Toulouse, France': [('Toulouse', '', 'FR')],
}
LEVEL = {'Europe': 'continent', 'Germany': 'country', 'Unspecified': 'none', 'Remote': 'none'}


def check():
    """Returns the list of failures (empty when every golden case holds)."""
    bad = []
    for text, want in GOLDEN.items():
        got = [(p['city'], p['state'], p['country']) for p in geo.resolve(text)['places']]
        if got != want:
            bad.append(f'{text!r}: want {want}, got {got}')
    for text, lv in LEVEL.items():
        got = geo.resolve(text if text != 'Unspecified' else '')['level']
        if got != lv:
            bad.append(f'{text!r}: want level {lv}, got {got}')
    # the 58 Munich spellings of the feed collapse to one city
    spellings = ['München', 'Munich', 'MUNICH', 'München, Deutschland', 'Munich, Germany', 'Munich, DE', 'Muenchen', 'München, Bayern', 'Munich, Bavaria']
    for t in spellings:
        p = geo.resolve(t)['primary']
        if not p or (p['city'], p['country']) != ('Munich', 'DE'):
            bad.append(f'Munich spelling {t!r} -> {p}')
    return bad


class GeoGoldenTest(unittest.TestCase):
    def test_golden_cases(self):
        bad = check()
        self.assertEqual(bad, [], '\n'.join(bad))


if __name__ == '__main__':
    sys.exit(unittest.main())
