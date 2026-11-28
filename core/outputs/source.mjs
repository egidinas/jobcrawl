// Outputs (row 2A.2): reads either stream into normalised records. `from` is 'delta' (per-board delta/v1 events and the posting/v1 snapshot)
// or 'resolved' (the resolver's resolved/v1 stream).
import { fromPosting, fromResolved } from './fields.mjs';
import { resolvedRecords } from '../resolve/resolver.mjs';

export const SOURCES = ['delta', 'resolved'];
const FEED_OPS = new Set(['added', 'changed', 'reappeared']);

/** Every resolved record in seq order (paged). */
function allResolved(store, after = 0) {
  const out = [];
  for (;;) {
    const page = resolvedRecords(store, { after, limit: 10000 });
    out.push(...page);
    if (page.length < 10000) return out;
    after = page.at(-1).seq;
  }
}

/** Full snapshot: { header, records }. Delta: the store's posting/v1 snapshot. Resolved: the latest record of each id, sorted by id. */
export function readSnapshot(store, { from = 'delta', status = 'open' } = {}) {
  if (from === 'delta') {
    const [head, ...rows] = store.snapshot({ status: status === 'all' ? null : status });
    return { header: { watermark: { event_id: head.event_id, boards: head.watermarks } }, records: rows.map((p) => fromPosting(p)) };
  }
  const last = new Map();
  let seq = 0;
  for (const r of allResolved(store)) { last.set(r.id, r); seq = r.seq; }
  const recs = [...last.values()].filter((r) => status === 'all' || r.status === status).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { header: { watermark: { seq } }, records: recs.map((r) => fromResolved(r)) };
}

/** Records after a cursor: { records, last, read }. `last` is the cursor to commit (event_id for delta, resolver seq for resolved).
 *  The latest record of each id wins; records come in cursor order. With `additions` only added/changed/reappeared (delta) or open (resolved) rows stay. */
export function readAfter(store, { from = 'delta', after = 0, limit = 1000, additions = true } = {}) {
  let raw, last, recs;
  if (from === 'delta') {
    raw = store.events({ after, limit });
    last = raw.length ? raw.at(-1).event_id : after;
    recs = raw.filter((e) => e.posting && (!additions || FEED_OPS.has(e.op))).map((e) => fromPosting(e.posting, { op: e.op, cursor: e.event_id }));
  } else {
    raw = resolvedRecords(store, { after, limit });
    last = raw.length ? raw.at(-1).seq : after;
    recs = raw.filter((r) => r.title && (!additions || r.status === 'open')).map((r) => fromResolved(r, { op: r.op, cursor: r.seq }));
  }
  const byId = new Map();
  for (const r of recs) byId.set(r.id, r);
  return { records: [...byId.values()].sort((a, b) => a.cursor - b.cursor), last, read: raw.length };
}

/** Bookmarks. The delta stream uses the store's consumer bookmarks (event_id). The resolved stream has its own cursor (the resolver seq),
 *  kept in the same table under "<consumer>@resolved" through a plain upsert, since bookmarkSet only accepts event_ids. */
export function bookmarkGet(store, consumer, from) {
  if (from === 'delta') return store.bookmarkGet(consumer);
  return store.readTransaction((db) => Number(db.prepare('SELECT event_id FROM bookmarks WHERE consumer = ?').get(`${consumer}@resolved`)?.event_id ?? 0));
}
export function bookmarkSet(store, consumer, from, cursor, now = () => new Date()) {
  if (from === 'delta') return store.bookmarkSet(consumer, cursor);
  store.withTransaction((db) => db.prepare('INSERT INTO bookmarks (consumer, event_id, updated_at) VALUES (?, ?, ?) ON CONFLICT (consumer) DO UPDATE SET event_id = excluded.event_id, updated_at = excluded.updated_at')
    .run(`${consumer}@resolved`, cursor, now().toISOString()));
  return cursor;
}
