// The EURES provider's host-wide request limiter (crawler/providers-eures.mjs euresLimiter, api): one request start per
// EURES_MIN_GAP_MS across every board of the process, Retry-After on a 429, the doubled gap after one. The env variable is read once
// at module load, so it is set here and the module imported dynamically; the gap is 50 ms to keep the file fast. No network.
// Run: node --test crawler/tests/eures-rate-limit.test.mjs
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.EURES_MIN_GAP_MS = '50';
const { eures, euresLimiter, retryAfterMs, tuning } = await import('../providers-eures.mjs');

const SEARCH = 'https://europa.eu/eures/api/jv-searchengine/public/jv-search/search';
const LABELS = 'https://europa.eu/eures/api/shared-data-rest-api/public/esco/label/en';
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });
/** One vacancy of the fixture without ESCO codes: a page of it needs no label call, so one board = one request. */
const vacancy = (() => { const v = JSON.parse(readFileSync(new URL('./fixtures/eures-search.json', import.meta.url), 'utf8')).jvs[0]; return { ...v, jobCategoriesCodes: [] }; })();
const page = (slug) => json({ numberRecords: 1, jvs: [{ ...vacancy, id: `id-${slug}` }], facets: {} });
const gaps = (times) => times.slice(1).map((t, i) => t - times[i]);

test('eures limiter: EURES_MIN_GAP_MS is read at load; the limiter and the Retry-After parser are exported', () => {
  assert.equal(tuning.minGapMs, 50);
  assert.equal(typeof euresLimiter.acquire, 'function');
  assert.equal(euresLimiter.gap(), 50, 'no backoff in force');
  assert.equal(retryAfterMs('1'), 1000, 'delay-seconds');
  assert.equal(retryAfterMs('120'), tuning.retryAfterCapMs, 'capped at 60 s');
  const now = Date.parse('Sun, 01 Nov 2026 12:00:00 GMT');
  assert.equal(retryAfterMs('Sun, 01 Nov 2026 12:00:03 GMT', now), 3000, 'an HTTP date');
  assert.equal(retryAfterMs('Sun, 01 Nov 2026 11:59:00 GMT', now), 0, 'a date in the past: no wait');
  assert.equal(retryAfterMs('Sun, 01 Nov 2026 12:05:00 GMT', now), tuning.retryAfterCapMs);
  assert.equal(retryAfterMs(null), tuning.retry429Ms, 'no header: the default backoff');
  assert.equal(retryAfterMs('soon'), tuning.retry429Ms, 'unreadable: the default backoff');
  assert.equal(tuning.retry429Ms, 10000);
});

test('eures limiter: 5 boards fetched at once start their requests one gap apart, in order', async (t) => {
  t.after(() => mock.restoreAll());
  euresLimiter.reset();
  const starts = [];
  mock.method(globalThis, 'fetch', async (url, init = {}) => {
    starts.push(performance.now());
    if (String(url) === LABELS) return json({});
    assert.equal(String(url), SEARCH);
    return page(JSON.parse(init.body).keywords[0].keyword);
  });
  const slugs = ['satellite|de', 'optics|fr', 'laser|at', 'antenna|se', 'rocket|it'];
  const t0 = performance.now();
  const results = await Promise.all(slugs.map((s) => eures.fetch(s)));
  const elapsed = performance.now() - t0;
  assert.deepEqual(results.map((r) => r.length), [1, 1, 1, 1, 1]);
  assert.equal(starts.length, 5, 'one request per board (no ESCO codes: no label call)');
  const g = gaps(starts);
  assert.ok(g.every((d) => d >= 45), `request starts at least ~50 ms apart, got ${g.map((d) => d.toFixed(1)).join(', ')}`);
  assert.ok(elapsed >= 4 * 45 && elapsed < 1000, `5 requests take about 4 gaps (${elapsed.toFixed(0)} ms)`);
});

test('eures limiter: a 429 with Retry-After: 1 is retried after about a second and succeeds', async (t) => {
  t.after(() => { mock.restoreAll(); euresLimiter.reset(); });
  euresLimiter.reset();
  const starts = [];
  let first = true;
  mock.method(globalThis, 'fetch', async (url, init = {}) => {
    starts.push(performance.now());
    if (String(url) === LABELS) return json({});
    if (first) { first = false; return json({ errorType: 'TOO_MANY_REQUESTS' }, 429, { 'retry-after': '1' }); }
    return page('x');
  });
  const jobs = await eures.fetch('satellite|de');
  assert.equal(jobs.length, 1, 'the retry succeeded');
  assert.equal(starts.length, 2, 'retried once');
  const wait = starts[1] - starts[0];
  assert.ok(wait >= 950 && wait < 1500, `retried after about 1 s (${wait.toFixed(0)} ms)`);
  assert.ok(euresLimiter.backoffUntil > Date.now() + tuning.backoffWindowMs - 2000, 'the 429 armed the global backoff');
});

test('eures limiter: after a 429 the gap doubles for the backoff window, then returns to the default', async (t) => {
  t.after(() => { mock.restoreAll(); euresLimiter.reset(); tuning.retry429Ms = 10000; });
  euresLimiter.reset();
  tuning.retry429Ms = 0;   // a 429 without Retry-After: the default 10 s pause is not what this test is about
  const starts = [];
  let first = true;
  mock.method(globalThis, 'fetch', async (url, init = {}) => {
    starts.push(performance.now());
    if (String(url) === LABELS) return json({});
    if (first) { first = false; return json({ errorType: 'TOO_MANY_REQUESTS' }, 429); }
    return page(JSON.parse(init.body).keywords[0].keyword);
  });
  await eures.fetch('satellite|de');               // request 1: 429 (no Retry-After), request 2: the retry
  assert.equal(starts.length, 2);
  assert.equal(euresLimiter.gap(), 100, 'doubled while the backoff is in force');
  await Promise.all([eures.fetch('optics|fr'), eures.fetch('laser|at')]);   // requests 3 and 4, both under the doubled gap
  assert.equal(starts.length, 4);
  const g = gaps(starts);
  assert.ok(g.slice(1).every((d) => d >= 90), `starts after the 429 are at least ~100 ms apart, got ${g.map((d) => d.toFixed(1)).join(', ')}`);
  euresLimiter.backoffUntil = Date.now() - 1;      // the window has passed
  assert.equal(euresLimiter.gap(), 50, 'back to the default');
});
