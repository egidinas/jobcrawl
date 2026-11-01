# EURES job-vacancy search backend

Notes from reverse-engineering the backend of the EURES portal (https://europa.eu/eures/portal/), as the crawler's
`crawler/providers-eures.mjs` uses it. Verified on **2026-11-01** with 15 requests (one per second, user agent
`jobcrawl/1 (+https://github.com/egidinas/jobcrawl)`); the captured responses, trimmed, are the fixtures
`crawler/tests/fixtures/eures-*.json`.

**Unofficial, may break.** The portal is an Angular app; these are the calls that app makes. Nothing here is a published API:
there is no documentation, no versioning, no stability or rate-limit promise from the operator, and the endpoints, fields and
code lists can change or disappear without notice. Treat every failure of the provider as "EURES changed" first.

**Legal.** The portal is run by the European Labour Authority (ELA). Its legal notice (https://eures.europa.eu/legal-notice_en)
states ELA's copyright and authorises re-use provided ELA is acknowledged as the source. The crawler therefore stores
`meta.source = "EURES (ELA)"` on every vacancy and suffixes the employer "(via EURES)". The portal's own terms of use are
linked from its disclaimer dialog (https://europa.eu/eures/portal/jv-se/home?lang=en&pageCode=find_a_job#openDisclaimerQualityDialog).
The detail document carries personal data of recruiters (`personContacts`: names, e-mail addresses, phone numbers). The provider's
`fetchDescription` reads it (owner's rule, 2026-11-01: contact data a posting publishes is collected with the posting and kept out
of the public outputs by a separate rule); the fixture drops that field and the tests use a synthetic contact ("Erika Mustermann").

**Community documentation.** https://github.com/rorar/EURES-API-Documentation (MIT) publishes a reverse-engineered OpenAPI 3.1
specification of 20 endpoints across three services (`jv-searchengine`, `shared-data-rest-api`,
`autocomplete-repository-rest-api`). It already lists the detail endpoint, the filters and the code lists below; everything
marked *verified* was re-checked live on 2026-11-01, the rest is taken from that specification.

## Portal URLs

| Page | URL |
|---|---|
| Search | `https://europa.eu/eures/portal/jv-se/search?page=1&resultsPerPage=10&orderBy=MOST_RECENT&keywordsEverywhere=<kw>&locationCodes=<code>&lang=en` |
| Search, employer mode (this crawler's parameter, see below) | `https://europa.eu/eures/portal/jv-se/search?page=1&resultsPerPage=10&orderBy=BEST_MATCH&keywordsEmployer=<name>&locationCodes=<code>&lang=en` |
| Vacancy | `https://europa.eu/eures/portal/jv-se/jv-details/<id>?lang=en` (verified: the lazy route `jv-details/:id` in `jv-se.routes-3K65JMYA.js`) |
| Advanced search | `https://europa.eu/eures/portal/jv-se/advanced` |

The app shell is `main-OJLS7FRG.js` (239 KB, `<base href="/eures/portal/">`); the job-search module is the lazy chunk
`jv-se.routes-3K65JMYA.js`, which loads `jv-search-page.component-HZ4AHKIF.js`, `jv-advanced-page.component-FEYZE7RN.js`,
`jv-details-page.component-H5TYD5ZN.js`, the saved-search and matching pages. The search-page component (where the URL query
parameters are read) was not downloaded within the request budget, so the parameter names above are the ones the portal's
address bar shows, not re-verified in the bundle. `detect()` reads `keywordsEverywhere` and `locationCodes` (repeated or
comma-joined) and, as a short form, `keyword` and `location`.

## Endpoints

Base URL `https://europa.eu/eures/api`. No authentication, cookies or CSRF token; plain JSON.

| Method | Path | Status | Purpose |
|---|---|---|---|
| POST | `/jv-searchengine/public/jv-search/search` | verified | the search: filters, paging, facets |
| GET | `/jv-searchengine/public/jv/id/{id}?requestLang=en[&preferredLang=]` | verified | one vacancy in full (all language profiles, locations with city, employer, application instructions) |
| GET | `/jv-searchengine/public/statistics/getNumberOfJobs` | verified | `{"numberOfJobs":2609810}` |
| GET | `/jv-searchengine/public/statistics/getCountryStats` | **503** on 2026-11-01 (`{"errorType":"SERVICE_UNAVAILABLE","errorMessage":"Unexpected error"}`) | vacancies per country with NUTS children (`label` may be null per the community spec) |
| GET | `/jv-searchengine/public/statistics/getSectorStats`, `getOccupationStats` | not called | per NACE sector, per ESCO occupation |
| GET | `/shared-data-rest-api/public/reference/countries` | verified | the 31 covered countries: `["AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","EL","HU","IS","IE","IT","LV","LI","LT","LU","MT","NL","NO","PL","PT","RO","SK","SI","ES","SE","CH"]` |
| GET | `/shared-data-rest-api/public/reference/nace` | not called | 21 NACE rev. 2 sections `[{id, code: "A", level: 1, revision: "2.0"}]` |
| GET | `/shared-data-rest-api/public/reference/languages`, `isoLanguages` | not called | portal languages (26), ISO 639-1 list |
| POST | `/shared-data-rest-api/public/esco/label/{lang}` body `["<esco uri>", ...]` | verified | `{ "<uri>": "<label>" }`, e.g. `.../occupation/2ff73126-...` → `"Pipe welder"` |
| GET | `/shared-data-rest-api/public/esco/occupation/tree` | not called | ISCO major groups `C0`–`C9` down to ESCO occupation URIs |
| GET | `/autocomplete-repository-rest-api/public/v2.0/occupations?language=en&keyword=<prefix>&nbResults=10` | not called | occupation name suggestions |

No code list for NUTS names is served (the only candidate, `getCountryStats`, failed); the crawler shows the country name from
the list above plus the NUTS code, e.g. `Germany (DE147)`. The detail document does give `cityName` and `postalCode` per
location, at the price of one request per vacancy.

## Search request

`POST /jv-searchengine/public/jv-search/search`, `Content-Type: application/json`. The body the portal sends, with every key
(the community spec marks all but `publicationPeriod`, `minNumberPost` and `userPreferredLanguage` as required; an empty array
means "no filter"):

```json
{
  "resultsPerPage": 50,
  "page": 1,
  "sortSearch": "MOST_RECENT",
  "keywords": [{ "keyword": "satellite", "specificSearchCode": "EVERYWHERE" }],
  "publicationPeriod": null,
  "occupationUris": [],
  "skillUris": [],
  "requiredExperienceCodes": [],
  "positionScheduleCodes": [],
  "sectorCodes": [],
  "educationAndQualificationLevelCodes": [],
  "positionOfferingCodes": [],
  "locationCodes": ["de"],
  "euresFlagCodes": [],
  "otherBenefitsCodes": [],
  "requiredLanguages": [],
  "minNumberPost": null,
  "sessionId": "jobcrawl",
  "userPreferredLanguage": null,
  "requestLanguage": "en"
}
```

| Field | Type | Values / notes |
|---|---|---|
| `resultsPerPage` | integer | **1–50**. 50 verified; 100 answers HTTP 400 `{"errorType":"java.lang.IllegalArgumentException","errorMessage":"Too many results per page were requested"}` |
| `page` | integer | 1-based. Pages 1 and 2 of the same query (seconds apart) had no overlap |
| `sortSearch` | enum | `MOST_RECENT` (verified: ordered by `lastModificationDate` descending, consistently across pages; `creationDate` is not monotonic), `BEST_MATCH` (verified for an `EMPLOYER` keyword: the exact employer's vacancies come first, the fuzzy matches after; `score` stays null) |
| `keywords[]` | `{keyword, specificSearchCode}` | `specificSearchCode`: `EVERYWHERE`, `TITLE`, `DESCRIPTION`, `EMPLOYER` (verified: a **fuzzy** match on the employer name, see "Employer and legal-id modes"), `LEGAL_ID`, `JOB_VACANCY_ID`. Empty list = no keyword |
| `publicationPeriod` | enum or null | `LAST_DAY`, `LAST_THREE_DAYS`, `LAST_WEEK` (verified: 398 of 754 "satellite"/de vacancies), `LAST_MONTH`, `LAST_VISIT` (needs a login) |
| `locationCodes[]` | string | lowercase NUTS 2024 codes: country `de`, region `de1`, district `de147`; `<country>-NS` = that country, region not specified. Several countries verified (`["de","fr"]` → 1,510 vs 754 for `de`) |
| `positionOfferingCodes[]` | enum | `apprenticeship`, `contract`, `contracttohire`, `directhire`, `internship`, `oncall`, `recruitmentreserve`, `seasonal`, `selfemployed`, `temporary`, `temporarytohire`, `volunteer`, `NS` |
| `positionScheduleCodes[]` | enum | `fulltime`, `parttime`, `flextime`, `NS` |
| `requiredExperienceCodes[]` | enum | `none_required`, `up_to_1_year`, `between_1_and_2_years`, `between_2_and_5_years`, `more_than_5_years`, `NS` |
| `educationAndQualificationLevelCodes[]` | enum | `basic`, `medium`, `bachelor`, `master`, `tertiary`, `doctoral`, `NS` (facets also show `not_classified` and EQF/ISCED children such as `eqf_6`, `isced_6`, which are not filter values) |
| `sectorCodes[]` | enum | NACE section letters, lowercase `a`–`u`, `NS` (the facet also lists a `v`) |
| `euresFlagCodes[]` | enum | `WITH` (cross-border vacancies promoted through the network), `WITHOUT` |
| `requiredLanguages[]` | string | `<iso639-1>(<CEFR>)`, e.g. `de(C2)`, `en(B1)` |
| `occupationUris[]`, `skillUris[]` | URI | ESCO occupation / skill URIs (`http://data.europa.eu/esco/occupation/<uuid>`) |
| `otherBenefitsCodes[]` | string | numeric codes; the facet shows `11`–`15` |
| `minNumberPost` | integer or null | minimum `numberOfPosts` |
| `sessionId` | string | any client-chosen string; no session is needed |
| `requestLanguage` | string | ISO 639-1; labels only. Titles and descriptions come in the vacancy's own language (`translationType: "FIRST_LANGUAGE"`) whatever is asked |
| `userPreferredLanguage` | string or null | |

## Search response

```json
{ "numberRecords": 754, "jvs": [ ... ], "facets": { ... } }
```

`jvs[]`, one vacancy (example values from the 2026-11-01 capture):

| Field | Type | Example / notes |
|---|---|---|
| `id` | string | `MTAwMDEtMTAwMzk0Mjk0Ny1TIDE`: unpadded base64 of `"<documentId> <connectionPointId>"` (`10001-1003942947-S 1`; a French one: `ODQ1ODk4MyA5` = `8458983 9`) |
| `title` | string | `AIT-Mechaniker - Integration Satelliten und Mechanismen (m/w/d) ...` |
| `description` | string | the whole text (4,901 characters here; byte-identical to the detail document's). HTML (`<p>`, `<ul>`, `<li>`, `<br>`) in 75 of 100 vacancies, entity-escaped plain text (`&amp;`) in the others |
| `creationDate` | integer | epoch ms, `1793401694685` = 2026-10-30T23:08:14.685Z |
| `lastModificationDate` | integer | epoch ms, `1793487190459`; the `MOST_RECENT` sort key |
| `numberOfPosts` | integer | `1` |
| `locationMap` | `{ "<CC>": [ "<NUTS>" or null ] }` | `{"DE":["DE147"]}`, `{"FR":["FRG05"]}`; uppercase; several countries and regions possible |
| `euresFlag` | boolean | `false` for all 100 captured |
| `jobCategoriesCodes` | URI[] | ESCO occupation URIs (`http://data.europa.eu/esco/occupation/<uuid>`), ISCO groups as `http://data.europa.eu/esco/isco/C<digits>`; 1–4 per vacancy |
| `positionScheduleCodes` | enum[] | `["fulltime"]`, `[]` |
| `positionOfferingCode` | enum (one string) | `directhire`, `temporary`, ... |
| `employer` | object | `{ name: "SimpleXX GmbH", legalID: null, organisationSizeCode: null, organisationOwnershipTypeCode: null, website: "http://www.go-simplexx.de", sectorCodes: [], description: null }`; `website` may be a bare domain or null |
| `availableLanguages` | string[] | `["de"]`: the keys of `translations` |
| `translations` | `{ "<lang>": { title, description } }` | the same text per language |
| `translationType` | string | `FIRST_LANGUAGE` |
| `score` | null | null in every captured response, `BEST_MATCH` included (per the community spec too) |

`facets`: `{ "<FACET>": { "facetEntriesList": [ { "code", "count", "childrenList": [...] } ] } }` for the whole result set,
which doubles as the live code list. Facets seen: `LANGUAGE_SKILLS` (`de`, `en`, ..., `NS`), `REQUIRED_EXPERIENCE`,
`POSITION_LOCATION` (countries with NUTS children: `de` → `dea`, `deb`, `ded`, ...; `be` → `be-NS`, `be1`...),
`NACE_CODE`, `CONNECTION_POINT_ID` (the feeding system: `1` for every German vacancy here = source `DE001`, the
Bundesagentur für Arbeit; the French one came through `9`), `EURES_FLAG`, `POSITION_SCHEDULE`, `POSITION_OFFERING`,
`EDUCATION_AND_QUALIFICATION_LEVEL`, `EXTRA_BENEFIT`. The trimmed fixture keeps four of them.

## Detail document

`GET /jv-searchengine/public/jv/id/<id>?requestLang=en` (7.6 KB for the example). Top level: `id`, `reference`
(`10001-1003942947-S`), `documentId`, `connectionPointId` (`1`), `source` (`DE001`), `creationDate`, `lastModificationDate`
(epoch ms), `preferredLanguage` (`de`), `jvProfiles` (one profile per language), `translationType`, `translation` (null).

`jvProfiles.<lang>`: `languageVersion`, `title`, `numberOfPosts`, `euresFlag`, `jobCategoriesCodes`, `positionOfferingCode`,
`positionScheduleCodes`, `description` (same text as the search response), `employmentPeriod` `{startDate, startDateText,
endDate, endDateText, periodDescription}`, `immediateStartIndicator`, `requiredSkills[]`, `workingLanguageCodes[]`,
`locations[]` `{countryCode: "de", region: "de147", cityName: "Immenstaad am Bodensee", postalCode: "88090", addressLines: [],
buildingAddress: null}` (codes lowercase here), `requiredExperiences[]`, `requiredDrivingLicenses[]`, `positionLanguages[]`
(`{languageCode, requiredSkillLevel, desiredSkillLevel, skillsEscoUri}`), `employer` (as in the search, plus
`organisationSizeCode: "medium-sizedenterprise"` and `sectorCodes: ["o78.2.0"]`, a NACE class), `applicationInstructions[]`
(free text, may contain an `<a>`; the German feed links the posting on arbeitsagentur.de), `personContacts[]` (recruiter name,
address, e-mail: personal data), and per the community spec also `lastApplicationDate`, `offeredRemunerationPackage`
(`salaries[] {minimumSalary, maximumSalary, currencyCode, payingIntervalCode, remunerationTypeCode}`),
`requiredEducationLevelCode`, `requiredQualificationLevelCode`, `requiredYearsOfExperience`, `travelPreference`.

The search response already carries the full description, so the search never needs this endpoint. The provider's
`fetchDescription(job)` GETs it (one request per vacancy; the crawl calls it only for a vacancy without a description, so in practice
the detail backfill does) and returns the description followed by a plain-text "Application and contact" section: the
`applicationInstructions` (an `<a>` keeps its link as "text (url)"), one `Contact:` line per `personContacts` entry (name, role, e-mail,
phone, address, any other field as `key: value`; the entry's shape is undocumented, so every string leaf is read), `lastApplicationDate`,
`employmentPeriod`, the employer's web site and NACE class, and the locations as `<postal code> <city>, <Country> (<NUTS>)`. The raw
capture stores the detail JSON byte for byte. When the call fails the job's own description comes back alone, nothing is logged.

## Limits and behaviour observed (2026-11-01)

* Page size at most 50; 100 is refused with HTTP 400 (message above). 50 vacancies are 290–340 KB of JSON and took 0.9–1.9 s;
  small calls 50–260 ms.
* Paging is consistent between consecutive requests; `MOST_RECENT` means `lastModificationDate` descending.
* A `503 SERVICE_UNAVAILABLE` came from `getCountryStats` while every other call succeeded: transient errors happen, the
  provider retries once after 2 s on 429/5xx.
* No rate-limit or quota headers were seen. The probe stayed at 15 requests, one per second; the provider reads at most 2,000
  vacancies (40 pages) per crawl and stops after 28 s so the crawl's 35 s per entry is kept.
* The pacing is host-wide, not per board: the crawl runs up to 8 boards at once and hundreds of them are EURES boards, so every
  request of the module (search pages, detail documents, ESCO labels) goes through one shared limiter that lets one request start
  per `EURES_MIN_GAP_MS` (default 1000 ms) in the whole process, whatever the number of boards.
* On a 429 the provider honours `Retry-After` (seconds or HTTP date, capped at 60 s; 10 s when absent), retries once, and doubles
  the host-wide gap for the next 60 s before returning to the default.
* `getNumberOfJobs` reported 2,609,810 active vacancies; the "satellite" keyword in Germany matched 754, in Germany and France
  1,510, of which 398 (Germany) were published in the last week.

## How the crawler maps a vacancy (`euresJob`)

| Job field | From |
|---|---|
| `id` | `id` |
| `title` | `title`, tags stripped |
| `url` | `https://europa.eu/eures/portal/jv-se/jv-details/<id>?lang=en` |
| `company` | `<employer.name> (via EURES)`, or `undisclosed (via EURES)` |
| `location` | per `locationMap` entry `"<Country> (<NUTS>)"`, e.g. `Germany (DE147)`; the country alone when the region is null or `-NS`; several joined with ` \| ` |
| `postedAt` | `creationDate` as ISO 8601 |
| `description` | `description` as plain text; `fetchDescription` appends the detail document's "Application and contact" section |
| `meta.nuts` | the NUTS codes (the country code when none) |
| `meta.contract` | `positionOfferingCode` (dropped when `NS`) |
| `meta.schedule` | `positionScheduleCodes` without `NS` |
| `meta.categories` | `jobCategoriesCodes`, resolved to English labels with one `esco/label/en` call per page (URIs stay when that call fails) |
| `meta.number_of_posts`, `meta.languages`, `meta.last_modified`, `meta.eures_flag` (only when true), `meta.employer_site` | `numberOfPosts`, `availableLanguages`, `lastModificationDate`, `euresFlag`, `employer.website` |
| `meta.source` | `EURES (ELA)` |

Profile entry: `{ "provider": "eures", "slug": "satellite|de,fr" }` (or a portal search URL as `careers_url`); optional
`max_jobs` (≤ 2,000) and `eures: { publicationPeriod, positionOfferingCodes, positionScheduleCodes, sectorCodes,
requiredLanguages, requiredExperienceCodes, educationAndQualificationLevelCodes, euresFlagCodes, occupationUris, skillUris,
minNumberPost, requestLanguage }` merged into the search body. `eures` is in `crosslist.mjs` `AGGREGATOR_PROVIDERS`.

## Employer and legal-id modes (2026-11-01)

Purpose (owner, 2026-11-01): for the employers a profile polls directly, also collect their EURES copies, because the EURES record is
richer in places (NUTS region, NACE sector, ESCO occupation URI, contract and schedule codes, number of posts, required languages,
contacts). The crawl recognises the copy as a cross-listing of the direct posting and the declared layer merges the fields per channel
later. Mechanism: one EURES board per tracked employer in a covered country, polled weekly.

| Mode | Slug | Portal URL (`detect` / `euresBoardUrl`) | `keywords[]` sent |
|---|---|---|---|
| keyword (unchanged) | `<keyword>\|<codes>` | `?keywordsEverywhere=<kw>` or `?keyword=<kw>`, `&locationCodes=`/`&location=` | `{keyword, specificSearchCode: "EVERYWHERE"}`, `sortSearch: MOST_RECENT` |
| employer | `employer:<name>\|<codes>` | `?keywordsEmployer=<name>` or the short form `?employer=<name>` | `{keyword: <name>, specificSearchCode: "EMPLOYER"}`, `sortSearch: BEST_MATCH` |
| legal id | `legalid:<id>\|<codes>` | `?keywordsLegalId=<id>` or `?legalId=<id>` | `{keyword: <id>, specificSearchCode: "LEGAL_ID"}`, `sortSearch: BEST_MATCH` |

`keywordsEmployer` and `keywordsLegalId` are this crawler's parameter names, modelled on the portal's `keywordsEverywhere`: the
advanced form has the fields, their URL parameters were not verified. One keyword per board; an employer parameter wins over a legal id,
which wins over an everywhere keyword. Paging, 50 per page, the 2,000 cap, the time budget, `max_jobs`, `entry.eures` and the mapping with
the `(via EURES)` suffix are the same in every mode.

**Probe result: `EMPLOYER` is a fuzzy match, not an employer filter.** `EMPLOYER` / `OHB` / `locationCodes: ["de"]`, `MOST_RECENT`
(request 16): **5,563** records; page 1 held 50 vacancies of 7 employers, 39 of them *ALDI SÜD Dienstleistungs- SE & Co. oHG*, then
*K2Trans OHG*, *Modehaus Jennerwein OHG*, *UPS DE S.à.r.l. & Co. OHG*, *Computacenter AG & Co. oHG*, *Werhahn & Nauen SE & Co. OHG*
and 2 of *OHB-System AG*; first title "Studentenjob Verkauf (m/w/d) (Helfer/in - Verkauf)". "OHB" matches "oHG" (edit distance 1,
the classic Elasticsearch `AUTO` fuzziness). Quoting the name (`"\"OHB\""`, request 17) changed nothing: the identical response. With
`sortSearch: BEST_MATCH` (request 18) the same 5,563 records come exact-employer first: page 1 was **50 of 50 OHB** (*OHB* ×3,
*OHB-System AG* ×47), first title "Technical Project Manager Earth Observation Missions (m/f/d) (Ingenieur/in - Luft- und
Raumfahrttechnik)". `employer.legalID` was `null` on every vacancy of the three pages, so the `LEGAL_ID` mode is implemented (the same
code path, only the code differs) but has no known use until a feed publishes the ids.

The provider therefore, in employer mode: sorts `BEST_MATCH`; keeps only the vacancies whose employer name contains the searched name
as whole words, in order and adjacent (`euresEmployerMatches`: "OHB System" matches "OHB-System AG" and "OHB System AG", not "OHB
Digital Connect GmbH"; "OHB" matches all three and not "K2Trans OHG"; case, diacritics, punctuation and the connectors and/und/& do
not count); resolves ESCO labels for the kept vacancies only; and stops at the first page that holds none (past the exact matches the
rest of the fuzzy result is other employers). A board for an employer with ~50 open vacancies costs two requests a week. In legal-id mode
nothing is filtered on this side (the vacancies do not carry the id).

**The boards generator** `node crawler/eures-employer-boards.mjs --profile <dir> [--codes de,fr,...] [--out <file>]` reads the
profile's companies file and catalogue, takes the enabled non-aggregator boards, one per employer (a board's `(workday) [tenant]`
decoration removed, the catalogue's `name`/`aliases` and `canonCompany` deciding which boards are one employer), and keeps an
employer when its `country_code` (or two-letter `country`) is one of the 31 portal countries (`gr` counts as the backend's `el`),
or its `location`/`address`/`country`/`state`/`city`/`headquarters` text names one of them, or nothing says where it is (included: an
empty EURES result costs one request a week). A known other country or a US state (the catalogue's `country` field often holds one)
drops it. The EURES keyword is the employer's short name: the catalogue's name when listed there, else the board's, trailing legal
forms stripped (GmbH, SE, AG, KG, & Co., Ltd, Inc, S.A., SAS, B.V., AB, Oy, A/S, Sp. z o.o., ...). Location codes: `--codes` for every
board, else the employer's own country, else none (every country). Employers with an EURES employer board already (any `eures` entry
whose slug is `employer:<name>|...`) are skipped. The entries are
`{ name: "EURES employer: <employer>", careers_url: <portal URL in employer mode>, provider: "eures", enabled: true, interval_hours: 168,
note: "EURES copies of <employer>'s postings for cross-listing and metadata; weekly" }`; the script prints a summary and does not modify
companies.json. Note that `crawl.mjs` caps the effective interval at 48 h (`Math.min(48, interval_hours)`, so that a role not confirmed
for three days is marked gone): the boards are in practice read every two days until that cap is changed.

## Probe log (2026-11-01, 15 requests, then 3 more for the employer mode)

1. search `satellite`/`de`, 3 per page → 200, 754 records
2. same, 50 per page → 200, 50 vacancies
3. same, 100 per page → **400** "Too many results per page were requested"
4. same, 50 per page, page 2 → 200, 50 vacancies, no overlap with page 1
5. same, `publicationPeriod: LAST_WEEK` → 398 records
6. `locationCodes: ["de","fr"]` → 1,510 records
7. detail of the first vacancy → 200
8. `getNumberOfJobs` → 2,609,810
9. `reference/countries` → 31 codes
10. `getCountryStats` → **503**
11. `esco/label/en` for 4 URIs → 4 labels
12. portal shell `/eures/portal/jv-se/home` → bundle names
13. `main-OJLS7FRG.js` fetched at the wrong path (the SPA fallback page came back)
14. `main-OJLS7FRG.js` (239 KB): the app shell, lazy route chunks
15. `jv-se.routes-3K65JMYA.js` (3.6 KB): the job-search routes
16. search `EMPLOYER` `OHB`/`de`, 50 per page, `MOST_RECENT` → 200, **5,563** records, 2 of 50 are OHB (fuzzy: "oHG" matches)
17. same with the quoted name `"OHB"` → 200, the identical response (quotes change nothing)
18. same, unquoted, `sortSearch: BEST_MATCH` → 200, 5,563 records, 50 of 50 are OHB (*OHB* ×3, *OHB-System AG* ×47)
