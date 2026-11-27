// `jobcrawl detect --page` (crawler/profiler/detect-page.mjs) on replayed answers: a platform hit from the page (recorded rexx listing)
// and a redirect into a private address refused by the SSRF guard before it is requested. No network: fetch, DNS and CNAME are stubs.
// Run: node --test crawler/tests/detect-page.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectPage } from '../profiler/detect-page.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const DNS = { 'karriere.n3eos.com': '93.184.216.34', 'careers.acme.example': '93.184.216.35', 'intranet.acme.example': '10.0.0.7' };
const lookupImpl = async (host) => (DNS[host] ? [{ address: DNS[host], family: 4 }] : []);

function replay(answers) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    const a = answers[String(url)];
    if (!a) return new Response('not recorded', { status: 404 });
    return new Response(a.body ?? null, { status: a.status ?? 200, headers: a.headers ?? { 'content-type': 'text/html; charset=utf-8' } });
  };
  return { fetchImpl, asked };
}

test('detect --page: a rexx portal on the employer host is named with its host as slug (detector v2 evidence)', async () => {
  const url = 'https://karriere.n3eos.com/stellenangebote.html';
  const { fetchImpl, asked } = replay({ [url]: { body: fx('rexx-table-listing.html') } });
  const res = await detectPage(url, { page: true, fetchImpl, lookupImpl, cnameImpl: async () => '' });
  assert.deepEqual(asked, [url]);
  assert.equal(res.page.status, 200);
  const h = res.hits.find((x) => x.provider === 'rexx');
  assert.ok(h, JSON.stringify(res.hits));
  assert.equal(h.slug, 'karriere.n3eos.com');
  assert.equal(h.platform, 'rexx');
  assert.ok(h.confidence >= 0.5);
  assert.ok(h.evidence.every((e) => e.type === 'platform'));
});

test('detect --page: CNAME of the careers host names the platform', async () => {
  const url = 'https://careers.acme.example/';
  const { fetchImpl } = replay({ [url]: { body: '<html><body>Jobs</body></html>' } });
  const res = await detectPage(url, { page: true, fetchImpl, lookupImpl, cnameImpl: async () => 'acme.teamtailor.com' });
  assert.equal(res.hits[0].provider, 'teamtailor');
  assert.equal(res.hits[0].slug, 'https://careers.acme.example');
});

test('detect --page: a redirect to a private address is refused before it is requested', async () => {
  const url = 'https://careers.acme.example/jobs';
  const { fetchImpl, asked } = replay({ [url]: { status: 302, headers: { location: 'http://intranet.acme.example/admin' } } });
  const res = await detectPage(url, { page: true, fetchImpl, lookupImpl, cnameImpl: async () => '' });
  assert.deepEqual(asked, [url], 'the private target is never fetched');
  assert.match(res.page.error, /non-public|private/i);
  assert.deepEqual(res.hits, []);
});

test('detect without --page reads nothing from the network', async () => {
  const { fetchImpl, asked } = replay({});
  const res = await detectPage('https://boards.greenhouse.io/acme', { fetchImpl, lookupImpl });
  assert.deepEqual(asked, []);
  assert.deepEqual(res.hits.map((h) => [h.provider, h.slug]), [['greenhouse', 'acme']]);
});
