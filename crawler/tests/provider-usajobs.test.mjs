// USAJOBS Search API provider: the item -> job mapping on a trimmed captured response (crawler/tests/fixtures/usajobs-search.json,
// two NASA announcements, Fields=Full, 2026-11-01), detect() on both URL forms, fetch() without credentials and fetch() paging against a
// stubbed global fetch. No network. The tests never read the real USAJOBS_KEY/USAJOBS_EMAIL: the child process gets a copy of the
// environment without them, and the paging test sets dummies and restores whatever was there.
//   Run: node --test crawler/tests/provider-usajobs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// This module first on purpose: it imports plain/metaOf from providers.mjs, which registers it, so the cycle must load in this order too.
import { usajobs, usajobsJob } from '../providers-usajobs.mjs';
import { providers, plain } from '../providers.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/usajobs-search.json', import.meta.url), 'utf8'));
const MODULE_URL = new URL('../providers-usajobs.mjs', import.meta.url).href;
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MISSING = 'usajobs: USAJOBS_KEY and USAJOBS_EMAIL must be set';

test('usajobs: registered in the provider registry, no fetchDescription', () => {
  assert.equal(providers.usajobs.detect, usajobs.detect);
  assert.equal(providers.usajobs.fetch, usajobs.fetch);
  assert.equal(providers.usajobs.fetchDescription, undefined, 'Fields=Full carries the whole announcement');
});

test('usajobs: detect turns a Search API URL or a www search into a query slug', () => {
  const d = usajobs.detect;
  assert.equal(d('https://data.usajobs.gov/api/Search?Organization=NN;CM54&DatePosted=60'), 'DatePosted=60&Organization=NN;CM54');
  assert.equal(d('https://data.usajobs.gov/api/Search?Organization=NN%3BCM54&Fields=Full&Page=3&ResultsPerPage=500'),
    'Fields=Full&Organization=NN;CM54&ResultsPerPage=500', 'Page is dropped (fetch pages itself), the rest kept');
  assert.equal(d('https://data.usajobs.gov/api/search?Organization=NN&Organization=AF4G'), 'Organization=NN;AF4G', 'repeated names merge into the semicolon list');
  assert.equal(d('https://www.usajobs.gov/Search/Results?k=satellite'), 'Keyword=satellite');
  assert.equal(d('https://www.usajobs.gov/Search/Results?k=satellite+communications&l=Houston%2C+Texas&a=NN&p=2&so=d'),
    'Keyword=satellite%20communications&LocationName=Houston,%20Texas&Organization=NN', 'www parameters mapped, paging and sort dropped');
  assert.equal(d('https://usajobs.gov/Search/?k=cryogenics'), 'Keyword=cryogenics');
  assert.equal(d('https://data.usajobs.gov/api/Search'), null, 'no query: all of USAJOBS is not a board');
  assert.equal(d('https://www.usajobs.gov/Search/Results?p=2'), null);
  assert.equal(d('https://www.usajobs.gov/job/889289300'), null, 'a single announcement is not a board');
  assert.equal(d('https://example.com/careers?k=x'), null);
  assert.equal(d('not a url'), null);
  assert.equal(d(''), null);
});

test('usajobs: the captured announcements map to jobs', () => {
  const items = fixture.SearchResult.SearchResultItems;
  assert.equal(items.length, 2);
  assert.equal(fixture.SearchResult.SearchResultCountAll, 10, 'the query had more rows than the captured page');
  const [orion, fellow] = items.map(usajobsJob);

  assert.equal(orion.id, '889289300');
  assert.equal(orion.title, 'Manager Orion Program');
  assert.equal(orion.url, 'https://www.usajobs.gov/job/889289300', 'the ":443" of PositionURI is gone');
  assert.equal(orion.company, 'Lyndon B. Johnson Space Center');
  assert.equal(orion.location, 'Kennedy Space Center, Florida | Houston, Texas');
  assert.equal(orion.postedAt, '2026-10-19', 'PublicationStartDate "2026-10-19T12:56:14.5100" (no zone) kept to the day');
  assert.equal(usajobsJob({ MatchedObjectDescriptor: { PublicationStartDate: '10/19/2026 12:56:14' } }).postedAt, '2026-10-19', 'the US-order form too');
  assert.ok(orion.description.startsWith('Summary\nServes as Manager of the Orion Program'), orion.description.slice(0, 60));
  assert.match(orion.description, /\n\nDuties\nThe Manager Orion Program: Provides program management and control/);
  assert.match(orion.description, /\n\nQualifications\nAs a basic requirement for entry into the Senior Executive Service/);
  assert.match(orion.description, /\n\nEducation\nThis position has a positive education requirement/);
  assert.doesNotMatch(orion.description, /\n\nRequirements\n/, 'an empty section gets no heading');
  assert.doesNotMatch(orion.description, /<\/?[a-z]+[^>]*>/, 'no HTML');
  assert.ok(orion.description.length > 2000, `the whole announcement (${orion.description.length} chars)`);
  // the agency contact and the application instructions travel with the job (meta), the latter cut at 600 characters
  const howToApply = plain(items[0].MatchedObjectDescriptor.UserArea.Details.HowToApply).slice(0, 600);
  assert.equal(howToApply.length, 600);
  assert.ok(howToApply.startsWith('To apply for this position, you must complete the online application and submit the documentation'), howToApply.slice(0, 80));
  assert.ok(items[0].MatchedObjectDescriptor.UserArea.Details.HowToApply.length > 600, 'the capture\'s text is longer than the cut');
  assert.deepEqual(orion.meta, {
    department: 'National Aeronautics and Space Administration',
    grade: 'ES 00',
    pay_min: '223380',
    pay_max: '228000',
    pay_interval: 'PA',
    close_date: '2026-11-03',
    schedule: 'Full-Time',
    clearance: 'Sensitive Compartmented Information',
    telework: true,
    travel: '50% or Less',
    category: 'General Engineering',
    category_code: '0801',
    org_code: 'NN/NN72',
    apply_url: 'https://www.usajobs.gov/job/889289300',
    contact_email: 'Agency-Executive-Staffing@mail.nasa.gov',
    how_to_apply: howToApply,
    source: 'USAJOBS',
  }, 'remote (false), offering (empty name) and contact_phone (no AgencyContactPhone in the capture) are dropped');

  assert.equal(fellow.id, '889810000');
  assert.equal(fellow.title, 'Technical Fellow Cryogenics');
  assert.equal(fellow.url, 'https://www.usajobs.gov/job/889810000');
  assert.ok(fellow.location.startsWith('Sandusky County, Ohio | Hampton, Virginia | '), fellow.location);
  assert.equal(fellow.location.split(' | ').length, 17, 'every PositionLocation');
  assert.equal(fellow.meta.clearance, 'Secret');
  assert.equal(fellow.meta.travel, 'Occasional Travel');
  assert.equal(fellow.meta.telework, undefined, 'TeleworkEligible false is dropped');
  assert.equal(fellow.meta.org_code, 'NN/NN23');
  assert.equal(fellow.meta.contact_email, 'Agency-Executive-Staffing@mail.nasa.gov');
  assert.equal(fellow.meta.contact_phone, undefined);
  assert.equal(fellow.meta.how_to_apply.length, 600);
  assert.equal(fellow.meta.source, 'USAJOBS');
  assert.match(fellow.description, /\n\nDuties\nThe Technical Fellow Cryogenics: Serves as the Agency's authoritative technical resource/);
});

test('usajobs: a remote announcement, HTML in a section, several duties, a bare item', () => {
  const remote = usajobsJob({
    MatchedObjectId: '1',
    MatchedObjectDescriptor: {
      PositionID: 'X-1', PositionTitle: ' Dev ', PositionURI: 'https://www.usajobs.gov:443/job/1', PublicationStartDate: '2026-02-03T04:05:06',
      PositionLocation: [{ LocationName: 'Anywhere in the U.S. (remote job)' }, { LocationName: 'Anywhere in the U.S. (remote job)' }],
      JobGrade: [{ Code: 'GS' }],
      UserArea: { Details: { RemoteIndicator: 'True', TeleworkEligible: true, LowGrade: '13', HighGrade: '14', JobSummary: '<p>Hello <b>world</b></p>', MajorDuties: ['Build', 'Ship'],
        AgencyContactEmail: ' hr@example.invalid ', AgencyContactPhone: '(000) 000-0000', HowToApply: '<p>Apply online.</p><p>Questions: call us.</p>' } },
    },
  });
  assert.equal(remote.title, 'Dev');
  assert.equal(remote.url, 'https://www.usajobs.gov/job/1');
  assert.equal(remote.location, 'Anywhere in the U.S. (remote job) | Remote', 'duplicates folded, Remote appended');
  assert.equal(remote.postedAt, '2026-02-03');
  assert.equal(remote.description, 'Summary\nHello world\n\nDuties\n- Build\n- Ship');
  assert.deepEqual(remote.meta, { grade: 'GS 13-14', telework: true, remote: true, contact_email: 'hr@example.invalid', contact_phone: '(000) 000-0000', how_to_apply: 'Apply online.\nQuestions: call us.', source: 'USAJOBS' },
    'the contact fields trimmed, HowToApply as text');
  assert.equal(usajobsJob({ MatchedObjectDescriptor: { PositionID: 'ABC-1' } }).id, 'ABC-1', 'PositionID when MatchedObjectId is missing');
  assert.deepEqual(usajobsJob({}), { id: '', title: '', url: '', company: '', location: '', postedAt: '', description: '', meta: { source: 'USAJOBS' } });
});

test('usajobs: fetch throws before any request when the credentials are not in the environment', () => {
  const run = (vars) => {
    const env = { ...process.env };
    delete env.USAJOBS_KEY;
    delete env.USAJOBS_EMAIL;
    Object.assign(env, vars);
    const code = `import { usajobs } from ${JSON.stringify(MODULE_URL)};
globalThis.fetch = () => { throw new Error('a network request was attempted'); };
try { await usajobs.fetch('Organization=NN'); console.log('resolved'); } catch (e) { console.log(e.message); }`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.equal(run({}), MISSING);
  assert.equal(run({ USAJOBS_KEY: 'dummy-key' }), MISSING, 'the e-mail is required too');
  assert.equal(run({ USAJOBS_EMAIL: 'tester@example.invalid' }), MISSING, 'the key is required too');
});

test('usajobs: fetch pages the query with the three headers and maps every item', async () => {
  const saved = { key: process.env.USAJOBS_KEY, email: process.env.USAJOBS_EMAIL };
  const realFetch = globalThis.fetch;
  const calls = [];
  process.env.USAJOBS_KEY = 'test-key';
  process.env.USAJOBS_EMAIL = 'tester@example.invalid';
  const all = fixture.SearchResult.SearchResultItems;
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ u, headers: init.headers, signal: init.signal });
    if (u.searchParams.get('Organization') === 'DENIED') return { ok: false, status: 403, json: async () => ({}) };
    const page = Number(u.searchParams.get('Page'));
    const items = page === 1 ? all.slice(0, 1) : all.slice(1);   // ResultsPerPage=1 in the slug: two pages for two rows
    return { ok: true, status: 200, json: async () => ({ SearchResult: { SearchResultCount: items.length, SearchResultCountAll: all.length, SearchResultItems: items } }) };
  };
  try {
    const jobs = await usajobs.fetch('Organization=NN&ResultsPerPage=1');
    assert.equal(calls.length, 2, 'SearchResultCountAll rows reached after two pages');
    for (const [i, c] of calls.entries()) {
      assert.equal(c.u.origin + c.u.pathname, 'https://data.usajobs.gov/api/Search');
      assert.equal(c.u.searchParams.get('Organization'), 'NN');
      assert.equal(c.u.searchParams.get('ResultsPerPage'), '1', 'the slug\'s own value is kept');
      assert.equal(c.u.searchParams.get('Fields'), 'Full');
      assert.equal(c.u.searchParams.get('SortField'), 'opendate');
      assert.equal(c.u.searchParams.get('Page'), String(i + 1));
      assert.deepEqual(c.headers, { host: 'data.usajobs.gov', 'user-agent': 'tester@example.invalid', 'authorization-key': 'test-key', accept: 'application/json' });
      assert.ok(c.signal instanceof AbortSignal, 'a timeout is set');
    }
    assert.deepEqual(jobs.map((j) => j.title), ['Manager Orion Program', 'Technical Fellow Cryogenics']);
    assert.deepEqual(jobs[0], usajobsJob(all[0]));

    await assert.rejects(usajobs.fetch('Organization=DENIED'), (e) => {
      assert.match(e.message, /^HTTP 403 https:\/\/data\.usajobs\.gov\/api\/Search\?Organization=DENIED/);
      assert.doesNotMatch(e.message, /test-key|example\.invalid/, 'no credential in the error');
      return true;
    });
    await assert.rejects(usajobs.fetch(''), /usajobs: the slug must be a Search query/);
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of [['USAJOBS_KEY', saved.key], ['USAJOBS_EMAIL', saved.email]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
