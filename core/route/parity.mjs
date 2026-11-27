// Parity of the new path against the legacy path, per board (design §5.3, strangler fig). Feeds the cut-over decision and the ledger.
//
// The legacy side is what the live crawl believes the board lists: the rows of <legacy data>/scan-history.tsv whose company is the
// board (or "... (via <board>)") and whose status is not "gone" (open, extra, filtered and dup all mean "the board listed it in the
// last 3 days"; the new path has no filters yet, so the comparison is on what is listed, not on what the board page shows).
// The new side is the board's open postings in the new store. Rows are matched by posting id (core/id.mjs), so a URL that differs only
// in tracking parameters still matches.
//
// compareBoard(legacyRows, newOpen) -> { legacy, new, both, only_legacy, only_new, title_diff, location_diff, overlap, verdict, samples }
//   verdict: pass  (same ids, no field differences)
//            near  (id overlap >= 0.99 and field differences <= 1 %)
//            fail  (anything else)
//            empty (neither side lists anything)
// A board's parity passes the cut-over gate after `PASSES_NEEDED` consecutive passing reports (ledger.mjs).
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { postingId } from '../id.mjs';

export const PARITY_SCHEMA = 'parity/v1';

/** Streams scan-history.tsv once and returns Map(board -> rows not gone) for the boards asked for. Read-only. */
export async function legacyRowsByBoard(historyFile, boards) {
  const want = new Set(boards);
  const out = new Map([...want].map((b) => [b, []]));
  if (!existsSync(historyFile)) return out;
  const rl = createInterface({ input: createReadStream(historyFile, { encoding: 'utf8' }), crlfDelay: Infinity });
  let head = null;
  for await (const line of rl) {
    if (!line) continue;
    const cols = line.split('\t');
    if (!head) { head = cols; continue; }
    const row = Object.fromEntries(head.map((h, i) => [h, cols[i] ?? '']));
    if (row.status === 'gone') continue;
    let board = row.company;
    const via = /\(via ([^)]+)\)\s*$/.exec(board);
    if (!want.has(board) && via && want.has(via[1])) board = via[1];
    if (want.has(board)) out.get(board).push(row);
  }
  return out;
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export function compareBoard(legacyRows, newOpen) {
  const L = new Map(legacyRows.map((r) => [postingId(r.url), r]));
  const N = new Map(newOpen.map((r) => [r.id ?? postingId(r.url), r]));
  let both = 0, title = 0, loc = 0;
  const samples = { only_legacy: [], only_new: [], field: [] };
  for (const [id, l] of L) {
    const n = N.get(id);
    if (!n) { if (samples.only_legacy.length < 5) samples.only_legacy.push(l.url); continue; }
    both++;
    const td = norm(l.title) !== norm(n.title), ld = norm(l.location) !== norm(n.location) && norm(l.location) !== 'unspecified';
    if (td) title++;
    if (ld) loc++;
    if ((td || ld) && samples.field.length < 5) samples.field.push({ url: l.url, legacy: { title: l.title, location: l.location }, new: { title: n.title, location: n.location } });
  }
  for (const [id, n] of N) if (!L.has(id) && samples.only_new.length < 5) samples.only_new.push(n.url);
  const onlyL = L.size - both, onlyN = N.size - both;
  const union = L.size + N.size - both;
  const overlap = union ? both / union : 1;
  const fieldRate = both ? (title + loc) / both : 0;
  const verdict = !union ? 'empty' : (onlyL === 0 && onlyN === 0 && title === 0 && loc === 0) ? 'pass' : (overlap >= 0.99 && fieldRate <= 0.01) ? 'near' : 'fail';
  return { legacy: L.size, new: N.size, both, only_legacy: onlyL, only_new: onlyN, title_diff: title, location_diff: loc, overlap: +overlap.toFixed(4), verdict, samples };
}

/** Per-provider aggregate of board reports: { provider: { boards, pass, near, fail, empty, legacy, new, both } }. */
export function byProvider(reports) {
  const agg = {};
  for (const r of reports) {
    const a = (agg[r.provider ?? '?'] ??= { boards: 0, pass: 0, near: 0, fail: 0, empty: 0, error: 0, legacy: 0, new: 0, both: 0 });
    a.boards++;
    if (r.error) { a.error++; continue; }
    a[r.verdict]++;
    a.legacy += r.legacy; a.new += r.new; a.both += r.both;
  }
  return agg;
}

/**
 * Self-consistency of the delta module against two full reads: the added ids must be B \ A and, with a departure rule that fires on
 * the first complete miss, the departed ids must be A \ B. Returns { ok, added_expected, added_got, departed_expected, departed_got }.
 */
export function deltaMatchesDiff(readA, readB, events) {
  const ids = (items) => new Set(items.map((i) => postingId(i.url)));
  const A = ids(readA), B = ids(readB);
  const addedExp = [...B].filter((x) => !A.has(x)).sort(), depExp = [...A].filter((x) => !B.has(x)).sort();
  const addedGot = events.filter((e) => e.op === 'added').map((e) => e.id).sort();
  const depGot = events.filter((e) => e.op === 'departed').map((e) => e.id).sort();
  const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  return { ok: same(addedExp, addedGot) && same(depExp, depGot), added_expected: addedExp.length, added_got: addedGot.length, departed_expected: depExp.length, departed_got: depGot.length };
}
