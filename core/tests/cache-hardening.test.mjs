// Conditional cache review fixes (review_cache.md, 2026-11-28): a 304 never reaches the caller bare, max age, Request objects untouched,
// served-from-cache rows in the raw capture, profile key shape and host-specific placement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeConditionalFetch } from '../fetch/conditional.mjs';
import { installRawCapture, recordServedFromCache } from '../../crawler/rawcapture.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = (p) => mkdtempSync(join(tmpdir(), `jcx-ch-${p}-`));
function server() {
  const seen = [];
  const s = createServer((req, res) => {
    seen.push({ url: req.url, inm: req.headers['if-none-match'] ?? null });
    if (req.headers['if-none-match'] === '"v1"') { res.statusCode = 304; return res.end(); }
    res.setHeader('etag', '"v1"'); res.setHeader('content-type', 'application/json'); res.end('{"jobs":[1]}');
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ s, seen, url: (p = '/jobs') => `http://127.0.0.1:${s.address().port}${p}` })));
}
const metaFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.vary.json'));

test('an entry that cannot be read or deleted: the 304 is not passed on, the request is sent again without validators', async () => {
  const { s, seen, url } = await server();
  try {
    const dir = tmp('undel');
    const f = makeConditionalFetch(globalThis.fetch, { dir, hosts: ['127.0.0.1'] });
    await (await f(url())).text();
    const gz = readdirSync(dir).find((x) => x.endsWith('.gz'));
    rmSync(join(dir, gz)); mkdirSync(join(dir, gz)); writeFileSync(join(dir, gz, 'x'), 'block');   // the body "file" is now a non-empty folder: unreadable, undeletable
    const r = await f(url());
    assert.equal(r.status, 200); assert.equal(await r.text(), '{"jobs":[1]}');
    assert.deepEqual(seen.map((x) => x.inm), [null, '"v1"', null]);
  } finally { s.close(); }
});

test('valid metadata with a header name Response refuses: recovered every time (entry dropped, refetched, stored cleanly)', async () => {
  const { s, seen, url } = await server();
  try {
    const dir = tmp('badhdr');
    const f = makeConditionalFetch(globalThis.fetch, { dir, hosts: ['127.0.0.1'] });
    await (await f(url())).text();
    const m = metaFiles(dir)[0];
    const meta = JSON.parse(readFileSync(join(dir, m), 'utf8'));
    meta.headers['bad header'] = 'x';
    writeFileSync(join(dir, m), JSON.stringify(meta));
    const r1 = await f(url());
    assert.equal(r1.status, 200, 'not a bare 304'); assert.equal(await r1.text(), '{"jobs":[1]}');
    const r2 = await f(url());           // the dropped entry is stored again cleanly by the next full fetch
    assert.equal(r2.status, 200); await r2.text();
    const r3 = await f(url());
    assert.equal(r3.headers.get('x-jobcrawl-cache'), 'revalidated', 'served from the clean entry');
    assert.deepEqual(seen.map((x) => x.inm), [null, '"v1"', null, null, '"v1"']);
  } finally { s.close(); }
});

test('an entry older than the max age is fetched in full; a Request object is passed through untouched', async () => {
  const { s, seen, url } = await server();
  try {
    let t = Date.parse('2026-11-01T00:00:00Z');
    const dir = tmp('age');
    const f = makeConditionalFetch(globalThis.fetch, { dir, hosts: ['127.0.0.1'], maxAgeMs: 7 * 864e5, now: () => t });
    await (await f(url())).text();
    t += 8 * 864e5;
    const r = await f(url());
    assert.equal(r.headers.get('x-jobcrawl-cache'), null);
    assert.deepEqual(seen.map((x) => x.inm), [null, null], 'no validators after 8 days');
    seen.length = 0;
    await (await f(new Request(url('/req')))).text(); await (await f(new Request(url('/req')))).text();
    assert.deepEqual(seen.map((x) => x.inm), [null, null]);
    assert.equal(readdirSync(dir).filter((x) => x.endsWith('.tmp')).length, 0, 'no temp files left');
  } finally { s.close(); }
});

test('a hit is reported to onServed, and the raw capture writes a served-from-cache index row', async () => {
  const { s, url } = await server();
  try {
    const raw = tmp('raw');
    installRawCapture(raw);
    const served = [];
    const f = makeConditionalFetch(globalThis.fetch, { dir: tmp('srv'), hosts: ['127.0.0.1'], onServed: (x) => { served.push(x.url); recordServedFromCache(x); } });
    await (await f(url())).text(); await (await f(url())).text();
    assert.deepEqual(served, [url()]);
    const idx = readdirSync(join(raw, 'index')).flatMap((d) => readFileSync(join(raw, 'index', d), 'utf8').trim().split('\n')).map((l) => JSON.parse(l));
    assert.equal(idx.filter((r) => r.cache === 'revalidated' && r.url === url()).length, 1);
    assert.equal(idx.filter((r) => r.status === 200 && !r.cache).length, 1, 'the first 200 as before');
  } finally { s.close(); }
});

// crawl.mjs: the profile key's shape and a dir that only exists on another host
function sitemapServer() {
  const s = createServer((req, res) => {
    const base = `http://127.0.0.1:${s.address().port}`;
    if (req.url === '/b/sitemap.xml') { res.setHeader('content-type', 'application/xml'); return res.end(`<?xml version="1.0"?><urlset><url><loc>${base}/b/job/1</loc></url></urlset>`); }
    res.setHeader('content-type', 'text/html');
    res.end(`<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Systems Engineer', datePosted: '2026-11-20', jobLocation: { '@type': 'Place', address: { addressLocality: 'Berlin' } } })}</script></head></html>`);
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}
const crawl = (prof, data) => new Promise((done) => {
  const p = spawn(process.execPath, [resolve(ROOT, 'crawler/crawl.mjs'), '--profile', prof, '--data', data], { cwd: ROOT, env: { ...process.env, JOBCRAWL_PROFILE: '', JOBCRAWL_RAW_DIR: '', JOBCRAWL_SHADOW: '' } });
  let out = '', err = '';
  p.stdout.on('data', (c) => (out += c)); p.stderr.on('data', (c) => (err += c));
  p.on('close', (status) => done({ status, out, err }));
});

test('crawl.mjs: a malformed key warns loudly; a dir whose parent does not exist on this host switches the cache off; a valid one prints the counters', async () => {
  const s = await sitemapServer();
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const mk = (cc) => {
      const dir = tmp('crawl'), prof = join(dir, 'p'), data = join(dir, 'd');
      mkdirSync(prof); mkdirSync(data);
      writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 'fx', crawl: { companies_file: 'companies.json', conditional_cache: cc } }));
      writeFileSync(join(prof, 'companies.json'), JSON.stringify({ title_filter: { positive: ['Engineer'], negative: [] }, location_filter: { allow: ['Berlin'], block_hard: [], allow_unknown: true },
        tracked_companies: [{ name: 'B', provider: 'sitemap', slug: `${base}/b/sitemap.xml`, url_pattern: '/job/' }] }));
      return { prof, data };
    };
    let x = mk({ hosts: '127.0.0.1' });
    let r = await crawl(x.prof, x.data);
    assert.equal(r.status, 0, r.err); assert.match(r.err, /WARNING crawl\.conditional_cache must be/);
    x = mk({ hosts: ['127.0.0.1'], dir: join(tmpdir(), 'jcx-no-such-parent-xyz', 'http-cache') });
    r = await crawl(x.prof, x.data);
    assert.equal(r.status, 0, r.err); assert.match(r.err, /conditional requests OFF \(the parent of crawl\.conditional_cache\.dir/);
    assert.equal(existsSync(join(tmpdir(), 'jcx-no-such-parent-xyz')), false, 'nothing created on this host');
    x = mk({ hosts: ['127.0.0.1'], dir: 'relative/cache' });
    r = await crawl(x.prof, x.data);
    assert.match(r.err, /must be an absolute path/);
    const good = join(tmp('cachehome'), 'http-cache');
    x = mk({ hosts: ['127.0.0.1'], dir: good });
    r = await crawl(x.prof, x.data);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /crawl: conditional requests on for 1 host pattern\(s\)/);
    assert.match(r.out, /crawl: conditional cache: \d+ served from cache/);
  } finally { s.close(); }
});
