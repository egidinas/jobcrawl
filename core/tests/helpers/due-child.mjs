// Child process for core/tests/run-due.test.mjs: one `run --due` pass over its own boards that all live on ONE host, with a source that
// logs enter/exit lines (timestamps) to a shared file, so the parent can check that two processes never overlapped on the host.
//   node due-child.mjs <root> <logfile> <tag> <boards> <holdMs> <perHost>
import { appendFileSync } from 'node:fs';
import { openSqliteStore } from '../../state/sqlite-store.mjs';
import { runDue } from '../../headless/due.mjs';

const [root, logfile, tag, n, hold, perHost] = process.argv.slice(2);
const store = await openSqliteStore(root, { busyMs: 20000 });
store.supports = (name) => typeof store[name] === 'function';
const boards = Array.from({ length: Number(n) }, (_, i) => ({ name: `${tag}-${i}`, provider: 'greenhouse', slug: `${tag}${i}`, careers_url: 'https://one-host.example/jobs' }));
const fetch = async () => {
  appendFileSync(logfile, `enter ${tag} ${Date.now()}\n`);
  await new Promise((r) => setTimeout(r, Number(hold)));
  appendFileSync(logfile, `exit ${tag} ${Date.now()}\n`);
  return [{ url: `https://boards.greenhouse.io/x/jobs/${tag}`, title: `Job ${tag}`, location: 'Berlin' }];
};
const r = await runDue(store, boards, { concurrency: 3, perHost: Number(perHost), hostWaitMs: 30000, readOptions: { providers: { greenhouse: { fetch } } } });
process.stdout.write(JSON.stringify({ tag, ran: r.ran, ok: r.ok, deferred: r.deferred, failed: r.failed }) + '\n');
store.close();
