// Registry flag `aggregator: true`, employer from the sitemap's JSON-LD (employer_from_jsonld), and the startup cross-listing sweep.
// A real crawl against a local HTTP server (127.0.0.1 only).   Run: node --test crawler/tests/aggregator-flag.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { providers, setCacheDir } from '../providers.mjs';
import { isAggregatorEntry } from '../crosslist.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HEADER = ['url', 'company', 'title', 'location', 'first_seen', 'last_seen', 'status', 'posted'];
const jdName = (url) => createHash('sha1').update(url).digest('hex').slice(0, 10) + '.md';
const TODAY = new Date().toISOString().slice(0, 10);
const BODY = 'We are looking for an optical engineer to design and verify free-space laser communication terminals for small satellites. '.repeat(4);

test('isAggregatorEntry: the provider list or the explicit flag', () => {
  assert.equal(isAggregatorEntry({ provider: 'spacecareers' }), true);
  assert.equal(isAggregatorEntry({ provider: 'sitemap' }), false);
  assert.equal(isAggregatorEntry({ provider: 'sitemap', aggregator: true }), true);
  assert.equal(isAggregatorEntry({ provider: 'sitemap', aggregator: 'yes' }), false);
  assert.equal(isAggregatorEntry(undefined), false);
});

test('sitemap provider: employer_from_jsonld writes "<hiringOrganization> (via <board>)"; without the key the company stays the board', async () => {
  const page = (org) => `<html><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Optical Engineer', datePosted: '2026-11-01',
    description: 'x', ...(org ? { hiringOrganization: { '@type': 'Organization', name: org } } : {}), jobLocation: { address: { addressLocality: 'Berlin', addressCountry: 'DE' } } })}</script></html>`;
  const srv = createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/robots.txt') return res.end('');
    if (p === '/sitemap.xml') return res.end(`<urlset>${[1, 2].map((i) => `<url><loc>http://${req.headers.host}/job/${i}</loc><lastmod>2026-11-01</lastmod></url>`).join('')}</urlset>`);
    const m = p.match(/^\/job\/(\d)$/); if (!m) { res.statusCode = 404; return res.end(''); }
    res.end(page(m[1] === '1' ? 'ACME Space GmbH' : ''));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'agg-flag-'));
  setCacheDir(dir);
  try {
    const slug = `http://127.0.0.1:${srv.address().port}/sitemap.xml`;
    const on = await providers.sitemap.fetch(slug, { name: 'Board X', url_pattern: '/job/', employer_from_jsonld: true });
    assert.deepEqual(on.map((j) => j.company).sort(), ['ACME Space GmbH (via Board X)', undefined].sort());
    const off = await providers.sitemap.fetch(slug, { name: 'Board X', url_pattern: '/job/' });
    assert.ok(off.every((j) => j.company === undefined), 'no key: the crawl falls back to the board name');
    const viaName = await providers.sitemap.fetch(slug, { name: 'Board X (via Board X)', url_pattern: '/job/', employer_from_jsonld: true });
    assert.equal(viaName.find((j) => j.organization).company, 'ACME Space GmbH (via Board X)', 'an entry name that already carries (via ...) is not doubled');
  } finally { srv.close(); setCacheDir(null); rmSync(dir, { recursive: true, force: true }); }
});

const crawl = (prof, data, args = []) => new Promise((done) => {
  const p = spawn(process.execPath, [resolve(ROOT, 'crawler/crawl.mjs'), '--profile', prof, '--data', data, ...args], { cwd: ROOT, env: { ...process.env, JOBCRAWL_PROFILE: '', JOBCRAWL_RAW_DIR: '' } });
  let stdout = '', stderr = '';
  p.stdout.on('data', (c) => (stdout += c)); p.stderr.on('data', (c) => (stderr += c));
  p.on('close', (status) => done({ status, stdout, stderr }));
});

async function sweepRun(flag) {
  const srv = createServer((req, res) => { if (req.url.startsWith('/agg/sitemap.xml')) return res.end('<urlset></urlset>'); res.statusCode = 404; res.end(''); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'agg-sweep-'));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const prof = join(dir, 'profile'), data = join(dir, 'data');
    mkdirSync(prof, { recursive: true }); mkdirSync(join(data, 'jd'), { recursive: true });
    writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 'fixture', crawl: { companies_file: 'companies.json' } }));
    writeFileSync(join(prof, 'companies.json'), JSON.stringify({
      title_filter: { positive: ['Engineer'], negative: [], seniority_boost: [] }, location_filter: { allow: ['Berlin'], block_hard: [], allow_unknown: true },
      tracked_companies: [{ name: 'Agg Feed', provider: 'sitemap', slug: `${base}/agg/sitemap.xml`, url_pattern: '/job/', ...(flag ? { aggregator: true } : {}) }],
    }));
    const rows = [
      // fingerprint route: an aggregator copy (company = the board's name) and the employer's own posting with the same text, no shared URL key
      ['https://agg.example/job/1', 'Agg Feed', 'Optical Engineer', 'Berlin', 'open', true],
      ['https://careers.foo.example/j/9', 'Foo GmbH', 'Optical Engineer', 'Berlin', 'open', true],
      // key route: same Greenhouse posting id, "(via ...)" copy
      ['https://boards.greenhouse.io/bar/jobs/8656960002', 'Bar (via Agg Feed)', 'Mechanical Engineer', 'Berlin', 'open', false],
      ['https://www.bar.example/careers?gh_jid=8656960002', 'Bar', 'Mechanical Engineer', 'Berlin', 'open', false],
      // no direct twin: stays open
      ['https://agg.example/job/3', 'Baz (via Other Board)', 'Thermal Engineer', 'Berlin', 'open', false],
    ];
    writeFileSync(join(data, 'scan-history.tsv'), [HEADER.join('\t'), ...rows.map((r) => [r[0], r[1], r[2], r[3], TODAY, TODAY, r[4], TODAY].join('\t'))].join('\n') + '\n');
    for (const r of rows) if (r[5]) writeFileSync(join(data, 'jd', jdName(r[0])), `# ${r[2]}\n\n- Company: ${r[1]}\n- Location: ${r[3]}\n- URL: ${r[0]}\n- First seen: 2026-11-01\n\n${BODY}`);
    const res = await crawl(prof, data, ['--company', 'Agg Feed']);
    assert.equal(res.status, 0, res.stderr);
    const out = Object.fromEntries(readFileSync(join(data, 'scan-history.tsv'), 'utf8').trim().split('\n').slice(1).map((l) => { const c = l.split('\t'); return [c[0], c[6]]; }));
    return { out, stdout: res.stdout };
  } finally { srv.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('startup sweep: open aggregator copies of open direct rows become dup at once (key and fingerprint); the flag makes a board-named row an aggregator row', async () => {
  const on = await sweepRun(true);
  assert.equal(on.out['https://boards.greenhouse.io/bar/jobs/8656960002'], 'dup', 'same posting key');
  assert.equal(on.out['https://agg.example/job/1'], 'dup', 'same fingerprint, title and place; board-named row of a flagged board');
  assert.equal(on.out['https://agg.example/job/3'], 'open', 'no direct twin');
  assert.equal(on.out['https://careers.foo.example/j/9'], 'open');
  assert.equal(on.out['https://www.bar.example/careers?gh_jid=8656960002'], 'open', 'the direct row stays');
  assert.match(on.stdout, /cross-listing sweep: 2 open aggregator copies/);
  const off = await sweepRun(false);
  assert.notEqual(off.out['https://agg.example/job/1'], 'dup', 'without the flag a sitemap board is a direct employer: its row is never swept as a copy (the old behaviour)');
  assert.equal(off.out['https://boards.greenhouse.io/bar/jobs/8656960002'], 'dup', 'the (via ...) naming still works without the flag');
});
