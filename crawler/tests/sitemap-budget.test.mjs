// sitemap provider pacing: entry.page_budget_ms stops starting page fetches once spent and returns what the cache holds, so a big
// first fill spreads over several cycles; entry.page_concurrency caps the parallel page fetches. Without the keys: one full pass.
// Run: node --test crawler/tests/sitemap-budget.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providers, setCacheDir } from '../providers.mjs';

const N = 8;
const page = (i) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: `Job ${i}`, datePosted: '2026-11-01',
  description: 'x', jobLocation: { address: { addressLocality: 'Kassel', addressCountry: 'Germany' } } })}</script></head></html>`;

async function withBoard(fn) {
  let inFlight = 0, maxInFlight = 0, pages = 0;
  const srv = createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/robots.txt') return res.end('');
    if (p === '/sitemap.xml') {
      return res.end(`<urlset>${Array.from({ length: N }, (_, i) => `<url><loc>http://${req.headers.host}/en/job/j/${i}</loc><lastmod>2026-11-01</lastmod></url>`).join('')}</urlset>`);
    }
    const m = p.match(/^\/en\/job\/j\/(\d+)$/);
    if (!m) { res.statusCode = 404; return res.end(''); }
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); pages++;
    setTimeout(() => { inFlight--; res.end(page(m[1])); }, 120);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'sitemap-budget-'));
  setCacheDir(dir);
  try { await fn(`http://127.0.0.1:${srv.address().port}/sitemap.xml`, () => ({ maxInFlight, pages })); }
  finally { srv.close(); setCacheDir(null); rmSync(dir, { recursive: true, force: true }); }
}

test('page_budget_ms spreads the first fill over several calls; the cache keeps what was read', async () => {
  await withBoard(async (slug, stats) => {
    const entry = { url_pattern: '/en/job/', page_budget_ms: 200, page_concurrency: 1 };
    const first = await providers.sitemap.fetch(slug, entry);
    assert.ok(first.length > 0 && first.length < N, `first call returned ${first.length} of ${N}`);
    let got = first.length;
    for (let k = 0; k < 10 && got < N; k++) got = (await providers.sitemap.fetch(slug, entry)).length;
    assert.equal(got, N, 'later calls complete the fill from the cache');
    assert.equal(stats().pages, N, 'every page was fetched exactly once');
    assert.equal(stats().maxInFlight, 1, 'page_concurrency 1 means one page at a time');
  });
});

test('without the keys the provider reads every page in one call, at most 4 at a time', async () => {
  await withBoard(async (slug, stats) => {
    const jobs = await providers.sitemap.fetch(slug, { url_pattern: '/en/job/' });
    assert.equal(jobs.length, N);
    assert.ok(stats().maxInFlight <= 4);
  });
});
