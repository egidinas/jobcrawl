// Strangler-fig authority swap: a board routed `new` (allow_new: true) gets its close decisions from the new per-board path. The public
// outputs (every file of the data folder: history with dates, crawl state, health, last-new ...) must be identical to a plain legacy
// crawl over the same sequence of board answers, including an empty answer, a reappearing role and a switch back to legacy (rollback).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importBaseline } from '../route/baseline.mjs';
import { openBoard } from '../state/board-store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = (p) => mkdtempSync(join(tmpdir(), `jcx-auth-${p}-`));
let JOBS = [];
function serve() {
  const s = createServer((req, res) => {
    const base = `http://127.0.0.1:${s.address().port}`;
    if (req.url === '/b/sitemap.xml') { res.setHeader('content-type', 'application/xml'); return res.end(`<?xml version="1.0"?><urlset>${JOBS.map((i) => `<url><loc>${base}/b/job/${i}</loc><lastmod>2026-11-20</lastmod></url>`).join('')}</urlset>`); }
    const m = req.url.match(/^\/b\/job\/(\d+)(\?.*)?$/);
    if (!m) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', 'text/html');
    res.end(`<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: `Systems Engineer ${m[1]}`, datePosted: '2026-11-20', description: '<p>Build systems.</p>', jobLocation: { '@type': 'Place', address: { addressLocality: 'Berlin', addressCountry: 'DE' } } })}</script></head></html>`);
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}
const crawl = (prof, data, env = {}) => new Promise((done) => {
  const p = spawn(process.execPath, [resolve(ROOT, 'crawler/crawl.mjs'), '--profile', prof, '--data', data],
    { cwd: ROOT, env: { ...process.env, JOBCRAWL_PROFILE: '', JOBCRAWL_RAW_DIR: '', JOBCRAWL_SHADOW: '', JOBCRAWL_ROUTING: '', JOBCRAWL_SHADOW_DATA: '', JOBCRAWL_ROUTE_KILL: '', JOBCRAWL_CONDITIONAL_CACHE: '', ...env } });
  let out = '', err = '';
  p.stdout.on('data', (c) => (out += c)); p.stderr.on('data', (c) => (err += c));
  p.on('close', (status) => done({ status, out, err }));
});
function folderDump(dir) {
  const out = {};
  const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else out[p.slice(dir.length + 1).split('\\').join('/')] = readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
}
const norm = (text, dir) => text.split(dir).join('<DATA>').split(JSON.stringify(dir).slice(1, -1)).join('<DATA>').split(dir.split('\\').join('/')).join('<DATA>')
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<T>').replace(/\b1\d{12}\b/g, '<EPOCH>')
  .replace(/"(ms|budget_ms|fetch_ms|took_ms|elapsed_ms|duration_ms)":\s*\d+/g, '"$1":<MS>').replace(/\d+(\.\d+)? (board-)?min(utes)?/g, '<MIN>').replace(/\b\d+ s\b/g, '<S>');
const dump = (d) => Object.fromEntries(Object.entries(folderDump(d)).map(([k, v]) => [k, norm(v, d)]));

async function scenario({ rollbackAt = null, extraEnv = {} } = {}) {
  const server = await serve();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const dir = tmp('scn');
    const prof = join(dir, 'p'); mkdirSync(prof);
    writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 'fx', crawl: { companies_file: 'companies.json' } }));
    writeFileSync(join(prof, 'companies.json'), JSON.stringify({ title_filter: { positive: ['Engineer'], negative: [] }, location_filter: { allow: ['Berlin'], block_hard: [], allow_unknown: true },
      tracked_companies: [{ name: 'Board B', provider: 'sitemap', slug: `${base}/b/sitemap.xml`, url_pattern: '/job/', interval_hours: 0 }] }));
    const plain = join(dir, 'plain', 'data'), auth = join(dir, 'auth', 'data'), store = join(dir, 'store');
    mkdirSync(plain, { recursive: true }); mkdirSync(auth, { recursive: true });
    const routing = join(dir, 'routing.json');
    const route = (on) => writeFileSync(routing, JSON.stringify({ schema: 'routing/v1', allow_new: on, boards: { 'Board B': on ? 'new' : 'legacy' } }));
    const env = { JOBCRAWL_SHADOW: '1', JOBCRAWL_ROUTING: routing, JOBCRAWL_SHADOW_DATA: store, ...extraEnv };
    // cycle 6 lists role 6 with a tracking parameter, cycle 7 without it: the same posting id, another url (legacy closes the old row)
    const cycles = [[1, 2, 3], [1, 2], [1, 2, 4], [], [1, 5], [5, '6?utm_source=feed'], [5, 6, 7], [5, 7]];
    const logs = [];
    for (const [k, jobs] of cycles.entries()) {
      JOBS = jobs;
      route(rollbackAt === null || k < rollbackAt);
      const a = await crawl(prof, plain);
      assert.equal(a.status, 0, a.err);
      const b = await crawl(prof, auth, env);
      assert.equal(b.status, 0, b.err);
      logs.push(b.out);
      if (k === 0) await importBaseline({ historyFile: join(auth, 'scan-history.tsv'), root: store, boards: ['Board B'] });   // the baseline epoch
      assert.deepEqual(dump(auth), dump(plain), `cycle ${k + 1} (${JSON.stringify(jobs)}): every legacy output identical`);
    }
    return { logs, store };
  } finally { server.close(); }
}

test('authority swap: identical public outputs over 7 cycles (closes, an empty answer, a reappearing role, new roles)', async () => {
  const { logs, store } = await scenario();
  const closed = logs.map((l) => Number((l.match(/closed by the new path (\d+)/) ?? [])[1] ?? 0));
  assert.ok(closed.reduce((a, b) => a + b, 0) >= 2, `the new path decided closes: ${JSON.stringify(closed)}`);
  assert.match(logs[3], /legacy fallback rows [1-9]/, 'the empty answer (no empty-OK signal) is decided by the legacy rule');
  assert.match(logs[6], /url variant/, 'the role listed under another url variant is decided by the legacy rule');
  const st = openBoard(store, 'Board B');
  assert.ok(st.seq > 0, 'the new state was committed');
});

test('kill switch: boards routed new, JOBCRAWL_ROUTE_KILL=1: no authority, identical outputs', async () => {
  const { logs } = await scenario({ extraEnv: { JOBCRAWL_ROUTE_KILL: '1' } });
  for (const l of logs) assert.doesNotMatch(l, /\[authority\]/);
});

test('rollback drill: routed new for 3 cycles, then back to legacy: outputs stay identical, no false departures', async () => {
  const { logs } = await scenario({ rollbackAt: 3 });
  assert.match(logs[1], /\[authority\] boards routed new 1/);
  for (const l of logs.slice(3)) assert.doesNotMatch(l, /\[authority\]/, 'no authority after the switch back');
});
