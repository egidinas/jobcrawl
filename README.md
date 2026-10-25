# jobcrawl

jobcrawl crawls public job boards for any field, cleans and classifies the roles, embeds them, and explores them in a
static web app with three views: a searchable list of the roles, **Match me** (rank the roles by a CV, a few statements or
free text) and the **Atlas** (a map of the roles, grouped by meaning).

The pipeline: crawl public ATS feeds -> clean -> classify -> embed -> explore.

Everything that depends on the field comes from a **profile**: a folder with the employers to poll, the keywords, the regions,
the field tags, the seniority bands and the map settings. `profiles/aerospace` is the reference profile (aerospace, space, defence
and photonics roles from European employers). `profiles/minimal` is the smallest working example.

Matching and the map run in the browser. Nothing you enter, no CV and no rating, is uploaded.

## 5-minute demo

Python 3 is all you need to see the web app; there is nothing to install.

```sh
git clone https://github.com/egidinas/jobcrawl
cd jobcrawl
python3 scripts/serve.py --data demo/site
```

Open http://localhost:8000/. The demo holds 1,051 public aerospace roles in Bavaria with short excerpts of their descriptions
(see `demo/README.md`). Match me runs on keywords and the statements without a model; a CV or free text needs the model (step 2 below).

## The full pipeline

Node 22 runs the crawler and the web app (no npm packages). The pipeline is Python 3.9 or newer.

```sh
# 1. crawl the employers of the profile into data/catalog.json, and build the board files in data/site (--build)
node crawler/run.mjs --profile profiles/aerospace --data data --build

# 2. optional, for CV and free-text matching: download EmbeddingGemma 2 into models/eg2 (not included; see NOTICE.md)
python3 scripts/fetch_model.py

# 3. optional: embed the roles (and the companies, when the profile names a catalogue) into data/vectors
#    needs requirements-embed.txt (numpy, onnxruntime, tokenizers, onnx)
python3 -m jobcrawl embed --site data/site --model-dir models/eg2 --profile profiles/aerospace

# 4. write the match files and config.json that the web app reads
python3 -m jobcrawl publish --site data/site --profile profiles/aerospace

# 5. optional, after step 3: the atlas layout (needs requirements-map.txt: umap-learn, leidenalg, igraph, scipy),
#    then publish again so the layout is copied into the match folder
python3 -m jobcrawl map --site data/site --profile profiles/aerospace
python3 -m jobcrawl publish --site data/site --profile profiles/aerospace

# 6. explore (--models models only when step 2 was run)
python3 scripts/serve.py --data data/site --models models
```

The Makefile wraps these steps (`make crawl build embed publish map serve PROFILE=profiles/aerospace DATA=data`). Without steps 2
and 3 the site works on keywords alone, and there is no atlas.

Dependencies: `requirements-embed.txt` and `requirements-map.txt` for the two optional steps. The crawler, `jobcrawl build`,
`jobcrawl publish` without vectors, and the web app need nothing beyond Node 22 and the Python standard library.

Map images: the Atlas page has a "Save as image" button (the current view, with area, employer and company names). For a
large export of the whole role map and the company map: `node scripts/export_atlas.mjs --data data/site --out exports
--scale 5 [--theme neon|light]` (needs Playwright). The neon theme (on black) is also what the page shows in dark mode.

Publishing on a small machine (a router, a static host's build step) without numpy: build the neighbour lists where the vectors are
made (`python3 -m jobcrawl neighbours --site data/site`, written into the vectors folder); publish then copies them and needs only
the standard library.

## Writing a profile

A profile is a folder with a `profile.json` and a `companies.json` (the employers to poll). Start from `profiles/minimal`, which
polls three software employers in Germany, and see:

* [docs/PROFILES.md](docs/PROFILES.md): how to write a profile for another field, with the minimal profile as the worked example;
* [profiles/schema.md](profiles/schema.md): every key, its type and its default.

## Reference implementations

* https://madenetwork.de/jobs.html: the aerospace board, with Match me and the Atlas, built from the reference profile.
* https://jobs.jmeyer.space: the same data in another layout.

This repository is a standalone version of the pipeline behind the first of these. Their branding, pages and the other things
that belong to those sites are not included.

## Not included

* the site builders and the branding of the reference sites, and their event, partner and people pages;
* the private job-search pipeline;
* the LLM classifiers (the heads trained on the classified roles);
* the company enrichment scripts and the ATS intelligence page;
* model weights: `scripts/fetch_model.py` downloads them under the Gemma Terms of Use, they are never committed;
* full job texts in the demo (the demo carries 300-character excerpts only).

## Documentation

* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the pipeline, the stages and every file format.
* [docs/PROFILES.md](docs/PROFILES.md): writing a profile.
* [docs/METHODS.md](docs/METHODS.md): the methods behind Match me and the Atlas, and what was measured.
* [demo/README.md](demo/README.md): the demo data, where it comes from, the excerpt rule and how to rebuild it.

## Licences

* The code is MIT licensed (`LICENSE`).
* Third-party code and data, and the terms of the model, are listed in `NOTICE.md`.
* The demo data is public job postings; see `demo/README.md` for the terms of the excerpts and how to ask for a removal.

## Responsible crawling

* The crawler identifies itself with a user agent that names the project and its repository.
* It fetches at most 8 employers at a time (`crawler/crawl.mjs`) and reads public feeds and pages only, without logins.
* The generic sitemap provider reads each site's `robots.txt` and honours its `Disallow` rules.
* Read a site's terms of use before you add it to a profile, and poll it no more often than it needs (`interval_hours`; the
  examples use 12 hours).
* LinkedIn is not crawled. Indeed, Glassdoor and XING are skipped by the crawler as well.
