// SAP SuccessFactors RMK tenant enumeration (crawler/rmk.mjs and the cc-harvest vendor `successfactors`; crawler audit 2026-11-06,
// finding 3). The tenant redirect follows what career5.successfactors.eu did for company=rohdeschwarz on 2026-11-06; hosts and job
// pages here are synthetic. No network: fetch is injected, and the cc-harvest run reads prepared probe results only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { successfactorsTenant, tenantSearchUrl, rmkJobFromUrl, rmkProbe, rmkEntryFields } from '../rmk.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('successfactorsTenant: the tenant id from a career<N>.successfactors.<eu|com>/career?company= URL', () => {
  assert.equal(successfactorsTenant('https://career5.successfactors.eu/career?company=rohdeschwarz&career_ns=job_listing_summary'), 'career5.successfactors.eu|rohdeschwarz');
  assert.equal(successfactorsTenant('https://career2.successfactors.com/career?company=AcmeP&lang=de_DE'), 'career2.successfactors.com|AcmeP');
  assert.equal(successfactorsTenant('https://career5.successfactors.eu/career?career_ns=x'), undefined, 'no company parameter');
  assert.equal(successfactorsTenant('https://career5.successfactors.eu/xi/ui/rcmcommon/x?company=a'), undefined, 'not the career page');
  assert.equal(successfactorsTenant('https://evil.example/career?company=a'), undefined, 'not a SuccessFactors data centre');
  assert.equal(successfactorsTenant('https://career5.successfactors.eu/career?company=a%20b'), undefined, 'not an id');
  assert.match(tenantSearchUrl('career5.successfactors.eu|rohdeschwarz'), /^https:\/\/career5\.successfactors\.eu\/career\?company=rohdeschwarz&career_ns=job_listing_summary/);
  assert.throws(() => tenantSearchUrl('example.org|x'), /bad tenant slug/);
});

test('rmkJobFromUrl: an RMK job URL gives its words as the title; other URLs give null', () => {
  assert.deepEqual(rmkJobFromUrl('https://jobs.acme.example/job/Ulm-Systems-Engineer-%28mwd%29-89077/1234567/'),
    { title: 'Ulm Systems Engineer (mwd) 89077', location: '', url: 'https://jobs.acme.example/job/Ulm-Systems-Engineer-%28mwd%29-89077/1234567/' });
  assert.ok(rmkJobFromUrl('https://jobs.acme.example/Acme/job/Graz-Test-Engineer/987654/'), 'a site segment before /job/');
  assert.equal(rmkJobFromUrl('https://jobs.acme.example/search/?q='), null);
  assert.equal(rmkJobFromUrl('https://jobs.acme.example/job/no-id/'), null);
});

/** A fake fetch: url -> { status, body, finalUrl } (a redirect is a different finalUrl, as fetch reports it in res.url). */
function fakeFetch(routes) {
  const asked = [];
  const fn = async (url) => {
    asked.push(url);
    const r = routes[url];
    if (!r) return { ok: false, status: 404, url, text: async () => 'missing' };
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, url: r.finalUrl ?? url, text: async () => r.body ?? '' };
  };
  return { fn, asked };
}
const SEARCH = tenantSearchUrl('career5.successfactors.eu|acmegroup');
const urlset = (locs) => `<?xml version="1.0"?><urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`;

test('rmkProbe: follows the tenant to its RMK host and lists the job pages of the sitemap (index followed, same host only, robots kept)', async () => {
  const { fn, asked } = fakeFetch({
    [SEARCH]: { finalUrl: 'https://jobs.acme.example/search' },
    'https://jobs.acme.example/robots.txt': { body: 'User-agent: *\nDisallow: /services/\nDisallow: /job/Secret-*\n' },
    'https://jobs.acme.example/sitemap.xml': { body: '<sitemapindex><sitemap><loc>https://jobs.acme.example/sitemap_jobs.xml</loc></sitemap><sitemap><loc>https://other.example/sitemap.xml</loc></sitemap></sitemapindex>' },
    'https://jobs.acme.example/sitemap_jobs.xml': { body: urlset([
      'https://jobs.acme.example/job/Ulm-Avionics-Engineer-89077/1111111/',
      'https://jobs.acme.example/job/Ulm-Avionics-Engineer-89077/1111111/',
      'https://jobs.acme.example/job/Secret-Role/2222222/',
      'https://jobs.acme.example/content/About/',
      'https://elsewhere.example/job/Bonn-Optics-Engineer/3333333/',
      'https://jobs.acme.example/job/Graz-Test-Engineer-8010/4444444/',
    ]) },
  });
  const p = await rmkProbe('career5.successfactors.eu|acmegroup', { fetchImpl: fn });
  assert.equal(p.host, 'jobs.acme.example');
  assert.deepEqual(p.jobs.map((j) => j.title), ['Ulm Avionics Engineer 89077', 'Graz Test Engineer 8010']);
  assert.equal(p.total, 2);
  assert.ok(!asked.includes('https://other.example/sitemap.xml'), 'a child sitemap on another host is not read');
  assert.ok(!asked.some((u) => u.includes('/services/')), 'the robots-disallowed search API is never asked');
});

test('rmkProbe: no redirect is an absence (HTTP 404), a disallowed sitemap is a robots error, a failed tenant page an HTTP error', async () => {
  const none = fakeFetch({ [SEARCH]: { finalUrl: SEARCH } });
  await assert.rejects(rmkProbe('career5.successfactors.eu|acmegroup', { fetchImpl: none.fn }), /^Error: HTTP 404 successfactors: .*no RMK career site/);
  const blocked = fakeFetch({
    [SEARCH]: { finalUrl: 'https://jobs.acme.example/search' },
    'https://jobs.acme.example/robots.txt': { body: 'User-agent: *\nDisallow: /\n' },
  });
  await assert.rejects(rmkProbe('career5.successfactors.eu|acmegroup', { fetchImpl: blocked.fn }), /robots\.txt of jobs\.acme\.example disallows \/sitemap\.xml/);
  assert.deepEqual(blocked.asked.filter((u) => u.endsWith('sitemap.xml')), [], 'the sitemap is not fetched');
  const down = fakeFetch({ [SEARCH]: { status: 503 } });
  await assert.rejects(rmkProbe('career5.successfactors.eu|acmegroup', { fetchImpl: down.fn }), /HTTP 503/);
});

test('cc-harvest: a probed SuccessFactors tenant is scored and spliced as a sitemap entry on its RMK host; a tracked host is skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobcrawl-rmk-'));
  try {
    const state = join(dir, 'state'), data = join(dir, 'data');
    mkdirSync(state); mkdirSync(data);
    writeFileSync(join(dir, 'companies.json'), JSON.stringify({
      title_filter: { positive: ['Engineer'], negative: [] }, location_filter: { allow: [], allow_unknown: true },
      tracked_companies: [{ name: 'Existing', provider: 'greenhouse', slug: 'existing' }],
    }, null, 2) + '\n');
    const rec = (id, host, extra = {}) => JSON.stringify({ k: `successfactors:career5.successfactors.eu|${id}`, vendor: 'successfactors', provider: 'sitemap',
      slug: `career5.successfactors.eu|${id}`, status: 'ok', jobs: 3, rmkHost: host, pass: 3, titlePass: 3, relRoles: 2, relPass: 2,
      relKw: { avionics: 1, optics: 1 }, samples: ['Ulm Avionics Engineer 89077'], ids: [], ...extra });
    writeFileSync(join(state, 'results.jsonl'), `${rec('acmegroup', 'jobs.acme.example')}\n${rec('tracked', 'jobs.tracked.example', { trackedHost: true })}\n`);
    const r = spawnSync(process.execPath, [join(ROOT, 'crawler/cc-harvest.mjs'), '--match', '--apply', '--state-dir', state, '--data', data,
      '--companies', join(dir, 'companies.json'), '--out', join(dir, 'out.json'), '--catalogue', join(dir, 'none.json')], { encoding: 'utf8', cwd: ROOT });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const csv = readFileSync(join(state, 'candidates.csv'), 'utf8').trim().split('\n');
    assert.equal(csv.length, 2, 'one candidate: the tracked RMK host is not offered again');
    assert.match(csv[1], /,sitemap,successfactors,career5\.successfactors\.eu\|acmegroup,Acmegroup,/);
    assert.match(csv[1], /https:\/\/jobs\.acme\.example\/$/, 'board_url is the RMK site');
    const added = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')).tracked_companies.slice(1);
    assert.equal(added.length, 1);
    assert.deepEqual({ provider: added[0].provider, slug: added[0].slug, url_pattern: added[0].url_pattern, careers_url: added[0].careers_url }, rmkEntryFields('jobs.acme.example'));
    assert.equal(added[0].probation, true, 'spliced on probation like every harvested board');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
