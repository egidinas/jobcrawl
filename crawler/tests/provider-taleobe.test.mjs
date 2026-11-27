// Taleo Business Edition (taleobe) on two recorded search pages of org=SONACA cws=38 (2026-11-27): 10 + 2 rows, the second page in
// the session the first one set. No network: fetch is stubbed.   Run: node --test crawler/tests/provider-taleobe.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providers } from '../providers.mjs';
import { taleoBeConfig, taleoBeBoard, parseTaleoBe } from '../providers-extra.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const BOARD = 'https://lde.tbe.taleo.net/lde01/ats/careers/v2/searchResults?org=SONACA&cws=38';

test('taleobe: board URL forms, detect on careers and requisition links', () => {
  assert.deepEqual(taleoBeConfig(BOARD), { base: 'https://lde.tbe.taleo.net/lde01/ats/careers/v2', org: 'SONACA', cws: '38' });
  assert.equal(taleoBeBoard('https://lde.tbe.taleo.net/lde01/ats/careers/v2/viewRequisition?org=SONACA&amp;cws=38&rid=1007'), BOARD);
  assert.equal(providers.taleobe.detect('https://lde.tbe.taleo.net/lde01/ats/careers/v2/searchResults?org=SONACA&#038;cws=38'), BOARD);
  assert.equal(taleoBeConfig('https://evil.example/lde01/ats/careers/v2/searchResults?org=X&cws=1'), null);
  assert.equal(providers.taleobe.detect('https://chp.tbe.taleo.net/chp04/ats/careers/requisition.jsp?org=X'), null);
});

test('taleobe: rows with title, place and a stable requisition URL; named entities decoded', () => {
  const rows = parseTaleoBe(fx('taleobe-page1.html'), taleoBeConfig(BOARD));
  assert.equal(rows.length, 10);
  assert.equal(rows[0].title, 'Account Manager (M/F)');
  assert.equal(rows[0].location, 'BELGIUM');
  assert.equal(rows[0].url, 'https://lde.tbe.taleo.net/lde01/ats/careers/v2/viewRequisition?org=SONACA&cws=38&rid=1007');
  assert.ok(rows.some((r) => r.title === "Chef d'équipe"), rows.map((r) => r.title).join(' | '));
});

test('taleobe: fetch pages in the session of the first answer until a page adds nothing', async () => {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    asked.push({ u, cookie: new Headers(init.headers ?? {}).get('cookie') });
    if (u.includes('org=SONACA')) return new Response(fx('taleobe-page1.html'), { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8', 'set-cookie': 'JSESSIONID=s1; Path=/' } });
    if (u.includes('rowFrom=10')) return new Response(fx('taleobe-page2.html'), { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' } });
    return new Response(fx('taleobe-page2.html'), { status: 200 });   // a page past the end repeats rows: no fresh row ends the walk
  };
  try {
    const jobs = await providers.taleobe.fetch(BOARD, {});
    assert.equal(jobs.length, 12);
    assert.equal(asked[1].cookie, 'JSESSIONID=s1');
    assert.ok(asked.length <= 3);
  } finally { globalThis.fetch = real; }
});
