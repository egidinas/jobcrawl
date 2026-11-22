// Title-rule release (companies-file key title_release, coordinator 2026-11-21): at a listed board a role that fails only the title rules is
// kept open instead of extra, within the per-board cap; other boards, location verdicts and the switch off keep the former behaviour.
// A real crawl against a local HTTP server (sitemap provider, JobPosting JSON-LD pages). No network beyond 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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

// job 1 passes, jobs 2 and 4 fail only the title (Sales; no positive word), job 3 fails the location (Paris)
const JOBS = { 1: ['Systems Engineer', 'Berlin'], 2: ['Sales Manager', 'Berlin'], 3: ['Accountant', 'Paris'], 4: ['Office Clerk', 'Berlin'] };

function serve() {
  const server = createServer((req, res) => {
    const m = req.url.match(/^\/(inscope|other)\/(sitemap\.xml|job\/(\d))$/);
    if (!m) { res.statusCode = 404; return res.end('missing'); }
    if (m[2] === 'sitemap.xml') { res.setHeader('content-type', 'application/xml'); return res.end(sitemap(`http://127.0.0.1:${server.address().port}`, m[1], 4)); }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(page(m[1], ...JOBS[m[3]]));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const history = (data) => readFileSync(join(data, 'scan-history.tsv'), 'utf8').trim().split('\n').slice(1)
  .map((l) => Object.fromEntries(l.split('\t').map((v, i) => [HEADER[i], v])));
const statusOf = (rows, board, n) => rows.find((r) => r.url.endsWith(`/${board}/job/${n}`))?.status;

function writeProfile(dir, base, release) {
  const prof = join(dir, 'profile'), data = join(dir, 'data');
  mkdirSync(prof, { recursive: true }); mkdirSync(data, { recursive: true });
  writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 'fixture', crawl: { companies_file: 'companies.json' } }));
  writeFileSync(join(prof, 'release.json'), JSON.stringify({ boards: [{ name: 'In Scope Co' }] }));
  writeFileSync(join(prof, 'companies.json'), JSON.stringify({
    ...(release ? { title_release: release } : {}),
    title_filter: { positive: ['Engineer'], negative: ['Sales'], seniority_boost: ['Senior'] },
    location_filter: { allow: ['Berlin'], block_hard: [], allow_unknown: true },
    tracked_companies: [
      { name: 'In Scope Co', provider: 'sitemap', slug: `${base}/inscope/sitemap.xml`, url_pattern: '/job/' },
      { name: 'Other Co', provider: 'sitemap', slug: `${base}/other/sitemap.xml`, url_pattern: '/job/' },
    ],
  }));
  return { prof, data };
}
const crawl = (prof, data, extraArgs = []) => new Promise((done) => {
  const p = spawn(process.execPath, [resolve(ROOT, 'crawler/crawl.mjs'), '--profile', prof, '--data', data, ...extraArgs], {
    cwd: ROOT, env: { ...process.env, JOBCRAWL_PROFILE: '', JOBCRAWL_RAW_DIR: '', JOBCRAWL_TITLE_RELEASE: '' },
  });
  let stdout = '', stderr = '';
  p.stdout.on('data', (c) => (stdout += c)); p.stderr.on('data', (c) => (stderr += c));
  p.on('close', (status) => done({ status, stdout, stderr }));
});
const scannedLine = (r) => { const l = r.stdout.split('\n').find((x) => /^Scanned /.test(x)); assert.ok(l, r.stdout + r.stderr); return l; };
const released = (data) => (existsSync(join(data, 'title-released.tsv')) ? readFileSync(join(data, 'title-released.tsv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split('\t')[0]) : []);

const crawlAt = (prof, data, now, extraArgs = []) => new Promise((done) => {
  const p = spawn(process.execPath, [resolve(ROOT, 'crawler/crawl.mjs'), '--profile', prof, '--data', data, ...extraArgs], {
    cwd: ROOT, env: { ...process.env, JOBCRAWL_PROFILE: '', JOBCRAWL_RAW_DIR: '', JOBCRAWL_TITLE_RELEASE: '', JOBCRAWL_TITLE_RELEASE_NOW: now },
  });
  let stdout = '', stderr = '';
  p.stdout.on('data', (c) => (stdout += c)); p.stderr.on('data', (c) => (stderr += c));
  p.on('close', (status) => done({ status, stdout, stderr }));
});

test('title_release window: outside it nothing new is released and released roles stay open; inside it the cap applies', async () => {
  const server = await serve();
  const dir = mkdtempSync(join(tmpdir(), 'jobcrawl-title-window-'));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const on = { enabled: true, employers_file: 'release.json', max_per_cycle: 100, max_per_board_per_cycle: 1, window: { tz: 'Europe/Berlin', from: '21:30', to: '23:30' } };
    const { prof, data } = writeProfile(dir, base, on);
    // 12:00 UTC = 13:00 Berlin: outside
    const r1 = await crawlAt(prof, data, '2026-11-22T12:00:00Z');
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(scannedLine(r1), /title release: 0 released, 0 kept open, 2 deferred \(caps 0\/cycle, 1\/board; outside the release window 21:30-23:30 Europe\/Berlin \(now 13:00\)\)/);
    assert.equal(statusOf(history(data), 'inscope', 2), 'extra');
    // 21:45 UTC = 22:45 Berlin: inside, one released (board cap 1)
    const r2 = await crawlAt(prof, data, '2026-11-22T21:45:00Z', ['--force-due']);
    assert.match(scannedLine(r2), /title release: 1 released, 0 kept open, 1 deferred \(caps 100\/cycle, 1\/board\)/);
    // 00:30 Berlin the next night: outside again, the released role stays open, nothing new
    const r3 = await crawlAt(prof, data, '2026-11-22T23:30:00Z', ['--force-due']);
    assert.match(scannedLine(r3), /title release: 0 released, 1 kept open, 1 deferred \(caps 0\/cycle/);
    const rows = history(data);
    assert.deepEqual([statusOf(rows, 'inscope', 2), statusOf(rows, 'inscope', 4)].sort(), ['extra', 'open']);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('title_release extra shift: <data>/title-release-extra.json opens the window until its time or total runs out', async () => {
  const server = await serve();
  const dir = mkdtempSync(join(tmpdir(), 'jobcrawl-title-extra-'));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const on = { enabled: true, employers_file: 'release.json', max_per_cycle: 100, max_per_board_per_cycle: 1, window: { tz: 'Europe/Berlin', from: '21:30', to: '23:30' } };
    const { prof, data } = writeProfile(dir, base, on);
    writeFileSync(join(data, 'title-release-extra.json'), JSON.stringify({ until: '2026-11-22T14:00:00Z', max_total: 1 }));
    // 13:00 Berlin, outside the window but inside the extra shift: one released, the total of 1 is then used up
    const r1 = await crawlAt(prof, data, '2026-11-22T12:00:00Z');
    assert.match(scannedLine(r1), /title release: 1 released, 0 kept open, 1 deferred \(caps 1\/cycle, 1\/board; extra shift until 2026-11-22T14:00:00Z\)/);
    assert.equal(JSON.parse(readFileSync(join(data, 'title-release-extra.json'), 'utf8')).released, 1);
    const r2 = await crawlAt(prof, data, '2026-11-22T12:10:00Z', ['--force-due']);
    assert.match(scannedLine(r2), /title release: 0 released, 1 kept open, 1 deferred \(caps 0\/cycle, 1\/board; outside the release window/);
    // expired by time: outside again even with total left
    writeFileSync(join(data, 'title-release-extra.json'), JSON.stringify({ until: '2026-11-22T14:00:00Z', max_total: 5 }));
    const r3 = await crawlAt(prof, data, '2026-11-22T15:00:00Z', ['--force-due']);
    assert.match(scannedLine(r3), /title release: 0 released, 1 kept open, 1 deferred \(caps 0\/cycle/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('title_release: title-only failures at a listed board turn open within the per-board cap; others unchanged; switch off restores extra', async () => {
  const server = await serve();
  const dir = mkdtempSync(join(tmpdir(), 'jobcrawl-title-release-'));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const on = { enabled: true, employers_file: 'release.json', max_per_cycle: 100, max_per_board_per_cycle: 1 };
    const { prof, data } = writeProfile(dir, base, on);

    // cycle 1: one of the two title-only failures is released (cap 1 per board), the other waits as extra
    const r1 = await crawl(prof, data);
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(scannedLine(r1), /title release: 1 released, 0 kept open, 1 deferred \(caps 100\/cycle, 1\/board\)/);
    let rows = history(data);
    assert.equal(statusOf(rows, 'inscope', 1), 'open');
    assert.deepEqual([statusOf(rows, 'inscope', 2), statusOf(rows, 'inscope', 4)].sort(), ['extra', 'open']);
    assert.equal(statusOf(rows, 'inscope', 3), 'filtered', 'a location verdict still drops the role');
    assert.equal(statusOf(rows, 'other', 2), 'extra', 'a board not on the list keeps the title rules');
    assert.equal(statusOf(rows, 'other', 4), 'extra');
    assert.equal(released(data).length, 1);

    // cycle 2: the released role stays open without using the cap, the deferred one is released now
    const r2 = await crawl(prof, data, ['--force-due']);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(scannedLine(r2), /title release: 1 released, 1 kept open, 0 deferred/);
    rows = history(data);
    assert.equal(statusOf(rows, 'inscope', 2), 'open');
    assert.equal(statusOf(rows, 'inscope', 4), 'open');
    assert.equal(released(data).length, 2);

    // switch off (env): the former behaviour, the released roles turn extra again and leave the released file
    const r3 = await new Promise((done) => {
      const p = spawn(process.execPath, [resolve(ROOT, 'crawler/crawl.mjs'), '--profile', prof, '--data', data, '--force-due'], {
        cwd: ROOT, env: { ...process.env, JOBCRAWL_PROFILE: '', JOBCRAWL_RAW_DIR: '', JOBCRAWL_TITLE_RELEASE: '0' },
      });
      let stdout = '', stderr = '';
      p.stdout.on('data', (c) => (stdout += c)); p.stderr.on('data', (c) => (stderr += c));
      p.on('close', (status) => done({ status, stdout, stderr }));
    });
    assert.equal(r3.status, 0, r3.stderr);
    assert.doesNotMatch(scannedLine(r3), /title release/);
    rows = history(data);
    assert.equal(statusOf(rows, 'inscope', 2), 'extra');
    assert.equal(statusOf(rows, 'inscope', 4), 'extra');
    assert.equal(statusOf(rows, 'inscope', 1), 'open');
    assert.deepEqual(released(data), []);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
