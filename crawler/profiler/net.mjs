// The profiler's network layer: one place every request of a profiling run goes through, including the providers' own fetch() calls
// during verification (globalThis.fetch is wrapped while a run is active). Per request: the crawl policy (../policy.mjs: never a login
// page or a URL behind one, never an opted-out host, 429/503 cooldowns, robots.txt advisory or strict per crawl.robots), the site's
// budget (requests made on behalf of one employer), at most one request per second per host or the host's Crawl-delay when longer
// (a Crawl-delay over 60 s ends the site), and a per-site response cache so a verification run re-reads the bytes the profiler already
// fetched instead of fetching them again. Redirects of GET requests are followed hop by hop, each hop checked. The site a request
// belongs to is tracked with AsyncLocalStorage.
import { AsyncLocalStorage } from 'node:async_hooks';
import { UA } from '../useragent.mjs';
import { parseRobots, robotsAllows, RobotsError, NoFetchError, CooldownError, noFetchReason, checkResponse, robotsModeFor, auditRobots, MAX_SLOT_WAIT_MS } from '../policy.mjs';

const als = new AsyncLocalStorage();
const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BudgetError extends Error {}
// robots.txt parsing and the crawl policy live in ../policy.mjs (shared with the crawl's fetch guard); re-exported for older imports.
export { parseRobots, robotsAllows, RobotsError };

/**
 * A network for one profiling run. token: the user-agent product token robots groups are matched against (e.g. "MADE-jobs-crawler").
 * Returns { run(site, fn), install(), uninstall(), robotsFor(origin), stats }.
 */
export function makeNet({ token = 'jobcrawl', minGapMs = 1000, budget = 10, maxBytes = 6e6, timeoutMs = 20000, log = () => {} } = {}) {
  const lastAt = new Map();      // host -> time of the last request start
  const robots = new Map();      // origin -> Promise<parsed>
  const stats = { requests: 0, robots_blocked: 0, robots_ignored: 0, policy_refused: 0, budget_hits: 0 };

  async function pace(host, gap) {
    for (;;) {
      const now = Date.now(), last = lastAt.get(host) ?? 0;
      if (now - last >= gap) { lastAt.set(host, now); return; }
      await sleep(gap - (now - last) + Math.random() * 50);
    }
  }
  function count(ctx, url, why) {
    if (!ctx) return;
    if (ctx.requests >= ctx.budget) { stats.budget_hits++; throw new BudgetError(`request budget (${ctx.budget}) spent before ${url}`); }
    ctx.requests++; stats.requests++;
    ctx.trace.push(why ? `${why} ${url}` : url);
  }
  function robotsFor(origin) {
    if (!robots.has(origin)) {
      robots.set(origin, (async () => {
        const ctx = als.getStore();
        count(ctx, `${origin}/robots.txt`, 'robots');
        await pace(new URL(origin).host, minGapMs);
        try {
          const res = await realFetch(`${origin}/robots.txt`, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
          if (res.status >= 400 && res.status < 500) return { rules: [], delay: 0, status: res.status, txt: '' };
          if (!res.ok) return { rules: [{ allow: false, path: '/' }], delay: 0, status: res.status, txt: '' };   // 5xx: treat as "do not crawl now"
          const txt = (await res.text()).slice(0, 500000);
          return { ...parseRobots(txt, token), status: res.status, txt };
        } catch (e) { return { rules: [], delay: 0, status: 0, txt: '', error: e.message }; }
      })());
    }
    return robots.get(origin);
  }

  async function politeFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const ctx = als.getStore();
    let u;
    try { u = new URL(url); } catch { return realFetch(input, init); }
    if (!/^https?:$/.test(u.protocol) || /^(?:127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) return realFetch(input, init);   // the local model
    const method = (init.method ?? 'GET').toUpperCase();
    const key = `${method} ${url} ${typeof init.body === 'string' ? init.body : ''}`;
    if (ctx?.cache.has(key)) { const c = ctx.cache.get(key); return mkResponse(c); }
    const manual = (init.redirect ?? 'follow') === 'follow' && (method === 'GET' || method === 'HEAD');
    const headers = { ...(init.headers ?? {}) };
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'user-agent')) headers['user-agent'] = UA;
    const t0 = Date.now();
    let cur = u, hops = 0, res;
    for (;;) {
      const why = noFetchReason(cur.href);
      if (why) { stats.policy_refused++; throw new NoFetchError(`not fetched: ${cur.href} (${hops ? `redirect from ${url}: ` : ''}${why})`); }
      if (cur.pathname === '/robots.txt') {
        // robots.txt was (or is now) read once per origin for the checks below: serve the same bytes to the provider's own robots reader
        const rb = await robotsFor(cur.origin);
        return mkResponse({ status: rb.status && rb.status < 400 ? 200 : 404, headers: [['content-type', 'text/plain']], body: Buffer.from(rb.txt ?? ''), url: cur.href });
      }
      const rb = await robotsFor(cur.origin);
      if (!robotsAllows(rb, cur.pathname + cur.search)) {
        if (robotsModeFor(cur.hostname) === 'strict') { stats.robots_blocked++; if (ctx) ctx.robotsBlocked.push(cur.href); throw new RobotsError(`robots.txt disallows ${cur.href}`); }
        stats.robots_ignored++; if (ctx) ctx.robotsIgnored.push(cur.href);
        auditRobots(cur.href, 'profiler');
      }
      if ((rb.delay || 0) * 1000 > MAX_SLOT_WAIT_MS) throw new CooldownError(`not fetched: ${cur.href} (Crawl-delay ${rb.delay} s of ${cur.host} is longer than probing waits)`);
      count(ctx, cur.href, method === 'GET' ? '' : method);
      await pace(cur.host, Math.max(minGapMs, (rb.delay || 0) * 1000));
      try {
        res = await realFetch(cur.href, { ...init, headers, redirect: manual ? 'manual' : init.redirect ?? 'follow', signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
      } catch (e) { log(`  net FAIL ${cur.href}: ${e.message}`); throw e; }
      const bad = checkResponse(cur.href, res);
      if (bad) { if (ctx) ctx.optout = bad; stats.policy_refused++; throw new NoFetchError(`not fetched: ${cur.href} (${bad})`); }
      const loc = manual && res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc) break;
      if (++hops > 10) throw new Error(`too many redirects from ${url}`);
      try { await res.body?.cancel(); } catch { /* nothing to drop */ }
      cur = new URL(loc, cur);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // TDMRep in the page itself (<meta name="tdm-reservation" content="1">): an explicit opt-out, recorded for the owner
    if (ctx && /<meta[^>]+name=["']tdm-reservation["'][^>]+content=["']1["']/i.test(buf.subarray(0, 200000).toString('latin1'))) ctx.optout = `${cur.host} reserves text and data mining (tdm-reservation meta tag)`;
    const c = { status: res.status, headers: [...res.headers.entries()].filter(([k]) => k !== 'content-encoding' && k !== 'content-length'), body: buf.subarray(0, maxBytes), url: cur.href, ms: Date.now() - t0 };
    if (ctx) ctx.cache.set(key, c);
    return mkResponse(c);
  }
  function mkResponse(c) {
    const r = new Response(c.status === 204 || c.status === 304 ? null : c.body, { status: c.status, headers: c.headers });
    Object.defineProperty(r, 'url', { value: c.url });
    return r;
  }

  return {
    stats,
    robotsFor,
    fetch: politeFetch,
    install() { globalThis.fetch = politeFetch; },
    uninstall() { globalThis.fetch = realFetch; },
    /** Run fn inside one site's context (its own budget, cache and trace). */
    run(site, fn, siteBudget = budget) {
      const ctx = { site, budget: siteBudget, requests: 0, cache: new Map(), trace: [], robotsBlocked: [], robotsIgnored: [], optout: null };
      return als.run(ctx, async () => { try { return await fn(ctx); } finally { ctx.cache.clear(); } });
    },
    context: () => als.getStore(),
  };
}

/** GET a page as text through the installed polite fetch: { ok, status, url (final), html, type } (never throws on HTTP errors). */
export async function getPage(url, { accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', timeoutMs = 20000 } = {}) {
  try {
    const res = await globalThis.fetch(url, { headers: { accept }, signal: AbortSignal.timeout(timeoutMs) });
    const type = res.headers.get('content-type') ?? '';
    const html = await res.text();
    return { ok: res.ok, status: res.status, url: res.url || url, html, type };
  } catch (e) {
    return { ok: false, status: 0, url, html: '', type: '', error: e instanceof BudgetError ? 'budget' : e instanceof RobotsError ? 'robots' : e instanceof NoFetchError || e instanceof CooldownError ? 'policy' : e.message };
  }
}
