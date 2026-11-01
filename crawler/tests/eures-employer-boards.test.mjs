// The per-employer EURES boards generator (crawler/eures-employer-boards.mjs) on a small synthetic companies.json + catalogue: the selection
// (enabled, non-aggregator, covered country or unknown, one board per employer, existing boards skipped), the name shortening, the entry shape,
// and the command line on a temporary profile. No network.
// Run: node --test crawler/tests/eures-employer-boards.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { shortName, baseName, countryVerdict, selectEmployers, boardEntry, existingEmployerBoards, catalogueIndex, COVERED_CODES, euresCodeOf, INTERVAL_HOURS } from '../eures-employer-boards.mjs';
import { detectEures, euresBoardUrl, parseSlug, EURES_COUNTRIES } from '../providers-eures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Synthetic tracked boards: every selection rule has one entry. */
const cfg = () => ({
  tracked_companies: [
    { name: 'OHB System AG', provider: 'greenhouse', slug: 'ohb', enabled: true },
    { name: 'OHB SE', provider: 'personio', slug: 'ohbse', enabled: true },                       // the same employer (catalogue alias): one board
    { name: 'Rohde & Schwarz GmbH & Co. KG', provider: 'workday', careers_url: 'https://rohde-schwarz.wd3.myworkdayjobs.com/x', enabled: true },
    { name: 'Astro Example Inc', provider: 'lever', slug: 'astro', enabled: true },                // catalogue: us -> skipped
    { name: 'Nordic Sat AB', provider: 'teamtailor', slug: 'nordic', enabled: true },              // catalogue location "Stockholm, Sweden"; has a board already
    { name: 'Mystery Labs', provider: 'ashby', slug: 'mystery', enabled: true },                   // not in the catalogue: unknown -> included, every country
    { name: 'Old Board GmbH', provider: 'personio', slug: 'old', enabled: false },                 // disabled
    { name: 'Space Careers', provider: 'spacecareers', enabled: true },                            // an aggregator, not an employer
    { name: 'EURES: satellite (EEA)', provider: 'eures', careers_url: 'https://europa.eu/eures/portal/jv-se/search?keyword=satellite&location=de', enabled: true },
    { name: 'EURES employer: Nordic Sat', provider: 'eures', careers_url: euresBoardUrl('employer:Nordic Sat|se'), enabled: true, interval_hours: 168 },
    { name: 'Tamus (workday) [TAMU_External]', provider: 'workday', careers_url: 'https://tamus.wd1.myworkdayjobs.com/TAMU_External', enabled: true },   // catalogue country "Texas"
    { name: 'Lux Orbit S.A.', provider: 'join', slug: 'lux', enabled: true, headquarters: 'Luxembourg' },   // not in the catalogue; the board's own field
    { name: 'Hellas Space', provider: 'recruitee', slug: 'hellas', enabled: true },                // catalogue gr -> the backend's "el"
  ],
});
const catalogue = () => ({
  companies: [
    { name: 'OHB', aliases: ['OHB System AG', 'OHB SE'], country_code: 'de', location: 'Bremen, Germany' },
    { name: 'Rohde & Schwarz', aliases: ['Rohde & Schwarz GmbH & Co. KG'], country_code: 'de' },
    { name: 'Astro Example', aliases: ['Astro Example Inc'], country_code: 'us', country: 'California' },
    { name: 'Nordic Sat', aliases: [], location: 'Stockholm, Sweden' },
    { name: 'Tamus', aliases: [], country: 'Texas' },
    { name: 'Hellas Space', country_code: 'gr' },
  ],
});

test('eures boards: shortName strips trailing legal forms, baseName the board decorations', () => {
  assert.equal(shortName('OHB System AG'), 'OHB System');
  assert.equal(shortName('Rohde & Schwarz GmbH & Co. KG'), 'Rohde & Schwarz');
  assert.equal(shortName('CGI Deutschland BV & Co. KG'), 'CGI Deutschland');
  assert.equal(shortName('Airbus Defence and Space GmbH'), 'Airbus Defence and Space');
  assert.equal(shortName('Thales Alenia Space'), 'Thales Alenia Space', 'nothing to strip');
  assert.equal(shortName('Lux Orbit S.A.'), 'Lux Orbit');
  assert.equal(shortName('Lux Orbit S.A'), 'Lux Orbit');
  assert.equal(shortName('Cailabs SAS'), 'Cailabs');
  assert.equal(shortName('GomSpace A/S'), 'GomSpace');
  assert.equal(shortName('Nordic Sat AB'), 'Nordic Sat');
  assert.equal(shortName('ICEYE Oy'), 'ICEYE');
  assert.equal(shortName('Astro Example Inc.'), 'Astro Example');
  assert.equal(shortName('Astro Example, Inc.'), 'Astro Example');
  assert.equal(shortName('Example Ltd'), 'Example');
  assert.equal(shortName('Example Limited'), 'Example');
  assert.equal(shortName('Example Corporation'), 'Example');
  assert.equal(shortName('Creotech Instruments S.A.'), 'Creotech Instruments');
  assert.equal(shortName('Scanway Sp. z o.o.'), 'Scanway');
  assert.equal(shortName('Fortiss gGmbH'), 'Fortiss');
  assert.equal(shortName('ALDI SÜD Dienstleistungs- SE & Co. oHG'), 'ALDI SÜD Dienstleistungs', 'a dangling hyphen goes too');
  assert.equal(shortName('Zentrum für Telematik e.V.'), 'Zentrum für Telematik');
  assert.equal(shortName('Deutsches Zentrum für Luft- und Raumfahrt'), 'Deutsches Zentrum für Luft- und Raumfahrt', 'a connector inside the name stays');
  assert.equal(shortName('Esri Deutschland GmbH'), 'Esri Deutschland', 'a country word is part of the name EURES has');
  assert.equal(shortName('Applus+ IMA | IMA Materialforschung und Anwendungstechnik GmbH'), 'Applus+ IMA', 'alternatives separated by a pipe: the first; the "+" of a brand stays');
  assert.equal(shortName('Canal+'), 'Canal+');
  assert.equal(shortName(' | Only Second GmbH'), 'Only Second', 'an empty first alternative is skipped');
  assert.equal(detectEures(boardEntry('A | B', ['de']).careers_url), 'employer:A B|de', 'a pipe can never reach the slug');
  assert.equal(shortName('GmbH'), 'GmbH', 'a name that is only a legal form stays');
  assert.equal(shortName('  SE  '), 'SE');
  assert.equal(shortName(''), '');
  assert.equal(shortName(undefined), '');
  assert.equal(baseName('Tamus (workday) [TAMU_External]'), 'Tamus');
  assert.equal(baseName('Alterra (workday) [SkiButlers]'), 'Alterra');
  assert.equal(baseName('1 shift (via Jobs-in-Photonics)'), '1 shift');
  assert.equal(baseName('OHB System AG'), 'OHB System AG');
});

test('eures boards: countryVerdict from the code, else from the texts; covered wins over other; nothing known = unknown', () => {
  assert.deepEqual(countryVerdict({ country_code: 'de' }), { verdict: 'covered', code: 'de' });
  assert.deepEqual(countryVerdict({ country_code: 'DE', location: 'Denver, Colorado' }), { verdict: 'covered', code: 'de' }, 'the code decides when present');
  assert.deepEqual(countryVerdict({ country_code: 'us', location: 'Bremen, Germany' }), { verdict: 'other', code: 'us' });
  assert.deepEqual(countryVerdict({ country_code: 'gr' }), { verdict: 'covered', code: 'gr' });
  assert.deepEqual(countryVerdict({ country_code: 'ch' }), { verdict: 'covered', code: 'ch' }, 'the portal covers Switzerland');
  assert.deepEqual(countryVerdict({ country_code: 'gb' }), { verdict: 'other', code: 'gb' });
  assert.deepEqual(countryVerdict({ country: 'DE' }), { verdict: 'covered', code: 'de' }, 'a two-letter `country`');
  assert.deepEqual(countryVerdict({ location: 'Stockholm, Sweden' }), { verdict: 'covered', code: 'se' });
  assert.deepEqual(countryVerdict({ location: 'München, Bavaria', address: 'Hauptstr. 1, 80000 München, Deutschland' }), { verdict: 'covered', code: 'de' }, 'native names');
  assert.deepEqual(countryVerdict({ country: 'California' }), { verdict: 'other', code: '' }, 'a US state in the catalogue\'s country field');
  assert.deepEqual(countryVerdict({ location: 'London, United Kingdom' }), { verdict: 'other', code: '' });
  assert.deepEqual(countryVerdict({ location: 'Belfast, Northern Ireland' }), { verdict: 'other', code: '' }, 'not the covered Ireland');
  assert.deepEqual(countryVerdict({ location: 'Dublin, Ireland' }), { verdict: 'covered', code: 'ie' });
  assert.deepEqual(countryVerdict({ location: 'Munich, Germany and Denver, Colorado' }), { verdict: 'covered', code: 'de' }, 'a European site is enough');
  assert.deepEqual(countryVerdict({ location: 'Indianapolis, Indiana' }), { verdict: 'other', code: '' }, 'Indiana is not India, and not covered either');
  assert.deepEqual(countryVerdict({ location: 'Munich' }), { verdict: 'unknown', code: '' }, 'a city alone says nothing to this rule');
  assert.deepEqual(countryVerdict({ location: '' }), { verdict: 'unknown', code: '' });
  assert.deepEqual(countryVerdict({}), { verdict: 'unknown', code: '' });
  assert.deepEqual(countryVerdict({ headquarters: 'Luxembourg' }), { verdict: 'covered', code: 'lu' });
  assert.equal(COVERED_CODES.size, Object.keys(EURES_COUNTRIES).length + 1, 'the 31 portal countries plus GR for the catalogue\'s Greece');
  assert.ok(COVERED_CODES.has('el') && COVERED_CODES.has('gr') && COVERED_CODES.has('de') && !COVERED_CODES.has('gb') && !COVERED_CODES.has('us'));
  assert.equal(euresCodeOf('gr'), 'el');
  assert.equal(euresCodeOf('DE'), 'de');
});

test('eures boards: selectEmployers picks enabled non-aggregator boards in covered or unknown countries, one board per employer, skipping existing ones', () => {
  const { boards, employers, stats } = selectEmployers(cfg(), catalogue());
  assert.deepEqual(stats, { tracked: 13, candidates: 9, employers: 8, covered: 5, unknown: 1, other: 2, existing: 1, emitted: 5 });
  assert.deepEqual(boards.map((b) => b.name), ['EURES employer: Hellas Space', 'EURES employer: Lux Orbit', 'EURES employer: Mystery Labs', 'EURES employer: OHB', 'EURES employer: Rohde & Schwarz']);
  const slugs = Object.fromEntries(boards.map((b) => [b.name, detectEures(b.careers_url)]));
  assert.deepEqual(slugs, {
    'EURES employer: Hellas Space': 'employer:Hellas Space|el',   // the catalogue's gr is the backend's el
    'EURES employer: Lux Orbit': 'employer:Lux Orbit|lu',         // the board's own headquarters field
    'EURES employer: Mystery Labs': 'employer:Mystery Labs|',     // unknown country: included, every country
    'EURES employer: OHB': 'employer:OHB|de',                     // the catalogue's short name for both OHB boards
    'EURES employer: Rohde & Schwarz': 'employer:Rohde & Schwarz|de',
  });
  for (const b of boards) {
    assert.equal(b.provider, 'eures');
    assert.equal(b.enabled, true);
    assert.equal(b.interval_hours, 168);
    assert.equal(INTERVAL_HOURS, 168);
    assert.match(b.note, /^EURES copies of .+'s postings for cross-listing and metadata; weekly$/);
    assert.equal(parseSlug(detectEures(b.careers_url)).mode, 'EMPLOYER');
    assert.deepEqual(Object.keys(b), ['name', 'careers_url', 'provider', 'enabled', 'interval_hours', 'note']);
  }
  const by = Object.fromEntries(employers.map((e) => [e.employer, e]));
  assert.deepEqual(by.OHB.boards, ['OHB System AG', 'OHB SE'], 'two boards, one employer');
  assert.equal(by.OHB.catalogue, 'OHB');
  assert.deepEqual([by['Astro Example'].verdict, by['Astro Example'].emitted], ['other', false]);
  assert.deepEqual([by.Tamus.verdict, by.Tamus.emitted], ['other', false], 'the Workday tenant decoration is removed before the catalogue lookup');
  assert.deepEqual([by['Nordic Sat'].verdict, by['Nordic Sat'].existing, by['Nordic Sat'].emitted], ['covered', true, false], 'has a board already');
  assert.deepEqual([by['Mystery Labs'].verdict, by['Mystery Labs'].catalogue], ['unknown', null]);
  assert.ok(!('Old Board' in by) && !('Space Careers' in by), 'disabled and aggregator entries are not employers');
  assert.equal(boardEntry('OHB', ['de']).careers_url, 'https://europa.eu/eures/portal/jv-se/search?page=1&resultsPerPage=10&orderBy=BEST_MATCH&keywordsEmployer=OHB&locationCodes=de&lang=en');
  assert.equal(boardEntry('OHB').note, "EURES copies of OHB's postings for cross-listing and metadata; weekly");

  // --codes: the same codes for every board
  const forced = selectEmployers(cfg(), catalogue(), { codes: ['de', 'FR'] });
  assert.ok(forced.boards.every((b) => detectEures(b.careers_url).endsWith('|de,fr')));
  assert.equal(forced.stats.emitted, 5);

  // an existing board is recognised by its slug whatever its name
  const c2 = cfg();
  c2.tracked_companies.push({ name: 'OHB on EURES', provider: 'eures', slug: 'employer:ohb|de', enabled: true });
  assert.deepEqual([...existingEmployerBoards(c2)].sort(), ['nordic sat', 'ohb']);
  assert.ok(!selectEmployers(c2, catalogue()).boards.some((b) => b.name === 'EURES employer: OHB'));

  // no catalogue at all: every employer is unknown and included (except the ones a board's own field places elsewhere)
  const none = selectEmployers(cfg(), { companies: [] });
  assert.equal(none.stats.other, 0);
  assert.equal(none.stats.emitted, 8, '9 candidates, OHB System and OHB SE stay two employers without the catalogue alias, Nordic Sat has a board');
  assert.ok(none.boards.some((b) => detectEures(b.careers_url) === 'employer:OHB System|'));

  const idx = catalogueIndex(catalogue());
  assert.equal(idx.exact.get('ohb se').name, 'OHB');
  assert.equal(idx.canon.get('nordic sat').name, 'Nordic Sat');
});

test('eures boards: the command line reads a profile, prints the summary and writes the JSON array; companies.json is untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eures-boards-'));
  try {
    writeFileSync(join(dir, 'profile.json'), JSON.stringify({ name: 'synthetic', crawl: { companies_file: 'companies.json', catalogue_file: 'catalogue.json' } }));
    const companiesText = JSON.stringify(cfg(), null, 2);
    writeFileSync(join(dir, 'companies.json'), companiesText);
    writeFileSync(join(dir, 'catalogue.json'), JSON.stringify(catalogue()));
    const run = (args) => spawnSync(process.execPath, [resolve(ROOT, 'crawler/eures-employer-boards.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, JOBCRAWL_PROFILE: '' } });

    const out = join(dir, 'out', 'eures-employer-boards.json');
    const r = run(['--profile', dir, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[eures-employer-boards\] start: profile /);
    assert.match(r.stdout, /13 tracked boards, 9 enabled non-aggregator, 8 distinct employers: 5 in covered countries \(EEA \+ CH\), 1 of unknown country \(included\), 2 elsewhere \(skipped\), 1 already have an EURES employer board; 5 boards emitted/);
    assert.match(r.stdout, /wrote 5 entries to .*eures-employer-boards\.json; paste the wanted ones into .*companies\.json \(this script does not modify it\)/);
    const written = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(written.length, 5);
    assert.equal(written[3].name, 'EURES employer: OHB');
    assert.equal(detectEures(written[3].careers_url), 'employer:OHB|de');
    assert.equal(readFileSync(join(dir, 'companies.json'), 'utf8'), companiesText, 'not modified');

    const s = run(['--profile', dir, '--codes', 'de,at']);
    assert.equal(s.status, 0, s.stderr);
    assert.match(s.stderr, /5 boards emitted/, 'without --out the summary goes to stderr');
    const printed = JSON.parse(s.stdout);
    assert.equal(printed.length, 5);
    assert.ok(printed.every((b) => detectEures(b.careers_url).endsWith('|de,at')));

    assert.equal(run(['--help']).status, 0);
    assert.match(run(['--help']).stdout, /usage: node crawler\/eures-employer-boards\.mjs --profile <dir>/);
    const none = run([]);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /no profile/);
    const missing = run(['--profile', join(dir, 'nope')]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /no profile\.json/);
  } finally {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});
