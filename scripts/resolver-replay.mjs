#!/usr/bin/env node
// Replay acceptance for the resolver job (row 1.4): today's legacy history, replayed in arrival order through the per-board path into a
// fresh SQLite store, resolved, and compared with the legacy crawl's own verdicts. Read-only on the legacy side: point it at a COPY.
//
//   node scripts/resolver-replay.mjs --legacy <copy of the crawl data folder> --out <new work folder> [--shadow <copy of a JSON shadow
//        store>] [--log <file>] [--report <file>]
//   node scripts/resolver-replay.mjs --legacy <dir> --list-jd      the jd/ file names the replay reads (aggregator open/dup rows), for a copy
//
// Inputs in --legacy: scan-history.tsv, simhash-cache.v2.json, admit-state.json, lifecycle/state.json, companies.json (+ companies_overlay.json),
// catalogue.json (optional), jd/ (optional; apply links of aggregator rows).
// Model. Every history row with legacy status open or dup is a listing of the board that last listed it (lifecycle state), else of the board
// its company names, from its first_seen day to the copy's time; a JSON shadow store adds the listings of its boards (a second board on
// the same URL: the only multi-board observations available). Per day, every board with new listings is read once (complete answer, the
// legacy departure rule) in the order of its first new row in the history file; the resolver runs after each day. At the end every board
// is read once at the copy's time and the resolver runs with the sweep on. Compared: dup (legacy dup vs resolved dup), admission
// (admit-state.json boards per URL vs the resolver's fresh admissions), protected set (legacy relevance.mjs over the history and config).
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';
import { openSqliteStore, SQLITE_FILE } from '../core/state/sqlite-store.mjs';
import { runBoardOn } from '../core/run-board.mjs';
import { LEGACY_RULES } from '../core/delta/board-delta.mjs';
import { postingId } from '../core/id.mjs';
import { runResolver, resolvedGroups, derivedSet, resolvedRecords } from '../core/resolve/resolver.mjs';
import { legacyFacts, readHistory } from '../core/resolve/facts.mjs';
import { isAggregatorEntry, isAggregatorRow, isCrossListing, canonCompany } from '../crawler/crosslist.mjs';
import { boardOfCompany } from '../crawler/admission.mjs';
import { protectedFromHistory, loadCatalogueNames, makeEmployerIndex, INDUSTRY_AGGREGATOR_PROVIDERS } from '../crawler/relevance.mjs';
import { jdFileName } from '../crawler/jdclean.mjs';
import { providers } from '../crawler/providers.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const flag = (n) => argv.includes(`--${n}`);
if (!argv.length || flag('help')) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 12).join('\n')); process.exit(0); }
const LEG = pathResolve(opt('legacy') ?? (console.error('--legacy <dir> is required'), process.exit(2)));
const t0 = Date.now();
const logFile = opt('log');
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; if (logFile) appendFileSync(logFile, line + '\n'); console.error(line); };

const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const companies = [...(readJson(join(LEG, 'companies.json'))?.tracked_companies ?? []), ...(readJson(join(LEG, 'companies_overlay.json'))?.tracked_companies ?? [])];
const seenNames = new Set();
const registry = companies.filter((c) => c?.name && !seenNames.has(c.name) && seenNames.add(c.name));
const boardNames = new Set(registry.filter(isAggregatorEntry).map((c) => c.name));
const history = readHistory(join(LEG, 'scan-history.tsv'));
const rows = [...history.values()].filter((r) => r.status === 'open' || r.status === 'dup');

if (flag('list-jd')) {
  for (const r of rows) if (isAggregatorRow(r, boardNames)) process.stdout.write(jdFileName(r.url) + '\n');
  process.exit(0);
}
const OUT = pathResolve(opt('out') ?? (console.error('--out <dir> is required'), process.exit(2)));
if (existsSync(join(OUT, SQLITE_FILE))) { console.error(`${OUT} already holds a store: use a new folder`); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const admit = readJson(join(LEG, 'admit-state.json'));
const T0 = Date.parse(admit.at);
const T0day = new Date(T0).toISOString().slice(0, 10);
const lc = readJson(join(LEG, 'lifecycle', 'state.json'), {}).urls ?? {};
const catalogue = loadCatalogueNames(existsSync(join(LEG, 'catalogue.json')) ? join(LEG, 'catalogue.json') : null);
log(`start: legacy ${LEG} at ${admit.at}; ${history.size} history rows, ${rows.length} open/dup; ${registry.length} registry entries (${boardNames.size} aggregator boards); ${Object.keys(lc).length} lifecycle urls; out ${OUT}`);

// ---- listings: board -> [{ url, row, from, idx }] ----
const listings = new Map();
const add = (board, l) => (listings.get(board) ?? listings.set(board, []).get(board)).push(l);
// The board that last listed the row (lifecycle state) and the board its company names: when the last lister is an aggregator board that
// lists the employer's own URL, the employer's board lists it too (the legacy admission seed and the "shadowed by the employer ATS" verdict)
const registryNames = new Set(registry.map((c) => c.name));
// title release (crawl.mjs loadTitleRelease, <data>/title-released.tsv url -> day): such a row was a title-only 'extra' row until that day
// and then turned open without a cross-listing check; replayed as a hidden listing whose verdict changes on that day (a 'changed' record)
const released = new Map();
if (existsSync(join(LEG, 'title-released.tsv'))) for (const l of readFileSync(join(LEG, 'title-released.tsv'), 'utf8').split('\n').slice(1)) { const [u, d] = l.split('\t'); if (u && d) released.set(u, d); }
let companyBoardExtra = 0;
rows.forEach((row, idx) => {
  const lcBoard = lc[row.url]?.[0];
  const cBoard = boardOfCompany(row.company);
  const board = lcBoard || cBoard;
  const rel = released.get(row.url);
  add(board, { url: row.url, title: row.title, location: row.location, posted: row.posted, from: row.first_seen || T0day, idx, rel: rel && rel > (row.first_seen || T0day) ? rel : undefined });
  if (lcBoard && lcBoard !== cBoard && boardNames.has(lcBoard) && registryNames.has(cBoard) && !boardNames.has(cBoard)) {
    add(cBoard, { url: row.url, title: row.title, location: row.location, posted: row.posted, from: row.first_seen || T0day, idx: idx + 0.5, rel: rel && rel > (row.first_seen || T0day) ? rel : undefined });
    companyBoardExtra++;
  }
});
let shadowExtra = 0;
const SH = opt('shadow');
if (SH) {
  for (const d of readdirSync(join(SH, 'boards'))) {
    const st = readJson(join(SH, 'boards', d, 'state.json'));
    if (!st?.board) continue;
    const have = new Set((listings.get(st.board) ?? []).map((l) => l.url));
    for (const p of Object.values(st.postings ?? {})) {
      if (p.status !== 'open' || have.has(p.url) || T0 - Date.parse(p.last_seen) >= 48 * 3600e3) continue;
      const row = history.get(p.url);
      if (!row || (row.status !== 'open' && row.status !== 'dup')) continue;   // a second board on a URL the replay holds
      add(st.board, { url: p.url, title: row.title, location: row.location, posted: row.posted, from: row.first_seen || T0day, idx: rows.length + shadowExtra, rel: released.get(p.url) > (row.first_seen || T0day) ? released.get(p.url) : undefined });
      shadowExtra++;
    }
  }
}
log(`listings: ${listings.size} boards, ${rows.length} history listings + ${companyBoardExtra} employer-board listings of URLs an aggregator board listed last + ${shadowExtra} second-board listings from the shadow store`);

// --fp arrival (default): the fingerprint counts only for boards whose provider returns the description in its list answer (no
// fetchDescription): the legacy crawl matched a new row on that text only; descriptions read later never re-match a direct row.
// --fp cache: every fingerprint the legacy cache holds today.
const FP_MODE = opt('fp', 'arrival');
// Proxy for "the list answer carries the description": providers without fetchDescription whose fetch maps a description field, plus
// the JSON-LD readers (sitemap, jsonld_direct). Others (softgarden widgets, Workday lists, ...) get their text later (lazy or page read).
const INLINE = new Set([...Object.entries(providers).filter(([, v]) => !v.fetchDescription && /description/i.test(String(v.fetch))).map(([k]) => k), 'sitemap', 'jsonld_direct']);
const providerOfBoard = new Map(registry.map((c) => [c.name, c.provider ?? null]));
// a description saved after the listing (lazy or page read) is known from the next cycle on: here from the next resolver batch (the
// legacy cycle runs every ~20 min, so a batch of --batch records stands for a cycle)
const fpWhen = FP_MODE === 'cache' ? () => true
  : (row, board, t, op) => (op === 'refresh' ? String(t ?? '').slice(0, 10) >= (row.first_seen || T0day) : INLINE.has(providerOfBoard.get(board)));
const BATCH = Number(opt('batch', 1000));
const SHADOWED = { kept: false, hide: 'filtered' };   // crawl.mjs shadowVerdict: an aggregator's copy of a role the employer's ATS lists
const EXTRA = { kept: false, hide: 'extra' };
const keptFor = (row, board, t) => {
  if (boardNames.has(board) && !/\(via /i.test(row.company ?? '') && registryNames.has(boardOfCompany(row.company)) && board !== boardOfCompany(row.company)) return SHADOWED;
  const rel = released.get(row.url);
  if (rel && t && String(t).slice(0, 10) < rel && rel > (row.first_seen || T0day)) return EXTRA;
  return null;
};
const facts = legacyFacts(LEG, { history, isAggregator: (row) => isAggregatorRow(row, boardNames), fpWhen, keptFor });
const config = { companies: registry, catalogue, rules: 'legacy' };
const store = await openSqliteStore(OUT);
const days = [...new Set(rows.map((r) => r.first_seen || T0day))].filter((d) => d <= T0day).sort();
let runs = 0, events = 0;
for (const [di, D] of days.entries()) {
  const due = [...listings].map(([b, ls]) => [b, ls, ls.filter((l) => l.from === D || l.rel === D)]).filter(([, , nw]) => nw.length)
    .sort((a, b) => Math.min(...a[2].map((l) => l.idx)) - Math.min(...b[2].map((l) => l.idx)));
  let k = 0;
  for (const [board, ls] of due) {
    const items = ls.filter((l) => l.from <= D).sort((a, b) => a.idx - b.idx).map((l) => ({ url: l.url, title: l.title, location: l.location, postedAt: l.rel && D < l.rel ? '1970-01-01' : l.posted }));   // the sentinel makes the release day a 'changed' record
    const when = new Date(Date.parse(`${D}T00:00:00Z`) + (k++) * 1000);
    const r = await runBoardOn(store, { name: board }, { read: { ok: true, items, complete: true, emptyOk: true }, now: () => when, rules: LEGACY_RULES });
    runs++; events += r.events?.length ?? 0;
  }
  const rr = await runResolver(store, { facts, config: { ...config, sweep: false }, now: () => new Date(Date.parse(`${D}T23:59:59Z`)), batch: BATCH, tickAtEnd: true });
  if (di % 5 === 0 || di === days.length - 1) log(`day ${D} (${di + 1}/${days.length}): ${due.length} boards read; total ${runs} runs, ${events} events; resolver bookmark ${rr.bookmark}, seq ${rr.seq}; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
// final read of every board at the copy's time, then the resolver with the sweep on
let k = 0;
for (const [board, ls] of listings) {
  const items = ls.sort((a, b) => a.idx - b.idx).map((l) => ({ url: l.url, title: l.title, location: l.location, postedAt: l.posted }));
  const when = new Date(T0 - 3600e3 + (k++) * 50);
  await runBoardOn(store, { name: board }, { read: { ok: true, items, complete: true, emptyOk: true }, now: () => when, rules: LEGACY_RULES });
  runs++;
}
const fin = await runResolver(store, { facts, config, now: () => new Date(T0), batch: BATCH, tickAtEnd: true });
log(`replayed: ${runs} board runs; resolver at event_id ${fin.bookmark}, ${fin.seq} resolved records; ${((Date.now() - t0) / 1000).toFixed(0)} s`);

// ---- compare ----
const groups = new Map(resolvedGroups(store).map((g) => [g.id, g]));
const idOfUrl = new Map(rows.map((r) => [r.url, postingId(r.url)]));
const urlsById = new Map();
for (const [u, id] of idOfUrl) (urlsById.get(id) ?? urlsById.set(id, []).get(id)).push(u);
const rowObj = (u) => { const r = history.get(u); return { url: u, company: r.company, title: r.title, location: r.location }; };
const fpOf = (u) => facts.simhash[u] ?? '';
const ex = (u, extra = {}) => { const r = history.get(u); return { url: u, company: r.company, title: r.title, location: r.location, first_seen: r.first_seen, ...extra }; };

// dup
let EPOCH = '9999'; for (const r of history.values()) if (r.first_seen && r.first_seen < EPOCH) EPOCH = r.first_seen;
const conf = {}; const cls = {}; const samples = {};
const note = (c, e) => { cls[c] = (cls[c] ?? 0) + 1; (samples[c] ??= []).length < 4 && samples[c].push(e); };
const openRowsList = rows.filter((r) => r.status === 'open');
for (const r of rows) {
  const id = idOfUrl.get(r.url);
  const g = groups.get(id);
  const got = g?.status ?? 'missing';
  const k2 = `${r.status}->${got}`;
  conf[k2] = (conf[k2] ?? 0) + 1;
  if (r.status === got) continue;
  if (urlsById.get(id).length > 1) { note(`id-merge (${k2})`, ex(r.url, { same_id: urlsById.get(id) })); continue; }
  if (r.status === 'open' && got === 'dup') {
    const of = groups.get(g.dup_of);
    const ofUrl = of ? urlsById.get(of.id)?.[0] : null;
    const ofRow = ofUrl ? history.get(ofUrl) : null;
    if (ofRow?.status === 'dup') note('resolver dup of a legacy dup (chain)', ex(r.url, { dup_of: ofUrl }));
    else if (ofRow && ofRow.first_seen === EPOCH && r.first_seen === EPOCH) note('resolver dup, legacy open: both rows from the history first day (inserted by older code, never re-matched)', ex(r.url, { dup_of: ofUrl }));
    else if (ofRow && ofRow.first_seen > r.first_seen) note('resolver dup, legacy open: arrival order (resolver original is younger)', ex(r.url, { dup_of: ofUrl }));
    else if (ofRow && isAggregatorRow(rowObj(r.url), boardNames) && !isAggregatorRow(ofRow, boardNames)) note('resolver dup, legacy open: aggregator copy of a direct posting not yet swept by legacy', ex(r.url, { dup_of: ofUrl }));
    else {
      const agg = (x) => (/\(via /i.test(x.company ?? '') ? 'aggregator' : 'direct');
      const when = !ofRow ? '' : ofRow.first_seen === r.first_seen ? ', same day' : ', original older';
      note(`resolver dup, legacy open: ${ofRow ? `${agg(ofRow)} original, ${agg(r)} copy${when}` : 'original not a replayed row'}`, ex(r.url, { dup_of: ofUrl, dup_of_title: ofRow?.title }));
    }
  } else if (r.status === 'dup' && got === 'open') {
    // is there an open legacy row this one cross-lists today?
    const me = rowObj(r.url);
    const cand = openRowsList.find((o) => o.url !== r.url && (canonCompany(o.company) === canonCompany(r.company) || isAggregatorRow(me, boardNames) || isAggregatorRow(o, boardNames)) && isCrossListing(fpOf(r.url), me, fpOf(o.url), rowObj(o.url), boardNames));
    if (!cand) note('legacy dup, resolver open: no open row matches it with today\'s data (decided on older title/text/original)', ex(r.url));
    else {
      const cg = groups.get(idOfUrl.get(cand.url));
      if (cg?.status === 'dup' && cg.dup_of === idOfUrl.get(r.url)) note('legacy dup, resolver open: pair swapped (resolver kept this one, legacy the other)', ex(r.url, { other: cand.url }));
      else note('legacy dup, resolver open: match exists, resolver original differs', ex(r.url, { other: cand.url, other_status: cg?.status }));
    }
  } else note(`other (${k2})`, ex(r.url));
}
// the recent window: rows that arrived while the legacy crawl ran today's code and the cycle logs cover it (default: 3 days before the copy)
const WINDOW = opt('window', new Date(T0 - 2 * 864e5).toISOString().slice(0, 10));
const windowConf = {};
for (const r of rows) { if ((r.first_seen || '') < WINDOW) continue; const k3 = `${r.status}->${groups.get(idOfUrl.get(r.url))?.status ?? 'missing'}`; windowConf[k3] = (windowConf[k3] ?? 0) + 1; }
const dupLegacy = rows.filter((r) => r.status === 'dup').length;
const dupBoth = conf['dup->dup'] ?? 0;
const dupResolver = [...rows].filter((r) => groups.get(idOfUrl.get(r.url))?.status === 'dup').length;

// admission
const adm = { compared: 0, equal: 0, classes: {}, samples: {} };
const anote = (c, e) => { adm.classes[c] = (adm.classes[c] ?? 0) + 1; (adm.samples[c] ??= []).length < 4 && adm.samples[c].push(e); };
const multiObserved = new Set();
for (const [b, ls] of listings) for (const l of ls) if (l.idx >= rows.length) multiObserved.add(l.url);
for (const [u, list] of Object.entries(admit.urls)) {
  const L = list.filter(([, t]) => T0 - t < 48 * 3600e3).map(([bi]) => admit.boards[bi]).sort();
  const id = postingId(u);
  const g = groups.get(id);
  const R = Object.entries(g?.adm ?? {}).filter(([, t]) => T0 - t < 48 * 3600e3).map(([b]) => b).sort();
  adm.compared++;
  const same = JSON.stringify(L) === JSON.stringify(R);
  if (same) { adm.equal++; adm.classes[L.length > 1 ? 'equal (multi-board)' : 'equal (one board)'] = (adm.classes[L.length > 1 ? 'equal (multi-board)' : 'equal (one board)'] ?? 0) + 1; continue; }
  const h = history.get(u);
  if (!g) anote(h ? `url not replayed (legacy status ${h.status})` : 'url not in the history', { url: u, legacy: L });
  else if (L.length > 1 && R.every((b) => L.includes(b)) && !multiObserved.has(u)) anote('multi-board: second board unobservable (not in the shadow store)', { url: u, legacy: L, resolver: R });
  else if (urlsById.get(id)?.length > 1) anote('id-merge', { url: u, legacy: L, resolver: R });
  else if (!L.length) anote('legacy admission older than the hold', { url: u, resolver: R });
  else anote('board attribution differs', { url: u, legacy: L, resolver: R, lifecycle_board: lc[u]?.[0] ?? null, company: h?.company });
}

// protected set (legacy: crawl.mjs protectedIdx before the cycle's aggregator answers + open rows of industry aggregator boards)
const providerOf = new Map(registry.map((c) => [c.name, c.provider]));
const legacyNames = [...catalogue, ...protectedFromHistory(history.values()), ...registry.filter((c) => !c.probation && !isAggregatorEntry(c)).map((c) => c.name)];
for (const r of rows) { const b = lc[r.url]?.[0] || boardOfCompany(r.company); if (INDUSTRY_AGGREGATOR_PROVIDERS.has(providerOf.get(b))) legacyNames.push(r.company); }
const legacyIdx = makeEmployerIndex(legacyNames), resIdx = makeEmployerIndex(derivedSet(store));
const canonSet = (names) => new Set(names.map((n) => canonCompany(String(n).replace(/\s*\(via [^)]*\)\s*$/i, ''))).filter(Boolean));
const Lp = canonSet(legacyNames), Rp = canonSet(derivedSet(store));
const onlyL = [...Lp].filter((n) => !Rp.has(n)), onlyR = [...Rp].filter((n) => !Lp.has(n));
// does the difference change a gate decision? the per-board gate asks has(board name) for every registry entry
let gateDiff = 0; const gateEx = [];
for (const c of registry) if (legacyIdx.has(c.name) !== resIdx.has(c.name)) { gateDiff++; if (gateEx.length < 5) gateEx.push({ board: c.name, legacy: legacyIdx.has(c.name), resolver: resIdx.has(c.name) }); }

const report = {
  legacy_copy: LEG, legacy_at: admit.at, out: OUT, seconds: Math.round((Date.now() - t0) / 1000),
  replay: { fp_mode: FP_MODE, batch: BATCH, inline_providers: INLINE.size, released_rows: rows.filter((r) => released.has(r.url)).length, epoch: EPOCH, employer_board_listings: companyBoardExtra, history_rows: history.size, replayed_rows: rows.length, second_board_listings: shadowExtra, boards: listings.size, board_runs: runs, resolved_records: fin.seq },
  dup: { rows: rows.length, agreement: +((rows.length - Object.values(cls).reduce((a, b) => a + b, 0)) / rows.length * 100).toFixed(3), confusion: conf,
    legacy_dup: dupLegacy, resolver_dup: dupResolver, both_dup: dupBoth,
    dup_recall: +(dupBoth / dupLegacy * 100).toFixed(2), window_from: WINDOW, window_confusion: windowConf, dup_precision: +(dupBoth / (dupResolver || 1) * 100).toFixed(2), classes: cls, samples },
  admission: { urls: adm.compared, agreement: +(adm.equal / adm.compared * 100).toFixed(3), classes: adm.classes, samples: adm.samples },
  protected: { legacy: Lp.size, resolver: Rp.size, only_legacy: onlyL.length, only_resolver: onlyR.length, only_legacy_sample: onlyL.slice(0, 8), only_resolver_sample: onlyR.slice(0, 8), registry_gate_decisions_differ: gateDiff, gate_examples: gateEx },
  resolver_stats: fin.stats,
};
const repFile = opt('report') ?? join(OUT, 'replay-report.json');
writeFileSync(repFile, JSON.stringify(report, null, 1) + '\n');
log(`result: dup agreement ${report.dup.agreement} % (legacy dup ${dupLegacy}, resolver dup ${dupResolver}, both ${dupBoth}); admission agreement ${report.admission.agreement} % over ${adm.compared} urls; protected only-legacy ${onlyL.length}, only-resolver ${onlyR.length}, gate decisions differ ${gateDiff}; report ${repFile}`);
store.close();
void resolvedRecords;
