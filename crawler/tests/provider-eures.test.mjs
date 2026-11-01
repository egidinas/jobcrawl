// EURES provider (crawler/providers-eures.mjs) on trimmed captured documents (crawler/tests/fixtures/eures-*.json, 2026-11-01):
// detect both ways, the vacancy -> job mapping, the search body, and the paging logic on a stubbed fetch. No network.
// Run: node --test crawler/tests/provider-eures.test.mjs
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providers, resolve } from '../providers.mjs';
import { AGGREGATOR_PROVIDERS, isAggregatorRow } from '../crosslist.mjs';
import { eures, euresJob, euresText, euresPlace, detectEures, parseSlug, euresBoardUrl, searchBody, tuning, EURES_PAGE_SIZE, EURES_COUNTRIES } from '../providers-eures.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const SEARCH = 'https://europa.eu/eures/api/jv-searchengine/public/jv-search/search';
const LABELS = 'https://europa.eu/eures/api/shared-data-rest-api/public/esco/label/en';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

tuning.pageDelayMs = 0;
tuning.retryDelayMs = 0;

test('eures: registered in the provider registry, as an aggregator, without a fetchDescription', () => {
  assert.equal(providers.eures, eures);
  assert.equal(typeof eures.detect, 'function');
  assert.equal(typeof eures.fetch, 'function');
  assert.equal(eures.fetchDescription, undefined, 'the search response carries the whole description');
  assert.equal(Object.keys(EURES_COUNTRIES).length, 31);
  assert.ok(AGGREGATOR_PROVIDERS.has('eures'), 'an EURES copy of an employer\'s own posting is a cross-listing');
  assert.equal(isAggregatorRow({ company: 'SimpleXX GmbH (via EURES)' }, new Set()), true);
  assert.equal(isAggregatorRow({ company: 'undisclosed (via EURES)' }, new Set()), true);
});

test('eures: detect reads the portal search URL (its own parameters and the short form), nothing else', () => {
  const d = detectEures;
  assert.equal(d('https://europa.eu/eures/portal/jv-se/search?page=1&resultsPerPage=10&orderBy=MOST_RECENT&keywordsEverywhere=satellite&locationCodes=de&locationCodes=fr&lang=en'), 'satellite|de,fr');
  assert.equal(d('https://europa.eu/eures/portal/jv-se/search?keywordsEverywhere=satellite&locationCodes=DE,fr&lang=en'), 'satellite|de,fr', 'comma-joined and uppercase codes');
  assert.equal(d('https://europa.eu/eures/portal/jv-se/search?keyword=satellite&location=de'), 'satellite|de', 'the short form');
  assert.equal(d('https://www.europa.eu/eures/portal/jv-se/search?keyword=optical%20engineer&location=de,at,ch'), 'optical engineer|de,at,ch');
  assert.equal(d('https://europa.eu/eures/portal/jv-se/search?keywordsEverywhere=satellite&lang=en'), 'satellite|', 'keyword alone: every country');
  assert.equal(d('https://europa.eu/eures/portal/jv-se/search?locationCodes=LU&locationCodes=de1&locationCodes=at-ns'), '|lu,de1,at-NS', 'countries, NUTS regions and the -NS suffix as the backend spells them');
  assert.equal(d('https://europa.eu/eures/portal/jv-se/search?lang=en'), null, 'an unfiltered search is not a board');
  assert.equal(d('https://europa.eu/eures/portal/jv-se/search?locationCodes=germany'), null, 'not a code');
  assert.equal(d('https://europa.eu/eures/portal/jv-se/jv-details/MTAwMDEtMTAwMzk0Mjk0Ny1TIDE?lang=en'), null, 'a vacancy page');
  assert.equal(d('https://europa.eu/eures/portal/jv-se/home?lang=en'), null);
  assert.equal(d('https://eures.europa.eu/index_en'), null);
  assert.equal(d('https://boards.greenhouse.io/spacex'), null);
  assert.equal(d('not a url'), null);
  assert.equal(eures.detect, detectEures);
});

test('eures: slug <-> URL round trip and parseSlug', () => {
  assert.deepEqual(parseSlug('satellite|de,fr'), { keyword: 'satellite', codes: ['de', 'fr'] });
  assert.deepEqual(parseSlug('satellite|'), { keyword: 'satellite', codes: [] });
  assert.deepEqual(parseSlug('satellite'), { keyword: 'satellite', codes: [] });
  assert.deepEqual(parseSlug('|lu, DE1 ,lu,xx-ns,germany,1de'), { keyword: '', codes: ['lu', 'de1', 'xx-NS'] }, 'names and malformed codes dropped');
  for (const slug of ['satellite|de,fr', 'optical engineer|', '|lu', 'laser & optics|de,at-NS']) {
    const url = euresBoardUrl(slug);
    assert.ok(url.startsWith('https://europa.eu/eures/portal/jv-se/search?'), url);
    assert.equal(detectEures(url), slug);
  }
  assert.equal(new URL(euresBoardUrl('satellite|de,fr')).searchParams.getAll('locationCodes').join(','), 'de,fr');
});

test('eures: resolve() picks the provider from a portal search URL or an explicit slug', () => {
  assert.deepEqual(resolve({ careers_url: 'https://europa.eu/eures/portal/jv-se/search?keywordsEverywhere=satellite&locationCodes=de&lang=en' }), { provider: 'eures', slug: 'satellite|de' });
  assert.deepEqual(resolve({ provider: 'eures', slug: 'satellite|de,fr' }), { provider: 'eures', slug: 'satellite|de,fr' });
});

test('eures: a captured search response maps to jobs with the whole description and the board metadata', () => {
  const d = fixture('eures-search.json');
  assert.equal(d.numberRecords, 754);
  assert.equal(d.jvs.length, 3);
  const jobs = d.jvs.map((v) => euresJob(v));
  const [j] = jobs;
  assert.equal(j.id, 'MTAwMDEtMTAwMzk0Mjk0Ny1TIDE');
  assert.equal(Buffer.from(j.id, 'base64').toString(), '10001-1003942947-S 1', 'the id is base64 of "<documentId> <connectionPointId>"');
  assert.equal(j.title, 'AIT-Mechaniker - Integration Satelliten und Mechanismen (m/w/d) für AIRBUS Defence and Space (Anlagenmechaniker/in)');
  assert.equal(j.url, 'https://europa.eu/eures/portal/jv-se/jv-details/MTAwMDEtMTAwMzk0Mjk0Ny1TIDE?lang=en');
  assert.equal(j.company, 'SimpleXX GmbH (via EURES)', 'the aggregator suffix, as spacecapital and jobsinphotonics add it');
  assert.equal(j.location, 'Germany (DE147)');
  assert.equal(j.postedAt, '2026-10-30T23:08:14.685Z', 'creationDate (epoch ms) as ISO');
  assert.ok(j.description.startsWith('Weitere Berufsbezeichnung:'), j.description.slice(0, 40));
  assert.ok(j.description.length > 4000, `the whole posting (${j.description.length} chars)`);
  assert.match(j.description, /Equal Pay & Equal Treatment/, 'entities decoded');
  assert.doesNotMatch(j.description, /<\/?[a-z]+[^>]*>|&amp;/, 'no HTML or entity left');
  assert.deepEqual(j.meta, {
    nuts: 'DE147',
    contract: 'directhire',
    schedule: 'fulltime',
    categories: [
      'http://data.europa.eu/esco/occupation/2ff73126-7aff-4233-9d9c-d8725e1c6822',
      'http://data.europa.eu/esco/occupation/2d6d4cb2-5d46-4d1f-939b-7f55c02c64cb',
      'http://data.europa.eu/esco/occupation/5ed024ab-3b6a-4e06-a7fe-8a29f8469a64',
      'http://data.europa.eu/esco/occupation/1a1ea837-0103-4230-8756-533a77c5f9f4',
    ],
    number_of_posts: '1',
    languages: 'de',
    last_modified: '2026-10-31T22:53:10.459Z',
    employer_site: 'http://www.go-simplexx.de',
    source: 'EURES (ELA)',
  });
  for (const x of jobs) {
    assert.equal(x.company, 'SimpleXX GmbH (via EURES)');
    assert.equal(isAggregatorRow(x, new Set()), true);
    assert.equal(x.meta.source, 'EURES (ELA)');
    assert.equal(x.url, `https://europa.eu/eures/portal/jv-se/jv-details/${x.id}?lang=en`);
    assert.ok(!('eures_flag' in x.meta), 'euresFlag false is dropped');
  }
  assert.equal(new Set(jobs.map((x) => x.id)).size, 3);

  // ESCO labels, when the label call answered, replace the URIs
  const labels = { 'http://data.europa.eu/esco/occupation/2ff73126-7aff-4233-9d9c-d8725e1c6822': 'Pipe welder', 'http://data.europa.eu/esco/occupation/5ed024ab-3b6a-4e06-a7fe-8a29f8469a64': 'Boilermaker' };
  assert.deepEqual(euresJob(d.jvs[0], labels).meta.categories, ['Pipe welder', 'http://data.europa.eu/esco/occupation/2d6d4cb2-5d46-4d1f-939b-7f55c02c64cb', 'Boilermaker', 'http://data.europa.eu/esco/occupation/1a1ea837-0103-4230-8756-533a77c5f9f4']);
  assert.equal(d.jvs[1].jobCategoriesCodes.length, 1);
  assert.equal(euresJob(d.jvs[1], labels).meta.categories, d.jvs[1].jobCategoriesCodes[0], 'one category: a string, as metaOf does');

  // the facets name the code lists the backend filters on
  assert.deepEqual(d.facets.POSITION_SCHEDULE.facetEntriesList.map((e) => e.code).sort(), ['NS', 'flextime', 'fulltime', 'parttime']);
  assert.ok(d.facets.POSITION_OFFERING.facetEntriesList.some((e) => e.code === 'directhire' && e.count === 608));
});

test('eures: a French vacancy (temporary, no schedule) and the edge cases of the mapping', () => {
  const fr = fixture('eures-search-fr.json');
  assert.equal(fr.numberRecords, 1510, 'de + fr');
  const j = euresJob(fr.jvs[0]);
  assert.equal(j.id, 'ODQ1ODk4MyA5');
  assert.equal(j.company, 'METIER INTERIM ET CDI CHALLANS (via EURES)');
  assert.equal(j.location, 'France (FRG05)');
  assert.equal(j.postedAt, '2026-11-01T12:32:26.000Z');
  assert.equal(j.meta.contract, 'temporary');
  assert.ok(!('schedule' in j.meta), 'positionScheduleCodes [] is dropped');
  assert.equal(j.meta.languages, 'fr');
  assert.equal(j.meta.nuts, 'FRG05');
  assert.ok(!('employer_site' in j.meta));
  assert.ok(j.description.startsWith('METIER INTERIM CHALLANS recrute'));

  const bare = euresJob({ id: 'x', title: ' <b>Dev</b> ', description: '<p>Hi &amp; bye</p><ul><li>one</li><li>two</li></ul>', creationDate: 0, locationMap: {}, positionOfferingCode: 'NS', positionScheduleCodes: ['NS'], jobCategoriesCodes: [], availableLanguages: [], euresFlag: true, numberOfPosts: 3 });
  assert.equal(bare.title, 'Dev');
  assert.equal(bare.company, 'undisclosed (via EURES)', 'no employer: still an aggregator row');
  assert.equal(bare.location, '');
  assert.equal(bare.postedAt, '');
  assert.equal(bare.description, 'Hi & bye\n- one\n- two');
  assert.deepEqual(bare.meta, { number_of_posts: '3', eures_flag: true, source: 'EURES (ELA)' }, 'NS codes are "not specified" and dropped');
  assert.equal(euresJob({ id: 'y', employer: { name: '  ' } }).company, 'undisclosed (via EURES)');
  assert.equal(euresJob({ id: 'y' }).meta.source, 'EURES (ELA)', 'a vacancy with nothing else still carries the attribution');

  // locations: several countries and regions, a country without a region, the -NS marker
  const multi = euresJob({ id: 'z', locationMap: { DE: ['DE147', 'DE21H'], FR: [null], LU: ['LU-NS'], EL: ['EL30'] } });
  assert.equal(multi.location, 'Germany (DE147) | Germany (DE21H) | France | Luxembourg | Greece (EL30)');
  assert.deepEqual(multi.meta.nuts, ['DE147', 'DE21H', 'FR', 'LU-NS', 'EL30']);
  assert.equal(euresPlace('de', 'de147'), 'Germany (DE147)');
  assert.equal(euresPlace('DE', 'DE'), 'Germany');
  assert.equal(euresPlace('XX', 'XX1'), 'XX (XX1)', 'an unknown country keeps its code');
});

test('eures: the detail document has the same description as the search response, plus the city', () => {
  const d = fixture('eures-detail.json');
  const s = fixture('eures-search.json').jvs[0];
  assert.equal(d.id, s.id);
  assert.deepEqual(Object.keys(d.jvProfiles), ['de']);
  const p = d.jvProfiles.de;
  assert.equal(p.description, s.description, 'byte-identical: a detail call would add nothing to the text');
  assert.equal(p.title, s.title);
  assert.equal(p.employer.name, s.employer.name);
  assert.deepEqual(p.locations.map((l) => [l.countryCode, l.region, l.cityName, l.postalCode]), [['de', 'de147', 'Immenstaad am Bodensee', '88090']]);
  assert.equal(d.source, 'DE001');
  assert.equal(d.connectionPointId, 1);
  assert.deepEqual(p.personContacts, [], 'the fixture drops the recruiter contact');
  assert.equal(euresText(p.description), euresJob(s).description);
});

test('eures: searchBody is the portal request with 50 per page at most, newest first', () => {
  const b = searchBody({ keyword: 'satellite', codes: ['de', 'fr'], page: 3 });
  assert.equal(b.resultsPerPage, 50);
  assert.equal(EURES_PAGE_SIZE, 50);
  assert.equal(b.page, 3);
  assert.equal(b.sortSearch, 'MOST_RECENT');
  assert.deepEqual(b.keywords, [{ keyword: 'satellite', specificSearchCode: 'EVERYWHERE' }]);
  assert.deepEqual(b.locationCodes, ['de', 'fr']);
  assert.equal(b.requestLanguage, 'en');
  assert.equal(b.publicationPeriod, null);
  for (const k of ['occupationUris', 'skillUris', 'requiredExperienceCodes', 'positionScheduleCodes', 'sectorCodes', 'educationAndQualificationLevelCodes', 'positionOfferingCodes', 'euresFlagCodes', 'otherBenefitsCodes', 'requiredLanguages']) assert.deepEqual(b[k], [], k);
  assert.deepEqual(searchBody({ codes: ['lu'] }).keywords, [], 'no keyword: an empty list');
  assert.equal(searchBody({ size: 100 }).resultsPerPage, 50, 'clamped: 100 answers HTTP 400');
  const x = searchBody({ keyword: 'x', extra: { publicationPeriod: 'LAST_WEEK', positionOfferingCodes: ['directhire'], resultsPerPage: 500, sortSearch: 'BEST_MATCH', bogus: 1 } });
  assert.equal(x.publicationPeriod, 'LAST_WEEK');
  assert.deepEqual(x.positionOfferingCodes, ['directhire']);
  assert.equal(x.resultsPerPage, 50, 'entry.eures cannot raise the page size');
  assert.equal(x.sortSearch, 'MOST_RECENT', 'nor change the sort');
  assert.ok(!('bogus' in x));
});

/** A stubbed backend: `total` vacancies derived from the fixture, served 50 per page; the label endpoint answers `labels`. */
function stubBackend(total, { labels = {}, labelStatus = 200, repeatPage = null } = {}) {
  const base = fixture('eures-search.json').jvs;
  const all = Array.from({ length: total }, (_, i) => ({ ...base[i % base.length], id: `id-${i + 1}`, title: `Role ${i + 1}` }));
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: init.method ?? 'GET', body, ua: init.headers?.['user-agent'] });
    if (String(url) === LABELS) return labelStatus === 200 ? json(labels) : json({ errorType: 'SERVICE_UNAVAILABLE' }, labelStatus);
    if (String(url) !== SEARCH) return json({ errorType: 'NOT_FOUND' }, 404);
    if (body.resultsPerPage > 50) return json({ errorType: 'java.lang.IllegalArgumentException', errorMessage: 'Too many results per page were requested' }, 400);
    const page = repeatPage ?? body.page;
    return json({ numberRecords: total, jvs: all.slice((page - 1) * body.resultsPerPage, page * body.resultsPerPage), facets: {} });
  });
  return calls;
}

test('eures: fetch pages 50 at a time until the results run out, resolving ESCO labels per page', async (t) => {
  t.after(() => mock.restoreAll());
  const calls = stubBackend(120, { labels: { 'http://data.europa.eu/esco/occupation/2ff73126-7aff-4233-9d9c-d8725e1c6822': 'Pipe welder' } });
  const jobs = await eures.fetch('satellite|de,fr');
  assert.equal(jobs.length, 120);
  assert.equal(new Set(jobs.map((j) => j.id)).size, 120, 'no duplicates');
  assert.equal(jobs[0].title, 'Role 1');
  assert.equal(jobs.at(-1).title, 'Role 120');
  const searches = calls.filter((c) => c.url === SEARCH);
  assert.deepEqual(searches.map((c) => c.body.page), [1, 2, 3], 'three pages: 50 + 50 + 20');
  for (const c of searches) {
    assert.equal(c.method, 'POST');
    assert.equal(c.body.resultsPerPage, 50);
    assert.equal(c.body.sortSearch, 'MOST_RECENT');
    assert.deepEqual(c.body.keywords, [{ keyword: 'satellite', specificSearchCode: 'EVERYWHERE' }]);
    assert.deepEqual(c.body.locationCodes, ['de', 'fr']);
    assert.match(c.ua ?? '', /jobcrawl/, 'identifies itself');
  }
  const labelCalls = calls.filter((c) => c.url === LABELS);
  assert.equal(labelCalls.length, 3, 'one label call per page');
  assert.ok(labelCalls[0].body.every((u) => u.startsWith('http://data.europa.eu/esco/')));
  assert.equal(new Set(labelCalls[0].body).size, labelCalls[0].body.length, 'URIs deduplicated');
  assert.ok(jobs[0].meta.categories.includes('Pipe welder'), 'labels applied');
  assert.equal(jobs[0].company, 'SimpleXX GmbH (via EURES)');
  assert.equal(jobs[0].meta.source, 'EURES (ELA)');
});

test('eures: fetch stops at the cap, at a page the backend repeats, and refuses an unfiltered slug', async (t) => {
  t.after(() => mock.restoreAll());
  let calls = stubBackend(500);
  let jobs = await eures.fetch('satellite|de', { max_jobs: 120 });
  assert.equal(jobs.length, 120, 'entry.max_jobs');
  assert.deepEqual(calls.filter((c) => c.url === SEARCH).map((c) => c.body.page), [1, 2, 3]);
  mock.restoreAll();

  calls = stubBackend(5000);
  jobs = await eures.fetch('satellite|');
  assert.equal(jobs.length, 2000, 'the hard cap');
  assert.equal(calls.filter((c) => c.url === SEARCH).length, 40);
  assert.deepEqual(calls.filter((c) => c.url === SEARCH)[0].body.locationCodes, [], 'keyword alone: no location filter');
  mock.restoreAll();

  calls = stubBackend(500, { repeatPage: 1 });   // a backend that ignores `page`
  jobs = await eures.fetch('satellite|de');
  assert.equal(jobs.length, 50, 'the repeated page adds nothing and paging stops');
  assert.equal(calls.filter((c) => c.url === SEARCH).length, 2);
  mock.restoreAll();

  calls = stubBackend(30, { labelStatus: 503 });
  jobs = await eures.fetch('|lu');
  assert.equal(jobs.length, 30, 'a short first page ends the crawl');
  assert.equal(calls.filter((c) => c.url === SEARCH).length, 1);
  assert.ok(jobs[0].meta.categories.toString().startsWith('http://data.europa.eu/esco/'), 'label call failed: URIs stay');
  mock.restoreAll();

  await assert.rejects(eures.fetch('|'), /refusing an unfiltered search/);
  await assert.rejects(eures.fetch(''), /refusing an unfiltered search/);
});

test('eures: fetch surfaces a 400 with the backend message and an unexpected document', async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(globalThis, 'fetch', async () => json({ errorType: 'java.lang.IllegalArgumentException', errorMessage: 'Too many results per page were requested' }, 400));
  await assert.rejects(eures.fetch('satellite|de'), /HTTP 400 eures .*Too many results per page/);
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => json({ hello: 'world' }));
  await assert.rejects(eures.fetch('satellite|de'), /unexpected search response \(keys: hello\)/);
});
