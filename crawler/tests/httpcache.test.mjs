// Conditional GET store (crawler/httpcache.mjs) and its profile switch. No network: the base fetch is a stub.
// Run: node --test crawler/tests/httpcache.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeConditionalFetch, httpCacheStats } from '../httpcache.mjs';
import { loadProfile } from '../profile.mjs';

function stub(answers) {
  const seen = [];
  const base = async (url, init = {}) => {
    const h = new Headers(init.headers ?? {});
    seen.push({ url: String(url), inm: h.get('if-none-match'), ims: h.get('if-modified-since'), method: init.method ?? 'GET' });
    const a = answers.shift();
    return new Response(a.body ?? null, { status: a.status, headers: a.headers ?? {} });
  };
  return { base, seen };
}

test('httpcache: ETag answer is stored, the next GET revalidates and a 304 comes back as the stored 200 body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-hc-'));
  try {
    const { base, seen } = stub([
      { status: 200, body: '{"jobs":[1,2]}', headers: { etag: '"v1"', 'content-type': 'application/json' } },
      { status: 304 },
      { status: 200, body: '{"jobs":[1,2,3]}', headers: { etag: '"v2"', 'content-type': 'application/json' } },
    ]);
    const f = makeConditionalFetch(base, { dir });
    const before = httpCacheStats().revalidated;
    const r1 = await f('https://x.example/jobs.json');
    assert.deepEqual(await r1.json(), { jobs: [1, 2] });
    const r2 = await f('https://x.example/jobs.json');
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get('x-jobcrawl-cache'), 'revalidated');
    assert.equal(r2.url, 'https://x.example/jobs.json');
    assert.deepEqual(await r2.json(), { jobs: [1, 2] });
    assert.equal(seen[1].inm, '"v1"');
    const r3 = await f('https://x.example/jobs.json');
    assert.deepEqual(await r3.json(), { jobs: [1, 2, 3] });
    assert.equal(seen[2].inm, '"v1"');
    assert.equal(httpCacheStats().revalidated - before, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('httpcache: Last-Modified works; no validator, binary bodies, POST and own conditional headers pass through unstored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-hc-'));
  try {
    const { base, seen } = stub([
      { status: 200, body: '<rss/>', headers: { 'last-modified': 'Wed, 25 Nov 2026 10:00:00 GMT', 'content-type': 'application/rss+xml' } },
      { status: 304 },
      { status: 200, body: 'x', headers: { 'content-type': 'text/html' } },
      { status: 200, body: 'x', headers: { 'content-type': 'text/html' } },
      { status: 200, body: 'PNG', headers: { etag: '"i"', 'content-type': 'image/png' } },
      { status: 200, body: 'PNG', headers: { etag: '"i"', 'content-type': 'image/png' } },
      { status: 200, body: '{}', headers: { etag: '"p"', 'content-type': 'application/json' } },
      { status: 200, body: '{}', headers: { etag: '"p"', 'content-type': 'application/json' } },
    ]);
    const f = makeConditionalFetch(base, { dir });
    await (await f('https://x.example/feed')).text();
    assert.equal(await (await f('https://x.example/feed')).text(), '<rss/>');
    assert.equal(seen[1].ims, 'Wed, 25 Nov 2026 10:00:00 GMT');
    await f('https://x.example/plain'); await f('https://x.example/plain');
    assert.equal(seen[3].inm, null);
    await f('https://x.example/logo.png'); await f('https://x.example/logo.png');
    assert.equal(seen[5].inm, null);
    await f('https://x.example/api', { method: 'POST', body: '{}' }); await f('https://x.example/api', { method: 'POST', body: '{}' });
    assert.equal(seen[7].inm, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('profile: crawl.http_cache is off unless enabled, and checked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-prof-'));
  try {
    const write = (crawl) => { writeFileSync(join(dir, 'profile.json'), JSON.stringify({ crawl })); return loadProfile(dir); };
    assert.equal(write({}).httpCache, null);
    assert.equal(write({ http_cache: { enabled: false } }).httpCache, null);
    assert.deepEqual(write({ http_cache: { enabled: true, max_body_kb: 100 } }).httpCache, { maxBodyBytes: 102400 });
    assert.throws(() => write({ http_cache: { enabled: 'yes' } }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
