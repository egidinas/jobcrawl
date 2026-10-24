"""Section segmentation of a job description: role text (tasks, requirements) versus the company blurb; benefits and
equal-opportunity sections are dropped. Port of segment_sections() in the source's tools/meta_engine.py (the headings are
English and German; nothing else from that module is needed here). Standard library only."""
import re

_H_DROP = re.compile(r'^(?:equal\s+opportunit\w*|we\s+offer|what\s+we\s+offer|what\s+you\s+get|benefits?|perks|compensation|salary|how\s+to\s+apply|application\s+process|privacy|data\s+protection|diversity|'
                     r'wir\s+bieten|das\s+bieten\s+wir|unser\s+angebot|benefits|vorteile|datenschutz|bewerbung\w*|kontakt)\b', re.I)
_H_ROLE = re.compile(r'^(?:about\s+the\s+(?:role|job|position)|the\s+(?:role|job|position)|role\s+(?:overview|description)|(?:key\s+)?responsibilit\w*|(?:your|main)\s+(?:tasks?|mission|responsibilit\w*)|tasks|what\s+you(?:\'ll|\s+will)\s+(?:do|bring|work\s+on)|what\s+you\s+bring|'
                     r'requirements?|qualifications?|(?:your|ideal)\s+profile|who\s+you\s+are|skills|must\s+have|nice\s+to\s+have|'
                     r'ihre\s+aufgaben|deine\s+aufgaben|aufgaben\w*|tätigkeit\w*|ihr\s+profil|dein\s+profil|anforderung\w*|qualifikation\w*|was\s+sie\s+mitbringen|was\s+du\s+mitbringst)\b', re.I)
_H_COMP = re.compile(r'^(?:about\s+(?:us|the\s+(?:company|team|division))|who\s+we\s+are|company\s+overview|our\s+(?:mission|company|story)|über\s+uns|wer\s+wir\s+sind|unser\s+unternehmen|das\s+unternehmen)\b', re.I)


def segment_sections(text):
    """Splits a description into role text (tasks, requirements) and company blurb; benefits/EEO sections are dropped.
    Bullets are kept. Without a recognisable 'role' heading the whole text counts as role text."""
    role, comp, sec, found_role = [], [], 'comp', False
    for line in (text or '').splitlines():
        s_ = line.strip().lstrip('#').strip()
        if not s_:
            continue
        head = s_.rstrip(':').strip()
        if len(head) <= 70 and not head.endswith(('.', ';', ',')):
            if _H_DROP.match(head):
                sec = 'drop'; continue
            if _H_ROLE.match(head):
                sec = 'role'; found_role = True; continue
            if _H_COMP.match(head):
                sec = 'comp'; continue
        s_ = re.sub(r'^[-•*–]+\s*', '', s_)
        if sec == 'role':
            role.append(s_)
        elif sec == 'comp':
            comp.append(s_)
    if not found_role:
        return {'role': (text or ''), 'comp': '', 'segmented': False}
    return {'role': '\n'.join(role), 'comp': '\n'.join(comp), 'segmented': True}
