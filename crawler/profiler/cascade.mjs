// The profiling cascade for one employer: find the careers page, then try, in order, until one VERIFIES:
//   1 ats      a known ATS board the pages point at (every provider's detect() over the page URLs and markup)
//   2 jsonld   schema.org JobPosting JSON-LD on the list page or on its posting pages (jsonld_direct), a job sitemap (sitemap), a job RSS feed
//   4 dom      the page's repeated link group, read with regexes (paginated_list html) - on the raw HTTP HTML, as the crawl will see it
//   3 xhr      (browser) the JSON response the rendered page loads its jobs from, replayed without the browser (paginated_list json)
//   5 llm      (local model) which links are postings, turned into a step-4 configuration
// Steps 4 runs before 3 because it needs no browser and the crawl can only use what plain HTTP returns; the method names keep the
// brief's numbering. VERIFIED means: the production provider's fetch(), over plain HTTP with the profile's user agent, returns the
// postings (>= 3 job-like items for steps 3-5, >= 1 JobPosting for step 2, a working board for step 1).
import { providers, parseJobPage } from '../providers.mjs';
import { jobsFromJsonLd } from '../providers-generic.mjs';
import { getPage, BudgetError, RobotsError } from './net.mjs';
import {
  atsFingerprints, careerLinks, listLinks, feedLinks, linkGroups, htmlListConfig, pagination, jobArrays, pagingParam, sitemapLocs,
  robotsSitemaps, sitemapJobGroup, rssItems, RSS_LIST, inlineJsonJobs, titleScore, isJobLike, regDomain, hostOf, reEscape, JOB_URL_TOKENS, textOf,
} from './detect.mjs';

const JOBPOSTING = /["']@type["']\s*:\s*\[?\s*["']JobPosting["']|itemtype=["']https?:\/\/schema\.org\/JobPosting["']/i;
const GUESS = { DE: ['/karriere', '/jobs'], AT: ['/karriere', '/jobs'], CH: ['/karriere', '/jobs'], GER: ['/karriere', '/jobs'], FR: ['/carrieres'], NL: ['/vacatures'], SE: ['/lediga-jobb'] };
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms))]);
const normUrl = (u) => { if (!u) return ''; const s = /^https?:\/\//i.test(u) ? u : `https://${u}`; try { const x = new URL(s); x.hash = ''; return x.href; } catch { return ''; } };
const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Baseline the crawl's health check compares against: a yield under expected_min for 3 cycles sets reprofile_due. */
export function baseline(n) {
  return { expected_min: n >= 3 ? Math.max(1, Math.floor(n * 0.25)) : 0, expected_max: Math.ceil(n * 4) + 10 };
}

/** Run the production provider on a copy of the entry trimmed for a check (2 pages, 3 posting pages). */
export async function verifyEntry(entry, { minJobLike = 3, minItems = 1, timeoutMs = 90000 } = {}) {
  const probe = JSON.parse(JSON.stringify(entry));
  if (probe.list) probe.list.max_pages = Math.min(probe.list.max_pages ?? 1, 2);
  if (probe.provider === 'jsonld_direct' || probe.provider === 'sitemap') probe.max_jobs = 3;
  const p = providers[probe.provider];
  if (!p) return { ok: false, error: `no provider ${probe.provider}` };
  try {
    const jobs = await withTimeout(Promise.resolve(p.fetch(probe.slug, probe)), timeoutMs, `${probe.provider} fetch`);
    const valid = (jobs ?? []).filter((j) => j?.title && j?.url);
    const urls = new Set(valid.map((j) => j.url));
    const jobLike = valid.filter((j) => isJobLike(j.title)).length;
    // several postings must have different titles: pages that all fall back to the site's own title ("Acme - Jobs") are not postings
    const titles = new Set(valid.map((j) => j.title.toLowerCase()));
    const siteTitle = valid.length >= 2 && titles.size === 1 && /\s[-|–]\s/.test(valid[0].title);
    const ok = valid.length >= minItems && urls.size >= Math.min(minItems, valid.length) && jobLike >= minJobLike && !siteTitle;
    return { ok, n: valid.length, jobLike, samples: valid.slice(0, 5).map((j) => ({ title: j.title, url: j.url, ...(j.location ? { location: j.location } : {}) })), all: valid };
  } catch (e) {
    return { ok: false, error: e instanceof BudgetError ? 'budget' : e instanceof RobotsError ? 'robots' : String(e.message ?? e).slice(0, 200) };
  }
}

/**
 * Profile one site. site: { key, name, website, careers_url, posting_url, country }. env: { net, sniff?(url, ctx), llm?(skeleton),
 * budget, date, log }. Returns the report record (method, entry, items, samples, steps, reason, requests).
 */
export async function profileSite(site, env) {
  const { log = () => {}, date = new Date().toISOString().slice(0, 10) } = env;
  const ctx = env.net.context();
  const rec = { key: site.key, name: site.name, input: { website: site.website ?? '', careers_url: site.careers_url ?? '', posting_url: site.posting_url ?? '', country: site.country ?? '', source: site.source ?? '', signal: site.signal ?? 0 },
    started: new Date().toISOString(), steps: {}, method: null, verified: false, entry: null, items: 0, samples: [], reason: '', requests: 0, browser_requests: 0 };
  const steps = rec.steps;
  const pages = [];          // { url, html, role }
  const website = normUrl(site.website), careersIn = normUrl(site.careers_url), postingIn = normUrl(site.posting_url);
  // The employer's own domain is its website's; a careers URL from a lane only counts as one when there is no website (a lane's
  // careers_page can be another company's: "inno-spec" -> headwall.com).
  const domains = new Set((website ? [website] : [careersIn, postingIn]).filter(Boolean).map((u) => regDomain(hostOf(u))));
  const nameTokens = String(site.name ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !/gmbh|holding|group|gruppe|systems|technolog|solutions|international|deutschland|germany/.test(w));
  const ownHost = (h) => domains.has(regDomain(h)) || nameTokens.some((w) => h.includes(w));
  const fetched = new Set();
  const fetchPage = async (url, role) => {
    if (!url || fetched.has(url)) return pages.find((p) => p.url === url) ?? null;
    fetched.add(url);
    const r = await getPage(url);
    if (r.error === 'budget') throw new BudgetError('budget');
    if (!r.ok || !r.html) { log(`  ${site.name}: ${role} ${url} -> ${r.status || r.error}`); return r.error === 'robots' ? { robots: true } : null; }
    if (!/html|xml|text\/plain|^$/i.test(r.type)) return null;
    const p = { url: r.url, requested: url, html: r.html, role };
    fetched.add(r.url);
    pages.push(p);
    return p;
  };
  const want = (s) => !env.steps || env.steps.has(s);   // --steps: a later pass (e.g. the model over the first pass's failures) skips the rest
  const finish = (method, entry, v, n) => {
    rec.method = method; rec.verified = true; rec.entry = entry; rec.items = n; rec.samples = v.samples ?? [];
    entry.profile = { method, at: date, items: n, ...baseline(n) };
    return rec;
  };

  try {
    // ---------- 0. the careers page (and the job list it links to) ----------
    let landing = null;
    if (careersIn && (ownHost(hostOf(careersIn)) || atsFingerprints('', careersIn).length)) landing = await fetchPage(careersIn, 'careers');
    else if (careersIn) steps.careers_in = `skip:other_domain ${hostOf(careersIn)}`;
    if (!landing && postingIn) {
      // a posting URL from the datasets: its parent directory is often the list ("/jobs/123" -> "/jobs/")
      const u = new URL(postingIn); u.search = '';
      const parent = u.pathname.length > 1 ? u.origin + u.pathname.replace(/[^/]+\/?$/, '') : '';
      if (parent && parent !== `${u.origin}/` && JOB_URL_TOKENS.test(new URL(parent).pathname)) landing = await fetchPage(parent, 'posting-parent');
    }
    let home = null;
    if (!landing && (website || postingIn)) {
      home = await fetchPage(website || new URL(postingIn).origin + '/', 'home');
      if (home?.robots) { rec.reason = 'robots'; steps.landing = 'fail:robots'; return rec; }
      if (!home) { rec.reason = 'homepage_failed'; steps.landing = 'fail:homepage_failed'; return rec; }
      if (!rec.name || /^[a-z0-9-]+$/.test(rec.name.replace(/^[^:]+:\s*/, ''))) {
        const sn = home.html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{2,60})["']/i)?.[1];
        if (sn) rec.name_suggested = textOf(sn);
      }
      // the home page itself may already be the answer (an embedded ATS, JSON-LD postings): checked below like any page
      const links = careerLinks(home.html, home.url).filter((l) => l.score >= 2);
      for (const l of links.slice(0, 2)) {
        if (!ownHost(hostOf(l.url)) && !atsFingerprints('', l.url).length) continue;
        landing = await fetchPage(l.url, 'careers');
        if (landing && !landing.robots) break;
      }
      if (!landing || landing.robots) {
        for (const g of (GUESS[site.country] ?? ['/careers', '/karriere']).slice(0, 1)) {
          landing = await fetchPage(new URL(g, home.url).href, 'careers-guess');
          if (landing && !landing.robots) break;
        }
      }
    }
    if (landing?.robots) { rec.reason = 'robots'; steps.landing = 'fail:robots'; return rec; }
    if (!landing && !home) { rec.reason = 'no_careers_page'; steps.landing = 'fail:no_careers_page'; return rec; }
    const main = landing ?? home;
    steps.landing = `ok:${main.role}`;
    rec.careers_page = main.url;
    if (!ownHost(hostOf(main.url)) && !atsFingerprints('', main.url).length) { rec.reason = 'domain_mismatch'; steps.landing = `fail:domain_mismatch ${hostOf(main.url)}`; return rec; }
    // a link from the landing page to the full list ("Offene Stellen", "All jobs") when the landing page has no posting group itself
    const groups0 = linkGroups(main.html, main.url).filter((g) => g.titleFrac >= 0.5);
    if (!groups0.length) {
      const ll = listLinks(main.html, main.url).filter((l) => l.score >= 3 && (ownHost(hostOf(l.url)) || atsFingerprints('', l.url).length));
      if (ll[0]) await fetchPage(ll[0].url, 'list');
    }

    // ---------- 1. ATS fingerprint ----------
    const ats = new Map();
    for (const p of pages) for (const f of atsFingerprints(p.html, p.url)) {
      const k = `${f.provider}\t${f.slug}`;
      const x = ats.get(k) ?? { ...f, hits: 0, page: p.url };
      x.hits += f.hits; ats.set(k, x);
    }
    const atsList = [...ats.values()].sort((a, b) => b.hits - a.hits);
    if (atsList.length && want("ats")) {
      for (const a of atsList.slice(0, 2)) {
        const entry = { name: site.name, careers_url: a.page, provider: a.provider, slug: a.slug };
        ctx.budget += 6;   // an ATS API may need a few requests (pages, a token); they are the ATS's, not the employer's
        const before = ctx.trace.length;
        const v = await verifyEntry(entry, { minJobLike: 0, minItems: 0 });
        // a board bigger than the profiling budget (a Workday tenant pages 20 rows per request): the ATS answered, which is the check
        if (!v.ok && v.error === 'budget' && ctx.trace.length - before >= 3) { steps.ats = `ok:${a.provider} ${a.slug} (larger than the profiling budget)`; return finish('ats', entry, { samples: [] }, 0); }
        steps.ats = v.ok ? `ok:${a.provider} ${a.slug} (${v.n} jobs)` : `fail:${a.provider} ${a.slug}: ${v.error ?? 'no jobs'}`;
        if (v.ok) return finish('ats', entry, v, v.n);
      }
    } else steps.ats = 'fail:no_fingerprint';

    // ---------- 2. structured data: JSON-LD on the list, on its posting pages, job sitemap, RSS ----------
    for (const p of want("jsonld") ? pages : []) {
      const jl = jobsFromJsonLd(p.html, p.url);
      // one JobPosting on a page is a posting page (a dataset's posting URL), not the list; a list carries several (an ItemList)
      if (jl.length >= 2) {
        const entry = { name: site.name, careers_url: p.url, provider: 'jsonld_direct', slug: p.url, max_jobs: 200 };
        const v = await verifyEntry(entry, { minJobLike: 0, minItems: 1 });
        steps.jsonld_list = v.ok ? `ok:${v.n}` : `fail:${v.error ?? `${v.n} items`}`;
        if (v.ok) return finish('jsonld', entry, v, jl.length);
      }
    }
    const allGroups = pages.flatMap((p) => linkGroups(p.html, p.url).map((g) => ({ ...g, page: p }))).filter((g) => g.titleFrac >= 0.4 || g.tokenFrac >= 0.8).sort((a, b) => b.score - a.score);
    const best = allGroups[0];
    if (best && want("jsonld")) {
      rec.link_group = { page: best.page.url, n: best.n, titleFrac: +best.titleFrac.toFixed(2), tokenFrac: +best.tokenFrac.toFixed(2), prefix: best.hp.prefix, host: best.hp.host, titles: best.titles.slice(0, 3) };
      if (ownHost(best.hp.host) || best.hp.sameHost) {
        const detail = await fetchPage(best.urls[0], 'posting');
        const jp = detail && !detail.robots ? (jobsFromJsonLd(detail.html, detail.url)[0] ?? (JOBPOSTING.test(detail.html) ? parseJobPage(detail.html, detail.url) : null)) : null;
        if (jp?.title) {
          const entry = { name: site.name, careers_url: best.page.url, provider: 'jsonld_direct', slug: best.page.url, job_url_pattern: best.hp.query ? `[?&]${reEscape(best.hp.query)}=` : `^${reEscape(best.hp.prefix)}`, max_jobs: 200 };
          if (!best.hp.sameHost) entry.link_hosts = [best.hp.host];
          const v = await verifyEntry(entry, { minJobLike: 0, minItems: 1 });
          steps.jsonld_detail = v.ok ? `ok:${v.n}/3 parsed, ${best.n} links` : `fail:${v.error ?? `${v.n} parsed`}`;
          if (v.ok && v.n >= Math.min(2, best.n)) return finish('jsonld', entry, v, best.n);
        } else steps.jsonld_detail = detail?.robots ? 'fail:robots' : 'fail:no_jobposting_on_posting_page';
      }
    } else steps.jsonld_detail = 'skip:no_link_group';
    // job sitemap (robots.txt Sitemap: lines, else /sitemap.xml)
    if (!want("sitemap")) steps.sitemap = "skip:steps";
    else if (ctx.requests < ctx.budget - 2) {
      const origin = new URL(main.url).origin;
      const rb = await env.net.robotsFor(origin);
      const sms = robotsSitemaps(rb.txt).filter((u) => ownHost(hostOf(u)));
      const smUrl = sms.find((u) => /job|career|karriere|stellen|vacanc|position/i.test(u)) ?? sms[0] ?? `${origin}/sitemap.xml`;
      const sm = await fetchPage(smUrl, 'sitemap');
      if (sm && !sm.robots) {
        let { isIndex, locs } = sitemapLocs(sm.html);
        let slug = sm.url;
        if (isIndex) {
          const kid = locs.find((u) => /job|career|karriere|stellen|vacanc|position|offer/i.test(u));
          const k = kid ? await fetchPage(kid, 'sitemap-child') : null;
          if (k && !k.robots) { slug = k.url; locs = sitemapLocs(k.html).locs; } else locs = [];
        }
        const g = sitemapJobGroup(locs);
        // a sitemap section is a job list only when its pages carry JobPosting markup (a "/careers/" section is mostly landing pages)
        const first = g ? await fetchPage(g.urls[0], 'posting') : null;
        if (g && !(first && !first.robots && JOBPOSTING.test(first.html))) steps.sitemap = `fail:no_jobposting (${g.urls.length} urls under ${g.prefix})`;
        else if (g) {
          const entry = { name: site.name, careers_url: main.url, provider: 'sitemap', slug, url_pattern: reEscape(g.prefix), max_jobs: 300, page_budget_ms: 20000, page_concurrency: 2 };
          const v = await verifyEntry(entry, { minJobLike: 0, minItems: 2 });
          steps.sitemap = v.ok ? `ok:${g.urls.length} urls` : `fail:${v.error ?? `${v.n} of 3 parsed (${g.urls.length} urls)`}`;
          if (v.ok) return finish('sitemap', entry, v, g.urls.length);
        } else if (!steps.sitemap) steps.sitemap = `fail:no_job_urls (${locs.length} locs)`;
      } else steps.sitemap = sm?.robots ? 'fail:robots' : 'fail:no_sitemap';
    } else steps.sitemap = 'skip:budget';
    for (const p of want("rss") ? pages : []) {
      const feed = feedLinks(p.html, p.url).find((u) => /job|karriere|career|stellen|vacanc/i.test(u));
      if (!feed || ctx.requests >= ctx.budget - 1) continue;
      const f = await fetchPage(feed, 'rss');
      const items = f && !f.robots ? rssItems(f.html) : [];
      if (items.filter((i) => isJobLike(i.title)).length >= 3) {
        const entry = { name: site.name, careers_url: p.url, provider: 'paginated_list', slug: `profiled-${slugify(hostOf(feed))}-rss`, list: RSS_LIST(f.url) };
        const v = await verifyEntry(entry);
        steps.rss = v.ok ? `ok:${v.n}` : `fail:${v.error ?? `${v.jobLike} job-like`}`;
        if (v.ok) return finish('rss', entry, v, v.n);
      } else steps.rss = `fail:${items.length} items`;
      break;
    }

    // ---------- 4. repeated link group on the raw HTML -> paginated_list html ----------
    const domGroups = allGroups.filter((g) => g.titleFrac >= 0.5 && g.n >= 3 && (ownHost(g.hp.host) || g.hp.sameHost));
    for (const g of want("dom") ? domGroups.slice(0, 2) : []) {
      const pg = pagination(g.page.html, g.page.url, g.n);
      const list = htmlListConfig(g, g.page.url, g.page.html, pg);
      const entry = { name: site.name, careers_url: g.page.url, provider: 'paginated_list', slug: `profiled-${slugify(hostOf(g.page.url))}`, list };
      const v = await verifyEntry(entry);
      steps.dom = v.ok ? `ok:${v.n} items${pg ? ' paged' : ''}` : `fail:${v.error ?? `${v.jobLike}/${v.n} job-like`}`;
      if (v.ok) return finish('dom', entry, v, v.n);
    }
    if (!domGroups.length) steps.dom = allGroups.length ? `fail:groups_not_job_like (best ${allGroups[0].titles.slice(0, 2).join(' | ').slice(0, 80)})` : 'fail:no_link_group';
    const inline = pages.flatMap((p) => inlineJsonJobs(p.html));
    if (inline.length) rec.inline_json = { n: inline[0].n, path: inline[0].path, titles: inline[0].titles };

    // ---------- 3. browser: the XHR/fetch JSON the page loads its jobs from ----------
    if (env.sniff && want("xhr")) {
      const target = pages.find((p) => p.role === 'list') ?? main;
      const s = await env.sniff(target.url, { ua: env.ua });
      rec.browser_requests = s.requests ?? 0;
      if (s.error) steps.xhr = `fail:browser ${s.error}`.slice(0, 160);
      // an ATS the page only loads with JavaScript (a Personio/Softgarden widget, a Workday iframe): its URLs are in the requests
      const jsAts = s.error ? [] : atsFingerprints(`${s.html}\n${(s.urls ?? []).map((u) => `<a href="${u}">`).join('\n')}`, target.url).filter((f) => !ats.has(`${f.provider}\t${f.slug}`));
      for (const a of jsAts.slice(0, 1)) {
        const entry = { name: site.name, careers_url: target.url, provider: a.provider, slug: a.slug };
        ctx.budget += 6;
        const v = await verifyEntry(entry, { minJobLike: 0, minItems: 0 });
        steps.ats_js = v.ok ? `ok:${a.provider} ${a.slug} (${v.n} jobs)` : `fail:${a.provider} ${a.slug}: ${v.error ?? 'no jobs'}`;
        if (v.ok) return finish('ats', entry, v, v.n);
      }
      if (!s.error) {
        const cands = [];
        for (const r of s.responses) for (const a of jobArrays(r.json)) cands.push({ r, a });
        cands.sort((x, y) => y.a.score - x.a.score);
        if (!cands.length) {
          const rg = s.html ? linkGroups(s.html, target.url).filter((g) => g.titleFrac >= 0.5) : [];
          steps.xhr = rg.length ? `fail:js_rendered_no_json_api (${rg[0].n} links in the rendered page)` : `fail:no_job_json (${s.responses.length} json responses)`;
          if (rg.length) rec.rendered_group = { n: rg[0].n, prefix: rg[0].hp.prefix, titles: rg[0].titles.slice(0, 3) };
        }
        for (const { r, a } of cands.slice(0, 2)) {
          const list = xhrListConfig(r, a, s.html, target.url);
          if (!list) { steps.xhr = `fail:no_url_field (${a.path})`; continue; }
          const entry = { name: site.name, careers_url: target.url, provider: 'paginated_list', slug: `profiled-${slugify(hostOf(r.url))}-api`, list };
          const v = await verifyEntry(entry);
          steps.xhr = v.ok ? `ok:${v.n} items from ${hostOf(r.url)}` : `fail:${v.error ? (/HTTP 40[13]/.test(v.error) ? 'api_needs_session ' : '') + v.error : `replay gave ${v.jobLike}/${v.n} job-like`}`.slice(0, 200);
          if (v.ok) return finish('xhr', entry, v, a.n);
        }
      }
    } else steps.xhr = 'skip:no_browser';

    // ---------- 5. local LLM: which links are postings -> a step-4 configuration ----------
    if (env.llm && want("llm")) {
      let target = pages.find((p) => p.role === 'list') ?? main;
      for (let round = 0; round < 2 && target; round++) {
        const ans = await env.llm(skeleton(target.html, target.url), { url: target.url, name: site.name });
        let next = null;
        if (ans?.error) steps.llm = `fail:${ans.error}`.slice(0, 160);
        else if (ans?.job_links?.length) {
          const g = groupFromExamples(target.html, target.url, ans.job_links);
          if (g && (ownHost(g.hp.host) || g.hp.sameHost)) {
            const list = htmlListConfig(g, target.url, target.html, pagination(target.html, target.url, g.n));
            const entry = { name: site.name, careers_url: target.url, provider: 'paginated_list', slug: `profiled-${slugify(hostOf(target.url))}`, list };
            const v = await verifyEntry(entry);
            steps.llm = v.ok ? `ok:${v.n}` : `fail:${v.error ?? `${v.jobLike}/${v.n} job-like`}`;
            if (v.ok) return finish('llm', entry, v, v.n);
          } else steps.llm = `fail:examples_not_a_group (${ans.job_links.slice(0, 2).join(' ')})`.slice(0, 160);
        } else steps.llm = ans?.is_job_list === false ? 'fail:model_says_no_job_list' : 'fail:no_job_links_named';
        // the model pointed at the complete list (a page this one only teases): read that once
        if (!ans?.error && ans?.full_list_link && round === 0) {
          try { const u = new URL(ans.full_list_link, target.url).href; if (ownHost(hostOf(u)) && !fetched.has(u)) next = await fetchPage(u, 'list-llm'); } catch {}
        }
        target = next && !next.robots ? next : null;
      }
    } else steps.llm = 'skip:no_llm';

    rec.reason = failureReason(rec, pages);
    return rec;
  } catch (e) {
    rec.reason = e instanceof BudgetError ? 'budget' : `error: ${String(e.message ?? e).slice(0, 160)}`;
    return rec;
  } finally {
    if (env.savePages) for (const [i, p] of pages.entries()) env.savePages(site, i, p);
    rec.requests = ctx.requests;
    rec.robots_blocked = ctx.robotsBlocked.length;
    rec.trace = ctx.trace.slice(0, 30);
    rec.ms = Date.now() - Date.parse(rec.started);
  }
}

const NO_OPENINGS = /(?:derzeit|aktuell|momentan|zur zeit|zurzeit)\s+(?:haben wir\s+)?(?:leider\s+)?keine\s+(?:offenen|vakanten|freien|ausgeschriebenen)?\s*(?:stellen|positionen|vakanzen|stellenangebote|jobs)|keine (?:offenen|vakanten) stellen|(?:no|not any) (?:open |current )?(?:positions|vacancies|openings|jobs)(?: available)?(?: at the moment| currently| right now)?|don[’']t have any open (?:positions|roles)|no vacancies|currently no (?:open )?(?:positions|vacancies|openings)/i;
function failureReason(rec, pages) {
  const s = rec.steps;
  const txt = pages.filter((p) => !/sitemap|robots/.test(p.role)).map((p) => textOf(p.html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' '))).join(' ');
  if (NO_OPENINGS.test(txt)) return 'no_openings';
  const pdfs = pages.flatMap((p) => [...p.html.matchAll(/<a\b[^>]*href=["']([^"']+\.pdf)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => textOf(m[2]) || m[1])).filter((t) => /stelle|job|position|m\/w\/d|w\/m\/d|m\/f\/d|engineer|ingenieur|techniker/i.test(t));
  if (pdfs.length) return 'pdf_postings';
  const headings = pages.flatMap((p) => [...p.html.matchAll(/<h[2-5]\b[^>]*>([\s\S]*?)<\/h[2-5]>/gi)].map((m) => textOf(m[1]))).filter((t) => /\([mwfdx]\s*\/\s*[mwfdx]\s*\/\s*[mwfdx]\)|\(all genders?\)/i.test(t));
  if (headings.length >= 1 && !rec.link_group) return 'inline_postings_no_links';
  if (String(s.xhr).includes('js_rendered')) return 'js_rendered_no_api';
  if (String(s.xhr).includes('api_needs_session')) return 'api_needs_session';
  if (rec.inline_json) return 'inline_json_state';
  if (String(s.ats).startsWith('fail:') && !String(s.ats).includes('no_fingerprint')) return 'ats_unverified';
  if (rec.link_group && rec.link_group.n >= 1 && rec.link_group.titleFrac >= 0.5) return 'few_or_unreadable_items';
  if (Object.values(s).some((x) => String(x).includes('budget'))) return 'budget';
  if (Object.values(s).some((x) => String(x).includes('robots'))) return 'robots';
  return pages.length ? 'no_job_list_found' : 'no_pages';
}

/** The JSON source of a sniffed response turned into a paginated_list json config (null when items carry no usable URL). */
export function xhrListConfig(r, a, renderedHtml, pageUrl) {
  const fields = { ...a.fields };
  let urlBase = new URL(pageUrl).origin + '/';
  if (!fields.url) {
    if (!fields.id || !renderedHtml) return null;
    // the posting links in the rendered page end with the item id: their common prefix is the URL base
    const ids = a.titles.length ? [] : [];
    const objs = jsonAt(r.json, a.path) ?? [];
    for (const o of objs.slice(0, 5)) {
      const id = String(fields.id.split('.').reduce((x, k) => x?.[k], o) ?? '');
      if (!id || id.length < 2) continue;
      const m = renderedHtml.match(new RegExp(`href=["']([^"']*?/)${reEscape(id)}/?["']`));
      if (m) ids.push(new URL(m[1], pageUrl).href);
    }
    if (ids.length < 2 || !ids.every((x) => x === ids[0])) return null;
    urlBase = ids[0];
    fields.url = fields.id;
  }
  delete fields.id;
  const list = { kind: 'json', url: r.url, items: a.path, fields, url_base: urlBase, page_size: a.n, max_pages: 10, delay_ms: 1100 };
  if (r.method && r.method !== 'GET') { list.method = r.method; list.body = r.postData ?? ''; const ct = r.reqHeaders?.['content-type']; if (ct) list.headers = { 'content-type': ct }; }
  const pp = pagingParam(r.url, r.postData);
  if (pp) {
    const ph = pp.kind === 'page' ? '{page}' : '{offset}';
    if (pp.where === 'query') { const u = new URL(r.url); u.searchParams.set(pp.key, '__P__'); list.url = u.href.replace('__P__', ph); }
    else { const k = pp.key.split('.').pop(); list.body = list.body.replace(new RegExp(`("${reEscape(k)}"\\s*:\\s*)${pp.value}`), `$1${ph}`); }
    if (pp.kind === 'page') list.first_page = pp.value;
  } else { list.max_pages = 1; list.page_size = 100000; }
  return list;
}
const jsonAt = (d, path) => (path ? path.split('.').reduce((x, k) => x?.[k], d) : d);

/** A compact view of a page for the local model: title, headings and every link (href + text), at most ~9,000 characters. */
export function skeleton(html, url) {
  const lines = [`URL: ${url}`, `TITLE: ${textOf(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')}`];
  const body = html.replace(/<(script|style|svg|noscript|head)\b[\s\S]*?<\/\1>/gi, ' ');
  const seen = new Set();
  for (const m of body.matchAll(/<(h[1-4])\b[^>]*>([\s\S]*?)<\/\1>|<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const line = m[1] ? `${m[1].toUpperCase()}: ${textOf(m[2]).slice(0, 120)}` : `LINK ${m[3].slice(0, 160)} :: ${textOf(m[4]).slice(0, 100)}`;
    if (seen.has(line) || /:: ?$/.test(line)) continue;
    seen.add(line); lines.push(line);
    if (lines.join('\n').length > 9000) break;
  }
  return lines.join('\n');
}

/** Build a link group from posting links the model named: every anchor sharing their prefix. */
export function groupFromExamples(html, pageUrl, examples) {
  const ex = examples.map((e) => { try { const u = new URL(e, pageUrl); u.hash = ''; return u.href; } catch { return null; } }).filter(Boolean);
  if (ex.length < 2) return null;
  const groups = linkGroups(html, pageUrl);
  return groups.find((g) => ex.filter((e) => g.urls.includes(e)).length >= Math.min(2, ex.length)) ?? null;
}
