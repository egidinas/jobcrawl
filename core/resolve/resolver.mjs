// The resolver job (design §3.3, row 1.4): a consumer of the per-board event log of a SQLite store (core/state/sqlite-store.mjs).
//
//   lease       one resolver at a time: a lease row for board "*" in the store's leases table, with a token. Every checkpoint checks that
//               the token is still ours (fencing) and extends the expiry; a resolver whose lease was taken over cannot commit.
//   bookmark    the last applied global event_id, in resolver_meta and mirrored as consumer "resolver" in the store's bookmarks table.
//               Records are applied in event_id order only, so the seq-null 'refreshed' records (1.1 open risk) need no per-board seq.
//   checkpoint  ONE BEGIN IMMEDIATE transaction per batch: the changed members and groups, the batch's resolved records, the derived
//               sets and the new bookmark (compare-and-swap on the old one). A crash before the commit leaves the previous checkpoint:
//               the batch is re-applied from the old bookmark onto the old state, so no resolved record is written twice.
//   bootstrap   a store imported from today's history has postings and no events (row 1.1/1.2): the first run seeds the groups from the
//               postings at the current max event_id (a baseline epoch: no resolved records), then follows the events after it.
//   clock       records carry their own time; holds and sweeps run at the batch's last event time, and once at `now` at the end of a run
//               (tickAtEnd), so a replay decides the same as the live run did.
// Tables (created on first use, next to the store's own): resolver_meta, resolver_members, resolver_groups, resolved, resolver_derived.
import { StateError } from '../state/board-store.mjs';
import { validate } from '../schema/validate.mjs';
import { createResolver, RESOLVED_SCHEMA } from './engine.mjs';
import { defaultFacts } from './facts.mjs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export const RESOLVER_BOARD = '*';
export const RESOLVER_CONSUMER = 'resolver';
export const RESOLVER_VERSION = 1;
const DDL = `
CREATE TABLE IF NOT EXISTS resolver_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resolver_members (board TEXT NOT NULL, id TEXT NOT NULL, rec TEXT NOT NULL, PRIMARY KEY (board, id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS resolver_groups (id TEXT PRIMARY KEY, status TEXT, rec TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS resolver_groups_status ON resolver_groups (status);
CREATE TABLE IF NOT EXISTS resolved (seq INTEGER PRIMARY KEY, src_event_id INTEGER NOT NULL, id TEXT NOT NULL, op TEXT NOT NULL, t TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resolver_derived (kind TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (kind, name)) WITHOUT ROWID;
`;

export class LeaseLost extends StateError {}

function requireSqlite(store) {
  if (!store || store.kind !== 'sqlite' || typeof store.withTransaction !== 'function') {
    throw new StateError('the resolver needs the SQLite store (a global event_id, bookmarks and transactions): run with --store sqlite');
  }
}

/** Creates the resolver tables (idempotent). */
export function ensureResolverTables(store) {
  requireSqlite(store);
  store.withTransaction((db) => db.exec(DDL));
}

/** Takes the resolver lease. -> { token, release() } or null while another live lease holds it. */
export function acquireResolverLease(store, ttlMs, now = Date.now) {
  const token = randomUUID();
  const ok = store.withTransaction((db) => {
    const cur = db.prepare('SELECT token, expires FROM leases WHERE board = ?').get(RESOLVER_BOARD);
    if (cur && cur.expires > now()) return false;
    db.prepare('INSERT INTO leases (board, token, owner, expires) VALUES (?, ?, ?, ?) ON CONFLICT (board) DO UPDATE SET token = excluded.token, owner = excluded.owner, expires = excluded.expires')
      .run(RESOLVER_BOARD, token, `${hostname()}:${process.pid}:resolver`, now() + ttlMs);
    return true;
  });
  if (!ok) return null;
  return { token, release: () => { try { store.withTransaction((db) => db.prepare('DELETE FROM leases WHERE board = ? AND token = ?').run(RESOLVER_BOARD, token)); } catch {} } };
}

/** Loads the persisted resolver state. -> { meta, state } (state null when the resolver never ran on this store). */
export function loadResolverState(store) {
  return store.readTransaction((db) => {
    const meta = Object.fromEntries(db.prepare('SELECT k, v FROM resolver_meta').all().map((r) => [r.k, JSON.parse(r.v)]));
    if (meta.bookmark == null) return { meta, state: null };
    const state = { v: RESOLVER_VERSION, seq: meta.seq ?? 0, ord: meta.ord ?? 0, members: {}, groups: {} };
    for (const r of db.prepare('SELECT board, id, rec FROM resolver_members').all()) state.members[`${r.board}\u0000${r.id}`] = JSON.parse(r.rec);
    for (const r of db.prepare('SELECT id, rec FROM resolver_groups').all()) state.groups[r.id] = JSON.parse(r.rec);
    return { meta, state };
  });
}

/**
 * Commits one checkpoint (see the header). expect: the bookmark this batch was built on (null for the bootstrap). Throws LeaseLost when
 * the lease token is no longer ours, StateError when the bookmark moved; nothing is written then.
 */
export function checkpoint(store, engine, { lease, expect, bookmark, srcEventId, leaseMs, now = Date.now, meta = {}, derived = null, beforeCommit } = {}) {
  const dirty = engine.dirty();
  const records = engine.drain();
  for (const r of records) {
    const errs = validate(r, 'resolved-v1');
    if (errs.length) throw new StateError(`resolved record ${r.seq} invalid: ${errs.slice(0, 3).join('; ')}`);
  }
  const st = engine.state;
  try {
    return store.withTransaction((db) => {
      const l = db.prepare('SELECT token FROM leases WHERE board = ?').get(RESOLVER_BOARD);
      if (!l || l.token !== lease.token) throw new LeaseLost('resolver lease lost (another resolver took it): nothing committed');
      const cur = db.prepare("SELECT v FROM resolver_meta WHERE k = 'bookmark'").get();
      const curBm = cur ? JSON.parse(cur.v) : null;
      if (curBm !== expect) throw new StateError(`resolver bookmark moved (${curBm} in the store, this batch was built on ${expect}): nothing committed`);
      const upM = db.prepare('INSERT INTO resolver_members (board, id, rec) VALUES (?, ?, ?) ON CONFLICT (board, id) DO UPDATE SET rec = excluded.rec');
      for (const k of dirty.members) { const m = st.members[k]; if (m) upM.run(m.board, m.id, JSON.stringify(m)); }
      const upG = db.prepare('INSERT INTO resolver_groups (id, status, rec) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status, rec = excluded.rec');
      for (const id of dirty.groups) { const g = st.groups[id]; if (g) upG.run(id, g.status, JSON.stringify(g)); }
      const ins = db.prepare('INSERT INTO resolved (seq, src_event_id, id, op, t, body) VALUES (?, ?, ?, ?, ?, ?)');
      for (const r of records) ins.run(r.seq, srcEventId ?? bookmark, r.id, r.op, r.t, JSON.stringify({ ...r, src_event_id: srcEventId ?? bookmark }));
      if (derived) {
        for (const [kind, names] of Object.entries(derived)) {
          db.prepare('DELETE FROM resolver_derived WHERE kind = ?').run(kind);
          const d = db.prepare('INSERT OR IGNORE INTO resolver_derived (kind, name) VALUES (?, ?)');
          for (const n of names) d.run(kind, n);
        }
      }
      const setMeta = db.prepare('INSERT INTO resolver_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v');
      for (const [k, v] of Object.entries({ ...meta, bookmark, seq: st.seq, ord: st.ord, version: RESOLVER_VERSION, checkpoint_at: new Date(now()).toISOString() })) setMeta.run(k, JSON.stringify(v));
      db.prepare('INSERT INTO bookmarks (consumer, event_id, updated_at) VALUES (?, ?, ?) ON CONFLICT (consumer) DO UPDATE SET event_id = excluded.event_id, updated_at = excluded.updated_at')
        .run(RESOLVER_CONSUMER, bookmark, new Date(now()).toISOString());
      db.prepare('UPDATE leases SET expires = ? WHERE board = ? AND token = ?').run(now() + leaseMs, RESOLVER_BOARD, lease.token);
      beforeCommit?.();
      return { records: records.length, members: dirty.members.length, groups: dirty.groups.length };
    });
  } catch (e) {
    // nothing was committed: the in-memory engine is ahead of the store and must not be used again (the caller stops)
    e.resolverAborted = true;
    throw e;
  }
}

/** The protected employer names of the engine's derived set (input names, deduplicated). */
function derivedSets(engine) {
  return { protected: engine.protectedNames() };
}

/**
 * One resolver run. opts:
 *   facts(record) -> { company, fp, applyText, kept, hide }   (default: defaultFacts, from the event's posting/v1 fields)
 *   config { companies, catalogue, rules }                    see engine.mjs
 *   batch (5000), leaseMs (10 min), now () => Date, tickAtEnd (true), maxEvents (null: all), log
 *   hooks { beforeCommit(n) }                                  test seam: runs inside the n-th checkpoint transaction (0 = bootstrap)
 * Returns { skipped? , bootstrapped, applied, records, bookmark, from, seq, stats }.
 */
export async function runResolver(store, { facts = defaultFacts, config = {}, batch = 5000, leaseMs = 10 * 60e3, now = () => new Date(), tickAtEnd = true, maxEvents = null, log = () => {}, hooks = {} } = {}) {
  requireSqlite(store);
  ensureResolverTables(store);
  const clock = () => now().getTime();
  const lease = acquireResolverLease(store, leaseMs, clock);
  if (!lease) return { skipped: 'resolver lease held by another run' };
  let n = 0;
  const commit = (engine, o) => checkpoint(store, engine, { lease, leaseMs, now: clock, beforeCommit: hooks.beforeCommit ? () => hooks.beforeCommit(n) : undefined, ...o });
  try {
    const { meta, state } = loadResolverState(store);
    const rules = meta.rules ?? config.rules ?? 'legacy';
    const engine = createResolver(state, { ...config, rules });
    let bookmark = meta.bookmark ?? null;
    const from = bookmark;
    let bootstrapped = false, applied = 0, records = 0;
    // first run: a store whose event log is its whole history (no imported boards) is replayed from event_id 0; a store with imported
    // boards (postings without 'added' events) starts from a baseline epoch over its postings instead
    const imported = bookmark == null && store.readTransaction((db) => Number(db.prepare('SELECT COUNT(*) AS n FROM imports').get().n)) > 0;
    if (bookmark == null && !imported) {
      const r = commit(engine, { expect: null, bookmark: 0, srcEventId: 0, meta: { rules, epoch: { event_id: 0, t: now().toISOString(), postings: 0, mode: 'replay' } }, derived: null });
      n++;
      bookmark = 0; bootstrapped = true;
      log(`[resolver] first run: the event log is the whole history; replaying from event_id 0 (${r.groups} groups)`);
    }
    if (bookmark == null) {
      // baseline epoch: the postings the store holds now, at the max event_id read in the same snapshot
      const { at, rows } = store.readTransaction((db) => ({
        at: Number(db.prepare('SELECT COALESCE(MAX(event_id), 0) AS m FROM events').get().m),
        rows: db.prepare('SELECT board, id, rec FROM postings ORDER BY board, id').all(),
      }));
      for (const r of rows) {
        const rec = JSON.parse(r.rec);
        engine.seed(r.board, r.id, rec, facts({ board: r.board, id: r.id, op: 'seed', t: rec.last_seen, posting: { url: rec.url, title: rec.title, jobcrawl: { board: r.board, id: r.id, status: rec.status, first_seen: rec.first_seen, last_seen: rec.last_seen } } }) ?? {});
      }
      engine.settleSeed(now().toISOString());
      const r = commit(engine, { expect: null, bookmark: at, srcEventId: at, meta: { rules, epoch: { event_id: at, t: now().toISOString(), postings: rows.length, mode: 'snapshot' } }, derived: derivedSets(engine) });
      n++;
      bookmark = at; bootstrapped = true;
      log(`[resolver] bootstrap: ${rows.length} postings seeded at event_id ${at} (baseline epoch, no resolved records), ${r.groups} groups`);
    }
    for (;;) {
      if (maxEvents != null && applied >= maxEvents) break;
      const lim = maxEvents != null ? Math.min(batch, maxEvents - applied) : batch;
      const recs = store.events({ after: bookmark, limit: lim });
      if (!recs.length) break;
      const views = new Map();
      const viewOf = (board) => {
        if (!views.has(board)) views.set(board, store.readTransaction((db) => new Map(db.prepare('SELECT id, rec FROM postings WHERE board = ?').all(board).map((x) => { const p = JSON.parse(x.rec); return [x.id, { last_seen: p.last_seen, misses: p.misses ?? 0, status: p.status }]; }))));
        return views.get(board);
      };
      let lastT = null;
      for (const rec of recs) {
        if (rec.op === 'board-ok') engine.boardOk(rec.board, rec.t, viewOf(rec.board));
        else if (rec.op !== 'board-failed') engine.apply(rec, rec.op === 'departed' || rec.op === 'unknown' ? {} : (facts(rec) ?? {}));
        if (rec.t && (!lastT || rec.t > lastT)) lastT = rec.t;
      }
      if (lastT) engine.tick(lastT);
      const last = recs.at(-1).event_id;
      const r = commit(engine, { expect: bookmark, bookmark: last, srcEventId: last, meta: { rules, last_event_t: lastT } });
      n++;
      bookmark = last; applied += recs.length; records += r.records;
      log(`[resolver] applied ${applied} records (to event_id ${last}), ${records} resolved records`);
    }
    if (tickAtEnd) {
      engine.tick(now().toISOString());
      const r = commit(engine, { expect: bookmark, bookmark, srcEventId: bookmark, meta: { rules, last_tick: now().toISOString() }, derived: derivedSets(engine) });
      n++;
      records += r.records;
    }
    log(`[resolver] result: from event_id ${from ?? 'none'} to ${bookmark}, ${applied} records applied, ${records} resolved records, seq ${engine.state.seq}${bootstrapped ? ', bootstrapped' : ''}`);
    return { bootstrapped, applied, records, from, bookmark, seq: engine.state.seq, stats: engine.stats, engine };
  } finally { lease.release(); }
}

/** Resolved records after a resolver seq: [{ seq, ...resolved/v1 }]. */
export function resolvedRecords(store, { after = 0, limit = 1000 } = {}) {
  requireSqlite(store);
  ensureResolverTables(store);
  return store.readTransaction((db) => db.prepare('SELECT body FROM resolved WHERE seq > ? ORDER BY seq LIMIT ?').all(Number(after) || 0, Math.max(1, Math.min(100000, Number(limit) || 1000))).map((r) => JSON.parse(r.body)));
}

/** The resolver's current groups: [{ id, status, dup_of, boards, admitting }]; status filter optional. */
export function resolvedGroups(store, { status = null } = {}) {
  requireSqlite(store);
  ensureResolverTables(store);
  return store.readTransaction((db) => (status ? db.prepare('SELECT rec FROM resolver_groups WHERE status = ?').all(status) : db.prepare('SELECT rec FROM resolver_groups').all()).map((r) => JSON.parse(r.rec)));
}

/** The resolver's derived set (default: protected employer names), for per-board jobs to read as a snapshot at job start. */
export function derivedSet(store, kind = 'protected') {
  requireSqlite(store);
  ensureResolverTables(store);
  return store.readTransaction((db) => db.prepare('SELECT name FROM resolver_derived WHERE kind = ? ORDER BY name').all(kind).map((r) => r.name));
}

export { RESOLVED_SCHEMA };
