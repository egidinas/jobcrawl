// The profiler's network layer: one place every request of a profiling run goes through, including the providers' own fetch() calls
// during verification (globalThis.fetch is wrapped while a run is active). Per request: the site's budget (requests made on behalf of
// one employer), robots.txt (the profile's user-agent token and "*", longest match, Allow beats Disallow on a tie), at most one request
// per second per host (or the host's Crawl-delay, up to 10 s), and a per-site response cache so a verification run re-reads the bytes the
// profiler already fetched instead of fetching them again. The site a request belongs to is tracked with AsyncLocalStorage.
import { AsyncLocalStorage } from 'node:async_hooks';
import { UA } from '../useragent.mjs';

const als = new AsyncLocalStorage();
const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BudgetError extends Error {}
export class RobotsError extends Error {}

/** robots.txt -> { rules: [{ allow, path }], delay } for the first group naming `token`, else the "*" group. */
export function parseRobots(txt, token) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [], delay: 0 }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (k === 'disallow' && v) cur.rules.push({ allow: false, path: v });
    else if (k === 'allow' && v) cur.rules.push({ allow: true, path: v });
    else if (k === 'crawl-delay' && Number(v) > 0) cur.delay = Number(v);
  }
  const t = String(token).toLowerCase();
  const g = groups.find((x) => x.agents.some((a) => a !== '*' && t.includes(a))) ?? groups.find((x) => x.agents.includes('*'));
  return g ? { rules: g.rules, delay: g.delay } : { rules: [], delay: 0 };
}
const ruleRe = (p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
/** Is path (pathname + search) allowed by parsed robots rules? */
export function robotsAllows(robots, path) {
  let best = null;
  for (const r of robots.rules) {
    if (!ruleRe(r.path).test(path)) continue;
    const len = r.path.replace(/\*/g, '').length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

/**
 * A network for one profiling run. token: the user-agent product token robots groups are matched against (e.g. "MADE-jobs-crawler").
 * Returns { run(site, fn), install(), uninstall(), robotsFor(origin), stats }.
 */
export function makeNet({ token = 'jobcrawl', minGapMs = 1000, budget = 10, maxBytes = 6e6, timeoutMs = 20000, log = () => {} } = {}) {
  const lastAt = new Map();      // host -> time of the last request start
  const robots = new Map();      // origin -> Promise<parsed>
  const stats = { requests: 0, robots_blocked: 0, budget_hits: 0 };

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
    if (u.pathname !== '/robots.txt') {
      const rb = await robotsFor(u.origin);
      if (!robotsAllows(rb, u.pathname + u.search)) { stats.robots_blocked++; if (ctx) ctx.robotsBlocked.push(url); throw new RobotsError(`robots.txt disallows ${url}`); }
      count(ctx, url, method === 'GET' ? '' : method);
      await pace(u.host, Math.max(minGapMs, Math.min(10, rb.delay || 0) * 1000));
    } else {
      // robots.txt was (or is now) read once per origin for the checks above: serve the same bytes to the provider's own robots reader
      const rb = await robotsFor(u.origin);
      return mkResponse({ status: rb.status && rb.status < 400 ? 200 : 404, headers: [['content-type', 'text/plain']], body: Buffer.from(rb.txt ?? ''), url });
    }
    const headers = { ...(init.headers ?? {}) };
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'user-agent')) headers['user-agent'] = UA;
    const t0 = Date.now();
    let res;
    try {
      res = await realFetch(url, { ...init, headers, redirect: init.redirect ?? 'follow', signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
    } catch (e) { log(`  net FAIL ${url}: ${e.message}`); throw e; }
    const buf = Buffer.from(await res.arrayBuffer());
    const c = { status: res.status, headers: [...res.headers.entries()].filter(([k]) => k !== 'content-encoding' && k !== 'content-length'), body: buf.subarray(0, maxBytes), url: res.url || url, ms: Date.now() - t0 };
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
      const ctx = { site, budget: siteBudget, requests: 0, cache: new Map(), trace: [], robotsBlocked: [] };
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
    return { ok: false, status: 0, url, html: '', type: '', error: e instanceof BudgetError ? 'budget' : e instanceof RobotsError ? 'robots' : e.message };
  }
}
