"""Embedding without a model: prompts, title cleaning, the cache, the work text, and the role and company vector files.

The model is replaced by a stand-in that returns deterministic 768-number rows (same shape, no weights), so the file formats,
the language directions and the append path are exercised for real. Needs numpy (skipped with the reason otherwise).
"""
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from synthetic import HAVE_NUMPY, NUMPY_REASON
from jobcrawl import board
from jobcrawl.embed import companies, embedder, roles
from jobcrawl.profile import load_profile

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, 'fixtures', 'catalog.json')
PROFILE = os.path.join(os.path.dirname(HERE), 'profiles', 'aerospace')
need_numpy = unittest.skipUnless(HAVE_NUMPY, NUMPY_REASON)


class FullText(unittest.TestCase):
    def test_search_query_prompt_and_title(self):
        self.assertEqual(embedder.full_text('Engineer', 'body text', 'search-query'), 'task: search result | query: Engineer. body text')
        self.assertEqual(embedder.full_text('', 'body', 'search-query'), 'task: search result | query: body')

    def test_document_prompt_puts_the_title_in(self):
        self.assertEqual(embedder.full_text('T', 'x', 'document'), 'title: T | text: x')
        self.assertEqual(embedder.full_text('', 'x', 'document'), 'title: none | text: x')

    def test_unknown_prompt_is_an_error(self):
        with self.assertRaisesRegex(ValueError, 'unknown embed prompt'):
            embedder.full_text('a', 'b', 'nope')

    def test_prompt_table_is_the_reference_one(self):
        self.assertEqual(embedder.PROMPTS['search-query'][0], 'task: search result | query: ')
        self.assertEqual(embedder.MODEL_DIM, 768)


class CleanTitle(unittest.TestCase):
    def test_gender_notation_and_numbers_go(self):
        self.assertEqual(roles.clean_title('Thermal Test Engineer (m/w/d) 2024'), 'Thermal Test Engineer')
        self.assertEqual(roles.clean_title('Engineer (R1234) - Night shift'), 'Engineer')
        self.assertEqual(roles.clean_title('Software Engineer, Mission Operations'), 'Software Engineer, Mission Operations')


class Cache(unittest.TestCase):
    def setUp(self):
        import numpy as np
        self.dir = tempfile.mkdtemp(prefix='jc-cache-')
        self.path = os.path.join(self.dir, 'c.npz')
        self.vec = np.arange(768, dtype=np.float32)
        np.savez(self.path, **{embedder.Store.key('known text', 256): self.vec.astype('float16')})

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    @need_numpy
    def test_cached_text_needs_no_model(self):
        store = embedder.Store(self.path, '/no/such/model')          # the model would fail to load: it must not be needed
        got = store.get(['known text'], 256, 'test', log=lambda m: None)
        self.assertEqual(got.shape, (1, 768))
        self.assertEqual(float(got[0, 5]), 5.0)
        self.assertIsNone(store.emb)

    @need_numpy
    def test_new_text_is_embedded_and_saved(self):
        import numpy as np

        class Stub:
            def __init__(self, model_dir, threads=4):
                pass

            def __call__(self, texts, images=None, maxlen=320, batch=8, log=None):
                return np.full((len(texts), 768), 2.0, np.float32)
        with mock.patch.object(embedder, 'Embedder', Stub):
            store = embedder.Store(self.path, '/x')
            got = store.get(['known text', 'new text'], 256, 'test', log=lambda m: None)
        self.assertEqual(float(got[1, 0]), 2.0)
        again = embedder.Store(self.path, '/x')
        self.assertEqual(len(again.c), 2)                            # the new text is in the cache file now


class FakeModel:
    """Stand-in for the ONNX model: 768 numbers from a hash of the text. Used by the tests only."""
    def __init__(self, model_dir, threads=4):
        pass

    def __call__(self, texts, images=None, maxlen=320, batch=8, log=None):
        import numpy as np
        out = np.zeros((len(texts), 768), np.float32)
        for i, t in enumerate(texts):
            out[i] = np.random.default_rng(int.from_bytes(t.encode('utf-8')[:8].ljust(8, b'\0'), 'little') % (2 ** 32)).normal(size=768)
        return out


@need_numpy
class RoleVectorsOnTheFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='jc-embed-')
        cls.site = os.path.join(cls.tmp, 'site')
        cls.vectors = os.path.join(cls.tmp, 'vectors')
        cls.profile = load_profile(PROFILE)
        board.build(cls.profile, FIXTURE, cls.site)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def vj(self):
        with open(os.path.join(self.vectors, 'match-vec.json'), encoding='utf-8') as fh:
            return json.load(fh)

    def test_board_texts_have_work_text_for_four_roles(self):
        rows = roles.board_texts(self.site)
        self.assertEqual(len(rows), 5)
        self.assertEqual(sum(1 for _, _, b, _ in rows if len(b) >= roles.MIN_CHARS), 4)

    def test_full_run_writes_int8_rows_with_mean_and_directions(self):
        with mock.patch.object(embedder, 'Embedder', FakeModel):
            n = roles.embed_roles(self.site, self.profile, '/x', self.vectors, threads=1)
        self.assertEqual(n, 4)
        vj = self.vj()
        self.assertEqual(vj['dim'], 256)
        self.assertEqual(len(vj['ids']), 4)
        self.assertEqual(len(vj['mean']), 256)
        self.assertIn('lang_dirs', vj)
        size = os.path.getsize(os.path.join(self.vectors, 'match-vec.bin'))
        self.assertEqual(size, 4 * 256)
        with open(FIXTURE, encoding='utf-8') as fh:
            no_text = [it['url'] for it in json.load(fh) if not (it.get('description') or '').strip()]
        self.assertEqual(len(no_text), 1)
        self.assertNotIn(board.role_id(no_text[0]), vj['ids'])          # a role without work text keeps no vector

    def test_only_missing_appends_the_role_without_a_vector(self):
        vj = self.vj()
        last = vj['ids'].pop()
        with open(os.path.join(self.vectors, 'match-vec.bin'), 'rb') as fh:
            raw = fh.read()
        with open(os.path.join(self.vectors, 'match-vec.bin'), 'wb') as fh:
            fh.write(raw[:-256])
        with open(os.path.join(self.vectors, 'match-vec.json'), 'w', encoding='utf-8') as fh:
            json.dump(vj, fh)
        with mock.patch.object(embedder, 'Embedder', FakeModel):
            added = roles.embed_roles(self.site, self.profile, '/x', self.vectors, only_missing=True, threads=1)
        self.assertEqual(added, 1)
        self.assertEqual(self.vj()['ids'][-1], last)
        self.assertEqual(os.path.getsize(os.path.join(self.vectors, 'match-vec.bin')), 4 * 256)

    def test_only_missing_without_vectors_says_what_to_do(self):
        empty = tempfile.mkdtemp(prefix='jc-empty-')
        try:
            with self.assertRaisesRegex(roles.RoleVectorError, 'without --only-missing'):
                roles.embed_roles(self.site, self.profile, '/x', empty, only_missing=True)
        finally:
            shutil.rmtree(empty, ignore_errors=True)

    def test_companies_share_the_space(self):
        with mock.patch.object(embedder, 'Embedder', FakeModel):
            roles.embed_roles(self.site, self.profile, '/x', self.vectors, threads=1)     # the companies use the role space
        cdir = tempfile.mkdtemp(prefix='jc-companies-')
        try:
            with open(os.path.join(cdir, 'companies.json'), 'w', encoding='utf-8') as fh:
                json.dump({'companies': [{'slug': 'alpha', 'name': 'Alpha GmbH', 'field': 'space', 'profile': {'en': 'Makes satellites.'}},
                                         {'slug': 'beta', 'name': 'Beta AG'}]}, fh)
            prof = dict(self.profile, companies_catalogue='companies.json', _dir=cdir)
            with mock.patch.object(embedder, 'Embedder', FakeModel):
                n = companies.embed_companies(prof, '/x', self.vectors, threads=1)
            self.assertEqual(n, 2)
            self.assertEqual(os.path.getsize(os.path.join(self.vectors, 'company-vec.bin')), 2 * 256)
            with open(os.path.join(self.vectors, 'company-vec.json'), encoding='utf-8') as fh:
                self.assertEqual(json.load(fh)['slugs'], ['alpha', 'beta'])
        finally:
            shutil.rmtree(cdir, ignore_errors=True)

    def test_no_catalogue_no_companies(self):
        with self.assertRaisesRegex(companies.CompanyError, 'no companies_catalogue'):
            companies.embed_companies(self.profile, '/x', self.vectors)


if __name__ == '__main__':
    unittest.main()
