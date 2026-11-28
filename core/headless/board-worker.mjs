// Worker thread of `run --due --isolate worker`: reads ONE board and posts the run back. The parent terminates this thread at the board
// budget, which also stops a parser that hangs the event loop (catastrophic regex). The worker only reads; the parent applies the run.
import { parentPort, workerData } from 'node:worker_threads';

const { entry, profileDir, data, readerModule, timeoutMs } = workerData;
let run;
try {
  if (readerModule) run = await (await import(readerModule)).read(entry, { timeoutMs });   // test seam
  else {
    const { loadProfile } = await import('../../crawler/profile.mjs');
    const profile = loadProfile(profileDir);
    if (!profile) throw new Error('worker: profile not found');
    (await import('../../crawler/useragent.mjs')).setUserAgent(profile.userAgent);
    const pol = await import('../../crawler/policy.mjs');
    pol.configurePolicy({ ...pol.policyFromProfile(profile, data) });
    pol.installGuard({ egress: true });
    (await import('../../crawler/providers.mjs')).setCacheDir(`${data}/cache`);
    // the worker's requests feed the same store cooldowns as the main thread's
    const { openSqliteStore } = await import('../state/sqlite-store.mjs');
    const { makeThrottleFetch } = await import('./due.mjs');
    const store = await openSqliteStore(data);
    globalThis.fetch = makeThrottleFetch(globalThis.fetch, { store });
    const { readBoard } = await import('../run-board.mjs');
    try { run = await readBoard(entry, { timeoutMs }); } finally { store.close(); }
  }
} catch (e) { run = { ok: false, items: [], error: { cls: 'OTHER', detail: String(e?.message ?? e).slice(0, 200) }, ms: 0 }; }
parentPort.postMessage(run);
