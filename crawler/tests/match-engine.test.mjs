// "Find roles": which engine answers (web/assets/match.js askService, pickServiceItems). No network: fetch is a stub.
// Run: node --test crawler/tests/match-engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { askService, pickServiceItems, servicePicks, SERVICE_MAX_CHARS } from '../../web/assets/match.js';

const SVC = { url: '/api/v1/next-role', regionScope: { 'Munich & Bavaria': 'bavaria', 'Germany (Other)': 'germany', Europe: 'europe' } };
const TEXT = 'Senior thermal engineer, 9 years in space. Thermal vacuum testing. Fictional example.';
const item = (sid, region, extra = {}) => ({ sid, job_id: sid.repeat(2), title: 'Role ' + sid, company: 'Co ' + sid, company_slug: 'co-' + sid, region, level: 'senior', ...extra });
const LIST = [item('a1', 'Europe'), item('b2', 'Munich & Bavaria'), item('c3', 'United States'), item('d4', 'Germany (Other)')];
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function stub(answer) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return answer(init); };
  return { fn, calls };
}

test('service answers: one POST with the text in the body, never in the URL', async () => {
  const s = stub(() => json(200, { list: LIST }));
  const a = await askService(SVC, TEXT, { lang: 'de', fetchFn: s.fn });
  assert.equal(a.engine, 'service');
  assert.equal(a.items.length, 4);
  assert.equal(s.calls.length, 1);
  const c = s.calls[0];
  assert.equal(c.url, '/api/v1/next-role');
  assert.ok(!c.url.includes('?'), 'no query string');
  assert.equal(c.init.method, 'POST');
  assert.deepEqual(JSON.parse(c.init.body), { entry: 'cv', cv_text: TEXT, lang: 'de' });
  assert.ok(!c.url.includes('thermal'));
});

test('a text longer than the route allows is cut on the client', async () => {
  const s = stub(() => json(200, { list: LIST }));
  await askService(SVC, 'x'.repeat(SERVICE_MAX_CHARS + 500), { fetchFn: s.fn });
  assert.equal(JSON.parse(s.calls[0].init.body).cv_text.length, SERVICE_MAX_CHARS);
});

test('service slow: no answer within the limit -> fallback (timeout), the request is aborted', async () => {
  let aborted = false;
  const fn = (url, init) => new Promise((ok, no) => { init.signal.addEventListener('abort', () => { aborted = true; no(new DOMException('aborted', 'AbortError')); }); });
  const t0 = Date.now();
  const a = await askService(SVC, TEXT, { fetchFn: fn, firstMs: 150 });
  assert.deepEqual(a, { engine: 'fallback', why: 'timeout' });
  assert.ok(aborted);
  assert.ok(Date.now() - t0 < 1000);
});

test('service unreachable -> fallback (network)', async () => {
  const a = await askService(SVC, TEXT, { fetchFn: async () => { throw new TypeError('Failed to fetch'); } });
  assert.deepEqual(a, { engine: 'fallback', why: 'network' });
});

test('service 5xx -> fallback, sent once (no retry: each request counts against the quota)', async () => {
  for (const code of [500, 502, 503, 504]) {
    const s = stub(() => json(code, { error: 'the next-role service is temporarily unavailable' }));
    const a = await askService(SVC, TEXT, { fetchFn: s.fn });
    assert.deepEqual(a, { engine: 'fallback', why: 'http ' + code });
    assert.equal(s.calls.length, 1);
  }
});

test('daily limit (429) is answered as such, no silent fallback', async () => {
  const s = stub(() => json(429, { error: 'daily limit' }, { 'retry-after': '3600' }));
  const a = await askService(SVC, TEXT, { fetchFn: s.fn });
  assert.deepEqual(a, { engine: 'limit', status: 429, retryAfter: 3600 });
  assert.equal(s.calls.length, 1);
});

test('a refused text (400, 413) is answered as such', async () => {
  for (const code of [400, 413]) {
    const a = await askService(SVC, TEXT, { fetchFn: async () => json(code, { error: 'refused' }) });
    assert.deepEqual(a, { engine: 'refused', status: code });
  }
});

test('a login page, an empty list or no list -> fallback', async () => {
  const html = await askService(SVC, TEXT, { fetchFn: async () => new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  assert.deepEqual(html, { engine: 'fallback', why: 'not json' });
  const empty = await askService(SVC, TEXT, { fetchFn: async () => json(200, { list: [] }) });
  assert.deepEqual(empty, { engine: 'fallback', why: 'empty' });
  const other = await askService(SVC, TEXT, { fetchFn: async () => json(403, { error: 'forbidden' }) });
  assert.deepEqual(other, { engine: 'fallback', why: 'http 403' });
});

test('on-device chosen or no service on the page: nothing is sent', async () => {
  const s = stub(() => json(200, { list: LIST }));
  const a = await askService(null, TEXT, { fetchFn: s.fn });
  assert.equal(a.engine, 'fallback');
  assert.equal(s.calls.length, 0);
});

test('picks: Where by the region (as the browser index scope bits), level range, cap per employer', () => {
  const scopeIds = ['bavaria', 'germany', 'europe', 'worldwide'], levelCodes = ['', 'student', 'entry', 'mid', 'senior', 'lead', 'exec'];
  const de = pickServiceItems(LIST, { scope: 1, scopeIds, regionScope: SVC.regionScope, levelCodes });
  assert.deepEqual(de.shown.map((x) => x.sid), ['b2', 'd4']);
  assert.deepEqual(de.outside.map((x) => x.sid), ['a1', 'c3']);
  const by = pickServiceItems(LIST, { scope: 0, scopeIds, regionScope: SVC.regionScope, levelCodes });
  assert.deepEqual(by.shown.map((x) => x.sid), ['b2']);
  const eu = pickServiceItems(LIST, { scope: 2, scopeIds, regionScope: SVC.regionScope, levelCodes });
  assert.deepEqual(eu.shown.map((x) => x.sid), ['a1', 'b2', 'd4']);
  const ww = pickServiceItems(LIST, { scope: 3, scopeIds, regionScope: SVC.regionScope, levelCodes });
  assert.equal(ww.shown.length, 4);
  // level: senior is 4; from lead (5) drops all, up to mid (3) drops all, an unknown level counts as 0
  assert.equal(pickServiceItems(LIST, { scope: 3, scopeIds, levelCodes, minLevel: 5 }).shown.length, 0);
  assert.equal(pickServiceItems(LIST, { scope: 3, scopeIds, levelCodes, maxLevel: 3 }).shown.length, 0);
  assert.equal(pickServiceItems([item('e5', 'Europe', { level: null })], { scope: 3, scopeIds, levelCodes, minLevel: 1 }).shown.length, 0);
  // cap: two roles of one employer with a cap of 1
  const two = [item('f6', 'Europe', { company_slug: 'same' }), item('g7', 'Europe', { company_slug: 'same' })];
  const cap = pickServiceItems(two, { scope: 3, scopeIds, levelCodes, perEmployer: 1 });
  assert.deepEqual([cap.shown.length, cap.capped], [1, 1]);
  // the rows outside Where keep the cap too (24 Nov: one employer three times in the list below the heading)
  const three = [item('h8', 'United States', { company_slug: 'io' }), item('i9', 'United States', { company_slug: 'io' }), item('j0', 'United States', { company_slug: 'io' })];
  const outCap = pickServiceItems(three, { scope: 1, scopeIds, regionScope: SVC.regionScope, levelCodes, perEmployer: 2 });
  assert.deepEqual([outCap.shown.length, outCap.outside.length, outCap.capped], [0, 2, 1]);
});

test('the picks go to the service in the POST body; what it applied comes back', async () => {
  const scopeIds = ['bavaria', 'germany', 'europe', 'worldwide'];
  assert.deepEqual(servicePicks(0, scopeIds, SVC.regionScope), ['Munich & Bavaria']);
  assert.deepEqual(servicePicks(1, scopeIds, SVC.regionScope), ['Munich & Bavaria', 'Germany (Other)']);
  assert.deepEqual(servicePicks(2, scopeIds, SVC.regionScope), ['Munich & Bavaria', 'Germany (Other)', 'Europe']);
  assert.deepEqual(servicePicks(3, scopeIds, SVC.regionScope), []);
  const applied = { applied: true, regions: ['Munich & Bavaria', 'Germany (Other)'], k: 30, scope: 'in', in_pick: 8682 };
  const s = stub(() => json(200, { list: LIST, picks: applied }));
  const a = await askService(SVC, TEXT, { fetchFn: s.fn, picks: { regions: servicePicks(1, scopeIds, SVC.regionScope), scope: 'in', k: 30 } });
  assert.deepEqual(JSON.parse(s.calls[0].init.body), { entry: 'cv', cv_text: TEXT, lang: 'en', regions: ['Munich & Bavaria', 'Germany (Other)'], scope: 'in', k: 30 });
  assert.ok(!s.calls[0].url.includes('?'));
  assert.deepEqual(a.picks, applied);
  // worldwide: no regions in the body
  const w = stub(() => json(200, { list: LIST }));
  const b = await askService(SVC, TEXT, { fetchFn: w.fn, picks: { regions: [], scope: 'in', k: 30 } });
  assert.deepEqual(JSON.parse(w.calls[0].init.body), { entry: 'cv', cv_text: TEXT, lang: 'en', scope: 'in', k: 30 });
  assert.equal(b.picks, null, 'an older Worker or NUC: no picks in the answer, the panel filters itself');
});
