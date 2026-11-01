// SAP SuccessFactors / Radancy career sites (the `successfactors` provider: jobs.bmwgroup.com, jobs.hensoldt.net, jobs.knds.de, ...)
// and the generic pageDescription, run on trimmed captured documents (crawler/tests/fixtures/, 2026-11-01). No network: the two
// fetch tests replace globalThis.fetch with a stub.   Run: node --test crawler/tests/feeds-radancy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providers, pageDescriptionOf, successfactorsTileJobs } from '../providers.mjs';

const text = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const ORIGIN = 'https://jobs.hensoldt.net';
/** What jobs.bmwgroup.com/tile-search-results/?startrow=0 returned on 2026-11-01: 16 bytes, no tile. */
const EMPTY_TILES = '<!DOCTYPE html>\n';

/** Runs fn with every HTTP request answered by handler(url) as a 200 text/html body; returns the requested URLs in order. */
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(handler(String(url)), { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' } });
  };
  try { await fn(calls); } finally { globalThis.fetch = real; }
  return calls;
}

test('successfactors: detect is unchanged', () => {
  const d = providers.successfactors.detect;
  assert.equal(d('https://jobs.bmwgroup.com/?locale=en_US'), 'jobs.bmwgroup.com');
  assert.equal(d('https://jobs.hensoldt.net/'), 'jobs.hensoldt.net');
  assert.equal(d('https://careers.ksat.no/job/Troms%C3%B8-Engineer/1234567/'), 'careers.ksat.no');
  assert.equal(d('https://example.com/careers'), null);
  assert.equal(providers.successfactors.fetchDescription, undefined, 'descriptions come from pageDescription');
});

test('successfactors: RMK tiles map to jobs with location and posting date', () => {
  assert.equal(EMPTY_TILES.length, 16);
  const html = text('successfactors-tiles.html');
  assert.equal([...html.matchAll(/<li class="job-tile/g)].length, 3, 'the fixture holds three tiles');
  const jobs = successfactorsTileJobs(html, ORIGIN);
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs[0], {
    title: 'Systemingenieur für TRx-4D Radare mit Schwerpunkt Obsoleszenz Bearbeitung (w/m/d)',
    url: 'https://jobs.hensoldt.net/job/Ulm-Systemingenieur-f%C3%BCr-TRx-4D-Radare-mit-Schwerpunkt-Obsoleszenz-Bearbeitung-%28wmd%29-89077/1363109555/',
    location: 'Ulm, DE, 89077',
    postedAt: '2026-11-01',
  });
  assert.equal(jobs[1].url, `${ORIGIN}/job/F%C3%BCrstenfeldbruck-Duales-Studium-Elektro-und-Informationstechnik-%28wmd%29%2C-F%C3%BCrstenfeldbruck%2C-Start-2027-82256/1354874855/`);
  assert.equal(jobs[1].location, 'Fürstenfeldbruck, DE, 82256');
  assert.match(jobs[2].url, /\/1334923755\/$/);
  assert.ok(jobs[2].location.startsWith('Wilhelmshaven, DE, 26389 • Koblenz, DE, 56073 • '), 'a multi-location tile keeps the whole list');
  assert.equal(jobs[2].title, 'Musterprüfingenieur Electrics / Avionics (w/m/d)');
  for (const j of jobs) {
    assert.deepEqual(Object.keys(j), ['title', 'url', 'location', 'postedAt'], 'the shape the provider always produced');
    assert.ok(j.title && !/<|\n/.test(j.title), j.title);
    assert.match(j.location, /^[^<\n]+, DE, \d{5}$/, j.location);
    assert.equal(j.postedAt, '2026-11-01', 'the Date field of the tile ("Nov 1, 2026"), which the provider used to leave empty');
  }

  // a page without a tile (BMW's answer) is empty, not an error; a tile without link or title maps to null and still counts
  assert.deepEqual(successfactorsTileJobs(EMPTY_TILES, ORIGIN), []);
  assert.deepEqual(successfactorsTileJobs('', ORIGIN), []);
  const bare = '<li class="job-tile job-id-1 x"><div>no link</div></li><li class="job-tile job-id-2" data-url="job/a/2/"><a class="jobTitle-link" href="/job/a/2/"> A </a></li>';
  assert.deepEqual(successfactorsTileJobs(bare, ORIGIN), [null, { title: 'A', url: `${ORIGIN}/job/a/2/`, location: '', postedAt: '' }]);
  assert.equal(successfactorsTileJobs('<li class="job-tile job-id-3" data-url="https://x.example/job/b/3/"><a class="jobTitle-link" href="#">B</a><div id="job-3-desktop-section-date-value">01.11.2026</div></li>', ORIGIN)[0].postedAt, '', 'a date format other than "Mon D, YYYY" stays empty rather than guessed');
});

test('pageDescriptionOf: JobPosting microdata when a job page has no JSON-LD', () => {
  const html = text('successfactors-job.html');
  assert.doesNotMatch(html, /ld\+json/, 'the RMK page carries no JSON-LD');
  assert.match(html, /itemtype="http:\/\/schema\.org\/JobPosting"/);
  const d = pageDescriptionOf(html, { title: 'Systemingenieur für TRx-4D Radare mit Schwerpunkt Obsoleszenz Bearbeitung (w/m/d)' });
  assert.ok(d.startsWith('Über den Bereich'), d.slice(0, 60));
  assert.ok(d.length > 3000, `the whole posting (${d.length} chars)`);
  assert.ok(d.endsWith('identity or ideology.'), d.slice(-60));
  assert.doesNotMatch(d, /<\/?[a-z]+[^>]*>|\r/, 'no HTML or CR left');
  assert.doesNotMatch(d, /Skip to main content|Apply now »|Job Requisition ID|Location:/, 'the description element, not the page chrome and metadata around it');
  assert.match(d, /Apply now and become part of the HENSOLDT team!/, 'the closing paragraph of the posting is part of the description');

  // JSON-LD still wins when present; a page with neither and little text yields nothing
  const ld = { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'X', description: '<p>' + 'Build satellites. '.repeat(50) + '</p>' };
  const withLd = html.replace('</head>', `<script type="application/ld+json">${JSON.stringify(ld)}</script></head>`);
  assert.ok(pageDescriptionOf(withLd, {}).startsWith('Build satellites.'));
  assert.equal(pageDescriptionOf('<html><body><div itemscope itemtype="http://schema.org/JobPosting"><div itemprop="description">short</div></div></body></html>', {}), '');
  assert.equal(pageDescriptionOf('<html><body><p>nothing</p></body></html>', {}), '');

  // the recruiting contact a posting publishes (applicationContact ContactPoint, hiringOrganization e-mail/telephone) closes the text as
  // one "Contact:" line; synthetic data (example.invalid), not a capture
  const inject = (jp) => pageDescriptionOf(html.replace('</head>', `<script type="application/ld+json">${JSON.stringify(jp)}</script></head>`), {});
  const full = inject({ ...ld,
    applicationContact: { '@type': 'ContactPoint', name: 'Erika Mustermann', contactType: 'Recruiting', email: 'mailto:recruiting@example.invalid', telephone: '+49 89 0000000' },
    hiringOrganization: { '@type': 'Organization', name: 'Example GmbH', email: 'jobs@example.invalid', telephone: 'tel:+49 89 0000001' } });
  assert.ok(full.startsWith('Build satellites.'));
  assert.ok(full.endsWith('\n\nContact: Erika Mustermann, Recruiting, recruiting@example.invalid, +49 89 0000000; Example GmbH, jobs@example.invalid, +49 89 0000001'), full.slice(-160));
  assert.equal(full.split('Contact:').length, 2, 'one line');
  assert.doesNotMatch(pageDescriptionOf(withLd, {}), /Contact:/, 'no contact in the posting: no line');
  assert.doesNotMatch(inject({ ...ld, hiringOrganization: { '@type': 'Organization', name: 'Example GmbH', sameAs: 'https://example.invalid' } }), /Contact:/, 'an organisation without e-mail or telephone adds nothing');
  assert.ok(inject({ ...ld, applicationContact: [{ '@type': 'ContactPoint', email: 'a@example.invalid' }, { '@type': 'ContactPoint', telephone: '+49 89 0000002' }, {}] })
    .endsWith('\n\nContact: a@example.invalid; +49 89 0000002'), 'a list of contact points, an empty one skipped');
  assert.ok(inject({ ...ld, applicationContact: 'Recruiting team, recruiting@example.invalid' }).endsWith('\n\nContact: Recruiting team, recruiting@example.invalid'), 'a bare string is kept as text');
});

test('successfactors: an empty tile response makes the fetch throw instead of listing 0 jobs', async () => {
  const calls = await withFetch(() => EMPTY_TILES, async () => {
    await assert.rejects(providers.successfactors.fetch('jobs.bmwgroup.com'), /no job listing at https:\/\/jobs\.bmwgroup\.com/);
  });
  const paths = calls.map((u) => new URL(u).pathname);
  assert.ok(paths.includes('/careers/SearchJobs/feed/'), 'the RSS feed was tried');
  assert.ok(paths.includes('/tile-search-results/'), 'the tile search was tried');
  assert.ok(paths.includes('/services/recruiting/v1/jobs'), 'the CSB search was tried');
  assert.ok(paths.includes('/sitemap.xml'), 'the sitemap was tried');
  assert.ok(paths.indexOf('/tile-search-results/') < paths.indexOf('/services/recruiting/v1/jobs') && paths.indexOf('/services/recruiting/v1/jobs') < paths.indexOf('/sitemap.xml'), 'in that order');
  assert.equal(paths.filter((p) => p === '/tile-search-results/').length, 1, 'no paging past an empty page');
});

test('successfactors: the sitemap lists the job pages when feed, tiles and CSB search give nothing', async () => {
  const sitemap = text('successfactors-sitemap.xml');
  const page = text('successfactors-job.html');   // stands in for each job page
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(locs.length, 3);
  let jobs;
  const calls = await withFetch((u) => (u.endsWith('/sitemap.xml') ? sitemap : /\/job\//.test(u) ? page : EMPTY_TILES), async () => {
    jobs = await providers.successfactors.fetch('jobs.bmwgroup.com');
  });
  assert.equal(calls.filter((u) => u.endsWith('/sitemap.xml')).length, 1);
  assert.equal(calls.filter((u) => /\/job\//.test(u)).length, 3, 'one fetch per listed job page');
  assert.deepEqual(jobs.map((j) => j.url), locs, 'the sitemap order');
  for (const j of jobs) {
    assert.equal(j.title, 'Systemingenieur für TRx-4D Radare mit Schwerpunkt Obsoleszenz Bearbeitung (w/m/d)');
    assert.equal(j.location, 'Ulm, DE, 89077');
    assert.equal(j.postedAt, '2026-11-01');
    assert.ok(j.description.startsWith('Über den Bereich'), j.description.slice(0, 60));
  }
});
