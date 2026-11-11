#!/usr/bin/env node
// Detail backfill: the full detail of every tracked posting into the raw store, in or out of scope.
//
// The crawl saves a description only for roles that pass the title filter ('open'). At vendors whose board response does not
// carry descriptions (Workday, SmartRecruiters, SuccessFactors, Teamtailor RSS, Oracle, the HTML-only career sites) that leaves
// the 'extra' and 'filtered' roles with a title and nothing else, and the 'open' ones with a plain-text copy clipped at 9,000
// characters. This script fetches the detail of all of them through the same provider code and the same fetch as the crawl,
// so rawcapture.mjs keeps every response byte for byte (JOBCRAWL_RAW_DIR is required; without it the fetch would be wasted).
// The fetched text is also kept (2026-11-11; before, it was thrown away and only its length was recorded): for an 'open' role the
// description file <data>/jd/<hash>.md is written when it is missing, and replaced when the saved text is thin (under 1,200
// characters) and the fetched one is at least 200 characters longer. A description of normal length is never replaced, and
// 'extra' / 'filtered' roles get no file (the declared layer is parsed from the raw store). Open roles that an earlier run fetched
// successfully but whose saved text is still missing or thin are fetched once more.
//
//   node crawler/detail-backfill.mjs --profile <dir> --data <dir> [--budget 400] [--minutes 0] [--host-delay 1500] [--concurrency 4]
//                                    [--host-fail-limit 5] [--statuses extra,filtered,open] [--vendors workday,smartrecruiters] [--dry-run]
//                                    [--retry-failed]
//
// --retry-failed ignores the retry dates of failed URLs (use it with --vendors after a provider learned to read its details).
//
// --minutes N stops starting requests after N minutes (0 = no time limit), so a large --budget fits a cycle or a lane. A host whose
// last --host-fail-limit requests in this run all failed is left for the next run (its remaining URLs are not tried and not counted
// as tries), so a vendor that fails slowly (timeouts) does not eat the run. Every request passes the crawl policy (policy.mjs:
// robots.txt advisory or strict per crawl.robots, Crawl-delay floor on top of --host-delay, 429/503 cooldowns, no login pages).
//
// Resumable: <data>/detail-backfill.json records every URL tried (ok, text length, tries, next retry). A run stops at --budget
// requests, so it rides the 20-minute crawl cycle; the queue order is open roles without a saved text first, then extra and
// filtered roles, then open roles whose text is only the clipped copy. Vendors whose board response carries every description
// (LIST_HAS_DESCRIPTION) are skipped unless named in --vendors. Hosts are fetched one request at a time with --host-delay
// between requests; --concurrency hosts run in parallel. Failures (JavaScript-rendered pages, errors) retry after 1, 7 and
// 30 days, then every 90 days. The log (stdout) has a start line with the plan, a progress line every 50 requests, and a
// result line with per-vendor counts, the raw-capture summary and the remaining queue.
//
// One instance per data directory: <data>/detail-backfill.lock holds {pid, started}; a second run finds it, sees the pid alive and
// the lock younger than 12 hours, and exits without touching the queue, so a long dedicated run and the per-cycle hook never
// work the same URLs. A crash leaves a stale lock, which the next run takes over (dead pid, or older than 12 hours).
import { existsSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { providers, resolve, setCacheDir, pageDescription } from './providers.mjs';
import { loadProfile, profileDirFromArgs, resolveDataDir, applyProfileFilters } from './profile.mjs';
import { setUserAgent } from './useragent.mjs';
import { jdFileName, jdBody, jdDocument, jdHeader, clipDescription, stripContactSection } from './jdclean.mjs';
import { installRawCapture, rawCaptureSummary } from './rawcapture.mjs';
import { configurePolicy, policyFromProfile, installGuard, policySummary, flushPolicy, policySettled } from './policy.mjs';
import { setEuresLane } from './providers-eures.mjs';

/** Vendors whose board response already carries every description: the raw capture of the crawl has them, no detail fetch needed. */
export const LIST_HAS_DESCRIPTION = new Set(['greenhouse', 'ashby', 'lever', 'personio', 'recruitee', 'pinpoint', 'breezy', 'workable']);
const NO_SCRAPE = /linkedin\.|indeed\.|glassdoor\.|xing\./i;
const RETRY_DAYS = [1, 7, 30, 90];
const THIN = 1200;   // a saved text shorter than this counts as missing (same threshold as the crawl's rolling rescore)
const CLIP = 8900;   // a saved text at least this long was clipped by the crawl (clipDescription cuts at 9,000)
const LOCK_MAX_AGE_MS = 12 * 3600e3;   // a lock older than this is stale even if its pid is alive (a pid reused by something else)

/**
 * Whether the lock file's content (JSON {pid, started}) belongs to a run that is still going: the pid is alive (isAlive(pid))
 * and started is less than 12 hours before now. Unparseable or incomplete content counts as stale.
 */
export function lockIsActive(lockJson, now = Date.now(), isAlive = pidIsAlive) {
  let lock;
  try { lock = JSON.parse(lockJson); } catch { return false; }
  const pid = Number(lock?.pid), started = Date.parse(lock?.started);
  if (!Number.isInteger(pid) || pid <= 0 || Number.isNaN(started)) return false;
  if (now - started >= LOCK_MAX_AGE_MS) return false;
  return isAlive(pid);
}

function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }   // EPERM: the process exists, it is just not ours
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The work list. history: Map url -> row ({url, company, title, status, first_seen, ...}); boards: Map company name -> {provider, slug};
 * state: the backfill state; jdInfo(url) -> text length of the saved description or -1. Returns {queue, skipped, byVendor}.
 */
export function planBackfill({ history, boards, state = {}, now = Date.now(), statuses = ['extra', 'filtered', 'open'], vendors = null, jdInfo = () => -1, retryFailed = false }) {
  const want = new Set(statuses);
  const only = vendors ? new Set(vendors) : null;
  const skipped = { status: 0, 'no-board': 0, 'list-carries-description': 0, 'no-scrape': 0, done: 0, waiting: 0 };
  const queue = [];
  for (const row of history.values()) {
    if (!want.has(row.status)) { skipped.status++; continue; }
    const board = boards.get(row.company);
    if (!board) { skipped['no-board']++; continue; }
    if (only ? !only.has(board.provider) : LIST_HAS_DESCRIPTION.has(board.provider)) { skipped['list-carries-description']++; continue; }
    if (NO_SCRAPE.test(row.url)) { skipped['no-scrape']++; continue; }
    const st = state[row.url];
    // done, unless it is an open role fetched before the text was kept (no st.jd) whose saved text is still missing or thin: once more
    if (st?.ok && !(row.status === 'open' && !st.jd && jdInfo(row.url) < THIN)) { skipped.done++; continue; }
    if (st && !st.ok && st.next > now && !retryFailed) { skipped.waiting++; continue; }
    let priority = 1;                                   // extra and filtered: no text at all
    if (row.status === 'open') { const len = jdInfo(row.url); priority = len < THIN ? 0 : len >= CLIP ? 2 : 3; }
    queue.push({ row, board, priority, host: hostOf(row.url) });
  }
  // open roles without text first, then the roles with nothing, then clipped open texts, then complete open texts (L0 completeness);
  // newest first within a class, so a fresh posting is captured before it disappears
  queue.sort((a, b) => a.priority - b.priority || String(b.row.first_seen ?? '').localeCompare(String(a.row.first_seen ?? '')));
  const byVendor = {};
  for (const q of queue) byVendor[q.board.provider] = (byVendor[q.board.provider] ?? 0) + 1;
  return { queue, skipped, byVendor };
}

/**
 * Fetches up to budget items: one request at a time per host with hostDelay ms between them, concurrency hosts in parallel.
 * maxMs (0 = none): no request starts after that many ms. hostFailLimit (0 = none): a host whose last hostFailLimit results all
 * failed gets no more requests in this run. fetchOne(item) -> result; onDone(item, result, i) after each.
 * Returns the items actually attempted; .skipped counts the items left for the next run ({ time, host_failing, hosts }).
 */
export async function runQueue(queue, fetchOne, { budget = 400, hostDelay = 1500, concurrency = 4, maxMs = 0, hostFailLimit = 0, onDone = () => {} } = {}) {
  const items = queue.slice(0, budget);
  const byHost = new Map();
  for (const it of items) { if (!byHost.has(it.host)) byHost.set(it.host, []); byHost.get(it.host).push(it); }
  const hosts = [...byHost.values()].sort((a, b) => b.length - a.length);   // the longest host queues start first
  const t0 = Date.now(), attempted = [], skipped = { time: 0, host_failing: 0, hosts: [] };
  let n = 0, next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, async () => {
    while (next < hosts.length) {
      const list = hosts[next++];
      let failStreak = 0;
      for (let k = 0; k < list.length; k++) {
        if (maxMs && Date.now() - t0 > maxMs) { skipped.time += list.length - k; break; }
        if (hostFailLimit && failStreak >= hostFailLimit) { skipped.host_failing += list.length - k; skipped.hosts.push(list[k].host); break; }
        if (k) await sleep(hostDelay);
        let res;
        try { res = await fetchOne(list[k]); } catch (e) { res = { ok: false, error: e.message }; }
        failStreak = res?.ok ? 0 : failStreak + 1;
        attempted.push(list[k]);
        onDone(list[k], res, ++n);
      }
    }
  }));
  return Object.assign(attempted, { skipped });
}

/**
 * What the description file of an open role holds after its detail was fetched: the new content, or null to leave the file alone.
 * existing: the file's content or null; row: the history row; text: the fetched description. A missing file is written; a thin one
 * (under THIN characters of text) is replaced, header kept, when the fetched text is at least 200 characters longer; a description
 * of normal length is never replaced (a page text can be longer only because it carries the menus). Recruiting contacts stay out.
 */
export function jdAfterFetch(existing, row, text) {
  const t = stripContactSection(text);
  if (t.length < 200) return null;
  if (existing == null) return jdDocument(row, t);
  const body = jdBody(existing);
  if (body.length >= THIN || t.length < body.length + 200) return null;
  const head = jdHeader(existing);
  return head ? `${head}\n\n${clipDescription(t)}\n` : jdDocument(row, t);
}

export function nextRetry(tries, now = Date.now()) {
  return now + RETRY_DAYS[Math.min(tries - 1, RETRY_DAYS.length - 1)] * 864e5;
}

function loadHistory(file) {
  const map = new Map();
  if (!existsSync(file)) return map;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const header = lines[0].split('\t');
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const row = Object.fromEntries(line.split('\t').map((v, i) => [header[i], v]));
    map.set(row.url, row);
  }
  return map;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(`--${n}`);
  const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
  const t0 = Date.now();
  const say = (m) => console.log(`backfill: ${m}`);

  let PROFILE;
  try { PROFILE = loadProfile(profileDirFromArgs(args)); } catch (e) { console.error(`backfill: ${e.message}`); process.exit(2); }
  if (!PROFILE) { console.error('backfill: no profile. Pass --profile <dir> or set JOBCRAWL_PROFILE.'); process.exit(2); }
  setUserAgent(PROFILE.userAgent);
  const dataDir = resolveDataDir(opt('data'), PROFILE);
  setCacheDir(dataDir);
  if (!installRawCapture()) { console.error('backfill: JOBCRAWL_RAW_DIR is not set; the backfill only makes sense with the raw capture on.'); process.exit(2); }

  // one instance per data directory
  const lockFile = pathResolve(dataDir, 'detail-backfill.lock');
  if (existsSync(lockFile)) {
    const content = readFileSync(lockFile, 'utf8');
    if (lockIsActive(content, Date.now())) {
      let held = {};
      try { held = JSON.parse(content); } catch { /* lockIsActive parsed it */ }
      say(`another run is active (pid ${held.pid} since ${held.started}), skipping`);
      return;
    }
    say(`taking over a stale lock (${content.trim()})`);
  }
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  const releaseLock = () => { try { unlinkSync(lockFile); } catch { /* already gone */ } };
  // The crawl policy around every request (the same as the crawl's), after the raw capture so refused requests are not captured.
  configurePolicy(policyFromProfile(PROFILE, dataDir));
  installGuard();
  if (PROFILE.euresLane) setEuresLane(pathResolve(dataDir, 'eures-lane'));   // EURES details: no request to europa.eu outside the lane
  process.on('exit', releaseLock);
  try { await backfill({ flag, opt, t0, say, PROFILE, dataDir }); } finally { releaseLock(); }
}

async function backfill({ flag, opt, t0, say, PROFILE, dataDir }) {
  const cfg = applyProfileFilters(JSON.parse(readFileSync(PROFILE.companiesFile, 'utf8')), PROFILE);
  const boards = new Map();
  for (const c of cfg.tracked_companies ?? []) {
    if (c.enabled === false) continue;
    const r = resolve(c);
    if (r) boards.set(c.name, r);
  }
  const history = loadHistory(pathResolve(dataDir, 'scan-history.tsv'));
  const stateFile = pathResolve(dataDir, 'detail-backfill.json');
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
  const saveState = () => { writeFileSync(`${stateFile}.tmp`, JSON.stringify(state)); renameSync(`${stateFile}.tmp`, stateFile); };
  const jdDir = pathResolve(dataDir, 'jd');
  const jdInfo = (url) => { try { return statSync(pathResolve(jdDir, jdFileName(url))).size; } catch { return -1; } };   // file size: close enough to the text length

  const budget = Number(opt('budget', 400)), hostDelay = Number(opt('host-delay', 1500)), concurrency = Number(opt('concurrency', 4));
  const maxMs = Number(opt('minutes', 0)) * 60000, hostFailLimit = Number(opt('host-fail-limit', 5));
  const statuses = opt('statuses', 'extra,filtered,open').split(',');
  const vendors = opt('vendors') ? opt('vendors').split(',') : null;
  const plan = planBackfill({ history, boards, state, statuses, vendors, jdInfo, retryFailed: flag('retry-failed') });
  const prio = [0, 1, 2, 3].map((p) => plan.queue.filter((q) => q.priority === p).length);
  say(`start: ${history.size} history rows, ${boards.size} boards; candidates ${plan.queue.length} (open without text ${prio[0]}, extra/filtered ${prio[1]}, `
    + `clipped open ${prio[2]}, complete open ${prio[3]}); skipped ${JSON.stringify(plan.skipped)}; budget ${budget}${maxMs ? ` or ${maxMs / 60000} min` : ''}, host delay ${hostDelay} ms, ${concurrency} hosts at a time, a host stops after ${hostFailLimit || 'unlimited'} failures in a row`);
  say(`candidates by vendor: ${Object.entries(plan.byVendor).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);
  if (flag('dry-run') || !plan.queue.length) { say(`result: dry run, nothing fetched${plan.queue.length ? '' : ' (queue empty)'}`); return; }

  const counts = {};
  const bump = (vendor, k) => { const c = counts[vendor] ??= { ok: 0, fail: 0 }; c[k]++; };
  let ok = 0, fail = 0, saved = 0;
  const fetchOne = async ({ row, board }) => {
    const p = providers[board.provider];
    const job = { url: row.url, title: row.title, company: row.company };
    const text = p?.fetchDescription ? await p.fetchDescription(job, board.slug) : await pageDescription(job);
    return { ok: typeof text === 'string' && text.length >= 200, len: text?.length ?? 0, text };
  };
  // the text of an open role goes to its description file (jdAfterFetch decides); a write error is reported, the run goes on
  const keepText = (row, text) => {
    const f = pathResolve(jdDir, jdFileName(row.url));
    let existing = null;
    try { existing = readFileSync(f, 'utf8'); } catch { /* no file yet */ }
    const next = jdAfterFetch(existing, row, text);
    if (!next) return 'kept';
    try { mkdirSync(jdDir, { recursive: true }); writeFileSync(f, next); saved++; return 'written'; }
    catch (e) { say(`description not saved for ${row.url}: ${e.message}`); return 'kept'; }
  };
  const onDone = ({ row, board }, res, i) => {
    const st = state[row.url] ?? { tries: 0 };
    st.tries++;
    st.t = Date.now();
    if (res.ok) { st.ok = true; st.len = res.len; delete st.next; ok++; bump(board.provider, 'ok'); if (row.status === 'open') st.jd = keepText(row, res.text); }
    else { st.ok = false; st.len = res.len ?? 0; if (res.error) st.error = res.error.slice(0, 120); st.next = nextRetry(st.tries); fail++; bump(board.provider, 'fail'); }
    state[row.url] = st;
    if (i % 50 === 0) {
      saveState();
      const dt = (Date.now() - t0) / 1000;
      say(`progress: ${i}/${Math.min(budget, plan.queue.length)} fetched, ${ok} ok, ${fail} failed, ${saved} descriptions saved, ${dt.toFixed(0)} s, ${(i / dt).toFixed(2)} req/s`);
    }
  };
  const done = await runQueue(plan.queue, fetchOne, { budget, hostDelay, concurrency, maxMs, hostFailLimit, onDone });
  saveState();
  await policySettled();
  flushPolicy();
  const left = plan.queue.length - done.length;
  const sk = done.skipped;
  say(`result: ${ok} ok, ${fail} failed, ${saved} descriptions saved in ${((Date.now() - t0) / 1000).toFixed(0)} s; per vendor ${Object.entries(counts).map(([v, c]) => `${v} ${c.ok}/${c.ok + c.fail}`).join(', ')}; `
    + `${left} left in the queue (about ${Math.ceil(left / Math.max(1, done.length))} more runs like this one)`
    + `${sk.time ? `; ${sk.time} not started (time limit)` : ''}${sk.host_failing ? `; ${sk.host_failing} left on ${sk.hosts.length} failing hosts (${sk.hosts.slice(0, 5).join(', ')})` : ''}; ${rawCaptureSummary()}`);
  for (const line of policySummary()) say(`policy: ${line}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`backfill: FAILED ${e.stack ?? e.message}`); process.exit(1); });
}
