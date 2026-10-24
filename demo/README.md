# Demo data

`demo/site/` is a complete data folder for the web app. Serve it with

```sh
python3 scripts/serve.py --data demo/site
```

and open http://localhost:8000/ (Jobs, Match me, Atlas). Matching and the map run in the browser, as they do on real data.

## What it contains

| | |
|---|---|
| roles | 1,051 public job postings, located in Bavaria |
| employers | 119 employer names (78 of them with an employer page, which the atlas uses as its companies layer) |
| descriptions | 1,039 roles with a description, each cut to an excerpt of at most 300 characters (see below) |
| role vectors | 1,030 (roles with too little text to embed have none) |
| company vectors | 78 |
| map | one atlas for Bavaria (the default view) and the worldwide view, which here is the same 1,051 roles |
| statements | autonomy, hands-on, research and customer; the defence statement is not published here (too few roles in the subset) |

The keyword index, the statements and the role neighbours are computed from the full postings, as the pipeline does for any board.

## Provenance

* The postings come from public job boards: the career pages and public applicant-tracking feeds of the employers listed in
  `profiles/aerospace/companies.json`.
* Crawled in October 2026. The first-seen dates of the roles run from 2020 to October 2026.
* The roles are the ones the reference board places in Bavaria, by the aerospace profile's `bavaria` scope (country DE, admin1
  Bavaria, see `profiles/aerospace/profile.json`). The board was built from the reference implementation's crawl with that profile.
* Titles, employer names, locations, posting links, field tags, levels, regions and vectors are kept as derived or identifying data.

## The excerpt rule

Job advertisements are third-party text. The demo therefore carries:

* the posting link of every role (`u`), which leads to the full advertisement;
* an excerpt of its description (`x`): the first 300 characters of the work text, with the employer's boilerplate removed
  (`jobcrawl/text/work_text.py`). No description is longer than 300 characters, in any file of the folder;
* derived data: field tags, level, regions, the role vectors (256 small integers each, not text) and the keyword index.

The keyword index is built from the full text before the excerpts are cut (`jobcrawl publish --text-from`). It keeps, per role, a
count of each word that occurs in the title and in the first 3,000 characters of the description, and the word order is not kept.
The full texts are not in this repository and are not in `demo/site/`.

## Removing a role or the demo

Open an issue at https://github.com/egidinas/jobcrawl/issues with the role id (the 8 hex digits of the role's id in the
data, or the posting link). A role that is taken down is removed from the next published version of the demo; the whole demo
is removed on request.

## How to rebuild

`scripts/make_demo.py` builds this folder from a board in the reference formats (the one it was made from is read-only input; it is
not part of this repository):

```sh
python3 scripts/make_demo.py \
  --source-site /path/to/board/site \
  --source-vectors /path/to/board/vectors \
  --work /path/outside/this/repository/demo-work \
  --write-labels profiles/aerospace/labels.json \
  --python python3 \
  --map-python /path/to/python/with/umap-learn-leidenalg-igraph
```

* `--work` holds the full texts and the vectors while the demo is built. It must be outside this repository (the script refuses otherwise).
* `--python` needs numpy (the neighbours step). `--map-python` needs the map extra (`requirements-map.txt`).
* The script replaces `--out` (default `demo/site`).

What the script changes from the aerospace profile, and why:

* the scopes are narrowed to `bavaria` and `worldwide` (the atlas needs the `any` scope; every role is in both);
* the title and tagline say that this is the demo;
* the footer links to the two reference implementations (madenetwork.de and jobs.jmeyer.space), as the aerospace profile does;
* the companies layer uses the employer names of the subset (no company profiles: the names are all the atlas gets);
* the Bavaria group names come from the reference labels (`profiles/aerospace/labels.json`): 41 of the 43 groups keep a name;
  the other two keep their word labels, as designed. Labels whose role ids are no longer on the reference board are dropped.

The folder is publish-and-map output of the repository's own commands: `jobcrawl publish --text-from` and `jobcrawl map` (see the
README for the full pipeline).
