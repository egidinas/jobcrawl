"""Text step: section segmentation, work text (employer boilerplate, metadata, EEO) and the language helpers."""
import unittest

from jobcrawl.text.sections import segment_sections
from jobcrawl.text.work_text import employer_boilerplate, work_text
from jobcrawl.text.langfix import language

POSTING = """About us
We are Nordlicht, founded in 1999 and headquartered in Munich.

Your tasks
- Plan and run thermal vacuum tests of satellite payloads in our cleanroom.
- Correlate the thermal model with measured data.

Requirements
- Degree in mechanical or aerospace engineering with several years of TVAC experience.

Benefits
- Flexible working hours and a company pension scheme.

Location: Munich
Equal opportunity employer. We welcome applications from all qualified applicants."""

BOILER = 'Shared boilerplate sentence about our company culture and values here.'


class Sections(unittest.TestCase):
    def test_role_and_company_sections(self):
        s = segment_sections(POSTING)
        self.assertTrue(s['segmented'])
        self.assertIn('Plan and run thermal vacuum tests', s['role'])
        self.assertIn('Degree in mechanical', s['role'])
        self.assertNotIn('pension', s['role'])
        self.assertNotIn('pension', s['comp'])
        self.assertEqual(s['comp'], 'We are Nordlicht, founded in 1999 and headquartered in Munich.')

    def test_german_headings(self):
        s = segment_sections('Über uns\nWir sind ein Team.\n\nIhre Aufgaben\nFPGA-Firmware entwickeln und testen.\n\nWir bieten\nUrlaub.')
        self.assertTrue(s['segmented'])
        self.assertIn('FPGA-Firmware', s['role'])
        self.assertNotIn('Urlaub', s['role'])

    def test_without_role_heading_the_whole_text_is_role_text(self):
        text = 'Just a paragraph about building test rigs.'
        s = segment_sections(text)
        self.assertFalse(s['segmented'])
        self.assertEqual(s['role'], text)
        self.assertEqual(s['comp'], '')


class WorkText(unittest.TestCase):
    def test_sections_metadata_and_eeo_are_removed(self):
        out = work_text('t', POSTING, segment=segment_sections)
        self.assertEqual(out, 'Plan and run thermal vacuum tests of satellite payloads in our cleanroom. Correlate the thermal model '
                              'with measured data. Degree in mechanical or aerospace engineering with several years of TVAC experience.')

    def test_without_segmentation_intro_and_benefit_paragraphs_still_go(self):
        out = work_text('t', POSTING)
        self.assertNotIn('Nordlicht', out)
        self.assertNotIn('pension', out)
        self.assertNotIn('Equal opportunity', out)
        self.assertNotIn('Location', out)
        self.assertIn('thermal vacuum tests', out)

    def test_employer_boilerplate_is_dropped(self):
        postings = {'acme': [
            BOILER + '\n\nRole one is about FPGA firmware design for radar systems.',
            BOILER + '\n\nRole two is about thermal testing of payloads in the lab.',
            BOILER + '\n\nRole three is about optics alignment for lasers.',
        ], 'small': ['Only one posting here about something else entirely in the world.']}
        boiler = employer_boilerplate(postings)
        self.assertEqual(len(boiler['acme']), 1)
        self.assertNotIn('small', boiler)          # fewer than three postings: nothing is learned
        out = work_text('t', postings['acme'][0], boiler=boiler['acme'])
        self.assertEqual(out, 'Role one is about FPGA firmware design for radar systems.')

    def test_empty_text(self):
        self.assertEqual(work_text('t', ''), '')
        self.assertEqual(work_text('t', None), '')


class Language(unittest.TestCase):
    def test_detects_german_and_english(self):
        self.assertEqual(language('Wir suchen Ingenieure für die Prüfung der Antennen und die Entwicklung der Software für unsere Kunden.'), 'de')
        self.assertEqual(language('We are looking for engineers to build and test the flight software with our team.'), 'en')

    def test_short_text_defaults_to_english(self):
        self.assertEqual(language('Hello'), 'en')


class LanguageDirections(unittest.TestCase):
    def setUp(self):
        try:
            import numpy  # noqa: F401
        except ImportError:
            self.skipTest('numpy not installed (the embed extra)')

    def test_projection_removes_the_direction(self):
        import numpy as np
        from jobcrawl.text.langfix import directions, project
        rng = np.random.default_rng(0)
        X = rng.normal(size=(60, 8)).astype(np.float32)
        langs = np.array(['de'] * 30 + ['en'] * 30)
        X[:30] += 3.0
        D = directions(X, langs, min_roles=20)
        self.assertEqual(D.shape, (1, 8))
        Y = project(X, D)
        self.assertLess(abs(float((Y @ D.T).max())), 1e-5)
        self.assertTrue(np.allclose(np.linalg.norm(Y, axis=1), 1.0, atol=1e-5))


if __name__ == '__main__':
    unittest.main()
