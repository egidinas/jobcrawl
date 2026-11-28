#!/usr/bin/env node
// Job crawler: polls the public ATS feeds of the companies in the profile's companies file, applies the broad title/location
// filter, dedups and tracks liveness in <data>/scan-history.tsv, and (with --jd) saves the full job description of every tracked
// role to <data>/jd/. New postings of a run go to <data>/last-new.json. Reads public job feeds only; nothing in here knows about
// any candidate. Run `node crawler/crawl.mjs --help` for the options.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, appendFileSync, statSync } from 'node:fs';
import { loadLabels, saveLabels, merge as mergeLabel } from './board-labels.mjs';
import { createHash } from 'node:crypto';
import { resolve as pathResolve } from 'node:path';
import { providers, resolve, setCacheDir, pageDescription } from './providers.mjs';
import { fingerprintText } from './fingerprint.mjs';
import { isCrossListing, sameEmployer, canonCompany, canonTitle, isAggregatorRow, isAggregatorEntry, rowPostingKeys, setApplyKeys } from './crosslist.mjs';
import { isRelevantRole, makeEmployerIndex, protectedFromHistory, loadCatalogueNames, strictVerdict, probationCycle, newProbation,
  useRelevance, INDUSTRY_AGGREGATOR_PROVIDERS, INDUSTRY_VIA, PROBATION_VERDICT } from './relevance.mjs';
import { loadProfile, profileDirFromArgs, resolveDataDir, applyProfileFilters, entryTimeoutMs } from './profile.mjs';
import { setUserAgent } from './useragent.mjs';
import { junkVerdict } from './junkgate.mjs';
import { reprofileCycle } from './profiler/health.mjs';
import { checkDisk } from './diskguard.mjs';
import { cleanJd, jdFileName } from './jdclean.mjs';
import { writeHistoryFile } from './history-write.mjs';
import { readHistoryFile } from './history-read.mjs';
import { installRawCapture, rawCaptureSummary } from './rawcapture.mjs';
import { setEuresRateFile, setEuresLane } from './providers-eures.mjs';
import { classifyError, makeBreaker, hostOf, breakerHostOf, livenessGuard, isCappedAnswer } from './resilience.mjs';
import { openLifecycle } from './lifecycle.mjs';
import { configurePolicy, policyFromProfile, installGuard, policySummary, flushPolicy, policySettled, interleaveByProvider } from './policy.mjs';
import { openAdmissions, degraded, oneLine } from './admission.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);

const USAGE = `usage: node crawler/crawl.mjs --profile <dir> [options]

Polls the public job feeds of the profile's companies file (<dir>/profile.json, crawl.companies_file), keeps the roles that pass the
title and location filters, and writes the history, descriptions and the list of new roles to the data folder.

options:
  --profile <dir>     profile folder (or set JOBCRAWL_PROFILE); required
  --data <dir>        data folder (default: the profile's data_dir, else ./data)
  --config <file>     companies file to use instead of the profile's
  --overlay <file>    extra employers {tracked_companies:[...]} appended to the companies file (env JOBCRAWL_COMPANIES_OVERLAY)
  --company <text>    only companies whose name contains <text>
  --all               ignore the title and location filters (see everything)
  --jd                also save the job description of every tracked role
  --refresh-only      update known roles only, never add new ones
  --force-due         fetch every enabled board now, ignoring interval_hours (a full refresh; one progress line per 50 boards)
  --dry-run           print the summary, write nothing
  --triage-out <file> also write one JSON line per board outcome (triage class, code, host, jobs; ms = first attempt, budget_ms) to this file, even with --dry-run
  --jd-cleanup-only   no crawl: remove the descriptions of roles not seen for more than jd_keep_days days, then exit
                      (with --dry-run it only counts them)
  --help              show this text
(profile key crawl.min_free_mb: refuse to start when the data disk has less free space than this many MB; 0 = no check)
(profile key crawl.jd_keep_days: a role's description is removed once the role has not been seen for more than this many days
 (its history row is not 'open'); default 90; 0 = keep forever)
(profile key crawl.history_prune_days: gone/filtered rows not seen for more than this many days leave scan-history.tsv and move to
 scan-history-archive.tsv; default 0 = never prune, every row stays in the working history)
(companies-file key collect_only on an entry: the board is collected but never published; its roles are kept as status 'extra',
 never 'open' or NEW, even when the title passes; other keys of an entry are listed in profiles/schema.md)
(companies-file key title_release {enabled, employers_file, max_per_cycle, max_per_board_per_cycle, window {tz, from, to}}: at the listed boards a role that
 fails only the title rules is kept 'open' instead of 'extra', within the caps; --no-title-release or JOBCRAWL_TITLE_RELEASE=0 turns it off)`;

if (flag('help')) { console.log(USAGE); process.exit(0); }

let PROFILE;
try { PROFILE = loadProfile(profileDirFromArgs(args)); } catch (e) { console.error(`crawl: ${e.message}`); process.exit(2); }
if (!PROFILE) { console.error('crawl: no profile. Pass --profile <dir> (or set JOBCRAWL_PROFILE). See crawl.mjs --help.'); process.exit(2); }
useRelevance(PROFILE.relevance);
setUserAgent(PROFILE.userAgent);

const CONFIG = pathResolve(opt('config') ?? PROFILE.companiesFile);   // --config <file>: a trimmed copy for tests
if (!existsSync(CONFIG)) { console.error(`crawl: companies file not found: ${CONFIG} (profile key crawl.companies_file)`); process.exit(2); }
const CATALOGUE = PROFILE.catalogueFile;   // optional (profile key crawl.catalogue_file): names that count as protected employers
const PROB_FILE_NAME = 'probation-state.json';
const OUT_DIR = resolveDataDir(opt('data'), PROFILE);
setCacheDir(OUT_DIR);
// EURES: one request start per gap across this crawl and any other process on the same data dir (eures-employer-detail.mjs)
setEuresRateFile(pathResolve(OUT_DIR, 'eures-rate.json'));
// crawl.eures_lane: the EURES boards are read by crawler/eures-lane.mjs at europa.eu's Crawl-delay; the crawl reads its answers
if (PROFILE.euresLane) setEuresLane(pathResolve(OUT_DIR, 'eures-lane'));
// every feed response byte for byte under JOBCRAWL_RAW_DIR (rawcapture.mjs), before the first request
const RAW_ON = !flag('jd-cleanup-only') && installRawCapture();
let SHADOW_INPUT = null;   // compact shadow input (captureShadowInput), set by scan() only when JOBCRAWL_SHADOW is set; see the end of this file
if (RAW_ON) console.log(`crawl: raw capture on, ${process.env.JOBCRAWL_RAW_DIR}`);
// The crawl policy (policy.mjs) around every request: robots.txt advisory or strict (crawl.robots), Crawl-delay floor, 429/503
// cooldowns, never a login page or an opted-out host. Installed after the raw capture, so a refused request is never captured.
configurePolicy(policyFromProfile(PROFILE, OUT_DIR));
if (!flag('jd-cleanup-only')) { installGuard(); console.log(`crawl: policy robots=${PROFILE.robots}${Object.keys(PROFILE.robotsHosts).length ? ` (${Object.keys(PROFILE.robotsHosts).length} host overrides)` : ''}, ${PROFILE.optOutHosts.length} opted-out hosts`); }
// Conditional-request cache (core/fetch/conditional.mjs): off unless the profile lists hosts in crawl.conditional_cache.hosts.
const CONDITIONAL = PROFILE.raw?.crawl?.conditional_cache;
if (!flag('jd-cleanup-only') && !flag('dry-run') && Array.isArray(CONDITIONAL?.hosts) && CONDITIONAL.hosts.length) {
  try {
    const { installConditionalCache } = await import('../core/fetch/conditional.mjs');
    const { checkPlacement, defaultDir } = await import('../core/paths.mjs');
    // outside the data folder and outside any git work tree (a data folder is swept into commits on some hosts)
    const dir = checkPlacement(CONDITIONAL.dir ? pathResolve(PROFILE.dir, CONDITIONAL.dir) : defaultDir('http-cache', OUT_DIR), OUT_DIR, 'HTTP cache');
    installConditionalCache({ dir, hosts: CONDITIONAL.hosts, maxMb: Number(CONDITIONAL.max_mb) || 20, totalMb: Number(CONDITIONAL.total_mb) || 500 });
    console.log(`crawl: conditional requests on for ${CONDITIONAL.hosts.length} host pattern(s), cache ${dir}`);
  } catch (e) { console.error(`crawl: conditional requests OFF (${e.message})`); }
}
if (!flag('dry-run') && !flag('jd-cleanup-only')) {   // the cleanup frees space, so it runs even on a full disk
  const full = checkDisk(OUT_DIR, PROFILE.minFreeMb);
  if (full) { console.error(`crawl: ${full}`); process.exit(3); }
}
const HISTORY = pathResolve(OUT_DIR, 'scan-history.tsv');
const STATE_FILE = pathResolve(OUT_DIR, 'crawl-state.json');
const NEW_FILE = pathResolve(OUT_DIR, 'last-new.json');
const JD_DIR = pathResolve(OUT_DIR, 'jd');
const CONCURRENCY = 8;

const norm = (s) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const today = () => new Date().toISOString().slice(0, 10);

// ---------- compiled filters (high-performance rule engine) ----------
// Pre-compile keyword list into normalized substrings and a unified RegExp for whole words
function compileMatcher(list = []) {
  if (!list || !list.length) return () => false;
  const exactWords = [];
  const substrings = [];
  for (const k of list) {
    if (k.startsWith('word:')) {
      exactWords.push(norm(k.slice(5)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    } else {
      substrings.push(norm(k));
    }
  }
  const wordRegex = exactWords.length ? new RegExp(`\\b(?:${exactWords.join('|')})\\b`, 'i') : null;
  return (normText) => {
    if (!normText) return false;
    if (wordRegex && wordRegex.test(normText)) return true;
    for (let i = 0; i < substrings.length; i++) {
      if (normText.includes(substrings[i])) return true;
    }
    return false;
  };
}

function prepareFilters(cfg) {
  const tf = cfg.title_filter ?? {};
  const lf = cfg.location_filter ?? {};

  const negativeTitleMatcher = compileMatcher(tf.negative);
  const positiveTitleMatcher = compileMatcher(tf.positive);
  const seniorityMatcher = compileMatcher(tf.seniority_boost);
  const blockHardLocMatcher = compileMatcher(lf.block_hard);
  const allowLocMatcher = compileMatcher(lf.allow);
  // location_filter.allow_country_codes (e.g. ["DE", "AT", "CH"]): a location text that names one of these ISO codes as its own token
  // ("Ulm, DE, 89077", "Graz (AT)") passes without the city being on the allow list. Audit 2026-11-06: the allow list alone silently
  // dropped 4,229 of 24,325 fetched roles (HENSOLDT 440 of 478: Ulm, Fürstenfeldbruck, Oberkochen ...), because SuccessFactors and
  // Workday write "<City>, DE, <PLZ>" with no country word. (A postcode clause was tried and dropped the same day: any 5-digit
  // number would have passed US ZIP codes; SuccessFactors always writes the country code, so the token rule suffices.)
  const codes = (lf.allow_country_codes ?? []).map((c) => norm(c)).filter((c) => /^[a-z]{2,3}$/.test(c));
  const countryCodeRegex = codes.length ? new RegExp(`(?:^|[^a-z])(?:${codes.join('|')})(?=$|[^a-z])`) : null;
  const allowCountryCode = (normLocation) => Boolean(countryCodeRegex && countryCodeRegex.test(normLocation));

  const companyMap = new Map();
  for (const c of cfg.tracked_companies ?? []) {
    const extraPositive = c.extra_positive?.length ? compileMatcher(c.extra_positive) : null;
    const locOnly = c.location_only?.length ? compileMatcher(c.location_only) : null;
    const locAllow = c.location_allow?.length ? compileMatcher(c.location_allow) : null;
    // any_location (owner 2026-11-06, "scope by content, not country"): for an in-scope employer a role that passes the title filter is kept
    // wherever it is; the allow list stays a region feature for the board, and block_hard and location_only still apply.
    companyMap.set(c.name, { extraPositive, locOnly, locAllow, anyLoc: c.any_location === true });
  }

  return {
    negativeTitleMatcher,
    positiveTitleMatcher,
    hasPositiveList: (tf.positive ?? []).length > 0,
    seniorityMatcher,
    blockHardLocMatcher,
    allowLocMatcher,
    allowCountryCode,
    allowUnknownLoc: lf.allow_unknown !== false,
    companyMap,
  };
}

function titleVerdictCompiled(filters, normTitle, company) {
  if (filters.negativeTitleMatcher(normTitle)) return 'negative-title';
  const c = filters.companyMap.get(company);
  // No positive keywords configured anywhere (global list empty and no company extras) means "accept every title", as before.
  if (!filters.hasPositiveList && !c?.extraPositive) return null;
  const hasPositive = filters.positiveTitleMatcher(normTitle) || (c?.extraPositive && c.extraPositive(normTitle));
  if (!hasPositive) return 'no-positive-title';
  return null;
}

// Title-rule release (coordinator 2026-11-21, owner "Agree with your recommendation"): at the boards of employers that are clearly in scope
// (companies-file key "title_release": { enabled, employers_file, max_per_cycle, max_per_board_per_cycle }; the list is written by the
// site's tools/title_release_employers.py), a role that fails ONLY the title rules is kept as a normal 'open' posting instead of 'extra',
// so the board's own per-posting cut and relevance flag decide whether it is shown. Location, probation, relevance, collect-only and
// aggregator verdicts are unchanged. A newly released role counts against the per-cycle and per-board caps (the description fetch and
// the nightly grading take them in batches); the rest stay 'extra' and are released on a later cycle. Every released url is written with
// its release date to <data>/title-released.tsv: the board build keeps a released role hidden until it is graded (tools/update_jobs.py).
// Off ("enabled": false, a missing list, --no-title-release or JOBCRAWL_TITLE_RELEASE=0) = the former behaviour: a released role that
// fails the title rules turns 'extra' again on its next fetch.
function loadTitleRelease(cfg, configPath) {
  const c = cfg.title_release;
  if (!c || c.enabled !== true || flag('no-title-release') || process.env.JOBCRAWL_TITLE_RELEASE === '0') return null;
  const file = c.employers_file ? pathResolve(configPath, '..', c.employers_file) : '';
  if (!file || !existsSync(file)) { console.log(`title release: on, but the employers file ${file || '(none)'} is missing; off for this cycle`); return null; }
  let boards;
  try { boards = new Set((JSON.parse(readFileSync(file, 'utf8')).boards ?? []).map((b) => b.name)); } catch (e) { console.log(`title release: ${file} unreadable (${e.message}); off for this cycle`); return null; }
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  // window {tz, from, to} ("HH:MM", cycle start time; from > to wraps midnight): new releases only inside it, so they reach the nightly
  // grading the same night; outside it the cap is 0 (roles released before stay open, nothing new is released)
  let outside = '';
  if (c.window?.from && c.window?.to) {
    const now = process.env.JOBCRAWL_TITLE_RELEASE_NOW ? new Date(process.env.JOBCRAWL_TITLE_RELEASE_NOW) : new Date();
    const hm = new Intl.DateTimeFormat('en-GB', { timeZone: c.window.tz || 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    const { from, to } = c.window;
    const inside = from <= to ? hm >= from && hm < to : hm >= from || hm < to;
    if (!inside) outside = `outside the release window ${from}-${to} ${c.window.tz || 'Europe/Berlin'} (now ${hm})`;
  }
  // one-off extra shift (owner 2026-11-22 "include extra shift"): <data>/title-release-extra.json {until: ISO, max_total, released}
  // opens the window until `until` for at most max_total roles in all; it expires by itself (time or total) and is never needed again
  let extra = null, maxCycle = num(c.max_per_cycle, 1000);
  const extraFile = pathResolve(OUT_DIR, 'title-release-extra.json');
  if (outside && existsSync(extraFile)) {
    try {
      const x = JSON.parse(readFileSync(extraFile, 'utf8'));
      const now = process.env.JOBCRAWL_TITLE_RELEASE_NOW ? Date.parse(process.env.JOBCRAWL_TITLE_RELEASE_NOW) : Date.now();
      const left = num(x.max_total, 0) - num(x.released, 0);
      if (Date.parse(x.until) > now && left > 0) { extra = { file: extraFile, data: x }; maxCycle = Math.min(maxCycle, left); outside = ''; }
    } catch (e) { console.log(`title release: ${extraFile} unreadable (${e.message}); ignored`); }
  }
  return { boards, maxCycle: outside ? 0 : maxCycle, maxBoard: num(c.max_per_board_per_cycle, 150), outside, extra, used: 0, deferred: 0, released: 0, kept: 0 };
}
const RELEASED_HEADER = 'url\treleased';
function loadReleased(file) {
  const m = new Map();
  if (!existsSync(file)) return m;
  for (const l of readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) { const [u, d] = l.split('\t'); if (u && d) m.set(u, d); }
  return m;
}

// The verdicts that drop a role for its place (the per-entry site whitelist, block_hard, location_only and the allow list).
const LOCATION_VERDICTS = new Set(['location (site whitelist)', 'blocked-location', 'location-not-allowed', 'unknown-location']);

function locationVerdictCompiled(filters, normLocation, company) {
  if (!normLocation) return filters.allowUnknownLoc ? null : 'unknown-location';
  if (filters.blockHardLocMatcher(normLocation)) return 'blocked-location';
  const c = filters.companyMap.get(company);
  if (c?.locOnly) return c.locOnly(normLocation) ? null : 'location-not-allowed';
  if (c?.anyLoc) return null;
  if (filters.allowLocMatcher(normLocation) || (c?.locAllow && c.locAllow(normLocation)) || filters.allowCountryCode(normLocation)) return null;
  return 'location-not-allowed';
}

// ---------- history ----------
const HEADER = ['url', 'company', 'title', 'location', 'first_seen', 'last_seen', 'status', 'posted'];
// Original publish date as YYYY-MM-DD, or '' when the source does not say (first_seen is only when WE first saw it).
const postedDate = (raw) => {
  const d = String(raw ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today() ? d : '';
};
// Read in 1 MB blocks (crawler/history-read.mjs): the same Map as the old whole-file read, without the ~170 MB string and its line array.
function loadHistory() {
  return readHistoryFile(HISTORY, HEADER);
}
// The history is written in chunks and compared with the old file while it is written (crawler/history-write.mjs): the same bytes as
// before, an unchanged history keeps its mtime (downstream steps skip), and the ~170 MB text is never built as one string.
function saveHistory(map) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeHistoryFile(HISTORY, HEADER, map.values());
}

// Rows that left the working history, appended to <data>/scan-history-archive.tsv (same columns; the header is written once)
function archiveRows(rows) {
  const file = pathResolve(OUT_DIR, 'scan-history-archive.tsv'), head = existsSync(file) ? '' : HEADER.join('\t') + '\n';
  appendFileSync(file, head + rows.map((r) => HEADER.map((h) => String(r[h] ?? '').replace(/[\t\n]/g, ' ')).join('\t')).join('\n') + '\n');
}

// ---------- job descriptions ----------
const jdFile = (url) => pathResolve(JD_DIR, jdFileName(url));
// The description part of a saved job file (saveJd writes a "- First seen:" header block, a blank line, then the text).
function jdBody(text) {
  const i = text.indexOf('\n- First seen:');
  const end = i < 0 ? -1 : text.indexOf('\n\n', i + 1);
  return end < 0 ? text : text.slice(end + 2);
}
// Long descriptions keep their beginning and their end: eligibility wording (export control, citizenship, equal opportunity) sits at the end and
// a plain cut at 9,000 characters lost it for about one description in seven.
const clipDescription = (d, max = 9000, tail = 1500) => (d.length <= max ? d : `${d.slice(0, max - tail - 8)}\n[...]\n${d.slice(-tail)}`);
function saveJd(row, j) {
  const f = jdFile(row.url);
  if (existsSync(f)) {
    let cur = readFileSync(f, 'utf8'), changed = false;
    if (row.location && cur.includes('\n- Location: ?\n')) {
      cur = cur.replace('\n- Location: ?\n', `\n- Location: ${row.location}\n`);
      changed = true;
    }
    const isoPosted = j.postedAt ? String(j.postedAt).slice(0, 10) : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(isoPosted)) {
      const next = cur.replace(/\n- Posted: (?!\d{4}-\d{2}-\d{2})[^\n]+\n/, `\n- Posted: ${isoPosted}\n`);
      if (next !== cur) { cur = next; changed = true; }
    }
    if (changed) writeFileSync(f, cur);
    return;
  }
  if (!j.description) return;
  mkdirSync(JD_DIR, { recursive: true });
  const head = ['# ' + row.title, '', '- Company: ' + row.company, '- Location: ' + (row.location || '?'), '- URL: ' + row.url, '- First seen: ' + row.first_seen,
    j.postedAt ? '- Posted: ' + String(j.postedAt).slice(0, 10) : '', j.compensation ? '- Compensation (posted): ' + j.compensation : '', ...(j.meta?.departments ? ['- Department: ' + [].concat(j.meta.departments).join(' / ')] : []), ''].filter((x, i) => x !== '' || i === 1 || i > 2);
  writeFileSync(f, head.join('\n') + '\n' + clipDescription(j.description) + '\n');
}
// Retention (jdclean.mjs): called with a history loaded or written without error. Logs one line; dryRun only counts.
function jdCleanup(history, dryRun) {
  const r = cleanJd({ history, jdDir: JD_DIR, keepDays: PROFILE.jdKeepDays, today: today(), dryRun });
  if (r.skipped) return console.log(`descriptions: 0 removed (${r.skipped}), ${r.kept} kept`);
  const verb = dryRun ? 'would be removed' : 'removed';
  console.log(`descriptions: ${r.removed.length} ${verb} (not seen for more than ${PROFILE.jdKeepDays} days), ${r.kept} kept${dryRun ? ' (dry run: nothing deleted)' : ''}`);
}

// Board metadata of the roles that are open right now, keyed by url: current state only (a role that closed drops out), compact on purpose.
// Companies not fetched this cycle keep their previous entries. The classifiers read this file; nothing else depends on it.
function writeJobMeta(history, seen) {
  const f = pathResolve(OUT_DIR, 'job-meta.json');
  let prev = {};
  try { prev = JSON.parse(readFileSync(f, 'utf8')).jobs ?? {}; } catch {}
  const jobs = {};
  for (const [url, row] of history) {
    if (row.status !== 'open') continue;
    const m = seen.get(url) ?? prev[url];
    if (m) jobs[url] = m;
  }
  const next = JSON.stringify({ updated: new Date().toISOString(), jobs });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, f);
}

// ---------- concurrency ----------
function formatErr(e) {
  const msg = e?.message || String(e);
  const c = e?.cause;
  if (!c) return msg;
  const detail = c.message && c.code && !c.message.includes(c.code) ? `${c.code}: ${c.message}` : (c.message || c.code || String(c));
  return detail && detail !== msg ? `${msg} (${detail})` : msg;
}
async function pool(items, worker) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await worker(items[idx]).catch((e) => ({ error: formatErr(e), triage: e.triage ?? classifyError(e), host: e.host, provider: e.provider, ms: e.ms, budget_ms: e.budget_ms }));
      }
    }),
  );
  return results;
}

// ---------- scan ----------
// Optional overlay of employers kept next to the companies file (--overlay <file> or JOBCRAWL_COMPANIES_OVERLAY): {"tracked_companies": [...]}. Its entries are
// appended when neither the name nor the provider+slug is already tracked; the companies file always wins. Not applied with --config (test copies).
// Use: a host that cannot write the repo (read-only deploy key) adds newly found employers here; they are folded into the companies file later.
function withOverlay(cfg) {
  const file = opt('config') ? '' : (opt('overlay') ?? process.env.JOBCRAWL_COMPANIES_OVERLAY ?? '');
  if (!file) return cfg;
  if (!existsSync(file)) { console.error(`crawl: overlay ${file} not found, ignored`); return cfg; }
  let add;
  try { add = JSON.parse(readFileSync(file, 'utf8')).tracked_companies; if (!Array.isArray(add)) throw new Error('no tracked_companies array'); }
  catch (e) { console.error(`crawl: overlay ${file} unreadable (${e.message}), ignored`); return cfg; }
  const names = new Set(cfg.tracked_companies.map((c) => c.name));
  const boards = new Set(cfg.tracked_companies.filter((c) => c.provider && c.slug).map((c) => `${c.provider}:${String(c.slug).toLowerCase()}`));
  let n = 0;
  for (const c of add) {
    if (!c || typeof c.name !== 'string' || !(c.provider || c.careers_url)) continue;
    const b = c.provider && c.slug ? `${c.provider}:${String(c.slug).toLowerCase()}` : '';
    if (names.has(c.name) || (b && boards.has(b))) continue;
    cfg.tracked_companies.push(c); names.add(c.name); if (b) boards.add(b); n++;
  }
  console.log(`crawl: overlay ${file}: +${n} employers (${add.length - n} already tracked or invalid)`);
  return cfg;
}

async function scan() {
  const cfg = applyProfileFilters(withOverlay(JSON.parse(readFileSync(CONFIG, 'utf8'))), PROFILE);
  const only = opt('company')?.toLowerCase();
  // Per-site crawl interval: an entry with "interval_hours" is fetched only when it is due, so heavy boards (hundreds of
  // pages, no feed) run once or twice a day while light ones run every cycle. Due times are staggered by a per-company
  // offset so the heavy boards do not all fall into the same cycle. --company, --all and --dry-run ignore the schedule.
  const crawlState = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
  const nowMs = Date.now();
  const due = (c) => !c.interval_hours || only || flag('all') || flag('dry-run') || flag('force-due') || !crawlState[c.name] || Date.parse(crawlState[c.name]) <= nowMs;
  const stagger = (c) => (parseInt(createHash('md5').update(c.name).digest('hex').slice(0, 6), 16) / 0xffffff) * 0.4 + 0.8;   // 0.8..1.2 of the interval
  const history = loadHistory();
  const metaSeen = new Map();   // url -> board metadata of this cycle (department, workplace type, employment type, ...); written to job-meta.json
  // Probation (relevance.mjs): state per probation company in <data>/probation-state.json. Protected employers (catalogue,
  // industry aggregators, directly tracked non-probation entries) are never gated or pruned. Entries without "probation": true are untouched.
  const PROB_FILE = pathResolve(OUT_DIR, PROB_FILE_NAME);
  let probation = {};
  try { if (existsSync(PROB_FILE)) probation = JSON.parse(readFileSync(PROB_FILE, 'utf8')); } catch {}
  let probationDirty = false;
  const protectedIdx = makeEmployerIndex([
    ...loadCatalogueNames(CATALOGUE),
    ...protectedFromHistory(history.values()),
    ...cfg.tracked_companies.filter((c) => !c.probation && !isAggregatorEntry(c)).map((c) => c.name),
  ]);
  const isProtected = (name) => protectedIdx.has(name);
  const enabledAll = cfg.tracked_companies.filter((c) => c.enabled !== false && (!only || c.name.toLowerCase().includes(only)));
  // A probation company the pruning rule disabled is skipped (and listed in probation-report.json) unless it has become protected.
  const enabled = enabledAll.filter((c) => !(c.probation === true && probation[c.name]?.state === 'disabled' && !probation[c.name]?.reenable && !isProtected(c.name)));
  const probationSkipped = enabledAll.length - enabled.length;
  // the due boards, each provider's spread over the cycle (policy.mjs interleaveByProvider): boards that share a host (an ATS API,
  // EURES) do not run side by side, so a host's Crawl-delay or rate limit meets one board at a time
  const companies = interleaveByProvider(enabled.filter(due));
  const skipped = enabled.length - companies.length;
  const compiledFilters = prepareFilters(cfg);
  const titleRel = loadTitleRelease(cfg, CONFIG);
  const RELEASED_FILE = pathResolve(OUT_DIR, 'title-released.tsv');
  const releasedAt = loadReleased(RELEASED_FILE);
  const date = today();
  const lc = openLifecycle(OUT_DIR);   // MADE_LIFECYCLE=shadow: source observations only (lifecycle.mjs); off = null, nothing recorded
  const fresh = [];
  const problems = [];
  const boardMs = [];   // [name, provider, ms] per board fetch, for the board-time note (cycle length is measured, owner 2026-11-07)
  const needLazyJd = [];
  const dropReasons = {};   // verdict -> roles dropped this cycle (all of them get a 'filtered' row); printed in the notes
  // Board -> roles that pass the title filter but were dropped for their location this cycle (still recorded as 'filtered'). These are
  // the candidates for an in-scope loss (audit 2026-11-06: a too narrow allow list cost HENSOLDT 440 of 478 roles without a trace), so
  // the notes name the boards, largest first: a board that should not lose them gets any_location or a wider allow list.
  const locationDrops = {};
  const noteDrop = (why, board, normTitle) => {
    dropReasons[why] = (dropReasons[why] ?? 0) + 1;
    if (LOCATION_VERDICTS.has(why) && !titleVerdictCompiled(compiledFilters, normTitle, board)) locationDrops[board] = (locationDrops[board] ?? 0) + 1;
  };
  // Source health: a board that errors or silently returns 0 jobs for 3 cycles in a row is reported, so a broken decoder does not go unnoticed.
  const GUARD_FILE = pathResolve(OUT_DIR, 'liveness-guard.json');
  let guardState = {};
  try { if (existsSync(GUARD_FILE)) guardState = JSON.parse(readFileSync(GUARD_FILE, 'utf8')); } catch {}
  const HEALTH_FILE = pathResolve(OUT_DIR, 'source-health.json');
  let health = {};
  try { if (existsSync(HEALTH_FILE)) health = JSON.parse(readFileSync(HEALTH_FILE, 'utf8')); } catch {}
  function noteHealth(name, ok, n) {
    const h = (health[name] ??= { fails: 0, zero: 0, last_jobs: 0, last_ok: '' });
    if (!ok) h.fails++;
    else { h.fails = 0; h.last_ok = today(); if (n > 0) { h.last_jobs = n; h.zero = 0; } else if (h.last_jobs > 0) h.zero++; }
    if (h.fails >= 3) problems.push(`ALERT ${name}: failed ${h.fails} cycles in a row (last ok ${h.last_ok || 'never'})`);
    if (h.zero >= 3) problems.push(`ALERT ${name}: returned 0 jobs for ${h.zero} cycles (last non-empty run had ${h.last_jobs})`);
    // Profiled entries (crawler/profiler.mjs): a yield under the profiling baseline, or repeated failures, flag reprofile_due.
    const rp = reprofileCycle(h, profileOf.get(name), { ok, n, today: today() });
    if (rp) problems.push(`${name}: ${rp}`);
  }
  const profileOf = new Map(cfg.tracked_companies.filter((c) => c.profile).map((c) => [c.name, c.profile]));
  const stats = { fetched: 0, filtered: 0, seen: 0, crosslisted: 0, shadowed: 0 };
  // Aggregator boards (their employer is named in the title or the company suffix, so employer names cannot be compared).
  const boardNames = new Set(cfg.tracked_companies.filter(isAggregatorEntry).map((c) => c.name));

  // The employer's own ATS is ground truth. A role an aggregator lists for an employer we crawl directly is not inserted (a known one is
  // filtered), provided the direct feed is healthy and currently holds open roles for that employer. If the direct feed dries up (a broken
  // decoder, a board returning nothing) its employer drops out of this list and the aggregator copies come back on the next cycle.
  const failing = cfg.tracked_companies.filter((c) => { const h = health[c.name]; return h && (h.fails >= 3 || h.zero >= 3); }).map((c) => c.name);
  const directEmployers = [];
  { const seen = new Set();
    for (const row of history.values()) {
      if (row.status !== 'open' || isAggregatorRow(row, boardNames)) continue;
      const k = canonCompany(row.company);
      if (k && !seen.has(k)) { seen.add(k); directEmployers.push(row.company); }
    } }
  const employerHasAts = (company) => !!company && directEmployers.some((e) => sameEmployer(e, company)) && !failing.some((n) => sameEmployer(n, company));
  const SHADOWED = 'shadowed by the employer ATS';

  // Cross-listing index. Fingerprints are of the description body only (the saved file's header is cut off, so a
  // fingerprint read back from disk equals the one taken from the live feed). Cached by URL; v2 because v1 included the header.
  const SIMHASH_CACHE_FILE = pathResolve(OUT_DIR, 'simhash-cache.v2.json');
  let simHashCache = {};
  if (existsSync(SIMHASH_CACHE_FILE)) {
    try { simHashCache = JSON.parse(readFileSync(SIMHASH_CACHE_FILE, 'utf8')); } catch {}
  }
  let simHashDirty = false;
  const fpOf = (row) => {
    if (simHashCache[row.url]) return simHashCache[row.url];
    const f = jdFile(row.url);
    if (!existsSync(f)) return '';
    try {
      const fp = fingerprintText(jdBody(readFileSync(f, 'utf8')));
      if (fp) { simHashCache[row.url] = fp; simHashDirty = true; }
      return fp;
    } catch { return ''; }
  };
  // Every open role with a fingerprint. Several roles can share one fingerprint (identical boilerplate), so this is a list.
  const openIndex = [];
  // Posting-id rule (postingkey.mjs): a row whose URL, or an apply link in its description (aggregator rows), names a known ATS posting is indexed
  // even without a fingerprint. An open aggregator copy of an open direct posting with the same id is marked dup (the employer's ATS is ground truth).
  const loadApplyKeys = (row) => { if (isAggregatorRow(row, boardNames)) { const f = jdFile(row.url); if (existsSync(f)) try { setApplyKeys(row, jdBody(readFileSync(f, 'utf8'))); } catch {} } };
  for (const row of history.values()) if (row.status === 'open') { loadApplyKeys(row); const fp = fpOf(row); if (fp || rowPostingKeys(row).length) openIndex.push({ fp, row }); }
  // Startup sweep: every open aggregator copy is checked against ALL open direct rows (posting key and description fingerprint, the same
  // isCrossListing as for a new row), so a match does not wait for a new direct row to arrive. The direct rows are indexed by posting key and
  // by title token (two titles that match share most tokens, so the aggregator title's rarest token finds every candidate); the check stays
  // linear in the number of aggregator rows.
  {
    const directIdx = openIndex.filter((d) => d.row.status === 'open' && !isAggregatorRow(d.row, boardNames));
    const byKey = new Map(), byTok = new Map();
    const keyOf = (k) => `${k.vendor}|${k.id}`;
    for (const d of directIdx) {
      for (const k of rowPostingKeys(d.row)) { const x = keyOf(k); (byKey.get(x) ?? byKey.set(x, []).get(x)).push(d); }
      if (d.fp) for (const t of new Set(canonTitle(d.row.title).split(' ').filter(Boolean))) (byTok.get(t) ?? byTok.set(t, []).get(t)).push(d);
    }
    let swept = 0;
    for (const e of openIndex) {
      if (e.row.status !== 'open' || !isAggregatorRow(e.row, boardNames)) continue;
      const cand = new Set();
      for (const k of rowPostingKeys(e.row)) for (const d of byKey.get(keyOf(k)) ?? []) cand.add(d);
      if (e.fp) {
        // titleMatch needs token Jaccard >= 0.8: a matching title misses at most floor(0.2 n) of this title's n tokens, so the
        // floor(0.2 n) + 1 rarest tokens always include one the matching title has
        const toks = [...new Set(canonTitle(e.row.title).split(' ').filter(Boolean))].sort((x, y) => (byTok.get(x)?.length ?? 0) - (byTok.get(y)?.length ?? 0));
        for (const t of toks.slice(0, Math.floor(0.2 * toks.length) + 1)) for (const d of byTok.get(t) ?? []) cand.add(d);
      }
      for (const d of cand) {
        if (d.row.status === 'open' && isCrossListing(e.fp, e.row, d.fp, d.row, boardNames)) { e.row.status = 'dup'; stats.crosslisted++; swept++; break; }
      }
    }
    if (swept) console.log(`cross-listing sweep: ${swept} open aggregator copies of an open direct posting marked dup (${directIdx.length} direct rows checked against)`);
  }
  const findOriginal = (fp, row) => openIndex.find((e) => e.row.status === 'open' && e.row.url !== row.url && isCrossListing(fp, row, e.fp, e.row, boardNames));

  const boardLabels = loadLabels(OUT_DIR);
  const breaker = makeBreaker({ dataDir: OUT_DIR, dryRun: flag('dry-run') });
  const triageRows = [];   // one row per board outcome, for the triage log and the class counts
  let labelsDirty = false;
  let boardsDone = 0;
  const crawlStarted = Date.now();
  const results = await pool(companies, async (entry) => {
    try { return await crawlOne(entry); } finally { if (++boardsDone % 50 === 0 || boardsDone === companies.length) console.log(`[crawl] ${boardsDone}/${companies.length} boards done, ${((Date.now() - crawlStarted) / 60000).toFixed(1)} min`); }
  });
  // Strangler fig (core/route/shadow-hook.mjs): only when JOBCRAWL_SHADOW is set, the cycle's answers are kept for the shadow hook, which
  // runs after every legacy output of the cycle is written (below, after scan()).
  async function crawlOne(entry) {
    const r = resolve(entry);
    if (!r) throw new Error('no supported ATS (set provider+slug or fix careers_url)');
    const host = hostOf(entry, r.slug);
    // the breaker's host is the one the fetch goes to (resilience.mjs breakerHostOf); the triage row keeps hostOf() as before
    const bhost = breakerHostOf(r.provider, entry, r.slug);
    if (breaker.shouldSkip(r.provider, bhost)) return { entry, r, skipped: true, error: 'skipped: provider circuit breaker open', triage: { cls: 'SKIPPED', code: '', detail: 'circuit breaker open' } };
    let timer;
    const ms = entryTimeoutMs(entry);   // entry.timeout_ms, default 35 s
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(ms / 1000)}s (${entry.name})`)), ms);
    });
    const t0 = Date.now();
    try {
      const fetchPromise = providers[r.provider].fetch(r.slug, entry);
      const jobs = await Promise.race([fetchPromise, timeoutPromise]);
      breaker.record(r.provider, bhost, true);
      return { entry, r, jobs, ms: Date.now() - t0, budget_ms: ms };
    } catch (e) {
      // the first attempt's duration, before the breaker's confirm retry (triage rows: "ms" beside the board's budget "budget_ms")
      e.ms = Date.now() - t0; e.budget_ms = ms;
      const triage = classifyError(e);
      const cand = breaker.record(r.provider, bhost, false, triage);
      if (cand) {   // enough failures of one class: look again before the rest of the provider is skipped (resilience.mjs commit)
        await new Promise((res) => setTimeout(res, 15000));
        let again = true;
        try { await Promise.race([providers[r.provider].fetch(r.slug, entry), new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out (retry)')), 30000))]); again = false; }
        catch (e2) { again = classifyError(e2).cls === triage.cls || ['TIMEOUT_TLS', 'HTTP_5XX', 'DNS'].includes(classifyError(e2).cls); }
        breaker.commit(cand, again);
      }
      e.triage = triage; e.host = host; e.provider = r.provider;
      throw e;
    } finally {
      clearTimeout(timer);
      boardMs.push([entry.name, r.provider, Date.now() - t0]);
    }
  }

  // The employers the industry aggregators carry this cycle are protected too.
  for (const res of results) {
    if (res && !res.error && INDUSTRY_AGGREGATOR_PROVIDERS.has(res.r.provider)) for (const j of res.jobs) if (j.company) protectedIdx.add(j.company);
  }
  const trustedSg = protectedIdx;   // strict Singapore gate keeps jobs of protected employers
  const filling = [];   // boards whose page fill continues next cycle
  let gatedSg = 0, gatedProbation = 0;

  // Per-provider health line (owner 2026-11-06: silent degradation must show): boards fetched this cycle per provider, how many
  // failed and how many answered with 0 jobs, so a provider that breaks (JOIN returned [] for weeks) is visible in every cycle's notes.
  {
    const ph = {};
    results.forEach((res, i) => {
      const p = companies[i].provider ?? res?.r?.provider ?? '?';
      const x = (ph[p] ??= { n: 0, fail: 0, zero: 0 });
      x.n++;
      if (res?.skipped) { x.skip = (x.skip ?? 0) + 1; x.n--; }
      else if (!res || res.error) x.fail++;
      else if (!res.jobs?.length) x.zero++;
    });
    const parts = Object.entries(ph).sort((a, b) => b[1].n - a[1].n).map(([p, x]) => `${p} ${x.n}${x.fail ? ` (${x.fail} failed)` : ''}${x.zero ? ` (${x.zero} empty)` : ''}${x.skip ? ` (${x.skip} skipped by breaker)` : ''}`);
    if (parts.length) problems.push(`provider health: ${parts.join(', ')}`);
  }
  // The open rows of each board, grouped once (a role belongs to board X when its company is X or ends with "(via X)"): the liveness check
  // below used to scan the whole history (about 600,000 rows) for every board, about 500 boards a cycle.
  const openByBoard = new Map();
  for (const row of history.values()) {
    if (row.status !== 'open' || !row.company) continue;
    const keys = new Set([row.company]);
    for (let at = row.company.indexOf('(via '); at >= 0; at = row.company.indexOf('(via ', at + 1)) if (row.company.endsWith(')')) keys.add(row.company.slice(at + 5, -1));
    for (const k of keys) (openByBoard.get(k) ?? openByBoard.set(k, []).get(k)).push(row);
  }
  // Hide only by the admitting board (admission.mjs). Before any board is processed, every complete answer withdraws its board's
  // admissions of the URLs it no longer lists, so a role its admitting board says is gone closes exactly as it did before the rule.
  const adm = openAdmissions(OUT_DIR, {
    now: nowMs, history,
    lifecycleState: () => { const f = pathResolve(OUT_DIR, 'lifecycle', 'state.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).urls ?? null : null; },
  });
  adm.withdrawFromAnswers(results.flatMap((res, i) => {
    if (!res || res.skipped || res.error || !Array.isArray(res.jobs)) return [];
    const n = res.jobs.length, emptyOk = res.jobs.emptyOk === true;
    return [{ board: companies[i].name, listed: new Set(res.jobs.map((j) => j.url)), emptyOk,
      complete: !res.jobs.incomplete && !isCappedAnswer(n) && (n > 0 || emptyOk) }];
  }));
  results.forEach((res, i) => {
    const name = companies[i].name;
    const tr = (extra) => { const row = { ts: new Date().toISOString(), board: name, provider: res?.provider ?? res?.r?.provider ?? companies[i].provider ?? '?', host: res?.host ?? hostOf(companies[i], res?.r?.slug), ...(Number.isFinite(res?.ms) ? { ms: res.ms, budget_ms: res.budget_ms } : {}), ...extra }; triageRows.push(row); return row; };
    // the triage row is written first: with lc null (MADE_LIFECYCLE off) the optional call skipped its arguments, so skipped and failed
    // boards had no triage row (fixed 2026-11-25; the live cycle runs with the lifecycle on and is unchanged)
    if (res?.skipped) { const row = tr({ cls: 'SKIPPED', code: '', detail: 'circuit breaker open' }); lc?.skippedOrFailed(name, row, 'SKIPPED'); return; }   // not fetched: no health change, nothing marked gone
    if (!res || res.error) {
      const t = res?.triage ?? { cls: 'OTHER', code: '', detail: 'failed' };
      const row = tr({ cls: t.cls, code: t.code, detail: t.detail });
      lc?.skippedOrFailed(name, row, t.cls);
      noteHealth(name, false, 0);
      return problems.push(`${name}: ${res?.error ?? 'failed'} [${t.cls}${t.code ? ' ' + t.code : ''}]`);
    }
    const trow = tr({ cls: res.jobs.length ? 'OK' : 'EMPTY_OK', code: '', detail: '', jobs: res.jobs.length, kept: 0 });
    // an answer of exactly a page cap is partial (resilience.mjs CAPPED_COUNTS): never evidence that what it lacks is gone
    if (!res.jobs.incomplete && isCappedAnswer(res.jobs.length)) {
      Object.defineProperty(res.jobs, 'incomplete', { value: { left: 0, note: `answer of exactly ${res.jobs.length}: a page cap, read as partial` }, enumerable: false });
      trow.detail = 'capped answer';
    }
    let boardKept = 0;   // roles of this board that pass every filter (the in-scope yield)
    let boardReleased = 0;   // roles of this board newly released from the title rules this cycle (title_release cap)
    noteHealth(name, true, res.jobs.length);
    // Relevance: "relevance": "strict" | "broad" | "off" on an entry; the MyCareersFuture provider defaults to strict, everything else to off.
    const relMode = companies[i].relevance ?? (res.r.provider === 'mycareersfuture' ? 'strict' : 'off');
    const sgVerdict = (j) => { const v = relMode === 'off' ? null : strictVerdict(j, trustedSg, relMode); if (v) gatedSg++; return v; };
    // Probation: gate on role relevance until the company has shown one relevant role (or is protected).
    const isProb = companies[i].probation === true;
    const pst = isProb ? (probation[name] ??= newProbation(date)) : null;
    const protectedNow = isProb && isProtected(name);
    const probGated = isProb && !protectedNow && pst.state !== 'promoted' && pst.state !== 'protected';
    const pc = { relevant: 0, irrelevant: 0, samples: [] };
    const probVerdict = (j) => {
      if (!isProb) return null;
      if (isRelevantRole(j)) { pc.relevant++; return null; }
      pc.irrelevant++;
      if (pc.samples.length < 5) pc.samples.push(j.title);
      return probGated ? PROBATION_VERDICT : null;
    };
    // Collect-only boards (entry.collect_only: true): every role is kept in the history as 'extra', never 'open' or NEW, even when its
    // title passes. For feeds whose scope is decided downstream (aggregators like EURES or USAJOBS) so they do not flood the public board.
    const collectOnly = companies[i].collect_only === true;
    const live = new Set();
    if (companies[i].interval_hours) crawlState[name] = new Date(nowMs + Math.min(48, companies[i].interval_hours) * 36e5 * stagger(companies[i])).toISOString();   // capped at 48 h: a role not confirmed for 3 days is marked gone
    // An incomplete page fill (sitemap, jsonld_direct: the page budget ran out, the cache keeps what was read) is due again next cycle.
    if (res.jobs.incomplete) {
      if (res.jobs.incomplete.left > 0 && companies[i].interval_hours) crawlState[name] = new Date(nowMs).toISOString();
      filling.push(`${name}${res.jobs.incomplete.left ? ` ${res.jobs.incomplete.left} pages left` : ''}${res.jobs.incomplete.note ? ` (${res.jobs.incomplete.note})` : ''}`);
    }
    // Optional per-site whitelist (entry.only_locations): for big employers whose boards list the whole world, keep
    // only the places this audience cares about. Roles elsewhere are treated as filtered.
    const siteOnly = companies[i].only_locations?.map(norm);
    const maxAggAge = (cfg.max_aggregator_age_days ?? 270) * 864e5;
    const staleVerdict = (j, board) => {
      if (!maxAggAge || !(/\(via /i.test(j.company ?? '') || boardNames.has(board))) return null;
      const d = Date.parse(String(j.postedAt ?? '').slice(0, 10));
      return d && Date.now() - d > maxAggAge ? 'stale aggregator posting' : null;
    };
    const siteVerdict = (j) => (siteOnly && !siteOnly.some((k) => norm(j.location).includes(k)) ? 'location (site whitelist)' : null);
    const fromAggregator = isAggregatorEntry({ ...companies[i], provider: res.r.provider });
    const shadowVerdict = (j) => (fromAggregator && employerHasAts((j.company ?? '').replace(/\s*\(via [^)]*\)\s*$/i, '')) ? SHADOWED : null);
    for (const j of res.jobs) {
      stats.fetched++;
      live.add(j.url);
      if (j.meta) metaSeen.set(j.url, j.meta);
      if (j.orgMeta && mergeLabel(boardLabels, j.orgMeta, date)) labelsDirty = true;   // the board's own labels, also for roles filtered out below
      const normTitle = norm(j.title);
      const normLocation = norm(j.location);
      const broadWhy = flag('all') ? null : siteVerdict(j) ?? staleVerdict(j, name) ?? shadowVerdict(j) ?? titleVerdictCompiled(compiledFilters, normTitle, name) ?? locationVerdictCompiled(compiledFilters, normLocation, name);
      if (!broadWhy) boardKept++;
      const probWhy = probVerdict(j);   // always evaluated: counts relevant/irrelevant roles for the pruning rule
      let why = broadWhy ?? (flag('all') ? null : sgVerdict(j) ?? probWhy);
      // A role at an in-scope employer that only fails the title filter (technician, IT, finance, admin...) is kept as status 'extra':
      // it is never alerted as new or fed to the classifiers by default, but the board can offer it behind a "more roles" switch and
      // it serves as a coverage check against other boards. Location, probation and relevance verdicts still drop it as before.
      // On a collect-only board a role that passes every filter is kept as 'extra' too (the other verdicts drop it as before).
      let extraOnly = (collectOnly && !why) || ((broadWhy === 'no-positive-title' || broadWhy === 'negative-title')
        && !(sgVerdict(j) ?? probWhy) && !locationVerdictCompiled(compiledFilters, normLocation, name));
      if (why === PROBATION_VERDICT) gatedProbation++;
      if (why === SHADOWED) stats.shadowed++;
      const prior = history.get(j.url);
      // title_release (loadTitleRelease above): a title-only 'extra' at a listed board becomes a normal posting, within the caps
      if (titleRel && extraOnly && !collectOnly && !fromAggregator && titleRel.boards.has(name) && (prior || !flag('refresh-only'))) {
        const already = prior?.status === 'open';
        if (already || (titleRel.used < titleRel.maxCycle && boardReleased < titleRel.maxBoard)) {
          if (!already) { titleRel.used++; boardReleased++; titleRel.released++; } else titleRel.kept++;
          if (!releasedAt.has(j.url)) releasedAt.set(j.url, date);
          why = null; extraOnly = false;
        } else titleRel.deferred++;
      }
      if (prior) {
        if (!prior.posted) prior.posted = postedDate(j.postedAt);
        if (/^insert title of the position/i.test(prior.title) && j.title && !/^insert title of the position/i.test(j.title)) prior.title = j.title;   // csod template titles seen before the German view was read
        if (j.location && (!prior.location || prior.location === '?')) prior.location = j.location;
        if (j.company && (!prior.company || prior.company === name)) prior.company = j.company;
        // Hide only by the admitting board (admission.mjs): a role another board admitted within 48 h keeps its status; this listing
        // only refreshes its last sighting. The board's own admission is withdrawn by its own hide.
        if ((why || extraOnly) && adm.mayHide(j.url, name, why ?? '', prior.status === 'open' || prior.status === 'dup')) {
          prior.last_seen = date;
          continue;
        }
        if (why || extraOnly) {
          if (extraOnly) { prior.status = 'extra'; prior.last_seen = date; stats.extra = (stats.extra ?? 0) + 1; if (collectOnly) stats.collectOnly = (stats.collectOnly ?? 0) + 1; continue; }
          prior.status = 'filtered';
          prior.last_seen = date;
          stats.filtered++;
          noteDrop(why, name, normTitle);
          continue;
        }
        stats.seen++;
        prior.last_seen = date;
        adm.admit(j.url, name);
        if (prior.status === 'dup') {
          // A cross-listed copy stays out of the lists while its original is open; if the original closed, it takes over.
          // The employer's own ATS posting is the ground truth: when the "original" is an aggregator copy, the direct posting replaces it.
          loadApplyKeys(prior);
          const pfp = fpOf(prior);
          const orig = pfp || rowPostingKeys(prior).length ? findOriginal(pfp, prior) : undefined;
          if (orig && isAggregatorRow(orig.row, boardNames) && !isAggregatorRow(prior, boardNames)) {
            orig.row.status = 'dup';
            prior.status = 'open';
            openIndex.push({ fp: pfp, row: prior });
          } else if (orig) {
            continue;
          } else {
            prior.status = 'open';
            if (pfp || rowPostingKeys(prior).length) openIndex.push({ fp: pfp, row: prior });
            fresh.push({ ...prior, seniority: compiledFilters.seniorityMatcher(norm(prior.title)), posted: prior.posted });
          }
        }
        prior.status = 'open';
        if (flag('jd')) {
          if (j.description) saveJd(prior, j);
          else if (!existsSync(jdFile(prior.url))) needLazyJd.push({ row: prior, j, r: res.r });
        }
        continue;
      }
      if (flag('refresh-only')) { stats.skippedNew = (stats.skippedNew ?? 0) + 1; continue; }   // update known roles only, never add
      if (why || extraOnly) {
        if (extraOnly) {
          history.set(j.url, { url: j.url, company: j.company || name, title: j.title, location: j.location, first_seen: date, last_seen: date, status: 'extra', posted: postedDate(j.postedAt) });
          stats.extra = (stats.extra ?? 0) + 1;
          if (collectOnly) stats.collectOnly = (stats.collectOnly ?? 0) + 1;
          continue;
        }
        stats.filtered++;
        // Every dropped role is recorded as 'filtered' with its reason tallied (owner 2026-11-06: no silent drops; before, only the
        // probation gate wrote a row and a location or stale verdict left no trace, so a wrong allow list was invisible). A filtered
        // row is never new again; if the filter or the company's state changes later the role turns 'open' by itself on the next
        // fetch. No description is saved for it. Consumers read 'open' rows only, so the board is unaffected.
        history.set(j.url, { url: j.url, company: j.company || name, title: j.title, location: j.location, first_seen: date, last_seen: date, status: 'filtered', posted: postedDate(j.postedAt) });
        noteDrop(why, name, normTitle);
        continue;
      }
      const companyName = j.company || name;
      adm.admit(j.url, name);

      // Cross-listing: the same role already open under another URL (direct ATS and aggregator, or a reposted requisition).
      // Needs a matching description AND title AND employer AND place (crosslist.mjs); similar boilerplate alone is not enough.
      // The copy is kept in the history as status "dup" (so it is not re-fetched as new every cycle and can take over if the
      // original closes) and is left out of the board, the catalog and the private inbox.
      const fp = j.description ? fingerprintText(j.description) : '';
      const row = { url: j.url, company: companyName, title: j.title, location: j.location, first_seen: date, last_seen: date, status: 'open', posted: postedDate(j.postedAt) };
      if (isAggregatorRow(row, boardNames) && j.description) setApplyKeys(row, j.description);
      const original = fp || rowPostingKeys(row).length ? findOriginal(fp, row) : undefined;
      if (original) {
        stats.crosslisted++;
        simHashCache[j.url] = fp;
        simHashDirty = true;
        const keep = original.row;
        if (isAggregatorRow(keep, boardNames) && !isAggregatorRow(row, boardNames)) {
          // The open copy came through an aggregator and this one is the employer's own posting: the employer's link becomes
          // the role's link, and the aggregator link is remembered as a duplicate.
          history.set(keep.url, { ...keep, status: 'dup', last_seen: date });
          history.delete(j.url);
          Object.assign(keep, { url: j.url, company: companyName, last_seen: date });
          history.set(j.url, keep);
          simHashCache[j.url] = fp;
          if (flag('jd') && j.description) saveJd(keep, j);
        } else {
          row.status = 'dup';
          history.set(j.url, row);
        }
        continue;
      }

      history.set(j.url, row);
      if (fp || rowPostingKeys(row).length) openIndex.push({ fp, row });
      if (fp) {
        simHashCache[j.url] = fp;
        simHashDirty = true;
      }
      if (flag('jd')) {
        if (j.description) saveJd(row, j);
        else needLazyJd.push({ row, j, r: res.r });
      }
      fresh.push({ ...row, seniority: compiledFilters.seniorityMatcher(normTitle) });
    }
    trow.kept = boardKept;
    if (isProb && !flag('dry-run')) {
      const employerMismatch = companies[i].employer_mismatch ? String(companies[i].employer_mismatch) : '';
      // junk gate (junkgate.mjs, crawl.junk_gate): a not-yet-promoted board whose list does not look like a job list is recorded
      // ("report", the default) or kept from promotion ("hold")
      let junkHold = '';
      if (PROFILE.junkGate !== 'off' && probGated) {
        const jv = junkVerdict(res.jobs, { ...companies[i], provider: res.r.provider });
        if (jv.hold) {
          pst.junk = { at: date, reasons: jv.reasons, n: jv.n, job_like: jv.jobLikeFrac, token: jv.tokenFrac };
          problems.push(`JUNK GATE (${PROFILE.junkGate}): ${name} - ${jv.reasons.join('; ')}`);
          if (PROFILE.junkGate === 'hold') junkHold = jv.reasons.join('; ');
        } else delete pst.junk;
      }
      probationCycle(pst, { ok: true, total: res.jobs.length, relevant: pc.relevant, irrelevant: pc.irrelevant, samples: pc.samples, protectedNow, now: date, employerMismatch, junkHold });
      if (employerMismatch) problems.push(`EMPLOYER MISMATCH: ${name} stays on probation (${employerMismatch})`);
      probationDirty = true;
      if (pst.state === 'disabled') problems.push(`PROBATION: ${name} disabled - ${pst.reason}`);
      else if (probGated && pst.state === 'promoted') problems.push(`PROBATION: ${name} promoted (${pc.relevant} relevant roles)`);
    }
    // Liveness: previously tracked roles that vanished from a feed that loaded fine. A partial answer (the provider's time or page
    // budget ended the walk: res.jobs.incomplete) proves nothing about the roles it did not reach: they keep their status, and the
    // 3-day sweep below still retires a role that no answer confirms.
    if (res.jobs.incomplete) { lc?.fetched(name, trow, live, { cls: 'INCOMPLETE', complete: false }); return; }
    // Liveness guard (resilience.mjs livenessGuard): a board that had more than 5 open roles and now shows under half of them, or none,
    // without a positive empty-OK signal is a suspect fetch (a provider that swallowed an error looks exactly like this): the roles stay
    // open for this cycle and only the 3rd such fetch in a row closes them.
    const openRows = (openByBoard.get(name) ?? []).filter((row) => row.status === 'open'), missing = openRows.filter((row) => !live.has(row.url));
    if (missing.length) {
      const gd = livenessGuard(guardState, name, openRows.length, openRows.length - missing.length, { emptyOk: res.jobs.emptyOk === true, date });
      if (gd.hold) {
        trow.cls = 'SUSPECT_DROP'; trow.detail = `${openRows.length - missing.length} of ${openRows.length} open roles still listed; kept open (${gd.n} of 3)`;
        problems.push(`GUARD ${name}: ${trow.detail}`);
        lc?.fetched(name, trow, live, { cls: 'SUSPECT_DROP', complete: false });
        return;
      }
      if (gd.confirmed) problems.push(`GUARD ${name}: ${gd.n} fetches in a row with under half of its ${openRows.length} open roles listed; closing ${missing.length}`);
    } else delete guardState[name];
    // an empty answer is a complete one only with the provider's positive empty signal (a swallowed error looks the same)
    lc?.fetched(name, trow, live, { cls: trow.cls, complete: res.jobs.length > 0 || res.jobs.emptyOk === true, emptyOk: res.jobs.emptyOk === true });
    let held = 0;
    for (const row of openRows) {
      if (!live.has(row.url)) {
        if (lc?.mode === 'on' && !lc.closable(row.url)) { held++; continue; }   // MADE_LIFECYCLE=on: gone only on K misses + the floor
        if (adm.mayClose(row.url, name)) continue;   // another board admitted it within 48 h and still lists it (admission.mjs)
        row.status = 'gone';
        problems.push(`GONE: ${row.company} - ${row.title} (${row.url})`);
      }
    }
    // An admitting board (not an aggregator) whose complete answer no longer lists a role it admitted closes it also when the role
    // carries another board's name, so a close the admitting board reports never waits for that other board's next fetch (admission.mjs).
    if (!isAggregatorEntry({ ...companies[i], provider: res.r.provider })) {
      const own = new Set(openRows);
      for (const u of adm.saidGone(name)) {
        const row = history.get(u);
        if (!row || row.status !== 'open' || own.has(row)) continue;
        if (lc?.mode === 'on' && !lc.closable(u)) { held++; continue; }
        if (adm.mayClose(u, name)) continue;
        row.status = 'gone';
        problems.push(`GONE: ${row.company} - ${row.title} (${row.url})`);
      }
    }
    if (held) problems.push(`LIFECYCLE ${name}: ${held} missing roles kept open (under the miss count or the time floor)`);
  });

  if (needLazyJd.length && !flag('dry-run')) {
    // Providers with their own fetchDescription go first. Everything else falls back to reading the job page itself
    // (pageDescription), at most GENERIC_JD_PER_CYCLE per cycle so the backfill of long-open roles spreads over cycles, and never
    // for aggregator sites we do not scrape (LinkedIn and similar).
    const GENERIC_JD_PER_CYCLE = Number(process.env.GENERIC_JD_PER_CYCLE ?? 300);
    const NO_SCRAPE = /linkedin\.|indeed\.|glassdoor\.|xing\./i;
    // A page that yielded nothing (JavaScript-rendered, timing out) is remembered for 7 days instead of being retried every cycle.
    const failedFile = pathResolve(OUT_DIR, 'jd-failed.json');
    let failed = {};
    try { failed = JSON.parse(readFileSync(failedFile, 'utf8')); } catch { /* none yet */ }
    const retryAfter = Date.now() - 7 * 864e5;
    const due = (x) => !(failed[x.row.url] > retryAfter);
    const native = needLazyJd.filter((x) => providers[x.r.provider].fetchDescription && due(x));
    const generic = needLazyJd.filter((x) => !providers[x.r.provider].fetchDescription && !NO_SCRAPE.test(x.row.url) && due(x)).slice(0, GENERIC_JD_PER_CYCLE);
    await pool([...native, ...generic], async ({ row, j, r }) => {
      const own = providers[r.provider].fetchDescription;
      j.description = own ? await own(j, r.slug).catch(() => '') : await pageDescription(j);
      if (j.description) saveJd(row, j);
      else failed[row.url] = Date.now();
    });
    for (const [u, t] of Object.entries(failed)) if (t < Date.now() - 14 * 864e5) delete failed[u];
    writeFileSync(failedFile, JSON.stringify(failed));
  }

  // Rolling rescore of the back catalogue: every cycle a constant batch of open roles whose saved description is missing or too thin to
  // classify (under ROLLING_JD_THIN characters) is read again from the job page, whichever board is due. The least recently tried come
  // first; a role that still yields nothing waits 1, 3, 7, 14, then 30 days. A longer text replaces a thin one, a shorter never does.
  if (flag('jd') && !flag('dry-run')) {
    const BATCH = Number(process.env.ROLLING_JD_BATCH ?? 40);
    const THIN = Number(process.env.ROLLING_JD_THIN ?? 1200);
    // EURES portal pages are an empty app shell; EURES details go through the provider's limiter (eures-employer-detail.mjs)
    const SKIP = /linkedin\.|indeed\.|glassdoor\.|xing\.|europa\.eu\/eures/i;
    const rollFile = pathResolve(OUT_DIR, 'jd-rolling.json');
    let roll = {};
    try { roll = JSON.parse(readFileSync(rollFile, 'utf8')); } catch { /* none yet */ }
    const now = Date.now();
    const cand = [];
    for (const row of history.values()) {
      if (row.status !== 'open' || SKIP.test(row.url)) continue;
      const st = roll[row.url];
      if (st && st.next > now) continue;
      const f = jdFile(row.url);
      let len = -1;
      if (existsSync(f)) { len = jdBody(readFileSync(f, 'utf8')).length; if (len >= THIN) continue; }
      cand.push({ row, len, st });
    }
    cand.sort((a, b) => (a.st?.t ?? 0) - (b.st?.t ?? 0) || a.len - b.len);
    const batch = cand.slice(0, BATCH);
    let gained = 0, borrowed = 0;
    // Other sources for the same role: the same employer and title under another URL (an aggregator copy, or a duplicate or filtered row)
    // may already have a saved description. Rows are grouped by canonical employer and normalised title.
    const sibKey = (r) => `${canonCompany(r.company)}|${norm(r.title)}`;
    const wanted = new Set(batch.map((x) => sibKey(x.row)));
    const siblings = new Map();
    for (const r of history.values()) {
      if (!wanted.has(sibKey(r))) continue;
      const k = sibKey(r);
      if (!siblings.has(k)) siblings.set(k, []);
      siblings.get(k).push(r);
    }
    const siblingText = (row) => {
      let best = '';
      for (const o of siblings.get(sibKey(row)) ?? []) {
        if (o.url === row.url) continue;
        const g = jdFile(o.url);
        if (!existsSync(g)) continue;
        const body = jdBody(readFileSync(g, 'utf8'));
        if (body.length > best.length) best = body;
      }
      return best;
    };
    await pool(batch, async ({ row, len, st }) => {
      let text = await pageDescription({ url: row.url, title: row.title });
      if (!text || text.length < len + 200) {
        const sib = siblingText(row);
        if (sib.length >= THIN && sib.length > Math.max(len, text?.length ?? 0) + 200) { text = sib; borrowed++; }
      }
      const tries = (st?.tries ?? 0) + 1;
      if (text && text.length > Math.max(len, 0) + 200) {
        if (len < 0) saveJd(row, { description: text });
        else {
          const f = jdFile(row.url), cur = readFileSync(f, 'utf8');
          writeFileSync(f, cur.slice(0, cur.length - jdBody(cur).length) + clipDescription(text) + '\n');
        }
        delete roll[row.url];
        gained++;
      } else {
        roll[row.url] = { t: now, tries, next: now + [1, 3, 7, 14, 30][Math.min(tries - 1, 4)] * 864e5 };
      }
    });
    const open = new Set([...history.values()].filter((r) => r.status === 'open').map((r) => r.url));
    for (const u of Object.keys(roll)) if (!open.has(u)) delete roll[u];
    writeFileSync(rollFile, JSON.stringify(roll));
    console.log(`Rolling description backfill: ${batch.length} of ${cand.length} due roles tried, ${gained} gained a description (${borrowed} from another listing of the same role)`);
  }

  fresh.sort((a, b) => Number(b.seniority) - Number(a.seniority) || a.company.localeCompare(b.company));
  console.log(`Scanned ${companies.length - results.filter((r) => !r || r.error).length}/${companies.length} companies${skipped ? ` (${skipped} not due)` : ""} | ${stats.fetched} postings | ${stats.seen} already known | ${stats.filtered} filtered | ${stats.extra ?? 0} kept as extra | ${stats.crosslisted} cross-listed | ${stats.shadowed} shadowed by ATS | ${fresh.length} NEW${gatedSg ? ` | ${gatedSg} dropped by the strict relevance gate` : ''}${gatedProbation ? ` | ${gatedProbation} held back by probation` : ''}${probationSkipped ? ` | ${probationSkipped} probation companies disabled` : ''}${stats.collectOnly ? ` | ${stats.collectOnly} collect-only` : ''}${titleRel ? ` | title release: ${titleRel.released} released, ${titleRel.kept} kept open, ${titleRel.deferred} deferred (caps ${titleRel.maxCycle}/cycle, ${titleRel.maxBoard}/board${titleRel.outside ? `; ${titleRel.outside}` : ''}${titleRel.extra ? `; extra shift until ${titleRel.extra.data.until}` : ''})` : ''}${results.some((r) => r?.skipped) ? ` | ${results.filter((r) => r?.skipped).length} skipped by the provider breaker` : ''}`);
  // R3: one line per run, also when nothing was kept back (admission.mjs)
  problems.unshift(adm.summaryLine());
  if (adm.degradedLine()) console.log(adm.degradedLine());
  const locTop = Object.entries(locationDrops).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (locTop.length) problems.unshift(`title-passing roles dropped for their location, by board: ${locTop.slice(0, 10).map(([k, v]) => `${k} ${v}`).join(', ')}${locTop.length > 10 ? ` (and ${locTop.length - 10} more boards, ${locTop.slice(10).reduce((t, [, v]) => t + v, 0)} roles)` : ''}`);
  if (Object.keys(dropReasons).length) problems.unshift(`filtered by reason: ${Object.entries(dropReasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (filling.length) problems.unshift(`partial answers (page or time budget spent; nothing marked gone for them, a page fill continues next cycle): ${filling.length} boards: ${filling.slice(0, 15).join(', ')}${filling.length > 15 ? ', ...' : ''}`);
  {
    const slow = [...boardMs].sort((a, b) => b[2] - a[2]);
    const total = boardMs.reduce((t, b) => t + b[2], 0);
    if (slow.length) problems.unshift(`board fetch time: ${(total / 60000).toFixed(1)} board-minutes over ${slow.length} boards (${CONCURRENCY} in parallel); slowest ${slow.slice(0, 8).map(([n, p, ms]) => `${n} (${p}) ${(ms / 1000).toFixed(0)} s`).join(', ')}`);
  }
  {
    // triage: one line per class, then the worst providers per class (cycle notes), one JSON line per board in <data>/crawl-triage.jsonl
    const byCls = {}, byProv = {};
    for (const t of triageRows) { byCls[t.cls] = (byCls[t.cls] ?? 0) + 1; if (!['OK', 'EMPTY_OK', 'SKIPPED'].includes(t.cls)) { const k = `${t.provider}:${t.cls}${t.code ? ' ' + t.code : ''}`; byProv[k] = (byProv[k] ?? 0) + 1; } }
    const top = Object.entries(byProv).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${v}`);
    console.log(`triage: ${Object.entries(byCls).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}${top.length ? ` | by provider: ${top.join(', ')}` : ''}`);
    const out = opt('triage-out') ?? (flag('dry-run') ? '' : pathResolve(OUT_DIR, 'logs', 'crawl-triage.jsonl'));
    if (out && triageRows.length) { mkdirSync(pathResolve(out, '..'), { recursive: true }); try { if (statSync(out).size > 20e6) renameSync(out, `${out}.1`); } catch { /* none yet */ } appendFileSync(out, triageRows.map((t) => JSON.stringify(t)).join('\n') + '\n'); }
    const b = breaker.finish();
    if (b.open.length) problems.unshift(`provider breaker open: ${b.open.map(([k, v]) => `${k} (${v.cls}${v.code ? ' ' + v.code : ''}, until cycle ${v.open_until})`).join(', ')}${b.skipped ? `; skipped this cycle: ${b.skipped}` : ''}`);
  }
  await policySettled();
  for (const line of policySummary().reverse()) problems.unshift(line);
  flushPolicy();
  if (problems.length) console.log('\nNotes:\n' + problems.map((p) => '  - ' + p).join('\n'));

  if (flag('dry-run')) return console.log('\n(dry run: nothing written)');
  // Sweep: a role that no feed has confirmed for 3 days is gone (covers sources that are no longer crawled).
  const cutoff = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  // MADE_LIFECYCLE=on (D1): the sweep closes only on the lifecycle evidence; a posting nothing has listed for UNKNOWN_DAYS becomes
  // 'unknown' (not a close: no surface lists it, the history never counts it as closed); the rest keeps its status.
  const lcOn = lc?.mode === 'on';
  for (const row of history.values()) {
    if (!((row.status === 'open' || row.status === 'dup' || row.status === 'extra') && row.last_seen < cutoff)) continue;
    if (!lcOn) row.status = 'gone';
    else if (lc.closable(row.url)) row.status = 'gone';
    else if (lc.unknownSince(row.url, row.last_seen)) row.status = 'unknown';
  }
  // The description retention (jdCleanup) needs the rows the prune below drops, so it gets a copy taken before the prune.
  const jdRows = new Map(history);
  // Retention (crawl.history_prune_days, default 0 = off: hoard first, reduce later). When a profile sets it, gone/filtered
  // postings unseen for more than that many days leave the working history and move to the archive, which keeps their row
  // (first and last seen, title, company, location) for good: the trace of what was on the market, and when
  const pruneDays = PROFILE.historyPruneDays, archived = [];
  if (pruneDays > 0) {
    const pruneCutoff = new Date(Date.now() - pruneDays * 864e5).toISOString().slice(0, 10);
    for (const [url, row] of history.entries()) {
      if ((row.status === 'gone' || row.status === 'filtered') && row.last_seen < pruneCutoff) {
        archived.push(row); history.delete(url);
      }
    }
    if (archived.length) archiveRows(archived);
    console.log(`history: ${archived.length} rows older than ${pruneDays} days archived`);
  } else {
    console.log('history: pruning off (crawl.history_prune_days 0)');
  }
  lc?.flush();
  // Strangler-fig shadow (core/route/shadow-hook.mjs): only when JOBCRAWL_SHADOW is set, a compact copy of the routed boards' answers and of
  // their rows' final legacy status is taken here (the crawl's own objects are not kept), and the hook runs after scan() (end of file).
  if (process.env.JOBCRAWL_SHADOW && !flag('dry-run')) {
    try { SHADOW_INPUT = (await import('../core/route/shadow-hook.mjs')).captureShadowInput({ companies, results, history }); }
    catch (e) { console.error(`[shadow] capture skipped: ${e?.message ?? e}`); }
  }
  saveHistory(history);
  // the released urls that are still open (a role that closed or turned 'extra' again, e.g. with the switch off, leaves the file)
  if (titleRel?.extra) {   // the extra shift counts what it released, so its max_total holds across cycles
    const x = titleRel.extra.data;
    x.released = Number(x.released || 0) + titleRel.released;
    x.cycles = [...(x.cycles ?? []), { at: new Date().toISOString(), released: titleRel.released }];
    writeFileSync(titleRel.extra.file, JSON.stringify(x, null, 1) + '\n');
  }
  if (titleRel || releasedAt.size) {
    const keep = [...releasedAt].filter(([u]) => history.get(u)?.status === 'open');
    writeFileSync(RELEASED_FILE + '.tmp', [RELEASED_HEADER, ...keep.map(([u, d]) => `${u}\t${d}`)].join('\n') + '\n');
    renameSync(RELEASED_FILE + '.tmp', RELEASED_FILE);
  }
  if (existsSync(JD_DIR) && jdRows.size) jdCleanup(jdRows, false);
  if (labelsDirty) saveLabels(OUT_DIR, boardLabels);
  writeFileSync(STATE_FILE, JSON.stringify(crawlState, null, 1) + '\n');
  for (const k of Object.keys(health)) if (!cfg.tracked_companies.some((c) => c.name === k)) delete health[k];
  writeFileSync(HEALTH_FILE, JSON.stringify(health, null, 1) + '\n');
  for (const k of Object.keys(guardState)) if (!cfg.tracked_companies.some((c) => c.name === k)) delete guardState[k];
  writeFileSync(GUARD_FILE, JSON.stringify(guardState, null, 1) + '\n');
  try { adm.save(); } catch (e) { console.log(degraded(`admit-state.json not written (${oneLine(e.message)}), continuing with a fresh seed at the next run`)); }
  if (probationDirty || Object.keys(probation).length) {
    if (probationDirty) writeFileSync(PROB_FILE, JSON.stringify(probation, null, 1) + '\n');
    // Review list: companies disabled by the pruning rule. The companies file is never touched.
    const rows = Object.entries(probation).filter(([, s]) => s.state === 'disabled').map(([name, s]) => ({ name, reason: s.reason, disabled_at: s.disabled_at, wrong_streak: s.wrong_streak, cycles_ok: s.cycles_ok, relevant_seen: s.relevant_seen, irrelevant_seen: s.irrelevant_seen, last_cycle: s.last_cycle, sample_irrelevant: s.sample_irrelevant }));
    const count = (k) => Object.values(probation).filter((s) => s.state === k).length;
    writeFileSync(pathResolve(OUT_DIR, 'probation-report.json'), JSON.stringify({ updated: new Date().toISOString(), how_to_reenable: 'set "reenable": true on the company in probation-state.json (or remove "probation" from its companies.json entry)', counts: { probation: count('probation'), promoted: count('promoted'), protected: count('protected'), disabled: rows.length }, disabled: rows }, null, 1) + '\n');
  }
  if (simHashDirty) {
    // Drop fingerprints of roles that left the history, and write atomically so an interrupted run cannot leave a torn file.
    for (const url of Object.keys(simHashCache)) if (!history.has(url)) delete simHashCache[url];
    try {
      writeFileSync(`${SIMHASH_CACHE_FILE}.tmp`, JSON.stringify(simHashCache) + '\n');
      renameSync(`${SIMHASH_CACHE_FILE}.tmp`, SIMHASH_CACHE_FILE);
    } catch {}
  }
  // Hand-off for whoever consumes the crawl (e.g. a later build step): what was new in this run.
  writeJobMeta(history, metaSeen);
  writeFileSync(NEW_FILE, JSON.stringify({ date, rows: fresh.map(({ url, company, title, location, first_seen, seniority, posted }) => ({ url, company, title, location, first_seen, seniority, posted })) }, null, 1) + '\n');
}

if (flag('jd-cleanup-only')) {
  // Standalone retention: loads the history as the last run left it, runs the cleanup and exits. Rows the 90-day prune already dropped
  // are no longer in it, so their files count as unknown and stay.
  try { jdCleanup(loadHistory(), flag('dry-run')); } catch (e) { console.error(`crawl: ${e.message}`); process.exit(1); }
} else {
  await scan();
  if (RAW_ON) console.log(`crawl: ${rawCaptureSummary()}`);
  // The legacy outputs are written; now (and only when armed) the answers of the boards routed shadow go to the new per-board path in its
  // own folder (core/route/shadow-hook.mjs: off by default, budgets per board and per cycle, never throws).
  if (SHADOW_INPUT) {
    try { await (await import('../core/route/shadow-hook.mjs')).runShadow({ dataDir: OUT_DIR, input: SHADOW_INPUT }); }
    catch (e) { console.error(`[shadow] skipped this cycle: ${e?.message ?? e}`); }
  }
}
