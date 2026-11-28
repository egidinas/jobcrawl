// Opens a data folder for the MCP server WITHOUT any write: no file is created, no DDL, no journal-mode change, and the connection
// refuses writes (readOnly + PRAGMA query_only). SqliteStore's read methods (events, snapshot, bookmarkGet, breakerState, ...) only use
// this.db, this._read and this.clock, so they are borrowed on a handle built by hand; the constructor (which runs DDL) is not called.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteStore, SQLITE_FILE, SQLITE_SCHEMA_VERSION } from '../state/sqlite-store.mjs';
import { jsonStore, detectStore } from '../state/store.mjs';
import { StateError } from '../state/board-store.mjs';
import { loadSqlite } from '../state/sqlite-load.mjs';

/** kind: 'sqlite' | 'json' | undefined (auto: sqlite when store.sqlite exists, else json). */
export async function openReadOnlyStore(root, { kind } = {}) {
  if (!root || !existsSync(root) || !statSync(root).isDirectory()) throw new StateError(`data folder not found: ${root}`);
  const has = detectStore(root);
  kind ??= has.sqlite ? 'sqlite' : 'json';
  if (kind === 'json') {
    if (has.sqlite && !has.json) throw new StateError(`${root} holds a ${SQLITE_FILE} store: run with --store sqlite`);
    return jsonStore(root);
  }
  if (kind !== 'sqlite') throw new StateError(`unknown store "${kind}" (expected json or sqlite)`);
  const file = join(root, SQLITE_FILE);
  if (!existsSync(file)) throw new StateError(`${file} does not exist (the MCP server never creates a store)`);
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA query_only=ON');
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v > SQLITE_SCHEMA_VERSION) { db.close(); throw new StateError(`${file}: schema version ${v} is newer than this jobcrawl (${SQLITE_SCHEMA_VERSION})`); }
  const s = Object.create(SqliteStore.prototype);
  Object.assign(s, { kind: 'sqlite', root, file, db, clock: Date.now, keepDescription: false, storeText: false, readOnly: true, supports: (n) => typeof s[n] === 'function' });
  return s;
}
