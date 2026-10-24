"""Reading a site folder (the board files jobcrawl build writes). Standard library only: the publish path imports this, not the board."""
import json
import os
import re


def read_site(site):
    """(index rows, {id: description entry}) of a site folder written by build()."""
    with open(os.path.join(site, 'jobs-index.json'), encoding='utf-8') as fh:
        index = json.load(fh)
    desc = {}
    for name in sorted(os.listdir(site)):
        if re.match(r'^jobs-desc-[0-9a-f]{2}\.json$', name):
            with open(os.path.join(site, name), encoding='utf-8') as fh:
                desc.update(json.load(fh))
    return index, desc
