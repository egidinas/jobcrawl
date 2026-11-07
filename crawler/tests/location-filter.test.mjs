// The location filter never drops a role silently (crawler audit 2026-11-06, finding 1): allow_country_codes lets "<City>, DE"
// through without the city on the allow list, any_location keeps an in-scope employer's roles anywhere, and every role the filter
// drops gets a 'filtered' history row, a reason count and, when its title passed, a per-board count in the cycle notes.
// A real crawl against a local HTTP server (sitemap provider, JobPosting JSON-LD pages). No network beyond 127.0.0.1.
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

// [title, addressLocality, addressCountry]; the provider writes the location as "<locality>, <country>".
const JOBS = {
  1: ['Systems Engineer', 'Ulm', 'DE'],                       // SuccessFactors style: a German town that is not on the allow list
  2: ['Test Engineer', 'Graz', 'AT'],
  3: ['Avionics Engineer', 'Harrisburg, PA, 17057', ''],      // a US place with a ZIP code: no country code token
  4: ['Optics Engineer', 'Toulouse', 'FR'],
  5: ['Sales Manager', 'Toulouse', 'FR'],                     // fails the title and the place
  6: ['Systems Engineer', 'Madeira', 'PT'],                   // "de" inside a word is no country token
  7: ['Software Engineer', 'Berlin', ''],                     // on the allow list
};
const page = (board, [title, city, country]) => `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'JobPosting', title, datePosted: '2026-10-20',
  description: `<p>${board} is hiring a ${title} in ${city}. Reference ${board}-${title.length}-${city.length}.</p>`,
  jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: city, ...(country ? { addressCountry: country } : {}) } },
})}</script></head><body>${title}</body></html>`;

function serve() {
  const server = createServer((req, res) => {
    const m = req.url.match(/^\/(home|global)\/(sitemap\.xml|job\/(\d))$/);
    if (!m) { res.statusCode = 404; return res.end('missing'); }
    if (m[2] === 'sitemap.xml') {
      const base = `http://127.0.0.1:${server.address().port}`;
      res.setHeader('content-type', 'application/xml');
      return res.end(`<?xml version="1.0"?><urlset>${Object.keys(JOBS).map((n) => `<url><loc>${base}/${m[1]}/job/${n}</loc><lastmod>2026-10-20</lastmod></url>`).join('')}</urlset>`);
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(page(m[1], JOBS[m[3]]));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function writeProfile(dir, base, locationFilter, globalEntry = {}) {
  const prof = join(dir, 'profile'), data = join(dir, 'data');
  mkdirSync(prof, { recursive: true }); mkdirSync(data, { recursive: true });
  writeFileSync(join(prof, 'profile.json'), JSON.stringify({ name: 'fixture', crawl: { companies_file: 'companies.json' } }));
  writeFileSync(join(prof, 'companies.json'), JSON.stringify({
    title_filter: { positive: ['Engineer'], negative: ['Sales'] },
    location_filter: { allow: ['Berlin'], block_hard: [], allow_unknown: true, ...locationFilter },
    tracked_companies: [
      { name: 'Home Board', provider: 'sitemap', slug: `${base}/home/sitemap.xml`, url_pattern: '/job/' },
      { name: 'Global Board', provider: 'sitemap', slug: `${base}/global/sitemap.xml`, url_pattern: '/job/', ...globalEntry },
    ],
  }));
  return { prof, data };
}
const crawl = (prof, data) => new Promise((done) => {
  const p = spawn(process.execPath, [resolve(ROOT, 'crawler/crawl.mjs'), '--profile', prof, '--data', data], {
    cwd: ROOT, env: { ...process.env, JOBCRAWL_PROFILE: '', JOBCRAWL_RAW_DIR: '' },
  });
  let stdout = '', stderr = '';
  p.stdout.on('data', (c) => (stdout += c)); p.stderr.on('data', (c) => (stderr += c));
  p.on('close', (status) => done({ status, stdout, stderr }));
});
const history = (data) => readFileSync(join(data, 'scan-history.tsv'), 'utf8').trim().split('\n').slice(1)
  .map((l) => Object.fromEntries(l.split('\t').map((v, i) => [HEADER[i], v])));
const statuses = (rows, board) => Object.fromEntries(Object.keys(JOBS).map((n) => [n, rows.find((r) => r.url.endsWith(`/${board}/job/${n}`))?.status]));
const note = (r, prefix) => r.stdout.split('\n').map((l) => l.replace(/^\s+- /, '')).find((l) => l.startsWith(prefix));

async function withCrawl(locationFilter, globalEntry, check) {
  const server = await serve();
  const dir = mkdtempSync(join(tmpdir(), 'jobcrawl-location-'));
  try {
    const { prof, data } = writeProfile(dir, `http://127.0.0.1:${server.address().port}`, locationFilter, globalEntry);
    const r = await crawl(prof, data);
    assert.equal(r.status, 0, r.stderr);
    await check(r, history(data));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('allow_country_codes: "<City>, DE" and "<City>, AT" pass without the city on the allow list; ZIP codes and word fragments do not', async () => {
  await withCrawl({ allow_country_codes: ['DE', 'AT', 'CH'] }, {}, (r, rows) => {
    assert.deepEqual(statuses(rows, 'home'), { 1: 'open', 2: 'open', 3: 'filtered', 4: 'filtered', 5: 'filtered', 6: 'filtered', 7: 'open' });
    assert.equal(note(r, 'filtered by reason:'), 'filtered by reason: location-not-allowed 6, negative-title 2');
    assert.equal(note(r, 'title-passing roles dropped'), 'title-passing roles dropped for their location, by board: Global Board 3, Home Board 3',
      'a failed title (job 5) is not counted as a location loss');
  });
});

test('without allow_country_codes the same roles are dropped, but recorded and named per board, never silently', async () => {
  await withCrawl({}, {}, (r, rows) => {
    assert.deepEqual(statuses(rows, 'home'), { 1: 'filtered', 2: 'filtered', 3: 'filtered', 4: 'filtered', 5: 'filtered', 6: 'filtered', 7: 'open' });
    assert.equal(rows.length, 14, 'every fetched role has a history row');
    assert.equal(note(r, 'filtered by reason:'), 'filtered by reason: location-not-allowed 10, negative-title 2');
    assert.equal(note(r, 'title-passing roles dropped'), 'title-passing roles dropped for their location, by board: Global Board 5, Home Board 5');
  });
});

test('any_location: the in-scope board keeps every title-passing role wherever it is and loses nothing to the location filter', async () => {
  await withCrawl({ allow_country_codes: ['DE', 'AT', 'CH'] }, { any_location: true }, (r, rows) => {
    assert.deepEqual(statuses(rows, 'global'), { 1: 'open', 2: 'open', 3: 'open', 4: 'open', 5: 'extra', 6: 'open', 7: 'open' });
    assert.equal(note(r, 'title-passing roles dropped'), 'title-passing roles dropped for their location, by board: Home Board 3');
  });
});

test('a cycle without location drops prints no per-board line', async () => {
  await withCrawl({ allow_unknown: true, allow: ['Berlin', 'Ulm', 'Graz', 'Harrisburg', 'Toulouse', 'Madeira'] }, {}, (r, rows) => {
    assert.equal(note(r, 'title-passing roles dropped'), undefined);
    assert.equal(note(r, 'filtered by reason:'), undefined, 'nothing filtered: the Sales role is kept as extra');
    assert.equal(statuses(rows, 'home')[5], 'extra');
  });
});
