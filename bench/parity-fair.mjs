#!/usr/bin/env node
// Fair parity: compare a board's answer with the legacy crawl's answer of the SAME board from the fetch closest in time, using the
// legacy lifecycle state (<data>/lifecycle/state.json: url -> [board that last listed it, day, misses, time of that fetch in ms]) instead
// of the history's company column. Read-only on every input. Two sources for the new side:
//   --recording <dir>   bench/record.mjs lists (one answer per board, recorded at list.t)
//   --shadow <store>    the shadow store (core/route/shadow-hook.mjs): the SAME response the live crawl got, so the comparison has no
//                       time skew at all; the board's open postings are compared with the legacy fetch whose time equals the store's
//                       last read (within --same-ms, default 120 s)
// Why the first parity method failed (bench/parity-breakdown.mjs): the history's company column is the provider's company name for
// many sources (teamtailor, workday, ...), not the board name, so a board's rows were missed ("not in legacy"), and the history has only
// day-level dates, so time skew could not be told apart from real differences.
// Per board: gap = |new answer time - legacy fetch time|; differences: only_new, only_legacy; verdict pass/fail. Per provider: boards,
// pass and fail by gap bucket (<=1 h, <=6 h, >6 h), and the share of differences in each bucket.
//   node bench/parity-fair.mjs --lifecycle <state.json> (--recording <dir> | --shadow <store>) [--out <prefix>]
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { postingId } from '../core/id.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
if (args.includes('--help') || !opt('lifecycle') || !(opt('recording') || opt('shadow'))) { console.log('usage: node bench/parity-fair.mjs --lifecycle <state.json> (--recording <dir> | --shadow <store>) [--out <prefix>] [--same-ms 120000]'); process.exit(args.includes('--help') ? 0 : 2); }
const SAME_MS = Number(opt('same-ms', 120000));
const OUT = opt('out', join(opt('recording') ?? opt('shadow'), 'parity-fair'));

// legacy: per board, the URLs of its LATEST fetch (all urls the lifecycle state attributes to the board with that fetch's time)
const st = JSON.parse(readFileSync(opt('lifecycle'), 'utf8'));
const byBoard = new Map();
for (const [url, v] of Object.entries(st.urls ?? {})) {
  const [board, , , ms] = v;
  const b = byBoard.get(board) ?? byBoard.set(board, { last: 0, urls: [] }).get(board);
  b.urls.push([url, Number(ms) || 0]);
  if ((Number(ms) || 0) > b.last) b.last = Number(ms) || 0;
}
const legacyFetch = (board) => {
  const b = byBoard.get(board);
  if (!b) return null;
  return { at: b.last, ids: new Set(b.urls.filter(([, ms]) => ms === b.last).map(([u]) => postingId(u))) };
};

// the new side
const answers = [];   // { board, provider, at, ids }
if (opt('recording')) {
  const dir = join(opt('recording'), 'lists');
  for (const f of readdirSync(dir)) {
    try { const l = JSON.parse(gunzipSync(readFileSync(join(dir, f))).toString('utf8')); answers.push({ board: l.board, provider: l.provider, at: Date.parse(l.t), ids: new Set((l.items ?? []).map((i) => postingId(i.url))) }); } catch {}
  }
} else {
  const base = join(opt('shadow'), 'boards');
  for (const k of readdirSync(base)) {
    try {
      const s = JSON.parse(readFileSync(join(base, k, 'state.json'), 'utf8'));
      if (!s.last_ok) continue;
      answers.push({ board: s.board, provider: 'shadow', at: Date.parse(s.last_ok), ids: new Set(Object.entries(s.postings).filter(([, p]) => p.status === 'open' && Date.parse(p.last_seen) === Date.parse(s.last_ok)).map(([id]) => id)) });
    } catch {}
  }
}

const bucket = (gap) => (gap <= 3600e3 ? 'le_1h' : gap <= 6 * 3600e3 ? 'le_6h' : 'gt_6h');
const P = {};
const boards = [];
for (const a of answers) {
  const lf = legacyFetch(a.board);
  const p = (P[a.provider] ??= { boards: 0, no_legacy: 0, both_empty: 0, le_1h: { pass: 0, fail: 0 }, le_6h: { pass: 0, fail: 0 }, gt_6h: { pass: 0, fail: 0 }, only_new: 0, only_legacy: 0 });
  p.boards++;
  if (!lf) { p.no_legacy++; continue; }
  if (!a.ids.size && !lf.ids.size) { p.both_empty++; continue; }
  const gap = Math.abs(a.at - lf.at);
  let onlyNew = 0, onlyLegacy = 0;
  for (const id of a.ids) if (!lf.ids.has(id)) onlyNew++;
  for (const id of lf.ids) if (!a.ids.has(id)) onlyLegacy++;
  const pass = onlyNew === 0 && onlyLegacy === 0;
  const b = opt('shadow') ? (gap <= SAME_MS ? 'le_1h' : bucket(gap)) : bucket(gap);
  p[b][pass ? 'pass' : 'fail']++;
  p.only_new += onlyNew; p.only_legacy += onlyLegacy;
  boards.push({ board: a.board, provider: a.provider, gap_min: Math.round(gap / 60000), new: a.ids.size, legacy: lf.ids.size, only_new: onlyNew, only_legacy: onlyLegacy, pass });
}
const out = { t: new Date().toISOString(), mode: opt('shadow') ? 'shadow' : 'recording', lifecycle_at: st.at, providers: P, failing: boards.filter((b) => !b.pass).sort((x, y) => x.gap_min - y.gap_min).slice(0, 40) };
writeFileSync(`${OUT}.json`, JSON.stringify(out, null, 1));
const md = ['# Fair parity (legacy fetch closest in time, board attribution from the lifecycle state)', '', `mode ${out.mode}; lifecycle state at ${st.at}`, '',
  '| provider | boards | no legacy fetch | both empty | <=1 h pass | <=1 h fail | <=6 h pass | <=6 h fail | >6 h pass | >6 h fail | only new | only legacy |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...Object.entries(P).sort((a, b) => b[1].boards - a[1].boards).slice(0, 30).map(([k, p]) => `| ${k} | ${p.boards} | ${p.no_legacy} | ${p.both_empty} | ${p.le_1h.pass} | ${p.le_1h.fail} | ${p.le_6h.pass} | ${p.le_6h.fail} | ${p.gt_6h.pass} | ${p.gt_6h.fail} | ${p.only_new} | ${p.only_legacy} |`), ''];
writeFileSync(`${OUT}.md`, md.join('\n'));
console.log(md.slice(4, 16).join('\n'));
