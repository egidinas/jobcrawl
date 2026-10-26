# Profile schema

A profile is a folder with a `profile.json` and the files it names. Paths in `profile.json` are relative to the
profile folder. Every key below is optional unless marked **required**. Unknown keys are ignored.

The crawler reads the `crawl` keys and the top-level `data_dir`. The Python pipeline (`jobcrawl`, `jobcrawl/profile.py`) reads
everything else. `profile.py` fills every default below and rejects a wrong value with the key's path in the message, e.g.
`profiles/x/profile.json: fields[2].keywords[0]: expected a string, got int`. Unknown keys are ignored by both readers.

## Top level

| key | type | default | read by | meaning |
|---|---|---|---|---|
| `name` | string | folder name | crawler, `profile.py` | short identifier, shown in logs |
| `title` | string | `""` | web config | title of the site built from this profile |
| `tagline` | string | `""` | web config | one line under the title |
| `languages` | list of `en`/`de` | `["en"]` | board, web config | languages of the labels; a label without `de` uses its `en` text |
| `data_dir` | string | none | crawler, catalog, run | data folder, relative to the profile folder. Used when `--data` is not given; else `./data`. The Python build takes `--catalog` explicitly |
| `companies_catalogue` | string | none | `jobcrawl embed`, atlas | optional employer catalogue for the companies layer of the Atlas, relative to the profile folder: JSON `{"companies": [{"slug", "name", "field", "arch_name", "profile": {"en": "..."}}]}`. `slug` and `name` are required; `field`, `arch_name` and `profile` add to the company's text (`embed/companies.py`). Without it the companies are not embedded and the Atlas has no companies layer |
| `accent` | CSS hex colour (`#rgb` or `#rrggbb`) | none | web config | accent colour of the web app (buttons, links, highlights); without it the app's built-in colour is used |
| `links` | object `{"reference": [{"label", "url"}]}` | `{"reference": []}` | web config | links shown in the web app's footer, only when there are any; `url` must be http or https. Use them for sites that show the same data or are the reference implementation of the profile |

## `board`: the order of the roles (optional)

| key | type | default | effect |
|---|---|---|---|
| `board.order` | `first_seen` or `published` | `first_seen` | the order of `jobs-index.json` and `jobs.json`. `first_seen`: newest first by the day the crawler first saw a role (`fs`). `published`: newest first by the posting date (`d`, the source's posted date, or the first-seen day when the source gives none). Ties: company, then title |

## `web`: site settings of the web app (all optional, copied into `config.json`)

Defaults fit the bundled pages (`web/`). A site that hosts the modules in its own pages sets what differs.

| key | type | default | effect |
|---|---|---|---|
| `web.role_url` | string with `{id}` | `index.html#{id}` | link to a role's detail page, e.g. `job.html?id={id}`. With it, the cards say "Full role page" and near-duplicates link there too |
| `web.company_url` | string with `{slug}` | none | link to an employer's page, e.g. `company-{slug}.html`; without it no company links are shown |
| `web.company_texts` | file in the data folder | none | `{slug: [text, ...]}`: the texts the Atlas shows on company cards |
| `web.default_scope` | a scope id | the first scope | the scope Match me, the Atlas and the job list start with |
| `web.atlas_maps` | `worldwide` or `per_scope` | `worldwide` | the Atlas's Where filter: one map for every filter (filters hide what is outside, the view fits the rest); `per_scope` builds a separate map per region filter, as before |
| `web.model_url` | path | `models/eg2/` | the model folder, relative to the web root (the folder above `assets/`) |
| `web.storage.prefix` | string | `jobcrawl` | the visitor's data is kept in the browser as `<prefix>-ratings`, `-prefs`, `-cv`, `-persona`, `-explored`, `-settings` |
| `web.storage.lang` | string | `<prefix>-lang` | where the language choice is kept (share it with the site's own pages) |
| `web.storage.model_cache` | string | `<prefix>-eg2-v1` | name of the browser cache that keeps the model files |
| `web.storage.profile_kind` | string | `jobcrawl-profile` | the `kind` of a saved profile file; only files of this kind are loaded |
| `web.storage.profile_file` | string | `jobcrawl-profile.json` | file name offered when the visitor saves the profile |

Keep `storage` stable once a site is public: changing a name makes visitors' saved ratings invisible to the app.

The data folder of the bundled pages is `?data=<folder>`, else `<meta name="jobcrawl-data" content="<folder>">` in the page, else
`data/`. A site that serves `config.json`, `jobs-*.json` and `match/` from its root sets the meta tag to `./`.

## `crawl`

| key | type | default | read by | meaning |
|---|---|---|---|---|
| `crawl.companies_file` | string | `companies.json` | crawler | the company list: `tracked_companies` with the ATS boards to poll, plus the filters below when the profile does not set them |
| `crawl.catalogue_file` | string | none | crawler, discover | optional employer catalogue (names and aliases, `companies` list). Its names count as protected employers (never pruned by probation). Not needed for a profile without one |
| `crawl.user_agent` | string | `Mozilla/5.0 (compatible; jobcrawl; +https://github.com/egidinas/jobcrawl)` | crawler, discover, ats-resolve, board-labels | user agent of every request. Name your crawler and give a URL where site owners can read what it does |
| `crawl.review_dir` | path | the data folder | ats-resolve | where the review lists (`ats_resolve_<label>.csv/.json`) are written, e.g. next to the companies file when they are kept in version control |
| `crawl.relevance.keywords` | list of strings | `[]` | relevance gate, probation | a role is relevant when its title or department matches one of these (see syntax below). With an empty list nothing is relevant |
| `crawl.relevance.negative` | list of strings | `[]` | relevance gate | titles that match a keyword by accident (`search engine`, `flight attendant`) are never relevant |
| `crawl.relevance.ssic_deeptech` | list of strings | `[]` | Singapore-style strict gate | SSIC industry code prefixes (Singapore Standard Industrial Classification) that count as the profile's sector. Only used by the MyCareersFuture provider |
| `crawl.min_free_mb` | number >= 0 | `0` (off) | crawler | refuse to start when the disk holding the data folder has less than this many MB free: the crawl exits with code 3 before fetching or writing anything. `--dry-run` skips the check |
| `crawl.jd_keep_days` | number >= 0 | `90` | crawler | a role's saved description (`<data>/jd/`) is removed once the role has not been seen for more than this many days (its history row is not `open`). Open roles are never touched and the history rows are kept. `0` keeps every description. `node crawler/crawl.mjs --profile <dir> --jd-cleanup-only` runs just this step |
| `crawl.title_filter` | object | none | crawler | when set, replaces `title_filter` in the companies file (same shape, see below) |
| `crawl.location_filter` | object | none | crawler | when set, replaces `location_filter` in the companies file |

### Keyword syntax (relevance and title filters)

* Plain entries are substrings, matched case- and accent-insensitively (`Pruf` matches `Prüfer`).
* `word:` entries match whole words only (`word:space` matches "Space Engineer" but not "Workspace").
* Matching runs on the title, and on the department or team when the board gives one.

### `title_filter` and `location_filter` (in the companies file, or in the profile)

```json
"title_filter": {
  "positive": ["Engineer", "word:Lead"],
  "negative": ["Intern", "Working Student"],
  "seniority_boost": ["Senior", "Lead"]
},
"location_filter": {
  "allow": ["Germany", "Berlin"],
  "block_hard": ["India"],
  "allow_unknown": true
}
```

* `title_filter.positive` empty means every title passes the positive test. `negative` always drops.
* `location_filter.allow` is a list of place names; `block_hard` drops; `allow_unknown` keeps roles whose location is empty.
* `seniority_boost` only marks roles in the output (`seniority` in last-new.json); it does not filter.

### Companies file entries (`tracked_companies`)

| key | type | meaning |
|---|---|---|
| `name` | string, **required** | employer name as shown |
| `provider` | string, **required** | ATS or aggregator id from `crawler/providers.mjs` (greenhouse, lever, ashby, personio, workday, ...) |
| `slug` | string | board id for the provider. Required unless `careers_url` lets the provider detect it |
| `careers_url` | string | the public careers page; the slug is detected from it when `slug` is missing |
| `enabled` | bool | default `true`; `false` skips the company |
| `interval_hours` | number | fetch only when due (2 to 48 h); without it, every run fetches it |
| `probation` | bool | gate roles on `crawl.relevance` until one relevant role shows up; pruned after 5 cycles with only irrelevant roles |
| `relevance` | `strict` / `broad` / `off` | per-entry relevance gate. Default: `strict` for MyCareersFuture, `off` for the rest |
| `only_locations` | list | keep only roles whose location contains one of these (for boards that list the whole world) |
| `max_jobs` | number | cap on the number of postings read, for providers that page |
| `extra_positive` | list | extra title keywords for this employer only |
| `location_only`, `location_allow` | list | per-employer location lists |

Provider-specific keys (`queries`, `feed_url`, `url_pattern`, `region`, ...) are documented in the provider's code in
`crawler/providers.mjs` and `crawler/providers-extra.mjs`.

Top level of the companies file: `title_filter`, `location_filter`, `tracked_companies`, and `max_aggregator_age_days`
(default 270: aggregator postings older than this are dropped).

## Pipeline keys (Python: `jobcrawl`)

Labels are objects `{"en": "...", "de": "..."}`; `en` is required, `de` defaults to `en`.
Ids (`scopes[].id`, `fields[].id`, `levels[].code`, `statements[].id`, `personas[].id`) are lower case: letters, digits and `_`, starting with a letter.

### `scopes`

List of search scopes, **narrowest first** (the reference profile: bavaria, germany, europe, worldwide). Read by `classify/scopes.py`
(a role's `sc`), the board's `r` (region label), the keyword index (`index/match_index.py`), the Atlas (`map/atlas.py`: every scope with
at least `map.min_scope` roles gets a map of its own, the `any` scope is the worldwide map) and the web app.

| key | type | default | meaning |
|---|---|---|---|
| `scopes[].id` | id | **required** | written into `sc` of every role |
| `scopes[].label` | label | **required** | shown in the web app |
| `scopes[].match` | object | **required** | which places count, one of: `{"any": true}`; `{"continent": "EU"}`; `{"country": "DE"}`; `{"country": "DE", "admin1": "Bavaria"}` (admin1 = the English state name of the geo tables) |

A role belongs to the scope of its narrowest matching place and to every scope listed after it. A role without a place belongs to the
`any` scopes. Default: `[{"id": "worldwide", "label": {"en": "Worldwide", "de": "Weltweit"}, "match": {"any": true}}]`.

### `fields`

Field tags (`tg`). Read by `classify/fields.py`; the web app shows the labels.

| key | type | default | meaning |
|---|---|---|---|
| `fields[].id` | id | **required** | the field's name in the profile |
| `fields[].tag` | string | the id | what the board writes into a role's `tg` and the web app looks the label up by. Set it when an existing board writes names (e.g. `"AIT & Testing"`) instead of ids |
| `fields[].label` | label | **required** | shown in the web app |
| `fields[].keywords` | list of strings | `[]` | matched on the title, the description and the employer (see below). `word:` entries match whole words |
| `fields[].company_keywords` | list of strings | `[]` | plain substrings of the employer name (a field tagged from its employers) |
| `fields[].pillar` | bool | `false` | `true`: matched on title, description or employer, and tagged first (before the title pass) |

Matching: lower case and accents removed on both sides (`Prüfer` matches `prufer`). Plain keywords are substrings; `word:` keywords
match whole words (`word:space` matches "Space Engineer" but not "Workspace"), as in `crawler/relevance.mjs`.
Order: pillar fields (title, description or employer), then the other fields on the title, then on the description and employer.

Top-level `max_field_tags` (integer >= 1, default `5`): the cap on the number of tags of one role.

Default for `fields`: `[]` (no field tags).

### `levels`

Seniority bands (`lv`), read by `classify/levels.py`. Tested **in list order**: the first band whose `pattern` matches gives the code;
the band with `"pattern": null` is the default (exactly one is required). `rank` orders the filter in the web app (lowest first).

| key | type | default | meaning |
|---|---|---|---|
| `levels[].code` | id | **required** | written into `lv` |
| `levels[].label` | label | **required** | shown in the web app |
| `levels[].rank` | integer | `0` | display order, lowest first |
| `levels[].pattern` | regex or null | **required** | case-insensitive regular expression on the title; `null` for the default band |

Default: the five bands of the reference board (student, lead, senior, entry, mid), `DEFAULT_LEVELS` in `profile.py`.
The title rules of `jobcrawl/classify/seniority.py` (a ladder of rungs: Chief, Director, Head, ... Student) are a separate port; the
board uses the bands above.

### `statements`

Directions for "Match me" and the Atlas (`index/prefs.py`; the web app shows the labels). Each statement has two poles.

| key | type | default | meaning |
|---|---|---|---|
| `statements[].id` | id | **required** | written into `match-prefs.json` |
| `statements[].a`, `.b` | label | **required** | the two poles |
| `statements[].a_regex`, `.b_regex` | regex | **required** | words that roles use about themselves (title and first 3,000 characters of the description), case-insensitive |

Default: `[]`. The reference profile has the five statements of the reference board (`prefs.py`).

### `personas`

Starting points for "Match me" when there is no CV (web app, `site/assets/profile.js` in the reference site).

| key | type | default | meaning |
|---|---|---|---|
| `personas[].id` | id | **required** | |
| `personas[].label` | label | **required** | |
| `personas[].regex` | string | **required** | the regular expression source (no slashes) matched on role titles |
| `personas[].flags` | string | `"i"` | JavaScript flags, letters from `imsu`, each once |

Default: `[]`.

### `glossary`

`[[en, de], ...]` pairs of job vocabulary. Read by the web app (`match.js`) and the keyword index (`index/match_index.py`) to translate query words.
Default: `[]`.

### `map`

Atlas layout (`map/atlas.py`; needs the `map` extra).

| key | type | default | meaning |
|---|---|---|---|
| `map.k` | integer >= 2 | `15` | neighbours per role in the grouping graph |
| `map.layout_k` | integer >= 2 | `45` | neighbours for the UMAP placement |
| `map.min_dist` | number >= 0 | `0.25` | UMAP minimum distance |
| `map.even` | number 0 to 1 | `0.7` | share of the radial redistribution in `relax()` |
| `map.reps` | integer >= 1 | `3` | representatives per company and group |
| `map.signature` | number 0 to 1 | `0.8` | share of an employer's average direction removed |
| `map.min_scope` | integer >= 0 | `600` | a scope gets its own map from this many roles on |
| `map.labels_file` | string or null | `null` | JSON of hand-written group names (relative to the profile folder) |
| `map.resolution` | [coarse, fine] numbers | `[1.6, 5.0]` | Leiden resolutions of the reference layout; written into `atlas-layout.json`. The group counts are searched as before (about n^0.35 regions), so this is a record, not an input |

### `embed`

Embedding recipe (`embed/roles.py`, `embed/embedder.py`, `embed/companies.py`).

| key | type | default | meaning |
|---|---|---|---|
| `embed.model_repo` | string | `onnx-community/embeddinggemma-2-ONNX` | Hugging Face repository the model is downloaded from (`scripts/fetch_model.py --profile P`) |
| `embed.prompt` | string | `search-query` | task prefix of the text |
| `embed.max_tokens` | integer >= 1 | `256` | tokens per text |
| `embed.text_chars` | integer >= 1 | `700` | characters of the work text (`text/work_text.py`) taken after the title |

## Pipeline key reference (what reads what)

| profile key | jobcrawl module |
|---|---|
| `scopes` | `classify/scopes.py`, `board.py` (`sc`, `r`) |
| `fields`, `max_field_tags` | `classify/fields.py`, `board.py` (`tg`) |
| `board.order` | `board.py` (the order of `jobs-index.json`, `jobs.json`) |
| `levels` | `classify/levels.py`, `board.py` (`lv`) |
| `languages`, `title`, `tagline`, `scopes`, `fields`, `levels`, `personas`, `glossary` | `index/publish.py` (`config.json`) and the web app |
| `statements` | `index/prefs.py` (`match-prefs.json`) |
| `map`, `scopes` | `map/atlas.py`, `map/labels.py` (`atlas-layout.json`) |
| `embed` | `embed/` and `scripts/fetch_model.py` |
| `companies_catalogue` | `embed/companies.py`, `map/atlas.py` |
| `accent`, `links` | `index/publish.py` (into `config.json`), web app footer and colour |
| `web.*` | `index/publish.py` (into `config.json`), `web/assets/app.js` |
| `crawl`, `data_dir`, `name` | the crawler (`crawler/*.mjs`) |
