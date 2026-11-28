// Global pacing and connect retries (core/fetch/pace.mjs), from the recording incident of 2026-11-28 (bursts of new connections dropped
// on the NUC uplink: every board failed with UND_ERR_CONNECT_TIMEOUT and the cause was hidden behind "fetch failed").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePacedFetch, errorCode, isConnectError } from '../fetch/pace.mjs';

const connectErr = (code = 'UND_ERR_CONNECT_TIMEOUT') => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code }) });
function clock() { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; }

test('requests start at most one per gap across the whole process (no burst of new connections)', async () => {
  const starts = [];
  const f = makePacedFetch(async () => { starts.push(Date.now()); return new Response('ok'); }, { gapMs: 40 });
  await Promise.all(Array.from({ length: 8 }, () => f('https://x.example/')));
  assert.equal(starts.length, 8);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 35, `start ${i} after ${starts[i] - starts[i - 1]} ms`);
});

test('connect failures are retried with backoff and their real cause is reported; the third attempt succeeds', async () => {
  const c = clock(), seen = [];
  let n = 0;
  const f = makePacedFetch(async () => { if (n++ < 2) throw connectErr(); return new Response('ok'); }, { gapMs: 0, ...c, onError: (u, code, attempt) => seen.push([code, attempt]) });
  const r = await f('https://x.example/');
  assert.equal(await r.text(), 'ok');
  assert.deepEqual(seen, [['UND_ERR_CONNECT_TIMEOUT', 0], ['UND_ERR_CONNECT_TIMEOUT', 1]]);
  assert.ok(c.now() >= 13000, 'waited 3 s + 10 s');
});

test('gives up after the retries and throws the original error', async () => {
  const c = clock();
  const f = makePacedFetch(async () => { throw connectErr('ECONNRESET'); }, { gapMs: 0, retries: 2, ...c });
  await assert.rejects(f('https://x.example/'), (e) => errorCode(e) === 'ECONNRESET');
});

test('HTTP answers, other errors and caller aborts are never retried', async () => {
  const c = clock();
  let calls = 0;
  const http = makePacedFetch(async () => { calls++; return new Response('busy', { status: 503 }); }, { gapMs: 0, ...c });
  assert.equal((await http('https://x.example/')).status, 503); assert.equal(calls, 1);
  calls = 0;
  const other = makePacedFetch(async () => { calls++; throw new TypeError('bad header'); }, { gapMs: 0, ...c });
  await assert.rejects(other('https://x.example/')); assert.equal(calls, 1);
  calls = 0;
  const ac = new AbortController(); ac.abort();
  const aborted = makePacedFetch(async () => { calls++; throw connectErr(); }, { gapMs: 0, ...c });
  await assert.rejects(aborted('https://x.example/', { signal: ac.signal })); assert.equal(calls, 1);
});

test('error codes: the cause code behind "fetch failed"', () => {
  assert.equal(errorCode(connectErr('EAI_AGAIN')), 'EAI_AGAIN');
  assert.equal(isConnectError(connectErr()), true);
  assert.equal(isConnectError(new Error('x')), false);
  assert.equal(errorCode(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 'TimeoutError', 'not the numeric legacy code 23');
});

test('reproduction: an uplink that drops bursts of new connections fails a burst of 8; paced, all 8 get through', async () => {
  // simulated uplink: a connection attempt fails (connect timeout) when 3 or more attempts started within the last 100 ms
  const uplink = () => { const starts = []; return async () => { const t = Date.now(); starts.push(t); if (starts.filter((s) => t - s < 100).length >= 3) throw connectErr(); return new Response('ok'); }; };
  const burst = makePacedFetch(uplink(), { gapMs: 0, retries: 0 });
  const r1 = await Promise.allSettled(Array.from({ length: 8 }, () => burst('https://x.example/')));
  assert.ok(r1.filter((r) => r.status === 'rejected').length >= 5, 'the burst mostly fails, as on the NUC');
  const paced = makePacedFetch(uplink(), { gapMs: 60, retries: 0 });
  const r2 = await Promise.allSettled(Array.from({ length: 8 }, () => paced('https://x.example/')));
  assert.equal(r2.filter((r) => r.status === 'fulfilled').length, 8);
});
