// The crawl policy (crawler/policy.mjs) against a local HTTP server: robots.txt advisory vs strict (and per-host overrides), the
// Crawl-delay floor, HTTP 429 cooldowns and Retry-After, the never-log-in rule, explicit opt-outs, and the page budgets (sitemap index
// followed in full, a first fill spread over calls, pagination past the old caps, the backfill's time and failing-host limits).
// No network beyond 127.0.0.1.   Run: node --test crawler/tests/policy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurePolicy, installGuard, resetPolicy, policyStats, policySummary, noFetchReason, retryAfterSeconds, flushPolicy, parseRobots, robotsAllows, policySettled, interleaveByProvider } from '../policy.mjs';
import { providers, setCacheDir, pageBudget } from '../providers.mjs';
import { runQueue } from '../detail-backfill.mjs';

/** A local site: routes maps a path to a handler (req, res, n) or a body; every request is logged as [path, time]. */
async function site(routes) {
  const log = [];
  const srv = createServer((req, res) => {
    const path = req.url;
    log.push([path, Date.now()]);
    const n = log.filter(([p]) => p === path).length;
    const r = routes[path.split('?')[0]] ?? routes[path];
    if (r === undefined) { res.statusCode = 404; return res.end('missing'); }
    if (typeof r === 'function') return r(req, res, n);
    res.end(r);
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, log, hits: (p) => log.filter(([x]) => x === p).length, close: () => new Promise((ok) => srv.close(ok)) };
}

async function withPolicy(opts, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jc-policy-'));
  configurePolicy({ dataDir: dir, ...opts });
  const un = installGuard();
  try { return await fn(dir); } finally { un(); await policySettled(); flushPolicy(); resetPolicy(); rmSync(dir, { recursive: true, force: true }); }
}

test('robots.txt advisory (default): a disallowed page is fetched and logged; strict refuses it; a per-host override wins', async () => {
  const s = await site({ '/robots.txt': 'User-agent: *\nDisallow: /careers/\n', '/careers/jobs': 'job list' });
  try {
    await withPolicy({}, async (dir) => {
      const r = await fetch(`${s.base}/careers/jobs`);
      assert.equal(await r.text(), 'job list');
      await policySettled();
      assert.equal(policyStats().robots_disallowed_fetched, 1);
      const audit = readFileSync(join(dir, 'robots-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(audit[0].url, `${s.base}/careers/jobs`);
      assert.equal(audit[0].mode, 'advisory');
      assert.match(policySummary().join('\n'), /robots\.txt \(advisory\): 1 requests to disallowed paths made anyway on 1 hosts: 127\.0\.0\.1 1/);
    });
    const before = s.hits('/careers/jobs');
    await withPolicy({ robots: 'strict' }, async () => {
      await assert.rejects(fetch(`${s.base}/careers/jobs`), /robots\.txt disallows/);
      assert.equal(s.hits('/careers/jobs'), before, 'strict: never requested');
    });
    await withPolicy({ robots: 'advisory', robotsHosts: { '127.0.0.1': 'strict' } }, async () => {
      await assert.rejects(fetch(`${s.base}/careers/jobs`), /robots\.txt disallows/);
    });
    await withPolicy({ robots: 'strict', robotsHosts: { '127.0.0.1': 'advisory' } }, async () => {
      assert.equal((await fetch(`${s.base}/careers/jobs`)).status, 200);
    });
  } finally { await s.close(); }
});

test('robots.txt parsing (RFC 9309): split "*" groups combine, Allow beats Disallow on a tie, the own token group replaces "*"', () => {
  const split = parseRobots('User-agent: *\nSitemap: https://x/sitemap.xml\n\nUser-agent: *\nDisallow: /\n', 'MADE-jobs-crawler');
  assert.equal(robotsAllows(split, '/join-us'), false, 'the second "*" group applies too (www.stcorp.nl, 2026-11-07)');
  const tie = parseRobots('User-agent: *\nAllow: /\nDisallow: /\n', 'MADE-jobs-crawler');
  assert.equal(robotsAllows(tie, '/job/'), true, 'Allow: / and Disallow: / tie: Allow wins (withtec.de, coatex.fr)');
  const own = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: MADE-jobs-crawler\nDisallow: /intern/\nCrawl-delay: 3\n', 'MADE-jobs-crawler');
  assert.equal(robotsAllows(own, '/jobs'), true);
  assert.equal(robotsAllows(own, '/intern/x'), false);
  assert.equal(own.delay, 3);
});

test('Content-Signal ai-train=no is recorded for the owner (content-signals.json) and the page is still read for the board', async () => {
  const s = await site({ '/robots.txt': 'User-agent: *\nContent-Signal: search=yes, ai-train=no\nAllow: /\n', '/jobs': 'jobs' });
  try {
    await withPolicy({}, async (dir) => {
      assert.equal(await (await fetch(`${s.base}/jobs`)).text(), 'jobs');
      await policySettled();
      assert.match(policySummary().join('\n'), /Content-Signal ai-train=no: 1 hosts .*127\.0\.0\.1/);
      flushPolicy();
      assert.match(readFileSync(join(dir, 'content-signals.json'), 'utf8'), /ai-train=no/);
    });
  } finally { await s.close(); }
});

test('advisory mode does not hold the first request for a slow robots.txt; strict mode does', async () => {
  const s = await site({ '/robots.txt': (req, res) => setTimeout(() => res.end('User-agent: *\nDisallow: /x\n'), 1200), '/x': 'x' });
  try {
    await withPolicy({}, async () => {
      const t0 = Date.now();
      assert.equal(await (await fetch(`${s.base}/x`)).text(), 'x');
      assert.ok(Date.now() - t0 < 1000, `advisory: answered in ${Date.now() - t0} ms`);
      await policySettled();
      assert.equal(policyStats().robots_disallowed_fetched, 1, 'the verdict is logged when robots.txt arrives');
    });
    await withPolicy({ robots: 'strict' }, async () => {
      const t0 = Date.now();
      await assert.rejects(fetch(`${s.base}/x`), /robots\.txt disallows/);
      assert.ok(Date.now() - t0 >= 1100, 'strict: waited for robots.txt');
    });
  } finally { await s.close(); }
});

test('Crawl-delay is a floor between two requests to the host, in advisory and in strict mode', async () => {
  const s = await site({ '/robots.txt': 'User-agent: *\nCrawl-delay: 1\n', '/a': 'a', '/b': 'b' });
  try {
    for (const robots of ['advisory', 'strict']) {
      await withPolicy({ robots }, async () => {
        const t0 = s.log.length;
        await Promise.all([fetch(`${s.base}/a`), fetch(`${s.base}/b`)]);
        const times = s.log.slice(t0).filter(([p]) => p !== '/robots.txt').map(([, t]) => t);
        assert.equal(times.length, 2);
        assert.ok(Math.abs(times[1] - times[0]) >= 950, `${robots}: requests ${Math.abs(times[1] - times[0])} ms apart`);
      });
    }
  } finally { await s.close(); }
});

test('HTTP 429: Retry-After is waited out (retried by the providers, held by the guard); a long Retry-After is never retried early', async () => {
  const s = await site({
    '/robots.txt': '',
    '/sitemap.xml': (req, res, n) => { if (n === 1) { res.statusCode = 429; res.setHeader('retry-after', '1'); return res.end('slow down'); } res.end('<urlset></urlset>'); },
    '/busy.xml': (req, res) => { res.statusCode = 429; res.setHeader('retry-after', '120'); res.end('later'); },
    '/other': 'other page',
  });
  const dir = mkdtempSync(join(tmpdir(), 'jc-429-'));
  setCacheDir(dir);
  try {
    await withPolicy({}, async () => {
      assert.deepEqual(await providers.sitemap.fetch(`${s.base}/sitemap.xml`, {}), []);
      const t = s.log.filter(([p]) => p === '/sitemap.xml').map(([, x]) => x);
      assert.equal(t.length, 2, 'retried once');
      assert.ok(t[1] - t[0] >= 950, `the retry waited Retry-After (${t[1] - t[0]} ms)`);
    });
    await withPolicy({}, async () => {
      const t0 = Date.now();
      await assert.rejects(providers.sitemap.fetch(`${s.base}/busy.xml`, {}), /HTTP 429 .*Retry-After 120 s: not retried before then/);
      assert.equal(s.hits('/busy.xml'), 1, 'asked once, not retried before Retry-After');
      assert.ok(Date.now() - t0 < 5000);
      // the host is on a cooldown now: any other request to it fails at once instead of hitting the server
      await assert.rejects(fetch(`${s.base}/other`), /asked to wait \d+ s more after HTTP 429\/503/);
      assert.equal(s.hits('/other'), 0);
      assert.match(policySummary().join('\n'), /HTTP 429\/503 cooldowns: 0 requests waited, 1 gave up/);
    });
  } finally { setCacheDir(null); rmSync(dir, { recursive: true, force: true }); await s.close(); }
  assert.equal(retryAfterSeconds('7'), 7);
  assert.equal(retryAfterSeconds(new Date(Date.now() + 30000).toUTCString()) >= 28, true);
  assert.equal(retryAfterSeconds('soon'), null);
});

test('never log in: login URLs are never requested, a redirect into a login page stops before it, a 401 URL is not asked again', async () => {
  const s = await site({
    '/robots.txt': '',
    '/login': 'login form',
    '/candidate/login': 'login form',
    '/jobs/123': (req, res) => { res.statusCode = 302; res.setHeader('location', '/sso/start?next=/jobs/123'); res.end(); },
    '/sso/start': 'sso',
    '/members/jobs': (req, res) => { res.statusCode = 401; res.setHeader('www-authenticate', 'Basic'); res.end('no'); },
    '/moved': (req, res) => { res.statusCode = 301; res.setHeader('location', '/open'); res.end(); },
    '/open': 'public job',
  });
  try {
    await withPolicy({}, async (dir) => {
      await assert.rejects(fetch(`${s.base}/login`), /a login or authentication page/);
      await assert.rejects(fetch(`${s.base}/candidate/login?x=1`), /a login or authentication page/);
      await assert.rejects(fetch(`${s.base}/jobs/123`), /redirect from .*\/jobs\/123: a login or authentication page/);
      assert.equal(s.hits('/login') + s.hits('/candidate/login?x=1') + s.log.filter(([p]) => p.startsWith('/sso')).length, 0, 'no login page was requested');
      assert.equal((await fetch(`${s.base}/members/jobs`)).status, 401);
      await assert.rejects(fetch(`${s.base}/members/jobs`), /behind a login \(HTTP 401/);
      assert.equal(s.hits('/members/jobs'), 1, 'the 401 URL is asked once only');
      await assert.rejects(fetch(`${s.base}/jobs/123`), /behind a login \(redirects to a login page/);
      const r = await fetch(`${s.base}/moved`);
      assert.equal(await r.text(), 'public job', 'ordinary redirects are still followed');
      assert.equal(r.redirected, true);
      flushPolicy();
      const walls = JSON.parse(readFileSync(join(dir, 'auth-walls.json'), 'utf8'));
      assert.ok(walls[`${s.base}/members/jobs`], 'auth walls persist for later runs');
    });
  } finally { await s.close(); }
  assert.match(noFetchReason('https://deeplist.tech/api/companies?page=2'), /deeplist\.tech \/api and login are never used/);
  assert.match(noFetchReason('https://www.deeplist.tech/login'), /deeplist/);
  assert.equal(noFetchReason('https://deeplist.tech/companies/acme'), null, 'public pages of deeplist.tech are not covered by the rule');
  assert.match(noFetchReason('https://user:pw@jobs.example.com/x'), /credentials in the URL/);
  assert.equal(noFetchReason('https://jobs.example.com/job/Login-Specialist-123'), null, 'a job titled Login is not a login page');
  assert.match(noFetchReason('https://acme.wd3.myworkdayjobs.com/en-US/acme/login'), /login/);
});

test('explicit opt-outs: a listed host is never requested; a TDM reservation header flags the host for the owner', async () => {
  const s = await site({ '/robots.txt': '', '/jobs': (req, res) => { res.setHeader('tdm-reservation', '1'); res.end('jobs'); }, '/more': 'more' });
  try {
    await withPolicy({ optOutHosts: [{ host: '127.0.0.1', reason: 'terms forbid automated access to job data' }] }, async () => {
      await assert.rejects(fetch(`${s.base}/more`), /explicit opt-out: terms forbid automated access/);
      assert.equal(s.hits('/more'), 0);
    });
    await withPolicy({}, async (dir) => {
      await assert.rejects(fetch(`${s.base}/jobs`), /reserves text and data mining/);
      await assert.rejects(fetch(`${s.base}/more`), /flagged for the owner/);
      assert.equal(s.hits('/more'), 0);
      assert.match(policySummary().join('\n'), /OPT-OUT FLAGS for the owner \(not crawled\): 127\.0\.0\.1/);
      flushPolicy();
      assert.ok(existsSync(join(dir, 'optout-flags.json')));
    });
    await withPolicy({ optOutCleared: ['127.0.0.1'] }, async () => {
      assert.equal(await (await fetch(`${s.base}/more`)).text(), 'more', 'the owner cleared the host');
    });
  } finally { await s.close(); }
});

test('budgets: a sitemap index is read in full (was 10 children), a first fill stops inside the board budget and resumes', async () => {
  const kids = 15;
  const routes = { '/robots.txt': '', '/index.xml': `<sitemapindex>${Array.from({ length: kids }, (_, i) => `<sitemap><loc>BASE/s${i}.xml</loc></sitemap>`).join('')}</sitemapindex>` };
  for (let i = 0; i < kids; i++) routes[`/s${i}.xml`] = `<urlset><url><loc>BASE/job/${i}</loc><lastmod>2026-11-01</lastmod></url></urlset>`;
  const page = (i) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: `Job ${i}` })}</script>`;
  const s = await site(new Proxy(routes, {
    get: (t, p) => (String(p).startsWith('/job/') ? (req, res) => setTimeout(() => res.end(page(String(p).slice(5))), 400) : typeof t[p] === 'string' ? t[p].replaceAll('BASE', base()) : t[p]),
  }));
  function base() { return s.base; }
  const dir = mkdtempSync(join(tmpdir(), 'jc-budget-'));
  setCacheDir(dir);
  try {
    const all = await providers.sitemap.fetch(`${s.base}/index.xml`, { url_pattern: '/job/' });
    assert.equal(all.length, kids, 'every child sitemap was read');
    rmSync(dir, { recursive: true, force: true });
    // page budget: 1.2 s of page fetches per call, one at a time (400 ms each): a call returns part, marked incomplete
    const entry = { url_pattern: '/job/', page_budget_ms: 1200, page_concurrency: 1 };
    const first = await providers.sitemap.fetch(`${s.base}/index.xml`, entry);
    assert.ok(first.length > 0 && first.length < kids, `first call ${first.length}`);
    assert.ok(first.incomplete?.left > 0, 'marked incomplete (the crawl makes the board due again)');
    let got = first.length;
    for (let k = 0; k < 20 && got < kids; k++) got = (await providers.sitemap.fetch(`${s.base}/index.xml`, entry)).length;
    assert.equal(got, kids, 'later calls complete the fill from the cache');
    // the default page budget follows the board's fetch budget: timeout_ms minus 10 s
    assert.equal(pageBudget({}).ms, 25000);
    assert.equal(pageBudget({ timeout_ms: 120000 }).ms, 110000);
    assert.equal(pageBudget({ timeout_ms: 120000, page_budget_ms: 20000 }).ms, 20000);
  } finally { setCacheDir(null); rmSync(dir, { recursive: true, force: true }); await s.close(); }
});

test('pagination is followed past the old caps (paginated_list: 40 pages, old default 30), and stops at a page without news', async () => {
  const pages = 40;
  // a JSON list of 40 pages of 2 items, then an empty page
  const s2 = await site(new Proxy({}, {
    get: (t, p) => {
      const m = String(p).match(/^\/api\?page=(\d+)$/);
      if (!m) return undefined;
      const n = Number(m[1]);
      return JSON.stringify({ items: n <= pages ? [{ t: `Role ${n}a`, u: `/r/${n}a` }, { t: `Role ${n}b`, u: `/r/${n}b` }] : [] });
    },
  }));
  try {
    const entry = { list: { kind: 'json', url: `${s2.base}/api?page={page}`, items: 'items', fields: { title: 't', url: 'u' }, page_size: 2, delay_ms: 1 } };
    const jobs = await providers.paginated_list.fetch('', entry);
    assert.equal(jobs.length, pages * 2);
  } finally { await s2.close(); }
});

test('scheduling: each provider\'s boards are spread over the cycle, registry order kept within a provider', () => {
  const list = [...['e1', 'e2', 'e3'].map((name) => ({ name, provider: 'eures' })), ...['g1', 'g2', 'g3', 'g4', 'g5', 'g6'].map((name) => ({ name, provider: 'greenhouse' }))];
  const order = interleaveByProvider(list).map((c) => c.name);
  assert.deepEqual(order, ['g1', 'e1', 'g2', 'g3', 'e2', 'g4', 'g5', 'e3', 'g6']);
  assert.equal(interleaveByProvider([]).length, 0);
});

test('backfill: --minutes stops starting requests, a host that keeps failing is left for the next run', async () => {
  const q = [...Array.from({ length: 8 }, (_, i) => ({ host: 'bad.example', i })), ...Array.from({ length: 3 }, (_, i) => ({ host: 'good.example', i }))];
  const done = await runQueue(q, async (it) => ({ ok: it.host === 'good.example' }), { budget: 100, hostDelay: 1, concurrency: 1, hostFailLimit: 3 });
  assert.equal(done.filter((x) => x.host === 'bad.example').length, 3, 'three failures in a row, then the host stops');
  assert.equal(done.filter((x) => x.host === 'good.example').length, 3);
  assert.equal(done.skipped.host_failing, 5);
  assert.deepEqual(done.skipped.hosts, ['bad.example']);
  const slow = await runQueue(Array.from({ length: 10 }, (_, i) => ({ host: `h${i}`, i })), async () => { await new Promise((r) => setTimeout(r, 60)); return { ok: true }; }, { budget: 100, concurrency: 1, maxMs: 150 });
  assert.ok(slow.length >= 2 && slow.length <= 4, `${slow.length} started within the time limit`);
  assert.equal(slow.length + slow.skipped.time, 10);
});
