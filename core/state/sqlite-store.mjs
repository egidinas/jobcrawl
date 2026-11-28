// SQLite backend of the state store (design §3.5, row 1.1). One file, <root>/store.sqlite, shared by every process on a data folder.
//
// Connection: busy_timeout first (so a concurrent first open waits instead of failing), then WAL, synchronous=FULL, foreign keys.
// Every write is one BEGIN IMMEDIATE transaction (the write lock is taken up front, never a deferred read upgraded to a write), so writers
// are serialised by SQLite and readers see only committed transactions. A process killed mid-transaction leaves nothing of it: the WAL
// frames of an uncommitted transaction are ignored on the next open.
//
// Tables (schema version in PRAGMA user_version):
//   boards        board -> committed per-board seq + the board state without its postings (board-state/v1 fields)
//   postings      (board, id) -> the posting record, stored losslessly as JSON (status as its own column)
//   events        event_id INTEGER PRIMARY KEY AUTOINCREMENT: ONE global commit sequence over all boards (increasing in commit order,
//                 because writers are serialised), plus the per-board seq of delta/v1 (unique per board) for compatibility.
//                 Rows with seq NULL are store records outside delta/v1's per-board numbering: op 'refreshed' (a posting's snapshot
//                 fields changed without a delta event: a URL variant, a description hash filled in, a baseline row refreshed).
//   ids           posting id -> the canonical key it was assigned under (ids are stored facts, assigned at first sight)
//   id_alias      other keys that resolve to a stored id (the normalised-URL key at first sight; a new key after a key-rule change)
//   bookmarks     named consumer -> last applied event_id
//   leases        per-board lease (token, owner, expiry)
//   host_slots    shared per-host concurrency slots (token, owner, expiry): a crashed holder's slot expires
//   cooldowns     per-host "do not request before" (429 Retry-After, WAF), shared by every process
//   breakers      time-window circuit breaker per key (open_until), with breaker_events (the window's outcomes)
//   imports       one row per board imported from the JSON store (seq and event_id at import; imports emit no events)
import { mkdirSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalKey, idForKey, normaliseUrl } from '../id.mjs';
import { splitText } from '../text.mjs';
import { emptyState, toPosting, DELTA_SCHEMA } from '../delta/board-delta.mjs';
import { PRODUCER } from '../compat/envelope.mjs';
import { StateError, listBoards as listJsonBoards, readBoardState } from './board-store.mjs';
import { loadSqlite } from './sqlite-load.mjs';

export const SQLITE_FILE = 'store.sqlite';
export const SQLITE_SCHEMA_VERSION = 1;
const OWNER = () => `${hostname()}:${process.pid}`;

const DDL = `
CREATE TABLE IF NOT EXISTS boards (board TEXT PRIMARY KEY, seq INTEGER NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS postings (board TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, rec TEXT NOT NULL, PRIMARY KEY (board, id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS postings_status ON postings (status, board);
CREATE TABLE IF NOT EXISTS events (event_id INTEGER PRIMARY KEY AUTOINCREMENT, board TEXT NOT NULL, seq INTEGER, op TEXT NOT NULL, id TEXT, t TEXT, body TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS events_board_seq ON events (board, seq) WHERE seq IS NOT NULL;
CREATE TABLE IF NOT EXISTS ids (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, board TEXT, first_seen TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS id_alias (key TEXT PRIMARY KEY, id TEXT NOT NULL REFERENCES ids (id), reason TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bookmarks (consumer TEXT PRIMARY KEY, event_id INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS leases (board TEXT PRIMARY KEY, token TEXT NOT NULL, owner TEXT, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS host_slots (token TEXT PRIMARY KEY, host TEXT NOT NULL, owner TEXT, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS host_slots_host ON host_slots (host, expires);
CREATE TABLE IF NOT EXISTS cooldowns (host TEXT PRIMARY KEY, until INTEGER NOT NULL, reason TEXT, set_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS breakers (key TEXT PRIMARY KEY, open_until INTEGER NOT NULL, opened_at INTEGER NOT NULL, failures INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS breaker_events (key TEXT NOT NULL, t INTEGER NOT NULL, ok INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS breaker_events_key ON breaker_events (key, t);
CREATE TABLE IF NOT EXISTS board_cadence (board TEXT PRIMARY KEY, next_due INTEGER NOT NULL, last_run INTEGER, last_ok INTEGER, failures INTEGER NOT NULL DEFAULT 0, last_cls TEXT, last_error TEXT, interval_ms INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS posting_text (id TEXT NOT NULL, content_hash TEXT NOT NULL, excerpt TEXT NOT NULL, description TEXT, PRIMARY KEY (id, content_hash)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS imports (board TEXT PRIMARY KEY, source TEXT, seq INTEGER NOT NULL, event_id INTEGER NOT NULL, postings INTEGER NOT NULL, at TEXT NOT NULL);
`;

/** The candidate keys of a posting URL, strongest first: the canonical key, then the normalised-URL key. */
export const defaultKeysOf = (url) => [...new Set([canonicalKey(url), `url:${normaliseUrl(url)}`])];

/** The snapshot-visible projection of a posting record (posting/v1 without last_seen, which changes on every read without an event). */
export function projection(board, id, rec) {
  const p = toPosting(board, id, rec);
  delete p.jobcrawl.last_seen;
  return p;
}
const PROJ_FIELDS = (a, b) => {
  const out = [];
  for (const k of ['title', 'url', 'datePosted', 'jobLocation']) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  for (const k of ['status', 'first_seen', 'content_hash']) if (a.jobcrawl[k] !== b.jobcrawl[k]) out.push(k);
  return out;
};
const EVENT_OPS = new Set(['added', 'changed', 'reappeared', 'departed']);

export class SqliteStore {
  constructor(DatabaseSync, root, { file = join(root, SQLITE_FILE), busyMs = 5000, clock = Date.now, keysOf = defaultKeysOf, keepDescription = false, storeText = false } = {}) {
    this.keepDescription = keepDescription;
    this.storeText = storeText;
    this.textWrites = 0;
    this.kind = 'sqlite';
    this.root = root; this.file = file; this.clock = clock; this.keysOf = keysOf;
    if (file !== ':memory:') mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(busyMs))}`);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
    this._tx(() => {
      const v = this.db.prepare('PRAGMA user_version').get().user_version;
      if (v > SQLITE_SCHEMA_VERSION) throw new StateError(`${file}: schema version ${v} is newer than this jobcrawl (${SQLITE_SCHEMA_VERSION})`);
      this.db.exec(DDL);
      if (v < SQLITE_SCHEMA_VERSION) this.db.exec(`PRAGMA user_version=${SQLITE_SCHEMA_VERSION}`);
    });
  }

  /** Every backend error surfaces as a StateError (the runner maps those to exit 4, never to a board failure). */
  _wrap(fn) {
    try { return fn(); } catch (e) {
      if (e instanceof StateError) throw e;
      const err = new StateError(`sqlite store (${this.file}): ${e?.message ?? e}`);
      err.cause = e; err.code = e?.code; err.errcode = e?.errcode;
      throw err;
    }
  }
  /** One write transaction, write lock taken up front. */
  _tx(fn) {
    return this._wrap(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
    });
  }
  /** One read transaction (a consistent WAL snapshot across several statements). */
  _read(fn) {
    return this._wrap(() => {
      this.db.exec('BEGIN');
      try { return fn(); } finally { try { this.db.exec('COMMIT'); } catch {} }
    });
  }

  /**
   * Runs fn(db) in one write transaction (BEGIN IMMEDIATE) and returns its result; a throw rolls everything back. Additive seam for a
   * consumer that commits its own tables together with its position in the event log (the resolver, core/resolve/resolver.mjs).
   */
  withTransaction(fn) { return this._tx(() => fn(this.db)); }
  /** Runs fn(db) in one read transaction (a consistent snapshot across statements). */
  readTransaction(fn) { return this._read(() => fn(this.db)); }

  // ---- board state ----
  listBoards() { return this._wrap(() => this.db.prepare('SELECT board FROM boards ORDER BY board').all().map((r) => r.board)); }

  /** The board's committed state (board-state/v1, postings included), or a fresh one. Read-only. */
  openBoard(board) {
    return this._read(() => {
      const b = this.db.prepare('SELECT seq, state FROM boards WHERE board = ?').get(board);
      if (!b) return emptyState(board);
      const s = JSON.parse(b.state);
      s.seq = b.seq; s.postings = {};
      for (const r of this.db.prepare('SELECT id, rec FROM postings WHERE board = ? ORDER BY id').all(board)) s.postings[r.id] = JSON.parse(r.rec);
      return s;
    });
  }

  /**
   * Commits one run atomically: the board's new state, its postings, its delta events (global event_id + per-board seq), the 'refreshed'
   * records and the run's new ids. The stored seq must be the base this state was derived from (state.seq - events.length); a writer
   * whose base moved (lease lost, a second writer) gets a StateError and nothing is written.
   * opts: { ids: [{ id, key, board, first_seen }], aliases: [{ key, id, reason }], beforeCommit() (test seam: runs inside the tx) }
   */
  commitRun(board, state, events, { ids = [], aliases = [], beforeCommit } = {}) {
    if (state.board !== board) throw new StateError(`commitRun: state is for "${state.board}", not "${board}"`);
    const base = state.seq - events.length;
    events.forEach((e, i) => { if (e.seq !== base + i + 1 || e.board !== board) throw new StateError(`commitRun: event ${i} of ${board} has seq ${e.seq}, expected ${base + i + 1}`); });
    return this._tx(() => {
      const cur = this.db.prepare('SELECT seq FROM boards WHERE board = ?').get(board);
      const curSeq = cur?.seq ?? 0;
      if (curSeq !== base) throw new StateError(`commitRun: ${board} is at seq ${curSeq} in the store, the run was built on seq ${base} (stale writer)`);
      const t = state.last_run ?? new Date(this.clock()).toISOString();
      // ids first (postings and events reference them only logically, but a run's ids are facts from this commit on)
      const insId = this.db.prepare('INSERT OR IGNORE INTO ids (id, key, board, first_seen) VALUES (?, ?, ?, ?)');
      const insAlias = this.db.prepare('INSERT OR IGNORE INTO id_alias (key, id, reason, at) VALUES (?, ?, ?, ?)');
      for (const r of ids) insId.run(r.id, r.key, r.board ?? board, r.first_seen ?? t);
      for (const a of aliases) if (this.db.prepare('SELECT 1 FROM ids WHERE id = ?').get(a.id)) insAlias.run(a.key, a.id, a.reason ?? null, t);
      // postings: write the changed records; snapshot-visible changes without an event become 'refreshed' records
      const old = new Map(this.db.prepare('SELECT id, rec FROM postings WHERE board = ?').all(board).map((r) => [r.id, r.rec]));
      const touched = new Set(events.filter((e) => EVENT_OPS.has(e.op)).map((e) => e.id));
      const up = this.db.prepare('INSERT INTO postings (board, id, status, rec) VALUES (?, ?, ?, ?) ON CONFLICT (board, id) DO UPDATE SET status = excluded.status, rec = excluded.rec');
      const refreshed = [];
      // text lives in posting_text (id + content_hash), not in the posting record: an unchanged posting writes nothing
      const texts = new Map(this.db.prepare('SELECT t.id AS id, t.content_hash AS h, t.excerpt AS excerpt, t.description AS description FROM posting_text t JOIN postings p ON p.id = t.id WHERE p.board = ?').all(board).map((r) => [r.id, r]));
      for (const [id, rec] of Object.entries(state.postings ?? {})) {
        const { slim, text } = splitText(rec);
        if (text) this._putText(id, rec.dh ?? '', text, texts.get(id));
        const js = JSON.stringify(slim);
        const prevJs = old.get(id);
        old.delete(id);
        if (prevJs === js) continue;
        up.run(board, id, String(rec.status ?? 'open'), js);
        if (prevJs !== undefined && !touched.has(id)) {
          const a = projection(board, id, JSON.parse(prevJs)), b = projection(board, id, slim);
          const fields = PROJ_FIELDS(a, b);
          if (fields.length) refreshed.push({ id, fields, posting: toPosting(board, id, rec) });
        } else if (prevJs === undefined && !touched.has(id)) {
          refreshed.push({ id, fields: ['new'], posting: toPosting(board, id, rec) });
        }
      }
      const del = this.db.prepare('DELETE FROM postings WHERE board = ? AND id = ?');
      const delText = this.db.prepare('DELETE FROM posting_text WHERE id = ?');
      for (const id of old.keys()) { del.run(board, id); delText.run(id); }
      // events, in order; then the store records
      const ins = this.db.prepare('INSERT INTO events (board, seq, op, id, t, body) VALUES (?, ?, ?, ?, ?, ?)');
      let first = null, last = null;
      for (const e of events) {
        const r = ins.run(board, e.seq, e.op, e.id ?? null, e.t ?? null, JSON.stringify(e));
        last = Number(r.lastInsertRowid); first ??= last;
      }
      const run = events[0]?.run ?? `${t}#store`;
      for (const r of refreshed) {
        const body = { schema: DELTA_SCHEMA, producer: PRODUCER, board, seq: null, run, t, op: 'refreshed', id: r.id, fields: r.fields, posting: r.posting };
        const x = ins.run(board, null, 'refreshed', r.id, t, JSON.stringify(body));
        last = Number(x.lastInsertRowid); first ??= last;
      }
      const { postings, ...meta } = state;
      this.db.prepare('INSERT INTO boards (board, seq, state, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (board) DO UPDATE SET seq = excluded.seq, state = excluded.state, updated_at = excluded.updated_at')
        .run(board, state.seq, JSON.stringify(meta), new Date(this.clock()).toISOString());
      beforeCommit?.();
      return { seqFrom: events[0]?.seq ?? null, seqTo: events.at(-1)?.seq ?? null, eventFrom: first, eventTo: last, refreshed: refreshed.length };
    });
  }

  /** Writes one posting's text when it differs from what is stored; older content hashes of the id are dropped. */
  _putText(id, hash, text, cur) {
    const desc = text.description ?? null;
    if (cur && cur.h === hash && cur.excerpt === text.excerpt && (desc === null || cur.description === desc)) return;
    this.textWrites = (this.textWrites ?? 0) + 1;
    this.db.prepare('INSERT INTO posting_text (id, content_hash, excerpt, description) VALUES (?, ?, ?, ?) ON CONFLICT (id, content_hash) DO UPDATE SET excerpt = excluded.excerpt, description = COALESCE(excluded.description, description)')
      .run(id, hash, text.excerpt, desc);
    this.db.prepare('DELETE FROM posting_text WHERE id = ? AND content_hash <> ?').run(id, hash);
  }

  // ---- ids as stored facts ----
  /**
   * A per-run id resolver: idOf(url) returns the stored id of the URL's posting (looked up by its canonical key, then by its other keys
   * via the alias table), or assigns a new one (idForKey(canonical key)) at first sight. New ids and aliases are only written by the
   * commitRun that gets pending() (same transaction as the run). prime(items) names the canonical keys listed in this run: a fallback
   * key never resolves to an id whose own key is listed in the same run (two postings that share a normalised URL stay apart).
   */
  idResolver({ board, now = () => new Date(this.clock()) } = {}) {
    const getId = this.db.prepare('SELECT id, key FROM ids WHERE key = ?');
    const getAlias = this.db.prepare('SELECT a.id AS id, i.key AS key FROM id_alias a JOIN ids i ON i.id = a.id WHERE a.key = ?');
    const lookup = (k) => this._wrap(() => getId.get(k) ?? getAlias.get(k) ?? null);
    const memo = new Map(), newIds = new Map(), newByKey = new Map(), aliases = new Map(), live = new Set();
    const keysOf = this.keysOf;
    const idOf = (url) => {
      const keys = keysOf(url);
      const primary = keys[0];
      if (memo.has(primary)) return memo.get(primary);
      let id = null;
      const hit = lookup(primary);
      if (hit) id = hit.id;
      else {
        for (const k of keys.slice(1)) {
          const h = lookup(k) ?? newByKey.get(k) ?? null;
          if (h && !live.has(h.key ?? h.primary)) { id = h.id; aliases.set(primary, { key: primary, id, reason: `rule-change from ${k}` }); break; }
        }
        if (!id) {
          id = idForKey(primary);
          const n = { id, key: primary, primary, keys, board, first_seen: now().toISOString() };
          newIds.set(primary, n);
          for (const k of keys.slice(1)) if (!newByKey.has(k)) newByKey.set(k, n);
          for (const k of keys.slice(1)) if (!lookup(k) && !aliases.has(k)) aliases.set(k, { key: k, id, reason: 'first-sight' });
        }
      }
      memo.set(primary, id);
      return id;
    };
    return {
      idOf,
      prime: (items) => { for (const it of items ?? []) if (it?.url) live.add(keysOf(it.url)[0]); },
      pending: () => ({ ids: [...newIds.values()].map(({ id, key, board: b, first_seen }) => ({ id, key, board: b, first_seen })), aliases: [...aliases.values()] }),
    };
  }

  /** Adds an alias key for a stored id (an explicit merge or a moved posting). */
  addAlias(key, id, reason = 'manual') {
    return this._tx(() => {
      if (!this.db.prepare('SELECT 1 FROM ids WHERE id = ?').get(id)) throw new StateError(`addAlias: unknown id ${id}`);
      this.db.prepare('INSERT INTO id_alias (key, id, reason, at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET id = excluded.id, reason = excluded.reason, at = excluded.at')
        .run(key, id, reason, new Date(this.clock()).toISOString());
    });
  }
  /** The stored id of a key (canonical or alias), or null. */
  idOfKey(key) { return this._wrap(() => (this.db.prepare('SELECT id FROM ids WHERE key = ?').get(key) ?? this.db.prepare('SELECT id FROM id_alias WHERE key = ?').get(key))?.id ?? null); }

  // ---- events and consumers ----
  maxEventId() { return this._wrap(() => Number(this.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS m FROM events').get().m)); }

  /** Committed records after a global event_id, in commit order: [{ event_id, ...delta/v1 }] (store records have seq null). */
  events({ after = 0, limit = 1000 } = {}) {
    return this._wrap(() => this.db.prepare('SELECT event_id, body FROM events WHERE event_id > ? ORDER BY event_id LIMIT ?')
      .all(Number(after) || 0, Math.max(1, Math.min(100000, Number(limit) || 1000))).map((r) => ({ event_id: Number(r.event_id), ...JSON.parse(r.body) })));
  }

  /** Compatibility: committed delta/v1 events after per-board watermarks ({ board: lastAppliedSeq }); store records are not included. */
  *readEvents(since = {}) {
    const rows = this._wrap(() => this.db.prepare('SELECT event_id, board, seq, body FROM events WHERE seq IS NOT NULL ORDER BY board, seq').all());
    for (const r of rows) if (r.seq > (Object.hasOwn(since, r.board) ? since[r.board] : 0)) yield JSON.parse(r.body);
  }

  bookmarkGet(consumer) { return this._wrap(() => Number(this.db.prepare('SELECT event_id FROM bookmarks WHERE consumer = ?').get(String(consumer))?.event_id ?? 0)); }
  bookmarkSet(consumer, eventId) {
    const v = Number(eventId);
    if (!consumer || !Number.isInteger(v) || v < 0) throw new StateError('bookmarkSet: a consumer name and an event_id >= 0 are required');
    return this._tx(() => {
      const max = Number(this.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS m FROM events').get().m);
      if (v > max) throw new StateError(`bookmarkSet: event_id ${v} is beyond the last committed event (${max})`);
      this.db.prepare('INSERT INTO bookmarks (consumer, event_id, updated_at) VALUES (?, ?, ?) ON CONFLICT (consumer) DO UPDATE SET event_id = excluded.event_id, updated_at = excluded.updated_at')
        .run(String(consumer), v, new Date(this.clock()).toISOString());
      return v;
    });
  }
  bookmarks() { return this._wrap(() => this.db.prepare('SELECT consumer, event_id, updated_at FROM bookmarks ORDER BY consumer').all().map((r) => ({ ...r, event_id: Number(r.event_id) }))); }

  /** A full snapshot, read in one transaction: a header (global event_id and per-board seq watermarks), then posting/v1 rows. */
  snapshot({ status = 'open' } = {}) {
    return this._read(() => {
      const head = { schema: 'snapshot/v1', t: new Date(this.clock()).toISOString(), event_id: Number(this.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS m FROM events').get().m),
        watermarks: Object.fromEntries(this.db.prepare('SELECT board, seq FROM boards ORDER BY board').all().map((r) => [r.board, r.seq])) };
      const rows = status
        ? this.db.prepare('SELECT board, id, rec FROM postings WHERE status = ? ORDER BY board, id').all(status)
        : this.db.prepare('SELECT board, id, rec FROM postings ORDER BY board, id').all();
      const text = new Map(this.db.prepare('SELECT id, content_hash AS h, excerpt, description FROM posting_text').all().map((t) => [t.id, t]));
      return [head, ...rows.map((r) => {
        const rec = JSON.parse(r.rec), t = text.get(r.id);
        if (t && t.h === (rec.dh ?? '')) { rec.excerpt = t.excerpt; if (t.description) rec.description = t.description; }
        return toPosting(r.board, r.id, rec);
      })];
    });
  }

  // ---- leases ----
  /** The board's lease for ttlMs, or null while another live lease holds it. Returns a release function. */
  lease(board, ttlMs = 15 * 60e3, now = this.clock) {
    const token = randomUUID();
    const got = this._tx(() => {
      const cur = this.db.prepare('SELECT expires FROM leases WHERE board = ?').get(board);
      if (cur && cur.expires > now()) return false;
      this.db.prepare('INSERT INTO leases (board, token, owner, expires) VALUES (?, ?, ?, ?) ON CONFLICT (board) DO UPDATE SET token = excluded.token, owner = excluded.owner, expires = excluded.expires')
        .run(board, token, OWNER(), now() + ttlMs);
      return true;
    });
    if (!got) return null;
    return () => { try { this._tx(() => this.db.prepare('DELETE FROM leases WHERE board = ? AND token = ?').run(board, token)); } catch {} };
  }

  // ---- shared host slots, cooldowns, breaker (one view for every process on the data folder) ----
  /**
   * Takes one of `limit` slots of a host for ttlMs. Returns { token, release(), renew(ms) } or { wait, reason: 'cooldown'|'slots', until }.
   * Expired slots (a crashed holder) are purged first, so a dead process blocks a host for at most its ttl.
   */
  acquireHost(host, { limit = 1, ttlMs = 60e3, owner = OWNER(), now = this.clock } = {}) {
    const t = now();
    const r = this._tx(() => {
      const cd = this.db.prepare('SELECT until, reason FROM cooldowns WHERE host = ?').get(host);
      if (cd && cd.until > t) return { wait: cd.until - t, reason: 'cooldown', until: cd.until, detail: cd.reason };
      this.db.prepare('DELETE FROM host_slots WHERE host = ? AND expires <= ?').run(host, t);
      const held = this.db.prepare('SELECT COUNT(*) AS n, MIN(expires) AS first FROM host_slots WHERE host = ?').get(host);
      if (held.n >= limit) return { wait: held.first - t, reason: 'slots', until: held.first };
      const token = randomUUID();
      this.db.prepare('INSERT INTO host_slots (token, host, owner, expires) VALUES (?, ?, ?, ?)').run(token, host, owner, t + ttlMs);
      return { token };
    });
    if (!r.token) return r;
    return { token: r.token,
      release: () => { try { this._tx(() => this.db.prepare('DELETE FROM host_slots WHERE token = ?').run(r.token)); } catch {} },
      renew: (ms = ttlMs) => this._tx(() => Number(this.db.prepare('UPDATE host_slots SET expires = ? WHERE token = ?').run(now() + ms, r.token).changes) === 1) };
  }
  hostSlots(host, now = this.clock) { return this._wrap(() => Number(this.db.prepare('SELECT COUNT(*) AS n FROM host_slots WHERE host = ? AND expires > ?').get(host, now()).n)); }

  /** Sets a host cooldown until `until` (ms epoch); an existing later cooldown is kept. */
  setCooldown(host, until, reason = null, now = this.clock) {
    return this._tx(() => {
      this.db.prepare('INSERT INTO cooldowns (host, until, reason, set_at) VALUES (?, ?, ?, ?) ON CONFLICT (host) DO UPDATE SET until = MAX(until, excluded.until), reason = CASE WHEN excluded.until >= until THEN excluded.reason ELSE reason END, set_at = excluded.set_at')
        .run(host, Math.floor(until), reason, now());
    });
  }
  cooldown(host, now = this.clock) {
    return this._wrap(() => { const r = this.db.prepare('SELECT until, reason FROM cooldowns WHERE host = ?').get(host); return r && r.until > now() ? { until: r.until, reason: r.reason } : null; });
  }

  /**
   * Records one outcome for a breaker key (host or board). Time-window rule: `threshold` failures within `windowMs` open the breaker for
   * `openMs`; after that it is half-open: the next failure re-opens it at once, the next success closes it (and clears the window).
   * Returns the state after the record.
   */
  breakerRecord(key, ok, { windowMs = 10 * 60e3, threshold = 5, openMs = 15 * 60e3, now = this.clock } = {}) {
    const t = now();
    return this._tx(() => {
      const row = this.db.prepare('SELECT open_until FROM breakers WHERE key = ?').get(key);
      if (ok) {
        this.db.prepare('DELETE FROM breaker_events WHERE key = ?').run(key);
        this.db.prepare('DELETE FROM breakers WHERE key = ?').run(key);
        return { state: 'closed', failures: 0 };
      }
      this.db.prepare('INSERT INTO breaker_events (key, t, ok) VALUES (?, ?, 0)').run(key, t);
      this.db.prepare('DELETE FROM breaker_events WHERE key = ? AND t <= ?').run(key, t - windowMs);
      const failures = Number(this.db.prepare('SELECT COUNT(*) AS n FROM breaker_events WHERE key = ? AND ok = 0').get(key).n);
      const halfOpen = row && row.open_until <= t;
      if (failures >= threshold || halfOpen) {
        this.db.prepare('INSERT INTO breakers (key, open_until, opened_at, failures) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET open_until = excluded.open_until, opened_at = excluded.opened_at, failures = excluded.failures')
          .run(key, t + openMs, t, failures);
        return { state: 'open', until: t + openMs, failures };
      }
      return row ? { state: 'open', until: row.open_until, failures } : { state: 'closed', failures };
    });
  }
  breakerState(key, now = this.clock) {
    return this._wrap(() => {
      const row = this.db.prepare('SELECT open_until, failures FROM breakers WHERE key = ?').get(key);
      if (!row) return { state: 'closed' };
      return row.open_until > now() ? { state: 'open', until: row.open_until, failures: row.failures } : { state: 'half-open', since: row.open_until, failures: row.failures };
    });
  }

  // ---- per-board cadence (run --due, core/headless/due.mjs): next_due, last_ok, consecutive failures; one row per board ----
  cadenceGet(board) { return this._wrap(() => this.db.prepare('SELECT * FROM board_cadence WHERE board = ?').get(board) ?? null); }
  cadenceList() { return this._wrap(() => this.db.prepare('SELECT * FROM board_cadence ORDER BY board').all()); }
  /** Upserts a board's cadence row; fields not given keep their value (a new row starts at failures 0). */
  cadenceSet(board, f, now = this.clock) {
    return this._tx(() => {
      const cur = this.db.prepare('SELECT * FROM board_cadence WHERE board = ?').get(board) ?? { next_due: 0, last_run: null, last_ok: null, failures: 0, last_cls: null, last_error: null, interval_ms: null };
      const m = { ...cur, ...f };
      this.db.prepare('INSERT INTO board_cadence (board, next_due, last_run, last_ok, failures, last_cls, last_error, interval_ms, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT (board) DO UPDATE SET next_due = excluded.next_due, last_run = excluded.last_run, last_ok = excluded.last_ok, failures = excluded.failures, last_cls = excluded.last_cls, last_error = excluded.last_error, interval_ms = excluded.interval_ms, updated_at = excluded.updated_at')
        .run(board, Math.floor(m.next_due), m.last_run ?? null, m.last_ok ?? null, m.failures, m.last_cls ?? null, m.last_error ?? null, m.interval_ms ?? null, now());
    });
  }

  // ---- import from the JSON store (no events) ----
  /**
   * Imports the JSON board states under jsonRoot (read-only on that side). Per board: its state (seq carried forward), its posting
   * records losslessly, and its ids as stored facts (the id a state holds is kept even when today's key rule would compute another one;
   * its keys become aliases). Emits NO events: the event log is untouched, and imports records seq and event_id at import.
   * A board already in this store is kept unless `replace`. Unreadable states are skipped and reported.
   */
  importJson(jsonRoot, { boards = null, replace = false, log = () => {} } = {}) {
    const names = boards ?? listJsonBoards(jsonRoot);
    const sum = { boards: names.length, imported: 0, replaced: 0, kept: 0, skipped: [], postings: 0, ids: 0, aliases: 0, events: 0 };
    const ev0 = this.maxEventId();
    for (const board of names) {
      const st = readBoardState(jsonRoot, board);
      if (!st.ok) { sum.skipped.push({ board, why: st.missing ? 'no state.json' : (st.reason ?? 'state.json unreadable') }); continue; }
      const s = st.value;
      this._tx(() => {
        const had = this.db.prepare('SELECT seq FROM boards WHERE board = ?').get(board);
        if (had && !replace) { sum.kept++; return; }
        if (had && had.seq > s.seq) throw new StateError(`importJson: ${board} is at seq ${had.seq} here, the JSON state at ${s.seq} (would reuse event numbers)`);
        this.db.prepare('DELETE FROM postings WHERE board = ?').run(board);
        const up = this.db.prepare('INSERT INTO postings (board, id, status, rec) VALUES (?, ?, ?, ?)');
        const insId = this.db.prepare('INSERT OR IGNORE INTO ids (id, key, board, first_seen) VALUES (?, ?, ?, ?)');
        const insAlias = this.db.prepare('INSERT OR IGNORE INTO id_alias (key, id, reason, at) VALUES (?, ?, ?, ?)');
        const at = new Date(this.clock()).toISOString();
        for (const [id, rec] of Object.entries(s.postings ?? {})) {
          const { slim, text } = splitText(rec);
          up.run(board, id, String(rec.status ?? 'open'), JSON.stringify(slim));
          if (text) this._putText(id, rec.dh ?? '', text, null);
          sum.postings++;
          if (!rec.url) continue;
          const keys = this.keysOf(rec.url);
          const own = keys.find((k) => idForKey(k) === id) ?? `legacy:${id}`;
          if (Number(insId.run(id, own, board, rec.first_seen ?? at).changes)) sum.ids++;
          for (const k of keys) if (k !== own && Number(insAlias.run(k, id, own.startsWith('legacy:') ? 'import (key rule changed)' : 'first-sight', at).changes)) sum.aliases++;
        }
        const { postings, ...meta } = s;
        this.db.prepare('INSERT INTO boards (board, seq, state, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (board) DO UPDATE SET seq = excluded.seq, state = excluded.state, updated_at = excluded.updated_at')
          .run(board, s.seq, JSON.stringify(meta), at);
        this.db.prepare('INSERT INTO imports (board, source, seq, event_id, postings, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (board) DO UPDATE SET source = excluded.source, seq = excluded.seq, event_id = excluded.event_id, postings = excluded.postings, at = excluded.at')
          .run(board, jsonRoot, s.seq, ev0, Object.keys(s.postings ?? {}).length, at);
        if (had) sum.replaced++; else sum.imported++;
      });
    }
    sum.events = this.maxEventId() - ev0;
    log(`[store] imported ${sum.imported}, replaced ${sum.replaced}, kept ${sum.kept}, skipped ${sum.skipped.length}; ${sum.postings} postings, ${sum.events} events`);
    return sum;
  }

  integrity() { return this._wrap(() => this.db.prepare('PRAGMA integrity_check').get().integrity_check); }
  close() { try { this.db.close(); } catch {} }
}

/** Opens (creates) the SQLite store of a data folder. */
export async function openSqliteStore(root, opts = {}) {
  const { DatabaseSync } = await loadSqlite();
  return new SqliteStore(DatabaseSync, root, opts);
}

export const hasSqliteStore = (root) => existsSync(join(root, SQLITE_FILE));
