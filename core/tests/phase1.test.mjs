// Phase 1 (a)-(e): shadow hook in the legacy crawl, recording replay + parity, baseline import, conditional cache, benchmark analysis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { runShadow, armed } from '../route/shadow-hook.mjs';
import { importBaseline } from '../route/baseline.mjs';
import { applyRun, LEGACY_RULES } from '../delta/board-delta.mjs';
import { boardKey, openBoard, readEvents } from '../state/board-store.mjs';
import { makeConditionalFetch, hostMatcher } from '../fetch/conditional.mjs';
import { analyse, toMarkdown } from '../../bench/analyse.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = (p) => mkdtempSync(join(tmpdir(), `jcx-p1-${p}-`));
const job = (n) => ({ url: `https://jobs.example.com/p/${n}`, title: `Engineer ${n}`, location: 'Munich' });
const routingFile = (dir, obj) => { const f = join(dir, 'routing.json'); writeFileSync(f, JSON.stringify({ schema: 'routing/v1', ...obj })); return f; };

// ---- (a) shadow hook ----
test('shadow hook: off unless armed; routed boards get state + deltas in their own folder; kill switch wins; failures never count misses', async () => {
  const data = tmp('shadow');
  const companies = [{ name: 'A', provider: 'greenhouse' }, { name: 'B', provider: 'lever' }, { name: 'C', provider: 'greenhouse' }];
  const jobs = [job(1), job(2)];
  const results = [{ r: { provider: 'greenhouse' }, jobs }, { r: { provider: 'lever' }, jobs: [job(3)] }, { error: 'HTTP 500', triage: { cls: 'HTTP_5XX' } }];
  const quiet = () => {};
  let s = await runShadow({ dataDir: data, companies, results, env: {}, log: quiet });
  assert.equal(s.armed, false);
  assert.equal(existsSync(join(data, 'jcx-shadow')), false, 'nothing written when not armed');
  const rf = routingFile(data, { providers: { greenhouse: 'shadow' } });
  const root = tmp('shadow-store');
  const env = { JOBCRAWL_SHADOW: '1', JOBCRAWL_ROUTING: rf, JOBCRAWL_SHADOW_DATA: root };
  assert.equal(armed(env), true);
  s = await runShadow({ dataDir: data, companies, results, env, log: quiet });
  assert.equal(s.shadowed, 2); assert.equal(s.legacy, 1);
  assert.deepEqual([...readEvents(root)].filter((e) => e.board === 'A').map((e) => e.op), ['added', 'added', 'board-ok']);
  assert.deepEqual([...readEvents(root)].filter((e) => e.board === 'C').map((e) => e.op), ['board-failed']);
  assert.equal(existsSync(join(root, 'boards', boardKey('B'))), false, 'legacy-routed board untouched');
  // second cycle: A's answer fails -> no departure; then a complete answer without job 2 -> departed (today's first-miss rule)
  s = await runShadow({ dataDir: data, companies, results: [{ error: 'timeout', triage: { cls: 'TIMEOUT_TLS' } }, results[1], results[2]], env, log: quiet });
  assert.ok(![...readEvents(root)].some((e) => e.op === 'departed'));
  s = await runShadow({ dataDir: data, companies, results: [{ r: { provider: 'greenhouse' }, jobs: [job(1)] }, results[1], results[2]], env, log: quiet });
  assert.equal([...readEvents(root)].filter((e) => e.op === 'departed').length, 1);
  const before = [...readEvents(root)].length;
  s = await runShadow({ dataDir: data, companies, results, env: { ...env, JOBCRAWL_ROUTE_KILL: 'yes' }, log: quiet });
  assert.equal(s.shadowed, 0); assert.equal(s.killed, true);
  assert.equal([...readEvents(root)].length, before, 'kill switch: nothing written');
});

function serve() {
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/b/sitemap.xml') { res.setHeader('content-type', 'application/xml'); return res.end(`<?xml version="1.0"?><urlset>${[1, 2].map((i) => `<url><loc>${base}/b/job/${i}</loc><lastmod>2026-11-20</lastmod></url>`).join('')}</urlset>`); }
    const m = req.url.match(/^\/b\/job\/(\d)$/);
    if (!m) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', 'text/html');
    res.end(`<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: `Systems Engineer ${m[1]}`, datePosted: '2026-11-20', description: '<p>Build systems.</p>', jobLocation: { '@type': 'Place', address: { addressLocality: 'Berlin', addressCountry: 'DE' } } })}</script></head><body></body></html>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}
const crawl = (prof, data, env = {}) => new Promise((done) => {
  const p = spawn(process.execPath, [resolve(ROOT, 'crawler/crawl.mjs'), '--profile', prof, '--data', data], { cwd: ROOT, env: { ...process.env, JOBCRAWL_PROFILE: '', JOBCRAWL_RAW_DIR: '', JOBCRAWL_SHADOW: '', JOBCRAWL_ROUTING: '', ...env } });
  let out = '', err = '';
  p.stdout.on('data', (c) => (out += c)); p.stderr.on('data', (c) => (err += c));
  p.on('close', (status) => done({ status, out, err }));
});

// Every file of a data folder (recursive), path -> content, with the run-specific parts normalised: the folder's own path, timestamps,
// epoch milliseconds and timing fields. The normaliser is checked first on two plain runs (it must make them equal).
function folderDump(dir) {
  const out = {};
  const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else out[p.slice(dir.length + 1).split('\\').join('/')] = readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
}
const norm = (text, dir) => text.split(dir).join('<DATA>').split(JSON.stringify(dir).slice(1, -1)).join('<DATA>').split(dir.split('\\').join('/')).join('<DATA>')
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<T>').replace(/\b1\d{12}\b/g, '<EPOCH>')
  .replace(/"(ms|budget_ms|fetch_ms|took_ms|elapsed_ms|duration_ms)":\s*\d+/g, '"$1":<MS>');

test('crawl.mjs: with the shadow armed every legacy output file is identical, and the routed board gets its shadow state outside the data folder', async () => {
  const server = await serve();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const dir = tmp('crawl');
    const prof = join(dir, 'p'); mkdirSync(prof);
    writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 'fixture', crawl: { companies_file: 'companies.json' } }));
    writeFileSync(join(prof, 'companies.json'), JSON.stringify({ title_filter: { positive: ['Engineer'], negative: [] }, location_filter: { allow: ['Berlin'], block_hard: [], allow_unknown: true },
      tracked_companies: [{ name: 'Board B', provider: 'sitemap', slug: `${base}/b/sitemap.xml`, url_pattern: '/job/' }] }));
    const runs = {};
    for (const name of ['plain1', 'plain2', 'shadowed']) {
      const d = join(dir, name, 'data'); mkdirSync(d, { recursive: true });
      const env = name === 'shadowed' ? { JOBCRAWL_SHADOW: '1', JOBCRAWL_ROUTING: routingFile(dir, { boards: { 'Board B': 'shadow' } }), JOBCRAWL_SHADOW_DATA: join(dir, 'shadow-store') } : {};
      const r = await crawl(prof, d, env);
      assert.equal(r.status, 0, r.err);
      runs[name] = { dir: d, out: r.out, files: folderDump(d) };
    }
    assert.match(runs.shadowed.out, /\[shadow\] boards shadowed 1, .* in \d+ ms ->/);
    const n = (run) => Object.fromEntries(Object.entries(run.files).map(([k, v]) => [k, norm(v, run.dir)]));
    assert.deepEqual(n(runs.plain2), n(runs.plain1), 'the normaliser makes two plain runs equal');
    assert.deepEqual(Object.keys(runs.shadowed.files).sort(), Object.keys(runs.plain1.files).sort(), 'same files: nothing added to the data folder');
    assert.deepEqual(n(runs.shadowed), n(runs.plain1), 'every legacy output identical (history with dates, crawl-state, source-health, last-new, ...)');
    const st = openBoard(join(dir, 'shadow-store'), 'Board B');
    assert.equal(Object.keys(st.postings).length, 2);
  } finally { server.close(); }
});

// ---- (c) baseline import ----
test('baseline import: legacy rows become an epoch without events; the next identical read emits only board-ok', async () => {
  const dir = tmp('base');
  const hist = join(dir, 'scan-history.tsv');
  writeFileSync(hist, 'url\tcompany\ttitle\tlocation\tfirst_seen\tlast_seen\tstatus\tposted\n'
    + `${job(1).url}\tAcme\tEngineer 1\tMunich\t2026-11-01\t2026-11-27\topen\t\n`
    + `${job(2).url}\tAcme\tEngineer 2\tMunich\t2026-11-02\t2026-11-27\textra\t\n`
    + `${job(9).url}\tAcme\tOld\tMunich\t2026-10-01\t2026-10-05\tgone\t\n`
    + `https://agg.example/x\tOther (via Acme)\tEngineer 3\tMunich\t2026-11-03\t2026-11-27\tdup\t\n`);
  const root = join(dir, 'store');
  const sum = await importBaseline({ historyFile: hist, root, boards: ['Acme', 'Nobody'] });
  assert.deepEqual(sum, { imported: 2, replaced: 0, kept: 0, busy: 0, empty: 1, rows: 3 });
  assert.equal([...readEvents(root)].length, 0, 'no events');
  const s = openBoard(root, 'Acme');
  assert.equal(s.seq, 0); assert.equal(Object.keys(s.postings).length, 3); assert.equal(s.baseline.rows, 3);
  const again = await importBaseline({ historyFile: hist, root, boards: ['Acme'] });
  assert.equal(again.kept, 1, 'an existing state is kept');
  const r = applyRun(s, { ok: true, items: [job(1), job(2), { url: 'https://agg.example/x', title: 'Engineer 3', location: 'Munich' }] }, { board: 'Acme', rules: LEGACY_RULES, now: new Date('2026-11-28T03:00:00Z') });
  assert.deepEqual(r.events.map((e) => e.op), ['board-ok'], 'no added burst');
});

// ---- (d) conditional cache ----
test('conditional cache: stores a 200 with validators, revalidates with If-None-Match, returns the cached body on 304; other hosts bypass', async () => {
  let seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers['if-none-match'] ?? null);
    if (req.headers['if-none-match'] === '"v1"') { res.statusCode = 304; return res.end(); }
    res.setHeader('etag', '"v1"'); res.setHeader('content-type', 'application/json'); res.end('{"jobs":[1,2]}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/jobs`;
    const f = makeConditionalFetch(globalThis.fetch, { dir: tmp('cond'), hosts: ['127.0.0.1'] });
    const a = await f(url); assert.equal(await a.text(), '{"jobs":[1,2]}');
    const b = await f(url);
    assert.equal(b.status, 200); assert.equal(b.headers.get('x-jobcrawl-cache'), 'revalidated'); assert.equal(await b.text(), '{"jobs":[1,2]}');
    assert.deepEqual(seen, [null, '"v1"']);
    seen = [];
    const off = makeConditionalFetch(globalThis.fetch, { dir: tmp('cond2'), hosts: ['example.org'] });
    await (await off(url)).text(); await (await off(url)).text();
    assert.deepEqual(seen, [null, null], 'not switched on: no conditional header');
    assert.equal(hostMatcher(['*.teamtailor.com'])('acme.teamtailor.com'), true);
    assert.equal(hostMatcher(['*.teamtailor.com'])('teamtailor.com.evil.org'), false);
  } finally { server.close(); }
});

// ---- (b) recording -> dual-run parity, (e) analysis ----
function fakeRecording(dir) {
  mkdirSync(join(dir, 'lists'), { recursive: true }); mkdirSync(join(dir, 'index'), { recursive: true });
  writeFileSync(join(dir, 'lists', `${boardKey('Acme')}.json.gz`), gzipSync(JSON.stringify({ board: 'Acme', provider: 'teamtailor', complete: true, items: [job(1), job(2)] })));
  writeFileSync(join(dir, 'boards.jsonl'), [
    { board: 'Acme', provider: 'teamtailor', ok: true, jobs: 2, req: 2, wire: 30000, validators: { etag: true } },
    { board: 'Slow', provider: 'greenhouse', ok: false, cls: 'TIMEOUT_TLS', jobs: 0 },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  const L = 'https://acme.teamtailor.com/jobs.json';
  writeFileSync(join(dir, 'index', '2026-11-28.jsonl'), [
    { board: 'Acme', provider: 'teamtailor', url: L, method: 'GET', status: 200, wire: 30000, bytes: 300000, etag: 'W/"1"', sha256: 'aa' },
    { board: 'Acme', provider: 'teamtailor', url: L, method: 'GET', status: 304, wire: 0, probe: true },
    { board: 'Slow', provider: 'greenhouse', url: 'https://boards-api.greenhouse.io/v1/boards/slow/jobs', method: 'GET', status: 0, err: 'TIMEOUT_TLS' },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  return L;
}

test('analyse: true 304 rate, change rate from the live index, projected saving, hosts to switch on', async () => {
  const dir = tmp('an'), rec = join(dir, 'rec'), live = join(dir, 'live');
  const L = fakeRecording(rec);
  mkdirSync(live);
  const day = new Date().toISOString().slice(0, 10);
  // read 10 times a day, changed once: change rate 1/9
  writeFileSync(join(live, `${day}.jsonl`), Array.from({ length: 10 }, (_, i) => JSON.stringify({ url: L, sha256: i < 5 ? 'aa' : 'bb' })).join('\n') + '\n');
  const r = await analyse({ rec, live, days: 2, minProbes: 1 });
  assert.equal(r.providers.teamtailor.p304, 1);
  assert.equal(r.providers.greenhouse.fail_cls.TIMEOUT_TLS, 1);
  assert.deepEqual(r.projection.hosts_to_switch_on, ['acme.teamtailor.com']);
  assert.equal(r.projection.now_bytes_day, 300000);
  assert.ok(r.projection.saving > 0.8, `saving ${r.projection.saving}`);
  assert.match(toMarkdown(r), /acme\.teamtailor\.com/);
});

const NO_NET = join(tmp('nonet'), 'nonet.mjs');
writeFileSync(NO_NET, "globalThis.fetch = () => { console.error('NETWORK USED'); process.exit(99); };\nimport dns from 'node:dns'; dns.lookup = () => { console.error('NETWORK USED'); process.exit(99); };\n");
const cli = (args) => spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(NO_NET).href, join(ROOT, 'cli', 'jobcrawl.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, JOBCRAWL_ROUTING: '' }, input: '' });

test('cli: import + dual-run over a recording with a companies override; recorded failures named; parity passes against the baseline', async () => {
  const dir = tmp('dual'), rec = join(dir, 'rec'), legacy = join(dir, 'legacy'), prof = join(dir, 'p');
  fakeRecording(rec);
  mkdirSync(legacy); mkdirSync(prof);
  writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 't', crawl: { companies_file: 'nonexistent.json' } }));
  const companies = join(dir, 'companies.json');
  writeFileSync(companies, JSON.stringify({ tracked_companies: [{ name: 'Acme', provider: 'teamtailor', slug: 'acme' }, { name: 'Slow', provider: 'greenhouse', slug: 'slow' }] }));
  writeFileSync(join(legacy, 'scan-history.tsv'), 'url\tcompany\ttitle\tlocation\tfirst_seen\tlast_seen\tstatus\tposted\n'
    + [job(1), job(2)].map((j) => `${j.url}\tAcme\t${j.title}\tMunich\t2026-11-01\t2026-11-27\topen\t`).join('\n') + '\n');
  let r = cli(['import', '--profile', prof, '--companies', companies, '--data', join(dir, 'store'), '--legacy-data', legacy, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).imported, 2);
  r = cli(['dual-run', '--profile', prof, '--companies', companies, '--data', join(dir, 'store'), '--legacy-data', legacy, '--replay', rec, '--boards', 'all', '--report', join(dir, 'parity.json'), '--json']);
  assert.equal(r.status, 1, 'Slow failed in the recording');
  const rep = JSON.parse(readFileSync(join(dir, 'parity.json'), 'utf8'));
  assert.equal(rep.boards.find((b) => b.board === 'Acme').verdict, 'pass');
  assert.equal(rep.boards.find((b) => b.board === 'Slow').error, 'recorded failure TIMEOUT_TLS');
  assert.deepEqual([...readEvents(join(dir, 'store'))].filter((e) => e.board === 'Acme').map((e) => e.op), ['board-ok'], 'replay on the baseline: no added burst');
});
