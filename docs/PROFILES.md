# Writing a profile

A profile is a folder that says what jobcrawl should look for, where, and how to show it. The stages in `docs/ARCHITECTURE.md` do
not change between fields; the profile does. This guide walks through a new one, using `profiles/minimal` as the worked example.
Every key, its type and its default is in [`profiles/schema.md`](../profiles/schema.md); this guide says which keys to set first.

## What goes in the folder

```
profiles/my-field/
  profile.json      the field: keys for the crawler and the pipeline (schema.md)
  companies.json    the employers to poll, with their public job boards (the crawler's list)
  labels.json       optional: hand-written names for the map's groups (map.labels_file)
```

Paths inside `profile.json` are relative to the folder. Start by copying a working profile:

```sh
cp -r profiles/minimal profiles/my-field
```

## 1. Check that the profile loads

After every change, run the loader. It names the key that is wrong:

```sh
python3 -c "from jobcrawl.profile import load_profile; p = load_profile('profiles/my-field'); print(p['name'], [s['id'] for s in p['scopes']])"
```

An error looks like `profiles/my-field/profile.json: fields[2].keywords[0]: expected a string, got int`.

## 2. Name the field

```json
{
  "name": "my-field",
  "title": "Software jobs in Germany",
  "tagline": "Software roles from three public job boards, one country.",
  "languages": ["en"],
  "data_dir": "data"
}
```

`name` is the short identifier in logs. `title` and `tagline` are shown in the web app. `languages` is `["en"]` or `["en", "de"]`; with
`de`, every label needs a German text or falls back to its English one.

## 3. Choose the employers (`companies.json`)

`companies.json` lists the employers the crawler polls. Each entry needs a name and a provider (an applicant-tracking system or
aggregator id from `crawler/providers.mjs`) and, for most providers, the board's slug. The slug is the name in the employer's public
job-board URL. The minimal profile polls three boards:

```json
{
  "tracked_companies": [
    { "name": "Stripe", "careers_url": "https://stripe.com/jobs", "provider": "greenhouse", "slug": "stripe", "enabled": true, "interval_hours": 12 },
    { "name": "Celonis", "careers_url": "https://www.celonis.com/careers/", "provider": "greenhouse", "slug": "celonis", "enabled": true, "interval_hours": 12 },
    { "name": "Palantir", "careers_url": "https://www.palantir.com/careers/", "provider": "lever", "slug": "palantir", "enabled": true, "interval_hours": 12 }
  ]
}
```

* `interval_hours` (2 to 48) polls an employer only when it is due.
* `enabled: false` skips an employer without removing it.
* A provider's own keys (`queries`, `feed_url`, `region`, ...) are documented in `crawler/providers.mjs` and `crawler/providers-extra.mjs`.
* Read the employer's terms before adding it, and keep the interval long (see the README's responsible crawling notes).

The file also holds the title and location filters for all employers at once. `profiles/minimal/companies.json` sets them (abridged here; the file lists 13 titles each way and 11 places):

```json
"title_filter": { "positive": ["Software", "Developer", "Engineer", "DevOps", "Backend"], "negative": ["Intern", "Sales", "Recruiter"] },
"location_filter": { "allow": ["Germany", "Berlin", "Munich"], "block_hard": [], "allow_unknown": true }
```

A title passes when it matches a `positive` entry (an empty list lets every title through) and no `negative` entry. A location passes
when it matches an `allow` entry, is not in `block_hard`, or is empty and `allow_unknown` is true.

## 4. Say which roles are relevant (`crawl.relevance`)

```json
"crawl": {
  "companies_file": "companies.json",
  "relevance": {
    "keywords": ["software", "developer", "word:backend", "word:devops", "machine learning"],
    "negative": ["word:sales", "recruiter", "intern"]
  }
}
```

Keyword syntax: a plain entry is a substring, matched without case and accents (`Prüfer` matches `prufer`); a `word:` entry matches
whole words only (`word:space` matches "Space Engineer" but not "Workspace"). Matching runs on the title, and on the department
when the board gives one.

These keywords decide relevance for the employers that ask for it: an entry with `"relevance": "strict"` or `"broad"`, or with
`"probation": true` (the employer is gated until one relevant role shows up, and pruned after five cycles with only irrelevant
roles). Employers without either setting are not gated by these keywords. The minimal example sets neither, so its keyword list is
the syntax example rather than a filter; add `"probation": true` to an entry to use it. `schema.md` lists the details.

## 5. Name the regions (`scopes`)

Scopes are the regions a visitor can filter by, narrowest first. A role belongs to the narrowest scope that matches its location,
and to every wider scope after it. A profile without `scopes` gets one scope, `worldwide`, which holds every role. The reference
profile has four:

```json
"scopes": [
  { "id": "bavaria", "label": { "en": "Bavaria", "de": "Bayern" }, "match": { "country": "DE", "admin1": "Bavaria" } },
  { "id": "germany", "label": { "en": "Germany", "de": "Deutschland" }, "match": { "country": "DE" } },
  { "id": "europe", "label": { "en": "Europe", "de": "Europa" }, "match": { "continent": "EU" } },
  { "id": "worldwide", "label": { "en": "Worldwide", "de": "Weltweit" }, "match": { "any": true } }
]
```

Keep one scope with `"any": true` (the worldwide one): the atlas takes its whole-field map from it. `admin1` takes the English state
name of the GeoNames tables.

## 6. Tag the fields (`fields`)

Field tags describe what a role is about (`tg`), in the words of the field. Each field has an id, a label, and keywords:

```json
"fields": [
  { "id": "backend", "label": { "en": "Backend", "de": "Backend" }, "keywords": ["word:backend", "word:api", "microservice"] },
  { "id": "data", "label": { "en": "Data & ML", "de": "Daten & ML" }, "keywords": ["machine learning", "word:ml", "data engineer"] }
]
```

Keywords are matched on the title, the description and the employer. A field with `"pillar": true` is matched first, before the title
pass, and `company_keywords` tag a field from employer names. `max_field_tags` (default 5) caps the tags of one role. A profile
with no fields gives its roles no tags.

## 7. Set the seniority bands (`levels`)

The defaults are five bands (student, entry, mid, senior, lead), which work for most fields in English and German titles. A band is a
case-insensitive regular expression on the title, tested in list order; the band with `"pattern": null` is the default. `rank` orders
the filter. Change a band only when the titles of your field need it, and test it on a few titles first.

## 8. Optional: statements, personas, glossary, labels, links

* `statements` (two poles each, with the words roles use about themselves) give Match me and the atlas a direction to lean along. Each
  statement is published only when it separates held-out roles well (AUC of at least 0.75); `jobcrawl publish` prints the AUC of each one.
* `personas` are starting points for visitors without a CV: a label and a regular expression on the titles.
* `glossary` is a list of `[en, de]` pairs, used to read query words in both languages.
* `map.labels_file` names the atlas groups by hand; a missing file means the groups keep their word labels.
* `links.reference` lists sites that show the same data, in the footer. `accent` sets the colour.

## 9. Run the pipeline

```sh
node crawler/run.mjs --profile profiles/my-field --data data/my-field --jd --build
python3 -m jobcrawl publish --site data/my-field/site --profile profiles/my-field
```

The first run only sees the roles that the employers publish today. Without a model the site works on keywords; step 2 to 5 of the
README add vectors, the statements' directions, the neighbours and the atlas.

## Worked example: `profiles/minimal`

`profiles/minimal` is the smallest working profile: software roles in Germany from three employers.

| file | what it sets |
|---|---|
| `profile.json` | `name`, `title`, `tagline`, `languages` (`en`), `data_dir`, and `crawl.relevance` (keywords and negatives for software roles) |
| `companies.json` | three Greenhouse and Lever boards, a title filter for software roles, a location filter for Germany (plus unknown locations) |

Everything else takes its default: one `worldwide` scope, the five default levels, no fields, no statements, no personas, no labels,
no accent and no reference links. Its `companies.json` holds the employers' names and slugs, the filters, and a comment that says what
the example is for.

What a run of it gives: the crawler keeps the roles whose title passes the filter and whose location is in Germany; the board writes
`jobs-index.json` and the description shards; `publish` writes the keyword index and `config.json`, and, with vectors, the rest. The
example has no field tags.

To turn it into your own field, change the employers first (step 3), then the title filter (step 3), then the keywords (step 4), and run
step 1 again after each change. The keywords can wait until the list of roles looks right.
