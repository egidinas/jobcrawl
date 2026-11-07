// Config-driven providers (providers-generic.mjs: paginated_list, jsonld_direct) on captured documents (crawler/tests/fixtures/:
// generic-json-page.json, research-mpg-*.html). No network: fetch is stubbed.   Run: node --test crawler/tests/provider-generic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providers, setCacheDir } from '../providers.mjs';
import { configurePolicy, installGuard, resetPolicy, policyStats } from '../policy.mjs';
import { jsonPath, itemsOf, fieldsOf, jobLinks, jobsFromJsonLd } from '../providers-generic.mjs';

const text = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(String(url));
    const body = handler(String(url), opts);
    return new Response(body ?? 'not found', { status: body == null ? 404 : 200, headers: { 'content-type': 'text/html' } });
  };
  try { await fn(calls); } finally { globalThis.fetch = real; }
  return calls;
}

const JSON_LIST = {
  kind: 'json', url: 'https://example.org/api/jobs/?page={page}', items: 'content.colPos0.0.content.data.documents.list.results',
  fields: { title: 'title', url: 'url', location: 'teaser', department: 'subtitle', company: 'subtitle' }, page_size: 3, max_pages: 5, delay_ms: 1,
  total: 'content.colPos0.0.content.data.documents.list.count', company_suffix: '(via Example)',
};

test('jsonPath: dot paths, indexes and * over arrays', () => {
  const o = { a: { b: [{ c: 1 }, { c: 2 }] }, n: null };
  assert.equal(jsonPath(o, 'a.b.0.c'), 1);
  assert.deepEqual(jsonPath(o, 'a.b.*.c'), [1, 2]);
  assert.equal(jsonPath(o, 'n.x'), undefined);
  assert.equal(jsonPath(o, ''), o);
});

test('paginated_list json: items at a dot path, fields at dot paths, company suffix', () => {
  const page = text('generic-json-page.json');
  const { items, total } = itemsOf(page, JSON_LIST);
  assert.equal(items.length, 3);
  assert.equal(total, 257);
  const j = fieldsOf(items[0], JSON_LIST);
  assert.deepEqual(j, {
    title: 'Studentische Pflichtpraktika sowie Grund-/Vorpraktikum m/w/d',
    url: 'https://www.fz-juelich.de/de/karriere/stellenangebote/2024P-029',
    location: 'Standort: Jülich',
    department: 'Forschungszentrum Jülich',
    postedAt: '',
    company: 'Forschungszentrum Jülich (via Example)',
  });
  assert.throws(() => itemsOf('<html>', JSON_LIST), /not JSON/);
});

test('paginated_list json: walks {page} until the total is reached or a page repeats', async () => {
  const page = text('generic-json-page.json');
  let jobs;
  const calls = await withFetch(() => page, async () => { jobs = await providers.paginated_list.fetch('x', { list: { ...JSON_LIST, total: undefined } }); });
  assert.deepEqual(calls, ['https://example.org/api/jobs/?page=1', 'https://example.org/api/jobs/?page=2'], 'page 2 repeats page 1 and ends the walk');
  assert.equal(jobs.length, 3);
  const calls2 = await withFetch(() => page, async () => { jobs = await providers.paginated_list.fetch('x', { list: { ...JSON_LIST, page_size: 10 } }); });
  assert.equal(calls2.length, 1, 'a page shorter than page_size is the last one');
  await assert.rejects(providers.paginated_list.fetch('x', { list: { url: 'https://x/' } }), /entry\.list needs url and kind/);
  // a 404 past the last page ends the walk with what was gathered; a 404 on the first page is the board's error
  const calls3 = await withFetch((u) => (u.endsWith('page=1') ? page : null), async () => { jobs = await providers.paginated_list.fetch('x', { list: { ...JSON_LIST, total: undefined, page_size: 3 } }); });
  assert.equal(calls3.length, 2);
  assert.equal(jobs.length, 3);
  await assert.rejects(withFetch(() => null, async () => { await providers.paginated_list.fetch('x', { list: JSON_LIST }); }), /HTTP 404/);
});

test('paginated_list html: items by regex, fields by capture group, {offset} and relative URLs', async () => {
  const frag = text('research-mpg-more_items.html');
  const list = {
    kind: 'html', url: 'https://www.mpg.de/jobboard/115824/more_items?offset={offset}&limit=20', first_page: 1, page_size: 20, max_pages: 3, delay_ms: 1,
    headers: { 'x-requested-with': 'XMLHttpRequest' },
    items: '<li class="teaser teaser-horizontal">.*?</li>',
    fields: { title: '<h3>\\s*<a href="[^"]+">(.*?)</a>', url: '<h3>\\s*<a href="([^"]+)"', postedAt: '<span class="date">([^<]*)</span>', department: '</div>\\s*<div>\\s*([^<]+?)\\s*</div>' },
  };
  const { items } = itemsOf(frag, list);
  assert.equal(items.length, 3);
  const j = fieldsOf(items[0], { ...list, url_base: 'https://www.mpg.de' });
  assert.equal(j.title, 'Scientist/Engineer (m/f/d) in Automated Biology');
  assert.equal(j.url, 'https://www.mpg.de/27061716/scientist-engineer-m-f-d-in-automated-biology');
  assert.equal(j.postedAt, '2026-10-29', 'a "Month D, YYYY" date parses through Date');
  assert.equal(j.department, 'Max Planck Institute of Molecular Cell Biology and Genetics, Dresden');
  let jobs;
  const calls = await withFetch((u) => (u.includes('offset=0') ? frag : '<ul></ul>'), async () => { jobs = await providers.paginated_list.fetch('x', { list }); });
  assert.deepEqual(calls, ['https://www.mpg.de/jobboard/115824/more_items?offset=0&limit=20'], 'three items on a 20-per-page list: last page');
  assert.equal(jobs.length, 3);
});

test('jobLinks: same-host links matching the pattern, absolute, deduplicated, not the page itself', () => {
  const html = '<a href="/27061716/scientist">a</a> <a href="https://www.mpg.de/jobboard">self</a> <a href="https://other.org/jobs/1">x</a> <a href="/jobs/2#top">b</a> <a href="/jobs/2">b again</a>';
  assert.deepEqual(jobLinks(html, 'https://www.mpg.de/jobboard', /\/jobs\//), ['https://www.mpg.de/jobs/2']);
  assert.deepEqual(jobLinks(html, 'https://www.mpg.de/jobboard', /^\/\d+\//), ['https://www.mpg.de/27061716/scientist']);
  assert.deepEqual(jobLinks(html, 'https://www.mpg.de/jobboard', /jobs/, ['other.org']), ['https://other.org/jobs/1', 'https://www.mpg.de/jobs/2']);
});

test('jobsFromJsonLd: a JobPosting node with a url; a page without one gives []', () => {
  const page = text('research-mpg-job.html').replace(/"@type"\s*:\s*"JobPosting"/, '"@type": "JobPosting", "url": "https://www.mpg.de/27061716/x"');
  const jobs = jobsFromJsonLd(page, 'https://www.mpg.de/27061716/x');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].url, 'https://www.mpg.de/27061716/x');
  assert.equal(jobs[0].location, 'Dresden, DE');
  assert.equal(jobs[0].postedAt, '2026-10-29');
  assert.ok(jobs[0].description.length > 2000);
  assert.deepEqual(jobsFromJsonLd(text('research-mpg-job.html'), 'x'), [], 'the real page names no url in its JSON-LD');
  assert.deepEqual(jobsFromJsonLd('<html></html>', 'x'), []);
});

test('jsonld_direct: list page links -> posting pages parsed once and cached; robots.txt per the crawl policy (strict refuses, advisory logs)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-generic-'));
  setCacheDir(dir);
  try {
    const list = text('research-mpg-jobboard.html'), job = text('research-mpg-job.html');
    const entry = { job_url_pattern: '^/\\d+/', max_jobs: 10, page_concurrency: 1 };
    let jobs;
    const calls = await withFetch((u) => (u.endsWith('/robots.txt') ? 'User-agent: *\nDisallow: /intern/\n' : u.endsWith('/jobboard') ? list : job),
      async () => { jobs = await providers.jsonld_direct.fetch('https://www.mpg.de/jobboard', entry); });
    assert.equal(calls[0], 'https://www.mpg.de/jobboard', 'the provider reads no robots.txt itself (the crawl policy guard does)');
    assert.equal(calls.length, 3, 'two posting links on the trimmed list page');
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].url, 'https://www.mpg.de/27072047/data-analyst-bioinformatician-for-proteomics-and-metabolomics');
    assert.equal(jobs[0].title, 'Scientist/Engineer (m/f/d) in Automated Biology', 'the stub serves the same posting page for every link');
    assert.equal(jobs[0].location, 'Dresden, DE');
    assert.ok(jobs[0].description.length > 2000);
    // second run: the posting pages come from the cache (TTL), only the list page is fetched
    const calls2 = await withFetch((u) => (u.endsWith('/robots.txt') ? '' : u.endsWith('/jobboard') ? list : null),
      async () => { jobs = await providers.jsonld_direct.fetch('https://www.mpg.de/jobboard', entry); });
    assert.equal(calls2.length, 1);
    assert.equal(jobs.length, 2);
    // behind the crawl's guard (policy.mjs), a robots-disallowed list page: strict refuses it (an error, not an empty board) ...
    const disallowing = (u) => (u.endsWith('/robots.txt') ? 'User-agent: *\nDisallow: /jobboard\n' : list);
    const guarded = async () => { const un = installGuard(); try { jobs = await providers.jsonld_direct.fetch('https://www.mpg.de/jobboard', entry); } finally { un(); } };
    try {
      configurePolicy({ robots: 'strict' });
      await assert.rejects(withFetch(disallowing, guarded), /robots\.txt disallows https:\/\/www\.mpg\.de\/jobboard/);
      // ... advisory (the default) fetches it and logs it
      configurePolicy({ robots: 'advisory' });
      const calls4 = await withFetch(disallowing, guarded);
      assert.deepEqual(calls4.slice(0, 2), ['https://www.mpg.de/robots.txt', 'https://www.mpg.de/jobboard']);
      assert.equal(jobs.length, 2);
      assert.equal(policyStats().robots_disallowed_fetched, 1);
    } finally { resetPolicy(); }
    // no links and a sitemap: the sitemap's matching URLs are the postings
    const calls3 = await withFetch((u) => (u.endsWith('/robots.txt') ? '' : u.endsWith('/empty') ? '<html>no links</html>' : u.endsWith('sitemap.xml') ? '<urlset><url><loc>https://www.mpg.de/1/a</loc></url><url><loc>https://www.mpg.de/about</loc></url></urlset>' : job),
      async () => { jobs = await providers.jsonld_direct.fetch('https://www.mpg.de/empty', { ...entry, sitemap: 'https://www.mpg.de/sitemap.xml' }); });
    assert.deepEqual(calls3.slice(1), ['https://www.mpg.de/sitemap.xml', 'https://www.mpg.de/1/a']);
    assert.equal(jobs.length, 1);
  } finally { setCacheDir(null); rmSync(dir, { recursive: true, force: true }); }
});
