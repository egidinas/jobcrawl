// Files backend of the per-board state store (design §3.5). One folder per board under <root>/boards/<key>/:
//   state.json       board-state/v1, written tmp + fsync + rename + directory fsync, after the run's events are on disk
//   state.prev.json  the previous committed state (kept at every commit), the base for a rebuild
//   events.ndjson    delta/v1 lines, append-only
// Leases live in <root>/leases.sqlite (compare-and-swap under BEGIN IMMEDIATE), so two runs can never both take a board.
//
// Commit order: events are appended and fsynced first, then the state is renamed into place. A crash between the two leaves events with
// seq > state.seq at the end of the log; openBoard() cuts them (only when the state itself was read cleanly), so the next run re-issues
// those seq numbers with its own content. Readers (readEvents) never see them: they stop at the committed state's seq. So a consumer
// never sees two different events under one (board, seq).
//
// Fail closed: a state.json that exists but cannot be read is NEVER replaced by an empty state (that would reset seq to 0 and truncate the
// log). The state is rebuilt from state.prev.json plus the events after it (or from the whole log), the unreadable file is kept as
// state.json.corrupt-<time>, and the rebuilt state records how it was made (state.rebuilt). Miss counters restart at 0 on a rebuild:
// a departure can come one cadence later, never earlier.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../id.mjs';
import { emptyState } from '../delta/board-delta.mjs';
import { loadSqlite } from './sqlite-load.mjs';

export const boardKey = (board) => `${String(board).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'board'}-${sha256(board).slice(0, 8)}`;
const dirOf = (root, board) => join(root, 'boards', boardKey(board));

export class StateError extends Error {}

/** { ok, value } | { missing } | { corrupt } for a JSON file. */
function readState(f) {
  if (!existsSync(f)) return { missing: true };
  try {
    const v = JSON.parse(readFileSync(f, 'utf8'));
    if (!v || typeof v !== 'object' || !Number.isInteger(v.seq) || typeof v.postings !== 'object') return { corrupt: true };
    return { ok: true, value: v };
  } catch { return { corrupt: true }; }
}

function readEventsFile(f) {
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function fsyncDir(dir) {
  // directory fsync makes the rename durable on POSIX; Windows cannot open a directory for fsync (EPERM/EISDIR): skipped there
  let fd;
  try { fd = openSync(dir, 'r'); fsyncSync(fd); } catch {} finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

function writeDurable(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

/** Applies logged events to a state (rebuild). Miss counters are not in the log; they restart at 0 (a departure can only come later). */
export function replayEvents(base, events) {
  const s = structuredClone(base);
  for (const e of events) {
    if (!(e.seq > s.seq)) continue;
    s.seq = e.seq;
    if (e.op === 'added' || e.op === 'changed' || e.op === 'reappeared') {
      const p = e.posting ?? {};
      const cur = s.postings[e.id] ?? { first_seen: e.t, misses: 0 };
      s.postings[e.id] = { ...cur, url: p.url ?? cur.url, title: p.title ?? cur.title ?? '', location: p.jobLocation?.[0]?.address?.name ?? cur.location ?? '',
        posted: p.datePosted ?? cur.posted ?? '', dh: p.jobcrawl?.content_hash ?? cur.dh ?? null, first_seen: p.jobcrawl?.first_seen ?? cur.first_seen,
        last_seen: e.t, misses: 0, status: 'open' };
    } else if (e.op === 'departed' && s.postings[e.id]) {
      Object.assign(s.postings[e.id], { status: 'departed', departed_at: e.t, last_seen: e.last_seen ?? s.postings[e.id].last_seen });
    } else if (e.op === 'board-ok') {
      s.runs = (s.runs ?? 0) + 1; s.last_run = e.t; s.last_ok = e.t;
      if (e.complete) s.last_complete = e.t;
    } else if (e.op === 'board-failed') {
      s.runs = (s.runs ?? 0) + 1; s.last_run = e.t;
    }
  }
  return s;
}

/** Loads a board's state (or a fresh one), repairs a log that ran ahead of a cleanly read state, rebuilds an unreadable state. */
export function openBoard(root, board, { log = () => {} } = {}) {
  const dir = dirOf(root, board);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'board.txt'))) writeFileSync(join(dir, 'board.txt'), String(board) + '\n');
  const stFile = join(dir, 'state.json'), evFile = join(dir, 'events.ndjson');
  const st = readState(stFile);
  const ev = readEventsFile(evFile);
  if (st.ok) {
    if (st.value.board !== board) throw new StateError(`${stFile} belongs to board "${st.value.board}", not "${board}"`);
    if (ev.some((e) => e.seq > st.value.seq)) {
      writeDurable(evFile, ev.filter((e) => e.seq <= st.value.seq).map((e) => JSON.stringify(e) + '\n').join(''));
      log(`[store] ${board}: cut ${ev.filter((e) => e.seq > st.value.seq).length} uncommitted events after seq ${st.value.seq}`);
    }
    return st.value;
  }
  if (st.missing && !ev.length) return emptyState(board);
  // fail closed: rebuild, never reset
  const prev = readState(join(dir, 'state.prev.json'));
  const base = prev.ok && prev.value.board === board ? prev.value : emptyState(board);
  const rebuilt = replayEvents(base, ev);
  rebuilt.rebuilt = { at: new Date().toISOString(), from: prev.ok ? `state.prev.json@${base.seq}` : 'empty', events: ev.filter((e) => e.seq > base.seq).length,
    reason: st.corrupt ? 'state.json unreadable' : 'state.json missing with a non-empty log' };
  if (st.corrupt) renameSync(stFile, `${stFile}.corrupt-${Date.now()}`);
  writeDurable(stFile, JSON.stringify(rebuilt));
  fsyncDir(dir);
  log(`[store] ${board}: state rebuilt (${rebuilt.rebuilt.reason}) from ${rebuilt.rebuilt.from} + ${rebuilt.rebuilt.events} events -> seq ${rebuilt.seq}`);
  return rebuilt;
}

/** Appends the run's events (fsync), keeps the previous state, then replaces the state durably. */
export function commitRun(root, board, state, events) {
  const dir = dirOf(root, board);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'board.txt'))) writeFileSync(join(dir, 'board.txt'), String(board) + '\n');
  if (events.length) {
    const fd = openSync(join(dir, 'events.ndjson'), 'a');
    try { writeSync(fd, events.map((e) => JSON.stringify(e) + '\n').join('')); fsyncSync(fd); } finally { closeSync(fd); }
  }
  const stFile = join(dir, 'state.json');
  const cur = readState(stFile);
  if (cur.ok) writeDurable(join(dir, 'state.prev.json'), JSON.stringify(cur.value));
  writeDurable(stFile, JSON.stringify(state));
  fsyncDir(dir);
  return { seqFrom: events[0]?.seq ?? null, seqTo: events.at(-1)?.seq ?? null };
}

// ---- leases: compare-and-swap in SQLite ----
const leaseDbs = new Map();
async function leaseDb(root) {
  if (!leaseDbs.has(root)) {
    const { DatabaseSync } = await loadSqlite();
    mkdirSync(root, { recursive: true });
    const db = new DatabaseSync(join(root, 'leases.sqlite'));
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS leases (board TEXT PRIMARY KEY, token TEXT NOT NULL, owner TEXT, expires INTEGER NOT NULL);');
    leaseDbs.set(root, db);
  }
  return leaseDbs.get(root);
}

/**
 * Takes the board's lease for ttlMs (atomic: BEGIN IMMEDIATE, read, write if free or expired, commit). Returns a release function, or
 * null while another live lease holds it. `db` may be passed (tests: two handles = two processes).
 */
export async function lease(root, board, ttlMs = 15 * 60e3, now = Date.now, { db, busyMs = 5000 } = {}) {
  const d = db ?? (await leaseDb(root));
  const token = randomUUID();
  d.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(busyMs))}`);
  d.exec('BEGIN IMMEDIATE');
  try {
    const cur = d.prepare('SELECT token, expires FROM leases WHERE board = ?').get(board);
    if (cur && cur.expires > now()) { d.exec('COMMIT'); return null; }
    d.prepare('INSERT INTO leases (board, token, owner, expires) VALUES (?, ?, ?, ?) ON CONFLICT(board) DO UPDATE SET token = excluded.token, owner = excluded.owner, expires = excluded.expires')
      .run(board, token, `${hostname()}:${process.pid}`, now() + ttlMs);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return () => { try { d.prepare('DELETE FROM leases WHERE board = ? AND token = ?').run(board, token); } catch {} };
}

/**
 * Read-only view of a board's committed state for importers (never writes: no board.txt, no log cut, no rebuild, unlike openBoard).
 * Returns { ok, value } | { missing } | { corrupt }.
 */
export function readBoardState(root, board) {
  const st = readState(join(dirOf(root, board), 'state.json'));
  if (st.ok && st.value.board !== board) return { corrupt: true, reason: `state belongs to board "${st.value.board}"` };
  return st;
}

/** Board names in a store. */
export function listBoards(root) {
  const base = join(root, 'boards');
  if (!existsSync(base)) return [];
  return readdirSync(base).map((k) => { try { return readFileSync(join(base, k, 'board.txt'), 'utf8').trim(); } catch { return null; } }).filter(Boolean);
}

/** The committed seq of a board (null when its state cannot be read: its events are then withheld until openBoard rebuilds it). */
function committedSeq(root, board) {
  const st = readState(join(dirOf(root, board), 'state.json'));
  return st.ok ? st.value.seq : null;
}

/** Committed delta events after the given watermarks ({ board: lastAppliedSeq }), board by board in seq order. */
export function* readEvents(root, since = {}) {
  for (const board of listBoards(root)) {
    const upto = committedSeq(root, board);
    if (upto == null) continue;
    const after = Object.hasOwn(since, board) ? since[board] : 0;
    for (const e of readEventsFile(join(dirOf(root, board), 'events.ndjson'))) if (e.seq > after && e.seq <= upto) yield e;
  }
}

/** A full snapshot: a header line with the per-board watermarks, then one posting per line. */
export function* snapshot(root, { status = 'open' } = {}) {
  const boards = listBoards(root);
  const states = boards.map((b) => [b, readState(join(dirOf(root, b), 'state.json'))]).filter(([, s]) => s.ok).map(([b, s]) => [b, s.value]);
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
