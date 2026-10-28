# Third-party notices

jobcrawl's own code is MIT licensed (see `LICENSE`). The third-party code and data below are included, used or downloaded
under the terms stated here. Where a licence text is shipped, it sits next to the code it covers.

## Shipped in the web app (`web/assets/vendor/`)

| component | licence | where | notes |
|---|---|---|---|
| ONNX Runtime Web 1.30.0 (`onnxruntime-web`), Microsoft Corporation | MIT | `web/assets/vendor/ort/` (`LICENSE.txt`) | runs the embedding model in the browser |
| `@huggingface/tokenizers` (the browser tokenizer, `tokenizers.min.js`) | Apache-2.0 | `web/assets/vendor/` (`LICENSE-tokenizers.txt`) | tokenises the text for the model in the browser |
| pdf.js 4.10.38, Mozilla Foundation | Apache-2.0 | `web/assets/vendor/pdfjs/` (`LICENSE.txt`) | reads the text of a CV (PDF) in the browser; the CV never leaves the browser |

## Used at build time (`jobcrawl/geo/`)

| component | licence | where | notes |
|---|---|---|---|
| GeoNames gazetteer | Creative Commons Attribution 4.0 (CC BY 4.0), https://www.geonames.org | `jobcrawl/geo/gazetteer.tsv.gz` and `jobcrawl/geo/geo_coords.json`, built by `jobcrawl/geo/build_gazetteer.py` and `geo_coords.py` | place names with population, country and state, filtered to the places the profiles need. Attribution: "GeoNames geographical database, https://www.geonames.org, CC BY 4.0" |
| Natural Earth country and state polygons, Natural Earth (https://www.naturalearthdata.com) | public domain | downloaded by `jobcrawl/map/geo_base.py` into the cache of `jobcrawl geomap` (not shipped) | the cartogram's base map (110m countries, 10m states of Germany). Attribution: "Natural Earth (public domain)" |

## Downloaded, not included

| component | licence | where | notes |
|---|---|---|---|
| EmbeddingGemma 2 (ONNX, q4), `onnx-community/embeddinggemma-2-ONNX` | Gemma Terms of Use, https://ai.google.dev/gemma/terms | `scripts/fetch_model.py` downloads it to `models/eg2/`, `jobcrawl/model/split.py` prepares it for the browser | model weights are not in this repository (`models/` is in `.gitignore`); the terms of use apply to anyone who downloads and uses them |

## Ideas re-implemented

| component | licence | where | notes |
|---|---|---|---|
| career-ops, (c) 2026 Santiago Fernandez de Valderrama, https://github.com/career-ops-hq/career-ops | MIT | `crawler/providers-extra.mjs` (header) | the approaches of several applicant-tracking providers were re-implemented for this crawler's shape. No code was copied: the career-ops job type, HTTP layer and registry are not used |

## Data

* The demo data (`demo/site/`) is built from public job postings: titles, employers, locations, posting links, excerpts of 300
  characters and derived data. See `demo/README.md`.
* The profile `profiles/aerospace/` names public employers' job boards and the reference sites that it was taken from. The
  reference names for the Bavaria map (`profiles/aerospace/labels.json`) are the groups' names of that map.
