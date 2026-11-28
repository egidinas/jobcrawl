// `run --due` (row 2A.1): due selection, cadence and backoff, hard per-board budget, shared host slots across processes, breaker, 429 cooldown,
// worker isolation, CLI contract. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { openSqliteStore } from '../state/sqlite-store.mjs';
import { boardKey } from '../state/board-store.mjs';
import { runDue, selectDue, intervalMs, backoffMs, makeThrottleFetch, makeWorkerReader, MAX_INTERVAL_MS } from '../headless/due.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'cli', 'jobcrawl.mjs');
const CHILD = join(ROOT, 'core', 'tests', 'helpers', 'due-child.mjs');
const READER = pathToFileURL(join(ROOT, 'core', 'tests', 'helpers', 'due-reader.mjs')).href;
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JOBCRAWL_')));
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const T0 = Date.parse('2026-11-28T00:00:00Z');
const H = 3600e3;
const job = (n) => [{ url: `https://boards.greenhouse.io/x/jobs/${n}`, title: `Job ${n}`, location: 'Berlin' }];
const entry = (name, extra = {}) => ({ name, provider: 'greenhouse', slug: name.toLowerCase(), ...extra });
async function sqlite(opts) { const s = await openSqliteStore(tmp('jcx-due-'), opts); s.supports = (n) => typeof s[n] === 'function'; return s; }
const withFetch = (fetch) => ({ providers: { greenhouse: { fetch } } });

test('due selection is deterministic for a fixed now: oldest next_due first, then name; max-boards cuts', async () => {
  const s = await sqlite();
  const boards = ['C', 'A', 'B', 'D', 'E'].map((n) => entry(n));
  s.cadenceSet('A', { next_due: T0 - 2 * H }); s.cadenceSet('B', { next_due: T0 - 2 * H }); s.cadenceSet('C', { next_due: T0 - H });
  s.cadenceSet('D', { next_due: T0 + 1 });   // not yet due
  // E has no row: due at once (next_due 0), so it comes first
  const pick = (o) => selectDue(boards, s.cadenceList(), { now: T0, ...o }).map((d) => d.entry.name);
  assert.deepEqual(pick(), ['E', 'A', 'B', 'C']);
  assert.deepEqual(pick(), pick());
  assert.deepEqual(pick({ maxBoards: 2 }), ['E', 'A']);
  assert.deepEqual(selectDue(boards, [], { now: T0 }).map((d) => d.entry.name), ['A', 'B', 'C', 'D', 'E']);
  s.close();
});

test('cadence: interval from interval_hours (clamped), failures back off exponentially and are capped, success resets', async () => {
  assert.equal(intervalMs({ interval_hours: 6 }), 6 * H);
  assert.equal(intervalMs({ interval_hours: 500 }), MAX_INTERVAL_MS);
  assert.equal(intervalMs({ interval_hours: 0.01 }), 15 * 60e3);
  assert.equal(intervalMs({}, 12), 12 * H);
  assert.deepEqual([1, 2, 3, 4].map((n) => backoffMs(n) / 60e3), [15, 30, 60, 120]);
  assert.equal(backoffMs(40), MAX_INTERVAL_MS);
  const s = await sqlite();
  let ok = false, now = T0;
  const fetch = async () => { if (!ok) throw new Error('HTTP 500 boom'); return job(1); };
  const go = () => runDue(s, [entry('Slow', { interval_hours: 6 })], { now: () => now, readOptions: withFetch(fetch), boardMs: () => 2000 });
  let r = await go(); assert.equal(r.failed, 1);
  let row = s.cadenceGet('Slow'); assert.equal(row.failures, 1); assert.equal(row.last_cls, 'HTTP_5XX'); assert.equal(row.next_due, T0 + 15 * 60e3);
  now = T0 + 15 * 60e3; await go(); row = s.cadenceGet('Slow'); assert.equal(row.failures, 2); assert.equal(row.next_due, now + 30 * 60e3);
  now += 10 * 60e3; r = await go(); assert.equal(r.selected, 0, 'inside the backoff: not due');
  ok = true; now += 30 * 60e3; r = await go(); assert.equal(r.ok, 1);
  row = s.cadenceGet('Slow'); assert.equal(row.failures, 0); assert.equal(row.last_ok, now); assert.equal(row.next_due, now + 6 * H);
  s.close();
});

test('a hanging source is cut at its budget, its requests are aborted, the other boards finish', async () => {
  const s = await sqlite();
  let hungSignal = null;
  const fetch = async (slug, e, ctx) => {
    if (slug === 'hang') { hungSignal = ctx.signal; return new Promise(() => {}); }   // never answers, ignores the signal
    return job(slug);
  };
  const boards = [entry('Hang'), entry('Fast1'), entry('Fast2')];
  const t = Date.now();
  const r = await runDue(s, boards, { readOptions: withFetch(fetch), boardMs: () => 300, graceMs: 200, concurrency: 3, hostOf: (e) => `h-${e.name}` });
  assert.ok(Date.now() - t < 3000, 'the run does not wait for the hung board');
  assert.equal(r.ok, 2); assert.equal(r.failed, 1); assert.equal(r.timedOut, 1);
  assert.equal(hungSignal.aborted, true, 'its in-flight requests were aborted');
  assert.equal(s.cadenceGet('Hang').failures, 1);
  assert.equal(s.cadenceGet('Hang').last_cls, 'TIMEOUT_TLS');
  assert.equal(s.cadenceGet('Fast1').failures, 0);
  assert.equal(s.listBoards().includes('Fast2'), true);
  assert.equal(s.hostSlots('h-Hang'), 0, 'its host slot is released');
  s.close();
});

test('a board whose run ignores every signal is hard-cut at budget + grace and not applied', async () => {
  const s = await sqlite();
  const runBoardImpl = async (st, e) => { if (e.name === 'Stuck') return new Promise(() => {}); return { board: e.name, run: { ok: true }, seqFrom: 1, seqTo: 1 }; };
  const r = await runDue(s, [entry('Stuck'), entry('Fine')], { runBoardImpl, boardMs: () => 150, graceMs: 100, concurrency: 2, hostOf: (e) => e.name });
  assert.equal(r.timedOut, 1); assert.equal(r.ok, 1);
  assert.match(s.cadenceGet('Stuck').last_error, /hard budget/);
  s.close();
});

test('the outer abort (SIGTERM) stops the run: the board in flight is discarded and gets no cadence row', async () => {
  const s = await sqlite();
  const ac = new AbortController();
  const fetch = async () => { setTimeout(() => ac.abort('SIGTERM'), 50); return new Promise(() => {}); };
  const r = await runDue(s, [entry('A'), entry('B')], { readOptions: withFetch(fetch), boardMs: () => 5000, concurrency: 1, signal: ac.signal });
  assert.equal(r.interrupted, true); assert.equal(r.ran, 0);
  assert.equal(s.cadenceGet('A'), null);
  s.close();
});

test('the breaker opens after N host failures, defers the next board to its open_until, half-opens and closes on a success', async () => {
  let clock = T0;
  const s = await sqlite({ clock: () => clock });
  let ok = false;
  const fetch = async () => { if (!ok) throw new Error('fetch failed'); return job(1); };
  const base = { readOptions: withFetch(fetch), boardMs: () => 2000, concurrency: 1, hostOf: () => 'sick.example', breaker: { threshold: 2, openMs: 10 * 60e3, windowMs: 60 * 60e3 }, now: () => clock };
  const go = (names) => runDue(s, names.map((n) => entry(n)), base);
  await go(['B1']); assert.equal(s.breakerState('host:sick.example').state, 'closed');
  await go(['B2']); const st = s.breakerState('host:sick.example'); assert.equal(st.state, 'open'); assert.equal(st.until, T0 + 10 * 60e3);
  const r = await go(['B3']);
  assert.equal(r.deferred, 1); assert.equal(r.ran, 0);
  assert.equal(s.cadenceGet('B3').next_due, T0 + 10 * 60e3, 'deferred to the breaker open_until');
  assert.equal(s.cadenceGet('B3').failures, 0, 'a deferral is not a failure');
  clock = T0 + 11 * 60e3;
  assert.equal(s.breakerState('host:sick.example').state, 'half-open');
  await go(['B4']);   // the probe fails: re-open at once
  assert.equal(s.breakerState('host:sick.example').state, 'open');
  clock += 11 * 60e3; ok = true;
  const p = await go(['B5']);   // the probe succeeds: closed
  assert.equal(p.ok, 1); assert.equal(s.breakerState('host:sick.example').state, 'closed');
  s.close();
});

test('429 with Retry-After sets the host cooldown; a due board on that host is deferred to it', async () => {
  const s = await sqlite();
  const seen = [];
  const mk = (status, headers = {}) => makeThrottleFetch(async () => new Response('', { status, headers }), { store: s, now: () => T0, onCooldown: (h, st, ms) => seen.push([h, st, ms]) });
  await mk(429, { 'retry-after': '7' })('https://api.slow.example/jobs');
  assert.deepEqual(seen[0], ['api.slow.example', 429, 7000]);
  assert.equal(s.cooldown('api.slow.example', () => T0).until, T0 + 7000);
  await mk(429, { 'retry-after': new Date(T0 + 90e3).toUTCString() })('https://date.example/x');
  assert.equal(seen[1][2], 90e3);
  await mk(429)('https://plain.example/x'); assert.equal(seen[2][2], 30e3);
  await mk(503)('https://five.example/x'); assert.equal(seen[3][2], 10e3);
  await mk(200)('https://fine.example/x'); assert.equal(seen.length, 4);
  await makeThrottleFetch(async () => new Response('', { status: 429, headers: { 'retry-after': '99999' } }), { store: s, now: () => T0 })('https://cap.example/x');
  assert.equal(s.cooldown('cap.example', () => T0).until, T0 + 3600e3, 'capped at one hour');
  // the deferral: the cooldown must lie in the store clock's future
  const until = Date.now() + 60e3;
  s.setCooldown('busy.example', until, 'HTTP 429');
  const r = await runDue(s, [entry('Held')], { readOptions: withFetch(async () => job(1)), hostOf: () => 'busy.example', now: () => T0 });
  assert.equal(r.deferred, 1); assert.equal(r.ran, 0);
  assert.equal(s.cadenceGet('Held').next_due, until);
  s.close();
});

test('worker isolation: a catastrophic regex hangs only its worker, which is terminated at the budget; the others finish', async () => {
  const s = await sqlite();
  const isolatedRead = makeWorkerReader({ readerModule: READER, graceMs: 300 });
  const t = Date.now();
  const r = await runDue(s, [entry('evil'), entry('good1'), entry('good2')], { isolatedRead, boardMs: () => 600, graceMs: 1500, concurrency: 3, hostOf: (e) => e.name });
  assert.ok(Date.now() - t < 5000, `finished in ${Date.now() - t} ms`);
  assert.equal(r.ok, 2); assert.equal(r.timedOut, 1);
  assert.equal(s.cadenceGet('evil').last_cls, 'TIMEOUT_TLS');
  assert.ok(s.listBoards().includes('good1'));
  s.close();
});

test('two processes on one store respect the host slots: no overlap at perHost 1, and both finish', async () => {
  const root = tmp('jcx-due-race-'), logfile = join(root, 'slots.log');
  writeFileSync(logfile, '');
  const run = (tag) => new Promise((ok, bad) => {
    const c = spawn(process.execPath, ['--no-warnings', CHILD, root, logfile, tag, '4', '80', '1'], { env: ENV, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; });
    c.on('error', bad); c.on('exit', (code) => (code === 0 ? ok(JSON.parse(out.trim().split('\n').pop())) : bad(new Error(`child ${tag} exit ${code}: ${out}`))));
  });
  const [a, b] = await Promise.all([run('pa'), run('pb')]);
  assert.equal(a.ran, 4); assert.equal(b.ran, 4); assert.equal(a.failed + b.failed, 0);
  const ev = readFileSync(logfile, 'utf8').trim().split('\n').map((l) => l.split(' ')).map(([k, tag, t]) => ({ k, tag, t: Number(t) }));
  ev.sort((x, y) => x.t - y.t || (x.k === 'exit' ? -1 : 1));   // at an equal millisecond an exit counts first
  let open = 0, max = 0;
  for (const e of ev) { open += e.k === 'enter' ? 1 : -1; max = Math.max(max, open); }
  assert.equal(ev.length, 16);
  assert.equal(max, 1, 'never more than one request on the shared host');
  const s = await openSqliteStore(root); assert.equal(s.hostSlots('one-host.example'), 0, 'every slot released'); s.close();
});

// ---- CLI ----
function fixture(n) {
  const base = tmp('jcx-duecli-');
  const prof = join(base, 'profile'), rec = join(base, 'rec');
  for (const d of [prof, join(rec, 'lists')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 't', crawl: { user_agent: 'jcx-test (+https://example.org)' } }));
  const boards = Array.from({ length: n }, (_, i) => ({ name: `B${i + 1}`, provider: 'greenhouse', slug: `b${i + 1}`, ...(i === 0 ? { interval_hours: 2 } : {}) }));
  writeFileSync(join(prof, 'companies.json'), JSON.stringify({ tracked_companies: boards }));
  boards.forEach((b, i) => writeFileSync(join(rec, 'lists', `${boardKey(b.name)}.json.gz`), gzipSync(JSON.stringify({ board: b.name, provider: 'greenhouse', complete: true, items: job(i + 1) }))));
  const routing = join(base, 'routing.json');
  writeFileSync(routing, JSON.stringify({ schema: 'routing/v1', providers: { greenhouse: 'shadow' } }));
  return { prof, rec, routing, data: join(base, 'data') };
}
const cli = (f, extra, store = 'sqlite') => spawnSync(process.execPath, ['--no-warnings', CLI, 'run', '--due', '--profile', f.prof, '--data', f.data, '--routing', f.routing, '--replay', f.rec, '--store', store, '--json', ...extra],
  { encoding: 'utf8', env: ENV, input: '' });
const last = (r) => JSON.parse(r.stdout.trim().split('\n').pop());

test('CLI: run --due picks boards by their own cadence under a fixed --now; --max-boards cuts; json store and --daemon are usage errors', () => {
  const f = fixture(3);
  let r = cli(f, ['--now', '2026-11-28T00:00:00Z', '--max-boards', '2']);
  assert.equal(r.status, 0, r.stderr); assert.equal(last(r).ran, 2); assert.equal(last(r).selected, 2);
  assert.deepEqual(last(r).results.map((x) => x.board), ['B1', 'B2']);
  r = cli(f, ['--now', '2026-11-28T00:00:00Z']);   // same instant: only the never-run board is due
  assert.equal(last(r).ran, 1); assert.deepEqual(last(r).results.map((x) => x.board), ['B3']);
  r = cli(f, ['--now', '2026-11-28T00:00:00Z']); assert.equal(last(r).selected, 0);
  r = cli(f, ['--now', '2026-11-28T03:00:00Z']);   // B1 has interval_hours 2; the others the 24 h default
  assert.deepEqual(last(r).results.map((x) => x.board), ['B1']);
  r = cli(f, ['--now', '2026-11-29T00:00:01Z']); assert.equal(last(r).ran, 3);
  assert.equal(cli(fixture(1), ['--now', '2026-11-28T00:00:00Z'], 'json').status, 2);
  assert.equal(cli(f, ['--daemon']).status, 2);
});
