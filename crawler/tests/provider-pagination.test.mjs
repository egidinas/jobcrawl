// Fixed page limits removed (coordinator 2026-11-24 audit): Dover and Dassault read every page; a stop by the safety limit is a partial
// answer (never a gone signal). No network: fetch is stubbed.   Run: node --test crawler/tests/provider-pagination.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { providers, PAGE_CAP, DASSAULT_MAX_PAGES } from '../providers.mjs';

async function withFetch(handler, fn) {
  const real = globalThis.fetch, realTimeout = globalThis.setTimeout;
  const asked = [];
  globalThis.fetch = async (url) => { asked.push(String(url)); return handler(new URL(String(url))); };
  globalThis.setTimeout = (cb, ...rest) => realTimeout(cb, 0, ...rest.slice(1));   // the providers' polite page sleeps, without the wait
  try { return await fn(asked); } finally { globalThis.fetch = real; globalThis.setTimeout = realTimeout; }
}
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const xml = (t) => new Response(t, { status: 200, headers: { 'content-type': 'text/xml' } });

test('dover: follows next pages past the old 1,500 and stops when next is empty', async () => {
  const total = 1900;
  await withFetch((u) => {
    const off = Number(u.searchParams.get('offset')), n = Math.max(0, Math.min(300, total - off));
    return json({ results: Array.from({ length: n }, (_, i) => ({ id: `j${off + i}`, title: `Role ${off + i}` })), next: off + 300 < total ? 'more' : null });
  }, async () => {
    const jobs = await providers.dover.fetch('acme|00000000-0000-0000-0000-000000000000');
    assert.equal(jobs.length, total);
    assert.equal(jobs.incomplete, undefined);
  });
});

test('dover: a next page at the safety stop is a partial answer', async () => {
  await withFetch(() => json({ results: [{ id: 'x', title: 'Role' }], next: 'more' }), async (asked) => {
    const jobs = await providers.dover.fetch('acme|00000000-0000-0000-0000-000000000000');
    assert.equal(asked.length, PAGE_CAP);
    assert.match(jobs.incomplete.note, /page stop/);
  });
});

const hit = (i) => `<Hit ><Meta name="content_title"><MetaString>Role ${i}</MetaString></Meta>`
  + `<Meta name="content_cta_1_url"><MetaString>/careers/job/${i}</MetaString></Meta>`
  + `<Meta name="content_categories"><MetaString>City/Paris Country/France</MetaString></Meta></Hit>`;

test('dassault: reads every page past the old 500 cards and ends on an empty page', async () => {
  const total = 690;
  await withFetch((u) => {
    const start = Number(u.searchParams.get('start')), n = Math.max(0, Math.min(10, total - start));
    return xml('<Answer>' + Array.from({ length: n }, (_, i) => hit(start + i)).join('') + '</Answer>');
  }, async () => {
    const jobs = await providers.dassault.fetch();
    assert.equal(jobs.length, total);
    assert.equal(jobs.incomplete, undefined);
  });
});

test('dassault: the safety stop is a partial answer', async () => {
  await withFetch((u) => xml('<Answer>' + Array.from({ length: 10 }, (_, i) => hit(Number(u.searchParams.get('start')) + i)).join('') + '</Answer>'), async (asked) => {
    const jobs = await providers.dassault.fetch();
    assert.equal(asked.length, DASSAULT_MAX_PAGES);
    assert.match(jobs.incomplete.note, /page stop/);
  });
});
