#!/usr/bin/env node
// EURES employer detail sweep: the official NACE class (and size code) of every employer seen on EURES, one detail document each.
//
// The EURES search response leaves employer.sectorCodes empty (0 of ~60k employer entries in the raw store, 2026-11-01); the NACE Rev. 2
// class (e.g. "o78.2.0") and organisationSizeCode are only in the per-vacancy detail document, GET /jv-searchengine/public/jv/id/<id>
// (docs/sources/eures-api.md), which the crawl fetches only for vacancies without a description. This tool reads the EURES search
// responses in the raw store (JOBCRAWL_RAW_DIR: index/*.jsonl and the gzipped objects), picks ONE vacancy per distinct employer
// (normalised name + web site host; the vacancy seen last, then the most recently modified), and fetches its detail document through
// the provider's own request path (providers-eures.mjs euresDetail: the host-wide limiter, the Retry-After and 5xx handling) with the
// raw capture on, so the response lands in the raw store byte for byte like every other.
//
//   node crawler/eures-employer-detail.mjs --data <dir> [--profile <dir>] [--budget 500] [--gap 1000] [--dry-run]
//                                          [--raw <dir>] [--log H:\AtlasLogs\eures-employer-detail.log]
//
// Politeness across processes: the EURES host gets at most one request start per --gap ms (default 1000) from this tool and the
// crawl TOGETHER. Both set the shared rate file <data>/eures-rate.json (providers-eures.mjs setEuresRateFile / claimSharedSlot): each
// request start is reserved in that file under a millisecond mutex, one gap after the previous reservation of any process, so the crawl
// and the sweep interleave instead of adding up. That needs --data to be the crawl's data directory. A crawl still running code from
// before the rate file ignores it: run the sweep with --gap 2000 until the crawl is updated (then the two together stay at 1.5 req/s
// at worst, and a 429 still doubles the gap).
//
// Resumable: <data>/eures-employer-detail.json maps employer key -> {name, website, id, tried, status, nace, size, fetched_at, tries,
// next, error}. status: 'ok' (codes found), 'no-code' (document fetched, sectorCodes empty; another vacancy of the employer is tried
// after 30 days), 'gone' (404: the vacancy expired; the next run takes another of the employer's vacancies, or waits 7 days for a new
// one), 'failed' (other error; retried after 1, 7, 30, then every 90 days). 'ok' employers are never fetched again.
// Output: <data>/eures-employer-nace.tsv, rewritten from the state at every save: employer, website, vacancy_id, sector_codes (the
// raw codes, comma-joined), organisation_size_code, fetched_at. Only employer-level fields: no recruiter contact data.
// One instance per data directory: <data>/eures-employer-detail.lock {pid, started}, the same rules as detail-backfill.mjs.
// Observable: a start line (employers, candidates, already done, budget), a progress line every 100 requests or 60 s (done/total, ok,
// failed, codes found, rate, ETA), a result line; all to the log file (flushed per line), the console gets the start and result lines.
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve as pathResolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { euresDetail, euresProfile, nameTokens, setEuresRateFile, tuning } from './providers-eures.mjs';
import { loadProfile, profileDirFromArgs, resolveDataDir } from './profile.mjs';
import { setUserAgent } from './useragent.mjs';
import { installRawCapture, rawCaptureSummary } from './rawcapture.mjs';
import { lockIsActive, nextRetry } from './detail-backfill.mjs';

const SEARCH_PATH = '/jv-searchengine/public/jv-search/search';
const DAY = 864e5;
const NO_CODE_RETRY_DAYS = 30, GONE_WAIT_DAYS = 7;
const MAX_IDS = 5;   // vacancies kept per employer as fallbacks when the chosen one has expired
export const TSV_HEADER = ['employer', 'website', 'vacancy_id', 'sector_codes', 'organisation_size_code', 'fetched_at'];

const clean = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The web site as a host: lowercase, scheme, "www." and everything after the host dropped ("http://www.Go-Simplexx.de/jobs" -> "go-simplexx.de"). */
export function normSite(url) {
  let s = String(url ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\d?\./, '');
  return s.split(/[/?#\s]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
}

/** The employer key: the name's words (nameTokens: case, diacritics, punctuation and connectors do not count) and the site host. '' without a name. */
export function employerKey(name, website) {
  const n = nameTokens(name).join(' ');
  return n ? `${n}|${normSite(website)}` : '';
}

/**
 * The EURES vacancies of the raw store, per employer. lines: index entries ({t, url, status, sha256}); readObject(sha) -> the parsed
 * search response or null. Only 200 responses of the search endpoint are read, each body once (the newest t of a body counts). Returns
 * Map key -> {name, website, ids: [{id, t, lm}] newest first, at most MAX_IDS} and {responses, vacancies, unreadable}.
 */
export function harvestEmployers(lines, readObject) {
  const lastT = new Map();
  for (const e of lines) {
    if (e?.status !== 200 || !String(e.url ?? '').includes(SEARCH_PATH) || !e.sha256) continue;
    if (!lastT.has(e.sha256) || String(e.t) > lastT.get(e.sha256)) lastT.set(e.sha256, String(e.t ?? ''));
  }
  const employers = new Map();
  const stats = { responses: 0, vacancies: 0, unreadable: 0, noName: 0 };
  for (const [sha, t] of lastT) {
    const d = readObject(sha);
    if (!d || !Array.isArray(d.jvs)) { stats.unreadable++; continue; }
    stats.responses++;
    for (const v of d.jvs) {
      if (!v?.id) continue;
      stats.vacancies++;
      const name = clean(v.employer?.name), website = clean(v.employer?.website);
      const key = employerKey(name, website);
      if (!key) { stats.noName++; continue; }
      let emp = employers.get(key);
      if (!emp) employers.set(key, emp = { name, website, ids: [], best: '' });
      const lm = Number(v.lastModificationDate) || 0;
      const have = emp.ids.find((x) => x.id === v.id);
      if (have) { if (t > have.t) have.t = t; if (lm > have.lm) have.lm = lm; } else emp.ids.push({ id: v.id, t, lm });
      const rank = `${t}|${String(lm).padStart(15, '0')}`;
      if (rank > emp.best) { emp.best = rank; emp.name = name; emp.website = website || emp.website; }
    }
  }
  for (const emp of employers.values()) {
    emp.ids.sort((a, b) => b.t.localeCompare(a.t) || b.lm - a.lm);
    emp.ids.length = Math.min(emp.ids.length, MAX_IDS);
    delete emp.best;
  }
  return { employers, stats };
}

/**
 * The work list: one vacancy per employer that is not resolved yet. state: key -> state entry. An 'ok' employer is done; one waiting
 * for its retry (next > now) is skipped; otherwise the first vacancy not tried yet is taken (after a 'gone' or 'no-code' the next one),
 * or, after a plain failure, the same vacancy again. An employer whose vacancies were all tried waits. The newest vacancies come first.
 */
export function planSweep(employers, state = {}, now = Date.now()) {
  const skipped = { done: 0, waiting: 0, exhausted: 0 };
  const queue = [];
  for (const [key, emp] of employers) {
    const st = state[key];
    if (st?.status === 'ok') { skipped.done++; continue; }
    if (st?.next > now) { skipped.waiting++; continue; }
    const tried = new Set(st?.tried ?? []);
    let pick = emp.ids.find((x) => !tried.has(x.id));
    if (!pick && st?.status === 'failed' && st.id) pick = emp.ids.find((x) => x.id === st.id) ?? { id: st.id, t: '', lm: 0 };
    if (!pick) { skipped.exhausted++; continue; }
    queue.push({ key, name: emp.name, website: emp.website, id: pick.id, t: pick.t, lm: pick.lm });
  }
  queue.sort((a, b) => b.t.localeCompare(a.t) || b.lm - a.lm);
  return { queue, skipped };
}

/** The employer fields of a detail document: {sectorCodes, size}. The codes are the raw strings as served ("o78.2.0"). */
export function employerFromDetail(d) {
  const e = euresProfile(d)?.employer ?? {};
  const codes = (Array.isArray(e.sectorCodes) ? e.sectorCodes : e.sectorCodes ? [e.sectorCodes] : []).map((c) => clean(c)).filter(Boolean);
  return { sectorCodes: [...new Set(codes)], size: clean(e.organisationSizeCode) };
}

/** Applies one fetch result to the employer's state entry (a new object). res: {ok, detail} or {ok: false, status, error}. */
export function applyResult(prev, item, res, now = Date.now()) {
  const st = { ...(prev ?? {}), name: item.name, website: item.website, id: item.id, tries: (prev?.tries ?? 0) + 1 };
  st.tried = [...new Set([...(prev?.tried ?? []), ...(res.ok || res.status === 404 ? [item.id] : [])])];
  delete st.error; delete st.next;
  if (res.ok) {
    const { sectorCodes, size } = employerFromDetail(res.detail);
    st.nace = sectorCodes; st.size = size; st.fetched_at = new Date(now).toISOString(); st.tries = 0;
    st.status = sectorCodes.length ? 'ok' : 'no-code';
    if (!sectorCodes.length) st.next = now + NO_CODE_RETRY_DAYS * DAY;
  } else if (res.status === 404) {
    st.status = 'gone'; st.tries = 0; st.error = clean(res.error).slice(0, 160);
    // another captured vacancy of this employer may be tried at once; planSweep waits when there is none
    st.next = now;
    st.goneAt = new Date(now).toISOString();
  } else {
    st.status = 'failed'; st.error = clean(res.error).slice(0, 160); st.next = nextRetry(st.tries, now);
  }
  return st;
}

/** The TSV of the employers with a fetched document ('ok' and 'no-code'), sorted by name. Employer-level fields only. */
export function naceTsv(state) {
  const rows = Object.values(state).filter((s) => s.fetched_at && (s.status === 'ok' || s.status === 'no-code' || s.nace?.length))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return [TSV_HEADER, ...rows.map((s) => [s.name, s.website, s.id, (s.nace ?? []).join(','), s.size ?? '', s.fetched_at])]
    .map((r) => r.map(clean).join('\t')).join('\n') + '\n';
}

/** An employer whose vacancies were all tried waits for new captures: planSweep marks it 'exhausted'; after GONE_WAIT_DAYS its tried list is cleared. */
export function releaseExhausted(employers, state, now = Date.now()) {
  let n = 0;
  for (const [key, emp] of employers) {
    const st = state[key];
    if (!st || st.status === 'ok' || st.status === 'failed') continue;
    const tried = new Set(st.tried ?? []);
    if (emp.ids.some((x) => !tried.has(x.id))) continue;
    if (st.status === 'gone' && Date.parse(st.goneAt ?? 0) + GONE_WAIT_DAYS * DAY > now) { st.next = Date.parse(st.goneAt) + GONE_WAIT_DAYS * DAY; continue; }
    if (st.status === 'no-code' && st.next > now) continue;
    if (st.status === 'gone' || st.status === 'no-code') { st.tried = []; n++; }
  }
  return n;
}

function readIndex(rawDir) {
  const dir = join(rawDir, 'index');
  const out = [];
  let bad = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
    for (const ln of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!ln.includes(SEARCH_PATH)) continue;
      try { out.push(JSON.parse(ln)); } catch { bad++; }
    }
  }
  return { lines: out, bad };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(`--${n}`);
  const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
  const t0 = Date.now();
  const logFile = opt('log', 'H:\\AtlasLogs\\eures-employer-detail.log');
  try { mkdirSync(dirname(logFile), { recursive: true }); } catch { /* reported by the first write */ }
  const log = (m) => { const l = `${new Date().toISOString()} eures-detail: ${m}`; try { appendFileSync(logFile, l + '\n'); } catch (e) { console.error(`eures-detail: cannot write log ${logFile}: ${e.message}`); } return l; };
  const say = (m) => console.log(log(m));   // start, result, errors: log and console
  const fail = (m, code = 2) => { console.error(log(`ERROR ${m}`)); process.exit(code); };

  let PROFILE = null;
  try { PROFILE = loadProfile(profileDirFromArgs(args)); } catch (e) { fail(e.message); }
  setUserAgent(PROFILE?.userAgent);
  if (!opt('data') && !PROFILE) fail('pass --data <crawl data dir> (or --profile with a data dir)');
  const dataDir = resolveDataDir(opt('data'), PROFILE);
  if (!existsSync(dataDir)) fail(`data dir not found: ${dataDir}`);
  const rawDir = opt('raw', process.env.JOBCRAWL_RAW_DIR);
  if (!rawDir || !existsSync(join(rawDir, 'index'))) fail(`no raw store (JOBCRAWL_RAW_DIR or --raw): ${rawDir ?? 'unset'}`);
  process.env.JOBCRAWL_RAW_DIR = rawDir;
  if (!flag('dry-run') && !installRawCapture(rawDir)) fail('the raw capture could not be installed');
  tuning.minGapMs = Math.max(500, Number(opt('gap', tuning.minGapMs)) || 1000);   // never faster than 2 req/s, whatever is passed
  setEuresRateFile(pathResolve(dataDir, 'eures-rate.json'));

  const lockFile = pathResolve(dataDir, 'eures-employer-detail.lock');
  if (existsSync(lockFile)) {
    const content = readFileSync(lockFile, 'utf8');
    if (lockIsActive(content, Date.now())) { say(`another run is active (${content.trim()}), skipping`); return; }
    log(`taking over a stale lock (${content.trim()})`);
  }
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  const releaseLock = () => { try { unlinkSync(lockFile); } catch { /* already gone */ } };
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { log('interrupted (SIGINT); the state was saved at most 30 s before'); process.exit(130); });
  try { await sweep({ flag, opt, t0, say, log, dataDir, rawDir, logFile }); } finally { releaseLock(); }
}

async function sweep({ flag, opt, t0, say, log, dataDir, rawDir, logFile }) {
  const { lines, bad } = readIndex(rawDir);
  const readObject = (sha) => {
    try { return JSON.parse(gunzipSync(readFileSync(join(rawDir, 'objects', sha.slice(0, 2), `${sha}.gz`))).toString('utf8')); } catch { return null; }
  };
  const { employers, stats } = harvestEmployers(lines, readObject);
  const stateFile = pathResolve(dataDir, 'eures-employer-detail.json');
  const tsvFile = pathResolve(dataDir, 'eures-employer-nace.tsv');
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
  const saveState = () => {
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(state)); renameSync(`${stateFile}.tmp`, stateFile);
    writeFileSync(`${tsvFile}.tmp`, naceTsv(state)); renameSync(`${tsvFile}.tmp`, tsvFile);
  };
  const released = releaseExhausted(employers, state);
  const plan = planSweep(employers, state);
  const budget = Math.max(0, Number(opt('budget', 500)) || 0);
  const total = Math.min(budget, plan.queue.length);
  const eta = (n) => { const m = n * tuning.minGapMs / 60e3; return m < 90 ? `${m.toFixed(1)} min` : `${(m / 60).toFixed(1)} h`; };
  say(`start: raw store ${rawDir}: ${lines.length} search index lines (${bad} unreadable), ${stats.responses} responses, ${stats.vacancies} vacancies `
    + `(${stats.noName} without employer), ${employers.size} employers; state ${Object.keys(state).length} (${plan.skipped.done} done, `
    + `${plan.skipped.waiting} waiting, ${plan.skipped.exhausted} without an untried vacancy, ${released} released); candidates ${plan.queue.length}; `
    + `budget ${budget}, gap ${tuning.minGapMs} ms shared via ${pathResolve(dataDir, 'eures-rate.json')}, at least ${eta(total)} for this run; log ${logFile}`);
  if (flag('dry-run') || !total) {
    for (const q of plan.queue.slice(0, 5)) log(`dry run: would fetch ${q.id} for "${q.name}" (${q.website || 'no site'})`);
    say(`result: ${flag('dry-run') ? 'dry run, ' : ''}nothing fetched${plan.queue.length ? '' : ' (queue empty)'}; the whole queue takes at least ${eta(plan.queue.length)}`);
    return;
  }

  let done = 0, ok = 0, noCode = 0, gone = 0, failed = 0, lastSave = Date.now(), lastProgress = Date.now();
  const sizes = {};
  const progress = () => {
    const dt = (Date.now() - t0) / 1000, rate = done / Math.max(dt, 1e-3);
    log(`progress: ${done}/${total} requests, ${ok} with NACE, ${noCode} without, ${gone} gone, ${failed} failed; ${dt.toFixed(0)} s, ${rate.toFixed(2)} req/s, ETA ${((total - done) / Math.max(rate, 1e-3) / 60).toFixed(1)} min`);
    lastProgress = Date.now();
  };
  for (const item of plan.queue.slice(0, total)) {
    let res;
    try { res = { ok: true, detail: await euresDetail(item.id) }; } catch (e) {
      const status = Number(/HTTP (\d{3})/.exec(e.message ?? '')?.[1]) || 0;
      res = { ok: false, status, error: e.message ?? String(e) };
    }
    const st = applyResult(state[item.key], item, res);
    state[item.key] = st;
    done++;
    if (st.status === 'ok') { ok++; sizes[st.size || '-'] = (sizes[st.size || '-'] ?? 0) + 1; }
    else if (st.status === 'no-code') noCode++;
    else if (st.status === 'gone') { gone++; log(`gone: ${item.id} "${item.name}": ${st.error}`); }
    else { failed++; log(`failed: ${item.id} "${item.name}": ${st.error} (try ${st.tries}, next ${new Date(st.next).toISOString().slice(0, 10)})`); }
    if (Date.now() - lastSave > 30e3) { saveState(); lastSave = Date.now(); }
    if (done % 100 === 0 || Date.now() - lastProgress >= 60e3) { saveState(); lastSave = Date.now(); progress(); }
  }
  saveState();
  const left = plan.queue.length - total;
  say(`result: ${done} requests in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${ok} with NACE, ${noCode} without, ${gone} gone (404), ${failed} failed; `
    + `size codes ${JSON.stringify(sizes)}; ${left} employers left (at least ${eta(left)}); TSV ${tsvFile}; ${rawCaptureSummary()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`eures-detail: FAILED ${e.stack ?? e.message}`); process.exit(1); });
}
