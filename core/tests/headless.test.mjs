// Headless pack (phase 2A.3): exit codes, resumable cycle, run lock, JSON-lines logs, health/metrics endpoint, CLI contract. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { EXIT, EXIT_TEXT } from '../headless/exit.mjs';
import { createLogger } from '../headless/log.mjs';
import { createMetrics, serveMetrics, parseListen } from '../headless/metrics.mjs';
import { runCycle, acquireLock, readRunState } from '../headless/runner.mjs';
import { StateError, boardKey, readEvents } from '../state/board-store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'cli', 'jobcrawl.mjs');
const NO_NET = join(mkdtempSync(join(tmpdir(), 'jcx-nonet-')), 'nonet.mjs');
writeFileSync(NO_NET, "globalThis.fetch = () => { console.error('NETWORK USED'); process.exit(99); };\n"
  + "import dns from 'node:dns'; dns.lookup = () => { console.error('NETWORK USED'); process.exit(99); };\n");
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('JOBCRAWL_')));   // the host's own JOBCRAWL_* settings must not leak into the runs
const nodeArgs = ['--no-warnings', '--import', pathToFileURL(NO_NET).href, CLI];
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const items = (n) => [{ url: `https://boards.greenhouse.io/x/jobs/${n}`, title: `Job ${n}`, location: 'Berlin' }];
const read = (n) => ({ ok: true, items: items(n), complete: true });
const mkBoards = (n) => Array.from({ length: n }, (_, i) => ({ name: `B${i + 1}`, provider: 'greenhouse', slug: `b${i + 1}` }));
const sink = () => { const lines = []; return { lines, log: createLogger({ format: 'json', write: (s) => lines.push(s) }) }; };

/** A profile, a routing file and a recording of n boards, for CLI runs. */
function fixture(n, { extraBoards = 0 } = {}) {
  const base = tmp('jcx-hl-');
  const prof = join(base, 'profile'), rec = join(base, 'rec');
  for (const d of [prof, join(rec, 'lists')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 't', crawl: { user_agent: 'jcx-test (+https://example.org)' } }));
  const boards = mkBoards(n + extraBoards);
  writeFileSync(join(prof, 'companies.json'), JSON.stringify({ tracked_companies: boards }));
  boards.slice(0, n).forEach((b, i) => writeFileSync(join(rec, 'lists', `${boardKey(b.name)}.json.gz`), gzipSync(JSON.stringify({ board: b.name, provider: 'greenhouse', complete: true, items: items(i + 1) }))));
  const routing = join(base, 'routing.json');
  writeFileSync(routing, JSON.stringify({ schema: 'routing/v1', providers: { greenhouse: 'shadow' } }));
  return { base, prof, rec, routing, data: join(base, 'data') };
}
const cliRun = (f, extra = [], env = {}, opts = {}) => spawnSync(process.execPath, [...nodeArgs, 'run', '--profile', f.prof, '--data', f.data, '--routing', f.routing, '--replay', f.rec, ...extra],
  { encoding: 'utf8', env: { ...ENV, ...env }, input: '', ...opts });

test('exit codes: the documented table, every code has a text', () => {
  assert.deepEqual(Object.values(EXIT).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 130, 143]);
  for (const c of Object.values(EXIT)) assert.ok(EXIT_TEXT[c], `text for ${c}`);
  const doc = readFileSync(join(ROOT, 'docs', 'HEADLESS.md'), 'utf8');
  for (const c of Object.values(EXIT)) assert.match(doc, new RegExp(`\\|\\s*${c}\\s*\\|`), `docs/HEADLESS.md lists exit code ${c}`);
});

test('logger: JSON lines parse one by one; text format is one line; bad format throws', () => {
  const { lines, log } = sink();
  log.info('board', { board: 'A', ok: true }); log.warn('budget-hit', { left: 3 });
  assert.equal(lines.length, 2);
  const o = JSON.parse(lines[0]);
  assert.equal(o.event, 'board'); assert.equal(o.level, 'info'); assert.equal(o.board, 'A'); assert.ok(Date.parse(o.t));
  const txt = []; createLogger({ format: 'text', write: (s) => txt.push(s) }).error('boom', { why: 'x y' });
  assert.match(txt[0], /ERROR boom why=x y\n$/);
  assert.throws(() => createLogger({ format: 'xml' }), /log-format/);
});

test('cycle: SIGTERM mid-run discards the board in flight, a restart resumes with the rest and ends complete', async () => {
  const data = tmp('jcx-resume-'), boards = mkBoards(5);
  const ac = new AbortController();
  const { runBoard } = await import('../run-board.mjs');
  let calls = 0;
  const impl = async (d, e, o) => {
    if (++calls === 3) { ac.abort('SIGTERM'); return { board: e.name, aborted: true }; }   // the signal arrives while board 3 is being read
    return runBoard(d, e, o);
  };
  const { lines, log } = sink();
  let r = await runCycle(data, boards, { readFor: (e) => read(Number(e.name.slice(1))), signal: ac.signal, runBoardImpl: impl, log });
  assert.equal(r.code, EXIT.SIGTERM);
  let st = readRunState(data);
  assert.equal(st.status, 'interrupted');
  assert.deepEqual(Object.keys(st.done), ['B1', 'B2']);
  assert.ok(!existsSync(join(data, 'run.lock')), 'lock released');
  assert.ok(!existsSync(join(data, 'boards', boardKey('B3'), 'state.json')), 'the board in flight left no state');
  // restart: only the three boards not done are read
  const seen = [];
  r = await runCycle(data, boards, { readFor: (e) => { seen.push(e.name); return read(Number(e.name.slice(1))); }, log });
  assert.equal(r.code, EXIT.OK);
  assert.deepEqual(seen, ['B3', 'B4', 'B5']);
  assert.equal(r.summary.resumed, true);
  st = readRunState(data);
  assert.equal(st.status, 'complete');
  assert.equal(Object.keys(st.done).length, 5);
  assert.ok(lines.every((l) => JSON.parse(l).event));
  // the next call is a new cycle, and --every-min makes it a no-op while the last one is fresh
  r = await runCycle(data, boards, { readFor: () => assert.fail('not due'), everyMs: 3600e3 });
  assert.equal(r.summary.skipped, 'not due');
});

test('cycle: abort passed to readBoard stops the request in flight and applies nothing', async () => {
  const { readBoard, runBoard } = await import('../run-board.mjs');
  const ac = new AbortController();
  const providers = { greenhouse: { fetch: (slug, entry, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })) } };
  const p = readBoard({ name: 'S', provider: 'greenhouse', slug: 's' }, { providers, resolve: (e) => ({ provider: e.provider, slug: e.slug }), signal: ac.signal });
  ac.abort('SIGTERM');
  assert.equal((await p).ok, false);
  const data = tmp('jcx-abort-');
  const r = await runBoard(data, { name: 'S', provider: 'greenhouse', slug: 's' }, { providers, resolve: (e) => ({ provider: e.provider, slug: e.slug }), signal: ac.signal });
  assert.equal(r.aborted, true);
  assert.equal([...readEvents(data, {})].length, 0);
});

test('cycle: budget (--max-minutes) leaves the cycle open and the next run continues; failures exit 1; store errors exit 4', async () => {
  const data = tmp('jcx-budget-'), boards = mkBoards(3);
  let t = 0; const now = () => t;
  const { runBoard } = await import('../run-board.mjs');
  const impl = async (d, e, o) => { t += 60e3; return runBoard(d, e, o); };
  let r = await runCycle(data, boards, { readFor: (e) => read(Number(e.name.slice(1))), maxMs: 90e3, now, runBoardImpl: impl });
  assert.equal(r.code, EXIT.OK);
  assert.equal(readRunState(data).status, 'open');
  assert.equal(Object.keys(readRunState(data).done).length, 2);
  r = await runCycle(data, boards, { readFor: (e) => read(Number(e.name.slice(1))), now, runBoardImpl: impl });
  assert.equal(readRunState(data).status, 'complete');
  // a failing board
  const d2 = tmp('jcx-fail-');
  r = await runCycle(d2, boards, { readFor: (e) => (e.name === 'B2' ? { ok: false, items: [], error: { cls: 'HTTP_5XX', detail: 'down' } } : read(1)) });
  assert.equal(r.code, EXIT.BOARDS_FAILED);
  assert.deepEqual(r.summary.failed_boards, ['B2']);
  // a store error
  const d3 = tmp('jcx-store-');
  r = await runCycle(d3, boards, { runBoardImpl: async () => { throw new StateError('state.json is corrupt'); } });
  assert.equal(r.code, EXIT.STATE);
});

test('cycle: --strict exits 5 on a board that read zero postings after it had some; lock held exits 3', async () => {
  const data = tmp('jcx-strict-'), boards = mkBoards(1);
  const stub = (n) => async (d, e) => ({ board: e.name, run: { ok: true }, events: [], state: { postings: Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { status: 'open' }])) } });
  let r = await runCycle(data, boards, { runBoardImpl: stub(2), strict: true });
  assert.equal(r.code, EXIT.OK);
  r = await runCycle(data, boards, { runBoardImpl: stub(0), strict: true });
  assert.equal(r.summary.alerts[0]?.alert, 'zero-jobs');
  assert.equal(r.code, EXIT.STRICT);
  const lk = acquireLock(data);
  assert.ok(lk);
  r = await runCycle(data, boards, { readFor: () => read(1) });
  assert.equal(r.code, EXIT.LOCKED);
  lk.release();
  // an expired lock and a dead pid on this host are taken over
  writeFileSync(join(data, 'run.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, host: (await import('node:os')).hostname(), expires: Date.now() + 1e6 }));
  const lk2 = acquireLock(data); assert.ok(lk2); lk2.release();
});

test('metrics: parseListen defaults to loopback; /health and /metrics answer; other paths 404, writes 405', async () => {
  assert.deepEqual(parseListen(':9464'), { host: '127.0.0.1', port: 9464 });
  assert.deepEqual(parseListen('9464'), { host: '127.0.0.1', port: 9464 });
  assert.deepEqual(parseListen('0.0.0.0:80'), { host: '0.0.0.0', port: 80 });
  assert.throws(() => parseListen('abc'), /--metrics/);
  assert.throws(() => parseListen(':99999'), /range/);
  const m = createMetrics();
  m.boardRun('greenhouse', 'ok'); m.boardRun('greenhouse', 'HTTP_5XX'); m.boardRun('greenhouse', 'ok');
  m.setCycle({ id: 'c1', status: 'running', total: 3, done: 2, failed: 1, failedBoards: ['B2'] });
  const srv = await serveMetrics(m, { host: '127.0.0.1', port: 0 });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    let res = await fetch(`${base}/health`);
    const h = await res.json();
    assert.equal(res.status, 200); assert.equal(h.schema, 'health/v1'); assert.equal(h.status, 'degraded'); assert.deepEqual(h.cycle.failedBoards, ['B2']);
    res = await fetch(`${base}/metrics`);
    const txt = await res.text();
    assert.match(res.headers.get('content-type'), /text\/plain/);
    assert.match(txt, /jobcrawl_board_runs_total\{source="greenhouse",cls="ok"\} 2/);
    assert.match(txt, /jobcrawl_board_runs_total\{source="greenhouse",cls="HTTP_5XX"\} 1/);
    assert.match(txt, /# TYPE jobcrawl_postings_open gauge/);
    assert.match(txt, /jobcrawl_cycle_boards\{state="failed"\} 1/);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/metrics`, { method: 'POST' })).status, 405);
    m.set('stopping', true);
    assert.equal((await fetch(`${base}/health`)).status, 503);
  } finally { await srv.close(); }
});

test('cli: run --help and no arguments send no network and write nothing; missing flags exit 2 and name the flag', async () => {
  const cwd = tmp('jcx-cwd-');
  for (const a of [['run', '--help'], [], ['--help']]) {
    const r = spawnSync(process.execPath, [...nodeArgs, ...a], { encoding: 'utf8', cwd, input: '' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /run \[--profile/);
  }
  assert.deepEqual((await import('node:fs')).readdirSync(cwd), []);
  let r = spawnSync(process.execPath, [...nodeArgs, 'run', '--json'], { encoding: 'utf8', input: '', env: { ...ENV, JOBCRAWL_PROFILE: '', JOBCRAWL_DATA: '' } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /--profile/);
  r = spawnSync(process.execPath, [...nodeArgs, 'run', '--profile', 'x', '--json'], { encoding: 'utf8', input: '', env: { ...ENV, JOBCRAWL_DATA: '' } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /--data/);
  r = spawnSync(process.execPath, [...nodeArgs, 'run', '--profile', 'x', '--data', join(cwd, 'd'), '--log-format', 'xml', '--json'], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 2);
});

test('cli: a closed stdin never blocks or prompts (stdin ignored, no TTY)', () => {
  const f = fixture(2);
  const r = spawnSync(process.execPath, [...nodeArgs, 'run', '--profile', f.prof, '--data', f.data, '--routing', f.routing, '--replay', f.rec, '--json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).done, 2);
});

test('cli: run from a recording writes JSON-lines logs, honours JOBCRAWL_* env, a second call is a resumed/new cycle, exit 1 on a missing board', () => {
  const f = fixture(2, { extraBoards: 1 });
  const logFile = join(f.base, 'logs', 'run.jsonl');
  let r = cliRun(f, ['--log-file', logFile, '--json']);
  assert.equal(r.status, 1, r.stderr);                                  // the third board is not in the recording
  const o = JSON.parse(r.stdout);
  assert.equal(o.code, 1); assert.deepEqual(o.failed_boards, ['B3']);
  const ev = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ev.map((e) => e.event).filter((e) => ['start', 'cycle-start', 'cycle-end', 'exit'].includes(e)), ['start', 'cycle-start', 'cycle-end', 'exit']);
  assert.equal(ev.filter((e) => e.event === 'board').length, 3);
  assert.equal(r.stderr.trim(), '', 'with a log file nothing goes to stderr');
  // stdout stays machine-only with --json; default log goes to stderr as JSON when not a TTY
  r = cliRun(f, ['--every-min', '0', '--json', '--board', 'B1'], { JOBCRAWL_LOG_FORMAT: 'json' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.trim().split('\n').every((l) => JSON.parse(l).event));
  // env fallbacks
  r = spawnSync(process.execPath, [...nodeArgs, 'run', '--routing', f.routing, '--replay', f.rec, '--board', 'B2', '--json'], { encoding: 'utf8', input: '',
    env: { ...ENV, JOBCRAWL_PROFILE: f.prof, JOBCRAWL_DATA: f.data } });
  assert.equal(r.status, 0, r.stderr);
});

/** Spawns the CLI with stderr captured; waitFor(regex, ms) fails with the captured stderr on a deadline; stop() signals and waits (hard deadline). */
function spawnCli(args, { net = false } = {}) {
  const child = spawn(process.execPath, net ? ['--no-warnings', CLI, ...args] : [...nodeArgs, ...args], { stdio: ['ignore', 'ignore', 'pipe'], env: ENV });
  let err = '', code = null;
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((ok) => child.on('exit', (c) => { code = c; ok(c); }));
  const waitFor = async (re, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const m = re.exec(err);
      if (m) return m;
      if (code !== null) assert.fail(`child exited ${code} before ${re}; stderr:\n${err}`);
      if (Date.now() > end) assert.fail(`no ${re} within ${ms} ms; stderr:\n${err}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const stop = async (sig = 'SIGTERM', ms = 10000) => {
    child.kill(sig);
    const c = await Promise.race([exited, new Promise((ok) => setTimeout(() => ok('TIMEOUT'), ms).unref())]);
    if (c === 'TIMEOUT') { child.kill('SIGKILL'); assert.fail(`no exit within ${ms} ms of ${sig}; stderr:\n${err}`); }
    return c;
  };
  return { child, waitFor, stop, err: () => err };
}

test('cli: --metrics binds loopback and serves while the run is open (daemon, stopped by a signal)', { skip: process.platform === 'win32' && 'POSIX signals' }, async () => {
  const f = fixture(1);
  const p = spawnCli(['run', '--profile', f.prof, '--data', f.data, '--routing', f.routing, '--replay', f.rec, '--daemon', '--interval-min', '60', '--metrics', '127.0.0.1:0', '--log-format', 'json'], { net: true });   // the loopback listener needs the real dns.lookup the no-network preload stubs
  try {
    const port = Number((await p.waitFor(/"metrics-listening".*?"port":(\d+)/))[1]);
    await p.waitFor(/"daemon-cycle"/);
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(h.schema, 'health/v1');
    assert.equal(await p.stop('SIGTERM', 5000), 143, p.err());   // prompt exit from the 60-minute sleep
  } finally { if (p.child.exitCode === null) p.child.kill('SIGKILL'); }
});

test('cli: SIGTERM mid-run exits 143 with the state consistent, and a restart resumes', { skip: process.platform === 'win32' && 'POSIX signals' }, async () => {
  const f = fixture(6);
  const p = spawnCli(['run', '--profile', f.prof, '--data', f.data, '--routing', f.routing, '--replay', f.rec, '--replay-delay-ms', '300', '--log-format', 'json']);
  try {
    await p.waitFor(/"event":"board"[\s\S]*"event":"board"/);
    assert.equal(await p.stop('SIGTERM', 10000), 143, p.err());
  } finally { if (p.child.exitCode === null) p.child.kill('SIGKILL'); }
  const st = readRunState(f.data);
  assert.equal(st.status, 'interrupted');
  const done = Object.keys(st.done).length;
  assert.ok(done >= 2 && done < 6, `done ${done}`);
  const r = cliRun(f, ['--json']);
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.equal(o.resumed, true); assert.equal(o.done, 6);
});

test('examples/systemd: unit and timer exist with the hardening and signal settings the docs promise', () => {
  const dir = join(ROOT, 'examples', 'systemd');
  const unit = readFileSync(join(dir, 'jobcrawl.service'), 'utf8');
  for (const k of ['ExecStart=', 'KillSignal=SIGTERM', 'TimeoutStopSec=', 'MemoryMax=', 'Restart=on-failure', 'SuccessExitStatus=143']) assert.ok(unit.includes(k), `service has ${k}`);
  const oneshot = readFileSync(join(dir, 'jobcrawl-due.service'), 'utf8');
  for (const k of ['Type=oneshot', '--max-minutes', 'SuccessExitStatus=']) assert.ok(oneshot.includes(k), `oneshot has ${k}`);
  const timer = readFileSync(join(dir, 'jobcrawl-due.timer'), 'utf8');
  for (const k of ['OnCalendar=', 'Persistent=true', 'Unit=jobcrawl-due.service']) assert.ok(timer.includes(k), `timer has ${k}`);
});
