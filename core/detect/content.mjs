// Content signals for custom boards (no ATS), JOBCRAWLX row 2A.5: what on a careers page says "the jobs are listed right here", mapped to
// the generic sources with a proposed entry the crawler can verify (the profiler's cascade does that verification with a fetch):
//   jsonld_list    two or more schema.org JobPosting objects in the page's JSON-LD          -> jsonld_direct { slug: page }
//   jsonld_one     one JobPosting (a posting page: its list is one level up)                 -> jsonld_direct, low confidence
//   job_cards      a repeated group of job-like links on the employer's own host            -> paginated_list html config (+ pagination),
//                                                                                              and jsonld_direct with job_url_pattern
//   job_links      a few job-like links in one job directory (small employers)              -> jsonld_direct with job_url_pattern
//   sitemap        the page IS a sitemap with a job URL group                                -> sitemap { url_pattern }
//   feed           an RSS/Atom job feed link                                                 -> paginated_list rss config
// Pure functions over the HTML; the pieces (linkGroups, pagination, htmlListConfig, ...) are the profiler's own (crawler/profiler/detect.mjs).
import { linkGroups, pagination, htmlListConfig, jobAnchors, commonJobDir, feedLinks, sitemapLocs, sitemapJobGroup, regDomain, hostOf, reEscape, RSS_LIST } from '../../crawler/profiler/detect.mjs';
import { jobsFromJsonLd } from '../../crawler/providers-generic.mjs';

const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const conf = (x) => +Math.min(0.95, x).toFixed(3);

/** The profiler's hold rule for link groups (cascade.mjs linkGroupHold): navigation, product or project links are not a job list. */
function holdReason(g, pageUrl) {
  if (!(g.tokenFrac > 0)) return 'no job-like URL token';
  if (!(g.titleFrac >= 0.5)) return 'titles not job-like';
  try { const u = new URL(pageUrl); if ((u.pathname === '/' || u.pathname === '') && !u.search) return 'list is the site root'; } catch { /* no rule */ }
  return '';
}

/**
 * Generic-source candidates for one page. ats: the ATS candidates already found (an ATS embed outranks the page's own links to it).
 * Returns candidates in the detector's shape with kind 'generic' and a proposed `config` (an entry fragment for companies.json).
 */
export function contentCandidates({ html = '', pageUrl = '', ats = [] } = {}) {
  const out = [];
  if (!html) return out;
  const own = (h) => !!h && regDomain(h) === regDomain(hostOf(pageUrl));
  const strongAts = ats.some((c) => c.provider && c.kind !== 'site' && c.confidence >= 0.8);
  const evidence = (kind, value) => ({ kind, value: String(value).slice(0, 200) });

  // the page is a sitemap
  if (/^\s*(?:<\?xml[^>]*>\s*)?<(?:urlset|sitemapindex)\b/i.test(html)) {
    const { isIndex, locs } = sitemapLocs(html);
    const g = isIndex ? null : sitemapJobGroup(locs);
    if (g) out.push({ provider: 'sitemap', kind: 'generic', slug: pageUrl, confidence: conf(0.55 + Math.min(0.3, g.urls.length / 100)), hits: g.urls.length,
      evidence: [evidence('sitemap', `${g.urls.length} job URLs under ${g.prefix}`)], config: { provider: 'sitemap', slug: pageUrl, url_pattern: reEscape(g.prefix), max_jobs: 3000 } });
    return out;
  }

  // JSON-LD JobPosting on the page
  let jl = [];
  try { jl = jobsFromJsonLd(html, pageUrl); } catch { jl = []; }
  if (jl.length >= 2) out.push({ provider: 'jsonld_direct', kind: 'generic', slug: pageUrl, confidence: conf(0.7 + 0.05 * Math.min(4, jl.length)), hits: jl.length,
    evidence: [evidence('jsonld_list', `${jl.length} JobPosting objects`)], config: { provider: 'jsonld_direct', careers_url: pageUrl, slug: pageUrl, max_jobs: 1000 } });

  // repeated job-card structure on the employer's own host
  let groups = [];
  try { groups = linkGroups(html, pageUrl).filter((g) => g.titleFrac >= 0.4 || g.tokenFrac >= 0.8).sort((a, b) => b.score - a.score); } catch { groups = []; }
  const g = groups.find((x) => own(x.hp.host) || x.hp.sameHost);
  if (g) {
    const why = holdReason(g, pageUrl);
    const pg = (() => { try { return pagination(html, pageUrl, g.n); } catch { return null; } })();
    let list = null;
    try { list = htmlListConfig(g, pageUrl, html, pg); } catch { list = null; }
    const base = why ? 0.3 : 0.45 + 0.25 * g.titleFrac + Math.min(0.15, g.n / 60) + (pg ? 0.05 : 0);
    const ev = [evidence('job_cards', `${g.n} links, ${Math.round(g.titleFrac * 100)} % job-like titles, under ${g.hp.prefix ?? g.hp.host}`)];
    if (pg) ev.push(evidence('pagination', JSON.stringify(pg).slice(0, 120)));
    if (why) ev.push(evidence('held', why));
    if (list) out.push({ provider: 'paginated_list', kind: 'generic', slug: `profiled-${slugify(hostOf(pageUrl))}`, confidence: conf(base), hits: g.n, evidence: ev,
      config: { provider: 'paginated_list', careers_url: pageUrl, slug: `profiled-${slugify(hostOf(pageUrl))}`, list } });
    out.push({ provider: 'jsonld_direct', kind: 'generic', slug: pageUrl, confidence: conf(base - 0.05), hits: g.n, evidence: [...ev, evidence('verify', 'needs JobPosting JSON-LD on a posting page')],
      config: { provider: 'jsonld_direct', careers_url: pageUrl, slug: pageUrl, job_url_pattern: g.hp.query ? `[?&]${reEscape(g.hp.query)}=` : `^${reEscape(g.hp.prefix ?? '')}`, max_jobs: 1000 } });
  } else {
    // a small employer: a few posting links in one job directory
    let few = [];
    try { few = jobAnchors(html, pageUrl).filter((a) => own(hostOf(a.url))); } catch { few = []; }
    const dir = few.length ? commonJobDir(few.map((a) => a.url)) : null;
    if (dir && new URL(pageUrl).pathname !== dir) out.push({ provider: 'jsonld_direct', kind: 'generic', slug: pageUrl, confidence: conf(0.35 + 0.05 * Math.min(4, few.length)), hits: few.length,
      evidence: [evidence('job_links', `${few.length} job-like links under ${dir}`), evidence('verify', 'needs JobPosting JSON-LD on a posting page')],
      config: { provider: 'jsonld_direct', careers_url: pageUrl, slug: pageUrl, job_url_pattern: `^${reEscape(dir)}`, max_jobs: 500 } });
  }
  if (jl.length === 1) out.push({ provider: 'jsonld_direct', kind: 'generic', slug: pageUrl, confidence: 0.3, hits: 1, evidence: [evidence('jsonld_one', 'one JobPosting (a posting page)')],
    config: { provider: 'jsonld_direct', careers_url: pageUrl, slug: pageUrl, max_jobs: 1000 } });

  // job feeds
  let feeds = [];
  try { feeds = feedLinks(html, pageUrl); } catch { feeds = []; }
  const feed = feeds.find((f) => /job|career|karriere|stellen|vacanc|position/i.test(f.url ?? f));
  if (feed) { const fu = feed.url ?? feed; out.push({ provider: 'paginated_list', kind: 'generic', slug: `profiled-${slugify(hostOf(fu))}-rss`, confidence: 0.5, hits: 1, evidence: [evidence('feed', fu)],
    config: { provider: 'paginated_list', careers_url: pageUrl, slug: `profiled-${slugify(hostOf(fu))}-rss`, list: RSS_LIST(fu) } }); }

  // an ATS embed on the page is the stronger reading: the page's own links are its rendering of that board
  if (strongAts) for (const c of out) c.confidence = conf(c.confidence * 0.6);
  return out;
}
