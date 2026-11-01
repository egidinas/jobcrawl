// Teamtailor (/jobs.json, RSS fallback) and Rippling (board API) item -> job mappings, run on trimmed captured documents
// (crawler/tests/fixtures/, 2026-11-01; no network).   Run: node --test crawler/tests/feeds-teamtailor-rippling.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providers, teamtailorJob, teamtailorRssJob, ripplingJob, ripplingDescription } from '../providers.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('teamtailor: detect is unchanged', () => {
  const d = providers.teamtailor.detect;
  assert.equal(d('https://dcubed.teamtailor.com/jobs'), 'dcubed');
  assert.equal(d('https://careers.open-cosmos.com'), 'https://careers.open-cosmos.com');
  assert.equal(d('https://careers.example.com/jobs/8434380-structural-engineer'), 'https://careers.example.com');
  assert.equal(d('https://example.com/careers'), undefined);
});

test('teamtailor: JSON Feed items map to jobs with the full description', () => {
  const feed = fixture('teamtailor-jobs.json');
  assert.equal(feed.version, 'https://jsonfeed.org/version/1.1');
  const jobs = feed.items.map(teamtailorJob);
  assert.equal(jobs.length, 3);
  const [j, us, open] = jobs;
  assert.match(j.id, UUID);
  assert.equal(j.title, 'Structural Engineer - Solar Arrays (f/m/d)');
  assert.equal(j.url, 'https://dcubed.teamtailor.com/jobs/8434380-structural-engineer-solar-arrays-f-m-d');
  assert.equal(j.location, 'Germering, DE');
  assert.equal(j.postedAt, '2026-09-22T13:29:01+02:00');
  assert.ok(j.description.startsWith('About the role'), j.description.slice(0, 40));
  assert.ok(j.description.length > 3000, 'the whole posting, not the RSS teaser');
  assert.doesNotMatch(j.description, /<\/?[a-z]+[^>]*>/, 'no HTML left');
  assert.match(j.description, /\n- /, 'list items became lines');
  assert.deepEqual(j.meta, { employment: 'FULL_TIME', ref: '8434380', country: 'DE' });
  assert.equal(us.location, 'Berthoud, US');
  assert.equal(us.meta.ref, '8325738');
  assert.equal(open.title, 'Open Application');
  assert.equal(open.location, '', 'a posting without an address has no location');
  assert.deepEqual(open.meta, { employment: 'FULL_TIME', ref: '7212657' });
  for (const x of jobs) assert.ok(!('department' in x), 'the JSON Feed carries no department');
});

test('teamtailor: a remote posting and an item without _jobposting', () => {
  const remote = teamtailorJob({ id: 'x', title: 'Dev', url: 'https://a.teamtailor.com/jobs/1234567-dev', date_published: '2026-01-02T03:04:05+01:00', content_html: '<p>Hi</p>',
    _jobposting: { jobLocationType: 'TELECOMMUTE', jobLocation: { '@type': 'Place', address: { addressLocality: 'Lisbon', addressCountry: 'PT' } } } });
  assert.equal(remote.location, 'Lisbon, PT | Remote');
  assert.equal(remote.meta.remote, true);
  const bare = teamtailorJob({ id: 'y', title: 'Ops', url: 'https://a.teamtailor.com/jobs/1234568-ops' });
  assert.deepEqual(bare, { id: 'y', title: 'Ops', url: 'https://a.teamtailor.com/jobs/1234568-ops', location: '', postedAt: '', description: '', meta: undefined });
});

test('teamtailor: the RSS fallback keeps its mapping', () => {
  const item = `<title><![CDATA[Production Manager]]></title><link>https://dcubed.teamtailor.com/jobs/8381369-production-manager</link>
    <description><![CDATA[<p>Build &amp; ship</p>]]></description><pubDate>Mon, 15 Sep 2026 10:16:46 +0000</pubDate>
    <department>Production</department><city>Germering</city><country>Germany</country><remoteStatus>hybrid</remoteStatus>`;
  assert.deepEqual(teamtailorRssJob(item), {
    title: 'Production Manager',
    url: 'https://dcubed.teamtailor.com/jobs/8381369-production-manager',
    location: 'Germering, Germany',
    department: 'Production',
    postedAt: '2026-09-15T10:16:46.000Z',
    description: 'Build & ship',
  });
  assert.equal(teamtailorRssJob('<remoteStatus>fully</remoteStatus><name>Berlin</name>').location, 'Berlin, Remote');
});

test('rippling: detect yields the board slug the API path uses', () => {
  assert.equal(providers.rippling.detect('https://ats.rippling.com/mbryonics/jobs'), 'mbryonics');
  assert.equal(providers.rippling.detect('https://ats.rippling.com/mbryonics/jobs/efeeef1d-7058-4a2f-ab3e-5d104a1d60f2'), 'mbryonics');
  assert.equal(providers.rippling.detect('https://example.com/careers'), undefined);
  assert.equal(typeof providers.rippling.fetchDescription, 'function');
});

test('rippling: board list entries map to jobs without a description', () => {
  const list = fixture('rippling-jobs.json');
  assert.ok(Array.isArray(list));
  const jobs = list.map((j) => ripplingJob(j, 'mbryonics'));
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs[0], {
    id: 'efeeef1d-7058-4a2f-ab3e-5d104a1d60f2',
    title: 'DSP Engineer (Digital Signal Processing)',
    url: 'https://ats.rippling.com/mbryonics/jobs/efeeef1d-7058-4a2f-ab3e-5d104a1d60f2',
    location: 'Galway, Ireland',
    department: 'Electronics',
    postedAt: '',
    meta: { departments: 'Electronics' },
  });
  for (const j of jobs) {
    assert.match(j.id, UUID);
    assert.equal(j.url, `https://ats.rippling.com/mbryonics/jobs/${j.id}`);
    assert.equal(j.description, undefined);
  }
  assert.equal(ripplingJob({ uuid: 'abc', name: ' X ' }, 'acme').url, 'https://ats.rippling.com/acme/jobs/abc');
  assert.equal(ripplingJob({ uuid: 'abc', name: ' X ' }, 'acme').title, 'X');
});

test('rippling: the per-job document gives the description as plain text, sections in order', () => {
  const d = fixture('rippling-job.json');
  assert.deepEqual(Object.keys(d.description), ['company', 'role']);
  const text = ripplingDescription(d);
  assert.ok(text.startsWith('About MBRYONICS'), text.slice(0, 40));
  assert.ok(text.indexOf('About MBRYONICS') < text.indexOf('Digital Signal Processing (DSP) Engineer'), 'company section before the role');
  assert.ok(text.length > 5000, `whole posting (${text.length} chars)`);
  assert.doesNotMatch(text, /<\/?[a-z]+[^>]*>|font-family|white-space/, 'no HTML or inline style left');
  assert.match(text, /\n\n/, 'sections separated');
  assert.equal(ripplingDescription({ description: '<p>Just <b>one</b> string</p>' }), 'Just one string');
  assert.equal(ripplingDescription({ description: { company: '', role: null } }), '');
  assert.equal(ripplingDescription({}), '');
  assert.equal(ripplingDescription(null), '');
});
