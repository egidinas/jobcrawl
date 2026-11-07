// SAP SuccessFactors Recruiting Marketing (RMK) tenant enumeration (crawler audit 2026-11-06, finding 3: the family behind many
// German industrial and research employers was never enumerated, because RMK career sites live on the employer's own host
// (job.rohde-schwarz.com, jobs.hensoldt.net) and so have no host pattern a Common Crawl prefix could list).
//
// What does have a pattern is the tenant namespace: career<N>.successfactors.<eu|com>/career?company=<tenant id>. Asked for its job
// search, that page redirects to the tenant's RMK site when it has one (career5.successfactors.eu, company=rohdeschwarz ->
// https://job.rohde-schwarz.com/search, 2026-11-06). cc-harvest.mjs lists tenant ids from the index (vendor `successfactors`); the probe
// below resolves each to its RMK host and counts the job pages in that host's sitemap, so one tenant costs three requests (redirect,
// robots.txt, sitemap; a sitemap index adds its children) and no job page is fetched. A tenant becomes a `sitemap` entry
// (sitemap.xml + url_pattern /job/), the route the robots.txt files of RMK sites allow; their /services/ search API is often disallowed.
import { parseRobots, robotsAllows, robotsModeFor, auditRobots } from './policy.mjs';
import { UA } from './useragent.mjs';

const DC_HOST = /^career\d*\.successfactors\.(?:eu|com)$/i;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
/** An RMK job page: /job/<City>-<Title>-<postcode>/<numeric id>/ (optionally under a locale or site segment). */
const RMK_JOB_PATH = /^\/(?:[\w-]+\/)?job\/([^/]+)\/(\d{5,})\/?$/;

/** "career5.successfactors.eu|rohdeschwarz" from a tenant-namespace URL, else undefined. */
export function successfactorsTenant(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return undefined; }
  if (!DC_HOST.test(u.hostname) || !/^\/career\/?$/i.test(u.pathname)) return undefined;
  const id = u.searchParams.get('company');
  return id && TENANT_ID.test(id) ? `${u.hostname.toLowerCase()}|${id}` : undefined;
}

/** The job-search URL of a tenant slug ("<data-centre host>|<tenant id>"). */
export function tenantSearchUrl(slug) {
  const [dc, id] = String(slug).split('|');
  if (!DC_HOST.test(dc ?? '') || !TENANT_ID.test(id ?? '')) throw new Error(`successfactors: bad tenant slug "${slug}" (want career<N>.successfactors.<eu|com>|<id>)`);
  return `https://${dc}/career?company=${encodeURIComponent(id)}&career_ns=job_listing_summary&navBarLevel=JOB_SEARCH`;
}

/** { title, location: '', url } from an RMK job URL (the title is the URL's words, place included), else null. */
export function rmkJobFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const m = u.pathname.match(RMK_JOB_PATH);
  if (!m) return null;
  let words;
  try { words = decodeURIComponent(m[1]); } catch { words = m[1]; }
  return { title: words.replace(/-/g, ' ').replace(/\s+/g, ' ').trim(), location: '', url: u.href };
}

const locs = (xml) => [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));

/**
 * Resolve a tenant to its RMK host and list the job pages of that host's sitemap.
 * Returns { host, jobs: [{ title, location, url }], total }. Throws "HTTP 404 ..." when the tenant has no RMK site (an absence for
 * cc-harvest). robots.txt follows the crawl policy (policy.mjs): in strict mode a disallowed sitemap is an error naming robots.txt and
 * disallowed job pages are left out; in advisory mode (the default) both are read and the disallowed URLs are logged.
 */
export async function rmkProbe(slug, { fetchImpl = globalThis.fetch, ua = UA, token = 'jobcrawl', maxSitemaps = 20, timeoutMs = 20000 } = {}) {
  const get = async (url) => {
    const res = await fetchImpl(url, { redirect: 'follow', headers: { 'user-agent': ua }, signal: AbortSignal.timeout(timeoutMs) });
    return res;
  };
  const first = await get(tenantSearchUrl(slug));
  if (!first.ok) throw new Error(`HTTP ${first.status} successfactors tenant ${slug}`);
  const final = new URL(first.url || tenantSearchUrl(slug));
  if (DC_HOST.test(final.hostname)) throw new Error(`HTTP 404 successfactors: tenant ${slug} has no RMK career site (no redirect)`);
  const origin = final.origin, host = final.hostname.toLowerCase();

  const robotsRes = await get(`${origin}/robots.txt`);
  const robots = robotsRes.ok ? parseRobots(await robotsRes.text(), token) : { rules: [] };
  const strict = robotsModeFor(host) === 'strict';
  const allowed = (path, url) => {
    if (robotsAllows(robots, path)) return true;
    if (strict) return false;
    auditRobots(url, 'rmk');
    return true;
  };
  if (!allowed('/sitemap.xml', `${origin}/sitemap.xml`)) throw new Error(`robots.txt of ${host} disallows /sitemap.xml`);

  const jobs = [], seen = new Set();
  const queue = [`${origin}/sitemap.xml`];
  let read = 0;
  while (queue.length && read < maxSitemaps) {
    const url = queue.shift();
    read++;
    const res = await get(url);
    if (!res.ok) { if (read === 1) throw new Error(`HTTP ${res.status} ${url}`); continue; }
    const xml = await res.text();
    if (/<sitemapindex/i.test(xml)) {
      for (const child of locs(xml)) { try { if (new URL(child).hostname.toLowerCase() === host) queue.push(child); } catch { /* not a URL */ } }
      continue;
    }
    for (const loc of locs(xml)) {
      const j = rmkJobFromUrl(loc);
      if (!j || seen.has(j.url) || new URL(j.url).hostname.toLowerCase() !== host) continue;
      if (!allowed(new URL(j.url).pathname, j.url)) continue;
      seen.add(j.url);
      jobs.push(j);
    }
  }
  return { host, jobs, total: jobs.length };
}

/** The companies-file entry for a resolved RMK host (a sitemap board; descriptions come from each job page's JobPosting markup). */
export const rmkEntryFields = (host) => ({ provider: 'sitemap', slug: `https://${host}/sitemap.xml`, url_pattern: '/job/', careers_url: `https://${host}/` });
