// Reproductions of the phase-1 façade review findings (review_phase1.md, 2026-11-27), each fixed on this branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importBaseline } from '../route/baseline.mjs';
import { runShadow, shadowRoot } from '../route/shadow-hook.mjs';
import { applyRun, LEGACY_RULES } from '../delta/board-delta.mjs';
import { commitRun, lease, openBoard, readEvents, boardKey } from '../state/board-store.mjs';
import { makeConditionalFetch } from '../fetch/conditional.mjs';
import { checkPlacement, defaultDir, PlacementError } from '../paths.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), `jcx-r1-${p}-`));
const job = (n) => ({ url: `https://jobs.example.com/p/${n}`, title: `Engineer ${n}`, location: 'Munich' });
const HEAD = 'url\tcompany\ttitle\tlocation\tfirst_seen\tlast_seen\tstatus\tposted\n';
const row = (j, status = 'open', company = 'Acme') => `${j.url}\t${company}\t${j.title}\tMunich\t2026-11-01\t2026-11-27\t${status}\t\n`;

// ---- (1) import ----
test('import --replace carries the sequence forward: the event log is never cut, the next event continues it', async () => {
  const dir = tmp('replace'), root = join(dir, 'store'), hist = join(dir, 'h.tsv');
  writeFileSync(hist, HEAD + row(job(1)));
  let r = applyRun(openBoard(root, 'Acme'), { ok: true, items: [job(1), job(2)] }, { board: 'Acme', now: new Date('2026-11-27T00:00:00Z') });
  commitRun(root, 'Acme', r.state, r.events);
  assert.equal([...readEvents(root)].length, 3);
  const sum = await importBaseline({ historyFile: hist, root, boards: ['Acme'], replace: true });
  assert.equal(sum.replaced, 1);
  const s = openBoard(root, 'Acme');
  assert.equal(s.seq, 3, 'seq kept'); assert.equal(s.baseline.replaced_seq, 3); assert.equal(s.baseline.epoch, 1);
  assert.equal([...readEvents(root)].length, 3, 'no event cut');
  r = applyRun(s, { ok: true, items: [job(1), job(3)] }, { board: 'Acme', now: new Date('2026-11-28T00:00:00Z') });
  assert.equal(r.events[0].seq, 4);
});

test('import: a missing history file fails instead of importing empty boards', async () => {
  await assert.rejects(importBaseline({ historyFile: join(tmp('miss'), 'nope.tsv'), root: tmp('miss-store'), boards: ['Acme'] }), /not found/);
});

test('import takes the board lease: a board held by a shadow run is reported busy, not written', async () => {
  const dir = tmp('lease'), root = join(dir, 'store'), hist = join(dir, 'h.tsv');
  writeFileSync(hist, HEAD + row(job(1)));
  const held = await lease(root, 'Acme', 60e3);
  const sum = await importBaseline({ historyFile: hist, root, boards: ['Acme'] });
  assert.equal(sum.busy, 1); assert.equal(sum.imported, 0);
  held();
  assert.equal((await importBaseline({ historyFile: hist, root, boards: ['Acme'] })).imported, 1);
});

test('import: lifecycle unknown rows stay unknown (never open, never a miss), and become open when listed again', async () => {
  const dir = tmp('unknown'), root = join(dir, 'store'), hist = join(dir, 'h.tsv');
  writeFileSync(hist, HEAD + row(job(1)) + row(job(2), 'unknown'));
  await importBaseline({ historyFile: hist, root, boards: ['Acme'] });
  const s = openBoard(root, 'Acme');
  assert.deepEqual(Object.values(s.postings).map((p) => p.status).sort(), ['open', 'unknown']);
  let r = applyRun(s, { ok: true, items: [job(1)] }, { board: 'Acme', rules: LEGACY_RULES, now: new Date('2026-11-28T00:00:00Z') });
  assert.deepEqual(r.events.map((e) => e.op), ['board-ok'], 'an unknown row is not departed by a miss');
  r = applyRun(r.state, { ok: true, items: [job(1), job(2)] }, { board: 'Acme', rules: LEGACY_RULES, now: new Date('2026-11-29T00:00:00Z') });
  assert.equal(r.events[0].op, 'reappeared');
});

// ---- (2) conditional cache ----
function server(handler) {
  const s = createServer(handler);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

test('conditional cache: Vary headers are part of the key (no de body for an fr request)', async () => {
  const s = await server((req, res) => {
    const lang = req.headers['accept-language'] ?? 'en';
    if (req.headers['if-modified-since'] === 'Wed, 01 Jan 2025 00:00:00 GMT') { res.statusCode = 304; return res.end(); }
    res.setHeader('last-modified', 'Wed, 01 Jan 2025 00:00:00 GMT'); res.setHeader('vary', 'Accept-Language'); res.end(`body-${lang}`);
  });
  try {
    const url = `http://127.0.0.1:${s.address().port}/jobs`;
    const f = makeConditionalFetch(globalThis.fetch, { dir: tmp('vary'), hosts: ['127.0.0.1'] });
    assert.equal(await (await f(url, { headers: { 'accept-language': 'de' } })).text(), 'body-de');
    assert.equal(await (await f(url, { headers: { 'accept-language': 'fr' } })).text(), 'body-fr', 'fr is not served the de body');
    const hit = await f(url, { headers: { 'accept-language': 'de' } });
    assert.equal(hit.headers.get('x-jobcrawl-cache'), 'revalidated'); assert.equal(await hit.text(), 'body-de');
  } finally { s.close(); }
});

test('conditional cache: Set-Cookie answers are not cached; a hit keeps url, link and other headers', async () => {
  let n = 0;
  const s = await server((req, res) => {
    n++;
    if (req.url === '/cookie') { res.setHeader('etag', '"c"'); res.setHeader('set-cookie', 'sid=1'); return res.end('c'); }
    if (req.url === '/start') { res.statusCode = 302; res.setHeader('location', '/final'); return res.end(); }
    if (req.headers['if-none-match'] === '"f"') { res.statusCode = 304; return res.end(); }
    res.setHeader('etag', '"f"'); res.setHeader('link', '</page2>; rel="next"'); res.setHeader('content-type', 'application/json'); res.end('{"a":1}');
  });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const f = makeConditionalFetch(globalThis.fetch, { dir: tmp('hdr'), hosts: ['127.0.0.1'] });
    await (await f(`${base}/cookie`)).text();
    const again = await f(`${base}/cookie`);
    assert.equal(again.headers.get('x-jobcrawl-cache'), null, 'a cookie-setting answer is never served from cache');
    const first = await f(`${base}/start`);
    assert.equal(first.url, `${base}/final`); await first.text();
    const hit = await f(`${base}/start`);
    assert.equal(hit.headers.get('x-jobcrawl-cache'), 'revalidated');
    assert.equal(hit.url, `${base}/final`, 'the final URL after redirects is kept');
    assert.equal(hit.headers.get('link'), '</page2>; rel="next"');
    assert.equal(hit.headers.get('content-type'), 'application/json');
    assert.ok(new URL(hit.url));
  } finally { s.close(); }
});

test('conditional cache: a corrupt cached body is dropped and the request goes out again without validators', async () => {
  const seen = [];
  const s = await server((req, res) => {
    seen.push(req.headers['if-none-match'] ?? null);
    if (req.headers['if-none-match'] === '"v"') { res.statusCode = 304; return res.end(); }
    res.setHeader('etag', '"v"'); res.end('fresh');
  });
  try {
    const url = `http://127.0.0.1:${s.address().port}/x`;
    const dir = tmp('corrupt');
    const f = makeConditionalFetch(globalThis.fetch, { dir, hosts: ['127.0.0.1'] });
    await (await f(url)).text();
    for (const g of readdirSync(dir).filter((x) => x.endsWith('.gz'))) writeFileSync(join(dir, g), 'not gzip');
    const r = await f(url);
    assert.equal(r.status, 200); assert.equal(await r.text(), 'fresh');
    assert.deepEqual(seen, [null, '"v"', null], 'the 304 was not passed on; re-asked unconditionally');
  } finally { s.close(); }
});

test('conditional cache: total size cap evicts the least recently used entries', async () => {
  const s = await server((req, res) => { res.setHeader('etag', `"${req.url}"`); res.end(Buffer.alloc(50_000, req.url.length)); });
  try {
    const dir = tmp('evict');
    const f = makeConditionalFetch(globalThis.fetch, { dir, hosts: ['127.0.0.1'], totalBytes: 300 });   // gz of 50 kB of one byte ~ 100 bytes
    for (const p of ['/a', '/bb', '/ccc', '/dddd', '/eeeee']) { await (await f(`http://127.0.0.1:${s.address().port}${p}`)).text(); await new Promise((r) => setTimeout(r, 5)); }
    const entries = readdirSync(dir).filter((x) => x.endsWith('.gz')).length;
    assert.ok(entries >= 1 && entries < 5, `evicted down to ${entries} entries`);
  } finally { s.close(); }
});

// ---- (3) placement ----
test('placement: stores inside the data folder or a git work tree are refused; the default lies outside', () => {
  const data = tmp('data');
  assert.throws(() => checkPlacement(join(data, 'jcx-shadow'), data), PlacementError);
  const repo = tmp('repo'); mkdirSync(join(repo, '.git'));
  assert.throws(() => checkPlacement(join(repo, 'state', 'shadow'), data), /git work tree/);
  const home = tmp('home');
  const d = defaultDir('shadow', data, { JOBCRAWL_HOME: home });
  assert.ok(d.startsWith(home)); assert.equal(checkPlacement(d, data), d);
  assert.throws(() => shadowRoot(data, { JOBCRAWL_SHADOW_DATA: join(data, 'x') }), PlacementError);
});

// ---- (4) shadow hook: provider fallback, budgets, run time, missing routing ----
test('shadow hook: routes failed boards by res.provider; per-cycle budget skips the rest; run time logged; missing routing warns once', async () => {
  const data = tmp('hookdata'), store = tmp('hookstore');
  const rf = join(data, 'routing.json');
  writeFileSync(rf, JSON.stringify({ schema: 'routing/v1', providers: { greenhouse: 'shadow' } }));
  const env = { JOBCRAWL_SHADOW: '1', JOBCRAWL_ROUTING: rf, JOBCRAWL_SHADOW_DATA: store };
  const logs = [];
  // a failed board whose entry has no provider: the result's provider routes it
  let s = await runShadow({ dataDir: data, companies: [{ name: 'F' }], results: [{ error: 'HTTP 500', provider: 'greenhouse', triage: { cls: 'HTTP_5XX' } }], env, log: (m) => logs.push(m) });
  assert.equal(s.shadowed, 1, 'routed by res.provider');
  assert.match(logs.at(-1), / in \d+ ms ->/);
  // budget: a clock that jumps 10 s per call -> only the first board fits a 15 s budget
  let t = 0;
  const companies = ['A', 'B', 'C'].map((name) => ({ name, provider: 'greenhouse' }));
  const results = companies.map(() => ({ r: { provider: 'greenhouse' }, jobs: [job(1)] }));
  s = await runShadow({ dataDir: data, companies, results, env: { ...env, JOBCRAWL_SHADOW_BUDGET_MS: '15000', JOBCRAWL_SHADOW_BOARD_MS: '100000' }, clock: () => (t += 10000), log: () => {} });
  assert.ok(s.over_budget >= 1, JSON.stringify(s));
  assert.ok(s.shadowed >= 1);
  // missing routing file: one warning, then quiet
  const warn = [];
  const miss = { ...env, JOBCRAWL_ROUTING: join(data, 'missing.json') };
  await runShadow({ dataDir: data, companies, results, env: miss, log: (m) => warn.push(m) });
  await runShadow({ dataDir: data, companies, results, env: miss, log: (m) => warn.push(m) });
  assert.equal(warn.filter((m) => /not found/.test(m)).length, 1);
});
