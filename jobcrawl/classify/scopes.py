"""Scopes of a role from the places the posting names (jobcrawl.geo.geo.resolve).

The profile lists its scopes from the narrowest to the widest (aerospace: bavaria, germany, europe, worldwide). A place matches
a scope by its rule: {"any": true}, {"continent": "EU"}, {"country": "DE"} or {"country": "DE", "admin1": "Bavaria"} (admin1 is
the English state name as the geo module writes it). A role belongs to the scope of its narrowest matching place and to every
scope listed after it, so a role in Bavaria also counts for Germany, Europe and worldwide (as in the reference board).
A role with no place at all belongs to the scopes with the "any" rule.
"""
from jobcrawl.geo import geo


def place_matches(place, rule):
    if rule.get('any'):
        return True
    if 'continent' in rule:
        return place.get('continent') == rule['continent']
    if 'country' in rule:
        if place.get('country') != rule['country']:
            return False
        return 'admin1' not in rule or place.get('state') == rule['admin1']
    return False


def scope_ids(places, scopes):
    """Scope ids of a role, in profile order. places: the 'places' list of geo.resolve() (dicts with country, state, continent)."""
    if not places:
        return [s['id'] for s in scopes if s['match'].get('any')]
    first = None
    for i, s in enumerate(scopes):
        if any(place_matches(p, s['match']) for p in places):
            first = i
            break
    if first is None:
        return []
    return [s['id'] for s in scopes[first:]]


def region_label(places, scopes, lang='en'):
    """The board's region label: the country name of the first place (from the geo tables), else the label of the narrowest
    scope that the role belongs to."""
    if places:
        cc = places[0].get('country') or ''
        info = geo.COUNTRY.get(cc)
        if info:
            return info.get('en', cc) if lang == 'en' else info.get('de', cc)
    ids = scope_ids(places, scopes)
    for s in scopes:
        if s['id'] in ids:
            return s['label'].get(lang) or s['label']['en']
    return ''
