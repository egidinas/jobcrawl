# Profile schema

A profile is a folder with a `profile.json` and the files it names. Paths in `profile.json` are relative to the
profile folder. Every key below is optional unless marked **required**. Unknown keys are ignored.

The crawler reads the `crawl` keys and the top-level `data_dir`. Later phases add the pipeline keys (fields, scopes, levels,
statements, personas, glossary, map, embed); they are appended here when they are implemented.

## Top level

| key | type | default | read by | meaning |
|---|---|---|---|---|
| `name` | string | folder name | crawler | short identifier, shown in logs |
| `title` | string | none | later (web config) | title of the site built from this profile |
| `tagline` | string | none | later (web config) | one line under the title |
| `languages` | list of `en`/`de` | `["en"]` | later | languages of the site and the labels |
| `data_dir` | string | none | crawler, catalog, run | data folder, relative to the profile folder. Used when `--data` is not given; else `./data` |

## `crawl`

| key | type | default | read by | meaning |
|---|---|---|---|---|
| `crawl.companies_file` | string | `companies.json` | crawler | the company list: `tracked_companies` with the ATS boards to poll, plus the filters below when the profile does not set them |
| `crawl.catalogue_file` | string | none | crawler, discover | optional employer catalogue (names and aliases, `companies` list). Its names count as protected employers (never pruned by probation). Not needed for a profile without one |
| `crawl.relevance.keywords` | list of strings | `[]` | relevance gate, probation | a role is relevant when its title or department matches one of these (see syntax below). With an empty list nothing is relevant |
| `crawl.relevance.negative` | list of strings | `[]` | relevance gate | titles that match a keyword by accident (`search engine`, `flight attendant`) are never relevant |
| `crawl.relevance.ssic_deeptech` | list of strings | `[]` | Singapore-style strict gate | SSIC industry code prefixes (Singapore Standard Industrial Classification) that count as the profile's sector. Only used by the MyCareersFuture provider |
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
