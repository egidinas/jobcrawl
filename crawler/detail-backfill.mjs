#!/usr/bin/env node
// Detail backfill: the full detail of every tracked posting into the raw store, in or out of scope.
//
// The crawl saves a description only for roles that pass the title filter ('open'). At vendors whose board response does not
// carry descriptions (Workday, SmartRecruiters, SuccessFactors, Teamtailor RSS, Oracle, the HTML-only career sites) that leaves
// the 'extra' and 'filtered' roles with a title and nothing else, and the 'open' ones with a plain-text copy clipped at 9,000
// characters. This script fetches the detail of all of them through the same provider code and the same fetch as the crawl,
// so rawcapture.mjs keeps every response byte for byte (JOBCRAWL_RAW_DIR is required; without it the fetch would be wasted).
// Nothing is written to jd/*.md: the declared layer is parsed from the raw store.
//
//   node crawler/detail-backfill.mjs --profile <dir> --data <dir> [--budget 400] [--host-delay 1500] [--concurrency 4]
//                                    [--statuses extra,filtered,open] [--vendors workday,smartrecruiters] [--dry-run]
//
// Resumable: <data>/detail-backfill.json records every URL tried (ok, text length, tries, next retry). A run stops at --budget
// requests, so it rides the 20-minute crawl cycle; the queue order is open roles without a saved text first, then extra and
// filtered roles, then open roles whose text is only the clipped copy. Vendors whose board response carries every description
// (LIST_HAS_DESCRIPTION) are skipped unless named in --vendors. Hosts are fetched one request at a time with --host-delay
// between requests; --concurrency hosts run in parallel. Failures (JavaScript-rendered pages, errors) retry after 1, 7 and
// 30 days, then every 90 days. The log (stdout) has a start line with the plan, a progress line every 50 requests, and a
// result line with per-vendor counts, the raw-capture summary and the remaining queue.
import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { providers, resolve, setCacheDir, pageDescription } from './providers.mjs';
import { loadProfile, profileDirFromArgs, resolveDataDir, applyProfileFilters } from './profile.mjs';
import { setUserAgent } from './useragent.mjs';
import { jdFileName } from './jdclean.mjs';
import { installRawCapture, rawCaptureSummary } from './rawcapture.mjs';

/** Vendors whose board response already carries every description: the raw capture of the crawl has them, no detail fetch needed. */
export const LIST_HAS_DESCRIPTION = new Set(['greenhouse', 'ashby', 'lever', 'personio', 'recruitee', 'pinpoint', 'breezy', 'workable']);
const NO_SCRAPE = /linkedin\.|indeed\.|glassdoor\.|xing\./i;
const RETRY_DAYS = [1, 7, 30, 90];
const THIN = 1200;   // a saved text shorter than this counts as missing (same threshold as the crawl's rolling rescore)
const CLIP = 8900;   // a saved text at least this long was clipped by the crawl (clipDescription cuts at 9,000)

const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The work list. history: Map url -> row ({url, company, title, status, first_seen, ...}); boards: Map company name -> {provider, slug};
 * state: the backfill state; jdInfo(url) -> text length of the saved description or -1. Returns {queue, skipped, byVendor}.
 */
export function planBackfill({ history, boards, state = {}, now = Date.now(), statuses = ['extra', 'filtered', 'open'], vendors = null, jdInfo = () => -1 }) {
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
    if (st?.ok) { skipped.done++; continue; }
    if (st && st.next > now) { skipped.waiting++; continue; }
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
 * fetchOne(item) -> result; onDone(item, result, i) after each. Returns the items actually attempted.
 */
export async function runQueue(queue, fetchOne, { budget = 400, hostDelay = 1500, concurrency = 4, onDone = () => {} } = {}) {
  const items = queue.slice(0, budget);
  const byHost = new Map();
  for (const it of items) { if (!byHost.has(it.host)) byHost.set(it.host, []); byHost.get(it.host).push(it); }
  const hosts = [...byHost.values()].sort((a, b) => b.length - a.length);   // the longest host queues start first
  let n = 0, next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, async () => {
    while (next < hosts.length) {
      const list = hosts[next++];
      for (let k = 0; k < list.length; k++) {
        if (k) await sleep(hostDelay);
        let res;
        try { res = await fetchOne(list[k]); } catch (e) { res = { ok: false, error: e.message }; }
        onDone(list[k], res, ++n);
      }
    }
  }));
  return items;
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
  const statuses = opt('statuses', 'extra,filtered,open').split(',');
  const vendors = opt('vendors') ? opt('vendors').split(',') : null;
  const plan = planBackfill({ history, boards, state, statuses, vendors, jdInfo });
  const prio = [0, 1, 2, 3].map((p) => plan.queue.filter((q) => q.priority === p).length);
  say(`start: ${history.size} history rows, ${boards.size} boards; candidates ${plan.queue.length} (open without text ${prio[0]}, extra/filtered ${prio[1]}, `
    + `clipped open ${prio[2]}, complete open ${prio[3]}); skipped ${JSON.stringify(plan.skipped)}; budget ${budget}, host delay ${hostDelay} ms, ${concurrency} hosts at a time`);
  say(`candidates by vendor: ${Object.entries(plan.byVendor).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);
  if (flag('dry-run') || !plan.queue.length) { say(`result: dry run, nothing fetched${plan.queue.length ? '' : ' (queue empty)'}`); return; }

  const counts = {};
  const bump = (vendor, k) => { const c = counts[vendor] ??= { ok: 0, fail: 0 }; c[k]++; };
  let ok = 0, fail = 0;
  const fetchOne = async ({ row, board }) => {
    const p = providers[board.provider];
    const job = { url: row.url, title: row.title, company: row.company };
    const text = p?.fetchDescription ? await p.fetchDescription(job, board.slug) : await pageDescription(job);
    return { ok: typeof text === 'string' && text.length >= 200, len: text?.length ?? 0 };
  };
  const onDone = ({ row, board }, res, i) => {
    const st = state[row.url] ?? { tries: 0 };
    st.tries++;
    st.t = Date.now();
    if (res.ok) { st.ok = true; st.len = res.len; delete st.next; ok++; bump(board.provider, 'ok'); }
    else { st.ok = false; st.len = res.len ?? 0; if (res.error) st.error = res.error.slice(0, 120); st.next = nextRetry(st.tries); fail++; bump(board.provider, 'fail'); }
    state[row.url] = st;
    if (i % 50 === 0) {
      saveState();
      const dt = (Date.now() - t0) / 1000;
      say(`progress: ${i}/${Math.min(budget, plan.queue.length)} fetched, ${ok} ok, ${fail} failed, ${dt.toFixed(0)} s, ${(i / dt).toFixed(2)} req/s`);
    }
  };
  await runQueue(plan.queue, fetchOne, { budget, hostDelay, concurrency, onDone });
  saveState();
  const left = plan.queue.length - Math.min(budget, plan.queue.length);
  say(`result: ${ok} ok, ${fail} failed in ${((Date.now() - t0) / 1000).toFixed(0)} s; per vendor ${Object.entries(counts).map(([v, c]) => `${v} ${c.ok}/${c.ok + c.fail}`).join(', ')}; `
    + `${left} left in the queue (about ${Math.ceil(left / budget)} more runs at this budget); ${rawCaptureSummary()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`backfill: FAILED ${e.stack ?? e.message}`); process.exit(1); });
}
