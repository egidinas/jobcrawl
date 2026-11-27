// oraclecloud: entry.oracle_keyword narrows a large tenant to the site's own keyword search. No network: fetch is stubbed.
// Run: node --test crawler/tests/provider-oraclecloud-keyword.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { providers } from '../providers.mjs';

async function withStub(fn) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const body = { items: [{ TotalJobsCount: 1, requisitionList: [{ Id: '129450', Title: 'Systems Engineer I (M/F/D)', PrimaryLocation: 'Brno-Mesto, Czech Republic', PostedDate: '2026-11-24' }] }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try { return await fn(asked); } finally { globalThis.fetch = real; }
}

test('oraclecloud: oracle_keyword goes into the finder; without it the finder is unchanged', async () => {
  await withStub(async (asked) => {
    const jobs = await providers.oraclecloud.fetch('https://x.fa.ocs.oraclecloud.com|Aerospace', { oracle_keyword: 'Brno' });
    assert.ok(asked[0].includes('finder=findReqs;siteNumber=Aerospace,limit=200,offset=0,keyword=Brno&'), asked[0]);
    assert.equal(jobs[0].location, 'Brno-Mesto, Czech Republic');
  });
  await withStub(async (asked) => {
    await providers.oraclecloud.fetch('https://x.fa.ocs.oraclecloud.com|Aerospace', {});
    assert.ok(asked[0].includes('finder=findReqs;siteNumber=Aerospace,limit=200,offset=0&'), asked[0]);
  });
});
