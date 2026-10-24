"""Field tags of a role from the profile's keyword rules (profile key `fields`).

Matching follows crawler/relevance.mjs: text is lower-cased and accents are removed ("Prüfer" matches "prufer"); a keyword
written "word:xyz" matches whole words only, a plain keyword matches as a substring. `company_keywords` are plain substrings of
the employer name. The order of a role's tags follows the reference board (tools/update_jobs.py extract_tags):
  1. fields with "pillar": true match on title, description or employer;
  2. the other fields match on the title;
  3. the other fields match on title, description or employer;
and the list is cut at `max_field_tags` (default 5). A field appears at most once.
"""
import re
import unicodedata


def fold(text):
    """Lower case, accents removed (crawler/relevance.mjs norm())."""
    t = str(text or '').lower()
    return ''.join(c for c in unicodedata.normalize('NFKD', t) if not unicodedata.combining(c))


class Matcher:
    """Matches a text against a keyword list (see module doc)."""

    def __init__(self, keywords):
        words, subs = [], []
        for k in keywords:
            if k.startswith('word:'):
                words.append(re.escape(fold(k[5:].strip())))
            else:
                subs.append(fold(k.strip()))
        self._re = re.compile(r'(?<![a-z0-9])(?:' + '|'.join(words) + r')(?![a-z0-9])') if words else None
        self._subs = [s for s in subs if s]

    def __call__(self, text):
        t = fold(text)
        if not t:
            return False
        if self._re is not None and self._re.search(t):
            return True
        return any(s in t for s in self._subs)


def field_matchers(fields):
    """{field id: (Matcher on text, Matcher on employer)} for the profile's fields."""
    out = {}
    for f in fields:
        out[f['id']] = (Matcher(f.get('keywords', [])), Matcher(f.get('company_keywords', [])))
    return out


def field_tags(title, text, company, fields, max_tags=5, matchers=None):
    """Field ids of one role, in the order described in the module doc."""
    m = matchers or field_matchers(fields)
    haystack = ' '.join(x for x in (title, text, company) if x)
    out = []

    def add(fid):
        if fid not in out and len(out) < max_tags:
            out.append(fid)

    for f in fields:
        if f.get('pillar'):
            text_rx, co_rx = m[f['id']]
            if co_rx(company) or text_rx(haystack):
                add(f.get('tag', f['id']))
    for f in fields:
        if not f.get('pillar') and m[f['id']][0](title):
            add(f.get('tag', f['id']))
    for f in fields:
        if not f.get('pillar') and m[f['id']][0](haystack):
            add(f.get('tag', f['id']))
    return out
