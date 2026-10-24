"""The model places a posting partly by its language: a German posting sits near other German postings whatever the work.
These helpers find that language direction in the role vectors and remove it, so a CV in English also finds German postings.

  directions: for German, French and Spanish, the mean of that language's roles minus the mean of the English ones,
              made orthonormal (3 directions in the 256-number space)
  project:    x - (x . D) D, then unit length again

The directions are stored with the vectors (match-vec.json "lang_dirs") and applied to every vector that enters the space:
new roles, companies and, in the browser, the visitor's CV (jobcrawl/embed, phase 3).
"""
import re

WORDS = {'de': set('der die und wir sie mit für ihre das ist nicht auf eine einen bei zur sowie oder'.split()),
         'fr': set('les des et vous nous pour une dans avec sur est'.split()),
         'es': set('el los y para con una del que las por es'.split()),
         'en': set('the and you we with for our are your will this of to'.split())}


def language(text):
    w = re.findall(r'[a-zäöüßéèàçñ]+', text.lower()); c = {l: sum(1 for x in w if x in s) for l, s in WORDS.items()}
    l = max(c, key=c.get)
    return l if c[l] >= 6 else 'en'


def directions(X, langs, min_roles=20):
    import numpy as np
    D = []
    for l in ('de', 'fr', 'es'):
        if (langs == l).sum() < min_roles:
            continue
        d = X[langs == l].mean(0) - X[langs == 'en'].mean(0)
        for q in D:
            d = d - (d @ q) * q
        D.append(d / np.linalg.norm(d))
    return np.array(D, np.float32)


def project(X, D):
    import numpy as np
    if D is None or not len(D):
        return X
    Y = X - (X @ D.T) @ D
    return Y / np.maximum(np.linalg.norm(Y, axis=-1, keepdims=True), 1e-9)
