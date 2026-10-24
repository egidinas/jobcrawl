"""Seniority ladder from a job title (German and French forms included). One modifier per role, the highest rung that matches wins:
Chief > Director > Head > Principal > Lead > Manager > Senior > Junior > Doctoral > Student. A plain "Engineer" has none ('').
The title decides the rung. Port of the reference board's tools/role_seniority.py; the board's own level bands are the profile's
`levels` (classify/levels.py)."""
import re

LADDER = [
 ('Chief',      r'^(?!.*office)(?:.*?)(?:\bcto\b|\bcoo\b|\bceo\b|\bcfo\b|\bciso\b|chief (?:executive|technology|technical|operating|financial|commercial|information|security|revenue|product)|geschäftsführ|managing director|general manager)'),
 ('Director',   r'\bdirector\b|vice president|\bvp\b|\bsvp\b|\bevp\b|bereichsleit|direktor|directeur|directrice'),
 ('Head',       r'^(?!.*(?:projekt|team|gruppen|fachteam|schicht)leit)(?!.*referent)(?:.*?)(?:head of|\bhead\b(?! of staff)|abteilungsleit|werksleit|produktionsleit|standortleit|bereichsleit|(?<![a-zäöü])leiter(?:in)?\b(?!.*team)|leiter:in|responsable (?:de|du)|chef de (?:service|département))'),
 ('Principal',  r'\bprincipal\b|\bstaff (?:engineer|scientist|designer|analyst|software|mechanical|electrical|propulsion|robotics|systems|hardware)|\bstaff\b(?=,)|\bfellow\b|\bdistinguished\b|chief engineer|chief scientist|chief architect|chief designer'),
 ('Lead',       r'team ?lead|teamlead|teamleit|teamleiter|fachteamleit|group ?lead|gruppenleit|schichtleit|shift lead|\blead\b(?!\s*(?:time|generation|gen\b))|supervisor|vorarbeiter|team leader|chef d.équipe|crew chief|chief of staff(?!x)'),
 ('Manager',    r'\bmanager\b|manager:in|managerin|projektleit|projektmanag|program(?:me)? manag|project manager|\bpmo\b'),
 ('Senior',     r'\bsenior\b|\bsr\b\.?|\bexperienced\b|\bexpert(?:e|in)?\b'),
 ('Junior',     r'\bjunior\b|\bjr\b\.?|berufseinsteig|entry[- ]level|new grad|\bgraduate\b|absolvent'),
 ('Doctoral',   r'doktorand|\bphd\b|doctoral|doctorant|promotionsstelle'),
 ('Student',    r'\bintern(?:ship)?\b|werkstudent|working student|praktik|^\s*stage\s*[-–:]|stagiaire|\btrainee\b|ausbildung|auszubildend|apprentice|\bthesis\b|abschlussarbeit|bachelorarbeit|masterarbeit|studentische|student positions?|\bstudent\b|\bphd student\b'),
]
RX = [(n, re.compile(r, re.I)) for n, r in LADDER]


def level(title):
    """-> (highest rung or '', every rung that matched)"""
    hits = [n for n, rx in RX if rx.search(title or '')]
    return (hits[0] if hits else ''), hits
