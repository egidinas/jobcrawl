# Changelog

jobcrawl has no numbered releases; `main` is always the running version. This file groups the history by period, newest first.
The commit log has the details of each change.

## 2026-11-28: MCP server (row 2A.4, branch feat/mcp-2a4)

- **`jobcrawl mcp --data <dir> [--store] [--allow-crawl]`** (`core/mcp/`, docs/MCP.md): a read-only MCP server over stdio, no dependency.
  Revision 2026-07-28 plus the legacy `initialize` handshake. Tools: `detect_board` (offline), `get_delta`, `search_postings` (in-memory
  FTS5), `explain_board_health`. Output is cleaned of invisible characters, marked `untrusted`, capped, and built from the field
  allowlist. `--allow-crawl` adds `detect_page` behind the egress guard (private targets refused) and unsupported stubs.

## 2026-11-28: resolver job (row 1.4, branch feat/resolver-1-4; default off)

- **Resolver** (`core/resolve/`): the cross-board logic of the legacy cycle (crosslist dups and the direct-over-aggregator swap, admission
  with its 48 h hold, the protected employer set, the 3-day sweep and `unknown`) as one consumer of the SQLite store's event log. It keeps a
  member per (board, posting id) and a group per posting id, and writes the **resolved/v1** stream (`schemas/resolved-v1.schema.json`,
  its own `seq`). Legacy modules are imported unchanged (`crawler/crosslist.mjs`, `relevance.mjs`); admission is checked against
  `crawler/admission.mjs` by a differential test.
- **Lease + checkpoints**: one lease row (board `*`, token-fenced); per batch one `BEGIN IMMEDIATE` commit of members, groups, resolved
  records, derived set and bookmark (compare-and-swap), so a crash resumes with no double records. Records are applied by global
  `event_id` only (seq-null `refreshed` records included). A store with imported boards starts from a silent baseline epoch.
- **CLI**: `jobcrawl resolve --data <dir> [--store sqlite] [--profile <dir> | --companies <file>] [--legacy-data <dir>] [--rules legacy|lifecycle]`,
  `jobcrawl resolved` (stream, `--groups`, `--derived`), `jobcrawl run --resolve` (opt-in). JSON stores are refused (exit 2).
- **Replay acceptance**: `scripts/resolver-replay.mjs` replays a copy of the legacy history through the per-board path and compares dup,
  admission and protected-set verdicts with the legacy files.
- `SqliteStore.withTransaction / readTransaction` (additive seam).

## 2026-11-28: SQLite state store (row 1.1, branch feat/store-sqlite-1-1; JSON stays the default)

- **SQLite backend** (`core/state/sqlite-store.mjs`, one `<data>/store.sqlite`): WAL, `busy_timeout` set first, `synchronous=FULL`, every
  write one `BEGIN IMMEDIATE` transaction. A run (state, postings, events, new ids) commits atomically; a writer whose base seq moved gets
  a StateError and writes nothing. Backend errors surface as StateError (exit 4), never as a board failure.
- **Global `event_id`** over all boards (commit order) beside the per-board `seq`; `events({ after, limit })`, named consumer bookmarks
  (`bookmarkGet/Set`, `jobcrawl bookmark`), `feed --store sqlite --after <id> | --consumer <name> [--commit]`. Snapshot changes that have no
  delta event (URL variant, description hash filled in, baseline row refreshed) are logged as `refreshed` records (event_id, seq null), so a
  snapshot plus the records after its `event_id` equals the later snapshot (last_seen excluded).
- **Ids as stored facts** (`ids` + `id_alias`): assigned at first sight, kept across a change of the key rule.
- **Shared host slots, cooldowns and a time-window breaker** in the store (API only; the live crawl's policy is not wired to them).
- **One interface, two backends** (`core/state/store.mjs`); `jobcrawl run|snapshot|feed --store json|sqlite` (default json; `JOBCRAWL_STORE`).
  A folder holds one backend; `jobcrawl store-import` moves the JSON states into SQLite with 0 events. node:sqlite's ExperimentalWarning is
  filtered (that warning only).

## 2026-11-28: multitool phase 1 (branch feat/jobcrawlx-phase1; everything off by default)

- **Shadow hook in the crawl** (`core/route/shadow-hook.mjs`, 6 lines in `crawler/crawl.mjs`): with `JOBCRAWL_SHADOW=1` and a routing file
  in `JOBCRAWL_ROUTING`, the cycle's own answers of the boards routed `shadow` are applied to the new per-board path in
  `<data>/jcx-shadow` (or `JOBCRAWL_SHADOW_DATA`): state and deltas, no extra request, nothing published. The kill switch wins; without the
  arm switch the module is not even loaded. A test runs the crawl with and without it: the legacy history is identical.
- **Baseline import** (`jobcrawl import`, `core/route/baseline.mjs`): the legacy history becomes the new path's starting state as an epoch
  without events, so the first shadow read emits only real changes.
- **Recording replay + parity**: `jobcrawl dual-run --replay <recording> --companies <file>` names the boards that failed in the recording.
- **Conditional requests** (`core/fetch/conditional.mjs`): off unless `crawl.conditional_cache.hosts` lists hosts; a 304 is turned back
  into the cached 200 body, so sources parse the same bytes.
- **`bench/analyse.mjs`**: wire bytes, true 304 rate per provider and host, change rates from the live index, projected list bytes per day
  and the hosts to switch on.

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

## 2026-11-28: Higher CandidatePortal (uhigher.com)

- **`candidateportal`** (Angular app "CandidatePortal", `<tenant>.uhigher.com`, route `/<lang>/jobs`): the page holds no data; the app reads
  `api.uhigher.com/api/v1` without a key. `companies/context/company_landing_page/<tenant>` gives the company id, then
  `jobs_and_alternative_jobs?company=<id>&publishOnHigher=1&status=active&limit=100&page=N` answers title, place, category, full text and
  application deadline (no posting date). A closed tenant answers 403 "Company is not active" and reads as an empty board. Live: SOVA 14.

## 2026-11-28: ApplicantPro, WeRecruit, hrlab repaired

- **`applicantpro`** (isolved Talent Acquisition, `<tenant>.applicantpro.com`): board = the tenant; the jobs page gives the domain id, and
  `/core/jobs/<domainId>?getParams={}` answers every vacancy as JSON (place, department, posting date). Descriptions come from the posting
  page JSON-LD through the detail fallback. Live: X-Bow Systems 55 jobs in 2 requests.
- **`werecruit`** (`careers.werecruit.io/<lang>/<tenant>`, France): offer cards (title, place) on the page behind the tenant short-id link;
  spontaneous applications dropped; no dates. Live: Unseenlabs 4 offers.
- **`hrlab`**: rewritten for the current card layout. The old reader split the card text on " - " (cutting titles) and defaulted every
  place to Garching. Now: title from the h3; place, date ("Online since") and text from the posting page (60 postings a cycle at most). The
  JSON-LD is not read (invalid JSON, different title). Live: HOLM 3 postings in Frankfurt, Swagelok B.E.S.T. 3 in Garching.

## 2026-11-27: Taleo Business Edition, Jobylon, places for SuccessFactors classic

- **`taleobe`** (Oracle Taleo Business Edition, `*.tbe.taleo.net`): slug = the careers search URL with `org` and `cws`; pages of 10 in the
  session the first answer sets. Detected from careers and requisition links.
- **`jobylon`**: a preset of `jsonld_direct` for employer careers pages that list `emp.jobylon.com/jobs/<id>-...` postings (as links or in
  the page's inline JSON); each posting page carries JobPosting JSON-LD. No Jobylon API or feed is read. Generic readers take links from
  inline JSON state only with `json_links: true` (the preset sets it).
- **`successfactors_classic`**: places from each posting page's microdata, read once per posting into the page cache within the board's
  page budget (`detail_places: false` turns it off); German dotted dates; the first filter value as department.
- **`workday`**: opt-in `workday_session: true` reads the board page once and sends its cookies, origin and referer with the search calls
  (a tenant that answers 429 to bare API calls).
- **rexx**: posting links with a session id (`.html?sid=...`) and div-based table rows; the session id is dropped from the URL.
- Named Latin letter entities (`&eacute;` ...) are decoded by the extra providers.

## 2026-11-27: SuccessFactors classic career sites (opt-in)

- **`successfactors_classic`** (`crawler/providers-sfclassic.mjs`): the classic career site `career<N>.successfactors.eu|com/career?company=<ID>`,
  read the way the anonymous search page reads it (session cookie and CSRF key from the page, then its DWR search calls, 50 per page).
  Opt-in: `detect()` never claims a URL; an entry sets the provider and slug = the career URL or `<host>|<company>`. Never logs in: a
  login page or a non-DWR answer fails the board. Approach from career-ops (MIT), written afresh.
- Detector v2 names it (`fingerprints.json` row `successfactors-classic`, slug = the link) instead of reading the career host as an RMK
  site.

## 2026-11-27: junk gate for probation boards

- **`crawler/junkgate.mjs`**: a not-yet-promoted probation board read by a generic reader (paginated_list, jsonld_direct, sitemap) whose
  list does not look like a job list (titles mostly not job-like, or navigation/product link text) is recorded in `probation-state.json`
  (`junk`) and in the cycle notes. Profile setting `crawl.junk_gate`: `report` (default, nothing else changes), `hold` (a relevant title
  no longer promotes such a board) or `off`. Calibrated on the 14 junk boards of the PROVIDERS review (13 held) and 3 good link-group
  boards (0 held).

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
