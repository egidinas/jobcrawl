// workday: entry.workday_session reads the board page once and sends its cookies with origin and referer on the search API calls
// (opt-in; without it the requests are unchanged). No network: fetch is stubbed.
// Run: node --test crawler/tests/provider-workday-session.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { providers } from '../providers.mjs';

async function withStub(fn) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const h = new Headers(init.headers ?? {});
    asked.push({ u, method: init.method ?? 'GET', cookie: h.get('cookie'), referer: h.get('referer') });
    if (!u.includes('/wday/cxs/')) return new Response('<html></html>', { status: 200, headers: { 'set-cookie': 'PLAY_SESSION=p1; Path=/' } });
    return new Response(JSON.stringify({ total: 1, facets: [], jobPostings: [{ title: 'Record to Report Analyst', externalPath: '/job/INSURGENTES/Record-to-Report-Analyst_REQ-1', locationsText: 'INSURGENTES', postedOn: 'Posted Today' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try { return await fn(asked); } finally { globalThis.fetch = real; }
}

test('workday_session: one page read, then the API with the page cookie, origin and referer', async () => {
  await withStub(async (asked) => {
    const jobs = await providers.workday.fetch('novartis|wd3|Novartis_Careers', { workday_session: true });
    assert.equal(jobs.length, 1);
    assert.equal(asked[0].u, 'https://novartis.wd3.myworkdayjobs.com/Novartis_Careers');
    const api = asked.find((a) => a.u.includes('/wday/cxs/'));
    assert.equal(api.cookie, 'PLAY_SESSION=p1');
    assert.equal(api.referer, 'https://novartis.wd3.myworkdayjobs.com/Novartis_Careers');
  });
});

test('without workday_session the API is called directly, without cookies', async () => {
  await withStub(async (asked) => {
    await providers.workday.fetch('novartis|wd3|Novartis_Careers', {});
    assert.ok(asked[0].u.includes('/wday/cxs/'));
    assert.equal(asked[0].cookie, null);
  });
});
