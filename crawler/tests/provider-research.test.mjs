// Research-organisation portals (providers-research.mjs: mpg, desy, hzdr) on captured pages (crawler/tests/fixtures/research-*.html,
// 2026-11-06). No network: the fetch tests replace globalThis.fetch with a stub.   Run: node --test crawler/tests/provider-research.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providers, pageDescriptionOf, resolve } from '../providers.mjs';
import { parseMpgList, parseDesyList, parseHzdrList, mpgDate } from '../providers-research.mjs';

const text = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers ?? {} });
    return new Response(handler(String(url), opts), { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' } });
  };
  try { await fn(calls); } finally { globalThis.fetch = real; }
  return calls;
}

test('registry: mpg, desy and hzdr are registered and detected from their list URLs', () => {
  for (const id of ['mpg', 'desy', 'hzdr']) assert.ok(providers[id]?.fetch, id);
  assert.deepEqual(resolve({ careers_url: 'https://www.mpg.de/jobboard' }), { provider: 'mpg', slug: 'https://www.mpg.de/jobboard' });
  assert.equal(resolve({ careers_url: 'https://www.desy.de/career/job_offers/index_eng.html' })?.provider, 'desy');
  assert.equal(resolve({ careers_url: 'https://www.hzdr.de/db/!JobList?pNid=490' })?.provider, 'hzdr');
  assert.equal(providers.mpg.detect('https://www.mpg.de/27061716/scientist-engineer'), null, 'a posting page is not a board');
  assert.equal(providers.desy.detect('https://www.desy.de/'), null);
});

test('mpg: list items carry title, URL, city, institute and the posting date', () => {
  assert.equal(mpgDate('October 29, 2026'), '2026-10-29');
  assert.equal(mpgDate('29.10.2026'), '');
  const jobs = parseMpgList(text('research-mpg-more_items.html'));
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs[0], {
    title: 'Scientist/Engineer (m/f/d) in Automated Biology',
    url: 'https://www.mpg.de/27061716/scientist-engineer-m-f-d-in-automated-biology',
    location: 'Dresden',
    department: 'Max Planck Institute of Molecular Cell Biology and Genetics',
    postedAt: '2026-10-29',
  });
  assert.equal(jobs[2].location, 'Köln');
  const page = parseMpgList(text('research-mpg-jobboard.html'));
  assert.equal(page.length, 2);
  assert.equal(page[0].postedAt, '2026-11-05');
  assert.equal(page[1].department, 'Max Planck Institute of Geoanthropology');
});

test('mpg: fetch walks more_items as XHR from offset 5 until a short page, deduplicated by URL', async () => {
  const board = text('research-mpg-jobboard.html'), frag = text('research-mpg-more_items.html');
  let jobs;
  const calls = await withFetch((url) => (url.includes('more_items') ? (url.includes('offset=5&') ? frag : '<ul></ul>') : board),
    async () => { jobs = await providers.mpg.fetch('https://www.mpg.de/jobboard', {}); });
  assert.deepEqual(calls.map((c) => c.url), [
    'https://www.mpg.de/jobboard',
    'https://www.mpg.de/jobboard/115824/more_items?offset=5&limit=20&region=&subject=&job_type=',
  ], 'a fragment with fewer than 20 items ends the walk');
  assert.equal(calls[1].headers['x-requested-with'], 'XMLHttpRequest', 'without the XHR header mpg.de answers 303');
  assert.equal(jobs.length, 5);
  assert.equal(new Set(jobs.map((j) => j.url)).size, 5);
  // a posting page: JobPosting JSON-LD gives the description through the generic fallback
  const d = pageDescriptionOf(text('research-mpg-job.html'), { url: jobs[0].url });
  assert.ok(d.length > 2000 && d.startsWith('The newly established Automated Biology Facility'), d.slice(0, 80));
});

test('desy: table rows map to jobs with date, record URL, location and reference', () => {
  const jobs = parseDesyList(text('research-desy-list.html'));
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs[0], {
    title: 'Project Manager of the PUNCH4NFDI Consortium in the NFDI',
    url: 'https://v22.desy.de/e67416/records327372/index_eng.html',
    location: 'Hamburg',
    department: 'Wissenschaft / Berufserfahrene',
    postedAt: '2026-11-06',
    reference: 'FHMA031/2026',
  });
  assert.equal(jobs[1].location, 'Zeuthen');
  assert.equal(jobs[2].title, 'Cyber Security Architektin (w/m/d)');
  assert.deepEqual(parseDesyList('<table><tr><td>no rows</td></tr></table>'), []);
});

test('desy: fetch reads the slug URL once', async () => {
  let jobs;
  const calls = await withFetch(() => text('research-desy-list.html'), async () => { jobs = await providers.desy.fetch('https://www.desy.de/career/job_offers/index_eng.html'); });
  assert.deepEqual(calls.map((c) => c.url), ['https://www.desy.de/career/job_offers/index_eng.html']);
  assert.equal(jobs.length, 3);
});

test('hzdr: cJob blocks map to jobs through the English title link; the detail page has JobPosting JSON-LD', async () => {
  const jobs = parseHzdrList(text('research-hzdr-joblist.html'));
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].title, 'Scientific Employee - Group leader High Performance Computing (f/m/d)');
  assert.equal(jobs[0].url, 'https://www.hzdr.de/db/Cms?pNid=490&pOid=79056&pContLang=en');
  assert.equal(jobs[0].location, 'Dresden-Rossendorf');
  assert.match(jobs[0].teaser, /^Scientific Employee - Group leader/);
  assert.match(jobs[2].title, /^PhD Student \(f\/m\/d\) Dynamic Modeling/);
  let fetched;
  const calls = await withFetch(() => text('research-hzdr-joblist.html'), async () => { fetched = await providers.hzdr.fetch('https://www.hzdr.de/db/!JobList?pNid=490'); });
  assert.equal(calls.length, 1);
  assert.equal(fetched.length, 3);
  const d = pageDescriptionOf(text('research-hzdr-job.html'), { url: jobs[0].url });
  assert.ok(d.length > 1500 && /Helmholtz-Zentrum Dresden-Rossendorf/.test(d), d.slice(0, 80));
});
