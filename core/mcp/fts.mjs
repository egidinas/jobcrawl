// Full-text search for the MCP server: a private in-memory SQLite database with an FTS5 table, built from the store's snapshot
// (title, company, location and the stored excerpt of posting_text). The store itself is never written: it is opened read-only and the
// index lives in ':memory:'. It is rebuilt when the store's last event_id moves (sqlite) or after `ttlMs` (json store).
// Agent-supplied terms are never passed to FTS5 as syntax: each term is a quoted phrase made of letters and digits only, and every
// value is a bound parameter. Index size is capped (maxRows); a capped index says so in the result.
import { loadSqlite } from '../state/sqlite-load.mjs';
import { EXCERPT_CHARS, fromPosting } from '../outputs/fields.mjs';

const TERM = /[\p{L}\p{N}]+/gu;

/** The FTS5 MATCH expression for a query string: "a" "b" "c"* (ANDed, last term a prefix), or null when no term is left. */
export function matchExpr(query, maxTerms = 12) {
  const terms = String(query ?? '').normalize('NFKC').match(TERM)?.slice(0, maxTerms) ?? [];
  if (!terms.length) return null;
  return terms.map((t, i) => `"${t}"${i === terms.length - 1 ? '*' : ''}`).join(' ');
}
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

export class PostingIndex {
  constructor(store, { maxRows = 500_000, ttlMs = 30_000, clock = Date.now } = {}) {
    Object.assign(this, { store, maxRows, ttlMs, clock, db: null, stamp: null, builtAt: 0, rows: 0, capped: false });
  }

  _stampNow() { return this.store.kind === 'sqlite' ? `e${this.store.maxEventId()}` : null; }

  async _build() {
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE p USING fts5(title, company, location, excerpt, id UNINDEXED, board UNINDEXED, status UNINDEXED, url UNINDEXED, date_posted UNINDEXED, first_seen UNINDEXED, tokenize = "unicode61 remove_diacritics 2")');
    } catch (e) {
      db.close();
      const x = new Error(`FTS5 is not available in this SQLite build (${e?.message ?? e})`); x.code = 'FTS5_UNAVAILABLE'; throw x;
    }
    const stamp = this._stampNow();
    const [, ...postings] = this.store.snapshot({ status: null });
    const ins = db.prepare('INSERT INTO p (title, company, location, excerpt, id, board, status, url, date_posted, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    let n = 0;
    for (const p of postings) {
      if (n >= this.maxRows) { this.capped = true; break; }
      const r = fromPosting(p);
      ins.run(r.title, r.company, r.location, (r.excerpt ?? '').slice(0, EXCERPT_CHARS), r.id, p.jobcrawl?.board ?? '', r.status, r.url, r.date_posted, r.first_seen);
      n++;
    }
    db.exec('COMMIT');
    this.db?.close();
    Object.assign(this, { db, stamp, builtAt: this.clock(), rows: n });
  }

  async _ensure() {
    const fresh = this.db && (this.store.kind === 'sqlite' ? this._stampNow() === this.stamp : this.clock() - this.builtAt < this.ttlMs);
    if (!fresh) await this._build();
  }

  /** { rows: [{ id, title, company, location, url, date_posted, first_seen, status, boards, excerpt, rank }], indexed, indexTruncated } */
  async search({ query, board, status = 'open', location, limit = 10 }) {
    await this._ensure();
    const expr = matchExpr(query);
    if (!expr) return { rows: [], indexed: this.rows, indexTruncated: this.capped };
    const where = ['p MATCH ?'], args = [expr];
    if (status && status !== 'all') { where.push('status = ?'); args.push(status); }
    if (board) { where.push('board = ?'); args.push(board); }
    if (location) { where.push("location LIKE ? ESCAPE '\\'"); args.push(`%${likeEscape(location)}%`); }
    const rows = this.db.prepare(`SELECT id, title, company, location, excerpt, board, status, url, date_posted, first_seen, bm25(p, 5.0, 2.0, 1.0, 1.0) AS rank FROM p WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`)
      .all(...args, Math.max(1, Math.min(200, limit)));
    return {
      rows: rows.map((r) => ({ id: r.id, title: r.title, company: r.company, location: r.location, url: r.url, date_posted: r.date_posted, first_seen: r.first_seen, last_seen: '',
        status: r.status, boards: r.board ? [r.board] : [], excerpt: r.excerpt, description: '', rank: -Number(r.rank) })),
      indexed: this.rows, indexTruncated: this.capped,
    };
  }

  close() { try { this.db?.close(); } catch { /* closed */ } this.db = null; }
}
