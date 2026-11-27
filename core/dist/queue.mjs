// Work queue for distributed stages (design §0.3): crawl, enrichment, embedding and extraction workers take work items at their own pace.
//
// Interface (every adapter implements it: this local SQLite queue; later the fleet API / Cloudflare queue, Redis, NATS, HTTP):
//   enqueue(item)                        idempotent by item.key: an item with a key already waiting or leased is not added twice;
//                                        a newer item.version replaces a waiting one; a newer version arriving while the item is leased is
//                                        kept as `pending` and becomes the next delivery when the lease ends (ack, nack or expiry)
//   lease(worker, { topics, n, ttlMs })  up to n items whose topic and requirements the worker meets (match.mjs), leased for ttlMs
//   heartbeat(leaseId, ttlMs)            extends a live lease (throws once it has expired)
//   ack(leaseId)                         done (throws once the lease has expired: the item may already be with another worker)
//   nack(leaseId, error, { retry })      failed; retried after an exponential backoff, or dead-lettered after maxAttempts
//   redrive(topic), stats()
// Semantics: at-least-once delivery. A worker that dies loses only its lease; the expired lease counts as an attempt, so a poison item
// that crashes its workers ends in the dead letter after maxAttempts instead of being redelivered forever.
// Results are merged by (key, version) idempotently (merge.mjs), so a duplicate delivery never duplicates a result.
// Work item (schema work-item/v1): { key, topic, version?, payload, requires?, priority?, maxAttempts? }
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { meets } from './match.mjs';

export const WORK_SCHEMA = 'work-item/v1';
const now = () => Date.now();

export class LocalQueue {
  /** file: a SQLite file (':memory:' for tests). */
  constructor(file, { clock = now, backoffMs = 30000, maxBackoffMs = 3600e3 } = {}) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.clock = clock; this.backoffMs = backoffMs; this.maxBackoffMs = maxBackoffMs;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS items (key TEXT PRIMARY KEY, topic TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, payload TEXT,
        requires TEXT, priority INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'ready', attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5, visible_at INTEGER NOT NULL, lease_id TEXT, worker TEXT, last_error TEXT,
        pending TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS items_ready ON items (topic, state, visible_at, priority);`);
  }

  _tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  _write(item, t) {
    this.db.prepare(`INSERT INTO items (key, topic, version, payload, requires, priority, state, attempts, max_attempts, visible_at, pending, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'ready', 0, ?, ?, NULL, ?, ?)
      ON CONFLICT(key) DO UPDATE SET topic = excluded.topic, version = excluded.version, payload = excluded.payload, requires = excluded.requires,
        priority = excluded.priority, state = 'ready', attempts = 0, max_attempts = excluded.max_attempts, visible_at = excluded.visible_at,
        lease_id = NULL, worker = NULL, last_error = NULL, pending = NULL, updated_at = excluded.updated_at`)
      .run(item.key, item.topic, Number(item.version ?? 0), JSON.stringify(item.payload ?? null), JSON.stringify(item.requires ?? null), Number(item.priority ?? 0),
        Number(item.maxAttempts ?? 5), t, t, t);
  }

  /** When a lease ends: a pending newer version becomes the next delivery (fresh attempts); returns true if it did. */
  _adoptPending(r, t) {
    if (!r.pending) return false;
    this._write(JSON.parse(r.pending), t);
    return true;
  }

  enqueue(item) {
    if (!item?.key || !item?.topic) throw new Error('enqueue: key and topic are required');
    const t = this.clock(), v = Number(item.version ?? 0);
    return this._tx(() => {
      const cur = this.db.prepare('SELECT state, version, pending FROM items WHERE key = ?').get(item.key);
      if (cur?.state === 'leased') {
        const pv = cur.pending ? Number(JSON.parse(cur.pending).version ?? 0) : cur.version;
        if (v <= pv) return { added: false, reason: 'already queued' };
        this.db.prepare('UPDATE items SET pending = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(item), t, item.key);
        return { added: true, pending: true };
      }
      if (cur && cur.state === 'ready' && cur.version >= v) return { added: false, reason: 'already queued' };
      this._write(item, t);
      return { added: true };
    });
  }

  _reclaimExpired(t) {
    const expired = this.db.prepare("SELECT * FROM items WHERE state = 'leased' AND visible_at <= ?").all(t);
    for (const r of expired) {
      if (this._adoptPending(r, t)) continue;
      const dead = r.attempts >= r.max_attempts;
      this.db.prepare("UPDATE items SET state = ?, lease_id = NULL, worker = NULL, last_error = ?, updated_at = ? WHERE key = ?")
        .run(dead ? 'dead' : 'ready', `lease expired (attempt ${r.attempts} of ${r.max_attempts}, worker ${r.worker})`, t, r.key);
    }
  }

  lease(worker, { topics, n = 1, ttlMs = 10 * 60e3 } = {}) {
    const t = this.clock();
    return this._tx(() => {
      this._reclaimExpired(t);
      const ph = topics.map(() => '?').join(',');
      const rows = this.db.prepare(`SELECT * FROM items WHERE state = 'ready' AND visible_at <= ? AND topic IN (${ph}) ORDER BY priority DESC, created_at LIMIT ?`)
        .all(t, ...topics, Math.max(n * 20, 50));
      const out = [];
      for (const r of rows) {
        if (out.length >= n) break;
        const requires = JSON.parse(r.requires ?? 'null');
        if (!meets(worker, requires, r.topic).ok) continue;
        const leaseId = randomUUID();
        this.db.prepare("UPDATE items SET state = 'leased', lease_id = ?, worker = ?, attempts = attempts + 1, visible_at = ?, updated_at = ? WHERE key = ?")
          .run(leaseId, worker.id, t + ttlMs, t, r.key);
        out.push({ leaseId, key: r.key, topic: r.topic, version: r.version, payload: JSON.parse(r.payload), attempts: r.attempts + 1 });
      }
      return out;
    });
  }

  /** The row of a LIVE lease (throws when unknown or expired). */
  _leased(leaseId) {
    const r = this.db.prepare("SELECT * FROM items WHERE lease_id = ? AND state = 'leased'").get(leaseId);
    if (!r) throw new Error('lease not found or expired');
    if (r.visible_at <= this.clock()) throw new Error('lease expired');
    return r;
  }

  heartbeat(leaseId, ttlMs = 10 * 60e3) {
    return this._tx(() => { const r = this._leased(leaseId); this.db.prepare('UPDATE items SET visible_at = ?, updated_at = ? WHERE key = ?').run(this.clock() + ttlMs, this.clock(), r.key); return true; });
  }

  ack(leaseId) {
    return this._tx(() => {
      const r = this._leased(leaseId);
      if (!this._adoptPending(r, this.clock())) this.db.prepare('DELETE FROM items WHERE key = ?').run(r.key);
      return true;
    });
  }

  nack(leaseId, error, { retry = true } = {}) {
    return this._tx(() => {
      const r = this._leased(leaseId);
      if (this._adoptPending(r, this.clock())) return { dead: false, retryInMs: 0, superseded: true };
      const dead = !retry || r.attempts >= r.max_attempts;
      const delay = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** Math.max(0, r.attempts - 1));
      this.db.prepare('UPDATE items SET state = ?, lease_id = NULL, worker = NULL, visible_at = ?, last_error = ?, updated_at = ? WHERE key = ?')
        .run(dead ? 'dead' : 'ready', this.clock() + (dead ? 0 : delay), String(error ?? '').slice(0, 500), this.clock(), r.key);
      return { dead, retryInMs: dead ? null : delay };
    });
  }

  /** Puts dead-lettered items back (after a fix). */
  redrive(topic) {
    return this._tx(() => Number(this.db.prepare("UPDATE items SET state = 'ready', attempts = 0, visible_at = ? WHERE state = 'dead' AND topic = ?").run(this.clock(), topic).changes));
  }

  stats() {
    this._tx(() => this._reclaimExpired(this.clock()));
    const rows = this.db.prepare('SELECT topic, state, COUNT(*) AS n FROM items GROUP BY topic, state').all();
    const s = {};
    for (const r of rows) (s[r.topic] ??= {})[r.state] = r.n;
    return s;
  }

  close() { this.db.close(); }
}
