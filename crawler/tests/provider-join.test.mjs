// JOIN (join.com) provider on synthetic company pages in the shapes seen on 2026-11-06/07 (crawler audit finding 2: the provider
// reported 0 jobs as success on 15 of 38 live boards after join.com moved its data from pageProps.initialState to pageData).
// No network: fetch is stubbed.   Run: node --test crawler/tests/provider-join.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { providers } from '../providers.mjs';

const item = (id, title, city = 'Weißensberg', country = 'Germany') => ({
  idParam: `${id}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, id, title, createdAt: '2026-10-01T10:10:37.647Z',
  workplaceType: 'ONSITE', city: { cityName: city, countryName: country }, category: { name: 'Engineering' }, country: { iso3166: 'DE' },
});
const jobsBlock = (items, { page = 1, pageCount = items.length ? 1 : 0, facets = items.length } = {}) => ({
  items, pagination: { page, pageCount, pageSize: items.length, perPage: 5, total: items.length + 1 },
  aggregations: facets ? [{ name: 'categoryId', values: [{ value: '1', label: 'Engineering', count: facets }] }] : [],
});
const companyPage = (pageProps) => `<!doctype html><html><body><div id="__next"></div>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps }, page: '/companies/[companyDomain]' })}</script></body></html>`;
const pageData = (jobs) => companyPage({ locale: 'en', pageData: { job: null, jobs, company: { domain: 'acme' } } });

async function withPages(pages, fn) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const p = Number(new URL(String(url)).searchParams.get('page') ?? 1);
    const body = pages[p - 1];
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  try { return await fn(asked); } finally { globalThis.fetch = real; }
}

test('join: detect takes the company slug', () => {
  assert.equal(providers.join.detect('https://join.com/companies/acme'), 'acme');
  assert.equal(providers.join.detect('https://join.com/companies/acme/jobs/123-x'), 'acme');
  assert.equal(providers.join.detect('https://example.org/careers'), null);
});

test('join: pageData shape, pages followed by pageCount, one row per posting with place and date', async () => {
  const p1 = pageData(jobsBlock([item(1, 'Systems Engineer'), item(2, 'Test Engineer')], { pageCount: 2 }));
  const p2 = pageData(jobsBlock([item(3, 'Optics Engineer', 'Wien', 'Austria')], { page: 2, pageCount: 2 }));
  await withPages([p1, p2], async (asked) => {
    const jobs = await providers.join.fetch('acme');
    assert.deepEqual(asked, ['https://join.com/companies/acme', 'https://join.com/companies/acme?page=2']);
    assert.equal(jobs.length, 3);
    const { postedAt, ...first } = jobs[0];
    assert.deepEqual(first, { title: 'Systems Engineer', url: 'https://join.com/companies/acme/jobs/1-systems-engineer', location: 'Weißensberg, Germany', department: 'Engineering' });
    assert.equal(postedAt.slice(0, 10), '2026-10-01', 'createdAt as the posting date (crawl.mjs keeps the day)');
    assert.equal(jobs[2].location, 'Wien, Austria');
  });
});

test('join: the older initialState shape is still read', async () => {
  const page = companyPage({ initialState: { jobs: jobsBlock([item(7, 'Avionics Engineer')]) } });
  await withPages([page], async () => {
    const jobs = await providers.join.fetch('acme');
    assert.deepEqual(jobs.map((j) => j.title), ['Avionics Engineer']);
  });
});

test('join: an empty board (pageCount 0, no facet counts) is 0 jobs, not an error', async () => {
  await withPages([pageData(jobsBlock([]))], async () => {
    assert.deepEqual(await providers.join.fetch('acme'), []);
  });
});

test('join: a live board that lists nothing, or a page without the data, is a failure, never "0 jobs"', async () => {
  // pageCount 1 but no item: the parser no longer fits the page
  await withPages([pageData(jobsBlock([], { pageCount: 1, facets: 0 }))], async () => {
    await assert.rejects(providers.join.fetch('acme'), /reports postings \(pageCount 1, facet count 0\) but lists none/);
  });
  // facets count postings although pageCount says 0
  await withPages([pageData(jobsBlock([], { pageCount: 0, facets: 3 }))], async () => {
    await assert.rejects(providers.join.fetch('acme'), /facet count 3/);
  });
  // the data moved somewhere else
  await withPages([companyPage({ somethingNew: { jobs: [] } })], async () => {
    await assert.rejects(providers.join.fetch('acme'), /unexpected page structure/);
  });
  // no Next.js data at all
  await withPages(['<html><body>Jobs</body></html>'], async () => {
    await assert.rejects(providers.join.fetch('acme'), /no __NEXT_DATA__/);
  });
  // the HTTP error surfaces (source health counts it)
  await withPages([], async () => {
    await assert.rejects(providers.join.fetch('acme'), /404/);
  });
});

test('join: a later page that repeats the previous one ends the walk without duplicates', async () => {
  const p = pageData(jobsBlock([item(1, 'Systems Engineer')], { pageCount: 5 }));
  await withPages([p, p, p, p, p], async (asked) => {
    const jobs = await providers.join.fetch('acme');
    assert.equal(jobs.length, 1);
    assert.equal(asked.length, 2, 'stops after the first repeated page');
  });
});
