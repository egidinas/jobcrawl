"""publish: the match folder and config.json on the Phase 2 fixture, with and without vectors; the command line for embed, publish and map.

The fixture site has five roles; the vectors are synthetic (tests/synthetic.py): the match-vec files for the five roles, a company
vector file and an atlas layout copied in from the map test. Needs numpy for the vector cases (skipped with the reason otherwise).
"""
import contextlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from synthetic import HAVE_NUMPY, NUMPY_REASON, write_company_vectors, write_match_vectors
from jobcrawl import board
from jobcrawl.cli import default_vectors, main
from jobcrawl.index import publish
from jobcrawl.profile import ProfileError, load_profile, _validate

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, 'fixtures', 'catalog.json')
PROFILE = os.path.join(os.path.dirname(HERE), 'profiles', 'aerospace')
need_numpy = unittest.skipUnless(HAVE_NUMPY, NUMPY_REASON)


def silent(message):
    pass

MATCH_FILES = ['match-vec.bin', 'match-vec.json', 'match-bm25.json', 'match-attrs.json', 'match-prefs.json', 'role-nb.bin', 'role-graph.json',
               'atlas-layout.json', 'company-vec.bin', 'company-vec.json']
CONFIG_KEYS = ['name', 'title', 'tagline', 'languages', 'scopes', 'fields', 'levels', 'personas', 'glossary', 'statements_file', 'accent', 'links']


def profile_from_dict(raw):
    """A profile from a dict, validated the way load_profile validates a file."""
    out = _validate(dict({'levels': [{'code': 'mid', 'rank': 0, 'label': {'en': 'Mid'}, 'pattern': None}]}, **raw), 'profile.json')
    out['name'] = out['name'] or 'x'
    return out


class PublishFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='jc-publish-')
        cls.profile = load_profile(PROFILE)
        cls.site = os.path.join(cls.tmp, 'site')
        board.build(cls.profile, FIXTURE, cls.site)
        cls.vectors = os.path.join(cls.tmp, 'vectors')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def fresh_site(self, name):
        site = os.path.join(self.tmp, name)
        shutil.copytree(self.site, site)
        return site

    @need_numpy
    def test_every_match_file_and_config_are_written(self):
        site = self.fresh_site('full')
        vectors = os.path.join(self.tmp, 'vec-full')
        with open(os.path.join(site, 'jobs-index.json'), encoding='utf-8') as fh:
            rows = json.load(fh)
        write_match_vectors(vectors, [(r[0], 'x') for r in rows], dim=16)
        write_company_vectors(vectors, ['alpha', 'beta'], dim=16)
        with open(os.path.join(vectors, 'atlas-layout.json'), 'w', encoding='utf-8') as fh:
            json.dump({'version': 2, 'roles': {}}, fh)
        files = publish.publish(site, self.profile, vectors, log=silent)
        for name in MATCH_FILES:
            self.assertTrue(os.path.exists(os.path.join(site, 'match', name)), name)
        self.assertTrue(os.path.exists(os.path.join(site, 'config.json')))
        self.assertIn(os.path.join('match', 'role-nb.bin'), files)
        self.assertIn('config.json', files)
        self.assertEqual(os.path.getsize(os.path.join(site, 'match', 'role-nb.bin')), len(rows) * 10 * 2)

    @need_numpy
    def test_vector_files_are_copies(self):
        site = self.fresh_site('copies')
        vectors = os.path.join(self.tmp, 'vec-copies')
        with open(os.path.join(site, 'jobs-index.json'), encoding='utf-8') as fh:
            rows = json.load(fh)
        write_match_vectors(vectors, [(r[0], 'x') for r in rows], dim=16)
        publish.publish(site, self.profile, vectors, log=silent)
        with open(os.path.join(vectors, 'match-vec.bin'), 'rb') as a, open(os.path.join(site, 'match', 'match-vec.bin'), 'rb') as b:
            self.assertEqual(a.read(), b.read())

    def test_without_vectors_keywords_and_config_only(self):
        site = self.fresh_site('keywords')
        files = publish.publish(site, self.profile, os.path.join(self.tmp, 'no-such-vectors'), log=silent)
        self.assertIn(os.path.join('match', 'match-bm25.json'), files)
        self.assertIn('config.json', files)
        for name in ('match-vec.bin', 'match-prefs.json', 'role-nb.bin'):
            self.assertFalse(os.path.exists(os.path.join(site, 'match', name)), name)

    def test_keywords_need_no_numpy(self):
        site = self.fresh_site('nonumpy')
        with mock.patch.dict(sys.modules, {'numpy': None}):
            publish.publish(site, self.profile, None, log=silent)
        self.assertTrue(os.path.exists(os.path.join(site, 'match', 'match-attrs.json')))

    def test_config_is_the_app_shape(self):
        site = self.fresh_site('config')
        publish.publish(site, self.profile, None, log=silent)
        with open(os.path.join(site, 'config.json'), encoding='utf-8') as fh:
            cfg = json.load(fh)
        for key in CONFIG_KEYS:
            self.assertIn(key, cfg)
        self.assertEqual(cfg['statements_file'], 'match/match-prefs.json')
        self.assertEqual([s['id'] for s in cfg['scopes']], ['bavaria', 'germany', 'europe', 'worldwide'])
        self.assertEqual(len(cfg['personas']), len(self.profile['personas']))
        self.assertEqual(cfg['personas'][0]['flags'], 'i')
        self.assertEqual(cfg['levels'][0]['code'], 'student')
        self.assertEqual(cfg['glossary'][0], ['test', 'prüfung'])
        self.assertEqual(cfg['accent'], '#2563eb')
        self.assertEqual([x['url'] for x in cfg['links']['reference']], [x['url'] for x in self.profile['links']['reference']])

    def test_text_from_indexes_the_full_text_and_publishes_the_excerpts(self):
        # the demo's rule: the keyword index reads the full descriptions, the published site carries excerpts
        full = self.fresh_site('full-text')
        cut = self.fresh_site('excerpt-text')
        for name in os.listdir(cut):
            if re.match(r'^jobs-desc-[0-9a-f]{2}\.json$', name):
                path = os.path.join(cut, name)
                with open(path, encoding='utf-8') as fh:
                    shard = json.load(fh)
                for entry in shard.values():
                    entry['x'] = entry['x'][:10]
                with open(path, 'w', encoding='utf-8') as fh:
                    json.dump(shard, fh)
        from jobcrawl.site import read_site
        ids = [r[0] for r in read_site(full)[0]][:2]
        for rid in ids:          # the term sits in two roles of the full text only
            name = [n for n in os.listdir(full) if re.match(r'^jobs-desc-[0-9a-f]{2}\.json$', n) and rid[:2] == n[10:12]][0]
            path = os.path.join(full, name)
            with open(path, encoding='utf-8') as fh:
                shard = json.load(fh)
            shard[rid]['x'] = shard[rid]['x'] + ' zyxquartz'
            with open(path, 'w', encoding='utf-8') as fh:
                json.dump(shard, fh)
        publish.publish(cut, self.profile, None, silent, text_from=full)
        with open(os.path.join(cut, 'match', 'match-bm25.json'), encoding='utf-8') as fh:
            bm = json.load(fh)
        self.assertEqual({bm['ids'][k] for k in bm['post']['zyxquartz'][::2]}, set(ids))
        for name in os.listdir(cut):
            if re.match(r'^jobs-desc-[0-9a-f]{2}\.json$', name):
                with open(os.path.join(cut, name), encoding='utf-8') as fh:
                    self.assertTrue(all(len(e['x']) <= 10 for e in json.load(fh).values()))
        with self.assertRaises(publish.PublishError):
            publish.publish(cut, self.profile, None, silent, text_from=os.path.join(self.tmp, 'no-such-folder'))

    def test_links_and_accent_default_to_nothing(self):
        raw = {'name': 'plain', 'languages': ['en'], 'levels': [{'code': 'mid', 'rank': 0, 'label': {'en': 'Mid'}, 'pattern': None}]}
        profile = profile_from_dict(raw)
        self.assertIsNone(profile['accent'])
        self.assertEqual(profile['links'], {'reference': []})
        site = self.fresh_site('plain-links')
        publish.publish(site, profile, None, log=silent)
        with open(os.path.join(site, 'config.json'), encoding='utf-8') as fh:
            cfg = json.load(fh)
        self.assertIsNone(cfg['accent'])
        self.assertEqual(cfg['links'], {'reference': []})

    @need_numpy
    def test_prebuilt_neighbours_are_copied_not_rebuilt(self):
        site = self.fresh_site('prebuilt-nb')
        vectors = os.path.join(self.tmp, 'vec-prebuilt')
        with open(os.path.join(site, 'jobs-index.json'), encoding='utf-8') as fh:
            rows = json.load(fh)
        write_match_vectors(vectors, [(r[0], 'x') for r in rows], dim=16)
        with open(os.path.join(vectors, 'role-nb.bin'), 'wb') as fh:
            fh.write(b'prebuilt')
        with open(os.path.join(vectors, 'role-graph.json'), 'w', encoding='utf-8') as fh:
            fh.write('{"k": 10}')
        with mock.patch('jobcrawl.index.neighbours.build', side_effect=AssertionError('neighbours rebuilt')):
            files = publish.publish(site, self.profile, vectors, log=silent)
        self.assertIn(os.path.join('match', 'role-nb.bin'), files)
        with open(os.path.join(site, 'match', 'role-nb.bin'), 'rb') as fh:
            self.assertEqual(fh.read(), b'prebuilt')

    def test_web_settings_and_field_tags_reach_the_config(self):
        raw = {'name': 'site', 'languages': ['en', 'de'],
               'scopes': [{'id': 'city', 'label': {'en': 'City'}, 'match': {'country': 'DE'}}, {'id': 'world', 'label': {'en': 'World'}, 'match': {'any': True}}],
               'fields': [{'id': 'ait', 'tag': 'AIT & Testing', 'label': {'en': 'AIT & Testing', 'de': 'AIT & Test'}}],
               'web': {'role_url': 'job.html?id={id}', 'company_url': 'company-{slug}.html', 'company_texts': 'jobs-co.json', 'default_scope': 'world',
                       'model_url': 'assets/models/eg2/', 'storage': {'prefix': 'site-match', 'lang': 'site-lang', 'model_cache': 'site-eg2-v1',
                                                                     'profile_kind': 'site-match-profile', 'profile_file': 'my-profile.json'}}}
        profile = profile_from_dict(raw)
        site = self.fresh_site('web-settings')
        publish.publish(site, profile, None, log=silent)
        with open(os.path.join(site, 'config.json'), encoding='utf-8') as fh:
            cfg = json.load(fh)
        for k, v in raw['web'].items():
            self.assertEqual(cfg[k], v, k)
        self.assertEqual(cfg['fields'], [{'id': 'AIT & Testing', 'label': {'en': 'AIT & Testing', 'de': 'AIT & Test'}}])

    def test_web_settings_are_checked(self):
        scopes = [{'id': 'world', 'label': {'en': 'World'}, 'match': {'any': True}}]
        for web, key in [({'role_url': 'job.html'}, 'web.role_url'), ({'company_url': 'c.html'}, 'web.company_url'),
                         ({'default_scope': 'moon'}, 'web.default_scope'), ({'colour': 'x'}, 'web'), ({'storage': {'cookie': 'x'}}, 'web.storage'),
                         ({'storage': {'prefix': 3}}, 'web.storage.prefix')]:
            with self.assertRaisesRegex(ProfileError, re.escape(key)):
                profile_from_dict({'name': 'bad', 'scopes': scopes, 'web': web})

    def test_bad_links_and_accent_name_the_key(self):
        for raw, key in [({'accent': 'blue'}, 'accent'), ({'links': {'reference': [{'label': 'x', 'url': 'ftp://x'}]}}, 'links.reference[0].url'),
                         ({'links': {'reference': [{'url': 'https://x'}]}}, 'links.reference[0]'), ({'links': {'site': []}}, 'links')]:
            with self.assertRaisesRegex(ProfileError, re.escape(key)):
                profile_from_dict(dict(raw, name='bad'))

    def test_missing_index_is_refused(self):
        empty = os.path.join(self.tmp, 'empty-site')
        os.makedirs(empty)
        with self.assertRaisesRegex(publish.PublishError, 'jobs-index.json'):
            publish.publish(empty, self.profile, None, log=silent)

    def test_default_vectors_is_the_sibling_folder(self):
        self.assertEqual(default_vectors('/a/b/site'), os.path.join(os.path.dirname(os.path.abspath('/a/b/site')), 'vectors'))
        self.assertEqual(default_vectors('/a/b/out/'), os.path.join(os.path.dirname(os.path.abspath('/a/b/out')), 'vectors'))
        self.assertEqual(default_vectors('demo/site'), os.path.join(os.path.dirname(os.path.abspath('demo/site')), 'vectors'))


class Commands(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='jc-cli-')
        cls.site = os.path.join(cls.tmp, 'site')
        board.build(load_profile(PROFILE), FIXTURE, cls.site)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_cli(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_publish_prints_the_files(self):
        site = os.path.join(self.tmp, 'cli-publish')
        shutil.copytree(self.site, site)
        code, out, _ = self.run_cli(['publish', '--site', site, '--profile', PROFILE, '--vectors', os.path.join(self.tmp, 'none')])
        self.assertEqual(code, 0)
        self.assertTrue('match/match-bm25.json' in out or 'match\\match-bm25.json' in out)
        self.assertIn('config.json', out)

    def test_embed_without_a_model_is_a_usage_error(self):
        code, _, err = self.run_cli(['embed', '--site', self.site, '--model-dir', os.path.join(self.tmp, 'no-model')])
        self.assertEqual(code, 2)
        self.assertIn('model folder not found', err)

    def test_embed_sample_needs_no_model(self):
        code, out, _ = self.run_cli(['embed', '--site', self.site, '--model-dir', 'unused', '--sample', '2'])
        self.assertEqual(code, 0)
        self.assertIn('roles have 150+ characters of work text', out)

    def test_map_on_a_site_without_index_is_a_usage_error(self):
        code, _, err = self.run_cli(['map', '--site', self.tmp, '--profile', PROFILE])
        self.assertEqual(code, 2)
        self.assertIn('jobs-index.json', err)

    def test_publish_needs_site_and_profile(self):
        with self.assertRaises(SystemExit):
            self.run_cli(['publish', '--site', self.site])


if __name__ == '__main__':
    unittest.main()
