"""Profile loading and validation: defaults, the shipped profiles, and errors that name the key."""
import json
import os
import shutil
import tempfile
import unittest

from jobcrawl.profile import DEFAULT_LEVELS, ProfileError, load_profile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROFILES = os.path.join(ROOT, 'profiles')


def write_profile(obj, folder=None):
    """Writes obj as profile.json in a temporary folder; returns the folder (removed by the caller's cleanup)."""
    folder = folder or tempfile.mkdtemp(prefix='jc-profile-')
    with open(os.path.join(folder, 'profile.json'), 'w', encoding='utf-8') as fh:
        json.dump(obj, fh, ensure_ascii=False)
    return folder


class ShippedProfiles(unittest.TestCase):
    def test_minimal_uses_defaults(self):
        p = load_profile(os.path.join(PROFILES, 'minimal'))
        self.assertEqual(p['name'], 'minimal')
        self.assertEqual(p['languages'], ['en'])
        self.assertEqual([s['id'] for s in p['scopes']], ['worldwide'])
        self.assertEqual(p['fields'], [])
        self.assertEqual(p['statements'], [])
        self.assertEqual(p['personas'], [])
        self.assertEqual(p['glossary'], [])
        self.assertEqual(p['map']['k'], 15)
        self.assertEqual(p['embed']['text_chars'], 700)
        self.assertEqual(p['crawl']['relevance']['keywords'][0], 'software')
        self.assertTrue(p['_dir'].endswith(os.path.join('profiles', 'minimal')))

    def test_aerospace_is_complete(self):
        p = load_profile(os.path.join(PROFILES, 'aerospace'))
        self.assertEqual([s['id'] for s in p['scopes']], ['bavaria', 'germany', 'europe', 'worldwide'])
        self.assertEqual(p['scopes'][0]['label'], {'en': 'Bavaria', 'de': 'Bayern'})
        self.assertEqual(len(p['fields']), 14)
        self.assertEqual([f['id'] for f in p['fields'] if f['pillar']], ['space', 'defense', 'deep_tech'])
        self.assertEqual(len(p['statements']), 5)
        self.assertEqual(len(p['personas']), 12)
        self.assertEqual(p['personas'][0]['flags'], 'i')
        self.assertEqual(len(p['glossary']), 115)
        self.assertEqual(p['map']['min_scope'], 600)
        self.assertEqual(p['map']['resolution'], [1.45, 5.3])
        self.assertEqual(p['crawl']['relevance']['keywords'][0], 'word:space')

    def test_aerospace_levels_are_the_default_bands(self):
        p = load_profile(os.path.join(PROFILES, 'aerospace'))
        self.assertEqual([(b['code'], b['pattern']) for b in p['levels']], [(b['code'], b['pattern']) for b in DEFAULT_LEVELS])


class Validation(unittest.TestCase):
    def setUp(self):
        self.folders = []

    def tearDown(self):
        for f in self.folders:
            shutil.rmtree(f, ignore_errors=True)

    def bad(self, obj, needle):
        folder = write_profile(obj)
        self.folders.append(folder)
        with self.assertRaises(ProfileError) as cm:
            load_profile(folder)
        self.assertIn(needle, str(cm.exception))
        return str(cm.exception)

    def test_wrong_type_names_key(self):
        self.bad({'crawl': {'relevance': {'keywords': ['ok', 3]}}}, 'crawl.relevance.keywords[1]')

    def test_field_keyword_names_index(self):
        self.bad({'fields': [{'id': 'a', 'label': {'en': 'A'}, 'keywords': 'x'}]}, 'fields[0].keywords')

    def test_bad_scope_match_names_key(self):
        self.bad({'scopes': [{'id': 'x', 'label': {'en': 'X'}, 'match': {'admin1': 'Bavaria'}}]}, 'scopes[0].match')

    def test_scope_match_unknown_key(self):
        self.bad({'scopes': [{'id': 'x', 'label': {'en': 'X'}, 'match': {'city': 'Munich'}}]}, 'scopes[0].match')

    def test_duplicate_field_id(self):
        f = {'id': 'a', 'label': {'en': 'A'}, 'keywords': []}
        self.bad({'fields': [f, dict(f)]}, 'fields[1].id')

    def test_bad_id_format(self):
        self.bad({'fields': [{'id': 'Has Space', 'label': {'en': 'A'}}]}, 'fields[0].id')

    def test_regex_must_compile(self):
        self.bad({'statements': [{'id': 's', 'a': {'en': 'a'}, 'b': {'en': 'b'}, 'a_regex': '(unclosed', 'b_regex': 'x'}]}, 'statements[0].a_regex')

    def test_level_default_band_required(self):
        self.bad({'levels': [{'code': 'a', 'label': {'en': 'A'}, 'pattern': 'x'}]}, 'levels')

    def test_language_must_be_known(self):
        self.bad({'languages': ['en', 'fr']}, 'languages[1]')

    def test_label_needs_english(self):
        self.bad({'fields': [{'id': 'a', 'label': {'de': 'A'}}]}, 'fields[0].label')

    def test_persona_flags(self):
        self.bad({'personas': [{'id': 'p', 'label': {'en': 'P'}, 'regex': 'x', 'flags': 'q'}]}, 'personas[0].flags')

    def test_glossary_pairs(self):
        self.bad({'glossary': [['only-one']]}, 'glossary[0]')

    def test_atlas_maps_values(self):
        for v in ('worldwide', 'per_scope'):
            folder = write_profile({'web': {'atlas_maps': v}})
            self.folders.append(folder)
            self.assertEqual(load_profile(folder)['web']['atlas_maps'], v)

    def test_atlas_maps_bad_value_names_key(self):
        self.bad({'web': {'atlas_maps': 'germany'}}, 'web.atlas_maps')

    def test_board_order_values(self):
        for v in ('first_seen', 'published'):
            folder = write_profile({'board': {'order': v}})
            self.folders.append(folder)
            self.assertEqual(load_profile(folder)['board']['order'], v)
        folder = write_profile({})
        self.folders.append(folder)
        self.assertEqual(load_profile(folder)['board'], {'order': 'first_seen'})

    def test_board_order_bad_value_names_key(self):
        self.bad({'board': {'order': 'newest'}}, 'board.order')

    def test_map_range(self):
        self.bad({'map': {'even': 1.5}}, 'map.even')

    def test_not_json(self):
        folder = tempfile.mkdtemp(prefix='jc-profile-')
        self.folders.append(folder)
        with open(os.path.join(folder, 'profile.json'), 'w') as fh:
            fh.write('{"name": ')
        with self.assertRaises(ProfileError) as cm:
            load_profile(folder)
        self.assertIn('not valid JSON', str(cm.exception))

    def test_file_path_and_folder_name_default(self):
        folder = write_profile({})
        self.folders.append(folder)
        p = load_profile(os.path.join(folder, 'profile.json'))
        self.assertEqual(p['name'], os.path.basename(folder))
        self.assertEqual(p['_dir'], folder)

    def test_crawler_keys_are_kept(self):
        folder = write_profile({'crawl': {'relevance': {'keywords': ['word:space'], 'negative': ['x']}}, 'data_dir': 'data'})
        self.folders.append(folder)
        p = load_profile(folder)
        self.assertEqual(p['crawl']['relevance']['keywords'], ['word:space'])
        self.assertEqual(p['crawl']['companies_file'], 'companies.json')
        self.assertEqual(p['data_dir'], 'data')


if __name__ == '__main__':
    unittest.main()
