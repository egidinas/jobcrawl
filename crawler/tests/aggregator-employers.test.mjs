// aggregator-employers.mjs: grouping, status decision, CSV, seed list and the command line, on a synthetic history + meta + companies
// + catalogue fixture. No network.   Run: node --test crawler/tests/aggregator-employers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { splitVia, parseHistory, domainOf, groupAggregatorRows, makeKnownIndex, decideStatus, classifyEmployers, toCsv, toSeedList,
  summarize, summaryLine, CSV_COLUMNS } from '../aggregator-employers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ---- fixture ----
const tsv = (rows) => ['url\tcompany\ttitle\tlocation\tfirst_seen\tlast_seen\tstatus\tposted', ...rows.map((r) => r.join('\t'))].join('\n') + '\n';
const HISTORY = tsv([
  // a directly tracked employer: not an aggregator row
  ['https://jobs.ashbyhq.com/beta-space/1', 'Beta Space', 'Thermal Engineer', 'Munich, Germany', '2026-10-01', '2026-11-01', 'open', '2026-09-30'],
  // Acme through two channels; "ACME" and "Acme GmbH" are one employer
  ['https://europa.eu/eures/portal/jv-se/jv-details/1?lang=en', 'Acme GmbH (via EURES)', 'Thermal Engineer', 'Germany (DE212)', '2026-10-20', '2026-11-01', 'open', '2026-10-19'],
  ['https://europa.eu/eures/portal/jv-se/jv-details/2?lang=en', 'Acme GmbH (via EURES)', 'AIT Engineer, m/f/d', 'Germany (DE212)', '2026-10-22', '2026-11-01', 'open', ''],
  ['https://europa.eu/eures/portal/jv-se/jv-details/3?lang=en', 'Acme GmbH (via EURES)', 'Old Role', 'Germany', '2026-09-01', '2026-09-20', 'gone', ''],
  ['https://europa.eu/eures/portal/jv-se/jv-details/4?lang=en', 'Acme GmbH (via EURES)', 'Yet Another', 'Germany', '2026-09-05', '2026-09-20', 'gone', ''],
  ['https://jobs.spacecapital.com/companies/acme/jobs/9', 'ACME (via Space Capital)', 'thermal engineer', 'Munich', '2026-10-25', '2026-11-01', 'open', ''],
  // tracked under a longer legal name
  ['https://www.space-careers.com/job_display/1/x', 'Beta Space Ltd (via Space-Careers)', 'Technician', 'Munich, Germany', '2026-10-10', '2026-11-01', 'extra', ''],
  ['https://www.space-careers.com/job_display/2/x', 'Beta Space Ltd (via Space-Careers)', 'Sales Manager', 'Munich, Germany', '2026-10-10', '2026-10-30', 'filtered', ''],
  // in the catalogue (by alias), no board
  ['https://www.jobs-in-photonics.com/job/1', 'Gamma Optics (via Jobs-in-Photonics)', 'Optical Designer', 'Jena, Germany', '2026-10-28', '2026-11-01', 'open', ''],
  // a disabled board, not in the catalogue
  ['https://www.mycareersfuture.gov.sg/job/abc', 'Delta Robotics (via MyCareersFuture)', 'Robotics Engineer', 'Singapore', '2026-10-28', '2026-11-01', 'open', ''],
  // tracked through the sameEmployer rule (generic suffix word)
  ['https://europa.eu/eures/portal/jv-se/jv-details/5?lang=en', 'Isar Aerospace Technologies (via EURES)', 'Propulsion Engineer', 'Germany (DE21)', '2026-10-28', '2026-11-01', 'open', ''],
  // reaches the catalogue (and through it a tracked board) only by the employer_site domain
  ['https://europa.eu/eures/portal/jv-se/jv-details/6?lang=en', 'EPS Holding (via EURES)', 'Systems Engineer', 'Germany (DE21)', '2026-10-28', '2026-11-01', 'open', ''],
  // gone only: listed, but not a seed
  ['https://spaceindividuals.com/job/z', 'Zeta (via Space Individuals)', 'Engineer', 'Paris', '2026-09-01', '2026-09-10', 'gone', ''],
  // skipped: no employer behind these
  ['https://europa.eu/eures/portal/jv-se/jv-details/7?lang=en', 'undisclosed (via EURES)', 'Engineer', 'France', '2026-10-28', '2026-11-01', 'open', ''],
  ['https://jobs.spacecapital.com/jobs/77', 'Space Capital (560+ Space Companies Meta-Board)', 'Engineer', 'Remote', '2026-10-28', '2026-11-01', 'open', ''],
  // a title with a comma and a quote: CSV quoting
  ['https://www.jobs-in-photonics.com/job/2', 'Quote, Inc. "Q" (via Jobs-in-Photonics)', 'Engineer, Lasers "X"', 'Berlin', '2026-10-28', '2026-11-01', 'open', ''],
]);
const META = {
  updated: '2026-11-01T00:00:00.000Z',
  jobs: {
    'https://europa.eu/eures/portal/jv-se/jv-details/1?lang=en': { nuts: 'DE212', contract: 'PERMANENT', categories: ['Engineering professionals', 'Physicists'], employer_site: 'https://www.acme.example/', source: 'EURES (ELA)' },
    'https://europa.eu/eures/portal/jv-se/jv-details/2?lang=en': { nuts: ['DE212', 'DE21'], categories: 'Engineering professionals', source: 'EURES (ELA)' },
    'https://europa.eu/eures/portal/jv-se/jv-details/6?lang=en': { nuts: 'DE21', employer_site: 'epsilon-systems.example', source: 'EURES (ELA)' },
    'https://jobs.spacecapital.com/companies/acme/jobs/9': { departments: 'Thermal', employment: 'FullTime' },
  },
};
const COMPANIES = {
  tracked_companies: [
    { name: 'Beta Space', provider: 'ashby', slug: 'beta-space', enabled: true },
    { name: 'Delta Robotics', provider: 'greenhouse', slug: 'delta', enabled: false },
    { name: 'Isar Aerospace', provider: 'personio', slug: 'isar', enabled: true },
    { name: 'Epsilon Systems', provider: 'lever', slug: 'epsilon', enabled: true },
    { name: 'Space Capital (560+ Space Companies Meta-Board)', provider: 'spacecapital', slug: '338', enabled: true },
    { name: 'EURES: satellite (EEA)', provider: 'eures', slug: 'satellite|', enabled: true },
    { name: 'Gamma Optics AG', provider: 'spacecareers', slug: 'gamma-watch', enabled: true },   // an aggregator watch, not a board
  ],
};
const CATALOGUE = {
  companies: [
    { slug: 'gamma-optics', name: 'Gamma Optics AG', aliases: ['Gamma Optics (via Jobs-in-Photonics)'], domain: 'gamma-optics.example', website: 'https://gamma-optics.example' },
    { slug: 'epsilon-systems', name: 'Epsilon Systems GmbH', aliases: [], domain: 'epsilon-systems.example', website: 'https://www.epsilon-systems.example' },
    { slug: 'beta-space', name: 'Beta Space', aliases: ['Beta Space Ltd'], domain: 'beta.example', tracked: true },
    { slug: 'space-capital', name: 'Space Capital', aliases: [], domain: 'spacecapital.com', kind: 'board', is_aggregator: true },
  ],
};
const rows = parseHistory(HISTORY);
const grouped = groupAggregatorRows(rows, META.jobs);
const index = makeKnownIndex({ tracked: COMPANIES.tracked_companies, catalogue: CATALOGUE.companies });
const employers = classifyEmployers(grouped, index);
const by = (name) => employers.find((e) => e.name === name);

test('splitVia and domainOf', () => {
  assert.deepEqual(splitVia('Acme GmbH (via EURES)'), { name: 'Acme GmbH', channel: 'EURES' });
  assert.deepEqual(splitVia('  X (via Space-Careers)  '), { name: 'X', channel: 'Space-Careers' });
  assert.equal(splitVia('Acme GmbH'), null);
  assert.equal(splitVia('Space Capital (560+ Space Companies Meta-Board)'), null);
  assert.equal(splitVia(''), null);
  assert.equal(domainOf('https://www.Acme.example/careers'), 'acme.example');
  assert.equal(domainOf('epsilon-systems.example'), 'epsilon-systems.example');
  assert.equal(domainOf('Acme GmbH'), '');
  assert.equal(domainOf('localhost'), '');
  assert.equal(domainOf(''), '');
});

test('parseHistory reads the header row and keeps every column', () => {
  assert.equal(rows.length, 16);
  assert.deepEqual(rows[0], { url: 'https://jobs.ashbyhq.com/beta-space/1', company: 'Beta Space', title: 'Thermal Engineer', location: 'Munich, Germany', first_seen: '2026-10-01', last_seen: '2026-11-01', status: 'open', posted: '2026-09-30' });
  assert.equal(parseHistory('').length, 0);
  assert.equal(parseHistory('url\tcompany\n').length, 0);
});

test('grouping: one employer per canonical name, channels and counts merged, direct and nameless rows skipped', () => {
  assert.deepEqual(grouped.map((e) => e.name).sort(), ['Acme GmbH', 'Beta Space Ltd', 'Delta Robotics', 'EPS Holding', 'Gamma Optics', 'Isar Aerospace Technologies', 'Quote, Inc. "Q"', 'Zeta']);
  const acme = grouped.find((e) => e.name === 'Acme GmbH');   // the most frequent spelling wins over "ACME"
  assert.deepEqual(acme.channels, ['EURES', 'Space Capital']);
  assert.deepEqual(acme.per_channel, { EURES: { rows: 4, open: 2 }, 'Space Capital': { rows: 1, open: 1 } });
  assert.equal(acme.rows, 5); assert.equal(acme.open, 3); assert.equal(acme.gone, 2); assert.equal(acme.extra, 0); assert.equal(acme.filtered, 0);
  assert.equal(acme.first_seen, '2026-09-01'); assert.equal(acme.last_seen, '2026-11-01');
  const beta = grouped.find((e) => e.name === 'Beta Space Ltd');
  assert.equal(beta.rows, 2); assert.equal(beta.open, 0); assert.equal(beta.extra, 1); assert.equal(beta.filtered, 1);
});

test('grouping: three sample titles, open roles first, distinct ignoring case', () => {
  const acme = grouped.find((e) => e.name === 'Acme GmbH');
  assert.deepEqual(acme.sample_titles, ['Thermal Engineer', 'AIT Engineer, m/f/d', 'Old Role']);
  const beta = grouped.find((e) => e.name === 'Beta Space Ltd');
  assert.deepEqual(beta.sample_titles, ['Technician', 'Sales Manager']);
});

test('grouping: EURES meta gives employer_site, NUTS, ESCO and contract; other meta is ignored', () => {
  const acme = grouped.find((e) => e.name === 'Acme GmbH');
  assert.equal(acme.employer_site, 'https://www.acme.example/');
  assert.equal(acme.site, 'acme.example');
  assert.deepEqual(acme.nuts, ['DE21', 'DE212']);
  assert.deepEqual(acme.esco, ['Engineering professionals', 'Physicists']);
  assert.deepEqual(acme.contract, ['PERMANENT']);
  assert.equal(acme.with_meta, 3);
  const gamma = grouped.find((e) => e.name === 'Gamma Optics');
  assert.equal(gamma.employer_site, ''); assert.deepEqual(gamma.nuts, []); assert.equal(gamma.with_meta, 0);
  // no meta at all
  const bare = groupAggregatorRows(rows);
  assert.equal(bare.find((e) => e.name === 'Acme GmbH').employer_site, '');
});

test('status: tracked by name, by legal-name variant, by the sameEmployer rule, and by domain through the catalogue', () => {
  assert.equal(by('Beta Space Ltd').status, 'tracked');
  assert.equal(by('Beta Space Ltd').tracked_board, 'Beta Space');
  assert.equal(by('Beta Space Ltd').catalogue_name, 'Beta Space');
  assert.equal(by('Isar Aerospace Technologies').status, 'tracked');
  assert.equal(by('Isar Aerospace Technologies').tracked_board, 'Isar Aerospace');
  assert.equal(by('EPS Holding').status, 'tracked');   // employer_site epsilon-systems.example -> catalogue "Epsilon Systems GmbH" -> board "Epsilon Systems"
  assert.equal(by('EPS Holding').catalogue_name, 'Epsilon Systems GmbH');
  assert.equal(by('EPS Holding').tracked_board, 'Epsilon Systems');
});

test('status: catalogue by alias (an aggregator watch is not a board), new, and a disabled board is not tracked', () => {
  assert.equal(by('Gamma Optics').status, 'catalogue');
  assert.equal(by('Gamma Optics').catalogue_name, 'Gamma Optics AG');
  assert.equal(by('Gamma Optics').catalogue_site, 'https://gamma-optics.example');   // website preferred over the bare domain
  assert.equal(by('Gamma Optics').tracked_board, '');
  assert.equal(by('Acme GmbH').status, 'new');
  assert.equal(by('Acme GmbH').catalogue_site, '');
  assert.equal(by('Zeta').status, 'new');
  assert.equal(by('Delta Robotics').status, 'new');
  assert.equal(by('Delta Robotics').tracked_board, 'Delta Robotics (disabled)');
  // decideStatus is pure: the same employer against an empty index is new
  assert.deepEqual(decideStatus(grouped.find((e) => e.name === 'Beta Space Ltd'), makeKnownIndex()), { status: 'new', tracked_board: '', catalogue_name: '', catalogue_site: '' });
});

test('makeKnownIndex: an enabled entry wins over a disabled one with the same name; board entries of the catalogue are skipped', () => {
  const idx = makeKnownIndex({ tracked: [{ name: 'Acme', provider: 'lever', enabled: false }, { name: 'Acme GmbH', provider: 'greenhouse', enabled: true }], catalogue: CATALOGUE.companies });
  assert.equal(idx.lookup('ACME (via EURES)').tracked.provider, 'greenhouse');
  assert.equal(idx.lookup('Space Capital').catalogue, null);
  assert.equal(idx.lookup('Nobody', 'https://nowhere.example').catalogue, null);
  assert.equal(idx.lookup('Nobody', 'https://www.gamma-optics.example/x').catalogue.name, 'Gamma Optics AG');
});

test('classifyEmployers sorts by open desc, then rows desc, then name', () => {
  assert.deepEqual(employers.map((e) => e.name), ['Acme GmbH', 'Delta Robotics', 'EPS Holding', 'Gamma Optics', 'Isar Aerospace Technologies', 'Quote, Inc. "Q"', 'Beta Space Ltd', 'Zeta']);
});

test('CSV: the documented columns, lists joined with " | ", RFC 4180 quoting', () => {
  const csv = toCsv(employers);
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.equal(lines[0], 'name,status,channels,open,extra,gone,filtered,rows,first_seen,last_seen,sample_titles,employer_site,nuts,esco,contract,tracked_board,catalogue_name');
  assert.equal(lines.length, 1 + employers.length);
  assert.equal(lines[1], 'Acme GmbH,new,EURES | Space Capital,3,0,2,0,5,2026-09-01,2026-11-01,"Thermal Engineer | AIT Engineer, m/f/d | Old Role",https://www.acme.example/,DE21 | DE212,Engineering professionals | Physicists,PERMANENT,,');
  const q = lines.find((l) => l.startsWith('"Quote'));
  assert.equal(q, '"Quote, Inc. ""Q""",new,Jobs-in-Photonics,1,0,0,0,1,2026-10-28,2026-11-01,"Engineer, Lasers ""X""",,,,,,');
  assert.equal(toCsv([]), CSV_COLUMNS.join(',') + '\n');
});

test('seed list: new + catalogue employers with >= min-open open postings, in the ats-resolve --seed shape', () => {
  const seeds = toSeedList(employers, 1);
  assert.deepEqual(seeds.map((s) => s.name), ['Acme GmbH', 'Delta Robotics', 'Gamma Optics', 'Quote, Inc. "Q"']);   // tracked ones and Zeta (0 open) left out
  assert.equal(seeds[0].website, 'https://www.acme.example/');   // from the EURES meta
  assert.equal('website' in seeds[1], false);                     // new, no site known
  assert.equal(seeds[2].website, 'https://gamma-optics.example'); // from the catalogue
  assert.equal('website' in seeds[3], false);
  assert.match(seeds[1].note, /^new; 1 open, 1 rows via MyCareersFuture; board: Delta Robotics \(disabled\)$/);
  assert.match(seeds[2].note, /^catalogue; 1 open.*catalogue: Gamma Optics AG$/);
  for (const s of seeds) assert.deepEqual(Object.keys(s).filter((k) => !['name', 'website', 'note'].includes(k)), []);
  assert.deepEqual(toSeedList(employers, 2).map((s) => s.name), ['Acme GmbH']);
  assert.deepEqual(toSeedList(employers, 0).map((s) => s.name), ['Acme GmbH', 'Delta Robotics', 'Gamma Optics', 'Quote, Inc. "Q"', 'Zeta']);
});

test('summary: totals per status and per channel', () => {
  const s = summarize(employers);
  assert.equal(s.employers, 8); assert.equal(s.rows, 13); assert.equal(s.open, 8);
  assert.deepEqual(s.byStatus, { tracked: 3, catalogue: 1, new: 4 });
  assert.deepEqual(s.byChannel.EURES, { employers: 3, rows: 6, open: 4 });
  assert.deepEqual(s.byChannel['Space Individuals'], { employers: 1, rows: 1, open: 0 });
  const line = summaryLine(s);
  assert.match(line, /^aggregator-employers: 8 employers \(tracked 3, catalogue 1, new 4\) from 13 aggregator rows, 8 open \| channels: EURES 3 employers\/4 open\/6 rows; /);
  assert.match(summaryLine(summarize([])), /0 employers \(tracked 0, catalogue 0, new 0\) from 0 aggregator rows, 0 open \| channels: none$/);
});

test('command line: writes the CSV and the seed list from a profile, logs start and result, exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aggregator-employers-'));
  try {
    const profile = join(dir, 'profile'), data = join(dir, 'data'), out = join(dir, 'review');
    mkdirSync(profile); mkdirSync(data);
    writeFileSync(join(profile, 'profile.json'), JSON.stringify({ name: 'fixture', crawl: { companies_file: 'companies.json', catalogue_file: 'catalogue.json' } }));
    writeFileSync(join(profile, 'companies.json'), JSON.stringify(COMPANIES));
    writeFileSync(join(profile, 'catalogue.json'), JSON.stringify(CATALOGUE));
    writeFileSync(join(data, 'scan-history.tsv'), HISTORY);
    writeFileSync(join(data, 'job-meta.json'), JSON.stringify(META));
    const r = spawnSync(process.execPath, [resolve(ROOT, 'crawler/aggregator-employers.mjs'), '--profile', profile, '--data', data, '--out', out, '--min-open', '1'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, JOBCRAWL_PROFILE: '' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /aggregator-employers: start \| history /);
    assert.match(r.stdout, /loaded 16 history rows, 14 aggregator rows \(9 open\), 4 meta entries, 7 companies entries \(3 aggregator boards\), 4 catalogue entries/);
    assert.match(r.stdout, /grouped 8 employers \(2 with meta, 2 with employer_site\)/);
    assert.match(r.stdout, /wrote .*aggregator-employers\.csv \(8 rows\) and .*aggregator-employers\.seed\.json \(4 seeds: new \+ catalogue with >= 1 open\)/);
    assert.match(r.stdout, /\naggregator-employers: 8 employers \(tracked 3, catalogue 1, new 4\) from 13 aggregator rows, 8 open \| channels: /);
    assert.equal(readFileSync(join(out, 'aggregator-employers.csv'), 'utf8'), toCsv(employers));
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'aggregator-employers.seed.json'), 'utf8')), toSeedList(employers, 1));
    // inputs untouched
    assert.equal(readFileSync(join(data, 'scan-history.tsv'), 'utf8'), HISTORY);
    // no history: exit 1 with the next step
    const r1 = spawnSync(process.execPath, [resolve(ROOT, 'crawler/aggregator-employers.mjs'), '--profile', profile, '--data', join(dir, 'empty'), '--out', out], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, JOBCRAWL_PROFILE: '' } });
    assert.equal(r1.status, 1);
    assert.match(r1.stderr, /no history at .*run crawler\/crawl\.mjs/);
    // a bad --min-open
    const r2 = spawnSync(process.execPath, [resolve(ROOT, 'crawler/aggregator-employers.mjs'), '--profile', profile, '--data', data, '--out', out, '--min-open', 'x'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, JOBCRAWL_PROFILE: '' } });
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /--min-open needs a whole number/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('command line: --help exits 0, no profile exits 2', () => {
  const run = (args) => spawnSync(process.execPath, [resolve(ROOT, 'crawler/aggregator-employers.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, JOBCRAWL_PROFILE: '' } });
  const h = run(['--help']);
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /usage: node crawler\/aggregator-employers\.mjs --profile <dir>/);
  assert.match(h.stdout, /--min-open <n>/);
  const n = run([]);
  assert.equal(n.status, 2);
  assert.match(n.stderr, /no profile/);
});
