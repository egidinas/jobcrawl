"""The text a role is embedded from: the work itself, without the employer's boilerplate.

Three steps, in this order:
1. The role section, where the description can be split into sections (jobcrawl.text.sections.segment_sections), else the whole text.
2. Employer boilerplate: any sentence that one employer repeats in at least 3 of its postings (and in at least a fifth of them)
   is dropped. This catches company introductions, benefits, application instructions and legal text in any language,
   without a list of phrases.
3. Template and intro lines that are still left: posting metadata (location, department, reports to, contract type, ...),
   and paragraphs that introduce the company or list what it offers.
EEO and equal-opportunity lines are dropped as before. The result is the work text alone (no title): embed callers prepend the
clean title and take the first 700 characters, as the production recipe does (jobcrawl/embed, phase 3).
"""
import collections
import hashlib
import re

SENT = re.compile(r'(?<=[.!?])\s+|\n+')
META = re.compile(r'^\s*[-•*]?\s*(role highlights|location|standort|department|abteilung|reports? to|employment type|contract( type)?|vertragsart|'
                  r'workplace( model)?|arbeitsmodell|arbeitszeit|working hours|start date|eintrittsdatum|job id|requisition|reference|kennziffer|'
                  r'salary|gehalt|compensation|travel|reisebereitschaft|product|experience level|posted on|ref id|job type|key job details|job details)\s*[:\-–]?\s*$|'
                  r'^\s*[-•*]?\s*(location|standort|department|reports? to|employment type|workplace model|job id|posted on|ref id|job type|experience level)\s*[:\-–]', re.I)
INTRO = re.compile(r'\b(about us|who we are|über uns|wer wir sind|our mission|unsere mission|we are a |we are an |wir sind ein|founded in|gegründet|'
                   r'headquartered|our company|unser unternehmen|what we offer|we offer|wir bieten|benefits|perks|why join|warum wir|'
                   r'your benefits|deine benefits|ihre vorteile|compensation|salary range|visa sponsorship|relocation)\b', re.I)
EEO = re.compile(r'equal opportunit|eeo\b|affirmative action|diversity|inclusion|gleichstellung|chancengleich|disabilit|veteran|sexual orientation|'
                 r'schwerbehind|behinderung|all qualified applicants|alle bewerber|welcome applications from|bewerbungen von', re.I)


def _key(s):
    return hashlib.sha1(re.sub(r'\W+', ' ', s.lower()).strip().encode()).hexdigest()[:16]


def sentences(text):
    return [s.strip() for s in SENT.split(text or '') if len(s.strip()) > 25]


def employer_boilerplate(texts_by_employer, min_posts=3, min_share=0.2):
    """{employer: set of sentence keys repeated across that employer's postings}."""
    out = {}
    for emp, texts in texts_by_employer.items():
        if len(texts) < min_posts:
            continue
        c = collections.Counter()
        for t in texts:
            c.update(set(_key(s) for s in sentences(t)))
        need = max(min_posts, min_share * len(texts))
        out[emp] = {k for k, n in c.items() if n >= need}
    return out


def work_text(title, text, boiler=frozenset(), segment=None):
    t = text or ''
    if segment:
        sec = segment(t)
        if sec.get('segmented') and len(sec.get('role') or '') > 200:
            t = sec['role']
    kept = []
    for para in re.split(r'\n\s*\n', t):
        if INTRO.search(para[:200]) and not re.search(r'\b(you will|your tasks|you\'ll|ihre aufgaben|deine aufgaben|du wirst|sie werden)\b', para, re.I):
            continue
        # short lines without a sentence (headers, "Apply", "Regular", a place name) carry no work; so do metadata and EEO lines
        lines = [l for l in para.splitlines() if l.strip() and not META.search(l) and not EEO.search(l) and (len(l.strip()) >= 30 or re.search(r'[.;:]\s*$', l.strip()))]
        para = ' '.join(lines)
        sents = [s for s in sentences(para) if _key(s) not in boiler]
        if sents:
            kept.append(' '.join(sents))
    return re.sub(r'\s+', ' ', ' '.join(kept)).strip()
