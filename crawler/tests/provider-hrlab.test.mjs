// hrlab on recorded pages (2026-11-28): HOLM list + one posting, Swagelok B.E.S.T. list. No network: fetch is stubbed.
// Run: node --test crawler/tests/provider-hrlab.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providers, parseHrlabList, parseHrlabJob } from '../providers.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

test('hrlab: detect keeps the tenant slug for any language path', () => {
  assert.equal(providers.hrlab.detect('https://app.hrlab.de/en/jobs/holm'), 'holm');
  assert.equal(providers.hrlab.detect('https://app.hrlab.de/de/jobs/karriere-best-fs/10435'), 'karriere-best-fs');
  assert.equal(providers.hrlab.detect('https://example.com/jobs/holm'), null);
});

test('hrlab: list cards give title and id; a title with " - " stays whole and no place is invented', () => {
  const rows = parseHrlabList(fx('hrlab-holm-list.html'), 'holm');
  assert.equal(rows.length, 3);
  assert.equal(rows[2].title, 'Werkstudenten (m/w/d) - Themen der Logistik & Mobilität - Eigenes Aufgabengebiet');
  assert.equal(rows[1].url, 'https://app.hrlab.de/en/jobs/holm/10782');
  assert.ok(rows.every((r) => r.location === ''));
  const best = parseHrlabList(fx('hrlab-best-list.html'), 'karriere-best-fs');
  assert.equal(best.length, 3);
  assert.equal(best[0].title, 'Customer Service Agent (m/w/d)');
  assert.equal(best[0].note, 'Full-time - Garching bei München - Hybrid');
});

test('hrlab: posting page gives place, date and text', () => {
  const j = parseHrlabJob(fx('hrlab-holm-job.html'));
  assert.equal(j.location, 'Frankfurt am Main');
  assert.equal(j.postedAt, '2026-10-29');
  assert.match(j.description, /Gateway Gardens/);
  assert.doesNotMatch(j.description, /Apply now/);
});

test('hrlab: fetch joins list and detail pages', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/\/jobs\/holm$/.test(u)) return new Response(fx('hrlab-holm-list.html'), { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response(fx('hrlab-holm-job.html'), { status: 200, headers: { 'content-type': 'text/html' } });
  };
  try {
    const jobs = await providers.hrlab.fetch('holm', {});
    assert.equal(jobs.length, 3);
    assert.equal(jobs[0].location, 'Frankfurt am Main');
    assert.equal(jobs[0].postedAt, '2026-10-29');
  } finally { globalThis.fetch = real; }
});
