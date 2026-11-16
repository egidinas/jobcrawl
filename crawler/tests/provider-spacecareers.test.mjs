// Space-Careers provider on a saved, trimmed listing (2026-11-16: two card layouts, sidebar with "Jobs by Location").
// No network: fetch is stubbed.   Run: node --test crawler/tests/provider-spacecareers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providers, parseSpaceCareers, spaceCareersDate, spaceCareersLocationLinks } from '../providers.mjs';

const html = readFileSync(new URL('./fixtures/spacecareers-listing.html', import.meta.url), 'utf8');

test('parses both card layouts with company, location and date', () => {
  const jobs = parseSpaceCareers(html, new Date('2026-11-16T10:00:00Z'));
  assert.equal(jobs.length, 4);
  const orqa = jobs.find((j) => j.company === 'Orqa' && j.title === 'Electric Motor Tech Lead');
  assert.equal(orqa.location, 'Osijek, Croatia');
  assert.equal(orqa.url, 'https://www.space-careers.com/job_display/298888/Electric_Motor_Tech_Lead_Orqa_Osijek_Croatia');
  assert.equal(orqa.postedAt, '2026-11-10');
  assert.ok(jobs.every((j) => j.title && j.company && j.location && j.url));
});

test('relative dates', () => {
  const now = new Date('2026-11-16T10:00:00Z');
  assert.equal(spaceCareersDate('today', now), '2026-11-16');
  assert.equal(spaceCareersDate('yesterday', now), '2026-11-15');
  assert.equal(spaceCareersDate('2 weeks ago', now), '2026-11-02');
  assert.equal(spaceCareersDate('', now), '');
});

test('location links come only from the Jobs by Location block', () => {
  const links = spaceCareersLocationLinks(html);
  assert.equal(links.length, 17);
  assert.ok(links.includes('/jobs/germany') && !links.includes('/jobs/defence'));
});

test('board entry reads the listing and every location page, joins by url, and tags the board', async () => {
  const real = globalThis.fetch; const real_warn = console.warn; const asked = [];
  globalThis.fetch = async (u) => { asked.push(String(u)); return new Response(html, { status: 200 }); };
  try {
    const jobs = await providers.spacecareers.fetch('space-careers', { pauseMs: 0 });
    assert.equal(jobs.length, 4);                  // every page is the same fixture: joined by url
    assert.equal(asked.length, 18);                // listing + 17 locations
    assert.ok(jobs.every((j) => j.company.endsWith(' (via Space-Careers)')));
  } finally { globalThis.fetch = real; console.warn = real_warn; }
});

test('watch entry uses the keyword path and filters by company', async () => {
  const real = globalThis.fetch; const asked = [];
  globalThis.fetch = async (u) => { asked.push(String(u)); return new Response(html, { status: 200 }); };
  try {
    const jobs = await providers.spacecareers.fetch('orqa-watch', { queries: ['Orqa'] });
    assert.deepEqual(asked, ['https://www.space-careers.com/job_search/keyword/orqa']);
    assert.equal(jobs.length, 2);
  } finally { globalThis.fetch = real; }
});

test('an empty page warns with status, url and size instead of staying silent', async () => {
  const real = globalThis.fetch; const real_warn = console.warn; const warned = [];
  globalThis.fetch = async () => new Response('<html>consent</html>', { status: 200 });
  console.warn = (m) => warned.push(m);
  try {
    const jobs = await providers.spacecareers.fetch('space-careers', {});
    assert.equal(jobs.length, 0);
    assert.ok(warned.some((m) => /0 jobs parsed from https:\/\/www\.space-careers\.com\/job_search \(HTTP 200, 20 bytes/.test(m)), warned.join('|'));
  } finally { globalThis.fetch = real; console.warn = real_warn; }
});
