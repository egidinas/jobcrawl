// Collect-only boards (companies-file key collect_only): a real crawl against a local HTTP server (sitemap provider, JobPosting JSON-LD
// pages), one normal board and one collect-only board. No network beyond 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HEADER = ['url', 'company', 'title', 'location', 'first_seen', 'last_seen', 'status', 'posted'];

const page = (board, title, city) => `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'JobPosting', title, datePosted: '2026-10-20',
  description: `<p>${board} is hiring a ${title} in ${city}. Apply at ${board}, reference ${board}-${title.length}.</p>`,
  jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: city, addressCountry: 'DE' } },
})}</script></head><body>${title}</body></html>`;
const sitemap = (base, board, n) => `<?xml version="1.0"?><urlset>${Array.from({ length: n }, (_, i) =>
  `<url><loc>${base}/${board}/job/${i + 1}</loc><lastmod>2026-10-20</lastmod></url>`).join('')}</urlset>`;

// Both boards: job 1 passes title and location, job 2 fails the title (Sales), job 3 fails the location (Paris).
const JOBS = { 1: ['Systems Engineer', 'Berlin'], 2: ['Sales Manager', 'Berlin'], 3: ['Test Engineer', 'Paris'] };

function serve() {
  const server = createServer((req, res) => {
    let base;
    const m = req.url.match(/^\/(normal|agg)\/(sitemap\.xml|job\/(\d))$/);
    if (!m) { res.statusCode = 404; return res.end('missing'); }   // robots.txt too: no Disallow
    if (m[2] === 'sitemap.xml') { base = `http://127.0.0.1:${server.address().port}`; res.setHeader('content-type', 'application/xml'); return res.end(sitemap(base, m[1], 3)); }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(page(m[1], ...JOBS[m[3]]));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const history = (data) => readFileSync(join(data, 'scan-history.tsv'), 'utf8').trim().split('\n').slice(1)
  .map((l) => Object.fromEntries(l.split('\t').map((v, i) => [HEADER[i], v])));
const statusOf = (rows, board, n) => rows.find((r) => r.url.endsWith(`/${board}/job/${n}`))?.status;

function writeProfile(dir, base, aggEntry) {
  const prof = join(dir, 'profile'), data = join(dir, 'data');
  mkdirSync(prof, { recursive: true }); mkdirSync(data, { recursive: true });
  writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 'fixture', crawl: { companies_file: 'companies.json' } }));
  writeFileSync(join(prof, 'companies.json'), JSON.stringify({
    title_filter: { positive: ['Engineer'], negative: ['Sales'], seniority_boost: ['Senior'] },
    location_filter: { allow: ['Berlin'], block_hard: [], allow_unknown: true },
    tracked_companies: [
      { name: 'Normal Co', provider: 'sitemap', slug: `${base}/normal/sitemap.xml`, url_pattern: '/job/' },
      { name: 'Agg Feed', provider: 'sitemap', slug: `${base}/agg/sitemap.xml`, url_pattern: '/job/', ...aggEntry },
    ],
  }));
  return { prof, data };
}
// async, not spawnSync: the test process serves the feeds, so it must keep its event loop while the crawl runs
const crawl = (prof, data) => new Promise((done) => {
  const p = spawn(process.execPath, [resolve(ROOT, 'crawler/crawl.mjs'), '--profile', prof, '--data', data], {
    cwd: ROOT, env: { ...process.env, JOBCRAWL_PROFILE: '', JOBCRAWL_RAW_DIR: '' },
  });
  let stdout = '', stderr = '';
  p.stdout.on('data', (c) => (stdout += c)); p.stderr.on('data', (c) => (stderr += c));
  p.on('close', (status) => done({ status, stdout, stderr }));
});
const scannedLine = (r) => { const l = r.stdout.split('\n').find((x) => /^Scanned /.test(x)); assert.ok(l, r.stdout + r.stderr); return l; };

test('a collect_only board: matching titles end as extra, never open, never NEW; other verdicts still filter; counted in the summary', async () => {
  const server = await serve();
  const dir = mkdtempSync(join(tmpdir(), 'jobcrawl-collect-only-'));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const { prof, data } = writeProfile(dir, base, { collect_only: true });

    // first cycle: everything is new
    const r1 = await crawl(prof, data);
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(scannedLine(r1), 'Scanned 2/2 companies | 6 postings | 0 already known | 2 filtered | 3 kept as extra | 0 cross-listed | 0 shadowed by ATS | 1 NEW | 2 collect-only');
    let rows = history(data);
    assert.equal(statusOf(rows, 'normal', 1), 'open', 'normal board: matching title is open');
    assert.equal(statusOf(rows, 'normal', 2), 'extra', 'normal board: title-only failure is extra');
    assert.equal(statusOf(rows, 'normal', 3), undefined, 'normal board: a new role failing the location filter is not recorded (filtered)');
    assert.equal(statusOf(rows, 'agg', 1), 'extra', 'collect-only board: matching title is extra, not open');
    assert.equal(statusOf(rows, 'agg', 2), 'extra', 'collect-only board: title-only failure is extra');
    assert.equal(statusOf(rows, 'agg', 3), undefined, 'collect-only board: a location failure still filters, as on any board');
    assert.ok(!rows.some((r) => r.company === 'Agg Feed' && r.status === 'open'), 'nothing of the collect-only board is open');
    const fresh = JSON.parse(readFileSync(join(data, 'last-new.json'), 'utf8')).rows;
    assert.deepEqual(fresh.map((r) => [r.company, r.title]), [['Normal Co', 'Systems Engineer']], 'only the normal board is NEW');

    // second cycle: the known rows take the other code path and stay extra, nothing new
    const r2 = await crawl(prof, data);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(scannedLine(r2), 'Scanned 2/2 companies | 6 postings | 1 already known | 2 filtered | 3 kept as extra | 0 cross-listed | 0 shadowed by ATS | 0 NEW | 2 collect-only');
    rows = history(data);
    assert.equal(statusOf(rows, 'agg', 1), 'extra');
    assert.equal(statusOf(rows, 'normal', 1), 'open');
    assert.deepEqual(JSON.parse(readFileSync(join(data, 'last-new.json'), 'utf8')).rows, []);

    // a board that was open before and is switched to collect_only: its open row becomes extra and is not alerted as gone
    const sw = writeProfile(join(dir, 'switch'), base, {});
    const s1 = await crawl(sw.prof, sw.data);
    assert.equal(s1.status, 0, s1.stderr);
    assert.equal(statusOf(history(sw.data), 'agg', 1), 'open');
    writeProfile(join(dir, 'switch'), base, { collect_only: true });
    const s2 = await crawl(sw.prof, sw.data);
    assert.equal(s2.status, 0, s2.stderr);
    assert.equal(statusOf(history(sw.data), 'agg', 1), 'extra', 'a previously open row of a now collect-only board becomes extra');
    assert.doesNotMatch(s2.stdout, /GONE: Agg Feed/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a collect_only board the summary line is unchanged (no collect-only part)', async () => {
  const server = await serve();
  const dir = mkdtempSync(join(tmpdir(), 'jobcrawl-collect-only-'));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const { prof, data } = writeProfile(dir, base, {});
    const r = await crawl(prof, data);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(scannedLine(r), 'Scanned 2/2 companies | 6 postings | 0 already known | 2 filtered | 2 kept as extra | 0 cross-listed | 0 shadowed by ATS | 2 NEW');
    const rows = history(data);
    assert.equal(statusOf(rows, 'agg', 1), 'open');
    assert.equal(statusOf(rows, 'agg', 2), 'extra');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
