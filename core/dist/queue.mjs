// Work queue for distributed stages (design §0.3): crawl, enrichment, embedding and extraction workers take work items at their own pace.
//
// Interface (every adapter implements it: this local SQLite queue; later the fleet API / Cloudflare queue, Redis, NATS, HTTP):
//   enqueue(item)                        idempotent by item.key: an item with a key already waiting or leased is not added twice;
//                                        a newer item.version replaces a waiting one (a re-crawl supersedes stale work)
//   lease(worker, { topics, n, ttlMs })  up to n items whose topic and requirements the worker meets (match.mjs), leased for ttlMs
//   heartbeat(leaseId, ttlMs)            extends a lease (long items)
//   ack(leaseId, result?)                done; the item leaves the queue
//   nack(leaseId, error, { retry })      failed; retried after an exponential backoff, or dead-lettered after maxAttempts
//   stats()                              counts per topic and state
// Semantics: at-least-once delivery. A worker that dies loses only its lease: the item becomes visible again when the lease expires.
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
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS items_ready ON items (topic, state, visible_at, priority);`);
  }

  _tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  enqueue(item) {
    if (!item?.key || !item?.topic) throw new Error('enqueue: key and topic are required');
    const t = this.clock(), v = Number(item.version ?? 0);
    return this._tx(() => {
      const cur = this.db.prepare('SELECT state, version FROM items WHERE key = ?').get(item.key);
      if (cur && (cur.state === 'ready' || cur.state === 'leased') && cur.version >= v) return { added: false, reason: 'already queued' };
      if (cur && cur.state === 'leased') return { added: false, reason: 'leased; the newer version is picked up after it' };
      this.db.prepare(`INSERT INTO items (key, topic, version, payload, requires, priority, state, attempts, max_attempts, visible_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'ready', 0, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET topic = excluded.topic, version = excluded.version, payload = excluded.payload, requires = excluded.requires,
          priority = excluded.priority, state = 'ready', attempts = 0, max_attempts = excluded.max_attempts, visible_at = excluded.visible_at,
          lease_id = NULL, worker = NULL, last_error = NULL, updated_at = excluded.updated_at`)
        .run(item.key, item.topic, v, JSON.stringify(item.payload ?? null), JSON.stringify(item.requires ?? null), Number(item.priority ?? 0),
          Number(item.maxAttempts ?? 5), t, t, t);
      return { added: true };
    });
  }

  lease(worker, { topics, n = 1, ttlMs = 10 * 60e3 } = {}) {
    const t = this.clock();
    return this._tx(() => {
      // expired leases become ready again (the worker died or stalled)
      this.db.prepare("UPDATE items SET state = 'ready', lease_id = NULL, worker = NULL WHERE state = 'leased' AND visible_at <= ?").run(t);
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

  _leased(leaseId) {
    const r = this.db.prepare("SELECT * FROM items WHERE lease_id = ? AND state = 'leased'").get(leaseId);
    if (!r) throw new Error('lease not found or expired');
    return r;
  }

  heartbeat(leaseId, ttlMs = 10 * 60e3) {
    return this._tx(() => { const r = this._leased(leaseId); this.db.prepare('UPDATE items SET visible_at = ?, updated_at = ? WHERE key = ?').run(this.clock() + ttlMs, this.clock(), r.key); return true; });
  }

  ack(leaseId) {
    return this._tx(() => { const r = this._leased(leaseId); this.db.prepare('DELETE FROM items WHERE key = ?').run(r.key); return true; });
  }

  nack(leaseId, error, { retry = true } = {}) {
    return this._tx(() => {
      const r = this._leased(leaseId);
      const dead = !retry || r.attempts >= r.max_attempts;
      const delay = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** Math.max(0, r.attempts - 1));
      this.db.prepare('UPDATE items SET state = ?, lease_id = NULL, worker = NULL, visible_at = ?, last_error = ?, updated_at = ? WHERE key = ?')
        .run(dead ? 'dead' : 'ready', this.clock() + (dead ? 0 : delay), String(error ?? '').slice(0, 500), this.clock(), r.key);
      return { dead, retryInMs: dead ? null : delay };
    });
  }

  /** Puts dead-lettered items back (after a fix). */
  redrive(topic) {
    return this._tx(() => this.db.prepare("UPDATE items SET state = 'ready', attempts = 0, visible_at = ? WHERE state = 'dead' AND topic = ?").run(this.clock(), topic).changes);
  }

  stats() {
    const rows = this.db.prepare('SELECT topic, state, COUNT(*) AS n FROM items GROUP BY topic, state').all();
    const s = {};
    for (const r of rows) (s[r.topic] ??= {})[r.state] = r.n;
    return s;
  }

  close() { this.db.close(); }
}
