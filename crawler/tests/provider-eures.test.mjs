// EURES provider (crawler/providers-eures.mjs) on trimmed captured documents (crawler/tests/fixtures/eures-*.json, 2026-11-01):
// detect both ways, the vacancy -> job mapping, the search body, the paging logic on a stubbed fetch, and the detail document's
// "Application and contact" section (fetchDescription). The recruiter contacts tested are SYNTHETIC: the captured fixture dropped
// the real personContacts, the tests put an obviously fake entry ("Erika Mustermann", example.invalid) into a copy. No network.
// Run: node --test crawler/tests/provider-eures.test.mjs
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providers, resolve } from '../providers.mjs';
import { AGGREGATOR_PROVIDERS, isAggregatorRow } from '../crosslist.mjs';
import { eures, euresJob, euresText, euresPlace, detectEures, parseSlug, euresBoardUrl, searchBody, tuning, EURES_PAGE_SIZE, EURES_COUNTRIES,
  euresIdOf, euresProfile, euresContactLine, euresDetailSection, euresEmployerMatches, SLUG_PREFIX } from '../providers-eures.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const SEARCH = 'https://europa.eu/eures/api/jv-searchengine/public/jv-search/search';
const LABELS = 'https://europa.eu/eures/api/shared-data-rest-api/public/esco/label/en';
const DETAIL = 'https://europa.eu/eures/api/jv-searchengine/public/jv/id';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
/** The detail fixture with a synthetic recruiter contact (the capture dropped the real one; this is obviously fake data). */
const detailWithContact = (contacts = [{ name: 'Erika Mustermann', title: 'Recruiting', email: 'recruiting@example.invalid', phone: '+49 89 0000000', address: null }]) => {
  const d = structuredClone(fixture('eures-detail.json'));
  d.jvProfiles.de.personContacts = contacts;
  return d;
};

tuning.minGapMs = 0;   // the host-wide limiter's gap (eures-rate-limit.test.mjs exercises it); here the paging logic alone
tuning.retryDelayMs = 0;
tuning.retry429Ms = 0;

test('eures: registered in the provider registry, as an aggregator, with a fetchDescription for the detail document', () => {
  assert.equal(providers.eures, eures);
  assert.equal(typeof eures.detect, 'function');
  assert.equal(typeof eures.fetch, 'function');
  assert.equal(typeof eures.fetchDescription, 'function', 'the detail document adds the application and contact section');
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
  assert.deepEqual(parseSlug('satellite|de,fr'), { keyword: 'satellite', codes: ['de', 'fr'], mode: 'EVERYWHERE' });
  assert.deepEqual(parseSlug('satellite|'), { keyword: 'satellite', codes: [], mode: 'EVERYWHERE' });
  assert.deepEqual(parseSlug('satellite'), { keyword: 'satellite', codes: [], mode: 'EVERYWHERE' });
  assert.deepEqual(parseSlug('|lu, DE1 ,lu,xx-ns,germany,1de'), { keyword: '', codes: ['lu', 'de1', 'xx-NS'], mode: 'EVERYWHERE' }, 'names and malformed codes dropped');
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
  assert.equal(euresProfile(d), p, 'the preferred language\'s profile');
  assert.equal(euresProfile({ jvProfiles: { fr: { title: 'a' }, en: { title: 'b' } }, preferredLanguage: 'de' }).title, 'a', 'else the first');
  assert.equal(euresProfile({}), null);
  assert.equal(euresIdOf(euresJob(s)), s.id, 'the vacancy id from the job URL');
  assert.equal(euresIdOf({ url: 'https://europa.eu/eures/portal/jv-se/jv-details/a%2Fb%2Bc?lang=en', id: 'other' }), 'a/b+c', 'the URL wins, percent-decoded');
  assert.equal(euresIdOf({ id: ' ODQ1ODk4MyA5 ' }), 'ODQ1ODk4MyA5', 'else job.id');
  assert.equal(euresIdOf({}), '');
});

test('eures: the detail document yields the "Application and contact" section; a synthetic recruiter contact is read whatever its shape', () => {
  const d = fixture('eures-detail.json');
  const s = euresDetailSection(d);
  assert.ok(s.startsWith('Application and contact\nGewünschte Bewerbungsarten: per E-Mail, über Internet\n'), s.slice(0, 80));
  assert.match(s, /\nInternetadresse: https:\/\/www\.go-simplexx\.de\/special-pages\/jobboerse-apply\/\?tx_dmmjobcontrol_pi1%5Bjob_uid%5D=8760\n/);
  assert.match(s, /Angaben zur Bewerbung: Bitte über den oberen Link zur "Internetadresse\/Internetseite" oder per E-Mail inkl\. Bewerbungsunterlagen/);
  assert.match(s, /aufrufen: 10001-1003942947-S \(https:\/\/www\.arbeitsagentur\.de\/jobsuche\/jobdetail\/10001-1003942947-S\)\n/, 'the link of the <a> is kept');
  assert.doesNotMatch(s, /Contact:/, 'the captured fixture has no recruiter contact');
  assert.doesNotMatch(s, /Application deadline/, 'none in the capture');
  assert.match(s, /\nEmployment period: from 2026-10-30, Das Stellenangebot ist unbefristet\n/, 'startDate (epoch ms) as a day, plus the free text');
  assert.match(s, /\nEmployer web site: http:\/\/www\.go-simplexx\.de\n/);
  assert.match(s, /\nNACE: o78\.2\.0\n/);
  assert.ok(s.endsWith('\nLocation: 88090 Immenstaad am Bodensee, Germany (DE147)'), s.slice(-80));
  assert.doesNotMatch(s, /<\/?[a-z]+[^>]*>|&amp;/, 'no HTML or entity left');

  // SYNTHETIC contacts (not captured data): a flat entry and a nested one, two shapes a feed might use; every string leaf is kept
  const two = euresDetailSection(detailWithContact([
    { name: 'Erika Mustermann', title: 'Recruiting', email: 'recruiting@example.invalid', phone: '+49 89 0000000', address: null },
    { givenName: 'Max', familyName: 'Mustermann', positionTitle: 'HR Business Partner', communication: { emailAddress: 'max.mustermann@example.invalid', telephoneNumber: '+49 89 0000001', fax: '' },
      address: { street: 'Musterstr. 1', postalCode: '80000', city: 'München' }, remarks: 'Mo-Fr 9-17', primary: true },
  ]));
  assert.match(two, /\nContact: Erika Mustermann, Recruiting, recruiting@example\.invalid, \+49 89 0000000\nContact: Max Mustermann, HR Business Partner, max\.mustermann@example\.invalid, \+49 89 0000001, Musterstr\. 1 80000 München, remarks: Mo-Fr 9-17\nEmployment period:/);
  assert.equal(euresContactLine({ email: 'a@example.invalid' }), 'a@example.invalid');
  assert.equal(euresContactLine({ contact: 'a@example.invalid', organisationName: 'Example GmbH', mobile: ' +49 170 0000000 ' }), 'a@example.invalid, +49 170 0000000, organisationName: Example GmbH', 'an e-mail is recognised by its value; an unknown key keeps its name');
  assert.equal(euresContactLine('Erika Mustermann, recruiting@example.invalid'), 'Erika Mustermann, recruiting@example.invalid', 'a bare string stays as it is');
  assert.equal(euresContactLine({ name: '<b>Erika &amp; Max</b>' }), 'Erika & Max', 'markup in a value is removed as everywhere');
  assert.equal(euresContactLine({}), '');
  assert.equal(euresContactLine(null), '');
  assert.equal(euresContactLine([]), '');

  // the other fields: deadline (epoch ms or text), period texts, several locations, nothing at all
  const p = { description: 'x', lastApplicationDate: 1797638400000, employmentPeriod: { startDateText: 'asap', endDate: 1800000000000, periodDescription: '' },
    employer: { website: '', sectorCodes: ['c30.3.0', 'm72.1.9'] }, locations: [{ countryCode: 'fr', region: 'frg05' }, { countryCode: 'de', cityName: 'Bremen', postalCode: '' }, { countryCode: 'de', cityName: 'Bremen' }] };
  assert.equal(euresDetailSection({ jvProfiles: { en: p } }), 'Application and contact\nApplication deadline: 2026-12-19\nEmployment period: from asap, until 2027-01-15\nNACE: c30.3.0, m72.1.9\nLocation: France (FRG05) | Bremen, Germany');
  assert.equal(euresDetailSection({ jvProfiles: { en: { ...p, lastApplicationDate: '2026-12-31' } } }).split('\n')[1], 'Application deadline: 2026-12-31', 'a textual date is kept');
  assert.equal(euresDetailSection({ jvProfiles: { en: { description: 'x', applicationInstructions: [], personContacts: [], employmentPeriod: null, employer: {}, locations: [] } } }), '', 'a profile without any of it: no section');
  assert.equal(euresDetailSection({}), '');
  assert.equal(euresDetailSection(null), '');
});

test('eures: fetchDescription GETs the detail document and appends the section; the plain description alone when the call fails', async (t) => {
  t.after(() => mock.restoreAll());
  const detail = detailWithContact([{ name: 'Erika Mustermann', email: 'recruiting@example.invalid', phone: '+49 89 0000000' }]);
  const job = euresJob(fixture('eures-search.json').jvs[0]);
  const calls = [];
  let status = 200;
  mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body, ua: init.headers?.['user-agent'] ?? '', accept: init.headers?.accept });
    return status === 200 ? json(detail) : json({ errorType: status === 404 ? 'NOT_FOUND' : 'SERVICE_UNAVAILABLE', errorMessage: 'Unexpected error' }, status);
  });
  const text = await eures.fetchDescription(job);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${DETAIL}/MTAwMDEtMTAwMzk0Mjk0Ny1TIDE?requestLang=en`, 'the documented detail endpoint, the id from the job URL');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[0].accept, 'application/json');
  assert.match(calls[0].ua, /jobcrawl/, 'the same polite user agent as the search');
  assert.ok(text.startsWith(job.description), 'the description first, unchanged');
  assert.equal(text.slice(job.description.length, job.description.length + 25), '\n\nApplication and contact');
  assert.match(text, /\nGewünschte Bewerbungsarten: per E-Mail, über Internet\n/);
  assert.match(text, /\nContact: Erika Mustermann, recruiting@example\.invalid, \+49 89 0000000\n/);
  assert.ok(text.endsWith('\nLocation: 88090 Immenstaad am Bodensee, Germany (DE147)'), text.slice(-80));
  assert.doesNotMatch(text, /<\/?[a-z]+[^>]*>|&amp;/, 'no HTML or entity left');

  // the id from job.id when the job has no portal URL; a job with neither gets its description back without a request
  calls.length = 0;
  await eures.fetchDescription({ id: 'ODQ1ODk4MyA5', description: 'x' });
  assert.equal(calls[0].url, `${DETAIL}/ODQ1ODk4MyA5?requestLang=en`);
  calls.length = 0;
  assert.equal(await eures.fetchDescription({ description: 'x' }), 'x');
  assert.equal(calls.length, 0);

  // the backfill passes { url, title, company } without a description: the detail document's own (byte-identical) description is used
  const backfilled = await eures.fetchDescription({ url: job.url, title: job.title, company: job.company });
  assert.equal(backfilled, text);

  // a failing detail call: the plain description alone, nothing thrown (a 404 at once; a 5xx after the one retry)
  status = 404; calls.length = 0;
  assert.equal(await eures.fetchDescription(job), job.description);
  assert.equal(calls.length, 1);
  status = 503; calls.length = 0;
  assert.equal(await eures.fetchDescription(job), job.description);
  assert.equal(calls.length, 2, 'a 5xx is retried once, as the search is');
  assert.equal(await eures.fetchDescription({ url: job.url, title: job.title, company: job.company }), '', 'no description to fall back on: empty, which the callers count as the failure');
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => json({ hello: 'world' }));
  assert.equal(await eures.fetchDescription(job), job.description, 'a document without profiles adds nothing');
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

test('eures: employer and legal-id modes: slug <-> URL both ways, the search body, the employer-name match', () => {
  assert.deepEqual(parseSlug('employer:OHB System|de'), { keyword: 'OHB System', codes: ['de'], mode: 'EMPLOYER' });
  assert.deepEqual(parseSlug('Employer: OHB |de,at'), { keyword: 'OHB', codes: ['de', 'at'], mode: 'EMPLOYER' }, 'prefix case and spaces do not matter');
  assert.deepEqual(parseSlug('legalid:HRB 12345|'), { keyword: 'HRB 12345', codes: [], mode: 'LEGAL_ID' });
  assert.deepEqual(parseSlug('legal_id:X|de'), { keyword: 'X', codes: ['de'], mode: 'LEGAL_ID' });
  assert.deepEqual(parseSlug('employer:|de'), { keyword: '', codes: ['de'], mode: 'EMPLOYER' });
  assert.deepEqual(SLUG_PREFIX, { EVERYWHERE: '', EMPLOYER: 'employer:', LEGAL_ID: 'legalid:' });

  const d = detectEures;
  assert.equal(d('https://europa.eu/eures/portal/jv-se/search?page=1&resultsPerPage=10&orderBy=BEST_MATCH&keywordsEmployer=OHB%20System&locationCodes=de&lang=en'), 'employer:OHB System|de');
  assert.equal(d('https://europa.eu/eures/portal/jv-se/search?employer=OHB&location=de,at'), 'employer:OHB|de,at', 'the short form');
  assert.equal(d('https://europa.eu/eures/portal/jv-se/search?employer=Airbus'), 'employer:Airbus|', 'no location: every country');
  assert.equal(d('https://europa.eu/eures/portal/jv-se/search?keywordsLegalId=DE123456789&locationCodes=de'), 'legalid:DE123456789|de');
  assert.equal(d('https://europa.eu/eures/portal/jv-se/search?legalId=DE1'), 'legalid:DE1|');
  assert.equal(d('https://europa.eu/eures/portal/jv-se/search?keywordsEverywhere=satellite&keywordsEmployer=OHB&locationCodes=de'), 'employer:OHB|de', 'one keyword per board: the employer wins');
  assert.equal(d('https://europa.eu/eures/portal/jv-se/search?employer=&lang=en'), null, 'an empty employer is no board');
  assert.equal(d('https://europa.eu/eures/portal/jv-se/search?keywordsEverywhere=satellite&locationCodes=de'), 'satellite|de', 'keyword mode as before');
  for (const slug of ['employer:OHB System|de', 'employer:Rohde & Schwarz|de,at,ch', 'employer:Airbus|', 'legalid:DE123|', 'legalid:HRB 1|lu', 'satellite|de,fr']) {
    const url = euresBoardUrl(slug);
    assert.ok(url.startsWith('https://europa.eu/eures/portal/jv-se/search?'), url);
    assert.equal(detectEures(url), slug, url);
  }
  const eu = new URL(euresBoardUrl('employer:OHB System|de'));
  assert.equal(eu.searchParams.get('keywordsEmployer'), 'OHB System');
  assert.equal(eu.searchParams.get('keywordsEverywhere'), null);
  assert.equal(eu.searchParams.get('orderBy'), 'BEST_MATCH');
  assert.equal(new URL(euresBoardUrl('legalid:DE123|')).searchParams.get('keywordsLegalId'), 'DE123');
  assert.equal(new URL(euresBoardUrl('satellite|de')).searchParams.get('orderBy'), 'MOST_RECENT', 'keyword mode unchanged');
  assert.deepEqual(resolve({ careers_url: euresBoardUrl('employer:OHB|de') }), { provider: 'eures', slug: 'employer:OHB|de' });

  const b = searchBody({ keyword: 'OHB', codes: ['de'], mode: 'EMPLOYER' });
  assert.deepEqual(b.keywords, [{ keyword: 'OHB', specificSearchCode: 'EMPLOYER' }]);
  assert.equal(b.sortSearch, 'BEST_MATCH', 'the exact employer first, the fuzzy matches after (probe 2026-11-01)');
  assert.equal(b.resultsPerPage, 50);
  assert.deepEqual(b.locationCodes, ['de']);
  assert.deepEqual(searchBody({ keyword: 'DE123', mode: 'LEGAL_ID' }).keywords, [{ keyword: 'DE123', specificSearchCode: 'LEGAL_ID' }]);
  assert.equal(searchBody({ keyword: 'DE123', mode: 'LEGAL_ID' }).sortSearch, 'BEST_MATCH');
  assert.equal(searchBody({ keyword: 'x', mode: 'bogus' }).keywords[0].specificSearchCode, 'EVERYWHERE', 'an unknown code falls back');
  assert.equal(searchBody({ keyword: 'x', mode: 'toString' }).keywords[0].specificSearchCode, 'EVERYWHERE');
  assert.equal(searchBody({ keyword: 'x' }).sortSearch, 'MOST_RECENT', 'keyword mode: newest first, as before');

  const m = euresEmployerMatches;
  assert.equal(m('OHB', 'OHB-System AG'), true);
  assert.equal(m('OHB', 'OHB'), true);
  assert.equal(m('OHB', 'OHB Digital Connect GmbH'), true);
  assert.equal(m('OHB System', 'OHB-System AG'), true, 'hyphen = space');
  assert.equal(m('OHB System', 'OHB System AG'), true);
  assert.equal(m('OHB System', 'OHB Digital Connect GmbH'), false, 'the words must be adjacent and in order');
  assert.equal(m('OHB', 'K2Trans OHG'), false, 'the fuzzy match the backend made');
  assert.equal(m('OHB', 'ALDI SÜD Dienstleistungs- SE & Co. oHG'), false);
  assert.equal(m('Airbus Defence and Space', 'Airbus Defence & Space GmbH'), true, 'connectors ignored');
  assert.equal(m('Rohde & Schwarz', 'ROHDE & SCHWARZ GmbH & Co. KG'), true, 'case does not count');
  assert.equal(m('Mynaric', 'Mynaric Lasercom GmbH'), true);
  assert.equal(m('Mynaric', 'Mynaricx GmbH'), false, 'whole words only');
  assert.equal(m('Lübeck Optik', 'Luebeck Optik GmbH'), true, 'umlaut = transliteration');
  assert.equal(m('Société Générale', 'SOCIETE GENERALE'), true, 'accents do not count');
  assert.equal(m('', 'OHB'), false);
  assert.equal(m('OHB', ''), false);
  assert.equal(m('OHB', undefined), false);
  assert.equal(m('OHB System AG', 'OHB'), false, 'longer than the returned name');
});

/** A stubbed backend serving `pages` (arrays of employer names, 50 names = one full page) in BEST_MATCH order; the label endpoint answers {}. */
function stubEmployerBackend(pages) {
  const base = fixture('eures-search.json').jvs[0];
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), body });
    if (String(url) === LABELS) return json({});
    if (String(url) !== SEARCH) return json({ errorType: 'NOT_FOUND' }, 404);
    const names = pages[body.page - 1] ?? [];
    const jvs = names.map((name, i) => ({ ...base, id: `p${body.page}-${i + 1}`, title: `${name} role ${i + 1}`, employer: { ...base.employer, name } }));
    return json({ numberRecords: 5563, jvs, facets: {} });
  });
  return calls;
}

test('eures: fetch in employer mode sends EMPLOYER + BEST_MATCH, keeps only the searched employer and stops at the first page without it', async (t) => {
  t.after(() => mock.restoreAll());
  const fill = (n, name) => Array.from({ length: n }, () => name);
  // page 1: the exact employer; page 2: a sister company, then the fuzzy rest ("oHG"); page 3: fuzzy only; page 4 would be more of it
  const pages = [[...fill(3, 'OHB'), ...fill(47, 'OHB-System AG')], [...fill(5, 'OHB Digital Connect GmbH'), ...fill(45, 'ALDI SÜD Dienstleistungs- SE & Co. oHG')], fill(50, 'K2Trans OHG'), fill(50, 'Modehaus Jennerwein OHG')];
  let calls = stubEmployerBackend(pages);
  let jobs = await eures.fetch('employer:OHB|de');
  assert.equal(jobs.length, 55, '3 + 47 + 5 OHB vacancies; the 95 oHG ones are dropped');
  assert.deepEqual([...new Set(jobs.map((j) => j.company))], ['OHB (via EURES)', 'OHB-System AG (via EURES)', 'OHB Digital Connect GmbH (via EURES)']);
  let searches = calls.filter((c) => c.url === SEARCH);
  assert.deepEqual(searches.map((c) => c.body.page), [1, 2, 3], 'page 3 held no OHB: paging stops, page 4 is never asked for');
  for (const c of searches) {
    assert.deepEqual(c.body.keywords, [{ keyword: 'OHB', specificSearchCode: 'EMPLOYER' }]);
    assert.equal(c.body.sortSearch, 'BEST_MATCH');
    assert.deepEqual(c.body.locationCodes, ['de']);
    assert.equal(c.body.resultsPerPage, 50);
  }
  assert.equal(calls.filter((c) => c.url === LABELS).length, 2, 'labels are resolved for the kept vacancies only: none for page 3');
  assert.equal(jobs[0].meta.source, 'EURES (ELA)');
  assert.ok(jobs.every((j) => isAggregatorRow(j, new Set())), 'the copies are aggregator rows for the cross-listing');
  mock.restoreAll();

  // the two-word name keeps the one entity; page 2 brings nothing and ends the board
  calls = stubEmployerBackend(pages);
  jobs = await eures.fetch('employer:OHB System|de');
  assert.equal(jobs.length, 47);
  assert.ok(jobs.every((j) => j.company === 'OHB-System AG (via EURES)'));
  assert.deepEqual(calls.filter((c) => c.url === SEARCH).map((c) => c.body.page), [1, 2]);
  mock.restoreAll();

  // entry.max_jobs caps the kept vacancies; a short first page ends the board as in keyword mode
  calls = stubEmployerBackend(pages);
  assert.equal((await eures.fetch('employer:OHB|de', { max_jobs: 10 })).length, 10);
  assert.equal(calls.filter((c) => c.url === SEARCH).length, 1);
  mock.restoreAll();
  calls = stubEmployerBackend([[...fill(2, 'Mynaric Lasercom GmbH'), 'Unrelated oHG']]);
  jobs = await eures.fetch('employer:Mynaric|');
  assert.equal(jobs.length, 2);
  assert.deepEqual(calls.filter((c) => c.url === SEARCH)[0].body.locationCodes, [], 'no codes: every country');
  mock.restoreAll();

  // legal-id mode: the code goes to the backend, nothing is filtered on this side (the vacancies do not carry the id), standard paging
  calls = stubBackend(120);
  jobs = await eures.fetch('legalid:DE123456789|de');
  assert.equal(jobs.length, 120);
  searches = calls.filter((c) => c.url === SEARCH);
  assert.deepEqual(searches.map((c) => c.body.page), [1, 2, 3]);
  for (const c of searches) {
    assert.deepEqual(c.body.keywords, [{ keyword: 'DE123456789', specificSearchCode: 'LEGAL_ID' }]);
    assert.equal(c.body.sortSearch, 'BEST_MATCH');
  }
  mock.restoreAll();

  // a mode without a name is refused before any request
  calls = stubBackend(10);
  await assert.rejects(eures.fetch('employer:|de'), /employer: mode needs a name/);
  await assert.rejects(eures.fetch('legalid:|'), /legalid: mode needs a name/);
  assert.equal(calls.length, 0);
});

test('eures: fetch surfaces a 400 with the backend message and an unexpected document', async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(globalThis, 'fetch', async () => json({ errorType: 'java.lang.IllegalArgumentException', errorMessage: 'Too many results per page were requested' }, 400));
  await assert.rejects(eures.fetch('satellite|de'), /HTTP 400 eures .*Too many results per page/);
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => json({ hello: 'world' }));
  await assert.rejects(eures.fetch('satellite|de'), /unexpected search response \(keys: hello\)/);
});
