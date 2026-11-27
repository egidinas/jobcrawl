# Changelog

jobcrawl has no numbered releases; `main` is always the running version. This file groups the history by period, newest first.
The commit log has the details of each change.

## 2026-11-27: multitool phase 0 (branch feat/jobcrawlx-phase0; additive, the crawl is unchanged)

- `package.json` as `@egidinas/jobcrawl` (private until the first release), `cli/jobcrawl.mjs` (`providers`, `detect`, `route`,
  `crawl`, `dual-run`, `snapshot`, `feed`, `doctor`; `--json`; help exits before any network use).
- `core/`: stable posting ids (`id.mjs`), per-board state and deltas with the departure grace rule (`delta/board-delta.mjs`), a files
  store with leases, crash repair and snapshots (`state/board-store.mjs`), the strangler-fig routing façade with a kill switch
  (`route/router.mjs`), parity reports and the migration ledger (`route/parity.mjs`, `route/ledger.mjs`), an SSRF guard for
  user-given URLs (`fetch/ssrf.mjs`).
- `schemas/`: posting/v1, delta/v1, snapshot/v1, board-state/v1, routing/v1, parity/v1.
- `bench/record.mjs`: the benchmark recording run (responses with ETag/Last-Modified, one conditional probe per board, parsed lists for
  replay); `core/tests/`.

## 2026-11-27: board detection v2 and the PROVIDERS review fixes

- **Detector v2** (`crawler/profiler/platforms.mjs` over `crawler/profiler/fingerprints.json`): page/redirect host, CNAME, embeds, links and
  markup scored per platform; makes the slug for boards on the employer's own host; in the profiler cascade and in `jobcrawl detect --page`
  (`crawler/profiler/detect-page.mjs`, through the SSRF guard). `crawler/profiler/eval-detect.mjs` scores it on the companies file.
- **SSRF guard on every hop** of the profiler (`profiler/net.mjs`) and of `eval-detect --fetch`, not only of `detect --page`.
- **Profiler hold rule for link-group boards**: no job-like URL token, titles mostly not job-like, or the list on the site root ->
  reason `link_group_held` (stays on the watchlist, never spliced).
- **rexx**: a row whose first job link is an image link takes its next link with text.
- **`crawl.http_cache`** (off by default): conditional GET (ETag / Last-Modified) under the policy guard, bytes kept as received.

## 2026-11-27: rexx on employer domains, discover notes

- **`rexx`**: the slug may be the host of a rexx portal on the employer's own domain (`karriere.n3eos.com`, `career.schiebel.net`), not only the
  `<tenant>-portal.rexx-systems.com` label. Rows are read by the job-link shape (`-<lang>-j<id>.html`) inside the listing, so the table and
  `joboffer_container` themes work beside the article cards; posting dates come from the portal's Atom feed when the listing links one.
- **`discover.mjs --sites`**: a careers page that links a board we already track now says so instead of "uses <ATS> - not supported yet", and
  systems with a provider that needs a hand-set slug (Phenom, rexx, Avature, Radancy, d.vinci, Breezy, iCIMS, SuccessFactors) say which
  provider and slug to use. The stale list had made the 2026-11-27 seed run file supported companies as "no provider yet".

## 2026-11-22: geography pills and pins

- **`web/assets/atlas-geo-pills.js`** (loaded by `atlas.js` beside the place data): country pills zoomed out, city pills zoomed in (only roles with a real
  place, each to its nearest city of its own country), company pins for verified exact sites only (`side/company-pins.json`) at street level; counts follow
  the field chips. A region header (worldwide, Europe, one country, Bavaria) and a list beside the map (a bottom sheet on a phone) whose rows add up to the
  header. "Hiring now" shows or hides the pinned companies without open roles; the status words come from `side/company-status.json`. The view, the chips,
  the toggles and an open card live in the address (`#v=lat,lon,deg&f=..&hn=0&pin=slug`).
- On when `config.json` has `geo_pills: true` or on the internal (preview) build; `?pills=1` / `?pills=0` decide one visit. Off, or a module that does not
  load, keeps the classic labels. While on, the canvas leaves out its own area names, clusters and company dots.

## 2026-11-12: aggregator follow-ups

- **`aggregator: true`** on a registry entry makes a board on a generic provider (sitemap, paginated_list, jsonld_direct) an aggregator
  (`isAggregatorEntry` in crosslist.mjs): its rows are aggregator rows, the cross-listing step applies, the direct row stays.
- **`employer_from_jsonld: true`** (sitemap provider): the employer comes from the posting's JSON-LD `hiringOrganization`, written
  `<employer> (via <board>)`.
- **Startup sweep**: every open aggregator copy is checked against all open direct rows (posting key and description fingerprint) when the
  crawl starts, so a match no longer waits for a new direct row to arrive (indexed by key and title token, linear in the aggregator rows).

## 2026-11-11: descriptions that the list call does not carry

- **Detail backfill keeps the text it fetches**: for an open role whose saved description is missing or thin (under 1,200 characters)
  the text of the detail page is written to the description store (`jdAfterFetch`: a missing file is written, a thin one replaced with
  its header kept when the page gives at least 200 characters more, a normal one left alone). It used to be read for the posting's
  facts only and thrown away. Open roles fetched before this change are queued once more; `--retry-failed` lifts the wait after a
  failed fetch (use it with `--vendors` after a provider learned a description call).
- **Description calls** (`fetchDescription`) for Oracle Recruiting Cloud (the `recruitingCEJobRequisitionDetails` call: description,
  responsibilities, qualifications) and UKG Pro / UltiPro (the `CandidateOpportunityDetail` script object of the detail page). Both
  have no text in the list call and a detail page the generic reader cannot read; the crawl's lazy description path and the backfill
  use the calls.
- `crawler/jdclean.mjs`: helpers for the description file layout (`jdDocument`, `jdBody`, `jdHeader`, `clipDescription`) and
  `stripContactSection`: the "Application and contact" section of an EURES detail document and `Contact:` lines are recruiting
  contacts and are cut before the backfill saves a fetched text.
- Tests: `crawler/tests/detail-description.test.mjs`, additions to `crawler/tests/detail-backfill.test.mjs`.

## 2026-11-07: crawl policy (robots.txt advisory), generous page budgets

- **Crawl policy in one place** (`crawler/policy.mjs`, owner's decision: "keep ambitious with probing and be generous with pages, small
  print in robots.txt aside"). robots.txt is **advisory by default** (`crawl.robots: advisory|strict`, per-host `crawl.robots_hosts`):
  a disallowed request to a career site, an ATS job board or a posting page is made and logged (`robots-audit.jsonl`, a count per host
  in the notes); strict refuses it. It used to be enforced by the `sitemap` and `jsonld_direct` providers, the profiler and the RMK
  probe only; the policy now reads robots.txt for every request of the crawl, the backfill, the harvest and the profiler.
- **Hard limits, enforced by the same guard and tested**: no login, sign-in or authentication page is ever requested, a redirect into
  one stops before it, a 401/407 URL is never asked again (`auth-walls.json`); deeplist.tech's `/api` and login are never requested;
  explicit opt-outs (`crawl.opt_out_hosts`, the TDMRep `tdm-reservation: 1` header, flagged in `optout-flags.json`) are not crawled;
  HTTP 429/503 put the host on a cooldown that honours Retry-After (the providers' retry never comes earlier; more than 20 s fails the
  board for the cycle); Crawl-delay is a floor in both modes. Concurrency per host is unchanged. Hosts whose robots.txt says
  `Content-Signal: ai-train=no` are recorded (`content-signals.json`) so model training can leave their postings out.
- **Generous with pages**: pagination is followed to the end (fixed caps of 10 to 150 pages replaced by "stop at an empty page, a page
  without new postings or the total", safety stop 500, `max_pages` per board); a sitemap index is read in full (was 10 children);
  defaults `sitemap` max_jobs 10000 (was 3000), `jsonld_direct` 1000 (was 300), Radancy 10000; the profiler writes entries with higher
  caps. `sitemap` and `jsonld_direct` have a page budget (default `timeout_ms` minus 10 s) and keep what they read, and the crawl makes
  an incomplete fill due again next cycle instead of letting it time out and lose its work. Paging providers in `providers-extra.mjs`
  page for the board's own `timeout_ms` instead of a fixed 28 s.
- **EURES slow lane** (`crawler/eures-lane.mjs`, `crawl.eures_lane`): europa.eu asks for Crawl-delay 10 s, so EURES boards are read
  outside the cycle, one at a time at that gap, and the crawl reads the lane's answers.
- A partial answer (page or time budget ended the walk) marks nothing gone; due boards are spread by provider over the cycle.
- **Detail backfill**: `--minutes` (time limit) and `--host-fail-limit` (a host whose last 5 requests failed is left for the next run).
- The crawl's notes name the board fetch time (total, slowest boards), the boards still filling, and the policy's counts.
- Tests: `crawler/tests/policy.test.mjs` (advisory vs strict and overrides, Crawl-delay, 429 and Retry-After, the no-login rule,
  opt-outs, page budgets, pagination past the old caps, the backfill limits); the jsonld_direct and RMK tests cover both robots modes.

## 2026-11-07: audit follow-up, documentation

- **Location filter, reported per board.** Each cycle's notes name the boards whose title-passing roles were dropped for their location,
  largest first, on top of the reason counts; covered by a crawl test against a local server (country-code tokens, US ZIP codes, word
  fragments, `any_location`, a history row for every drop).
- **JOIN.** A company page that reports postings (page count or facet counts) but lists none is a failure, not "0 jobs"; tests for both
  page shapes, pagination, empty boards and the failure cases.
- **SAP SuccessFactors RMK tenants** are enumerated: `cc-harvest` lists tenant ids from the Common Crawl index, and `crawler/rmk.mjs`
  follows each to its RMK site and counts the job pages of its sitemap (robots rules applied); new boards become `sitemap` entries.
- Four providers (`join`, `concludis`, `factorial`, `oraclecloud`) were defined twice in `providers.mjs`; the dead first copies are
  removed and a test keeps every provider id unique.
- README rewritten (architecture, responsible crawling, data model, testing, contributing); the provider table is generated from the
  code (`scripts/provider_table.mjs`) and checked by a test. `docs/ARCHITECTURE.md` documents the crawler's state files and statuses;
  `profiles/schema.md` the new entry keys.
- Privacy: test fixtures carry synthetic contact data only; no machine-specific default paths.
- ReachMee provider (Nordic ATS); probation keeps an entry whose board names another employer (`employer_mismatch`) and names it in every
  cycle's notes; the Atlas timeline shows Berlin time.

## 2026-11-06: crawler audit fixes and new sources

- **No silent drops.** Every role a filter drops is kept as a `filtered` history row with its reason counted in the notes;
  `location_filter.allow_country_codes` passes "<City>, DE" without the town on the allow list; `any_location` keeps an in-scope
  employer's roles anywhere.
- **JOIN** reads the new `pageData` page shape and paginates.
- New providers: BITE (jobs-api v5), the research portals of Max Planck, DESY and HZDR, and two config-driven readers for sites
  without an ATS, `paginated_list` and `jsonld_direct`. The sitemap provider reads gzipped sitemaps and filters by organisation.
- `cc-harvest` enumerates the German mid-market ATSs (d.vinci, umantis, rexx, onlyfy, BITE).
- **Career-site profiler** (`crawler/profiler.mjs`): finds how to read a site without a known ATS (JSON-LD, sitemap, RSS, repeated link
  groups, the page's XHR, a local model), honours robots.txt and Crawl-delay, verifies with the provider's own fetch, and splices
  entries on probation; the crawl flags boards whose yield drops for re-profiling.
- Crawl: per-board fetch budget `timeout_ms`, `--force-due`, a progress line per 50 boards, a per-provider health line.
- Geography: roles pinned at their employer's site.

## 2026-11-01 to 2026-11-03: first-party data and aggregators

- **Raw capture** (`JOBCRAWL_RAW_DIR`): every feed response byte for byte, content-addressed, with a daily index.
- **Detail backfill**: the detail of every tracked posting, in or out of scope, into the raw store; resumable, one run per data folder.
- **EURES** provider on the portal's search backend (unofficial; ELA attribution), with employer mode, one request per second across
  all processes, backoff on HTTP 429, and the employer detail sweep for the official NACE class.
- **USAJOBS** provider (US federal announcements, API key from the environment).
- Teamtailor on its JSON feed merged with RSS, Rippling on its board API, softgarden on its Frontend API where a public client id
  exists, Radancy sites fail loudly and read JSON-LD.
- `collect_only` boards (kept as `extra`, never published); aggregator-employer review lists; recruiting contacts kept with a posting
  where it publishes them; history pruning only when a profile asks for it; sitemap page budget and concurrency per entry.

## 2026-10-26 to 2026-10-31: the Atlas, history and geography

- `jobcrawl traces`: a permanent trace of every role, weekly trends and the Atlas timeline; descriptions dropped 90 days after a role
  was last seen, old rows archived, not deleted.
- Atlas: role and company maps linked, a time scrubber, hot and cold spots, image export, a page per view.
- Geography: a role-sized cartogram, then one zoomable map (Web Mercator levels of detail, rivers, islands), company dots by type.
- Job functions, domains and levels as a stable two-level nomenclature; companies classified on the same axes (type, domain, stage,
  hiring); the company graph and re-embedding upstreamed from the reference site.
- Match me: CV scoring with orthogonal rating reasons.

## 2026-10-24 to 2026-10-25: first public version

- The profile-driven Node crawler, the Python pipeline (profile, text, geo, classification, board), embedding, index and map, the web
  app (list, Match me, Atlas) and `serve.py`, demo data (1,051 roles in Bavaria), docs and CI (Node 22, Python 3.9 and 3.12).
- The crawler refuses to start on a nearly full disk (`crawl.min_free_mb`); the keyword index streams the description shards.
