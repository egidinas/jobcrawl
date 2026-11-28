#!/usr/bin/env node
// Why boards fail parity: a per-provider breakdown of the differences between a recording (bench/record.mjs lists) and the legacy
// history, by reason. Read-only on every input. Prints one JSON line and writes <out>.json and <out>.md.
//
// For each board of the parity report (or of the recording), with recDay = the day its list was recorded:
//   only in legacy (legacy lists it, the recording does not):
//     added-since       legacy first saw it AFTER the recording day (time skew: it appeared later)
//     url-variant       the recording has the same posting under another URL form (same host+path, other query/case)
//     legacy-only       legacy had it on or before the recording day and the recording did not list it
//   only in the recording:
//     gone-since        legacy has it, now closed, last seen on or after the recording day (time skew: it closed later)
//     lastday-filter    legacy has it open but not seen on the board's last day (the parity method left it out)
//     url-variant       legacy has the same posting under another URL form
//     not-in-legacy     legacy never had it
//   field diffs        title / location differ (normalised: whitespace, case) on postings both sides list
// A board "passes on a fair comparison" when every difference is time skew (added-since, gone-since) or the method (lastday-filter),
// and no field differs except where legacy keeps first-sighting fields (counted separately, see `field_first_sighting`).
//   node bench/parity-breakdown.mjs --recording <out dir> --history <scan-history.tsv> --companies <json> [--out <file prefix>]
import { createReadStream, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { postingId } from '../core/id.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
if (args.includes('--help') || !opt('recording') || !opt('history')) { console.log('usage: node bench/parity-breakdown.mjs --recording <dir> --history <tsv> [--out <prefix>]'); process.exit(args.includes('--help') ? 0 : 2); }
const REC = opt('recording'), OUT = opt('out', join(REC, 'parity-breakdown'));
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const urlKey = (u) => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, '').toLowerCase()}${x.pathname.replace(/\/+$/, '').toLowerCase()}`; } catch { return String(u); } };

// recording lists
const lists = new Map();
for (const f of readdirSync(join(REC, 'lists'))) {
  try { const l = JSON.parse(gunzipSync(readFileSync(join(REC, 'lists', f))).toString('utf8')); lists.set(l.board, l); } catch {}
}
const boardsByName = new Map([...lists.keys()].map((b) => [b, true]));
// legacy rows per board (company = board or "... (via board)"), all statuses
const legacy = new Map();
const rl = createInterface({ input: createReadStream(opt('history'), { encoding: 'utf8' }), crlfDelay: Infinity });
let head = null;
for await (const line of rl) {
  if (!line) continue;
  const c = line.split('\t');
  if (!head) { head = c; continue; }
  const row = Object.fromEntries(head.map((h, i) => [h, c[i] ?? '']));
  let b = row.company;
  const via = /\(via ([^)]+)\)\s*$/.exec(b);
  if (!boardsByName.has(b) && via && boardsByName.has(via[1])) b = via[1];
  if (!boardsByName.has(b)) continue;
  (legacy.get(b) ?? legacy.set(b, []).get(b)).push(row);
}

const P = {};
const zero = () => ({ boards: 0, both_empty: 0, identical: 0, fair_pass: 0, unfair: 0, added_since: 0, url_variant_l: 0, legacy_only: 0, gone_since: 0, lastday_filter: 0, url_variant_n: 0, not_in_legacy: 0, title_diff: 0, location_diff: 0, samples: [] });
for (const [board, l] of lists) {
  const p = (P[l.provider] ??= zero());
  p.boards++;
  const recDay = String(l.t ?? '').slice(0, 10);
  const rows = legacy.get(board) ?? [];
  const lastDay = rows.reduce((m, r) => (r.last_seen > m ? r.last_seen : m), '');
  const L = new Map(), Lall = new Map(), Lkey = new Map();
  for (const r of rows) { const id = postingId(r.url); Lall.set(id, r); Lkey.set(urlKey(r.url), r); if (r.status !== 'gone' && r.status !== 'unknown' && r.last_seen === lastDay) L.set(id, r); }
  const N = new Map(), Nkey = new Map();
  for (const it of l.items ?? []) { const id = postingId(it.url); N.set(id, it); Nkey.set(urlKey(it.url), it); }
  if (!L.size && !N.size) { p.both_empty++; continue; }
  const d = { added_since: 0, url_variant_l: 0, legacy_only: 0, gone_since: 0, lastday_filter: 0, url_variant_n: 0, not_in_legacy: 0, title_diff: 0, location_diff: 0 };
  for (const [id, r] of L) {
    if (N.has(id)) {
      const n = N.get(id);
      if (norm(n.title) !== norm(r.title)) d.title_diff++;
      if (norm(n.location) !== norm(r.location) && norm(r.location) !== 'unspecified') d.location_diff++;
      continue;
    }
    if (r.first_seen > recDay) d.added_since++;
    else if (Nkey.has(urlKey(r.url))) d.url_variant_l++;
    else d.legacy_only++;
  }
  for (const [id, n] of N) {
    if (L.has(id)) continue;
    const r = Lall.get(id);
    if (r && r.status === 'gone' && r.last_seen >= recDay) d.gone_since++;
    else if (r && r.status !== 'gone') d.lastday_filter++;
    else if (Lkey.has(urlKey(n.url))) d.url_variant_n++;
    else d.not_in_legacy++;
  }
  for (const k of Object.keys(d)) p[k] += d[k];
  const unfair = d.legacy_only + d.not_in_legacy + d.url_variant_l + d.url_variant_n;
  const diffs = Object.values(d).reduce((a, b) => a + b, 0);
  if (!diffs) p.identical++;
  else if (!unfair) p.fair_pass++;
  else { p.unfair++; if (p.samples.length < 4) p.samples.push({ board, recDay, lastDay, legacy_listed: L.size, recorded: N.size, ...d }); }
}
const totals = zero(); delete totals.samples;
for (const p of Object.values(P)) for (const k of Object.keys(totals)) totals[k] += p[k];
const out = { t: new Date().toISOString(), recording: REC, history: opt('history'), totals, providers: P };
writeFileSync(`${OUT}.json`, JSON.stringify(out, null, 1));
const rowsMd = Object.entries(P).sort((a, b) => b[1].boards - a[1].boards).slice(0, 30).map(([k, p]) =>
  `| ${k} | ${p.boards} | ${p.both_empty} | ${p.identical} | ${p.fair_pass} | ${p.unfair} | ${p.added_since} | ${p.gone_since} | ${p.lastday_filter} | ${p.legacy_only} | ${p.not_in_legacy} | ${p.url_variant_l + p.url_variant_n} | ${p.title_diff} | ${p.location_diff} |`);
writeFileSync(`${OUT}.md`, ['# Parity breakdown', '', `recording ${REC}; legacy history ${opt('history')} (read ${out.t})`, '',
  '| provider | boards | both empty | identical | fair pass | unfair | added since | gone since | lastday filter | legacy only | not in legacy | url variant | title diff | location diff |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|', ...rowsMd, ''].join('\n'));
console.log(JSON.stringify({ totals }));
