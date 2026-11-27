// Baseline import (design §0.1, Fable 7): today's legacy state becomes the new path's starting point as an epoch WITHOUT events, so the
// first shadow read emits only real changes, never an "everything added" burst.
// Per board: the rows of <legacy data>/scan-history.tsv that the board listed in its last reads (status open, extra, filtered or dup;
// company = the board or "... (via <board>)") become open postings with their first_seen / last_seen; seq stays 0; the state records
// `baseline: { epoch, from, at, rows }`. A board that already has a state (seq > 0 or postings) is left alone unless replace is set.
// Read-only on the legacy side.
import { postingId } from '../id.mjs';
import { emptyState } from '../delta/board-delta.mjs';
import { commitRun, openBoard } from '../state/board-store.mjs';
import { legacyRowsByBoard } from './parity.mjs';

const iso = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d ?? '')) ? `${d}T00:00:00.000Z` : (d || null));

export function baselineState(board, rows, { epoch = 1, from = 'legacy', at = new Date().toISOString() } = {}) {
  const s = emptyState(board);
  for (const r of rows) {
    if (!r.url) continue;
    const id = postingId(r.url);
    if (s.postings[id]) continue;
    s.postings[id] = { url: r.url, title: r.title ?? '', location: r.location ?? '', posted: String(r.posted ?? '').slice(0, 10), dh: null,
      first_seen: iso(r.first_seen) ?? at, last_seen: iso(r.last_seen) ?? at, misses: 0, status: 'open' };
  }
  s.baseline = { epoch, from, at, rows: rows.length };
  return s;
}

/** Imports the boards' legacy rows into the store at root. Returns { imported, kept, empty, rows }. */
export async function importBaseline({ historyFile, root, boards, replace = false, at = new Date().toISOString(), log = () => {} }) {
  const byBoard = await legacyRowsByBoard(historyFile, boards);
  const sum = { imported: 0, kept: 0, empty: 0, rows: 0 };
  for (const board of boards) {
    const cur = openBoard(root, board);
    if (!replace && (cur.seq > 0 || Object.keys(cur.postings).length)) { sum.kept++; continue; }
    const rows = byBoard.get(board) ?? [];
    if (!rows.length) sum.empty++;
    const s = baselineState(board, rows, { from: historyFile, at });
    commitRun(root, board, s, []);
    sum.imported++; sum.rows += rows.length;
  }
  log(`[import] boards ${boards.length}: imported ${sum.imported} (${sum.rows} rows), already had state ${sum.kept}, without rows ${sum.empty}`);
  return sum;
}
