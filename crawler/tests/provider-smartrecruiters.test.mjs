// SmartRecruiters provider: pagination to the stated total and the page-cap rule (live check 2026-11-23: boards answering exactly 500 on
// every fetch while the postings beyond it stayed live). No network: fetch is stubbed.   Run: node --test crawler/tests/provider-smartrecruiters.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { providers, SR_MAX_PAGES } from '../providers.mjs';
import { isCappedAnswer, CAPPED_COUNTS } from '../resilience.mjs';

async function withBoard(total, fn) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const u = new URL(String(url));
    const offset = Number(u.searchParams.get('offset') ?? 0), limit = Number(u.searchParams.get('limit') ?? 100);
    const n = Math.max(0, Math.min(limit, total - offset));
    const content = Array.from({ length: n }, (_, i) => ({ id: String(offset + i), name: `Role ${offset + i}`, location: { city: 'Stuttgart', country: 'de' } }));
    return new Response(JSON.stringify({ totalFound: total, content }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try { return await fn(asked); } finally { globalThis.fetch = real; }
}

test('smartrecruiters: follows offset pages to the stated total (more than the old fixed 500)', async () => {
  await withBoard(1234, async (asked) => {
    const jobs = await providers.smartrecruiters.fetch('BoschGroup');
    assert.equal(jobs.length, 1234);
    assert.equal(new Set(jobs.map((j) => j.url)).size, 1234);
    assert.equal(asked.length, 13);
    assert.equal(jobs.incomplete, undefined);
  });
});

test('smartrecruiters: a small board stops at its total; reaching the safety stop is a partial answer', async () => {
  await withBoard(37, async (asked) => {
    const jobs = await providers.smartrecruiters.fetch('Small');
    assert.equal(jobs.length, 37);
    assert.equal(asked.length, 1);
    assert.equal(jobs.incomplete, undefined);
  });
  await withBoard(SR_MAX_PAGES * 100 + 50, async () => {
    const jobs = await providers.smartrecruiters.fetch('Huge');
    assert.equal(jobs.length, SR_MAX_PAGES * 100);
    assert.match(jobs.incomplete.note, /page stop/);
  });
});

test('capped answer: exactly a page cap is partial; other sizes are not', () => {
  for (const n of CAPPED_COUNTS) assert.equal(isCappedAnswer(n), true);
  for (const n of [0, 1, 37, 499, 501, 1234]) assert.equal(isCappedAnswer(n), false);
});
