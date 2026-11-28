# Board detection (detector v2)

Which job-board source reads a careers page: an ATS (Greenhouse, Personio, Teamtailor, ... 124 sources in the registry), a
single-employer reader, or, for a custom board with no ATS, one of the generic readers (`jsonld_direct`, `sitemap`,
`paginated_list`) with a proposed config. JOBCRAWLX row 2A.5.

Status: **behind a switch** (`--detector v2`); the default stays v1. On the frozen hold-out v2 does **not** beat v1 (see
[Benchmark](#benchmark)), so the acceptance line of row 2A.5 is not met yet.

## API

```js
import { detect, detectOffline, best } from '@egidinas/jobcrawl/core/detect';

// offline: nothing is fetched, no DNS
const { candidates } = detectOffline({ url, html, finalUrl, headers, cname });
// with a fetch: the careers page, then at most one follow (the board iframe, or the careers link when the page named no source)
const res = await detect({ url, allowFetch: true });            // or fetch: myFetch, lookupImpl: myDns (tests)
best(res.candidates);                                            // the first readable answer, or null
```

A candidate is `{ provider, slug, confidence, kind, evidence: [{ kind, value, url? }], platform?, config? }`, best first.

- `kind`: `ats`, `site` (single-employer reader), `aggregator`, or `generic` (custom board; carries `config`, an entry fragment
  for `companies.json` that the profiler's verify step can run).
- Ranking: a named source with a slug at or above confidence 0.4 outranks every generic proposal. Then confidence, then a known
  slug, then the order of `fingerprints.json`. A named source without a slug (an unsupported tenant UI, a platform with no reader)
  is listed but is not a readable answer (`best()` skips it).
- Every request of the fetch path goes through the egress guard (`core/fetch/guard.mjs`), a caller's own fetch included: private,
  loopback, link-local and metadata addresses are refused at every hop, the follow URL too.

## Fingerprints as data

`core/detect/fingerprints.json`, schema `jobcrawl-detect-fingerprints-v2`, one line per source. It covers all 124 registry providers
plus 16 platforms that have no reader yet (`provider: null`).

| field | meaning |
|---|---|
| `provider`, `platform` | registry id; display id when it differs |
| `kind` | `ats` \| `site` \| `generic` \| `aggregator` |
| `hosts` | regexes over a host: the vendor's own hosts |
| `url` | regexes over a full URL: board URLs, tenant custom domains. A match off the vendor's hosts counts only on a vendor host or on the page's own domain |
| `cname` | regexes over the CNAME target of the careers host |
| `html` | `script_src`, `iframe_src`, `link_href`, `meta_generator`, `jsonld`: regexes over that attribute or block (a capture group is the slug); `markup`: over the raw HTML |
| `headers` | `[{ name, pattern }]` over response headers |
| `api` | endpoint templates (`https://api.lever.co/v0/postings/{slug}`); an appearance anywhere in the page is a signal, `{slug}` is the slug |
| `slug` | rules, first hit wins: `{from:url, pattern, group}`, `{from:detect}` (the provider's own `detect()`, the code fallback), `{from:const, value}`, `{from:ref}`, `{from:origin\|host\|page}` (the employer's own host; never a vendor host) |
| `weights` | optional per-kind multipliers |
| `page_refs` | `false`: only the careers URL itself counts, never a link on a page |

Signal weights (top of the file): url / redirect 0.95, cname 0.90, iframe 0.85, script / form 0.80, api 0.75, meta generator / JSON-LD
0.70, header / markup 0.60, link 0.60, inline URL 0.50. Confidence is `1 - prod(1 - w)` over the distinct kinds seen. It is cut by
10 % when only links were seen, and raised when the evidence is a recognisable board URL that names a tenant. A `site` row counts
only on the page's own registrable domain: `bwi.de` linked from a news site is not BWI's board.

Seeded from every provider `detect()` regex, `crawler/profiler/fingerprints.json` (v1) and hand-written embed markers.

**Adding a source:** add one line to `fingerprints.json`, then add a fixture
`core/tests/fixtures/detect/<name>.html` whose first line is `<!-- expect: <provider> <slug> url=<page url> [cname=<target>] -->`.
The test suite checks every row (regexes compile, slug rules known, one row per provider) and every fixture.

## Content signals (custom boards)

`core/detect/content.mjs` reuses the profiler's pure parsers (`crawler/profiler/detect.mjs`).

| signal | proposal |
|---|---|
| two or more JSON-LD `JobPosting` on the page | `jsonld_direct` (slug = page) |
| repeated job-card links on the employer's host (+ pagination) | `paginated_list` with an html list config, and `jsonld_direct` with `job_url_pattern` (needs JSON-LD on a posting page) |
| a few job-like links in one job directory | `jsonld_direct` with `job_url_pattern` |
| the page is a sitemap with a job URL group | `sitemap` with `url_pattern` |
| an RSS/Atom job feed link | `paginated_list` rss config |

The profiler's hold rule applies: navigation, product or site-root link groups are held at low confidence. A strong ATS embed on the
same page scales the generic proposals down.

## CLI and MCP

```
jobcrawl detect <url> --detector v2 [--html <file>] [--page] [--json]
jobcrawl mcp --data <dir> [--allow-crawl] --detector v2       # detect_board (offline) and detect_page use v2
```

The MCP tool schemas are unchanged. Hits gain `confidence`, `kind` and, for generic proposals, `config`.

## Benchmark

`node scripts/eval-detect.mjs --split holdout --cache <evalcache dir> [--out report.json]`. Cached pages only: the script never
fetches. It prints per-class P/R/F1 for v1 and v2, the macro-F1, wins and losses, a paired bootstrap interval of the gap and the
confusion pairs.

**Data**
- Labels: `bench/detect/split-v1.jsonl`, frozen at commit `868ec2a` before any v2 code ran on it. It holds 3,629 careers URLs from
  `companies.json`, with EURES and the aggregators left out; a row's label is its provider, and the generic readers count as `custom`.
- Split: by company (union of normalised name and employer domain), 25 % hold-out by `sha1("jcx-detect-2a5-v1" + group) % 4`.
- Pages: the PROVIDERS eval-detect cache (732 careers pages on the employer's own host, fetched 2026-11-27 on the NUC, kept private).
  457 split rows have a usable page: 356 dev, 101 hold-out (56 ATS rows, 45 custom). Each row pins the page by `html_sha1`.

**Baseline (v1)** is what ships: `providers.resolve(url)`, then `atsFingerprints`, then the platform fingerprints, first hit wins
(`core/detect/v1.mjs`). Both detectors get the same inputs: URL, redirect target, HTML and the cached CNAME.

**Metric**
- Macro-F1 over the multi-tenant ATS classes seen in labels or predictions. Custom rows count as negatives.
- Single-employer readers are left out of the average, but a wrong prediction on them still counts.
- Secondary: custom as a class, with v1's empty answer counted as custom.
- The two top-1 rules differ. v1 answers with any hit, slugless ones included. v2 answers only with a readable candidate, one
  that has a slug. On dev this rule moved v2 from 0.646 to 0.687 (later fixes settled it at 0.667); v1 was unchanged.

**Results.** Evaluated commit `be8f7b7`. The hold-out was run once.

| set | rows | macro-F1 v1 | macro-F1 v2 | gap 95 % (bootstrap) | wins / losses | micro-F1 v1 / v2 |
|---|---|---|---|---|---|---|
| dev, page tier | 356 | 0.670 | 0.667 | [-0.053, +0.041] | 5 / 2 | 0.839 / 0.847 |
| **hold-out, page tier** | **101** | **0.694** | **0.624** | **[-0.178, +0.050]** | **1 / 1** | 0.865 / 0.854 |
| hold-out, page needed (URL alone gives nothing) | 97 | 0.676 | 0.603 | [-0.171, +0.044] | 1 / 1 | |
| hold-out, with custom as a class | 101 | 0.704 | 0.637 | [-0.165, +0.048] | | |
| URL tier, all rows (URL only) | 3,629 | parity | parity | 0 | 0 / 0 | |

URL tier: v2 from data alone gives the same provider and slug as `providers.resolve` on all 886 URLs that v1 answers (665 dev,
221 hold-out). That is the coverage check for the fingerprint rows.

**Reading the hold-out**
- Most classes have one row, so one row moves the macro-F1 by several points. The gap comes from two rows:
  - `avature -> radancy`: v1 was right, so avature drops from 1.0 to 0.
  - `personio -> jobylon` (v1 said teamtailor, also wrong): this adds a class with no support, 19 classes against 18.
- Over the classes with support, the macro-F1 is about 0.79 (v2) against 0.83 (v1).
- v2 wins `custom -> workday`, and teamtailor and workday precision rise to 1.0.
- The interval includes 0. This is no evidence that v2 is better, and weak evidence that it is worse.
- Hold-out confusions:
  - shared by both: `reachmee -> custom` (6; the careers URL is the homepage, no ReachMee mention without a follow), `rippling -> custom`,
    `custom -> rexx / radancy / recruitee / successfactors`;
  - v1 only: `personio -> teamtailor`, `custom -> workday`;
  - v2 only: `personio -> jobylon`, `avature -> radancy`.
- Slug accuracy of v2 where the provider is right: 0.94. Generic subtype (which generic reader) where v2 says custom: 5 of 9.

**Known defect (next fix):** a markup-only hit takes an origin slug from the page for free and can outrank evidence that carries a real
tenant slug. jobylon over teamtailor on dev (taxistockholm, greencargo) showed it before the hold-out run, and the hold-out's
jobylon and radancy errors look like the same pattern. Fix it in a separate commit, validate on dev, and label any later hold-out run
post-hoc.

**Limits of this benchmark**
- It sees one page per company and no response headers. It cannot measure the follow, header fingerprints or sitemap detection
  (a sitemap is never the cached page).
- Labels are the current config. When a generic reader stands in for a real ATS, that row counts as a false positive for any
  detector that names the ATS. The CNAME `generali.prospective.ch` and Recruitee custom domains are examples, and most
  `custom -> X` confusions on dev are of this kind.
- A clean acceptance needs fresh cached pages (two pages per company, so the follow counts) and a larger hold-out.
- The profiler's raw capture (`~/atlas/profiler/pages`, about 2,500 careers pages) was not used for scoring. Its labels come from
  v1's own cascade, so it is biased towards v1.
