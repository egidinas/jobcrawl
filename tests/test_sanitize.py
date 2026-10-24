"""Geo sanitising of a crawl folder: places.json is written, new rows get their canonical place."""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from jobcrawl.geo import sanitize


class Sanitize(unittest.TestCase):
    def setUp(self):
        self.data = tempfile.mkdtemp(prefix='jc-geo-')
        with open(os.path.join(self.data, 'scan-history.tsv'), 'w', encoding='utf-8') as fh:
            fh.write('url\tcompany\ttitle\tlocation\tstatus\n')
            fh.write('https://careers.example.com/a\tAcme\tEngineer\tMünchen, DE\topen\n')
            fh.write('https://careers.example.com/b\tAcme\tEngineer\tRockville, MD or Hawthorne, CA\topen\n')
            fh.write('https://careers.example.com/c\tAcme\tEngineer\tUnspecified\topen\n')
            fh.write('https://careers.example.com/d\tAcme\tEngineer\tParis\tclosed\n')
        with open(os.path.join(self.data, 'last-new.json'), 'w', encoding='utf-8') as fh:
            json.dump({'rows': [{'url': 'https://careers.example.com/a', 'location': 'München, DE'}]}, fh)

    def tearDown(self):
        shutil.rmtree(self.data, ignore_errors=True)

    def test_run(self):
        out = io.StringIO()
        with mock.patch.object(sys, 'argv', ['sanitize', '--data', self.data]), contextlib.redirect_stdout(out):
            self.assertEqual(sanitize.main(), 0)
        self.assertIn('3 distinct location texts', out.getvalue())
        with open(os.path.join(self.data, 'places.json'), encoding='utf-8') as fh:
            places = json.load(fh)
        self.assertEqual(places['München, DE']['places'], [['Munich', 'Bavaria', 'DE']])
        self.assertEqual(places['Rockville, MD or Hawthorne, CA']['places'],
                         [['Rockville', 'Maryland', 'US'], ['Hawthorne', 'California', 'US']])
        self.assertNotIn('Paris', places)          # closed rows are not resolved
        with open(os.path.join(self.data, 'last-new.json'), encoding='utf-8') as fh:
            row = json.load(fh)['rows'][0]
        self.assertEqual(row['place'], 'Munich, Bavaria')
        self.assertEqual(row['places'], [['Munich', 'Bavaria', 'DE']])

    def test_no_history_is_not_an_error(self):
        empty = tempfile.mkdtemp(prefix='jc-geo-empty-')
        try:
            out = io.StringIO()
            with mock.patch.object(sys, 'argv', ['sanitize', '--data', empty]), contextlib.redirect_stdout(out):
                self.assertEqual(sanitize.main(), 0)
            self.assertIn('nothing to do', out.getvalue())
        finally:
            shutil.rmtree(empty, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
