import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeGuardedFetch, installEngineFetch } from '../fetch/guard.mjs';
import { readBoard } from '../run-board.mjs';
import { SsrfError } from '../fetch/ssrf.mjs';

const pub = async () => [{ address: '93.184.216.34', family: 4 }];
const guard = (base, o = {}) => makeGuardedFetch(base, { lookupImpl: pub, ...o });

test('guard: a Request input keeps method, headers and body (checked and unchecked path)', async () => {
  for (const mk of [(b) => guard(b), (b) => makeGuardedFetch(b, { egress: false })]) {
    let seen;
    const base = async (u, init) => { seen = { init, body: init.body && Buffer.from(init.body).toString() }; return new Response('ok'); };
    await mk(base)(new Request('https://a.example/p', { method: 'POST', headers: { 'content-type': 'application/json', 'x-k': '1' }, body: '{"a":1}' }));
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.body, '{"a":1}');
    assert.equal(new Headers(seen.init.headers).get('x-k'), '1');
  }
});

test('guard: 303 keeps HEAD, turns POST into GET and drops the body headers; 307 keeps the body', async () => {
  const calls = [];
  const base = (status) => async (u, init) => {
    calls.push({ u, init });
    return u.endsWith('/r') ? new Response(null, { status, headers: { location: '/t' } }) : new Response('ok');
  };
  await guard(base(303))('https://a.example/r', { method: 'HEAD' });
  assert.equal(calls.at(-1).init.method, 'HEAD');
  await guard(base(303))('https://a.example/r', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain', 'content-length': '1', 'x-k': '1' } });
  const g = calls.at(-1).init, h = new Headers(g.headers);
  assert.equal(g.method, 'GET');
  assert.equal(g.body, undefined);
  assert.equal(h.get('content-type'), null);
  assert.equal(h.get('content-length'), null);
  assert.equal(h.get('x-k'), '1');
  await guard(base(307))('https://a.example/r', { method: 'POST', body: 'x' });
  assert.equal(calls.at(-1).init.method, 'POST');
  assert.equal(calls.at(-1).init.body, 'x');
});

test('install: readBoard does not swap the process fetch; installEngineFetch is the entry-point switch and refuses private targets', async () => {
  const before = globalThis.fetch;
  const run = await readBoard({ name: 'b' }, { providers: { p: { async fetch() { return []; } } }, resolve: () => ({ provider: 'p', slug: 's' }) });
  assert.equal(run.ok, true);
  assert.equal(globalThis.fetch, before, 'readBoard left the global fetch alone');
  const uninstall = installEngineFetch();
  try {
    assert.notEqual(globalThis.fetch, before);
    assert.equal(installEngineFetch(), uninstall, 'idempotent');
    await assert.rejects(fetch('http://127.0.0.1:9/'), SsrfError);
  } finally { uninstall(); }
  assert.equal(globalThis.fetch, before);
});

test('abort: two concurrent boards, one aborted at its budget, the other completes untouched', async () => {
  const orig = globalThis.fetch;
  const srv = http.createServer((req, res) => { if (req.url === '/fast') setTimeout(() => res.end('[]'), 300); else { res.writeHead(200); res.write('['); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  globalThis.fetch = makeGuardedFetch(orig, { testAllowHosts: ['127.0.0.1'] });
  try {
    const mk = (path) => ({ p: { async fetch() { const r = await fetch(`http://127.0.0.1:${port}${path}`); return JSON.parse(await r.text()); } } });
    const resolve = () => ({ provider: 'p', slug: 's' });
    const [slow, fast] = await Promise.all([
      readBoard({ name: 'slow' }, { providers: mk('/slow'), resolve, timeoutMs: 100 }),
      readBoard({ name: 'fast' }, { providers: mk('/fast'), resolve, timeoutMs: 5000 }),
    ]);
    assert.equal(slow.ok, false);
    assert.equal(fast.ok, true, 'the other board was not aborted');
  } finally { globalThis.fetch = orig; srv.closeAllConnections(); srv.close(); }
});
