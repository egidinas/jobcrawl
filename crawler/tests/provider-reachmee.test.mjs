// ReachMee provider on captured pages (Andøya Space, I010/2575, 2026-11-07; the embed validator replaced by a placeholder).
// No network: fetch is stubbed.   Run: node --test crawler/tests/provider-reachmee.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providers, reachmeeRows } from '../providers.mjs';

const text = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const SLUG = 'https://web103.reachmee.com/ext/I010/2575/main?site=6&validator=FIXTUREVALIDATOR&lang=NO';

test('reachmee: detect takes the embedded main URL and drops the job-page parameters', () => {
  const page = `<a href="https://web103.reachmee.com/ext/I010/2575/main?site=6&amp;validator=FIXTUREVALIDATOR&amp;lang=NO&amp;rmpage=job&amp;rmjob=7">x</a>`;
  assert.equal(providers.reachmee.detect(page), SLUG);
  assert.equal(providers.reachmee.detect('https://example.org/careers'), null);
});

test('reachmee: the list table gives title, absolute job URL, place and deadline per row', () => {
  const rows = reachmeeRows(text('reachmee-list.html'), 'https://web103.reachmee.com');
  assert.ok(rows.length >= 4, `rows ${rows.length}`);
  const r = rows.find((x) => x.url.includes('job_id=102'));
  assert.equal(r.title, 'Administrative Coordinator');
  assert.equal(r.location, 'Andøy');
  assert.equal(r.validThrough, '2026-11-15');
  assert.match(r.url, /^https:\/\/web103\.reachmee\.com\/ext\/I010\/2575\/job\?site=6&lang=NO&validator=FIXTUREVALIDATOR&job_id=102$/);
});

test('reachmee: fetch reads the list page; fetchDescription reads the ad body; a slug without validator is refused', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(String(url).includes('/job?') ? text('reachmee-job.html') : text('reachmee-list.html'), { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
  try {
    const jobs = await providers.reachmee.fetch(SLUG);
    assert.ok(jobs.length >= 4);
    const d = await providers.reachmee.fetchDescription(jobs[0]);
    assert.ok(d.length > 50, d.slice(0, 80));
    await assert.rejects(providers.reachmee.fetch('https://web103.reachmee.com/ext/I010/2575/main?site=6&lang=NO'), /bad slug/);
  } finally { globalThis.fetch = real; }
});
