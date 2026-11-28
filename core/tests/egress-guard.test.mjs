import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeGuardedFetch } from '../fetch/guard.mjs';
import { runWithSignal } from '../fetch/context.mjs';
import { readBoard } from '../run-board.mjs';
import { SsrfError } from '../fetch/ssrf.mjs';

const pub = async () => [{ address: '93.184.216.34', family: 4 }];
const never = () => { throw new Error('base must not be reached'); };
const guard = (base = never, o = {}) => makeGuardedFetch(base, { lookupImpl: pub, ...o });

test('guard: every spelling of a non-public target is refused before the base fetch', async () => {
  const f = guard();
  const urls = ['http://127.0.0.1/', 'http://localhost/', 'http://a.localhost/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/', 'http://0.0.0.0/', 'http://[::1]/', 'http://[fc00::1]/', 'http://[fd12:3456::1]/',
    'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:a00:1]/', 'http://[64:ff9b::7f00:1]/',
    'http://2130706433/', 'http://017700000001/', 'http://0177.0.0.1/', 'http://0x7f.1/', 'http://0x7f000001/', 'http://127.1/',
    'file:///etc/passwd', 'ftp://example.com/', 'http://user:pw@example.com/'];
  for (const u of urls) await assert.rejects(f(u), SsrfError, u);
});

test('guard: a DNS name resolving to a private address is refused, including one private answer among public ones', async () => {
  await assert.rejects(guard(never, { lookupImpl: async () => [{ address: '10.0.0.5' }] })('https://evil.example/'), SsrfError);
  await assert.rejects(guard(never, { lookupImpl: async () => [{ address: '93.184.216.34' }, { address: '::1' }] })('https://evil.example/'), SsrfError);
  await assert.rejects(guard(never, { lookupImpl: async () => [{ address: '::ffff:7f00:1' }] })('https://evil.example/'), SsrfError);
});

test('guard: a rebinding name (public at the check, private at the second resolution) does not deliver its body', async () => {
  let n = 0, cancelled = false;
  const lookupImpl = async () => [{ address: n++ === 0 ? '93.184.216.34' : '127.0.0.1' }];
  const base = async () => ({ status: 200, headers: new Headers(), body: { cancel: async () => { cancelled = true; } } });
  await assert.rejects(makeGuardedFetch(base, { lookupImpl })('https://rebind.example/'), /second resolution/);
  assert.equal(cancelled, true);
});

test('guard: redirects are followed manually and every hop is checked', async () => {
  const seen = [];
  const base = async (u, init) => {
    seen.push([u, init.redirect]);
    if (u === 'https://a.example/') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/x' } });
    return new Response('secret');
  };
  await assert.rejects(guard(base)('https://a.example/'), SsrfError);
  assert.deepEqual(seen, [['https://a.example/', 'manual']]);
  const lk = async (h) => [{ address: h === 'internal.example' ? '10.0.0.9' : '93.184.216.34' }];
  const base2 = async (u) => (u === 'https://a.example/' ? new Response(null, { status: 301, headers: { location: 'https://internal.example/' } }) : new Response('x'));
  await assert.rejects(makeGuardedFetch(base2, { lookupImpl: lk })('https://a.example/'), /internal.example resolves to a non-public/);
  // a public redirect chain works, with relative locations, and 'manual' hands the 3xx back
  const base3 = async (u) => (u.endsWith('/one') ? new Response(null, { status: 302, headers: { location: '/two' } }) : new Response('done'));
  assert.equal(await (await guard(base3)('https://b.example/one')).text(), 'done');
  assert.equal((await guard(base3)('https://b.example/one', { redirect: 'manual' })).status, 302);
  await assert.rejects(guard(base3)('https://b.example/one', { redirect: 'error' }), /redirect/);
});

test('guard: redirect loops stop at maxHops; credentials are dropped on a cross-origin hop', async () => {
  const loop = async (u) => new Response(null, { status: 302, headers: { location: u + 'x' } });
  await assert.rejects(guard(loop, { maxHops: 3 })('https://l.example/'), /redirects/);
  let auth = 'unset';
  const base = async (u, init) => {
    if (u === 'https://a.example/') return new Response(null, { status: 302, headers: { location: 'https://b.example/' } });
    auth = new Headers(init.headers).get('authorization');
    return new Response('ok');
  };
  await guard(base)('https://a.example/', { headers: { authorization: 'Bearer t' } });
  assert.equal(auth, null);
});

test('guard: allowPrivate and egress:false switch the address check off (operator opt-out)', async () => {
  const ok = async () => new Response('ok');
  assert.equal(await (await makeGuardedFetch(ok, { allowPrivate: true })('http://127.0.0.1/')).text(), 'ok');
  assert.equal(await (await makeGuardedFetch(ok, { egress: false })('http://10.0.0.1/')).text(), 'ok');
});

function slowServer() {
  let sockets = 0, closed = 0, reqSockClosed = false;
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('start'); req.socket.on('close', () => { reqSockClosed = true; }); /* never ends */ });
  srv.on('connection', (s) => { sockets++; s.on('close', () => closed++); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, stats: () => ({ sockets, closed, reqSockClosed }) })));
}

test('abort: a caller signal aborts a slow local request (explicit test-only allow)', async () => {
  const { srv, port } = await slowServer();
  try {
    const f = makeGuardedFetch(globalThis.fetch, { testAllowHosts: ['127.0.0.1'] });
    const t0 = Date.now();
    await assert.rejects(async () => { const r = await f(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(150) }); await r.text(); });
    assert.ok(Date.now() - t0 < 3000);
    // without the allow option the same URL is refused
    await assert.rejects(makeGuardedFetch(globalThis.fetch)(`http://127.0.0.1:${port}/`), SsrfError);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('abort: a board time budget aborts the in-flight requests of a source that knows nothing about ctx', async () => {
  const { srv, port, stats } = await slowServer();
  const orig = globalThis.fetch;
  globalThis.fetch = makeGuardedFetch(orig, { testAllowHosts: ['127.0.0.1'] });
  try {
    let sourceErr = null;
    const providers = { slow: { async fetch() { try { const r = await fetch(`http://127.0.0.1:${port}/`); return JSON.parse(await r.text()); } catch (e) { sourceErr = e; throw e; } } } };
    const resolve = () => ({ provider: 'slow', slug: 'x' });
    const t0 = Date.now();
    const run = await readBoard({ name: 'slowboard' }, { providers, resolve, timeoutMs: 200 });
    assert.equal(run.ok, false);
    assert.match(run.error.detail, /Timed out/);
    assert.ok(Date.now() - t0 < 3000, 'returned at the budget');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(sourceErr, 'the source itself was aborted (not just abandoned)');
    assert.equal(stats().reqSockClosed, true, 'the connection to the server was closed by the abort');
  } finally { globalThis.fetch = orig; srv.closeAllConnections(); srv.close(); }
});

test('abort: a source receives ctx.signal, and runWithSignal feeds the same signal to nested fetches', async () => {
  let got = null;
  const providers = { p: { async fetch(slug, entry, ctx) { got = ctx?.signal; return []; } } };
  const run = await readBoard({ name: 'b' }, { providers, resolve: () => ({ provider: 'p', slug: 's' }) });
  assert.equal(run.ok, true);
  assert.ok(got instanceof AbortSignal);
  const ac = new AbortController(); ac.abort(new Error('budget'));
  await assert.rejects(runWithSignal(ac.signal, () => makeGuardedFetch(never, { egress: false })('https://x.example/')), /budget|abort/i);
});
