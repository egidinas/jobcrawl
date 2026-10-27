"""The text a role is embedded from: the work itself, without the employer's boilerplate.

Multi-stage sanitization pipeline:
1. Strip web/cookie/tab artifacts, apply buttons, and standalone HR perk/benefits bullets.
2. Strip standalone posting metadata lines and labels (location, department, contract, job id, etc.).
3. The role section, where the description can be split into sections (jobcrawl.text.sections.segment_sections), else the whole text.
4. Employer boilerplate: any sentence that one employer repeats in at least 3 of its postings (and in at least a fifth of them) is dropped.
5. Template and intro lines that are still left: paragraphs that introduce the company or list what it offers (benefits/perks).
6. EEO, diversity, and disability (Schwerbehinderte) clauses are dropped.

The result is the work text alone (no title): embed callers prepend the clean title and embed the substantive role mission.
"""
import collections
import hashlib
import re

SENT = re.compile(r'(?<=[.!?])\s+|\n+')

RE_DROP_PATTERNS = re.compile(
    r'(?i)('
    r'wird auf einer neuen registerkarte|opens in a new (tab|window)|'
    r'sitzungs-stickiness|cookie|datenschutz|impressum|privacy policy|terms of (use|service)|'
    r'[©\xa9]\s*20\d\d|all rights reserved|alle rechte vorbehalten|'
    r'jetzt bewerben|apply now|share this job|diesen job teilen|'
    r'egym\s*wellpass|urban sports|gympass|fitnessstudio|betriebssport|'
    r'mobilitätsangebote|fahrradleasing|jobrad|bike\s*leasing|deutschlandticket|zuschuss zum deutschlandticket|'
    r'pendel-?\s*und werksbusse|fahrzeugleasing|e-ladesäulen|kostenfreie parkplätze|'
    r'betriebsgastronomie|barista bar|kantine|obstkorb|kostenlose getränke|'
    r'mitarbeiterrabatte|corporate benefits|betriebliche altersvorsorge|bav\b|company pension|'
    r'30 tage urlaub|urlaubstage|urlaubsgeld|weihnachtsgeld|'
    r'equal opportunit|schwerbehinderte menschen|all genders\b'
    r')'
)

META = re.compile(
    r'^\s*[-•*·–—]?\s*(role highlights|location|standort|arbeitsort|department|abteilung|reports? to|employment type|anstellungsart|'
    r'contract( type)?|vertragsart|workplace( model)?|arbeitsmodell|arbeitszeit|working hours|start date|eintrittsdatum|'
    r'job[- ]?id|ausschreibungs-id|requisition|reference|referenznummer|kennziffer|salary|gehalt|compensation|travel|'
    r'reisebereitschaft|product|experience level|posted on|ref id|job type|key job details|job details)\s*[:\-–—"]?\s*$|'
    r'^\s*[-•*·–—]?\s*(location|standort|arbeitsort|department|abteilung|reports? to|employment type|anstellungsart|'
    r'contract type|vertragsart|workplace model|arbeitsmodell|arbeitszeit|working hours|job[- ]?id|ausschreibungs-id|'
    r'requisition|referenznummer|posted on|ref id|job type|experience level)\s*[:\-–—"]', re.I)

INTRO = re.compile(
    r'\b(about us|who we are|über uns|wer wir sind|our mission|unsere mission|we are a |we are an |wir sind ein|founded in|gegründet|'
    r'headquartered|our company|unser unternehmen|what we offer|we offer|wir bieten|benefits|perks|why join|warum wir|'
    r'your benefits|deine benefits|ihre vorteile|compensation|salary range|visa sponsorship|relocation)\b', re.I)

EEO = re.compile(
    r'equal opportunit|eeo\b|affirmative action|diversity|inclusion|gleichstellung|chancengleich|disabilit|veteran|sexual orientation|'
    r'schwerbehind|behinderung|all qualified applicants|alle bewerber|welcome applications from|bewerbungen von', re.I)


def _key(s):
    return hashlib.sha1(re.sub(r'\W+', ' ', s.lower()).strip().encode('utf-8')).hexdigest()[:16]


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
    # Step 1: Pre-clean standalone lines (artifacts, UI text, cookies, perks, standalone meta)
    lines = []
    skip_next = False
    for line in t.splitlines():
        l_strip = line.strip()
        if not l_strip:
            lines.append('')
            continue
        if skip_next:
            skip_next = False
            continue
        if re.match(r'(?i)^\s*[-•*·–—]?\s*(arbeitsort|standort|location|ausschreibungs-id|job-?id|requisition|referenznummer|abteilung|department)\s*[:\-–—"]?\s*$', l_strip):
            skip_next = True
            continue
        l_core = re.sub(r'^[\s\-•*·–—"\'`]+', '', l_strip).strip()
        if META.match(l_strip):
            continue
        # Drop standalone bullet/short lines matching drop patterns, but not multi-sentence paragraphs
        if (len(l_strip) <= 120 or l_strip.startswith(('-', '•', '*', '·', '–', '—'))) and RE_DROP_PATTERNS.search(l_core) and not re.search(r'\b(you will|your tasks|you\'ll|ihre aufgaben|deine aufgaben|du wirst|sie werden)\b', l_core, re.I):
            continue
        lines.append(line)
    t = '\n'.join(lines)

    # Step 2: Segment sections if segmenter is supplied
    if segment:
        sec = segment(t)
        if sec.get('segmented') and len(sec.get('role') or '') > 200:
            t = sec['role']

    kept = []
    for para in re.split(r'\n\s*\n', t):
        if INTRO.search(para[:200]) and not re.search(r'\b(you will|your tasks|you\'ll|ihre aufgaben|deine aufgaben|du wirst|sie werden)\b', para, re.I):
            continue
        # short lines without a sentence (headers, "Apply", "Regular", a place name) carry no work; so do metadata and EEO lines
        p_lines = [
            l for l in para.splitlines()
            if l.strip() and not META.search(l) and not EEO.search(l)
            and not ((len(l.strip()) <= 120 or l.strip().startswith(('-', '•', '*', '·', '–', '—'))) and RE_DROP_PATTERNS.search(l))
            and (len(l.strip()) >= 30 or re.search(r'[.;:]\s*$', l.strip()))
        ]
        para = ' '.join(p_lines)
        sents = [s for s in sentences(para) if _key(s) not in boiler and not EEO.search(s) and not RE_DROP_PATTERNS.search(s)]
        if sents:
            kept.append(' '.join(sents))
    return re.sub(r'\s+', ' ', ' '.join(kept)).strip()
