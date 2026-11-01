#!/usr/bin/env node
// Job crawler: polls the public ATS feeds of the companies in the profile's companies file, applies the broad title/location
// filter, dedups and tracks liveness in <data>/scan-history.tsv, and (with --jd) saves the full job description of every tracked
// role to <data>/jd/. New postings of a run go to <data>/last-new.json. Reads public job feeds only; nothing in here knows about
// any candidate. Run `node crawler/crawl.mjs --help` for the options.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, appendFileSync } from 'node:fs';
import { loadLabels, saveLabels, merge as mergeLabel } from './board-labels.mjs';
import { createHash } from 'node:crypto';
import { resolve as pathResolve } from 'node:path';
import { providers, resolve, setCacheDir, pageDescription } from './providers.mjs';
import { fingerprintText } from './fingerprint.mjs';
import { isCrossListing, sameEmployer, canonCompany, isAggregatorRow, AGGREGATOR_PROVIDERS, rowPostingKeys, setApplyKeys } from './crosslist.mjs';
import { isRelevantRole, makeEmployerIndex, protectedFromHistory, loadCatalogueNames, strictVerdict, probationCycle, newProbation,
  useRelevance, INDUSTRY_AGGREGATOR_PROVIDERS, INDUSTRY_VIA, PROBATION_VERDICT } from './relevance.mjs';
import { loadProfile, profileDirFromArgs, resolveDataDir, applyProfileFilters } from './profile.mjs';
import { setUserAgent } from './useragent.mjs';
import { checkDisk } from './diskguard.mjs';
import { cleanJd, jdFileName } from './jdclean.mjs';
import { installRawCapture, rawCaptureSummary } from './rawcapture.mjs';

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
  --company <text>    only companies whose name contains <text>
  --all               ignore the title and location filters (see everything)
  --jd                also save the job description of every tracked role
  --refresh-only      update known roles only, never add new ones
  --dry-run           print the summary, write nothing
  --jd-cleanup-only   no crawl: remove the descriptions of roles not seen for more than jd_keep_days days, then exit
                      (with --dry-run it only counts them)
  --help              show this text
(profile key crawl.min_free_mb: refuse to start when the data disk has less free space than this many MB; 0 = no check)
(profile key crawl.jd_keep_days: a role's description is removed once the role has not been seen for more than this many days
 (its history row is not 'open'); default 90; 0 = keep forever)
(profile key crawl.history_prune_days: gone/filtered rows not seen for more than this many days leave scan-history.tsv and move to
 scan-history-archive.tsv; default 0 = never prune, every row stays in the working history)
(companies-file key collect_only on an entry: the board is collected but never published; its roles are kept as status 'extra',
 never 'open' or NEW, even when the title passes; other keys of an entry are listed in profiles/schema.md)`;

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
// every feed response byte for byte under JOBCRAWL_RAW_DIR (rawcapture.mjs), before the first request
const RAW_ON = !flag('jd-cleanup-only') && installRawCapture();
if (RAW_ON) console.log(`crawl: raw capture on, ${process.env.JOBCRAWL_RAW_DIR}`);
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

  const companyMap = new Map();
  for (const c of cfg.tracked_companies ?? []) {
    const extraPositive = c.extra_positive?.length ? compileMatcher(c.extra_positive) : null;
    const locOnly = c.location_only?.length ? compileMatcher(c.location_only) : null;
    const locAllow = c.location_allow?.length ? compileMatcher(c.location_allow) : null;
    companyMap.set(c.name, { extraPositive, locOnly, locAllow });
  }

  return {
    negativeTitleMatcher,
    positiveTitleMatcher,
    hasPositiveList: (tf.positive ?? []).length > 0,
    seniorityMatcher,
    blockHardLocMatcher,
    allowLocMatcher,
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

function locationVerdictCompiled(filters, normLocation, company) {
  if (!normLocation) return filters.allowUnknownLoc ? null : 'unknown-location';
  if (filters.blockHardLocMatcher(normLocation)) return 'blocked-location';
  const c = filters.companyMap.get(company);
  if (c?.locOnly) return c.locOnly(normLocation) ? null : 'location-not-allowed';
  if (filters.allowLocMatcher(normLocation) || (c?.locAllow && c.locAllow(normLocation))) return null;
  return 'location-not-allowed';
}

// ---------- history ----------
const HEADER = ['url', 'company', 'title', 'location', 'first_seen', 'last_seen', 'status', 'posted'];
// Original publish date as YYYY-MM-DD, or '' when the source does not say (first_seen is only when WE first saw it).
const postedDate = (raw) => {
  const d = String(raw ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today() ? d : '';
};
function loadHistory() {
  const map = new Map();
  if (!existsSync(HISTORY)) return map;
  for (const line of readFileSync(HISTORY, 'utf8').split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const row = Object.fromEntries(line.split('\t').map((v, i) => [HEADER[i], v]));
    map.set(row.url, row);
  }
  return map;
}
function saveHistory(map) {
  mkdirSync(OUT_DIR, { recursive: true });
  const lines = [HEADER.join('\t'), ...[...map.values()].map((r) => HEADER.map((h) => String(r[h] ?? '').replace(/[\t\n]/g, ' ')).join('\t'))];
  const next = lines.join('\n') + '\n';
  if (existsSync(HISTORY) && readFileSync(HISTORY, 'utf8') === next) return;   // unchanged: keep the mtime so downstream steps can skip
  const tmp = `${HISTORY}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, HISTORY);
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
async function pool(items, worker) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await worker(items[idx]).catch((e) => ({ error: e.message }));
      }
    }),
  );
  return results;
}

// ---------- scan ----------
async function scan() {
  const cfg = applyProfileFilters(JSON.parse(readFileSync(CONFIG, 'utf8')), PROFILE);
  const only = opt('company')?.toLowerCase();
  // Per-site crawl interval: an entry with "interval_hours" is fetched only when it is due, so heavy boards (hundreds of
  // pages, no feed) run once or twice a day while light ones run every cycle. Due times are staggered by a per-company
  // offset so the heavy boards do not all fall into the same cycle. --company, --all and --dry-run ignore the schedule.
  const crawlState = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
  const nowMs = Date.now();
  const due = (c) => !c.interval_hours || only || flag('all') || flag('dry-run') || !crawlState[c.name] || Date.parse(crawlState[c.name]) <= nowMs;
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
    ...cfg.tracked_companies.filter((c) => !c.probation && !AGGREGATOR_PROVIDERS.has(c.provider)).map((c) => c.name),
  ]);
  const isProtected = (name) => protectedIdx.has(name);
  const enabledAll = cfg.tracked_companies.filter((c) => c.enabled !== false && (!only || c.name.toLowerCase().includes(only)));
  // A probation company the pruning rule disabled is skipped (and listed in probation-report.json) unless it has become protected.
  const enabled = enabledAll.filter((c) => !(c.probation === true && probation[c.name]?.state === 'disabled' && !probation[c.name]?.reenable && !isProtected(c.name)));
  const probationSkipped = enabledAll.length - enabled.length;
  const companies = enabled.filter(due);
  const skipped = enabled.length - companies.length;
  const compiledFilters = prepareFilters(cfg);
  const date = today();
  const fresh = [];
  const problems = [];
  const needLazyJd = [];
  // Source health: a board that errors or silently returns 0 jobs for 3 cycles in a row is reported, so a broken decoder does not go unnoticed.
  const HEALTH_FILE = pathResolve(OUT_DIR, 'source-health.json');
  let health = {};
  try { if (existsSync(HEALTH_FILE)) health = JSON.parse(readFileSync(HEALTH_FILE, 'utf8')); } catch {}
  function noteHealth(name, ok, n) {
    const h = (health[name] ??= { fails: 0, zero: 0, last_jobs: 0, last_ok: '' });
    if (!ok) h.fails++;
    else { h.fails = 0; h.last_ok = today(); if (n > 0) { h.last_jobs = n; h.zero = 0; } else if (h.last_jobs > 0) h.zero++; }
    if (h.fails >= 3) problems.push(`ALERT ${name}: failed ${h.fails} cycles in a row (last ok ${h.last_ok || 'never'})`);
    if (h.zero >= 3) problems.push(`ALERT ${name}: returned 0 jobs for ${h.zero} cycles (last non-empty run had ${h.last_jobs})`);
  }
  const stats = { fetched: 0, filtered: 0, seen: 0, crosslisted: 0, shadowed: 0 };
  // Aggregator boards (their employer is named in the title or the company suffix, so employer names cannot be compared).
  const boardNames = new Set(cfg.tracked_companies.filter((c) => AGGREGATOR_PROVIDERS.has(c.provider)).map((c) => c.name));

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
  for (const e of openIndex) {
    if (e.row.status !== 'open' || !isAggregatorRow(e.row, boardNames) || !rowPostingKeys(e.row).length) continue;
    if (openIndex.some((d) => d.row.status === 'open' && !isAggregatorRow(d.row, boardNames) && isCrossListing('', e.row, '', d.row, boardNames))) { e.row.status = 'dup'; stats.crosslisted++; }
  }
  const findOriginal = (fp, row) => openIndex.find((e) => e.row.status === 'open' && e.row.url !== row.url && isCrossListing(fp, row, e.fp, e.row, boardNames));

  const boardLabels = loadLabels(OUT_DIR);
  let labelsDirty = false;
  const results = await pool(companies, async (entry) => {
    const r = resolve(entry);
    if (!r) throw new Error('no supported ATS (set provider+slug or fix careers_url)');
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after 35s (${entry.name})`)), 35000);
    });
    try {
      const fetchPromise = providers[r.provider].fetch(r.slug, entry);
      const jobs = await Promise.race([fetchPromise, timeoutPromise]);
      return { entry, r, jobs };
    } finally {
      clearTimeout(timer);
    }
  });

  // The employers the industry aggregators carry this cycle are protected too.
  for (const res of results) {
    if (res && !res.error && INDUSTRY_AGGREGATOR_PROVIDERS.has(res.r.provider)) for (const j of res.jobs) if (j.company) protectedIdx.add(j.company);
  }
  const trustedSg = protectedIdx;   // strict Singapore gate keeps jobs of protected employers
  let gatedSg = 0, gatedProbation = 0;

  results.forEach((res, i) => {
    const name = companies[i].name;
    if (!res || res.error) { noteHealth(name, false, 0); return problems.push(`${name}: ${res?.error ?? 'failed'}`); }
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
    const fromAggregator = AGGREGATOR_PROVIDERS.has(res.r.provider);
    const shadowVerdict = (j) => (fromAggregator && employerHasAts((j.company ?? '').replace(/\s*\(via [^)]*\)\s*$/i, '')) ? SHADOWED : null);
    for (const j of res.jobs) {
      stats.fetched++;
      live.add(j.url);
      if (j.meta) metaSeen.set(j.url, j.meta);
      if (j.orgMeta && mergeLabel(boardLabels, j.orgMeta, date)) labelsDirty = true;   // the board's own labels, also for roles filtered out below
      const normTitle = norm(j.title);
      const normLocation = norm(j.location);
      const broadWhy = flag('all') ? null : siteVerdict(j) ?? staleVerdict(j, name) ?? shadowVerdict(j) ?? titleVerdictCompiled(compiledFilters, normTitle, name) ?? locationVerdictCompiled(compiledFilters, normLocation, name);
      const probWhy = probVerdict(j);   // always evaluated: counts relevant/irrelevant roles for the pruning rule
      const why = broadWhy ?? (flag('all') ? null : sgVerdict(j) ?? probWhy);
      // A role at an in-scope employer that only fails the title filter (technician, IT, finance, admin...) is kept as status 'extra':
      // it is never alerted as new or fed to the classifiers by default, but the board can offer it behind a "more roles" switch and
      // it serves as a coverage check against other boards. Location, probation and relevance verdicts still drop it as before.
      // On a collect-only board a role that passes every filter is kept as 'extra' too (the other verdicts drop it as before).
      const extraOnly = (collectOnly && !why) || ((broadWhy === 'no-positive-title' || broadWhy === 'negative-title')
        && !(sgVerdict(j) ?? probWhy) && !locationVerdictCompiled(compiledFilters, normLocation, name));
      if (why === PROBATION_VERDICT) gatedProbation++;
      if (why === SHADOWED) stats.shadowed++;
      const prior = history.get(j.url);
      if (prior) {
        if (!prior.posted) prior.posted = postedDate(j.postedAt);
        if (/^insert title of the position/i.test(prior.title) && j.title && !/^insert title of the position/i.test(j.title)) prior.title = j.title;   // csod template titles seen before the German view was read
        if (j.location && (!prior.location || prior.location === '?')) prior.location = j.location;
        if (j.company && (!prior.company || prior.company === name)) prior.company = j.company;
        if (why || extraOnly) {
          if (extraOnly) { prior.status = 'extra'; prior.last_seen = date; stats.extra = (stats.extra ?? 0) + 1; if (collectOnly) stats.collectOnly = (stats.collectOnly ?? 0) + 1; continue; }
          prior.status = 'filtered';
          stats.filtered++;
          continue;
        }
        stats.seen++;
        prior.last_seen = date;
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
        // A role held back only by the probation gate is recorded as 'filtered' (like a known role that fails a filter), so it is not
        // treated as new again; if the company is promoted later it turns 'open' by itself. No description is saved for it.
        if (why === PROBATION_VERDICT) history.set(j.url, { url: j.url, company: j.company || name, title: j.title, location: j.location, first_seen: date, last_seen: date, status: 'filtered', posted: postedDate(j.postedAt) });
        continue;
      }
      const companyName = j.company || name;

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
      fresh.push({ ...row, seniority: compiledFilters.seniorityMatcher(normTitle), posted: (j.postedAt ?? '').slice(0, 10) });
    }
    if (isProb && !flag('dry-run')) {
      probationCycle(pst, { ok: true, total: res.jobs.length, relevant: pc.relevant, irrelevant: pc.irrelevant, samples: pc.samples, protectedNow, now: date });
      probationDirty = true;
      if (pst.state === 'disabled') problems.push(`PROBATION: ${name} disabled - ${pst.reason}`);
      else if (probGated && pst.state === 'promoted') problems.push(`PROBATION: ${name} promoted (${pc.relevant} relevant roles)`);
    }
    // Liveness: previously tracked roles that vanished from a feed that loaded fine.
    for (const row of history.values()) {
      if ((row.company === name || row.company?.endsWith(`(via ${name})`)) && row.status === 'open' && !live.has(row.url)) {
        row.status = 'gone';
        problems.push(`GONE: ${row.company} - ${row.title} (${row.url})`);
      }
    }
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
      j.description = own ? await own(j, r.slug) : await pageDescription(j);
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
    const SKIP = /linkedin\.|indeed\.|glassdoor\.|xing\./i;
    const rollFile = pathResolve(OUT_DIR, 'jd-rolling.json');
    let roll = {};
    try { roll = JSON.parse(readFileSync(rollFile, 'utf8')); } catch { /* none yet */ }
    const now = Date.now();
    const cand = [];
    for (const row of history.values()) {
      if (row.status !== 'open' || SKIP.test(row.url)) continue;
      const f = jdFile(row.url);
      let len = -1;
      if (existsSync(f)) { len = jdBody(readFileSync(f, 'utf8')).length; if (len >= THIN) continue; }
      const st = roll[row.url];
      if (st && st.next > now) continue;
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
  console.log(`Scanned ${companies.length - results.filter((r) => !r || r.error).length}/${companies.length} companies${skipped ? ` (${skipped} not due)` : ""} | ${stats.fetched} postings | ${stats.seen} already known | ${stats.filtered} filtered | ${stats.extra ?? 0} kept as extra | ${stats.crosslisted} cross-listed | ${stats.shadowed} shadowed by ATS | ${fresh.length} NEW${gatedSg ? ` | ${gatedSg} dropped by the strict relevance gate` : ''}${gatedProbation ? ` | ${gatedProbation} held back by probation` : ''}${probationSkipped ? ` | ${probationSkipped} probation companies disabled` : ''}${stats.collectOnly ? ` | ${stats.collectOnly} collect-only` : ''}`);
  if (problems.length) console.log('\nNotes:\n' + problems.map((p) => '  - ' + p).join('\n'));

  if (flag('dry-run')) return console.log('\n(dry run: nothing written)');
  // Sweep: a role that no feed has confirmed for 3 days is gone (covers sources that are no longer crawled).
  const cutoff = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  for (const row of history.values()) if ((row.status === 'open' || row.status === 'dup' || row.status === 'extra') && row.last_seen < cutoff) row.status = 'gone';
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
  saveHistory(history);
  if (existsSync(JD_DIR) && jdRows.size) jdCleanup(jdRows, false);
  if (labelsDirty) saveLabels(OUT_DIR, boardLabels);
  writeFileSync(STATE_FILE, JSON.stringify(crawlState, null, 1) + '\n');
  for (const k of Object.keys(health)) if (!cfg.tracked_companies.some((c) => c.name === k)) delete health[k];
  writeFileSync(HEALTH_FILE, JSON.stringify(health, null, 1) + '\n');
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
}
