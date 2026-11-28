// SQLite state store (row 1.1): commit + global event_id, consumer bookmarks, stale-writer refusal, snapshot + deltas == later snapshot,
// ids as stored facts across a key-rule change, JSON import with 0 events, two-process lock and crash tests, host slots / cooldowns /
// breaker shared through the store, CLI wiring (--store, feed --after/--consumer, bookmark, store-import), the quiet ExperimentalWarning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { applyRun, DEFAULT_RULES } from '../delta/board-delta.mjs';
import { commitRun as jsonCommit, openBoard as jsonOpen, boardKey, StateError } from '../state/board-store.mjs';
import { openSqliteStore, projection, SQLITE_FILE } from '../state/sqlite-store.mjs';
import { openStore } from '../state/store.mjs';
import { baselineState } from '../route/baseline.mjs';
import { runCycle } from '../headless/runner.mjs';
import { EXIT } from '../headless/exit.mjs';
import { idForKey, normaliseUrl, postingId } from '../id.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'cli', 'jobcrawl.mjs');
const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'store-child.mjs');
const tmp = (p = 'jcx-sq-') => mkdtempSync(join(tmpdir(), p));
const H = 3600e3;
const at = (h) => new Date(Date.UTC(2026, 10, 1) + h * H);
const job = (n, extra = {}) => ({ url: `https://jobs.example.com/p/${n}`, title: `Engineer ${n}`, location: 'Munich', ...extra });
const ok = (items, extra = {}) => ({ ok: true, items, complete: true, ...extra });
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JOBCRAWL_')));
const NO_NET = join(tmp('jcx-nonet-'), 'nonet.mjs');
writeFileSync(NO_NET, "globalThis.fetch = () => { console.error('NETWORK USED'); process.exit(99); };\n");

/** One run through the store the way runBoardOn does it (stored ids, commit in one transaction). */
function run(store, board, read, h, rules = DEFAULT_RULES) {
  const prev = store.openBoard(board);
  const ids = store.idResolver?.({ board, now: () => at(h) });
  ids?.prime(read.items);
  const { state, events } = applyRun(prev, read, { board, now: at(h), rules, ...(ids ? { idOf: ids.idOf } : {}) });
  const c = store.commitRun(board, state, events, ids?.pending());
  return { ...c, events, state };
}

test('sqlite: commit round-trips the state; one global event_id over boards in commit order; per-board seq kept; events(after, limit)', async () => {
  const s = await openSqliteStore(tmp());
  const r1 = run(s, 'A', ok([job(1), job(2)]), 0);
  const r2 = run(s, 'B', ok([job(3)]), 0);
  const r3 = run(s, 'A', ok([job(1), job(2, { title: 'Lead' })]), 1);
  assert.deepEqual([r1.eventFrom, r1.eventTo, r2.eventFrom, r2.eventTo, r3.eventFrom, r3.eventTo], [1, 3, 4, 5, 6, 7]);
  assert.deepEqual(s.openBoard('A'), r3.state, 'openBoard returns exactly the committed state');
  const all = s.events({ after: 0, limit: 100 });
  assert.deepEqual(all.map((e) => e.event_id), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(all.map((e) => `${e.board}:${e.seq}`), ['A:1', 'A:2', 'A:3', 'B:1', 'B:2', 'A:4', 'A:5']);
  assert.deepEqual(s.events({ after: 3, limit: 2 }).map((e) => e.event_id), [4, 5]);
  assert.deepEqual([...s.readEvents({ A: 3 })].map((e) => `${e.board}:${e.seq}`), ['A:4', 'A:5', 'B:1', 'B:2'], 'per-board watermarks still work');
  assert.equal(s.maxEventId(), 7);
  assert.deepEqual(s.listBoards(), ['A', 'B']);
  s.close();
});

test('sqlite: named consumer bookmarks; a bookmark beyond the last event is refused', async () => {
  const s = await openSqliteStore(tmp());
  run(s, 'A', ok([job(1)]), 0);
  assert.equal(s.bookmarkGet('board-publish'), 0);
  assert.equal(s.bookmarkSet('board-publish', 2), 2);
  assert.equal(s.bookmarkGet('board-publish'), 2);
  assert.throws(() => s.bookmarkSet('board-publish', 3), StateError);
  assert.throws(() => s.bookmarkSet('', 1), StateError);
  assert.deepEqual(s.bookmarks().map((b) => [b.consumer, b.event_id]), [['board-publish', 2]]);
  s.close();
});

test('sqlite: a writer whose base seq moved (lease lost, second writer) gets a StateError and writes nothing', async () => {
  const root = tmp();
  const a = await openSqliteStore(root), b = await openSqliteStore(root);
  run(a, 'A', ok([job(1)]), 0);
  const prevB = b.openBoard('A');
  run(a, 'A', ok([job(1), job(2)]), 1);
  const { state, events } = applyRun(prevB, ok([job(1), job(3)]), { board: 'A', now: at(2) });
  const before = a.maxEventId();
  assert.throws(() => b.commitRun('A', state, events), (e) => e instanceof StateError && /stale writer/.test(e.message));
  assert.equal(a.maxEventId(), before);
  assert.equal(a.openBoard('A').seq, 4);
  a.close(); b.close();
});

/** Applies store records to a snapshot (Map board|id -> projection). */
function applyRecords(snap, recs) {
  const m = new Map(snap);
  for (const e of recs) {
    const k = `${e.board}|${e.id}`;
    if (['added', 'changed', 'reappeared', 'refreshed'].includes(e.op)) {
      const p = structuredClone(e.posting); delete p.jobcrawl.last_seen; m.set(k, p);
    } else if (e.op === 'departed' && m.has(k)) { const p = structuredClone(m.get(k)); p.jobcrawl.status = 'departed'; m.set(k, p); }
  }
  return m;
}
const snapMap = (rows) => new Map(rows.slice(1).map((p) => { const q = JSON.parse(JSON.stringify(p));   // the wire form (undefined fields absent)
  delete q.jobcrawl.last_seen; return [`${q.jobcrawl.board}|${q.jobcrawl.id}`, q]; }));
const openOnly = (m) => new Map([...m].filter(([, p]) => p.jobcrawl.status === 'open'));

test('sqlite: snapshot + records after its event_id == the later snapshot (adds, changes, departures, reappearance, URL variant, hash fill, baseline refresh)', async () => {
  // JSON side: a baseline epoch (bl rows whose fields differ from the live read), imported without events
  const jroot = tmp();
  const bl = baselineState('A', [{ url: job(1).url, title: 'Old title', location: 'Munich', first_seen: '2026-10-01', last_seen: '2026-10-31', status: 'open' },
    { url: job(2).url, title: 'Engineer 2', location: 'Munich', first_seen: '2026-10-01', last_seen: '2026-10-31', status: 'open' }]);
  jsonCommit(jroot, 'A', bl, []);
  const s = await openSqliteStore(tmp());
  assert.equal(s.importJson(jroot).events, 0);
  const S0 = s.snapshot({ status: null });
  assert.equal(S0[0].event_id, 0);
  const rules = { mode: 'misses', k: 1, floorH: 0 };
  run(s, 'A', ok([job(1), job(2), job(3)]), 1, rules);                                          // bl refresh of 1 (title), add 3
  run(s, 'B', ok([job(10), job(11, { description: 'x' })]), 1, rules);
  const S1 = s.snapshot({ status: null });
  run(s, 'A', ok([job(1, { url: job(1).url + '?utm_source=feed' }), job(2, { description: 'now with text' }), job(3, { title: 'Senior' })]), 2, rules);   // URL variant (same id), dh fill, change
  run(s, 'B', ok([job(11, { description: 'x' })]), 2, rules);                                    // 10 departs
  run(s, 'B', ok([job(10), job(11, { description: 'x' })]), 3, rules);                          // 10 reappears
  run(s, 'A', { ok: false, error: { cls: 'HTTP', detail: '503' } }, 4, rules);                   // failed read
  const S2 = s.snapshot({ status: null });
  const recs = s.events({ after: S1[0].event_id, limit: 10000 });
  assert.ok(recs.some((e) => e.op === 'refreshed' && e.seq === null), 'silent changes are carried as refreshed records');
  assert.deepEqual(applyRecords(snapMap(S1), recs), snapMap(S2), 'S1 + records == S2 (all statuses)');
  assert.deepEqual(openOnly(applyRecords(snapMap(S1), recs)), snapMap(s.snapshot({ status: 'open' })), 'open view');
  assert.deepEqual(applyRecords(snapMap(S0), s.events({ after: 0, limit: 10000 })), snapMap(S2), 'from the import snapshot too');
  // the watermarks of S1 are consistent with its event_id: per-board seq of every later delta event is above S1's watermark
  for (const e of recs) if (e.seq != null) assert.ok(e.seq > S1[0].watermarks[e.board]);
  s.close();
});

test('sqlite: ids are stored facts: a key-rule change keeps the id (no departed/added pair, seq moves by board-ok only)', async () => {
  const root = tmp();
  const U = 'https://careers.example.org/job/view?jid=123';
  const urlOnly = (u) => [`url:${normaliseUrl(u)}`];
  const withRule = (u) => { const m = /jid=(\d+)/.exec(u); return [...(m ? [`pk:example:org:${m[1]}`] : []), `url:${normaliseUrl(u)}`]; };
  let s = await openSqliteStore(root, { keysOf: urlOnly });
  const r1 = run(s, 'A', ok([{ url: U, title: 'T' }]), 0);
  const id = r1.events[0].id;
  assert.equal(id, idForKey(`url:${normaliseUrl(U)}`));
  s.close();
  // a vendor rule is added: the canonical key is now pk:..., the stored id stays
  s = await openSqliteStore(root, { keysOf: withRule });
  const r2 = run(s, 'A', ok([{ url: U + '&utm_source=x', title: 'T' }]), 1);
  assert.deepEqual(r2.events.map((e) => e.op), ['board-ok']);
  assert.equal(r2.seqFrom, r1.seqTo + 1);
  assert.equal(s.idOfKey('pk:example:org:123'), id, 'the new key is an alias of the stored id');
  assert.deepEqual(Object.keys(s.openBoard('A').postings), [id]);
  s.close();
  // the rule is removed again: still the same id
  s = await openSqliteStore(root, { keysOf: urlOnly });
  assert.deepEqual(run(s, 'A', ok([{ url: U, title: 'T' }]), 2).events.map((e) => e.op), ['board-ok']);
  s.close();
  // two postings that share a normalised URL but have their own canonical keys stay apart when listed together
  const spa = (u) => { const m = /#\/job\/(\d+)/.exec(u); return [...(m ? [`pk:spa:x:${m[1]}`] : []), `url:${normaliseUrl(u)}`]; };
  s = await openSqliteStore(tmp(), { keysOf: spa });
  const r = run(s, 'S', ok([{ url: 'https://x.example/#/job/1', title: 'a' }, { url: 'https://x.example/#/job/2', title: 'b' }]), 0);
  assert.deepEqual(r.events.map((e) => e.op), ['added', 'added', 'board-ok']);
  assert.notEqual(r.events[0].id, r.events[1].id);
  s.close();
});

test('sqlite: JSON import keeps ids today\'s rule would compute differently, emits 0 events, carries seq; skips unreadable states', async () => {
  const jroot = tmp();
  let st = null;
  for (const [h, items] of [[0, [job(1), job(2), job(3)]], [1, [job(1), job(2, { title: 'X' })]], [30, [job(1), job(2, { title: 'X' })]]]) {
    const r = applyRun(jsonOpen(jroot, 'A'), ok(items), { board: 'A', now: at(h) });
    jsonCommit(jroot, 'A', r.state, r.events); st = r.state;
  }
  // a posting whose stored id came from an older key rule
  const legacyId = 'jc1_' + 'a'.repeat(32);
  const st2 = structuredClone(jsonOpen(jroot, 'B'));
  st2.seq = 7; st2.postings[legacyId] = { url: job(9).url, title: 'Old', location: '', posted: '', dh: null, first_seen: at(0).toISOString(), last_seen: at(0).toISOString(), misses: 0, status: 'open' };
  jsonCommit(jroot, 'B', st2, []);
  mkdirSync(join(jroot, 'boards', boardKey('C')), { recursive: true });
  writeFileSync(join(jroot, 'boards', boardKey('C'), 'board.txt'), 'C\n');
  writeFileSync(join(jroot, 'boards', boardKey('C'), 'state.json'), '{not json');
  const root = tmp();
  const s = await openSqliteStore(root);
  const sum = s.importJson(jroot);
  assert.equal(sum.events, 0); assert.equal(s.maxEventId(), 0);
  assert.equal(sum.imported, 2); assert.deepEqual(sum.skipped.map((x) => x.board), ['C']);
  assert.deepEqual(s.openBoard('A'), st, 'the imported state deep-equals the JSON state');
  assert.deepEqual(s.openBoard('B'), st2);
  assert.equal(s.importJson(jroot).kept, 2, 'a second import keeps what is there');
  const r = run(s, 'B', ok([{ url: job(9).url, title: 'Old' }]), 31);
  assert.deepEqual(r.events.map((e) => e.op), ['board-ok'], 'the stored legacy id is found through its alias');
  assert.equal(r.seqFrom, 8);
  assert.equal(postingId(job(9).url) === legacyId, false);
  s.close();
  // a folder holds one backend
  await assert.rejects(openStore(jroot, { kind: 'sqlite' }), /import them first/);
  await assert.rejects(openStore(root, { kind: 'json' }), /--store sqlite/);
  await assert.rejects(openStore(root, { kind: 'mongo' }), StateError);
});

// ---- child processes ----
function child(args) {
  const c = spawn(process.execPath, [CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: ENV });
  let out = '', err = '', code = null;
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((r) => c.on('exit', (x, sig) => { code = x ?? sig; r(code); }));
  const waitFor = async (re, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const m = re.exec(out);
      if (m) return m;
      if (code !== null) assert.fail(`child exited ${code} before ${re}; stdout:\n${out}\nstderr:\n${err}`);
      if (Date.now() > end) { c.kill('SIGKILL'); assert.fail(`no ${re} within ${ms} ms; stderr:\n${err}`); }
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const kill = async () => { c.kill('SIGKILL'); await exited; };   // by the child's own handle (its PID), never by name
  return { c, waitFor, kill, exited, out: () => out, err: () => err };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('two processes: concurrent first open and writers on one store; per-board seq contiguous, global event_id unique and each run contiguous', { timeout: 120000 }, async () => {
  const root = tmp();   // not created beforehand: the four processes race on the first open (schema creation) too
  const ws = [child(['writer', root, 'shared', '25', 'x']), child(['writer', root, 'shared', '25', 'y']), child(['writer', root, 'own1', '25', 'p']), child(['writer', root, 'own2', '25', 'q'])];
  const codes = await Promise.all(ws.map((w) => w.exited));
  ws.forEach((w, i) => assert.equal(codes[i], 0, w.err()));
  const s = await openSqliteStore(root);
  const recs = s.events({ after: 0, limit: 100000 });
  const ids = recs.map((e) => e.event_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [...ids].sort((x, y) => x - y));
  for (const b of ['shared', 'own1', 'own2']) {
    const seqs = recs.filter((e) => e.board === b && e.seq != null).map((e) => e.seq);
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1), `${b}: seq 1..n without gaps`);
    assert.equal(s.openBoard(b).seq, seqs.length);
  }
  assert.equal(s.openBoard('shared').runs, 50);
  const byRun = new Map();
  for (const e of recs) (byRun.get(`${e.board}|${e.run}`) ?? byRun.set(`${e.board}|${e.run}`, []).get(`${e.board}|${e.run}`)).push(e.event_id);
  for (const [k, v] of byRun) assert.equal(v.at(-1) - v[0] + 1, v.length, `run ${k} committed as one block`);
  assert.equal(s.integrity(), 'ok');
  s.close();
});

test('two processes: a lease held by another process blocks; after its holder is killed the lease frees at expiry', { timeout: 60000 }, async () => {
  const root = tmp();
  const s = await openSqliteStore(root);
  const h = child(['lease', root, 'A', '1500']);
  await h.waitFor(/GOT/);
  assert.equal(s.lease('A', 60000), null);
  await h.kill();
  assert.equal(s.lease('A', 60000), null, 'still held until its expiry');
  await sleep(1600);
  const rel = s.lease('A', 60000);
  assert.equal(typeof rel, 'function');
  rel();
  s.close();
});

test('crash: a child killed inside the commit transaction leaves nothing of the run; reopened store is consistent and writable', { timeout: 60000 }, async () => {
  const root = tmp();
  const s0 = await openSqliteStore(root);
  run(s0, 'A', ok([job(1)]), 0);
  s0.close();
  const k = child(['crash', root, 'A', 'mid']);
  await k.waitFor(/MID/);
  await k.kill();
  const s = await openSqliteStore(root);
  assert.equal(s.integrity(), 'ok');
  assert.equal(s.openBoard('A').seq, 2, 'seq unchanged');
  assert.equal(s.maxEventId(), 2, 'no events of the killed run');
  assert.deepEqual(Object.keys(s.openBoard('A').postings), [postingId(job(1).url)]);
  const r = run(s, 'A', ok([job(1), job(2)]), 5);
  assert.equal(r.seqFrom, 3, 'the next run continues the sequence');
  s.close();
  // killed right after COMMIT: the run is there
  const k2 = child(['crash', root, 'A', 'after']);
  await k2.waitFor(/DONE/);
  await k2.kill();
  const s2 = await openSqliteStore(root);
  assert.equal(s2.integrity(), 'ok');
  assert.ok(s2.openBoard('A').seq > 4);
  assert.equal(s2.events({ after: 0, limit: 1000 }).filter((e) => e.seq != null).at(-1).seq, s2.openBoard('A').seq);
  s2.close();
});

test('host slots are shared across processes; a killed holder blocks the host only until its slot expires', { timeout: 60000 }, async () => {
  const root = tmp();
  const s = await openSqliteStore(root);
  const h = child(['slot', root, 'boards.greenhouse.io', '1', '1500']);
  const m = await h.waitFor(/\{.*\}/);
  assert.ok(JSON.parse(m[0]).token);
  assert.equal(s.acquireHost('boards.greenhouse.io', { limit: 1 }).reason, 'slots');
  assert.ok(s.acquireHost('jobs.lever.co', { limit: 1 }).token, 'other hosts are free');
  await h.kill();
  await sleep(1600);
  const got = s.acquireHost('boards.greenhouse.io', { limit: 1 });
  assert.ok(got.token);
  got.release();
  assert.equal(s.hostSlots('boards.greenhouse.io'), 0);
  s.close();
});

test('cooldowns and the time-window breaker live in the store (one view for every handle)', async () => {
  const root = tmp();
  let t = 1_000_000;
  const clock = () => t;
  const a = await openSqliteStore(root, { clock }), b = await openSqliteStore(root, { clock });
  a.setCooldown('h', t + 60e3, '429 Retry-After');
  assert.deepEqual(b.cooldown('h'), { until: t + 60e3, reason: '429 Retry-After' });
  a.setCooldown('h', t + 10e3, 'shorter');
  assert.equal(b.cooldown('h').until, t + 60e3, 'a later cooldown is kept');
  assert.equal(b.acquireHost('h').reason, 'cooldown');
  t += 61e3;
  assert.equal(b.cooldown('h'), null);
  const o = { windowMs: 10e3, threshold: 3, openMs: 30e3 };
  a.breakerRecord('k', false, o); t += 1e3; b.breakerRecord('k', false, o);
  t += 20e3;                                                       // the first two leave the window
  assert.equal(a.breakerRecord('k', false, o).state, 'closed');
  a.breakerRecord('k', false, o); assert.equal(b.breakerRecord('k', false, o).state, 'open');
  assert.equal(a.breakerState('k').state, 'open');
  t += 31e3;
  assert.equal(b.breakerState('k').state, 'half-open');
  assert.equal(a.breakerRecord('k', false, o).state, 'open', 'a failure while half-open re-opens at once');
  t += 31e3;
  assert.equal(a.breakerRecord('k', true, o).state, 'closed');
  assert.equal(b.breakerState('k').state, 'closed');
  a.close(); b.close();
});

test('runner: a busy SQLite store is a store error (exit 4), not a board failure', { timeout: 30000 }, async () => {
  const root = tmp();
  const holder = await openSqliteStore(root);
  const s = await openSqliteStore(root, { busyMs: 50 });
  holder.db.exec('BEGIN IMMEDIATE');
  try {
    const r = await runCycle(join(root, 'cycle'), [{ name: 'A' }], { store: s, readFor: () => ok([job(1)]) });
    assert.equal(r.code, EXIT.STATE);
  } finally { holder.db.exec('ROLLBACK'); }
  const r = await runCycle(join(root, 'cycle'), [{ name: 'A' }], { store: s, readFor: () => ok([job(1)]) });
  assert.equal(r.code, EXIT.OK);
  assert.equal(s.openBoard('A').seq, 2);
  holder.close(); s.close();
});

// ---- CLI ----
function fixture(n) {
  const base = tmp('jcx-sqcli-');
  const prof = join(base, 'profile'), rec = join(base, 'rec');
  for (const d of [prof, join(rec, 'lists')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 't', crawl: { user_agent: 'jcx-test (+https://example.org)' } }));
  const boards = Array.from({ length: n }, (_, i) => ({ name: `B${i + 1}`, provider: 'greenhouse', slug: `b${i + 1}` }));
  writeFileSync(join(prof, 'companies.json'), JSON.stringify({ tracked_companies: boards }));
  boards.forEach((b, i) => writeFileSync(join(rec, 'lists', `${boardKey(b.name)}.json.gz`), gzipSync(JSON.stringify({ board: b.name, provider: 'greenhouse', complete: true,
    items: [{ url: `https://boards.greenhouse.io/x/jobs/${i + 1}`, title: `Job ${i + 1}`, location: 'Berlin' }] }))));
  const routing = join(base, 'routing.json');
  writeFileSync(routing, JSON.stringify({ schema: 'routing/v1', providers: { greenhouse: 'shadow' } }));
  return { base, prof, rec, routing, data: join(base, 'data') };
}
const cli = (args, { warnings = false } = {}) => spawnSync(process.execPath, [...(warnings ? [] : ['--no-warnings']), '--import', pathToFileURL(NO_NET).href, CLI, ...args],
  { encoding: 'utf8', env: ENV, input: '' });
const runArgs = (f, extra = []) => ['run', '--profile', f.prof, '--data', f.data, '--routing', f.routing, '--replay', f.rec, '--log-file', join(f.base, 'run.jsonl'), ...extra];

test('cli: run --store sqlite, feed --after / --consumer --commit, bookmark get/set, bad --store exits 2, no ExperimentalWarning on stderr', () => {
  const f = fixture(2);
  let r = cli(runArgs(f, ['--store', 'sqlite', '--json']), { warnings: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '', 'nothing on stderr: the SQLite ExperimentalWarning is filtered');
  assert.ok(existsSync(join(f.data, SQLITE_FILE)));
  r = cli(['feed', '--data', f.data, '--store', 'sqlite', '--after', '0', '--limit', '3'], { warnings: true });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, '');
  const recs = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(recs.map((e) => e.event_id), [1, 2, 3]);
  r = cli(['feed', '--data', f.data, '--store', 'sqlite', '--consumer', 'pub', '--commit', '--limit', '3']);
  assert.equal(r.stdout.trim().split('\n').length, 3);
  r = cli(['bookmark', 'get', '--data', f.data, '--consumer', 'pub', '--json']);
  assert.deepEqual(JSON.parse(r.stdout), { consumer: 'pub', event_id: 3 });
  r = cli(['feed', '--data', f.data, '--store', 'sqlite', '--consumer', 'pub']);
  assert.deepEqual(r.stdout.trim().split('\n').map((l) => JSON.parse(l).event_id), [4]);
  r = cli(['bookmark', 'set', '--data', f.data, '--consumer', 'pub', '--event-id', '99']);
  assert.equal(r.status, 2);
  r = cli(['feed', '--data', f.data, '--store', 'sqlite', '--since', 'B1=1']);
  assert.deepEqual(r.stdout.trim().split('\n').map((l) => JSON.parse(l)).map((e) => `${e.board}:${e.seq}`), ['B1:2', 'B2:1', 'B2:2']);
  r = cli(['snapshot', '--data', f.data, '--store', 'sqlite']);
  const head = JSON.parse(r.stdout.split('\n')[0]);
  assert.equal(head.event_id, 4); assert.deepEqual(head.watermarks, { B1: 2, B2: 2 });
  r = cli(runArgs(f, ['--store', 'bogus']));
  assert.equal(r.status, 2); assert.match(r.stderr, /--store expects json or sqlite/);
  r = cli(runArgs(f, ['--store', 'json']));
  assert.equal(r.status, 4, 'a json run on a sqlite folder is refused'); assert.match(r.stderr, /--store sqlite/);
});

test('cli: the default JSON run prints no ExperimentalWarning either (lease database)', () => {
  const f = fixture(1);
  const r = cli(runArgs(f), { warnings: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.ok(existsSync(join(f.data, 'leases.sqlite')), 'the JSON path did load node:sqlite');
});

test('cli: store-import moves a JSON folder without events; a sqlite run before the import is refused (exit 4)', () => {
  const f = fixture(2);
  let r = cli(runArgs(f, ['--json']));
  assert.equal(r.status, 0, r.stderr);
  r = cli(runArgs(f, ['--store', 'sqlite']));
  assert.equal(r.status, 4); assert.match(r.stderr, /import them first/);
  r = cli(['store-import', '--data', f.data, '--json'], { warnings: true });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr.includes('ExperimentalWarning'), false);
  const sum = JSON.parse(r.stdout);
  assert.equal(sum.imported, 2); assert.equal(sum.events, 0);
  r = cli(['feed', '--data', f.data, '--store', 'sqlite', '--after', '0']);
  assert.equal(r.stdout.trim(), '', '0 events after the import');
  r = cli(runArgs(f, ['--store', 'sqlite', '--every-min', '0', '--json']));
  assert.equal(r.status, 0, r.stderr);
  r = cli(['feed', '--data', f.data, '--store', 'sqlite', '--after', '0']);
  const recs = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(recs.map((e) => e.op), ['board-ok', 'board-ok'], 'the first sqlite run after the import emits no "everything added" burst');
  assert.deepEqual(recs.map((e) => e.seq), [3, 3], 'the per-board seq continues from the JSON states');
});
