// Child process for the SQLite store's two-process and crash tests (core/tests/store-sqlite.test.mjs). Not a test file.
//   writer <root> <board> <runs> <tag>      commits <runs> runs on <board> under its lease (retries while leased elsewhere); prints a summary
//   crash  <root> <board> mid|after         one run; prints MID inside the commit transaction (before COMMIT) or DONE after it, then blocks
//   lease  <root> <board> <ttlMs>           takes the board lease, prints GOT or NONE, then blocks
//   slot   <root> <host> <limit> <ttlMs>    takes a host slot, prints the result as JSON, then blocks
// Output goes through fs.writeSync(1) (synchronous on every platform), so a line is out before the process blocks.
import { writeSync } from 'node:fs';
import { openSqliteStore } from '../../state/sqlite-store.mjs';
import { applyRun } from '../../delta/board-delta.mjs';

const [mode, root, a, b, c] = process.argv.slice(2);
const say = (s) => writeSync(1, s + '\n');
const block = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
const store = await openSqliteStore(root, { busyMs: 20000 });
const items = (tag, k) => Array.from({ length: 5 }, (_, i) => ({ url: `https://boards.greenhouse.io/acme/jobs/${tag}${i}`, title: `Job ${tag}${i} v${k % 3}`, location: 'Berlin' }));

function oneRun(board, list, opts) {
  const prev = store.openBoard(board);
  const ids = store.idResolver({ board });
  ids.prime(list);
  const { state, events } = applyRun(prev, { ok: true, items: list, complete: true }, { board, now: new Date(Date.UTC(2026, 10, 1) + (prev.runs ?? 0) * 3600e3), idOf: ids.idOf });
  return store.commitRun(board, state, events, { ...ids.pending(), ...opts });
}

if (mode === 'writer') {
  const runs = Number(b), tag = c;
  let done = 0, waits = 0;
  const t0 = Date.now();
  while (done < runs) {
    const release = store.lease(a, 30000);
    if (!release) { waits++; await new Promise((r) => setTimeout(r, 2)); continue; }
    try { oneRun(a, items(tag, done)); done++; } finally { release(); }
    await new Promise((r) => setImmediate(r));
  }
  say(JSON.stringify({ tag, done, waits, ms: Date.now() - t0 }));
  store.close();
} else if (mode === 'crash') {
  if (b === 'mid') oneRun(a, items('c', 1), { beforeCommit: () => { say('MID'); block(); } });
  else { oneRun(a, items('c', 1)); say('DONE'); block(); }
} else if (mode === 'lease') {
  say(store.lease(a, Number(b)) ? 'GOT' : 'NONE');
  block();
} else if (mode === 'slot') {
  const r = store.acquireHost(a, { limit: Number(b), ttlMs: Number(c) });
  say(JSON.stringify({ token: r.token ?? null, reason: r.reason ?? null }));
  block();
} else { say(`unknown mode ${mode}`); process.exit(2); }
