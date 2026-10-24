"""Seniority band of a role from its title (profile key `levels`): the first band whose pattern matches, in the order the
profile lists them; the band with pattern null is the default. Port of the reference board's companies.level_of()."""
import re


def compile_levels(levels):
    """[(code, compiled pattern or None)] in match order."""
    return [(b['code'], re.compile(b['pattern'], re.I) if b['pattern'] is not None else None) for b in levels]


def level_of(title, compiled):
    t = title or ''
    default = None
    for code, rx in compiled:
        if rx is None:
            default = code
            continue
        if rx.search(t):
            return code
    return default if default is not None else ''
