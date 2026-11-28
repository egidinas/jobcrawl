#!/usr/bin/env node
// Live shadow of the resolver job (row 1.4) beside the legacy crawl cycle. SHADOW ONLY: nothing reads its output, and it writes only
// inside --out (it owns that folder); the legacy crawl state is read and copied, never written.
//
//   node --no-warnings scripts/resolver-shadow.mjs --src <legacy scan dir> --code <crawl code tree> --overlay <companies overlay> \
//        --summary <last-summary.txt> --out <shadow dir> [--shadow <JSON shadow store>] [--force] [--min-age <s>]
//
// One run = at most one legacy cycle. The cycle is "new" when --summary changed since the last handled one (the crawl step writes it when
// the scan state is final). The run
//   1. copies the legacy state (scan-history.tsv, simhash cache, admit-state, lifecycle state, title release, companies, catalogue and the
//      saved descriptions of aggregator rows) into <out>/legacy; a state that changed under the copy is copied again, else the run is skipped;
//   2. first run only: the baseline epoch (every open/dup row, per board, imported without events; the legacy verdicts are adopted) and the
//      list of every url the history holds. A posting is part of the COHORT only when its url is not in that list: first seen after the start;
//   3. every board whose set of open/dup rows changed since the last cycle is read once (a complete answer built from the legacy rows, as
//      resolver-replay.mjs does; no request to any employer), then one resolver run (the sweeps on);
//   4. compares, for the cohort: duplicates (legacy dup vs resolved dup) and admission (legacy admit-state boards vs the resolver's), at the
//      cycle in which a url first appears ("first sight") and as of now ("cumulative"); writes compare/<cycle>.json and summary.txt.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openSqliteStore } from '../core/state/sqlite-store.mjs';
import { jsonStore } from '../core/state/store.mjs';
import { runBoardOn } from '../core/run-board.mjs';
import { LEGACY_RULES } from '../core/delta/board-delta.mjs';
import { postingId } from '../core/id.mjs';
import { runResolver, resolvedGroups } from '../core/resolve/resolver.mjs';
import { legacyFacts, readHistory } from '../core/resolve/facts.mjs';
import { isAggregatorEntry, isAggregatorRow } from '../crawler/crosslist.mjs';
import { boardOfCompany } from '../crawler/admission.mjs';
import { loadCatalogueNames } from '../crawler/relevance.mjs';
import { jdFileName } from '../crawler/jdclean.mjs';
import { providers } from '../crawler/providers.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const flag = (n) => argv.includes(`--${n}`);
if (!argv.length || flag('help')) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 17).join('\n')); process.exit(0); }
const need = (n) => opt(n) ?? (console.error(`--${n} is required`), process.exit(2));
const SRC = pathResolve(need('src')), CODE = pathResolve(need('code')), SUMMARY = pathResolve(need('summary')), OUT = pathResolve(need('out'));
const OVERLAY = opt('overlay') ? pathResolve(opt('overlay')) : null;
const SHADOW = opt('shadow') ? pathResolve(opt('shadow')) : null;
const MIN_AGE_S = Number(opt('min-age', 60));
const LEG = join(OUT, 'legacy');
for (const d of [OUT, LEG, join(LEG, 'lifecycle'), join(LEG, 'jd'), join(OUT, 'compare')]) mkdirSync(d, { recursive: true });
if (SRC === OUT || OUT.startsWith(SRC + '/')) { console.error('--out must not be inside --src'); process.exit(2); }

// ---- heartbeat log ----
const HB = join(OUT, 'heartbeat.log');
try { if (statSync(HB).size > 5e6) renameSync(HB, HB + '.1'); } catch { /* none yet */ }
const t0 = Date.now();
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; appendFileSync(HB, line + '\n'); console.error(line); };
const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

const db = new DatabaseSync(join(OUT, 'shadow.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS known (url TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS board_sig (board TEXT PRIMARY KEY, sig TEXT);
CREATE TABLE IF NOT EXISTS cohort (url TEXT PRIMARY KEY, cycle TEXT, board TEXT, company TEXT, title TEXT, first_day TEXT, first_legacy TEXT, first_resolver TEXT, first_adm_legacy TEXT, first_adm_resolver TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cycles (cycle TEXT PRIMARY KEY, at TEXT, body TEXT);`);
const getMeta = (k, d = null) => { const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k); return r ? JSON.parse(r.v) : d; };
const setMeta = (k, v) => db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));

// ---- is there a new legacy cycle? ----
let sumStat;
try { sumStat = statSync(SUMMARY); } catch { log(`skip: ${SUMMARY} does not exist`); process.exit(0); }
const marker = Math.round(sumStat.mtimeMs);
if (!flag('force')) {
  if (marker === getMeta('marker')) { log('skip: no new cycle since the last handled one'); process.exit(0); }
  if (Date.now() - marker < MIN_AGE_S * 1000) { log(`skip: the cycle summary is ${Math.round((Date.now() - marker) / 1000)} s old (< ${MIN_AGE_S} s); next poll`); process.exit(0); }
}
const cycle = new Date(marker).toISOString().slice(0, 16).replace(':', '-') + 'Z';
log(`start cycle ${cycle} (summary ${new Date(marker).toISOString()}): ${readFileSync(SUMMARY, 'utf8').trim().slice(0, 160)}`);

// ---- 1. copy the legacy state (read-only on the source) ----
const FILES = [['scan-history.tsv', 'scan-history.tsv'], ['simhash-cache.v2.json', 'simhash-cache.v2.json'], ['admit-state.json', 'admit-state.json'],
  ['lifecycle/state.json', 'lifecycle/state.json'], ['title-released.tsv', 'title-released.tsv']];
const EXTRA = [[join(CODE, 'crawler', 'companies.json'), 'companies.json'], [join(CODE, 'site', 'content', 'companies.json'), 'catalogue.json']];
if (OVERLAY) EXTRA.push([OVERLAY, 'companies_overlay.json']);
const sig = (f) => { try { const s = statSync(f); return `${s.size}:${Math.round(s.mtimeMs)}`; } catch { return 'none'; } };
const jobs = [...FILES.map(([a, b]) => [join(SRC, a), join(LEG, b)]), ...EXTRA.map(([a, b]) => [a, join(LEG, b)])];
let copied = false;
for (let attempt = 1; attempt <= 3 && !copied; attempt++) {
  const before = jobs.map(([a]) => sig(a));
  for (const [a, b] of jobs) { if (!existsSync(a)) { if (/history|admit|lifecycle/.test(a)) throw new Error(`legacy file missing: ${a}`); continue; } copyFileSync(a, b + '.tmp'); renameSync(b + '.tmp', b); }
  const after = jobs.map(([a]) => sig(a));
  if (JSON.stringify(before) === JSON.stringify(after)) copied = true;
  else log(`legacy state changed under the copy (attempt ${attempt}); copying again`);
}
if (!copied) { log('skip: the legacy state kept changing during the copy; the cycle is not handled (marker not advanced)'); process.exit(0); }
log(`copied ${jobs.length} legacy files in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// ---- parse (the model is resolver-replay.mjs's: every open/dup history row is a listing of the board that last listed it) ----
const companies = [...(readJson(join(LEG, 'companies.json'))?.tracked_companies ?? []), ...(readJson(join(LEG, 'companies_overlay.json'))?.tracked_companies ?? [])];
const seenNames = new Set();
const registry = companies.filter((c) => c?.name && !seenNames.has(c.name) && seenNames.add(c.name));
const boardNames = new Set(registry.filter(isAggregatorEntry).map((c) => c.name));
const registryNames = new Set(registry.map((c) => c.name));
const history = readHistory(join(LEG, 'scan-history.tsv'));
const rows = [...history.values()].filter((r) => r.status === 'open' || r.status === 'dup');
const admit = readJson(join(LEG, 'admit-state.json'));
const T0 = Date.parse(admit.at);
const T0day = new Date(T0).toISOString().slice(0, 10);
const lc = readJson(join(LEG, 'lifecycle', 'state.json'), {}).urls ?? {};
const catalogue = loadCatalogueNames(existsSync(join(LEG, 'catalogue.json')) ? join(LEG, 'catalogue.json') : null);
const released = new Map();
if (existsSync(join(LEG, 'title-released.tsv'))) for (const l of readFileSync(join(LEG, 'title-released.tsv'), 'utf8').split('\n').slice(1)) { const [u, d] = l.split('\t'); if (u && d) released.set(u, d); }
log(`parsed: ${history.size} history rows, ${rows.length} open/dup, ${registry.length} registry entries (${boardNames.size} aggregator boards), ${Object.keys(lc).length} lifecycle urls, legacy at ${admit.at}`);

// saved descriptions of aggregator rows (apply links): copy the missing or newer ones
let jdCopied = 0;
for (const r of rows) {
  if (!isAggregatorRow(r, boardNames)) continue;
  const n = jdFileName(r.url), a = join(SRC, 'jd', n), b = join(LEG, 'jd', n);
  try { if (!existsSync(b) || statSync(a).mtimeMs > statSync(b).mtimeMs) { copyFileSync(a, b); jdCopied++; } } catch { /* no saved description */ }
}
if (jdCopied) log(`copied ${jdCopied} saved descriptions`);

// listings: board -> [{ url, row, from, idx }]
const listings = new Map();
const add = (board, l) => (listings.get(board) ?? listings.set(board, []).get(board)).push(l);
let companyBoardExtra = 0;
rows.forEach((row, idx) => {
  const lcBoard = lc[row.url]?.[0];
  const cBoard = boardOfCompany(row.company);
  const l = { url: row.url, title: row.title, location: row.location, posted: row.posted, idx };
  add(lcBoard || cBoard, l);
  if (lcBoard && lcBoard !== cBoard && boardNames.has(lcBoard) && registryNames.has(cBoard) && !boardNames.has(cBoard)) { add(cBoard, { ...l, idx: idx + 0.5 }); companyBoardExtra++; }
});
let shadowExtra = 0;
if (SHADOW && existsSync(join(SHADOW, 'boards'))) {
  for (const d of readdirSync(join(SHADOW, 'boards'))) {
    const st = readJson(join(SHADOW, 'boards', d, 'state.json'));
    if (!st?.board) continue;
    const have = new Set((listings.get(st.board) ?? []).map((l) => l.url));
    for (const p of Object.values(st.postings ?? {})) {
      if (p.status !== 'open' || have.has(p.url) || T0 - Date.parse(p.last_seen) >= 48 * 3600e3) continue;
      const row = history.get(p.url);
      if (!row || (row.status !== 'open' && row.status !== 'dup')) continue;
      add(st.board, { url: p.url, title: row.title, location: row.location, posted: row.posted, idx: rows.length + shadowExtra++ });
    }
  }
}
log(`listings: ${listings.size} boards, ${companyBoardExtra} employer-board and ${shadowExtra} second-board listings`);

// facts: the fingerprint counts at arrival only for providers whose list answer carries the description (the legacy crawl's rule);
// a later refresh sees the current cache. Same rules as the replay's default.
const INLINE = new Set([...Object.entries(providers).filter(([, v]) => !v.fetchDescription && /description/i.test(String(v.fetch))).map(([k]) => k), 'sitemap', 'jsonld_direct']);
const providerOfBoard = new Map(registry.map((c) => [c.name, c.provider ?? null]));
const fpWhen = (row, board, t, op) => (op === 'refresh' ? true : INLINE.has(providerOfBoard.get(board)));
const SHADOWED = { kept: false, hide: 'filtered' }, EXTRA_HIDE = { kept: false, hide: 'extra' };
const keptFor = (row, board, t) => {
  if (boardNames.has(board) && !/\(via /i.test(row.company ?? '') && registryNames.has(boardOfCompany(row.company)) && board !== boardOfCompany(row.company)) return SHADOWED;
  const rel = released.get(row.url);
  if (rel && t && String(t).slice(0, 10) < rel && rel > (row.first_seen || T0day)) return EXTRA_HIDE;
  return null;
};
const facts = legacyFacts(LEG, { history, isAggregator: (row) => isAggregatorRow(row, boardNames), fpWhen, keptFor });
const config = { companies: registry, catalogue, rules: 'legacy' };
const itemsOf = (ls) => [...ls].sort((a, b) => a.idx - b.idx).map((l) => ({ url: l.url, title: l.title, location: l.location, postedAt: l.posted }));
const sigOf = (ls) => `${ls.length}:${createHash('sha1').update(ls.map((l) => l.url).sort().join('\n')).digest('hex').slice(0, 16)}`;

const store = await openSqliteStore(join(OUT, 'store'));
const lastT = getMeta('last_t', 0);
const T = Math.max(T0, lastT + 1000);   // the resolver's clock never runs back
const firstRun = getMeta('baseline') == null;
let runs = 0, fedBoards = 0;
let known;
if (firstRun) {
  // ---- 2. baseline epoch: import without events, legacy verdicts adopted at the resolver's first run ----
  const tmpJson = join(OUT, 'baseline-json');
  rmSync(tmpJson, { recursive: true, force: true });   // our own folder
  const js = jsonStore(tmpJson);
  let k = 0;
  for (const [board, ls] of listings) {
    await runBoardOn(js, { name: board }, { read: { ok: true, items: itemsOf(ls), complete: true, emptyOk: true }, now: () => new Date(T - 3600e3 + (k++) * 50), rules: LEGACY_RULES });
    if (k % 500 === 0) log(`baseline: ${k}/${listings.size} boards`);
  }
  const imp = store.importJson(tmpJson, { log: () => {} });
  rmSync(tmpJson, { recursive: true, force: true });
  log(`baseline: imported ${listings.size} boards (${JSON.stringify(imp).slice(0, 120)})`);
  db.exec('BEGIN');
  const ins = db.prepare('INSERT OR IGNORE INTO known (url) VALUES (?)');
  for (const u of history.keys()) ins.run(u);
  const sg = db.prepare('INSERT OR REPLACE INTO board_sig (board, sig) VALUES (?, ?)');
  for (const [b, ls] of listings) sg.run(b, sigOf(ls));
  db.exec('COMMIT');
  setMeta('baseline', { at: new Date(T).toISOString(), cycle, urls: history.size, rows: rows.length });
  known = new Set(history.keys());
  log(`baseline: ${history.size} urls recorded as known; the cohort is every url not among them`);
} else {
  // ---- 3. feed the boards whose listing changed ----
  known = new Set(db.prepare('SELECT url FROM known').all().map((r) => r.url));
  const sigs = new Map(db.prepare('SELECT board, sig FROM board_sig').all().map((r) => [r.board, r.sig]));
  const due = [...listings].map(([b, ls]) => [b, ls, sigOf(ls)]).filter(([b, , s]) => sigs.get(b) !== s);
  // boards that lost all their rows still need a (complete, empty) read
  for (const b of sigs.keys()) if (!listings.has(b)) due.push([b, [], 'empty']);
  due.sort((a, b) => Math.min(...(a[1].length ? a[1].map((l) => l.idx) : [-1])) - Math.min(...(b[1].length ? b[1].map((l) => l.idx) : [-1])));
  let k = 0;
  for (const [board, ls, s] of due) {
    await runBoardOn(store, { name: board }, { read: { ok: true, items: itemsOf(ls), complete: true, emptyOk: true }, now: () => new Date(T - 60e3 + (k++) * 10), rules: LEGACY_RULES });
    if (s === 'empty') db.prepare('DELETE FROM board_sig WHERE board = ?').run(board); else db.prepare('INSERT OR REPLACE INTO board_sig (board, sig) VALUES (?, ?)').run(board, s);
    runs++;
  }
  fedBoards = due.length;
  log(`fed ${fedBoards} changed boards of ${listings.size}`);
}

// ---- resolver ----
const tr = Date.now();
const rr = await runResolver(store, { facts, config, now: () => new Date(T), batch: 20000, tickAtEnd: true, log: (m) => log(m.slice(0, 200)) });
if (rr.skipped) { log(`resolver skipped: ${rr.skipped}`); store.close(); db.close(); process.exit(0); }
setMeta('last_t', T);
log(`resolver: ${rr.applied} records applied, ${rr.records} resolved records, seq ${rr.seq} in ${((Date.now() - tr) / 1000).toFixed(1)} s`);

// ---- 4. cohort and comparison ----
const groups = new Map(resolvedGroups(store).map((g) => [g.id, g]));
const gOf = (u) => groups.get(postingId(u));
const idToUrl = new Map(rows.map((r) => [postingId(r.url), r.url]));
const admBoards = (u, now = T) => {
  const L = (admit.urls?.[u] ?? []).filter(([, t]) => now - t < 48 * 3600e3).map(([bi]) => admit.boards[bi]).sort();
  const R = Object.entries(gOf(u)?.adm ?? {}).filter(([, t]) => now - t < 48 * 3600e3).map(([b]) => b).sort();
  return { L, R, inAdmit: Boolean(admit.urls?.[u]) };
};
const newUrls = firstRun ? [] : [...history.keys()].filter((u) => !known.has(u));
if (newUrls.length) {
  db.exec('BEGIN');
  const ic = db.prepare('INSERT OR IGNORE INTO cohort (url, cycle, board, company, title, first_day, first_legacy, first_resolver, first_adm_legacy, first_adm_resolver) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const ik = db.prepare('INSERT OR IGNORE INTO known (url) VALUES (?)');
  for (const u of newUrls) {
    const r = history.get(u), g = gOf(u), a = admBoards(u);
    ic.run(u, cycle, lc[u]?.[0] ?? boardOfCompany(r.company), r.company ?? '', r.title ?? '', r.first_seen ?? '', r.status, g?.status ?? 'missing', a.inAdmit ? a.L.join('|') : null, a.inAdmit ? a.R.join('|') : null);
    ik.run(u);
  }
  db.exec('COMMIT');
}

const classify = (L, R) => {
  if (L !== 'open' && L !== 'dup') return 'not_listed';          // legacy filtered/extra/gone: the resolver is not asked
  if (L === 'dup' && R === 'dup') return 'both_dup';
  if (L === 'open' && R === 'dup') return 'extra';
  if (L === 'dup') return 'missed';
  return R === 'open' ? 'both_open' : 'open_other';
};
const tally = (pairs) => {
  const c = { both_dup: 0, extra: 0, missed: 0, both_open: 0, open_other: 0, not_listed: 0 };
  for (const [L, R] of pairs) c[classify(L, R)]++;
  const dl = c.both_dup + c.missed, dr = c.both_dup + c.extra;
  const listed = c.both_dup + c.extra + c.missed + c.both_open + c.open_other;
  return { urls: pairs.length, ...c, legacy_dup: dl, resolver_dup: dr,
    dup_recall_pct: dl ? +(c.both_dup / dl * 100).toFixed(1) : null, dup_precision_pct: dr ? +(c.both_dup / dr * 100).toFixed(1) : null,
    agree_pct: listed ? +((c.both_dup + c.both_open) / listed * 100).toFixed(1) : null };
};
const ex = (u, more = {}) => { const r = history.get(u) ?? {}; return { url: u, company: r.company, title: r.title, first_seen_day: r.first_seen, ...more }; };
const examples = { extra: [], missed: [], admission: [] };
const keep = (arr, e) => { if (arr.length < 5) arr.push(e); };
const cohort = db.prepare('SELECT * FROM cohort').all();
const cur = cohort.map((c) => { const L = history.get(c.url)?.status ?? 'gone', g = gOf(c.url); return { ...c, L, R: g?.status ?? 'missing', g }; });
for (const c of cur) {
  const k = classify(c.L, c.R);
  if (k === 'extra') keep(examples.extra, ex(c.url, { cycle: c.cycle, legacy: c.L, resolver: c.R, dup_of: idToUrl.get(c.g?.dup_of) ?? c.g?.dup_of ?? null }));
  if (k === 'missed') keep(examples.missed, ex(c.url, { cycle: c.cycle, legacy: c.L, resolver: c.R }));
}
const thisCycle = cur.filter((c) => c.cycle === cycle);
const admTally = (list) => {
  let compared = 0, equal = 0; const classes = {};
  for (const c of list) {
    const a = admBoards(c.url);
    if (!a.inAdmit) continue;
    compared++;
    if (JSON.stringify(a.L) === JSON.stringify(a.R)) { equal++; continue; }
    const kind = !a.L.length ? 'legacy_none' : !a.R.length ? 'resolver_none' : a.R.every((b) => a.L.includes(b)) ? 'resolver_subset' : 'differs';
    classes[kind] = (classes[kind] ?? 0) + 1;
    keep(examples.admission, ex(c.url, { cycle: c.cycle, legacy: a.L, resolver: a.R }));
  }
  return { compared, equal, agree_pct: compared ? +(equal / compared * 100).toFixed(1) : null, classes };
};
const report = {
  schema: 'resolver-shadow/v1', cycle, summary_at: new Date(marker).toISOString(), legacy_at: admit.at, resolver_t: new Date(T).toISOString(),
  shadow_started: getMeta('baseline'), first_run: firstRun,
  legacy_cycle: readFileSync(SUMMARY, 'utf8').trim().slice(0, 300),
  fed_boards: fedBoards, boards: listings.size, history_rows: history.size, open_dup_rows: rows.length,
  resolver: { applied: rr.applied, resolved_records: rr.records, seq: rr.seq, stats: rr.stats },
  new_urls: newUrls.length,
  first_sight: { note: 'urls first seen this cycle: the legacy status in this cycle against the resolver verdict of this cycle', dup: tally(thisCycle.map((c) => [c.first_legacy, c.first_resolver])), admission: admTally(thisCycle) },
  cumulative: { note: 'every cohort url (first seen after the shadow started): legacy status and resolver verdict as of now', cohort_urls: cohort.length, dup: tally(cur.map((c) => [c.L, c.R])), admission: admTally(cur) },
  examples, seconds: +((Date.now() - t0) / 1000).toFixed(1),
};
writeFileSync(join(OUT, 'compare', `${cycle}.json`), JSON.stringify(report, null, 1) + '\n');
db.prepare('INSERT OR REPLACE INTO cycles (cycle, at, body) VALUES (?, ?, ?)').run(cycle, report.summary_at, JSON.stringify({ new_urls: report.new_urls, fed: fedBoards, fs: report.first_sight, cum: report.cumulative, first_run: firstRun }));

// ---- summary.txt (rolling) ----
const pct = (x) => (x == null ? '   - ' : String(x.toFixed ? x.toFixed(1) : x).padStart(5));
const hist = db.prepare('SELECT cycle, body FROM cycles ORDER BY cycle DESC LIMIT 96').all().reverse().map((r) => ({ cycle: r.cycle, ...JSON.parse(r.body) }));
const lines = [];
lines.push(`resolver shadow (jobcrawl row 1.4): updated ${new Date().toISOString()}; shadow started ${getMeta('baseline')?.at} (cycle ${getMeta('baseline')?.cycle})`);
lines.push('Counted: only urls first seen after the shadow started (the cohort). Legacy dup = the legacy crawl marked the row dup; resolver dup = the resolver\'s group is dup.');
lines.push('  first-sight columns (per cycle): new = new urls this cycle; ldup = legacy dups among them; both = also resolver dup; extra = resolver dup, legacy open;');
lines.push('  miss = legacy dup, resolver not dup; agr% = share of listed urls with the same verdict; adm% = admission agreement (urls in admit-state).');
lines.push('  cumulative columns: the whole cohort as of this cycle (late descriptions and the 3-day sweep have then had their say): coh = cohort size, rec% = both/legacy dup, prec% = both/resolver dup.');
lines.push('  A cycle with new=0 has nothing to compare; judge by the cumulative columns once ldup (cumulative) is in the hundreds. rec%/prec% near the replay (recent window 91/138 recall) = no regression.');
lines.push('');
lines.push('cycle(UTC)         new ldup both extra miss  agr%  adm% |   coh  ldup  both extra miss  rec% prec%  agr%  adm%');
let sumNew = 0;
for (const h of hist) {
  const f = h.fs.dup, c = h.cum.dup;
  sumNew += h.new_urls;
  lines.push(`${h.cycle.padEnd(17)} ${String(h.new_urls).padStart(4)} ${String(f.legacy_dup).padStart(4)} ${String(f.both_dup).padStart(4)} ${String(f.extra).padStart(5)} ${String(f.missed).padStart(4)} ${pct(f.agree_pct)} ${pct(h.fs.admission.agree_pct)} | ${String(h.cum.cohort_urls).padStart(5)} ${String(c.legacy_dup).padStart(5)} ${String(c.both_dup).padStart(4)} ${String(c.extra).padStart(5)} ${String(c.missed).padStart(4)} ${pct(c.dup_recall_pct)} ${pct(c.dup_precision_pct)} ${pct(c.agree_pct)} ${pct(h.cum.admission.agree_pct)}${h.first_run ? '  (baseline)' : ''}`);
}
const cc = report.cumulative;
lines.push('');
lines.push(`now: cohort ${cc.cohort_urls} urls; legacy dup ${cc.dup.legacy_dup}, both ${cc.dup.both_dup}, extra ${cc.dup.extra}, missed ${cc.dup.missed}; recall ${cc.dup.dup_recall_pct ?? '-'} %, precision ${cc.dup.dup_precision_pct ?? '-'} %; verdict agreement ${cc.dup.agree_pct ?? '-'} %; admission ${cc.admission.equal}/${cc.admission.compared} (${cc.admission.agree_pct ?? '-'} %)`);
lines.push(`latest examples: compare/${cycle}.json (examples.extra, examples.missed, examples.admission)`);
writeFileSync(join(OUT, 'summary.txt.tmp'), lines.join('\n') + '\n');
renameSync(join(OUT, 'summary.txt.tmp'), join(OUT, 'summary.txt'));

setMeta('marker', marker);
log(`done cycle ${cycle}: ${newUrls.length} new urls; cohort ${cc.cohort_urls}; cumulative dup both ${cc.dup.both_dup} extra ${cc.dup.extra} missed ${cc.dup.missed}; admission ${cc.admission.equal}/${cc.admission.compared}; ${report.seconds} s; rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
store.close();
db.close();
void dirname;
