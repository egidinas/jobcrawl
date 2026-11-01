// The EURES employer detail sweep (crawler/eures-employer-detail.mjs) and the cross-process rate file of the provider
// (providers-eures.mjs claimSharedSlot / setEuresRateFile). No network: fetch is mocked, the rate file lives in a temp dir.
// Run: node --test crawler/tests/eures-employer-detail.test.mjs
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.EURES_MIN_GAP_MS = '0';
const { euresDetail, claimSharedSlot, setEuresRateFile, euresLimiter, tuning } = await import('../providers-eures.mjs');
const { normSite, employerKey, harvestEmployers, planSweep, employerFromDetail, applyResult, naceTsv, releaseExhausted, TSV_HEADER } = await import('../eures-employer-detail.mjs');

const DETAIL = JSON.parse(readFileSync(new URL('./fixtures/eures-detail.json', import.meta.url), 'utf8'));
const SEARCH = 'https://europa.eu/eures/api/jv-searchengine/public/jv-search/search';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const vac = (id, name, website, lm = 1) => ({ id, employer: { name, website, sectorCodes: [] }, lastModificationDate: lm });

test('eures detail sweep: web site host and employer key', () => {
  assert.equal(normSite('http://www.Go-Simplexx.de/jobs?x=1'), 'go-simplexx.de');
  assert.equal(normSite('go-simplexx.de'), 'go-simplexx.de');
  assert.equal(normSite('https://karriere.example.com:443/'), 'karriere.example.com');
  assert.equal(normSite(null), '');
  assert.equal(employerKey('SimpleXX GmbH', 'http://www.go-simplexx.de'), 'simplexx gmbh|go-simplexx.de');
  assert.equal(employerKey('SIMPLEXX  GmbH.', 'go-simplexx.de/'), 'simplexx gmbh|go-simplexx.de', 'case, punctuation, scheme and path do not count');
  assert.equal(employerKey('Müller & Söhne', ''), 'mueller soehne|');
  assert.notEqual(employerKey('Impuls Personal GmbH', 'impuls-personal.de'), employerKey('Impuls Personal GmbH', ''), 'the site is part of the key');
  assert.equal(employerKey('', 'x.de'), '', 'no name, no key');
});

test('eures detail sweep: harvest reads each search body once, one entry per employer, newest vacancy first', () => {
  const bodies = {
    a: { jvs: [vac('v1', 'ACME GmbH', 'acme.de', 10), vac('v2', 'ACME GmbH', 'http://www.acme.de', 30), vac('v3', '', 'x.de')] },
    b: { jvs: [vac('v1', 'ACME GmbH', 'acme.de', 10), vac('v4', 'Other AG', null, 5)] },
  };
  const lines = [
    { t: '2026-11-01T10:00:00Z', url: SEARCH, status: 200, sha256: 'a' },
    { t: '2026-11-01T12:00:00Z', url: SEARCH, status: 200, sha256: 'b' },
    { t: '2026-11-01T13:00:00Z', url: SEARCH, status: 200, sha256: 'a' },    // the same body again: read once, its newest t counts
    { t: '2026-11-01T13:00:00Z', url: SEARCH, status: 500, sha256: 'z' },    // not a 200
    { t: '2026-11-01T13:00:00Z', url: 'https://x/other', status: 200, sha256: 'b' },
    { t: '2026-11-01T13:00:00Z', url: SEARCH, status: 200, sha256: 'gone' }, // object missing
  ];
  const reads = [];
  const { employers, stats } = harvestEmployers(lines, (sha) => { reads.push(sha); return bodies[sha] ?? null; });
  assert.deepEqual(reads.sort(), ['a', 'b', 'gone']);
  assert.equal(stats.responses, 2);
  assert.equal(stats.unreadable, 1);
  assert.equal(stats.noName, 1);
  assert.equal(employers.size, 2);
  const acme = employers.get('acme gmbh|acme.de');
  assert.deepEqual(acme.ids.map((x) => x.id), ['v2', 'v1'], 'both last seen at 13:00; v2 is the more recently modified');
  assert.equal(acme.website, 'http://www.acme.de', 'the name and site as last seen');
  assert.equal(employers.get('other ag|').ids[0].id, 'v4');
});

test('eures detail sweep: plan skips resolved and waiting employers, moves on after a 404, retries a failure', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const emp = (ids) => ({ name: 'n', website: '', ids: ids.map((id, i) => ({ id, t: `2026-11-01T0${i}`, lm: 0 })) });
  const employers = new Map([['ok', emp(['a'])], ['wait', emp(['b'])], ['gone', emp(['c1', 'c2'])], ['fail', emp(['d'])], ['new', emp(['e'])], ['spent', emp(['f'])]]);
  const state = {
    ok: { status: 'ok', tried: ['a'] },
    wait: { status: 'failed', id: 'b', next: now + 1000 },
    gone: { status: 'gone', id: 'c1', tried: ['c1'], next: now },
    fail: { status: 'failed', id: 'd', tried: [], next: now - 1 },
    spent: { status: 'gone', id: 'f', tried: ['f'], next: now },
  };
  const { queue, skipped } = planSweep(employers, state, now);
  assert.deepEqual(Object.fromEntries(queue.map((q) => [q.key, q.id])), { gone: 'c2', fail: 'd', new: 'e' });
  assert.deepEqual(skipped, { done: 1, waiting: 1, exhausted: 1 });
});

test('eures detail sweep: NACE class and size from the detail fixture; result states', () => {
  assert.deepEqual(employerFromDetail(DETAIL), { sectorCodes: ['o78.2.0'], size: 'medium-sizedenterprise' });
  assert.deepEqual(employerFromDetail({}), { sectorCodes: [], size: '' });
  const now = Date.parse('2026-11-01T12:00:00Z');
  const item = { key: 'k', name: 'SimpleXX GmbH', website: 'http://www.go-simplexx.de', id: 'X1' };
  const ok = applyResult(undefined, item, { ok: true, detail: DETAIL }, now);
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.nace, ['o78.2.0']);
  assert.equal(ok.fetched_at, '2026-11-01T12:00:00.000Z');
  assert.equal(ok.next, undefined);
  const none = applyResult(undefined, item, { ok: true, detail: { jvProfiles: { de: { employer: { sectorCodes: [] } } }, preferredLanguage: 'de' } }, now);
  assert.equal(none.status, 'no-code');
  assert.equal(none.next, now + 30 * 864e5);
  const gone = applyResult(undefined, item, { ok: false, status: 404, error: 'HTTP 404 eures /jv/id/X1' }, now);
  assert.equal(gone.status, 'gone');
  assert.deepEqual(gone.tried, ['X1']);
  let f = applyResult(undefined, item, { ok: false, status: 503, error: 'HTTP 503' }, now);
  assert.equal(f.status, 'failed');
  assert.deepEqual(f.tried, [], 'a failure does not use up the vacancy');
  assert.equal(f.next, now + 864e5, 'first retry after a day');
  f = applyResult(f, item, { ok: false, status: 0, error: 'fetch failed' }, now);
  assert.equal(f.next, now + 7 * 864e5, 'then after 7 days');
});

test('eures detail sweep: an employer whose vacancies all expired waits 7 days, then its tried list is cleared', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  const employers = new Map([['g', { ids: [{ id: 'a' }] }], ['old', { ids: [{ id: 'b' }] }]]);
  const state = { g: { status: 'gone', tried: ['a'], goneAt: '2026-11-08T00:00:00Z' }, old: { status: 'gone', tried: ['b'], goneAt: '2026-11-01T00:00:00Z' } };
  assert.equal(releaseExhausted(employers, state, now), 1);
  assert.equal(state.g.next, Date.parse('2026-11-15T00:00:00Z'));
  assert.deepEqual(state.old.tried, []);
});

test('eures detail sweep: the TSV holds employer fields only, never the recruiter contacts', () => {
  const detail = structuredClone(DETAIL);
  const p = detail.jvProfiles[detail.preferredLanguage];
  p.personContacts = [{ givenName: 'Erika', familyName: 'Mustermann', email: 'erika.mustermann@example.org', phone: '+49 30 1234567' }];
  const item = { key: 'k', name: 'SimpleXX\tGmbH', website: 'http://www.go-simplexx.de', id: 'X1' };
  const state = { k: applyResult(undefined, item, { ok: true, detail }, Date.parse('2026-11-01T12:00:00Z')), f: { status: 'failed', name: 'F' } };
  const tsv = naceTsv(state);
  const [head, row, ...rest] = tsv.trimEnd().split('\n');
  assert.equal(head, TSV_HEADER.join('\t'));
  assert.equal(rest.length, 0, 'the failed employer has no row');
  assert.deepEqual(row.split('\t'), ['SimpleXX GmbH', 'http://www.go-simplexx.de', 'X1', 'o78.2.0', 'medium-sizedenterprise', '2026-11-01T12:00:00.000Z']);
  assert.doesNotMatch(tsv, /Mustermann|Erika|@example|1234567/);
  assert.doesNotMatch(JSON.stringify(state), /Mustermann|@example/, 'nor the state file');
});

test('eures detail sweep: euresDetail goes through the provider path and throws HTTP 404 for an expired vacancy', async (t) => {
  t.after(() => mock.restoreAll());
  euresLimiter.reset();
  const urls = [];
  mock.method(globalThis, 'fetch', async (url) => { urls.push(String(url)); return String(url).includes('/id/OLD') ? json({ errorType: 'NOT_FOUND' }, 404) : json(DETAIL); });
  const d = await euresDetail('MTAw+/x');
  assert.equal(urls[0], 'https://europa.eu/eures/api/jv-searchengine/public/jv/id/MTAw%2B%2Fx?requestLang=en');
  assert.deepEqual(employerFromDetail(d).sectorCodes, ['o78.2.0']);
  await assert.rejects(euresDetail('OLD'), /HTTP 404/);
  assert.equal(urls.length, 2, 'a 404 is not retried');
});

test('eures rate file: claims from any process are one gap apart; a stale mutex is taken over', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eures-rate-'));
  try {
    const file = join(dir, 'eures-rate.json');
    let clock = 1_000_000;
    const now = () => clock;
    assert.equal(await claimSharedSlot(file, 1000, now), 1_000_000, 'first claim: now');
    assert.equal(await claimSharedSlot(file, 1000, now), 1_001_000, 'second claim at the same instant: one gap later (reserved ahead)');
    assert.equal(await claimSharedSlot(file, 2000, now), 1_002_000, 'a third, from a process with a longer gap');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).nextAt, 1_004_000);
    clock = 2_000_000;
    assert.equal(await claimSharedSlot(file, 1000, now), 2_000_000, 'after a pause: now again');
    assert.equal(existsSync(`${file}.lock`), false, 'the mutex is released after each claim');
    // a crashed process left its mutex behind: older than 10 s, it is removed
    writeFileSync(`${file}.lock`, '99999');
    const old = new Date(Date.now() - 60e3);
    utimesSync(`${file}.lock`, old, old);
    const at = await claimSharedSlot(file, 1000);
    assert.ok(at >= Date.now() - 1000, 'the claim went through');
    // concurrent claims in one process (as two processes would interleave): all distinct, one gap apart
    writeFileSync(file, JSON.stringify({ nextAt: 0 }));
    clock = 3_000_000;
    const slots = await Promise.all([1, 2, 3, 4].map(() => claimSharedSlot(file, 500, now)));
    assert.deepEqual(slots.sort(), [3_000_000, 3_000_500, 3_001_000, 3_001_500]);
    // an unwritable location falls back to now: the in-process limiter still holds
    assert.equal(await claimSharedSlot(join(dir, 'missing', 'r.json'), 1000, now), 3_000_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('eures rate file: the limiter honours the shared file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'eures-rate-'));
  t.after(() => { setEuresRateFile(null); tuning.minGapMs = 0; mock.restoreAll(); rmSync(dir, { recursive: true, force: true }); });
  const file = join(dir, 'eures-rate.json');
  setEuresRateFile(file);
  tuning.minGapMs = 60;
  euresLimiter.reset();
  writeFileSync(file, JSON.stringify({ nextAt: Date.now() + 150, pid: 1 }));   // another process holds the next 150 ms
  const t0 = Date.now();
  await euresLimiter.acquire();
  assert.ok(Date.now() - t0 >= 140, `waited for the other process's slot (${Date.now() - t0} ms)`);
  await euresLimiter.acquire();
  assert.ok(Date.now() - t0 >= 200, 'then one gap more');
});
