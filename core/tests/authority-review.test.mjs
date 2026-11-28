// Review fixes of the authority swap (review_authority.md, 2026-11-28): F1 errors in decide go to the legacy rule for that board, F3
// a line for every cycle with boards routed new, F4 kept-open urls in the log, F5 per-board setup errors release the lease and leave
// the other boards on the new path, F6 read time stamped at commit, F8 only reached boards are skipped by the hook, a heap check, and
// provider-wide `new` refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRun } from '../delta/board-delta.mjs';
import { commitRun, lease, openBoard } from '../state/board-store.mjs';
import { prepareAuthority, decide, reached, commitAuthority, authorityBoards } from '../route/authority.mjs';

const U = (b, n) => `https://boards.greenhouse.io/${b}/jobs/${n}`;
function setup(routes, { allow = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jcx-authr-'));
  const data = join(dir, 'data'), store = join(dir, 'store'), routing = join(dir, 'routing.json');
  mkdirSync(data); mkdirSync(store);
  writeFileSync(routing, JSON.stringify({ schema: 'routing/v1', allow_new: allow, ...routes }));
  const env = { JOBCRAWL_SHADOW: '1', JOBCRAWL_ROUTING: routing, JOBCRAWL_SHADOW_DATA: store };
  for (const b of ['A', 'B']) {
    const r = applyRun(openBoard(store, b), { ok: true, items: [1, 2, 3].map((n) => ({ url: U(b, n), title: 'T' })) }, { board: b, now: new Date(Date.UTC(2026, 10, 27)) });
    commitRun(store, b, r.state, r.events);
  }
  const history = new Map();
  for (const b of ['A', 'B']) for (const n of [1, 2, 3]) history.set(U(b, n), { url: U(b, n), status: 'open' });
  return { data, store, env, history };
}
const jobs = (b, ns) => ns.map((n) => ({ url: U(b, n), title: 'T' }));
const companies = [{ name: 'A', provider: 'greenhouse' }, { name: 'B', provider: 'greenhouse' }];
const logs = () => { const l = []; return { l, log: (m) => l.push(m) }; };

test('F1: an error in decide puts that board on the legacy rule; its state is not committed; the other board commits', async () => {
  const { data, store, env, history } = setup({ boards: { A: 'new', B: 'new' } });
  const { l, log } = logs();
  const auth = await prepareAuthority({ dataDir: data, companies, results: [{ jobs: jobs('A', [1, 2]) }, { jobs: jobs('B', [1, 2]) }], history, env, log });
  auth.boards.get('A').known = null;                      // any internal fault
  assert.equal(decide(auth, 'A', U('A', 3)), null);
  assert.equal(decide(auth, 'A', U('A', 3)), null, 'stays legacy for the rest of the cycle');
  reached(auth, 'B');
  assert.equal(decide(auth, 'B', U('B', 3)), true);
  const seqA = openBoard(store, 'A').seq;
  const s = commitAuthority(auth, { log });
  assert.equal(s.errors, 1); assert.equal(s.committed, 1);
  assert.equal(openBoard(store, 'A').seq, seqA, 'A not committed');
  assert.ok(l.some((m) => /A: error, legacy rule, state not committed/.test(m)));
  assert.deepEqual([...authorityBoards(auth)], ['B']);
});

test('F5: a setup error after the lease releases it and leaves the other board on the new path', async () => {
  const { data, store, env, history } = setup({ boards: { A: 'new', B: 'new' } });
  const { l, log } = logs();
  const bad = { name: 'A', provider: 'greenhouse', get max_jobs() { throw new Error('boom'); } };
  const auth = await prepareAuthority({ dataDir: data, companies: [bad, companies[1]], results: [{ jobs: jobs('A', [1]) }, { jobs: jobs('B', [1]) }], history, env, log });
  assert.equal(auth.summary.setup_failed, 1);
  assert.deepEqual([...auth.boards.keys()], ['B']);
  assert.ok(l.some((m) => /A: setup failed, legacy rule this cycle: boom/.test(m)));
  const rel = await lease(store, 'A', 60e3, Date.now, { busyMs: 0 });
  assert.ok(rel, 'the lease of A was released'); rel();
  commitAuthority(auth, { log });
});

test('F3: a line also when every routed board was unread; provider-wide new refused; low memory', async () => {
  let { data, env, history } = setup({ boards: { A: 'new' } });
  let { l, log } = logs();
  let auth = await prepareAuthority({ dataDir: data, companies, results: [{ error: 'timeout' }, { jobs: jobs('B', [1]) }], history, env, log });
  commitAuthority(auth, { log });
  assert.match(l.at(-1), /boards routed new 1, decided 0 \(all routed boards unread or unusable\).*failed reads 1/);

  ({ data, env, history } = setup({ providers: { greenhouse: 'new' } }));
  ({ l, log } = logs());
  auth = await prepareAuthority({ dataDir: data, companies, results: [{ jobs: jobs('A', [1]) }, { jobs: jobs('B', [1]) }], history, env, log });
  assert.equal(auth.boards.size, 0);
  commitAuthority(auth, { log });
  assert.match(l.at(-1), /provider routes refused 2/);

  ({ data, env, history } = setup({ boards: { A: 'new' } }));
  ({ l, log } = logs());
  auth = await prepareAuthority({ dataDir: data, companies, results: [{ jobs: jobs('A', [1]) }, { jobs: jobs('B', [1]) }], history, env, log, headroom: () => 10 });
  commitAuthority(auth, { log });
  assert.match(l.at(-1), /low memory 1/);

  ({ data, env, history } = setup({ boards: { A: 'legacy' } }));
  assert.equal(await prepareAuthority({ dataDir: data, companies, results: [{ jobs: [] }, { jobs: [] }], history, env, log }), null, 'nothing routed new: no line');
});

test('F4: kept-open rows are logged with their urls', async () => {
  const { data, env, history } = setup({ boards: { A: 'new' } });
  const { l, log } = logs();
  const auth = await prepareAuthority({ dataDir: data, companies, results: [{ jobs: jobs('A', [1, 2]) }, { jobs: [] }], history, env, log });
  const b = auth.boards.get('A');
  const id = [...b.departed][0]; b.departed.delete(id); b.statusAfter.set(id, 'open');   // force the divergence
  reached(auth, 'A');
  assert.equal(decide(auth, 'A', U('A', 3)), false);
  const s = commitAuthority(auth, { log });
  assert.equal(s.kept, 1);
  assert.ok(l.some((m) => m.includes('KEPT OPEN 1') && m.includes(U('A', 3))));
  assert.match(l.at(-1), /kept open 1/);
});

test('F6: the read time is stamped at commit; F8: boards not reached are left to the shadow hook', async () => {
  const { data, store, env, history } = setup({ boards: { A: 'new', B: 'new' } });
  const { log } = logs();
  const t0 = new Date(Date.UTC(2026, 10, 28, 6, 0)), t1 = new Date(Date.UTC(2026, 10, 28, 6, 20));
  const auth = await prepareAuthority({ dataDir: data, companies, results: [{ jobs: jobs('A', [1, 2]) }, { jobs: jobs('B', [1]) }], history, env, log, now: () => t0 });
  reached(auth, 'A');
  assert.deepEqual([...authorityBoards(auth)], ['A'], 'B (not reached: guard hold, incomplete) stays with the hook');
  commitAuthority(auth, { log, now: () => t1 });
  const st = openBoard(store, 'A');
  assert.equal(st.last_ok, t1.toISOString());
  const seen = Object.values(st.postings).filter((p) => p.status === 'open' && p.last_seen === st.last_ok).map((p) => p.url).sort();
  assert.deepEqual(seen, [U('A', 1), U('A', 2)], 'the postings of this read carry the commit time');
});
