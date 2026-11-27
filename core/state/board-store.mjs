// Files backend of the per-board state store (design §3.5). One folder per board under <root>/boards/<key>/:
//   state.json      board-state/v1 (written tmp + rename after the run's events are on disk)
//   events.ndjson   delta/v1 lines, append-only
//   lease           { pid, host, expires } created exclusively; an expired lease is taken over
// Commit order: events are appended and fsynced first, then the state is renamed into place. A crash between the two leaves events with
// seq > state.seq at the end of the log; openBoard() cuts them, so the next run re-issues those seq numbers with its own content and a
// consumer never sees two different events under one (board, seq).
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../id.mjs';
import { emptyState } from '../delta/board-delta.mjs';

export const boardKey = (board) => `${String(board).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'board'}-${sha256(board).slice(0, 8)}`;
const dirOf = (root, board) => join(root, 'boards', boardKey(board));
const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

function readEventsFile(f) {
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** Loads a board's state (or a fresh one) and repairs a log that ran ahead of the state. */
export function openBoard(root, board) {
  const dir = dirOf(root, board);
  mkdirSync(dir, { recursive: true });
  const state = readJson(join(dir, 'state.json')) ?? emptyState(board);
  const evFile = join(dir, 'events.ndjson');
  const ev = readEventsFile(evFile);
  if (ev.some((e) => e.seq > state.seq)) {
    const keep = ev.filter((e) => e.seq <= state.seq);
    const tmp = `${evFile}.tmp`;
    writeFileSync(tmp, keep.map((e) => JSON.stringify(e) + '\n').join(''));
    renameSync(tmp, evFile);
  }
  if (!existsSync(join(dir, 'board.txt'))) writeFileSync(join(dir, 'board.txt'), String(board) + '\n');
  return state;
}

/** Appends the run's events, then replaces the state. */
export function commitRun(root, board, state, events) {
  const dir = dirOf(root, board);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'board.txt'))) writeFileSync(join(dir, 'board.txt'), String(board) + '\n');
  if (events.length) {
    const fd = openSync(join(dir, 'events.ndjson'), 'a');
    try { writeSync(fd, events.map((e) => JSON.stringify(e) + '\n').join('')); fsyncSync(fd); } finally { closeSync(fd); }
  }
  const tmp = join(dir, 'state.json.tmp');
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, join(dir, 'state.json'));
  return { seqFrom: events[0]?.seq ?? null, seqTo: events.at(-1)?.seq ?? null };
}

/** Takes the board's lease for ttlMs. Returns a release function, or null while another live lease holds it. */
export function lease(root, board, ttlMs = 15 * 60e3, now = Date.now) {
  const dir = dirOf(root, board);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'lease');
  const body = JSON.stringify({ pid: process.pid, host: hostname(), expires: now() + ttlMs });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(f, body, { flag: 'wx' });
      return () => { try { const cur = readJson(f); if (cur?.pid === process.pid && cur?.host === hostname()) rmSync(f, { force: true }); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const cur = readJson(f);
      if (cur && cur.expires > now()) return null;
      rmSync(f, { force: true });   // expired or unreadable: take it over
    }
  }
  return null;
}

/** Board names in a store. */
export function listBoards(root) {
  const base = join(root, 'boards');
  if (!existsSync(base)) return [];
  return readdirSync(base).map((k) => { try { return readFileSync(join(base, k, 'board.txt'), 'utf8').trim(); } catch { return null; } }).filter(Boolean);
}

/** Delta events after the given watermarks ({ board: lastAppliedSeq }), board by board in seq order. */
export function* readEvents(root, since = {}) {
  for (const board of listBoards(root)) {
    const after = since[board] ?? 0;
    for (const e of readEventsFile(join(dirOf(root, board), 'events.ndjson'))) if (e.seq > after) yield e;
  }
}

/** A full snapshot: a header line with the per-board watermarks, then one posting per line. */
export function* snapshot(root, { status = 'open' } = {}) {
  const boards = listBoards(root);
  const states = boards.map((b) => [b, readJson(join(dirOf(root, b), 'state.json')) ?? emptyState(b)]);
  yield { schema: 'snapshot/v1', t: new Date().toISOString(), watermarks: Object.fromEntries(states.map(([b, s]) => [b, s.seq])) };
  for (const [b, s] of states) {
    for (const [id, r] of Object.entries(s.postings)) {
      if (status && r.status !== status) continue;
      yield { '@type': 'JobPosting', title: r.title, url: r.url, datePosted: r.posted || undefined,
        jobcrawl: { schema: 'posting/v1', id, board: b, status: r.status, first_seen: r.first_seen, last_seen: r.last_seen, content_hash: r.dh ?? undefined } };
    }
  }
}

export const appendLine = (file, obj) => appendFileSync(file, JSON.stringify(obj) + '\n');
