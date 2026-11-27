// Baseline import (design §0.1, Fable 7): today's legacy state becomes the new path's starting point as an epoch WITHOUT events, so the
// first shadow read emits only real changes, never an "everything added" burst.
// Per board: the rows of <legacy data>/scan-history.tsv that the board listed in its last reads (status open, extra, filtered or dup;
// company = the board or "... (via <board>)") become postings with their first_seen / last_seen, normalised exactly as the live read
// normalises them (normaliseItem) and flagged `bl` so that their first live sighting refreshes the record silently (the legacy history
// keeps the fields of the FIRST sighting). Rows seen on the board's last read day are open; older rows are departed; rows the lifecycle
// marked 'unknown' stay 'unknown'. The state records `baseline: { epoch, from, at, rows }`. Read-only on the legacy side.
// Safety (phase-1 review): a missing history file fails the import (it never imports "everything empty"); each board is imported under its
// lease (a shadow run cannot interleave); a board that already has a state is left alone unless `replace`, and even then the sequence
// is carried forward (seq = the existing seq, the event log untouched), so a replace never cuts or reuses an event number.
import { existsSync } from 'node:fs';
import { postingId } from '../id.mjs';
import { emptyState, normaliseItem } from '../delta/board-delta.mjs';
import { commitRun, lease, openBoard } from '../state/board-store.mjs';
import { legacyRowsByBoard } from './parity.mjs';

const iso = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d ?? '')) ? `${d}T00:00:00.000Z` : (d || null));

export function baselineState(board, rows, { epoch = 1, from = 'legacy', at = new Date().toISOString(), seq = 0 } = {}) {
  const s = emptyState(board);
  s.seq = seq;
  // The board's last read day: the newest last_seen among its rows. Only rows seen that day are what the board lists now; older rows
  // (a 'filtered' or 'extra' row the legacy history keeps after the board stopped listing it) are imported as departed, so the first
  // read neither departs them again nor counts them as open (a later listing makes them 'reappeared').
  const lastDay = rows.reduce((m, r) => (String(r.last_seen ?? '') > m ? String(r.last_seen) : m), '');
  let open = 0, old = 0, unknownN = 0;
  for (const r of rows) {
    if (!r.url) continue;
    const id = postingId(r.url);
    if (s.postings[id]) continue;
    const n = normaliseItem({ url: r.url, title: r.title, location: r.location, posted: r.posted });   // the same normalised record the live read makes
    const unknown = r.status === 'unknown';
    const stale = !unknown && String(r.last_seen ?? '') < lastDay;
    const status = unknown ? 'unknown' : stale ? 'departed' : 'open';
    if (unknown) unknownN++; else if (stale) old++; else open++;
    s.postings[id] = { ...n, first_seen: iso(r.first_seen) ?? at, last_seen: iso(r.last_seen) ?? at, misses: 0, status, bl: 1,
      ...(unknown ? { unknown_since: iso(r.last_seen) ?? at } : {}), ...(stale ? { departed_at: iso(r.last_seen) ?? at } : {}) };
  }
  s.baseline = { epoch, from, at, rows: rows.length, open, departed: old, unknown: unknownN, last_day: lastDay || null };
  return s;
}

/** Imports the boards' legacy rows into the store at root. Returns { imported, replaced, kept, busy, empty, rows }. */
export async function importBaseline({ historyFile, root, boards, replace = false, at = new Date().toISOString(), log = () => {} }) {
  if (!existsSync(historyFile)) throw new Error(`legacy history not found: ${historyFile} (nothing imported)`);
  const byBoard = await legacyRowsByBoard(historyFile, boards, { includeUnknown: true });
  const sum = { imported: 0, replaced: 0, kept: 0, busy: 0, empty: 0, rows: 0 };
  for (const board of boards) {
    const release = await lease(root, board, 5 * 60e3);
    if (!release) { sum.busy++; continue; }
    try {
      const cur = openBoard(root, board);
      const had = cur.seq > 0 || Object.keys(cur.postings).length > 0;
      if (had && !replace) { sum.kept++; continue; }
      const rows = byBoard.get(board) ?? [];
      if (!rows.length) sum.empty++;
      const s = baselineState(board, rows, { from: historyFile, at, seq: cur.seq, epoch: (cur.baseline?.epoch ?? 0) + 1 });
      if (had) s.baseline.replaced_seq = cur.seq;
      commitRun(root, board, s, []);
      if (had) sum.replaced++; else sum.imported++;
      sum.rows += rows.length;
    } finally { release(); }
  }
  log(`[import] boards ${boards.length}: imported ${sum.imported}, replaced ${sum.replaced} (${sum.rows} rows), kept ${sum.kept}, lease busy ${sum.busy}, without rows ${sum.empty}`);
  return sum;
}
