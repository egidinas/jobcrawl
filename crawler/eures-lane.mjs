#!/usr/bin/env node
// The EURES slow lane (owner 2026-11-07): europa.eu's robots.txt asks for Crawl-delay: 10, which the crawl policy honours (policy.mjs),
// so the EURES boards are read here, one board at a time at that gap, and not in the crawl cycle. Each board's answer goes to
// <data>/eures-lane/<hash>.json.gz; the crawl (profile key crawl.eures_lane: true) reads the newest answer instead of calling EURES.
//
//   node crawler/eures-lane.mjs --profile <dir> [--data <dir>] [--minutes 25] [--min-age-hours 12] [--log <file>]
//
// Each run takes the enabled EURES boards of the companies file, oldest answer first (none = oldest), skips those answered within
// --min-age-hours, and reads boards until --minutes is spent (0 = until every board is done), so a scheduled run every 30 minutes keeps
// the lane going around the clock without overlapping (<data>/eures-lane.lock, one run per data folder). A board gets up to 10 minutes
// (its pages at the robots gap); an answer the time budget cut short is stored as partial (the crawl marks nothing gone for it).
// A failed board keeps its previous answer and is retried in the next run. Log: a start line, one line per board, a result line.
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { loadProfile, profileDirFromArgs, resolveDataDir, entryTimeoutMs } from './profile.mjs';
import { setUserAgent } from './useragent.mjs';
import { configurePolicy, policyFromProfile, installGuard, policySummary, flushPolicy, policySettled } from './policy.mjs';
import { eures, readLaneAnswer, writeLaneAnswer, setEuresRateFile } from './providers-eures.mjs';
import { lockIsActive } from './detail-backfill.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const t0 = Date.now();
const LOG = opt('log');
const say = (m) => {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} [${String(Math.round((Date.now() - t0) / 1000)).padStart(6)}s] eures-lane: ${m}`;
  console.log(line);
  if (LOG) try { appendFileSync(LOG, line + '\n'); } catch { /* console has it */ }
};

let PROFILE;
try { PROFILE = loadProfile(profileDirFromArgs(args)); } catch (e) { console.error(`eures-lane: ${e.message}`); process.exit(2); }
if (!PROFILE) { console.error('eures-lane: no profile. Pass --profile <dir> (or set JOBCRAWL_PROFILE).'); process.exit(2); }
setUserAgent(PROFILE.userAgent);
const DATA = resolveDataDir(opt('data'), PROFILE);
const LANE = pathResolve(DATA, 'eures-lane');
setEuresRateFile(pathResolve(DATA, 'eures-rate.json'));
configurePolicy(policyFromProfile(PROFILE, DATA));
installGuard();

const lockFile = pathResolve(DATA, 'eures-lane.lock');
if (existsSync(lockFile) && lockIsActive(readFileSync(lockFile, 'utf8'), Date.now())) { say(`another run is active (${readFileSync(lockFile, 'utf8').trim()}), skipping`); process.exit(0); }
writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
process.on('exit', () => { try { unlinkSync(lockFile); } catch { /* gone */ } });

const minutes = Number(opt('minutes', 25)), minAgeH = Number(opt('min-age-hours', 12));
const cfg = JSON.parse(readFileSync(PROFILE.companiesFile, 'utf8'));
const boards = (cfg.tracked_companies ?? []).filter((c) => c.enabled !== false && c.provider === 'eures' && (c.slug || c.careers_url));
const slugOf = (c) => c.slug ?? eures.detect(c.careers_url);
const ageOf = (c) => { const a = readLaneAnswer(LANE, slugOf(c)); return a ? (Date.now() - Date.parse(a.at)) / 36e5 : Infinity; };
const queue = boards.map((c) => ({ c, age: ageOf(c) })).filter((x) => x.age >= minAgeH).sort((a, b) => (a.age === b.age ? 0 : b.age > a.age ? 1 : -1));
say(`start: ${boards.length} EURES boards, ${queue.length} due (answer older than ${minAgeH} h or none; ${queue.filter((x) => x.age === Infinity).length} never answered), time limit ${minutes || 'none'} min, data ${DATA}`);

let ok = 0, failed = 0, partial = 0, jobsTotal = 0;
for (const { c, age } of queue) {
  if (minutes && Date.now() - t0 > minutes * 60000) { say(`time limit reached: ${queue.length - ok - failed} boards left for the next run`); break; }
  const slug = slugOf(c);
  if (!slug) { failed++; say(`FAIL ${c.name}: no EURES slug`); continue; }
  const b0 = Date.now();
  try {
    const jobs = await eures.fetch(slug, { ...c, timeout_ms: Math.max(entryTimeoutMs(c), 600000) });
    const cut = !!jobs.incomplete;
    writeLaneAnswer(LANE, slug, { name: c.name, slug, at: new Date().toISOString(), n: jobs.length, incomplete: cut, jobs: [...jobs] });
    ok++; jobsTotal += jobs.length; if (cut) partial++;
    say(`OK   ${c.name}: ${jobs.length} vacancies${cut ? ' (partial: time budget)' : ''} in ${Math.round((Date.now() - b0) / 1000)} s (previous answer ${age === Infinity ? 'none' : `${Math.round(age)} h old`})`);
  } catch (e) {
    failed++;
    say(`FAIL ${c.name}: ${String(e.message ?? e).slice(0, 200)} (previous answer kept)`);
  }
}
await policySettled();
flushPolicy();
for (const line of policySummary()) say(`policy: ${line}`);
say(`result: ${ok} boards answered (${partial} partial, ${jobsTotal} vacancies), ${failed} failed, in ${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(0);
