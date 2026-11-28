// The state store behind one interface (design §3.1 StateStore), two backends:
//   json    today's files store (board-store.mjs: state.json + events.ndjson per board, leases.sqlite); the default for now
//   sqlite  one store.sqlite per data folder (sqlite-store.mjs): global event_id, consumer bookmarks, stored ids + alias table,
//           shared host slots, cooldowns and breaker
// Common methods: kind, root, openBoard(board, opts), commitRun(board, state, events, opts) -> { seqFrom, seqTo, ... },
//   lease(board, ttlMs) -> release | null, listBoards(), readEvents(since), snapshot(opts) -> [header, ...postings], close().
// SQLite only: events({ after, limit }), bookmarkGet/bookmarkSet, maxEventId, idResolver, addAlias, acquireHost, setCooldown,
//   cooldown, breakerRecord, breakerState, importJson. (`supports(name)` tells which.)
// A data folder holds one backend: opening it with the other one is refused (a JSON folder opened as SQLite would start empty, and the
// first run would emit an "everything added" burst). Move a folder with importJson / `jobcrawl store-import` (no events).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as json from './board-store.mjs';
import { StateError } from './board-store.mjs';
import { openSqliteStore, SQLITE_FILE } from './sqlite-store.mjs';

export const STORE_KINDS = Object.freeze(['json', 'sqlite']);

/** Which backends have data in a folder: { json, sqlite }. */
export function detectStore(root) {
  return { json: json.listBoards(root).length > 0, sqlite: existsSync(join(root, SQLITE_FILE)) };
}

export function jsonStore(root, { keepDescription = false, storeText = false } = {}) {
  return {
    kind: 'json', root, keepDescription, storeText,
    supports: (name) => ['openBoard', 'commitRun', 'lease', 'listBoards', 'readEvents', 'snapshot'].includes(name),
    openBoard: (board, opts) => json.openBoard(root, board, opts),
    commitRun: (board, state, events) => json.commitRun(root, board, state, events),
    lease: (board, ttlMs, now) => json.lease(root, board, ttlMs, now),
    listBoards: () => json.listBoards(root),
    readEvents: (since) => json.readEvents(root, since),
    snapshot: (opts) => [...json.snapshot(root, opts)],
    close() {},
  };
}

/** Opens the store of a data folder. kind: 'json' | 'sqlite'. */
export async function openStore(root, { kind = 'json', ...opts } = {}) {
  if (!STORE_KINDS.includes(kind)) throw new StateError(`unknown store "${kind}" (expected ${STORE_KINDS.join(' or ')})`);
  const has = detectStore(root);
  if (kind === 'sqlite' && has.json && !has.sqlite) throw new StateError(`${root} holds JSON board states and no ${SQLITE_FILE}: import them first (jobcrawl store-import --data <dir>), or run with --store json`);
  if (kind === 'json' && has.sqlite) throw new StateError(`${root} holds a ${SQLITE_FILE} store: run with --store sqlite`);
  if (kind === 'json') return jsonStore(root, opts);
  const s = await openSqliteStore(root, opts);
  s.supports = (name) => typeof s[name] === 'function';
  return s;
}
