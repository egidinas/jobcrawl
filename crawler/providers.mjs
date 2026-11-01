// ATS providers for the portal scanner. Each fetches a company's public job feed
// and returns [{ title, url, location, department, postedAt }]. No auth, no scraping of
// logged-in pages; only the public JSON/XML/RSS feeds the ATS vendors expose.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { extraProviders } from './providers-extra.mjs';
import { usajobsDetect, usajobsFetch } from './providers-usajobs.mjs';
import { UA } from './useragent.mjs';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with a timeout and up to two retries on 429, 5xx and network errors (backoff 1 s, 2 s plus jitter; a Retry-After header
 * wins, capped at 20 s). Other 4xx fail at once. Pattern from career-ops-hq/career-ops providers/_http.mjs (MIT), reduced to what a
 * fixed list of public feeds needs.
 */
async function request(url, init = {}, { timeoutMs = 20000, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return res;
    } catch (err) {
      if (attempt >= retries) throw err;
    }
    const transient = !res || res.status === 429 || res.status >= 500;
    if (!transient || attempt >= retries) throw new Error(`HTTP ${res?.status} ${url}`);
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 20000) : 1000 * 2 ** attempt + Math.random() * 500);
  }
}

async function get(url, { json = true, timeoutMs = 20000 } = {}) {
  const res = await request(url, { headers: { 'user-agent': UA, accept: json ? 'application/json' : '*/*' } }, { timeoutMs });
  return json ? res.json() : res.text();
}

const decode = (s = '') =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i'));
  return m ? decode(m[1]) : '';
};

const isoDate = (raw = '') => {
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
};

// Workday's list gives only a relative label: "Posted Today", "Posted Yesterday", "Posted 5 Days Ago", "Posted 30+ Days Ago".
// "30+" has no date, so it stays empty rather than guessed.
const workdayPosted = (label = '') => {
  const m = /today|yesterday|(\d+)\+? days? ago/i.exec(label);
  if (!m || /\+/.test(label)) return '';
  const days = /today/i.test(m[0]) ? 0 : /yesterday/i.test(m[0]) ? 1 : Number(m[1]);
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
};

/** HTML (possibly entity-escaped, as Greenhouse sends it) to readable plain text. */
export function plain(html = '') {
  let s = String(html);
  if (/&lt;\/?[a-z]/i.test(s)) s = decode(s);
  s = s.replace(/<(?:br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, ' ');
  return decode(s).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}


/**
 * Fallback for career sites whose provider has no fetchDescription: the schema.org JobPosting JSON-LD if the page has one,
 * else the page's <main>/<article> text, else its body text (without scripts, navigation and footer). Returns '' when the page
 * yields less than 600 characters, which means a JavaScript-rendered page this crawler cannot read.
 */
export async function pageDescription(job) {
  try {
    const html = await get(job.url, { json: false, timeoutMs: 15000 });
    for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const d = JSON.parse(m[1]);
        for (const x of Array.isArray(d) ? d : (d['@graph'] ?? [d])) {
          const t = x?.['@type'];
          if ((Array.isArray(t) ? t.includes('JobPosting') : t === 'JobPosting') && x.description) {
            const text = plain(String(x.description));
            if (text.length >= 600) return text;
          }
        }
      } catch { /* not valid JSON: ignore this block */ }
    }
    const strip = (h) => plain(h.replace(/<(script|style|nav|header|footer|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')).replace(/\u00ad/g, '');
    // Page text, not a structured JobPosting: start at the line that is the job title (drops menus and leaked script), and
    // insist on 1,500 characters, because a shorter page is usually posting metadata (company, department, job id) without the role.
    const fromTitle = (t) => {
      const want = (job.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      const lines = t.split('\n');
      const i = want ? lines.findIndex((l, n) => n > 0 && l.toLowerCase().replace(/\s+/g, ' ').trim() === want) : -1;
      return i > 0 ? lines.slice(i).join('\n') : t;
    };
    let text = fromTitle(strip(html.match(/<(main|article)[\s\S]*?<\/\1>/i)?.[0] ?? ''));
    if (text.length < 1500) text = fromTitle(strip(html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? ''));
    return text.length >= 1500 ? text : '';
  } catch {
    return '';
  }
}


// ---- sitemap provider helpers ----
let cacheDir = null;
/** Where providers may keep small caches (the crawl's data folder). Without it the sitemap provider re-fetches pages. */
export function setCacheDir(dir) { cacheDir = dir; }
const cacheFile = (slug) => (cacheDir ? join(cacheDir, `sitemap-cache-${createHash('sha1').update(slug).digest('hex').slice(0, 10)}.json`) : null);
function loadSitemapCache(slug) {
  try { return JSON.parse(readFileSync(cacheFile(slug), 'utf8')); } catch { return {}; }
}
function saveSitemapCache(slug, c) {
  const f = cacheFile(slug);
  if (f) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(f, JSON.stringify(c)); }
}
async function robotsDisallow(origin) {
  try {
    const txt = await get(`${origin}/robots.txt`, { json: false, timeoutMs: 10000 });
    const out = [];
    let applies = false;
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*(user-agent|disallow)\s*:\s*(.*?)\s*$/i);
      if (!m) continue;
      if (m[1].toLowerCase() === 'user-agent') applies = m[2] === '*';
      else if (applies && m[2]) out.push(m[2]);
    }
    return out;
  } catch { return []; }
}
const attr = (html, prop) => html.match(new RegExp(`<meta[^>]+itemprop="${prop}"[^>]+content="([^"]*)"`, 'i'))?.[1] ?? '';
const dateOnly = (raw) => { const d = isoDate(decode(raw || '')); return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : ''; };

/** One job page to { title, url, location, postedAt, description } from JobPosting JSON-LD, else microdata. */
function parseJobPage(html, url) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const nodes = [].concat(data, data?.['@graph'] ?? []).flat();
    const jp = nodes.find((n) => n && [].concat(n['@type']).includes('JobPosting'));
    if (!jp) continue;
    const loc = [].concat(jp.jobLocation ?? []).map((l) => [l.address?.addressLocality, l.address?.addressCountry?.name ?? l.address?.addressCountry].filter(Boolean).join(', ')).filter(Boolean).join(' | ');
    return { title: decode(jp.title ?? ''), url, location: loc, postedAt: dateOnly(jp.datePosted), description: plain(jp.description ?? '') };
  }
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)?.[1];
  const tagTitle = html.match(/<title>([^<]*?)(?:\s+(?:Job Details|at|\|)|$).*?<\/title>/i)?.[1];
  const rawTitle = (html.match(/<span[^>]+itemprop="title"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ||
    attr(html, 'title') ||
    ogTitle ||
    tagTitle ||
    '').replace(/<[^>]+>/g, '');
  const title = decode(rawTitle).trim();
  const desc = html.match(/itemprop="description"[^>]*>([\s\S]*?)<\/(?:div|span)>\s*<\/(?:div|span)>/i)?.[1] ??
               html.match(/class=["'][^"']*(?:jobdescription|job-description)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i)?.[1] ?? '';
  const geoLoc = html.match(/class=["'][^"']*jobGeoLocation[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i)?.[1]?.replace(/<[^>]+>/g, '').trim();
  const loc = decode(attr(html, 'streetAddress') || attr(html, 'addressLocality') || geoLoc || '');
  return { title, url, location: loc, postedAt: dateOnly(attr(html, 'datePosted')), description: plain(desc) };
}

/** Board metadata of one posting, kept as the board gave it: empty values dropped, so a role without any returns undefined. */
export function metaOf(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    const x = Array.isArray(v) ? [...new Set(v.map((e) => (Array.isArray(e) ? e.join(': ') : String(e ?? '').trim())).filter(Boolean))] : typeof v === 'boolean' ? v : String(v ?? '').trim();
    if (x === false || x === '' || (Array.isArray(x) && !x.length)) continue;
    out[k] = Array.isArray(x) && x.length === 1 && k !== 'custom' && k !== 'locations' ? x[0] : x;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---- feed item -> job mappings kept pure so the tests can run them on captured documents ----

/** One item of a Teamtailor JSON Feed (/jobs.json). The posting's numeric id (the one in the URL) is _jobposting.identifier.value. */
export function teamtailorJob(item) {
  const jp = item._jobposting ?? {};
  const places = Array.isArray(jp.jobLocation) ? jp.jobLocation : [jp.jobLocation].filter(Boolean);
  const location = places.map((p) => [p?.address?.addressLocality, p?.address?.addressCountry].filter(Boolean).join(', ')).filter(Boolean);
  if (jp.jobLocationType === 'TELECOMMUTE') location.push('Remote');
  return {
    id: item.id,
    title: item.title ?? jp.title ?? '',
    url: item.url,
    location: location.join(' | '),
    postedAt: isoDate(item.date_published || jp.datePosted),
    description: plain(item.content_html ?? jp.description ?? ''),
    meta: metaOf({ employment: jp.employmentType, ref: jp.identifier?.value, remote: jp.jobLocationType === 'TELECOMMUTE', country: places.map((p) => p?.address?.addressCountry) }),
  };
}

/** One <item> of a Teamtailor RSS feed (/jobs.rss): title, link, city/country/remoteStatus, department, a partial description. */
export function teamtailorRssJob(b) {
  const city = tag(b, 'city') || tag(b, 'name');
  const country = tag(b, 'country');
  const remote = tag(b, 'remoteStatus');
  return {
    title: tag(b, 'title'),
    url: tag(b, 'link'),
    location: [city, country, remote === 'fully' ? 'Remote' : ''].filter(Boolean).join(', '),
    department: tag(b, 'department'),
    postedAt: isoDate(tag(b, 'pubDate')),
    description: plain(tag(b, 'description')),
  };
}

/** The posting's numeric id: the number in /jobs/<id>-<slug>. */
const teamtailorId = (url = '') => url.match(/\/jobs\/(\d+)/)?.[1] ?? '';

/**
 * A board's JSON Feed items joined with its RSS <item>s by posting id. The JSON item gives the posting (full description, date,
 * url, title, employment, address); the RSS item adds department and the location string the RSS mapping always produced
 * ("City, Country[, Remote]"), so neither changes for postings already stored. items null (no JSON feed): the RSS mapping alone.
 */
export function teamtailorMerge(items, xml = '') {
  const rss = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, b]) => teamtailorRssJob(b));
  if (!items) return rss;
  const byId = new Map(rss.filter((j) => teamtailorId(j.url)).map((j) => [teamtailorId(j.url), j]));
  return items.map((item) => {
    const job = teamtailorJob(item);
    const r = byId.get(String(item._jobposting?.identifier?.value ?? '') || teamtailorId(item.url));
    return r ? { ...job, location: r.location || job.location, department: r.department } : job;
  });
}

/** One entry of a Rippling board list (api.rippling.com/platform/api/ats/v1/board/<slug>/jobs); no description or date there. */
export function ripplingJob(j, slug) {
  return {
    id: j.uuid,
    title: j.name?.trim() ?? '',
    url: j.url ?? `https://ats.rippling.com/${slug}/jobs/${j.uuid}`,
    location: j.workLocation?.label ?? '',
    department: j.department?.label ?? '',
    postedAt: '',
    meta: metaOf({ departments: [j.department?.label] }),
  };
}

/** The per-job document of the Rippling board API: description is HTML, either a string or sections ({company, role}) in order. */
export function ripplingDescription(d) {
  const desc = d?.description;
  const parts = typeof desc === 'string' ? [desc] : Object.values(desc ?? {});
  return parts.filter((h) => typeof h === 'string').map((h) => plain(h)).filter(Boolean).join('\n\n');
}

export const providers = {
  greenhouse: {
    detect: (u) => u.match(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([\w-]+)/)?.[1],
    async fetch(slug) {
      const d = await get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
      return d.jobs.map((j) => ({
        title: j.title,
        url: j.absolute_url,
        location: j.location?.name ?? '',
        postedAt: j.first_published || '',   // the original publish date (updated_at moves on every edit)
        description: plain(j.content),
        meta: metaOf({ departments: (j.departments ?? []).map((x) => x.name), offices: (j.offices ?? []).map((x) => x.name), language: j.language, req: j.requisition_id, updated: j.updated_at, custom: (j.metadata ?? []).map((m) => [m.name, m.value]) }),
      }));
    },
  },

  ashby: {
    detect: (u) => u.match(/jobs\.ashbyhq\.com\/([\w.%-]+)/)?.[1],
    async fetch(slug) {
      const d = await get(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
      return d.jobs
        .filter((j) => j.isListed !== false)
        .map((j) => ({
          title: j.title,
          url: j.jobUrl,
          location: [j.location, ...(j.secondaryLocations ?? []).map((l) => l.location)].filter(Boolean).join(' | '),
          department: j.department ?? j.team ?? '',
          postedAt: j.publishedAt,
          description: j.descriptionPlain ?? plain(j.descriptionHtml),
          compensation: j.compensation?.compensationTierSummary ?? '',
          meta: metaOf({ departments: [j.department], teams: [j.team], employment: j.employmentType, workplace: j.workplaceType, remote: j.isRemote, region: j.address?.postalAddress?.addressRegion, country: j.address?.postalAddress?.addressCountry }),
        }));
    },
  },

  lever: {
    detect: (u) => u.match(/jobs(?:\.eu)?\.lever\.co\/([\w.-]+)/)?.[1],
    async fetch(slug, entry = {}) {
      const host = entry?.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
      const d = await get(`https://${host}/v0/postings/${slug}?mode=json`);
      return d.map((j) => ({
        title: j.text,
        url: j.hostedUrl,
        location: j.categories?.location ?? '',
        department: j.categories?.team ?? '',
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : '',
        description: [j.descriptionPlain, ...(j.lists ?? []).map((l) => l.text + '\n' + plain(l.content)), j.additionalPlain].filter(Boolean).join('\n\n'),
        meta: metaOf({ departments: [j.categories?.department], teams: [j.categories?.team], employment: j.categories?.commitment, workplace: j.workplaceType, country: j.country, locations: j.categories?.allLocations, salary: j.salaryRange ? [j.salaryRange.currency, j.salaryRange.min, j.salaryRange.max, j.salaryRange.interval].join(' ') : '' }),
      }));
    },
  },

  personio: {
    detect: (u) => u.match(/([\w-]+)\.jobs\.personio\.(?:de|com)/)?.[1],
    async fetch(slug, entry) {
      const tld = entry?.careers_url?.match(/personio\.(de|com)/)?.[1] ?? 'de';
      const base = `https://${slug}.jobs.personio.${tld}`;
      let xml;
      try {
        xml = await get(`${base}/xml`, { json: false });
      } catch {
        // Some tenants disable the XML feed; fall back to the server-rendered list ("Title | City, Country").
        const html = await get(`${base}/`, { json: false });
        return [...html.matchAll(/href="\/job\/(\d+)"[\s\S]*?jb-title">([^<]+)</g)].map(([, id, t]) => {
          const [title, ...loc] = decode(t).split(' | ');
          return { title, url: `${base}/job/${id}`, location: loc.join(' | '), department: '', postedAt: '' };
        });
      }
      return [...xml.matchAll(/<position>([\s\S]*?)<\/position>/g)].map(([, b]) => ({
        title: tag(b, 'name'),
        url: `${base}/job/${tag(b, 'id')}`,
        location: tag(b, 'office'),
        department: tag(b, 'department'),
        postedAt: isoDate(tag(b, 'createdAt')),
        meta: metaOf({ departments: [tag(b, 'department')], category: tag(b, 'recruitingCategory'), employment: tag(b, 'employmentType'), schedule: tag(b, 'schedule'), level: tag(b, 'seniority'), experience: tag(b, 'yearsOfExperience'), keywords: tag(b, 'keywords'), occupation: tag(b, 'occupationCategory') }),
        description: [...b.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/g)].map(([, d]) => tag(d, 'name') + '\n' + plain(tag(d, 'value'))).join('\n\n'),
      }));
    },
    async fetchDescription(job) {
      if (job.description) return job.description;
      const html = await get(job.url, { json: false });
      const body = html.match(/<main[\s\S]*?<\/main>|<article[\s\S]*?<\/article>/i)?.[0] ?? html;
      return plain(body);
    },
  },

  smartrecruiters: {
    detect: (u) => u.match(/(?:jobs|careers)\.smartrecruiters\.com\/([\w-]+)/)?.[1],
    async fetch(slug) {
      const out = [];
      for (let offset = 0; offset < 500; offset += 100) {
        const d = await get(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100&offset=${offset}`);
        for (const j of d.content) {
          out.push({
            id: j.id,
            title: j.name,
            url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
            location: [j.location?.city, j.location?.country?.toUpperCase()].filter(Boolean).join(', '),
            department: j.department?.label ?? '',
            postedAt: isoDate(j.releasedDate),
            meta: metaOf({ departments: [j.department?.label], function: j.function?.label, industry: j.industry?.label, employment: j.typeOfEmployment?.label, level: j.experienceLevel?.label, remote: j.location?.remote, hybrid: j.location?.hybrid, ref: j.refNumber }),
          });
        }
        if (out.length >= d.totalFound) break;
      }
      return out;
    },
    async fetchDescription(job, slug) {
      const id = job.id ?? job.url.split('/').pop();
      const d = await get(`https://api.smartrecruiters.com/v1/companies/${slug}/postings/${id}`);
      const s = d.jobAd?.sections ?? {};
      return [s.companyDescription, s.jobDescription, s.qualifications, s.additionalInformation]
        .filter((sec) => sec?.text)
        .map((sec) => (sec.title ? `${sec.title}\n` : '') + plain(sec.text))
        .join('\n\n');
    },
  },

  // Teamtailor: /jobs.json is a JSON Feed 1.1 whose items carry the full HTML description (content_html) and a schema.org
  // JobPosting (_jobposting: identifier, datePosted, employmentType, jobLocation) but no department; /jobs.rss has the department
  // and the location names. Both are fetched and merged per posting (teamtailorMerge); the RSS alone when the JSON feed fails.
  teamtailor: {
    detect: (u) => {
      if (/careers\.reorbit\.space/i.test(u)) return 'reorbit';
      if (/careers\.revolvspace\.com/i.test(u)) return 'https://careers.revolvspace.com';
      if (/careers\.open-cosmos\.com/i.test(u)) return 'https://careers.open-cosmos.com';
      const own = u.match(/^(https?:\/\/[\w.-]+)\/jobs\/\d{6,}-[\w-]+/i)?.[1];
      if (own && !/teamtailor\.com/i.test(own)) return own;
      return u.match(/([\w-]+)\.teamtailor\.com/)?.[1];
    },
    async fetch(slug) {
      const base = slug.startsWith('http') ? slug.replace(/\/jobs\.rss$/, '').replace(/\/+$/, '') : `https://${slug}.teamtailor.com`;
      let items = null, xml;
      try {
        const feed = JSON.parse(await get(`${base}/jobs.json`, { json: false }));
        if (Array.isArray(feed.items)) items = feed.items;
      } catch { /* not served or not JSON: the RSS alone */ }
      try {
        xml = await get(`${base}/jobs.rss`, { json: false });
      } catch (err) {
        if (!items) throw err;   // neither feed answered
      }
      return teamtailorMerge(items, xml ?? '');
    },
  },

  // Recruitee: public offers API per company subdomain or custom career domain.
  recruitee: {
    detect: (u) => {
      const s = u.match(/([\w-]+)\.recruitee\.com/)?.[1];
      if (s && !['www', 'api', 'app', 'careers-analytics'].includes(s)) return s;
      if (/career\.quantum-systems\.com/i.test(u)) return 'https://career.quantum-systems.com';
      if (/careers\.maia-space\.com/i.test(u)) return 'maiaspace';
      if (/careers\.morpheus\.space/i.test(u)) return 'https://careers.morpheus.space';
      return null;
    },
    async fetch(slug, entry = {}) {
      const origin = entry.api || (slug.startsWith('http') ? slug.replace(/\/+$/, '') : `https://${slug}.recruitee.com`);
      const data = await get(`${origin}/api/offers/`);
      return (data.offers ?? []).filter((o) => o.status === undefined || o.status === 'published').map((o) => ({
        title: o.title ?? '',
        url: o.careers_url ?? `${origin}/o/${o.slug}`,
        location: o.location || [o.city, o.country].filter(Boolean).join(', '),
        department: o.department ?? '',
        postedAt: isoDate(o.published_at || o.created_at),
        description: plain(`${o.description ?? ''} ${o.requirements ?? ''}`),
        meta: metaOf({ departments: [o.department], employment: (o.employment_type_code ?? '').replace(/_/g, ' '), level: (o.experience_code ?? '').replace(/_/g, ' '), category: (o.category_code ?? '').replace(/_/g, ' '), education: (o.education_code ?? '').replace(/_/g, ' '),
          remote: o.remote, hybrid: o.hybrid, tags: o.tags, country: o.country, salary: o.salary?.min ? [o.salary.currency, o.salary.min, o.salary.max, o.salary.period].join(' ') : '' }),
      }));
    },
  },

  // Generic fallback for career sites without a job-board API (SAP SuccessFactors, custom sites): read the public
  // sitemap, then each job page's schema.org JobPosting markup (JSON-LD or microdata), which employers publish for
  // Google for Jobs and which carries the original datePosted. Entry: { provider: 'sitemap', slug: <sitemap url>,
  // url_pattern: <regex a job URL must match>, max_jobs }. Pages already fetched are cached by sitemap lastmod, so
  // a cycle only downloads new or changed jobs. Be gentle: 4 parallel requests, robots.txt Disallow honoured.
  sitemap: {
    detect: () => null,
    async fetch(slug, entry = {}) {
      const origin = new URL(slug).origin;
      const disallow = await robotsDisallow(origin);
      let xml = await get(slug, { json: false, timeoutMs: 30000 });
      if (/<sitemapindex/i.test(xml)) {   // an index: read its child sitemaps (at most 10)
        const kids = [...xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1])).slice(0, 10);
        xml = (await Promise.all(kids.map((k) => get(k, { json: false, timeoutMs: 30000 }).catch(() => '')))).join(' ');
      }
      const pat = entry.url_pattern ? new RegExp(entry.url_pattern) : /./;
      const urls = [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]*)<\/lastmod>)?/g)]
        .map((m) => ({ url: decode(m[1]), lastmod: m[2] || '' }))
        .filter((u) => pat.test(u.url) && !disallow.some((d) => new URL(u.url).pathname.startsWith(d)))
        .slice(0, entry.max_jobs ?? 3000);
      const cache = loadSitemapCache(slug);
      const todo = urls.filter((u) => cache[u.url]?.lastmod !== u.lastmod || !cache[u.url]?.job);
      let i = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (i < todo.length) {
          const u = todo[i++];
          try {
            cache[u.url] = { lastmod: u.lastmod, job: parseJobPage(await get(u.url, { json: false, timeoutMs: 25000 }), u.url) };
          } catch (e) { if (!cache[u.url]) cache[u.url] = { lastmod: u.lastmod, job: null }; }
          await new Promise((r) => setTimeout(r, 150));
        }
      }));
      const live = new Set(urls.map((u) => u.url));
      for (const k of Object.keys(cache)) if (!live.has(k)) delete cache[k];
      saveSitemapCache(slug, cache);
      return urls.map((u) => cache[u.url]?.job).filter((j) => j?.title);
    },
  },

  // Cornerstone OnDemand career sites (<tenant>.csod.com/ux/ats/careersite/<id>/home?c=<corp>). The home page embeds an
  // anonymous bearer token (plus session cookies some tenants insist on); the public search API takes it. Approach as
  // documented in the MIT-licensed career-ops project (providers/csod.mjs). slug = the career-site home URL.
  csod: {
    detect: (u) => (/^https:\/\/[\w-]+\.csod\.com\/ux\/ats\/careersite\/\d+/i.test(u) ? u.split('#')[0] : null),
    async fetch(slug) {
      const u = new URL(slug);
      const siteId = Number(u.pathname.match(/careersite\/(\d+)/)[1]);
      const corp = u.searchParams.get('c') || u.host.split('.')[0];
      const home = await fetch(`${u.origin}/ux/ats/careersite/${siteId}/home?c=${encodeURIComponent(corp)}`, { headers: { 'user-agent': UA }, redirect: 'error', signal: AbortSignal.timeout(20000) });
      const token = (await home.text()).match(/"token"\s*:\s*"([\w.-]+)"/)?.[1];
      if (!token) throw new Error(`no anonymous token on ${u.origin}`);
      const cookie = (home.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
      const crawlCulture = async (cultureId, cultureName) => {
      const out = [], seen = new Set();
      for (let page = 1; page <= 40; page++) {
        if (page > 1) await new Promise((r) => setTimeout(r, 120));
        const res = await fetch(`${u.origin}/services/x/career-site/v1/search`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
          headers: { 'user-agent': UA, 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}`, ...(cookie ? { cookie } : {}) },
          body: JSON.stringify({ careerSiteId: siteId, careerSitePageId: siteId, pageNumber: page, pageSize: 25, cultureId, cultureName, searchText: '', states: [], countryCodes: [], cities: [], placeID: '', radius: null, postingsWithinDays: null, customFieldCheckboxKeys: [], customFieldDropdowns: [], customFieldRadios: [] }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} csod search`);
        const d = (await res.json()).data ?? {};
        const rows = d.requisitions ?? [];
        let fresh = 0;
        for (const r of rows) {
          const id = String(r.requisitionId ?? '');
          if (!id || seen.has(id)) continue;
          seen.add(id); fresh++;
          const m = String(r.postingEffectiveDate ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);   // US order M/D/YYYY
          out.push({
            title: decode(String(r.displayJobTitle ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' '),
            url: `${u.origin}/ux/ats/careersite/${siteId}/home/requisition/${id}?c=${encodeURIComponent(corp)}`,
            location: (r.locations ?? []).map((l) => [l.city, l.country].filter(Boolean).join(', ')).filter(Boolean).join(' / '),
            postedAt: m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '',
          });
        }
        if (!fresh || page * 25 >= (d.totalCount ?? 0) || rows.length < 25) break;
      }
      return out;
      };
      // Postings written only in German carry the template title "insert title of the position (m/f/d)" in the English view (seen on
      // OHB / MT Aerospace). For those the German view holds the real title, so it is fetched once and used where the English one is a placeholder.
      const out = await crawlCulture(1, 'en-US');
      const isPlaceholder = (t) => /^insert title of the position/i.test(t);
      if (out.some((r) => isPlaceholder(r.title))) {
        const de = new Map((await crawlCulture(3, 'de-DE')).map((r) => [r.url, r.title]));
        for (const r of out) if (isPlaceholder(r.title) && de.get(r.url)) r.title = de.get(r.url);
      }
      return out;
    },
  },

  // Eightfold AI: public positions API on <tenant>.eightfold.ai (10 per page). slug = the career-site URL; add
  // ?domain=<company domain> when the tenant needs it. Approach as in career-ops (MIT) providers/eightfold.mjs; its
  // newer /api/pcsx/search fallback for tenants that answer 403 here is not ported.
  eightfold: {
    detect: (u) => (/^https:\/\/[\w-]+\.eightfold\.ai\//i.test(u) ? u.split('#')[0] : null),
    async fetch(slug) {
      const u = new URL(slug);
      const domain = u.searchParams.get('domain');
      const out = [];
      // Tenants migrated to Eightfold's newer career-site API answer /api/apply/v2/jobs with 403 "Not authorized for PCSX"; their board is
      // on /api/pcsx/search instead (same host; fields postedTs, positionUrl, locations[]). Approach as in career-ops (MIT) eightfold.mjs.
      let pcsx = false;
      for (let start = 0; start < 3000; start += 10) {
        if (start) await new Promise((r) => setTimeout(r, pcsx ? 400 : 250));
        let d;
        if (!pcsx) {
          try { d = await get(`${u.origin}/api/apply/v2/jobs?${domain ? `domain=${encodeURIComponent(domain)}&` : ''}start=${start}&num=10`); }
          catch (e) {
            if (start || !/HTTP 403/.test(String(e.message))) throw e;
            pcsx = true;
          }
        }
        if (pcsx) d = (await get(`${u.origin}/api/pcsx/search?${domain ? `domain=${encodeURIComponent(domain)}&` : ''}start=${start}&num=10`)).data ?? {};
        const pos = d.positions ?? [];
        for (const p of pos) {
          const ts = Number(p.t_create ?? p.t_update ?? p.postedTs ?? p.creationTs);
          const locs = [p.location, ...(p.locations ?? []), ...(pcsx ? (p.standardizedLocations ?? []) : [])];
          out.push({
            title: String(p.name ?? p.posting_name ?? '').trim(),
            url: p.canonicalPositionUrl || (p.positionUrl ? `${u.origin}${p.positionUrl}${domain ? `?domain=${encodeURIComponent(domain)}` : ''}` : `${u.origin}/careers?pid=${p.id}${domain ? `&domain=${encodeURIComponent(domain)}` : ''}`),
            location: [...new Set(locs.filter((x) => typeof x === 'string' && x.trim()))].join(' · '),
            postedAt: ts > 0 ? new Date(ts * 1000).toISOString().slice(0, 10) : '',
          });
        }
        if (pos.length < 10 || (typeof d.count === 'number' && start + 10 >= d.count)) break;
      }
      return out.filter((j) => j.title);
    },
  },

  // Oracle Recruiting Cloud (Fusion HCM candidate experience): public REST finder. slug = the career-site URL
  // https://<host>.fa.<region>.oraclecloud.com/hcmUI/CandidateExperience/<lang>/sites/<siteNumber>. Approach as in
  // career-ops providers/oraclecloud.mjs.
  oraclecloud: {
    detect: (u) => (/^https:\/\/[\w-]+\.fa\.(?:[\w-]+\.)?(?:ocs\.)?oraclecloud\d*\.com\//i.test(u) ? u.split('#')[0] : null),
    async fetch(slug) {
      const u = new URL(slug);
      const segs = u.pathname.split('/').filter(Boolean);
      const lang = segs[segs.indexOf('CandidateExperience') + 1] || 'en';
      const site = segs[segs.indexOf('sites') + 1] || 'CX_1';
      const out = [];
      for (let offset = 0; offset < 5000; offset += 200) {
        if (offset) await new Promise((r) => setTimeout(r, 250));
        const finder = `findReqs;siteNumber=${site},limit=200,sortBy=POSTING_DATES_DESC,offset=${offset}`;
        const d = await get(`${u.origin}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=${encodeURIComponent('requisitionList.workLocation,requisitionList.secondaryLocations')}&finder=${encodeURIComponent(finder)}&limit=200&offset=${offset}`);
        const item = d.items?.[0] ?? {};
        const list = item.requisitionList ?? [];
        for (const r of list) {
          out.push({
            title: r.Title ?? '',
            url: r.ExternalURL || `${u.origin}/hcmUI/CandidateExperience/${lang}/sites/${site}/job/${r.Id}`,
            location: r.PrimaryLocation || '',
            postedAt: /^\d{4}-\d{2}-\d{2}/.test(r.PostedDate ?? '') ? r.PostedDate.slice(0, 10) : '',
            description: plain(r.ShortDescriptionStr ?? ''),
          });
        }
        if (!list.length || offset + 200 >= (item.TotalJobsCount ?? 0)) break;
      }
      return out.filter((j) => j.title);
    },
  },

  // join.com: the company page embeds its job list as __NEXT_DATA__ JSON. No publish date on the list.
  // Approach as in career-ops providers/join.mjs.
  join: {
    detect: (u) => u.match(/join\.com\/companies\/([\w-]+)/)?.[1],
    async fetch(slug) {
      const out = [];
      let pages = 1;
      for (let page = 1; page <= Math.min(pages, 50); page++) {
        const html = await get(`https://join.com/companies/${slug}${page > 1 ? `?page=${page}` : ''}`, { json: false });
        const raw = html.match(/<script[^>]+__NEXT_DATA__[^>]*>([\s\S]*?)<\/script>/)?.[1];
        const st = raw ? JSON.parse(raw)?.props?.pageProps?.initialState : null;
        if (!st?.jobs?.items) throw new Error('join: unexpected page structure');
        pages = st.jobs.pagination?.pageCount || 1;
        for (const j of st.jobs.items) out.push({ title: j.title ?? '', url: `https://join.com/companies/${st.company?.domain || slug}/jobs/${j.idParam}`, location: j.city?.cityName ?? '', postedAt: '' });
        if (page > 1) await new Promise((r) => setTimeout(r, 200));
      }
      return out;
    },
  },

  // softgarden: server-rendered widget listing every posting with its date (M/D/Y or D.M.Y). Approach as in
  // career-ops providers/softgarden.mjs. slug = the tenant host, e.g. acme.softgarden.io.
  softgarden: {
    detect: (u) => u.match(/([\w-]+\.softgarden\.io)/i)?.[1],
    async fetch(slug) {
      const host = slug.includes('.') ? slug : `${slug}.softgarden.io`;
      const url = `https://${host}/de/widgets/jobs`;
      const html = await get(url, { json: false });
      const out = [], seen = new Set();
      for (const block of html.split(/<div class="matchElement" id="job_id_/).slice(1)) {
        const id = block.match(/^(\d+)"/)?.[1];
        const a = block.match(/<a href="([^"]*\/job\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!id || !a || seen.has(id)) continue;
        seen.add(id);
        const cities = [...block.matchAll(/class="location-view-item"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => plain(m[1])).filter(Boolean);
        const raw = plain(block.match(/class="matchValue date"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '');
        const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/), dot = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
        const [mo, da, yr] = slash ? [slash[1], slash[2], slash[3]] : dot ? [dot[2], dot[1], dot[3]] : [];
        const y = yr ? (yr.length === 2 ? '20' + yr : yr) : '';
        out.push({ title: plain(a[2]), url: new URL(decode(a[1]), url).href, location: [...new Set(cities)].join(' / '), postedAt: y ? `${y}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}` : '' });
      }
      return out;
    },
  },

  // Rheinmetall: server-rendered vacancy list, 10 per page, no dates; so it belongs on a long crawl interval
  // (interval_hours) with only_locations. Approach as in career-ops providers/rheinmetall.mjs.
  rheinmetall: {
    detect: (u) => (/^https:\/\/(?:www\.)?rheinmetall\.com\//i.test(u) ? 'vacancies' : null),
    async fetch() {
      const out = [], seen = new Set();
      for (let page = 1; page <= 150; page++) {
        if (page > 1) await new Promise((r) => setTimeout(r, 150));
        const html = await get(`https://www.rheinmetall.com/en/career/vacancies?page=${page}`, { json: false });
        let fresh = 0;
        for (const block of html.split(/<div class="flex gap-0\.5 group">/).slice(1)) {
          const link = block.match(/href="(\/[a-z]{2}\/job\/[^"]+\/(\d+))"/);
          if (!link || seen.has(link[2])) continue;
          seen.add(link[2]); fresh++;
          const t = block.match(/md:text-xl[^"]*">([\s\S]*?)<\/div>/);
          const slug = decodeURIComponent(link[1].split('/')[3] || '').replace(/_/g, ' ');
          const org = plain(block.match(/class="flex flex-wrap mr-6">([\s\S]*?)<\/div>/)?.[1] ?? '');
          out.push({ title: plain(t?.[1] ?? slug), url: 'https://www.rheinmetall.com' + link[1], location: org.includes('|') ? org.split('|').pop().trim() : '', postedAt: '' });
        }
        if (!fresh) break;
      }
      return out.filter((j) => j.title);
    },
  },

  // Workable: public widget API per account.
  workable: {
    detect: (u) => {
      const s = u.match(/apply\.workable\.com\/([\w-]+)/)?.[1];
      return s && !['api', 'j', 'www'].includes(s) ? s : null;
    },
    async fetch(slug) {
      const data = await get(`https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`);
      return (data.jobs ?? []).map((j) => ({
        title: j.title ?? '',
        url: j.url ?? j.application_url ?? `https://apply.workable.com/${slug}/j/${j.shortcode}/`,
        location: [j.city, j.state, j.country].filter(Boolean).join(', '),
        department: j.department ?? '',
        postedAt: isoDate(j.published_on || j.created_at),
        description: plain(j.description ?? ''),
      }));
    },
  },

  workday: {
    detect: (u) => {
      const m = u.match(/https?:\/\/([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([\w-]+)/);
      return m ? `${m[1]}|${m[2]}|${m[3]}` : null;
    },
    // Workday pages by 20 and clamps every query at 2000 rows: past that, `total` stays 2000 and offset 2000 repeats offset 0 (seen on
    // Airbus: 2000 reported, about 3000 real). A clamped query is therefore re-run once per value of a facet (job family, company,
    // country ...) until each slice fits. `entry.facets` ({ facetParameter: [id] }) can narrow a huge board up front, e.g. one country.
    async fetch(slug, entry = {}) {
      const [tenant, wd, site] = slug.split('|');
      const base = `https://${tenant}.${wd}.myworkdayjobs.com`;
      const api = `${base}/wday/cxs/${tenant}/${site}/jobs`;
      const searchText = entry.search_text ?? entry.query ?? '';
      const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      const CLAMP = 2000;
      const out = new Map();
      const post = async (appliedFacets, offset) => (await request(api, {
        method: 'POST',
        headers: { 'user-agent': BROWSER_UA, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ appliedFacets, limit: 20, offset, searchText }),
      })).json();
      // Facets can nest (a group holding facets); flatten to { facetParameter, values }. Date buckets overlap, so never split on them.
      const flat = (fs = []) => fs.flatMap((f) => (f.facetParameter ? [f] : flat(f.values))).filter((f) => f.values?.length && f.facetParameter !== 'startDate');
      async function crawl(applied, depth = 0) {
        let first = await post(applied, 0), total = first.total ?? 0;
        if (total >= CLAMP && depth < 2) {
          // Split on a facet that covers (nearly) the whole board, not a partial one such as a national grade list, and among
          // those on the one whose largest slice is smallest. Facets already applied are skipped.
          const sum = (f) => f.values.reduce((a, v) => a + (v.count ?? 0), 0), big = (f) => Math.max(...f.values.map((v) => v.count ?? 0));
          const usable = flat(first.facets).filter((f) => !(f.facetParameter in applied) && f.values.every((v) => v.id));
          const size = Math.max(0, ...usable.map(sum));
          const best = usable.filter((f) => sum(f) >= 0.9 * size).sort((x, y) => big(x) - big(y))[0];
          if (best) {
            for (const v of best.values) if (v.count) await crawl({ ...applied, [best.facetParameter]: [v.id] }, depth + 1);
            return;
          }
        }
        for (let offset = 0; ; offset += 20) {
          const d = offset ? await post(applied, offset) : first;
          const rows = d.jobPostings ?? [];
          for (const j of rows) {
            if (!j.externalPath || out.has(j.externalPath)) continue;
            out.set(j.externalPath, {
              externalPath: j.externalPath,
              title: j.title ?? '',
              url: `${base}/${site}${j.externalPath}`,
              location: j.locationsText ?? '',
              postedAt: workdayPosted(j.postedOn),
            });
          }
          if (!rows.length || offset + 20 >= Math.min(total, CLAMP)) break;
          await sleep(120);
        }
      }
      await crawl(entry.facets ?? {});
      return [...out.values()];
    },
    async fetchDescription(job, slug) {
      const [tenant, wd, site] = slug.split('|');
      const path = job.externalPath ?? new URL(job.url).pathname.replace(new RegExp(`^/${site}`), '');
      const d = await get(`https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}${path}`);
      return plain(d.jobPostingInfo?.jobDescription ?? '');
    },
  },

  mycareersfuture: {
    detect: (u) => (/mycareersfuture\.gov\.sg/.test(u) ? 'singapore' : null),
    async fetch(slug, entry = {}) {
      const queries = entry.queries && entry.queries.length ? entry.queries : ['optics', 'satellite', 'aerospace', 'cleanroom', 'photonics'];
      const seen = new Map();
      for (const q of queries) {
        try {
          const res = await get(`https://api.mycareersfuture.gov.sg/v2/jobs?limit=50&page=0&search=${encodeURIComponent(q)}`);
          for (const j of res.results ?? []) {
            if (!seen.has(j.uuid)) {
              seen.set(j.uuid, {
                title: j.title ?? '',
                company: j.postedCompany?.name ? `${j.postedCompany.name} (via MyCareersFuture)` : 'MyCareersFuture',
                url: `https://www.mycareersfuture.gov.sg/job/${j.uuid}`,
                location: 'Singapore',
                postedAt: j.metadata?.originalPostingDate ?? '',
                compensation: j.salary?.min && j.salary?.max ? `S$${j.salary.min}–S$${j.salary.max}/mo` : undefined,
                description: plain(j.description ?? ''),
                // Board's own labels, kept as a signal for the company scope check (see board-labels.mjs).
                orgMeta: j.postedCompany?.name ? {
                  board: 'mycareersfuture', id: j.postedCompany.uen ?? '', name: j.postedCompany.name,
                  ssic: j.postedCompany.ssicCode2020 ?? j.postedCompany.ssicCode ?? '', ssic_desc: j.postedCompany.ssicDescription2020 ?? '',
                  employees: j.postedCompany.employeeCount ?? null, url: j.postedCompany.companyUrl ?? '',
                  description: plain(j.postedCompany.description ?? '').slice(0, 1500),
                  categories: (j.categories ?? []).map((c) => c.category), skills: (j.skills ?? []).slice(0, 8).map((x) => x.skill),
                } : undefined,
                // Employer metadata for the strict relevance gate (relevance.mjs); crawl.mjs ignores it otherwise.
                sg: {
                  employer: j.postedCompany?.name ?? '',
                  hiring: j.hiringCompany?.name ?? '',
                  ssic: [j.postedCompany?.ssicCode2020, j.postedCompany?.ssicCode, j.hiringCompany?.ssicCode2020, j.hiringCompany?.ssicCode].filter(Boolean),
                  skills: (j.skills ?? []).map((s) => s.skill).filter(Boolean),
                  onBehalf: !!j.metadata?.isPostedOnBehalf,
                },
              });
            }
          }
        } catch {}
      }
      return [...seen.values()];
    },
  },

  spacecareers: {
    detect: (u) => (/space-careers\.com/.test(u) ? 'global' : null),
    // entry.queries: employer watch. The listing shows only the newest ~30 jobs and the site has no query-string search or paging, so
    // the watch keeps the jobs whose company matches one of the terms; read it often enough and nothing from that employer is missed.
    async fetch(slug, entry = {}) {
      const html = await get('https://www.space-careers.com/job_search', { json: false });
      const want = entry.queries?.length ? new RegExp(entry.queries.map((q) => q.replace(/[^\w ]/g, '.')).join('|'), 'i') : null;
      const regex = /<h3><a href="(\/job_display\/[^"]+)">([^<]+)<\/a><\/h3>\s*<div class="companyName">([^<]+)<\/div>\s*<div class="location">([^<]+)<\/div>/g;
      const jobs = [];
      for (const m of html.matchAll(regex)) {
        if (want && !want.test(decode(m[3]))) continue;
        jobs.push({
          title: decode(m[2]),
          company: `${decode(m[3])} (via Space-Careers)`,
          location: decode(m[4]),
          url: `https://www.space-careers.com${m[1]}`,
          postedAt: '',
        });
      }
      return jobs;
    },
    async fetchDescription(job) {
      try {
        const html = await get(job.url, { json: false });
        const start = html.indexOf('<h3>About the Role</h3>');
        const end = html.indexOf('class="apply', start);
        if (start !== -1 && end > start) {
          return plain(html.slice(start, end));
        }
        return '';
      } catch {
        return '';
      }
    },
  },

  // spaceindividuals.com publishes its whole job board as one JSON document; each job carries its own company.
  spaceindividuals: {
    detect: (u) => (/spaceindividuals\.com/.test(u) ? 'global' : null),
    async fetch() {
      const data = await get('https://spaceindividuals.com/get-all-jobs-published');
      return data.map((j) => ({
        title: (j.jobTitle ?? '').trim(),
        company: `${(j.companyName ?? 'Unknown').trim()} (via Space Individuals)`,
        location: (j.jobLocation ?? '').trim(),
        url: j.applyExternalSiteInput || `https://spaceindividuals.com/job/${j._id}`,
        postedAt: (j.createdAt ?? '').slice(0, 10),
        description: plain(`${j.jobDescription ?? ''} ${j.jobRequirements ?? ''} ${j.jobResponsibilities ?? ''}`),
        orgMeta: { board: 'space-individuals', id: j.companyID ?? '', name: (j.companyName ?? '').trim(), contract: j.contractType ?? '' },
      })).filter((j) => j.title);
    },
  },

  jobsinphotonics: {
    detect: (u) => (/jobs-in-photonics\.com/.test(u) ? 'global' : null),
    async fetch(slug, entry = {}) {
      const queries = entry.queries && entry.queries.length ? entry.queries : ['laser', 'optical', 'photonics', 'cleanroom', 'test'];
      const seen = new Map();
      for (const q of queries) {
        try {
          const res = await get(`https://jobs-in-photonics.com/wp-json/wp/v2/jobs?search=${encodeURIComponent(q)}&per_page=30`);
          if (!Array.isArray(res)) continue;
          for (const j of res) {
            if (!seen.has(j.id)) {
              const rawTitle = decode(j.title?.rendered ?? '');
              let company = 'Jobs-in-Photonics (EPIC)';
              let title = rawTitle;
              if (rawTitle.includes(' – ')) {
                const parts = rawTitle.split(' – ');
                title = parts[0].trim();
                company = `${parts.slice(1).join(' – ').trim()} (via Jobs-in-Photonics)`;
              } else if (rawTitle.includes(' - ')) {
                const parts = rawTitle.split(' - ');
                title = parts[0].trim();
                company = `${parts.slice(1).join(' - ').trim()} (via Jobs-in-Photonics)`;
              }
              const desc = plain(j.content?.rendered ?? '');
              const fullText = (rawTitle + ' ' + desc).toLowerCase();
              if (company === 'Jobs-in-Photonics (EPIC)') {
                if (fullText.includes('diehl defence') || fullText.includes('diehl')) {
                  company = 'Diehl Defence (via Jobs-in-Photonics)';
                } else if (fullText.includes('toptica')) {
                  company = 'TOPTICA Photonics (via Jobs-in-Photonics)';
                } else if (fullText.includes('trumpf')) {
                  company = 'TRUMPF (via Jobs-in-Photonics)';
                } else if (fullText.includes('zeiss')) {
                  company = 'ZEISS (via Jobs-in-Photonics)';
                } else if (fullText.includes('jenoptik')) {
                  company = 'Jenoptik (via Jobs-in-Photonics)';
                }
              }
              seen.set(j.id, {
                title,
                company,
                location: 'Europe',
                url: j.link,
                postedAt: j.date?.slice(0, 10) ?? '',
                description: plain(j.content?.rendered ?? ''),
              });
            }
          }
        } catch {}
      }
      return [...seen.values()];
    },
  },

  // Dover (app.dover.com): public careers-page list, Django-style pages of up to 300. Endpoint and location rules from
  // career-ops-hq/career-ops providers/dover.mjs (MIT). Slug: "<Company>|<board uuid>".
  dover: {
    detect: (u) => {
      const m = u.match(/app\.dover\.com\/([^/]+)\/careers\/([0-9a-f-]{36})/i);
      return m ? `${decodeURIComponent(m[1])}|${m[2].toLowerCase()}` : null;
    },
    async fetch(slug) {
      const [company, board] = slug.split('|');
      const out = [];
      for (let offset = 0; offset < 1500; offset += 300) {
        const d = await get(`https://app.dover.com/api/v1/careers-page/${board}/jobs?limit=300&offset=${offset}`);
        for (const j of d.results ?? []) {
          if (j.is_published === false || j.is_sample === true || !j.title || !j.id) continue;
          const place = (l) => {
            const name = (l.location_option?.display_name || l.name || '').trim();
            const type = String(l.location_type ?? '').toUpperCase();
            return type === 'REMOTE' ? `Remote${name ? ` (${name})` : ''}` : type === 'HYBRID' ? `${name} (Hybrid)` : name;
          };
          out.push({
            title: j.title.trim(),
            url: `https://app.dover.com/apply/${encodeURIComponent(company)}/${encodeURIComponent(j.id)}`,
            location: (j.locations ?? []).map(place).filter(Boolean).join(' | ') || (/remote/i.test(j.workplace_type ?? '') ? 'Remote' : ''),
            postedAt: '',
          });
        }
        if (!d.next) break;
        await sleep(200);
      }
      return out;
    },
  },

  // Jobvite: the old JSON API is retired; the working public feed is XML keyed by an opaque companyEId that only appears in the
  // board page's inline script (documented in career-ops-hq/career-ops providers/jobvite.mjs, MIT). Slug: board name or "eid:<id>".
  jobvite: {
    detect: (u) => u.match(/jobs\.jobvite\.com\/(?:careers\/)?([\w-]+)/i)?.[1],
    async fetch(slug) {
      let eid = slug.startsWith('eid:') ? slug.slice(4) : '';
      if (!eid) {
        const page = await get(`https://jobs.jobvite.com/${slug}`, { json: false });
        eid = page.match(/companyEId\s*[:=]\s*['"]([\w-]+)['"]/)?.[1] ?? '';
        if (!eid) throw new Error(`jobvite: no companyEId on the board page of ${slug}`);
      }
      const xml = await get(`https://app.jobvite.com/CompanyJobs/Xml.aspx?c=${eid}`, { json: false });
      return [...xml.matchAll(/<job>([\s\S]*?)<\/job>/g)].map(([, b]) => {
        const [mo, da, yr] = tag(b, 'date').split('/');
        return {
          title: tag(b, 'title'),
          url: tag(b, 'detail-url') || tag(b, 'apply-url'),
          location: tag(b, 'location'),
          department: tag(b, 'category'),
          postedAt: yr ? `${yr}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}` : '',
        };
      }).filter((j) => j.title && j.url);
    },
  },

  // Phenom People ("CareerConnect" sites on a company's own domain): a public POST {origin}/widgets "refineSearch" call, 100 per page.
  // No auto-detection (tenants sit on branded domains): set provider "phenom" and slug to the careers origin. Shape from
  // career-ops-hq/career-ops providers/phenom.mjs (MIT). Optional entry.phenom: { lang, country, urlPrefix, selectedFields }.
  phenom: {
    detect: () => null,
    async fetch(slug, entry = {}) {
      const origin = new URL(slug).origin, cfg = entry.phenom ?? {};
      const prefix = String(cfg.urlPrefix ?? 'global/en').replace(/^\/+|\/+$/g, '');
      const out = [];
      for (let from = 0; from < 2000; from += 100) {
        const res = await request(`${origin}/widgets`, {
          method: 'POST',
          headers: { 'user-agent': UA, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ lang: cfg.lang ?? 'en_global', country: cfg.country ?? 'global', ddoKey: 'refineSearch', pageName: 'search-results',
            siteType: 'external', jobs: true, counts: false, from, size: 100, keywords: '', selected_fields: cfg.selectedFields ?? {}, all_fields: [] }),
          redirect: 'error',
        });
        const rs = (await res.json()).refineSearch ?? {};
        const rows = rs.data?.jobs ?? [];
        for (const j of rows) {
          if (!j.jobId || !j.title) continue;
          const title = plain(String(j.title));
          out.push({
            title,
            url: `${origin}/${prefix}/job/${j.jobId}/${title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'job'}`,
            location: plain(String(j.location || j.cityStateCountry || [j.city, j.state, j.country].filter(Boolean).join(', '))),
            postedAt: isoDate(j.postedDate),
          });
        }
        if (!rows.length || from + 100 >= (rs.totalHits ?? 0)) break;
        await sleep(150);
      }
      return out;
    },
  },

  // Rippling: the board API lists {uuid, name, department, url, workLocation} without a description or date (no key needed);
  // the per-job call adds description {company, role} (HTML), workLocations, employmentType and createdOn.
  rippling: {
    detect: (u) => u.match(/ats\.rippling\.com\/([\w-]+)/)?.[1],
    async fetch(slug) {
      const d = await get(`https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`);
      return (Array.isArray(d) ? d : d.items ?? []).map((j) => ripplingJob(j, slug));
    },
    async fetchDescription(job, slug) {
      const id = job.id ?? job.url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
      if (id) {
        try {
          const text = ripplingDescription(await get(`https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs/${id}`));
          if (text) return text;
        } catch { /* the job page below */ }
      }
      return pageDescription(job);
    },
  },

  bamboohr: {
    detect: (u) => u.match(/([\w-]+)\.bamboohr\.com/)?.[1],
    async fetch(slug) {
      const d = await get(`https://${slug}.bamboohr.com/jobs/embed2.php`);
      const jobs = [];
      for (const dept of d.departments ?? []) {
        for (const pos of dept.positions ?? []) {
          jobs.push({
            title: pos.name?.trim() ?? '',
            url: pos.url ?? `https://${slug}.bamboohr.com/careers/${pos.id}`,
            location: pos.location ?? '',
            department: dept.label ?? '',
            postedAt: '',
          });
        }
      }
      return jobs;
    },
    async fetchDescription(job) {
      try {
        const html = await get(job.url, { json: false });
        const og = html.match(/<meta property="og:description" content="([\s\S]*?)"/i) ||
                   html.match(/<meta name="description" content="([\s\S]*?)"/i) ||
                   html.match(/<meta property="twitter:description" content="([\s\S]*?)"/i);
        return og ? plain(og[1]) : '';
      } catch {
        return '';
      }
    },
  },

  cailabs: {
    detect: (u) => (/cailabs\.com/.test(u) ? 'cailabs' : null),
    async fetch() {
      const html = await get('https://www.cailabs.com/fr/nos-offres-demploi/', { json: false });
      const articles = [...html.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/gi)];
      const jobs = [];
      for (const [, a] of articles) {
        const titleM = a.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
        const locM = a.match(/<span class="address">([\s\S]*?)<\/span>/i);
        const urlM = a.match(/href="([^"]+)"/i);
        if (titleM && urlM) {
          jobs.push({
            title: decode(titleM[1]).trim(),
            location: locM ? decode(locM[1]).trim() : 'France',
            url: urlM[1].trim(),
            department: 'Photonics / Laser Comms',
            postedAt: '',
          });
        }
      }
      return jobs;
    },
    async fetchDescription(job) {
      try {
        const html = await get(job.url, { json: false });
        const bodyM = html.match(/<div class="[^"]*(?:rich-text|description)[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
                      html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                      html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
        return bodyM ? plain(bodyM[1]) : '';
      } catch {
        return '';
      }
    },
  },

  spacecapital: {
    detect: (u) => (/jobs\.spacecapital\.com/.test(u) ? '338' : null),
    async fetch(slug = '338', entry = {}) {
      const queries = entry.queries && entry.queries.length ? entry.queries : ['optical', 'laser', 'spacecraft', 'payload', 'cleanroom', 'thermal', 'cryogenic', 'satellite'];
      const seen = new Map();
      for (const q of queries) {
        try {
          const res = await fetch(`https://api.getro.com/api/v2/collections/${slug}/search/jobs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
            body: JSON.stringify({ hitsPerPage: 30, page: 0, query: q }),
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) continue;
          const data = await res.json();
          for (const j of data.results?.jobs ?? []) {
            if (!seen.has(j.url)) {
              seen.set(j.url, {
                title: j.title?.trim() ?? '',
                company: j.organization?.name ? `${j.organization.name} (via Space Capital)` : 'Space Capital',
                url: j.url,
                location: j.locations?.join(' | ') || (j.searchable_locations?.[0] ?? ''),
                postedAt: j.created_at ? new Date(j.created_at * 1000).toISOString().slice(0, 10) : '',
                compensation: (j.compensation_amount_min_cents && j.compensation_amount_max_cents)
                  ? `$${Math.round(j.compensation_amount_min_cents / 100).toLocaleString()}–$${Math.round(j.compensation_amount_max_cents / 100).toLocaleString()}`
                  : undefined,
                orgMeta: j.organization?.name ? {
                  board: 'space-capital', id: String(j.organization.id ?? ''), name: j.organization.name,
                  industry_tags: j.organization.industry_tags ?? [], topics: j.organization.topics ?? [],
                  head_count: j.organization.head_count ?? null, stage: j.organization.stage ?? null,
                  seniority: j.seniority ?? '', work_mode: j.work_mode ?? '', skills: (j.skills ?? []).slice(0, 8),
                } : undefined,
              });
            }
          }
        } catch {}
      }
      return [...seen.values()];
    },
    async fetchDescription(job) {
      for (const [name, p] of Object.entries(providers)) {
        if (name === 'spacecapital') continue;
        const slug = p.detect(job.url);
        if (slug && p.fetchDescription) {
          try {
            return await p.fetchDescription(job, slug);
          } catch {}
        }
      }
      return '';
    },
  },

  concludis: {
    detect: (u) => {
      const m = u.match(/(?:careers\.toptica\.com|[\w-]+\.concludis\.de)/i);
      return m ? u : null;
    },
    async fetch(slug) {
      const rootUrl = slug.startsWith('http') ? slug : `https://${slug}`;
      const rootRes = await fetch(rootUrl, {
        headers: { 'user-agent': UA },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
      if (!rootRes.ok) throw new Error(`HTTP ${rootRes.status} ${slug}`);
      const html = await rootRes.text();
      const matches = [...html.matchAll(/cJobboard\.openJob\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
      const urls = [...new Set(matches)];
      const out = [];
      for (let i = 0; i < urls.length; i += 4) {
        const batch = urls.slice(i, i + 4);
        const results = await Promise.all(
          batch.map(async (u) => {
            try {
              const res = await fetch(u, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
              if (!res.ok) return null;
              const jobHtml = await res.text();
              return parseJobPage(jobHtml, u);
            } catch { return null; }
          })
        );
        for (const r of results) if (r && r.title) out.push(r);
      }
      return out;
    },
    async fetchDescription(job) {
      return job.description ?? '';
    },
  },

  factorial: {
    detect: (u) => {
      const m = u.match(/https?:\/\/([\w-]+)\.factorial\.(?:it|es|de|com|io)/i);
      return m ? m[1] : null;
    },
    async fetch(slug) {
      const host = slug.includes('.') ? slug : `${slug}.factorial.it`;
      let urls = [];
      try {
        const smRes = await fetch(`https://${host}/sitemap.xml`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
        if (smRes.ok) {
          const smText = await smRes.text();
          urls = [...new Set([...smText.matchAll(/<loc>([^<]*job_posting\/[^<]+)<\/loc>/gi)].map((m) => m[1]))];
        }
      } catch {}
      if (!urls.length) {
        const res = await fetch(`https://${host}/`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
        if (res.ok) {
          const html = await res.text();
          const regex = /<a[^>]+href=['"]([^'"]*job_posting\/[^'"]+)['"][^>]*>/gi;
          let m;
          const set = new Set();
          while ((m = regex.exec(html)) !== null) {
            set.add(m[1].startsWith('http') ? m[1] : `https://${host}${m[1]}`);
          }
          urls = [...set];
        }
      }
      const out = [];
      for (let i = 0; i < urls.length; i += 4) {
        const batch = urls.slice(i, i + 4);
        const results = await Promise.all(
          batch.map(async (u) => {
            try {
              const r = await fetch(u, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
              if (!r.ok) return null;
              const t = await r.text();
              const title = t.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, '').trim() ||
                            t.match(/<title>([^<]*?)<\/title>/i)?.[1]?.trim() || '';
              const locMatch = t.match(/(?:Fino Mornasco|Lisboa|Lomazzo|Milan|Rome|Boulder|London|Munich|Madrid|Paris)/i);
              let loc = locMatch ? locMatch[0] : '';
              if (/Fino Mornasco|Lomazzo/i.test(loc)) loc = `${loc}, Italy`;
              else if (/Lisboa/i.test(loc)) loc = 'Lisbon, Portugal';
              const descIdx = t.indexOf('<h1');
              const desc = descIdx !== -1 ? t.slice(descIdx, descIdx + 1500) : '';
              return { title, url: u, location: loc, postedAt: '', description: plain(desc) };
            } catch { return null; }
          })
        );
        for (const r of results) if (r && r.title) out.push(r);
      }
      return out;
    },
    async fetchDescription(job) {
      return job.description ?? '';
    },
  },

  umantis: {
    detect: (u) => {
      const numMatch = u.match(/recruitingapp-(\d+)\.de\.umantis\.com/i)?.[1];
      if (numMatch) return numMatch;
      if (/career\.diehl\.com/i.test(u)) return 'career.diehl.com';
      if (/jobs\.facc\.com/i.test(u)) return 'jobs.facc.com';
      const m = u.match(/https?:\/\/(?:career\.diehl\.com|jobs\.facc\.com|[\w-]+\.umantis\.com)/i);
      return m ? u : null;
    },
    async fetch(slug, entry = {}) {
      const raw = slug || entry.slug || '5312';
      const isNum = /^\d+$/.test(raw);
      const base = isNum ? `https://recruitingapp-${raw}.de.umantis.com` : (raw.startsWith('http') ? raw.replace(/\/$/, '') : `https://${raw}`);
      const jobs = [];
      const seen = new Set();

      const pageUrls = isNum
        ? (p) => `${base}/Jobs/1?lang=ger&page=${p + 1}`
        : (p) => `${base}/Jobs/All?tc1152481=p${p}`;

      for (let page = 0; page < 10; page++) {
        const url = pageUrls(page);
        let r;
        try {
          r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
        } catch { break; }
        if (!r.ok) break;
        const t = await r.text();

        const tableMatch = t.match(/<table[\s\S]*?<\/table>/i);
        if (tableMatch) {
          const rows = [...tableMatch[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
          if (rows.length <= 1) break;
          let found = 0;
          for (const row of rows.slice(1)) {
            const href = row.match(/href=["'](\/Vacancies\/\d+\/Description\/\d+)["']/i)?.[1];
            if (!href) continue;
            const fullUrl = `${base}${href}`;
            if (seen.has(fullUrl)) continue;
            seen.add(fullUrl);
            found++;

            const text = decode(row.replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
            const dateMatch = text.match(/Online seit:\s*(\d{2})\.(\d{2})\.(\d{4})/);
            const postedAt = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : '';

            const titleM = row.match(/class=["']HSTableLinkSubTitle["'][^>]*>([\s\S]*?)<\/a>/i) ||
                           row.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
            let title = titleM ? plain(titleM[1]) : '';
            if (!title) {
              const tm = text.match(/Online seit:\s*\d{2}\.\d{2}\.\d{4}\s+(.*?)\s*\|\s*Stellennummer/i);
              if (tm) title = tm ? tm[1].trim() : '';
            }

            const locMatch = row.match(/icon-umantis-icon-404[^>]*><\/i><\/span><span class="column-value"[^>]*>([\s\S]*?)<\/span>/i) ||
                             text.match(/Unternehmensbereich:[^|]+\|\s*([^|]+)\s*\|/i);
            const loc = locMatch ? plain(locMatch[1]) : (/facc/i.test(base) ? 'Austria' : 'Germany');

            if (entry.filter_text && !new RegExp(entry.filter_text, 'i').test(text)) continue;
            if (title) {
              jobs.push({
                title,
                url: fullUrl,
                location: loc,
                postedAt,
                description: text,
              });
            }
          }
          if (!found) break;
        } else {
          const matches = [...t.matchAll(/<a[^>]+href="([^"]*\/Vacancies\/(\d+)\/Description\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
          if (!matches.length) break;
          let fresh = 0;
          for (const m of matches) {
            const rawUrl = m[1];
            const fullUrl = rawUrl.startsWith('http') ? rawUrl : `${base}${rawUrl}`;
            if (seen.has(fullUrl)) continue;
            seen.add(fullUrl);
            fresh++;
            const title = plain(decode(m[3]));
            if (!title) continue;
            jobs.push({
              title,
              url: fullUrl,
              location: isNum ? 'Seefeld / Inning / Bavaria / Germany' : 'Germany',
              postedAt: '',
            });
          }
          if (!fresh) break;
        }
      }
      return jobs;
    },
    async fetchDescription(job) {
      return job.description ?? '';
    },
  },

  // SAP SuccessFactors: Recruiting Marketing (RMK) HTML tiles, RSS feeds, or Career Site Builder JSON API.
  // Used by Hensoldt, Rohde & Schwarz, MTU Aero Engines, and German industrial heavyweights.
  successfactors: {
    detect: (u) => {
      if (/jobs\.hensoldt\.net/i.test(u)) return 'jobs.hensoldt.net';
      if (/jobs\.rohde-schwarz\.com/i.test(u)) return 'jobs.rohde-schwarz.com';
      if (/jobs\.esa\.int/i.test(u)) return 'jobs.esa.int';
      if (/jobs\.knds\.de/i.test(u)) return 'jobs.knds.de';
      if (/jobs\.frequentis\.com/i.test(u)) return 'jobs.frequentis.com';
      if (/jobs\.avl\.com/i.test(u)) return 'jobs.avl.com';
      if (/careers\.vatvalve\.com/i.test(u)) return 'careers.vatvalve.com';
      if (/jobs\.webasto\.com/i.test(u)) return 'jobs.webasto.com';
      if (/jobs\.bmwgroup\.com/i.test(u)) return 'jobs.bmwgroup.com';
      const rmk = u.match(/^https?:\/\/([\w.-]+)\/(?:[\w-]+\/)?job\/[^/]+\/\d{7,}\/?(?:[?#].*)?$/i);
      if (rmk && !/\.(?:greenhouse|lever|ashbyhq|workable)\./i.test(rmk[1])) return rmk[1];
      const m = u.match(/https?:\/\/([^/]+)\/(?:tile-search-results|careers|jobsearch|search)\/?/i);
      if (m && /successfactors|jobs2web/i.test(u)) return m[1];
      return null;
    },
    async fetch(slug, entry = {}) {
      const origin = entry.api || (slug.startsWith('http') ? new URL(slug).origin : `https://${slug}`);
      const jobs = [];
      const seen = new Set();

      // Strategy A: If an RSS feed exists (e.g. Rohde & Schwarz, Frequentis /SearchJobs/feed/)
      const feedCandidates = entry.feed_url
        ? [entry.feed_url]
        : [
            `${origin}/careers/SearchJobs/feed/?jobRecordsPerPage=200`,
            `${origin}/en_US/careers/SearchJobs/feed/?jobRecordsPerPage=200`,
          ];
      for (const feedUrl of feedCandidates) {
        try {
          const xml = await get(feedUrl, { json: false, timeoutMs: 15000 });
          if (xml && xml.includes('<rss') && xml.includes('<item>')) {
            for (const item of xml.split(/<item>/i).slice(1)) {
              const title = tag(item, 'title');
              const link = tag(item, 'link') || tag(item, 'guid');
              const pub = tag(item, 'pubDate');
              const loc = tag(item, 'dc:coverage');
              if (title && link && !seen.has(link)) {
                seen.add(link);
                jobs.push({
                  title: plain(title),
                  url: link.trim(),
                  location: loc ? plain(loc) : '',
                  postedAt: pub ? isoDate(pub) : '',
                });
              }
            }
            if (jobs.length) return jobs;
          }
        } catch {}
      }

      // Strategy B: RMK tile-search-results HTML fragment (e.g. Hensoldt, AVL)
      try {
        let startrow = 0;
        for (let p = 0; p < 25; p++) {
          const html = await get(`${origin}/tile-search-results/?startrow=${startrow}`, { json: false, timeoutMs: 15000 });
          const tileRe = /<li class="job-tile job-id-(\d+)\b[\s\S]*?<\/li>/g;
          let t;
          let batchCount = 0;
          while ((t = tileRe.exec(html)) !== null) {
            batchCount++;
            const block = t[0];
            const urlM = block.match(/data-url="([^"]+)"/);
            if (!urlM) continue;
            const titleM = block.match(/class="jobTitle-link[^"]*"[^>]*>([\s\S]*?)<\/a>/) || block.match(/title="([^"]+)"/);
            const title = titleM ? plain(titleM[1]) : '';
            if (!title) continue;
            const cityM = block.match(/id="[^"]*-section-city-value">([\s\S]*?)<\/div>/) ||
                          block.match(/id="[^"]*-section-location-value">([\s\S]*?)<\/div>/) ||
                          block.match(/class="section-field multilocation[^"]*"[^>]*>([\s\S]*?)<\/div>/);
            const city = cityM ? plain(cityM[1]).replace(/^Locations?\s*/i, '').trim() : '';
            const url = /^https?:\/\//i.test(urlM[1]) ? urlM[1] : `${origin}${urlM[1].startsWith('/') ? '' : '/'}${urlM[1]}`;
            if (!seen.has(url)) {
              seen.add(url);
              jobs.push({ title, url, location: city, postedAt: '' });
            }
          }
          if (!batchCount) break;
          startrow += batchCount;
          if (p > 0) await new Promise((r) => setTimeout(r, 200));
        }
        if (jobs.length) return jobs;
      } catch {}

      // Strategy C: Career Site Builder (CSB) unified JSON search (e.g. MTU Aero Engines, BMW Group)
      try {
        const locales = ['de_DE', 'en_US', 'en_GB'];
        const locQuery = entry.location_query ?? entry.location ?? '';
        for (const loc of locales) {
          for (let pageNumber = 0; pageNumber < 30; pageNumber++) {
            const res = await fetch(`${origin}/services/recruiting/v1/jobs`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'user-agent': BROWSER_UA,
                accept: 'application/json',
              },
              body: JSON.stringify({ keywords: '', locale: loc, location: locQuery, pageNumber, sortBy: 'recent' }),
              signal: AbortSignal.timeout(15000),
            });
            if (!res.ok) break;
            const data = await res.json();
            const list = data.jobSearchResult ?? [];
            if (!list.length) break;
            for (const item of list) {
              const resp = item.response ?? {};
              if (!resp.id) continue;
              const title = resp.unifiedStandardTitle || '';
              const urlTitle = resp.unifiedUrlTitle || '';
              const url = `${origin}/job/${urlTitle}/${resp.id}-${loc}/`;
              if (seen.has(resp.id)) continue;
              seen.add(resp.id);
              const locShort = (resp.jobLocationShort ?? []).map((l) => plain(l).replace(/<br\s*\/?>/gi, ' ').trim()).filter(Boolean).join(', ');
              const locCoords = resp.jobLocationShortWithCoordinates?.[0]?.value ? plain(resp.jobLocationShortWithCoordinates[0].value).replace(/<br\s*\/?>/gi, ' ').trim() : '';
              const location = locShort || locCoords || locQuery || resp.city || resp.location || '';
              jobs.push({
                title: plain(title),
                url,
                location,
                postedAt: resp.unifiedStandardStart ? isoDate(resp.unifiedStandardStart) : '',
              });
            }
            if (data.totalJobs && seen.size >= data.totalJobs) break;
            await new Promise((r) => setTimeout(r, 150));
          }
          if (jobs.length) break;
        }
        if (jobs.length) return jobs;
      } catch {}

      return jobs;
    },
  },

  // Thyssenkrupp Marine Systems (TKMS): Naval defense / submarine & surface vessel technology.
  tkms: {
    detect: (u) => (/jobs\.tkmsgroup\.com/i.test(u) ? 'tkms' : null),
    async fetch() {
      const out = [], seen = new Set();
      for (let page = 0; page < 30; page++) {
        const res = await fetch('https://jobs.tkmsgroup.com/api/filter/query', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': UA },
          body: JSON.stringify({ searchQuery: '', filter: {}, subclient: 'tkms', locale: 'en', page }),
        });
        if (!res.ok) break;
        const data = await res.json();
        const list = data.jobs ?? [];
        if (!list.length) break;
        for (const item of list) {
          const d = item.data ?? {};
          if (!d.id || seen.has(d.id)) continue;
          seen.add(d.id);
          const slug = (d.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
          const url = `https://jobs.tkmsgroup.com/en/job/${slug}/${d.id}`;
          const loc = [d.city, d.country].filter(Boolean).join(', ');
          out.push({
            title: d.title ?? '',
            url,
            location: loc,
            department: d.functionalArea ?? '',
            postedAt: isoDate(d.postingDate),
          });
        }
        if (data.nextPage === null || data.nextPage === undefined) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      return out;
    },
  },

  // BWI GmbH: IT system house of the German Federal Armed Forces (Bundeswehr).
  bwi: {
    detect: (u) => (/bwi\.de/i.test(u) ? 'bwi' : null),
    async fetch() {
      const html = await get('https://www.bwi.de/karriere/stellenangebote', { json: false });
      const ldMatches = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
      const out = [];
      for (const m of ldMatches) {
        try {
          const data = JSON.parse(m[1]);
          const list = data.mainEntity?.itemListElement ?? [];
          for (const item of list) {
            const url = item.url;
            if (!url) continue;
            const slug = url.split('/').filter(Boolean).pop() || '';
            const title = slug
              .replace(/-m-w-d$/i, ' (m/w/d)')
              .replace(/-w-m-d$/i, ' (w/m/d)')
              .replace(/-/g, ' ')
              .replace(/\b\w/g, (c) => c.toUpperCase());
            out.push({
              title,
              url,
              location: 'Germany',
              postedAt: '',
            });
          }
        } catch {}
      }
      return out;
    },
  },

  // Dassault Systèmes / Dassault Aviation: Public Exalead card search API for careers.
  dassault: {
    detect: (u) => (/3ds\.com/i.test(u) ? 'dassault' : null),
    async fetch() {
      const out = [], seen = new Set();
      for (let offset = 0; offset < 500; offset += 10) {
        const url = `https://www.3ds.com/apisearch/card_search_api?lang=en&r=f/card_content_type/career&r=f/card_content_categories_facet/cards%20language/en&start=${offset}`;
        const xml = await get(url, { json: false, timeoutMs: 15000 });
        const hits = xml.split(/<Hit /).slice(1);
        if (!hits.length) break;
        let fresh = 0;
        for (const h of hits) {
          const title = h.match(/<Meta name="content_title"[^>]*>\s*<MetaString[^>]*>([\s\S]*?)<\/MetaString>/i)?.[1];
          const link = h.match(/<Meta name="content_cta_1_url"[^>]*>\s*<MetaString[^>]*>([\s\S]*?)<\/MetaString>/i)?.[1];
          const cats = h.match(/<Meta name="content_categories"[^>]*>\s*<MetaString[^>]*>([\s\S]*?)<\/MetaString>/i)?.[1] || '';
          const city = cats.match(/City\/([^\/]+?)(?=\s+[A-Z][a-z]+\/|$)/)?.[1]?.trim() || '';
          const country = cats.match(/Country\/([^\/]+?)(?=\s+[A-Z][a-z]+\/|$)/)?.[1]?.trim() || '';
          if (title && link) {
            const fullUrl = link.startsWith('http') ? link : `https://www.3ds.com${link}`;
            if (!seen.has(fullUrl)) {
              seen.add(fullUrl);
              fresh++;
              out.push({
                title: plain(title),
                url: fullUrl,
                location: [city, country].filter(Boolean).join(', '),
                postedAt: '',
              });
            }
          }
        }
        if (!fresh) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      return out;
    },
  },

  // Breezy HR: public JSON feed per tenant board.
  breezy: {
    detect: (u) => {
      const m = u.match(/([a-z0-9-]+)\.breezy\.hr/i);
      return m && !['api', 'app', 'www'].includes(m[1]) ? m[1] : null;
    },
    async fetch(slug) {
      const data = await get(`https://${slug}.breezy.hr/json`);
      return (Array.isArray(data) ? data : []).map((j) => ({
        title: j.name ?? '',
        url: j.url ?? `https://${slug}.breezy.hr/p/${j._id}`,
        location: [j.location?.city, j.location?.country?.name].filter(Boolean).join(', '),
        department: j.department ?? '',
        postedAt: isoDate(j.published_date),
      }));
    },
  },

  // Pinpoint HQ: public postings.json per tenant board.
  pinpoint: {
    detect: (u) => {
      const m = u.match(/([a-z0-9-]+)\.pinpointhq\.com/i);
      return m && !['app', 'www', 'api'].includes(m[1]) ? m[1] : null;
    },
    async fetch(slug) {
      const data = await get(`https://${slug}.pinpointhq.com/postings.json`);
      return (data.data ?? []).map((j) => ({
        title: j.title ?? '',
        url: j.url ?? '',
        location: [j.location?.city, j.location?.country].filter(Boolean).join(', '),
        department: j.job?.department ?? '',
        postedAt: isoDate(j.created_at),
      }));
    },
  },

  // Avature: parses public server-rendered job list at /SearchJobs?jobOffset=N
  avature: {
    detect: (u) => {
      if (/avature\.net/i.test(u)) return new URL(u).origin;
      if (/jobs\.rohde-schwarz\.com/i.test(u)) return 'https://jobs.rohde-schwarz.com';
      return null;
    },
    async fetch(slug, entry = {}) {
      const origin = entry.api || (slug?.startsWith('http') ? slug : 'https://jobs.rohde-schwarz.com');
      const searchPath = /\/SearchJobs\b/i.test(origin) ? '' : (origin.includes('/careers') ? '/SearchJobs' : '/en_US/careers/SearchJobs');
      const searchUrl = `${origin.replace(/\/+$/, '')}${searchPath}`;
      const out = [], seen = new Set();
      for (let offset = 0; offset < 300; offset += 6) {
        const url = `${searchUrl}?jobOffset=${offset}`;
        const html = await get(url, { json: false, timeoutMs: 15000 });
        const matches = [...html.matchAll(/<a[^>]+href="([^"]*JobDetail\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
        if (!matches.length) break;
        let fresh = 0;
        for (const m of matches) {
          const rawUrl = m[1];
          const fullUrl = rawUrl.startsWith('http') ? rawUrl : `${new URL(searchUrl).origin}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
          if (seen.has(fullUrl)) continue;
          seen.add(fullUrl);
          fresh++;
          const title = decode(plain(m[2]));
          out.push({
            title,
            url: fullUrl,
            location: 'Germany / Global',
            postedAt: '',
          });
        }
        if (!fresh) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      return out;
    },
  },

  // Oracle Cloud HCM Candidate Experience (ORC CE) REST API
  oraclecloud: {
    detect: (u) => {
      const m = u.match(/(https?:\/\/[a-z0-9_.-]+\.oraclecloud\.com)[^\s]*\/sites\/([a-zA-Z0-9_-]+)/i);
      return m ? `${m[1]}|${m[2]}` : null;
    },
    async fetch(slug, entry = {}) {
      const raw = slug || entry.slug || '';
      let origin, site;
      if (raw.includes('|')) {
        [origin, site] = raw.split('|');
      } else {
        const u = raw.startsWith('http') ? new URL(raw) : null;
        origin = u ? u.origin : (entry.api || raw);
        site = (raw.match(/\/sites\/([a-zA-Z0-9_-]+)/)?.[1]) || entry.site || 'CX_1';
      }
      const out = [];
      const seen = new Set();
      for (let offset = 0; offset <= 400; offset += 200) {
        const finder = `findReqs;siteNumber=${site},limit=200,offset=${offset}`;
        const url = `${origin.replace(/\/+$/, '')}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?finder=${finder}&expand=requisitionList`;
        let json;
        try {
          json = await get(url, { json: true, timeoutMs: 15000 });
        } catch {
          break;
        }
        const reqs = json.items?.[0]?.requisitionList || [];
        if (!reqs.length) break;
        for (const item of reqs) {
          if (!item.Title || !item.Id || seen.has(item.Id)) continue;
          seen.add(item.Id);
          const jobUrl = `${origin.replace(/\/+$/, '')}/hcmUI/CandidateExperience/en/sites/${site}/requisitions/preview/${item.Id}/`;
          out.push({
            title: plain(item.Title),
            url: jobUrl,
            location: item.PrimaryLocation || 'UAE / Global',
            postedAt: item.PostedDate || '',
          });
        }
        if (reqs.length < 200) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      return out;
    },
  },

  // MBDA Deutschland: WordPress admin-ajax endpoint for job listings
  mbda: {
    detect: (u) => /mbda-careers\.de/i.test(u) ? 'mbda' : null,
    async fetch(_slug, entry = {}) {
      const ajaxUrl = 'https://www.mbda-careers.de/wp/wp-admin/admin-ajax.php';
      const out = [], seen = new Set();
      for (let page = 1; page <= 25; page++) {
        const body = new URLSearchParams({ action: 'load_job_results', page: String(page) });
        const res = await fetch(ajaxUrl, {
          method: 'POST',
          headers: {
            'user-agent': UA,
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'x-requested-with': 'XMLHttpRequest'
          },
          body: body.toString(),
          signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) break;
        const data = await res.json();
        if (!data?.html) break;
        // One block per role: title (h3), the specialty line under it, then reference id and site in the result columns. The specialty
        // is part of the title on the employer's own pages ("Senior Systems Engineer (w/m/d) Produktsicherheit und -zuverlässigkeit"),
        // so it is kept, and each role carries its own site instead of one fixed place.
        const blocks = data.html.split('<div class="single-result"').slice(1);
        if (!blocks.length) break;
        let fresh = 0;
        for (const blk of blocks) {
          const link = blk.match(/href="([^"]*\/stellen\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
          if (!link) continue;
          const fullUrl = link[1].startsWith('http') ? link[1] : `https://www.mbda-careers.de${link[1]}`;
          if (seen.has(fullUrl)) continue;
          seen.add(fullUrl);
          fresh++;
          const specialty = plain(blk.match(/result-secondary-text">([\s\S]*?)<\/div>/i)?.[1] ?? '');
          const cols = [...blk.matchAll(/class="result-text">([\s\S]*?)<\/div>/gi)].map((m) => plain(m[1]));
          const title = plain(link[2]);
          out.push({
            title: specialty && !title.toLowerCase().includes(specialty.toLowerCase()) ? `${title} ${specialty}` : title,
            url: fullUrl,
            location: cols[1] ? `${cols[1].replace(/\bam lnn\b/, 'am Inn')} / Germany` : 'Germany',   // the source misspells Aschau am Inn with a lower-case L
            postedAt: '',
            meta: metaOf({ departments: [specialty], req: cols[0] }),
          });
        }
        if (!fresh || (data.paging && page >= (data.paging.totalPages || 1))) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      return out;
    },
  },

  // Lucca Software Careers widget: used by Atmos Space Cargo
  lucca: {
    detect: (u) => u.match(/jobs\.world\.luccasoftware\.com\/([a-zA-Z0-9_-]+)/i)?.[1],
    async fetch(slug, entry = {}) {
      const origin = 'https://jobs.world.luccasoftware.com';
      const s = slug || entry.slug || 'atmos-space-cargo';
      const url = `${origin}/${s}`;
      const html = await get(url, { json: false, timeoutMs: 15000 });
      const matches = [...html.matchAll(/<a[^>]+href="(\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
      const out = [], seen = new Set();
      for (const m of matches) {
        if (!m[1].startsWith(`/${s}/`)) continue;
        const fullUrl = `${origin}${m[1]}`;
        if (seen.has(fullUrl)) continue;
        seen.add(fullUrl);
        const title = decode(plain(m[2]));
        if (!title) continue;
        out.push({
          title,
          url: fullUrl,
          location: 'Munich / Bavaria / Germany',
          postedAt: '',
        });
      }
      return out;
    },
  },

  // Onlyfy / Prescreen ATS: Next.js server-rendered jobsData array
  onlyfy: {
    detect: (u) => u.match(/([\w-]+)\.onlyfy\.jobs/i)?.[1],
    async fetch(slug, entry = {}) {
      const tenant = slug || entry.slug;
      const out = [], seen = new Set();
      for (let page = 1; page <= 25; page++) {
        const url = `https://${tenant}.onlyfy.jobs/en?page=${page}`;
        const html = await get(url, { json: false, timeoutMs: 15000 });
        const m = html.match(/\\"jobsData\\":(\{(?:(?!\\"meta\\":).)*\\"meta\\":\{.*?\}\})/);
        if (!m) break;
        let parsed;
        try {
          parsed = JSON.parse(m[1].replace(/\\"/g, '"'));
        } catch {
          break;
        }
        const jobs = parsed.data || [];
        if (!jobs.length) break;
        let fresh = 0;
        for (const j of jobs) {
          if (!j.title || !j.jobAdUrl || seen.has(j.jobAdUrl)) continue;
          seen.add(j.jobAdUrl);
          fresh++;
          out.push({
            title: plain(j.title),
            url: j.jobAdUrl,
            location: j.cityName || 'Germany / Global',
            postedAt: (j.publishedAt || '').split('T')[0],
          });
        }
        if (!fresh || page >= (parsed.meta?.totalPages || 1)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      return out;
    },
  },

  // Concludis: used by TOPTICA Photonics
  concludis: {
    detect: (u) => /careers\.toptica\.com/i.test(u) ? 'toptica' : null,
    async fetch(_slug, entry = {}) {
      const url = entry.api || 'https://careers.toptica.com/prj/lst/a181a603769c1f98ad927e7367c7aa51/GesamtlisteOffenePositionen.htm';
      const html = await get(url, { json: false, timeoutMs: 15000 });
      const blocks = html.split(/onclick="cJobboard\.openJob\('/);
      const out = [], seen = new Set();
      for (const b of blocks.slice(1)) {
        const jobUrl = b.split("'")[0];
        if (!jobUrl || seen.has(jobUrl)) continue;
        seen.add(jobUrl);
        const titleMatch = b.match(/class="[^"]*stellenlink[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
        const title = titleMatch ? plain(decode(titleMatch[1])) : '';
        if (!title) continue;
        out.push({
          title,
          url: jobUrl,
          location: 'Gräfelfing / Munich / Germany',
          postedAt: '',
        });
      }
      return out;
    },
  },


  // JazzHR ATS: used by EnduroSat and space ventures (applytojob.com)
  jazzhr: {
    detect: (u) => u.match(/([\w-]+)\.applytojob\.com/i)?.[1],
    async fetch(slug, entry = {}) {
      const tenant = slug || entry.slug;
      const url = `https://${tenant}.applytojob.com/apply/`;
      const html = await get(url, { json: false, timeoutMs: 15000 });
      const out = [], seen = new Set();
      const re = /<li class="list-group-item[^"]*">([\s\S]*?)<\/li>/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        const block = m[1];
        const linkM = block.match(/href="([^"]+)"/);
        const titleM = block.match(/<h3 class=['"]list-group-item-heading['"][^>]*>([\s\S]*?)<\/h3>/i);
        const locM = block.match(/<i class=['"]fa fa-map-marker['"][^>]*><\/i>([^<]+)/i);
        const depM = block.match(/<i class=['"]fa fa-building['"][^>]*><\/i>([^<]+)/i);
        if (!linkM || !titleM) continue;
        const jobUrl = linkM[1].trim();
        if (seen.has(jobUrl)) continue;
        seen.add(jobUrl);
        const title = plain(titleM[1]);
        const loc = locM ? plain(locM[1]) : '';
        const dep = depM ? plain(depM[1]) : '';
        out.push({
          title,
          url: jobUrl,
          location: loc,
          department: dep,
          postedAt: '',
        });
      }
      return out;
    },
  },

  // Aerospacelab careers portal scraper
  aerospacelab: {
    detect: (u) => (/aerospacelab\.com\/jobs/i.test(u) ? 'aerospacelab' : null),
    async fetch(slug, entry = {}) {
      const url = 'https://www.aerospacelab.com/jobs';
      const html = await get(url, { json: false, timeoutMs: 15000 });
      const out = [], seen = new Set();
      const re = /<a href="(\/jobs\/detail\/[^"]+)">([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        const path = m[1];
        const block = m[2];
        const jobUrl = `https://www.aerospacelab.com${path}`;
        if (seen.has(jobUrl)) continue;
        seen.add(jobUrl);
        const titleM = block.match(/class="[^"]*x_wd_jobs_title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i);
        const locM = block.match(/class="[^"]*x_wd_ff_cd[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
        const title = titleM ? plain(titleM[1]) : '';
        if (!title) continue;
        const loc = locM ? plain(locM[1]) : 'Mont-Saint-Guibert, Belgium';
        out.push({
          title,
          url: jobUrl,
          location: loc,
          postedAt: '',
        });
      }
      return out;
    },
  },

  // Prospective ATS (Switzerland): used by Pilatus Aircraft, Sensirion, and Swiss precision engineering
  prospective: {
    detect: (u) => {
      const m = u.match(/([\w-]+)\.prospective\.ch/i);
      return m ? m[1] : null;
    },
    async fetch(slug, entry = {}) {
      const tenant = slug || entry.slug;
      const base = `https://${tenant}.prospective.ch`;
      const out = [], seen = new Set();
      for (let page = 1; page <= 25; page++) {
        const url = `${base}/index.cfm?sprCd=en&wlgo=1&seq=${page}`;
        let html;
        try {
          html = await get(url, { json: false, timeoutMs: 15000 });
        } catch { break; }
        const re = /<div class="itemlist_title"><a[^>]+onclick="window\.open\('([^']+)'[^>]*>([\s\S]*?)<\/a><\/div>[\s\S]*?<div class="itemlist_niederlassung">([\s\S]*?)<\/div>/gi;
        let m;
        let fresh = 0;
        while ((m = re.exec(html)) !== null) {
          const rawUrl = m[1].trim();
          if (seen.has(rawUrl)) continue;
          seen.add(rawUrl);
          fresh++;
          const title = plain(m[2]);
          const loc = plain(m[3]);
          if (!title) continue;
          out.push({
            title,
            url: rawUrl,
            location: loc || 'Switzerland',
            postedAt: '',
          });
        }
        if (!fresh && page === 1) {
          const re2 = /<div class="itemlist_jobtitle">\s*<a href="([^"]+)"[^>]*title="([^"]+)">/gi;
          let m2;
          while ((m2 = re2.exec(html)) !== null) {
            const rawUrl = m2[1].trim();
            if (seen.has(rawUrl)) continue;
            seen.add(rawUrl);
            fresh++;
            const title = plain(m2[2]);
            if (!title) continue;
            out.push({
              title,
              url: rawUrl,
              location: 'Switzerland',
              postedAt: '',
            });
          }
        }
        if (!fresh) break;
      }
      return out;
    },
  },

  // Gilmour Space Technologies (Australia): orbital launch vehicles & spaceport
  gilmourspace: {
    detect: (u) => (/gspace\.com/i.test(u) ? 'gspace' : null),
    async fetch(slug, entry = {}) {
      const url = 'https://www.gspace.com/career';
      const html = await get(url, { json: false, timeoutMs: 20000 });
      const re = /<div[^>]*data-testid="richTextElement"[^>]*>[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>[\s\S]*?<div[^>]*data-testid="richTextElement"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>[\s\S]*?<a[^>]+href="(https:\/\/external-jobboard\.myrecruitmentplus\.com\/job-details\/query\/(\d+)[^"]*)"/gi;
      let m;
      const out = [], seen = new Set();
      while ((m = re.exec(html)) !== null) {
        const rawDeptLoc = plain(m[1]);
        const title = plain(m[2]);
        const jobUrl = m[3].trim();
        if (seen.has(jobUrl)) continue;
        seen.add(jobUrl);

        let department = '';
        let location = 'Gold Coast, Australia';
        if (rawDeptLoc.includes('|')) {
          const parts = rawDeptLoc.split('|').map((s) => s.trim());
          department = parts[0] || '';
          location = parts[1] ? `${parts[1]}, Australia` : location;
        } else if (rawDeptLoc) {
          department = rawDeptLoc;
        }

        out.push({
          title,
          url: jobUrl,
          location,
          department,
          postedAt: '',
        });
      }
      return out;
    },
  },

  // TTTech Group: deterministic safety networking & critical compute (Vienna HQ)
  tttech: {
    detect: (u) => (/tttech(?:-auto)?\.com/i.test(u) ? 'tttech' : null),
    async fetch(slug, entry = {}) {
      const url = 'https://www.tttech.com/jobs-career/jobs';
      const html = await get(url, { json: false, timeoutMs: 15000 });
      const re = /<div class="views-row">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
      let m;
      const out = [], seen = new Set();
      while ((m = re.exec(html)) !== null) {
        const block = m[1];
        const titleM = block.match(/<div class="views-field views-field-title"><span class="field-content"><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        const applyM = block.match(/href="(https:\/\/career55\.sapsf\.eu\/[^"]+)"/i);
        const locM = block.match(/<\/span><\/div><div><span>([^<]+)<\/span><\/div>/i);
        if (titleM) {
          const relUrl = titleM[1];
          const title = plain(titleM[2]);
          const jobUrl = applyM ? decode(applyM[1]) : `https://www.tttech.com${relUrl}`;
          if (seen.has(jobUrl)) continue;
          seen.add(jobUrl);
          const location = locM ? plain(locM[1]) : 'Vienna, Austria';
          out.push({
            title,
            url: jobUrl,
            location,
            postedAt: '',
          });
        }
      }
      return out;
    },
  },

  // CVWarehouse: used by Antwerp Space (OHB Group) and European aerospace firms
  cvwarehouse: {
    detect: (u) => {
      const m = u.match(/companyGuid=([a-f0-9-]+)/i);
      return m ? m[1] : null;
    },
    async fetch(slug, entry = {}) {
      const guid = slug || entry.slug;
      const url = `https://jobpage.cvwarehouse.com/?companyGuid=${guid}&lang=en-US`;
      const html = await get(url, { json: false, timeoutMs: 15000 });
      const re = /<a[^>]+href="([^"]*job=(\d+)&amp;q=([^"&]+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      const out = [], seen = new Set();
      while ((m = re.exec(html)) !== null) {
        const rawHref = m[1].replace(/&amp;/g, '&');
        const jobId = m[2];
        const slugName = m[3];
        const inner = plain(m[4]);
        if (seen.has(jobId)) continue;
        seen.add(jobId);
        let title = inner;
        if (!title || title.length < 3) {
          title = slugName.replace(/-/g, ' ').trim();
        }
        const jobUrl = `https://jobpage.cvwarehouse.com/${rawHref.startsWith('?') ? rawHref : rawHref}`;
        out.push({
          title,
          url: jobUrl,
          location: 'Hoboken (Antwerp), Belgium',
          postedAt: '',
        });
      }
      return out;
    },
  },

  // Factorial ATS: used by Pangea Aerospace and European ventures
  factorial: {
    detect: (u) => {
      const m = u.match(/(?:https?:\/\/)?([\w.-]+\.factorial(?:hr)?\.(?:com|it|es|de|io|pt))/i);
      if (m) return m[1];
      const m2 = u.match(/([\w-]+)\.factorial\.com/i);
      return m2 ? m2[1] : null;
    },
    async fetch(slug, entry = {}) {
      const tenant = slug || entry.slug;
      const url = tenant.startsWith('http') ? tenant : `https://${tenant}${tenant.includes('.') ? '' : '.factorial.com'}/`;
      const html = await get(url, { json: false, timeoutMs: 15000 });
      const groups = html.split(/<div data-target='job-filters\.officeGroup'>/i);
      const out = [], seen = new Set();
      for (const group of groups.slice(1)) {
        const locMatch = group.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
        const location = locMatch ? plain(locMatch[1]) : 'Europe';
        const re = /<li class='job-offer-item[^']*'[^>]*data-job-postings-url='([^']*)'[^>]*>([\s\S]*?)<\/li>/gi;
        let m;
        while ((m = re.exec(group)) !== null) {
          const jobUrl = m[1].startsWith('http') ? m[1] : `https://${new URL(url).host}${m[1]}`;
          const block = m[2];
          if (seen.has(jobUrl)) continue;
          seen.add(jobUrl);
          const titleM = block.match(/<div class="[^"]*factorial__headingFontFamily">([\s\S]*?)<\/div>/i);
          const title = titleM ? plain(titleM[1]) : '';
          if (!title) continue;
          out.push({
            title,
            url: jobUrl,
            location,
            postedAt: '',
          });
        }
      }
      return out;
    },
  },

  // DSI Aerospace: space on-board computers, FPGA, mass memories (Bremen, Germany)
  dsi: {
    detect: (u) => (/dsi(?:-as)?\.space|dsi-as\.de/i.test(u) ? 'dsi' : null),
    async fetch(slug, entry = {}) {
      const url = 'https://www.dsi.space/professionals/';
      const html = await get(url, { json: false, timeoutMs: 15000 });
      const re = /<a[^>]+href="(https:\/\/www\.dsi\.space\/joboffer\/[^"]+\/)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      const out = [], seen = new Set();
      while ((m = re.exec(html)) !== null) {
        const jobUrl = m[1];
        const inner = plain(m[2]);
        if (seen.has(jobUrl)) continue;
        seen.add(jobUrl);
        const title = inner.replace(/Read more\s*$/i, '').trim();
        if (!title || title.length < 3) continue;
        out.push({
          title,
          url: jobUrl,
          location: 'Bremen, Germany',
          postedAt: '',
        });
      }
      return out;
    },
  },

  // HPS Munich: High Performance Space Structure Systems (deployable antennas, sails, arrays)
  hps: {
    detect: (u) => (/hps-gmbh\.com/i.test(u) ? 'hps' : null),
    async fetch(slug, entry = {}) {
      const url = 'https://www.hps-gmbh.com/career-at-hps/';
      const html = await get(url, { json: false, timeoutMs: 15000 });
      const re = /<a[^>]+href="([^"]*\/uploads\/\d{4}\/\d{2}\/([^"]+)\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      const out = [], seen = new Set();
      while ((m = re.exec(html)) !== null) {
        const pdfUrl = m[1];
        const filename = m[2];
        const inner = plain(m[3]);
        if (seen.has(pdfUrl)) continue;
        seen.add(pdfUrl);
        let title = inner;
        if (!title || title.length < 3 || /download|pdf|view/i.test(title)) {
          title = filename.replace(/^[\d-]+_?/, '').replace(/[-_]/g, ' ').trim();
        }
        out.push({
          title,
          url: pdfUrl,
          location: 'Munich, Germany',
          postedAt: '',
        });
      }
      return out;
    },
  },

  // AVILUS: autonomous medical evacuation heavy-lift eVTOL/drones (Munich, Germany)
  avilus: {
    detect: (u) => (/avilus\.com/i.test(u) ? 'avilus' : null),
    async fetch(slug, entry = {}) {
      const url = 'https://www.avilus.com/career';
      const html = await get(url, { json: false, timeoutMs: 15000 });
      const re = /<a[^>]+href="(\/careers\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      const out = [], seen = new Set();
      while ((m = re.exec(html)) !== null) {
        const path = m[1];
        const block = m[2];
        const fullUrl = `https://www.avilus.com${path}`;
        if (seen.has(fullUrl)) continue;
        seen.add(fullUrl);

        const titleM = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
        const locM = block.match(/<span class="u-weight-bold">([^<]+)<\/span>/i);
        const deptM = block.match(/<div class="u-text-style-main">\s*<span>([^<]+)<\/span>/i);
        
        const title = titleM ? plain(titleM[1]) : '';
        if (!title) continue;
        const loc = locM ? `${plain(locM[1])}, Munich, Germany` : 'Munich, Germany';
        const dept = deptM ? plain(deptM[1]) : '';

        out.push({
          title,
          url: fullUrl,
          location: loc,
          department: dept,
          postedAt: '',
        });
      }
      return out;
    },
  },

  // SwissTo12: 3D-printed RF products & HummingSat GEO small satellites (Renens, Switzerland)
  swissto12: {
    detect: (u) => (/swissto12\.com/i.test(u) ? 'swissto12' : null),
    async fetch(slug, entry = {}) {
      const url = 'https://swissto12.com/careers/';
      const html = await get(url, { json: false, timeoutMs: 15000 });
      const chunks = html.split(/job-Apply/i);
      const out = [], seen = new Set();
      for (let i = 1; i < chunks.length; i++) {
        const after = chunks[i];
        const before = chunks[i - 1];
        const applyMatch = after.match(/href="([^"]+)"/i);
        if (!applyMatch) continue;
        const applyUrl = applyMatch[1].trim();
        if (seen.has(applyUrl)) continue;
        seen.add(applyUrl);

        const titleMatch = before.match(/elementor-widget-theme-post-title[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/i);
        const locMatch = before.match(/elementor-button-text">([^<]+)<\/span>/i);
        const title = titleMatch ? plain(titleMatch[1]) : '';
        if (!title) continue;
        const rawLoc = locMatch ? plain(locMatch[1]) : '';
        const location = rawLoc && !/apply/i.test(rawLoc) ? `${rawLoc}, Switzerland` : 'Renens (Lausanne), Switzerland';

        out.push({
          title,
          url: applyUrl,
          location,
          postedAt: '',
        });
      }
      return out;
    },
  },

  // Infinite Orbits: GEO satellite life extension, docking & rendezvous servicing (Toulouse, France)
  infiniteorbits: {
    detect: (u) => (/infiniteorbits\.io/i.test(u) ? 'infiniteorbits' : null),
    async fetch(slug, entry = {}) {
      const url = 'https://jobs.infiniteorbits.io/jobs';
      const html = await get(url, { json: false, timeoutMs: 20000 });
      const re = /<a[^>]+href="(https:\/\/jobs\.infiniteorbits\.io\/jobs\/([^"\/]+))"[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      const out = [], seen = new Set();
      while ((m = re.exec(html)) !== null) {
        const jobUrl = m[1];
        const pathSlug = m[2];
        const inner = plain(m[3]);
        if (seen.has(jobUrl)) continue;
        seen.add(jobUrl);

        let title = inner;
        if (!title || title.length < 3 || /view|apply|read/i.test(title)) {
          title = decodeURIComponent(pathSlug).replace(/–/g, '-').replace(/-/g, ' ').trim();
          title = title.charAt(0).toUpperCase() + title.slice(1);
        }

        out.push({
          title,
          url: jobUrl,
          location: 'Toulouse, France',
          postedAt: '',
        });
      }
      return out;
    },
  },

  // Sybilla Technologies: autonomous robotic observatories, space surveillance & tracking (SST)
  sybilla: {
    detect: (u) => (/sybillatechnologies\.com/i.test(u) ? 'sybilla' : null),
    async fetch(slug, entry = {}) {
      const url = 'https://sybillatechnologies.com/career/';
      const html = await get(url, { json: false, timeoutMs: 15000 });
      const re = /<a[^>]+href="(https:\/\/sybillatechnologies\.com\/career\/([^"\/]+)\/)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      const out = [], seen = new Set();
      while ((m = re.exec(html)) !== null) {
        const jobUrl = m[1];
        const inner = plain(m[3]);
        if (seen.has(jobUrl)) continue;
        seen.add(jobUrl);
        if (!inner || inner.length < 3) continue;
        out.push({
          title: inner,
          url: jobUrl,
          location: 'Bydgoszcz, Poland (Remote / Hybrid)',
          postedAt: '',
        });
      }
      return out;
    },
  },

  // Telesat: global satellite communications & Lightspeed LEO constellation
  telesat: {
    detect: (u) => (/telesat\.com/i.test(u) ? 'telesat' : null),
    async fetch(slug, entry = {}) {
      const url = 'https://www.telesat.com/careers/jobs/';
      const html = await get(url, { json: false, timeoutMs: 20000 });
      const re = /<a[^>]+href=["'](?:\/careers\/jobs\/|https?:\/\/[^"']*telesat\.com\/careers\/jobs\/)([a-zA-Z0-9_-]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      const out = [], seen = new Set();
      while ((m = re.exec(html)) !== null) {
        const id = m[1];
        const inner = m[2];
        const jobUrl = `https://www.telesat.com/careers/jobs/${id}`;
        if (seen.has(jobUrl)) continue;
        seen.add(jobUrl);
        const titleMatch = inner.match(/<span class=['"]large['"]>([\s\S]*?)<\/span>/i);
        const title = titleMatch ? plain(titleMatch[1]) : '';
        if (!title) continue;
        const locMatch = inner.match(/<span class=['"]small['"]>([\s\S]*?)<\/span>/i);
        const location = locMatch ? plain(locMatch[1]) : 'Global / Canada';
        const deptMatch = inner.match(/<span class=['"]medium['"]>([\s\S]*?)<\/span>/i);
        const department = deptMatch ? plain(deptMatch[1]) : '';
        out.push({
          title,
          url: jobUrl,
          location,
          department,
          postedAt: '',
        });
      }
      return out;
    },
  },

  // THEVA: high-temperature superconductors (HTS) & fusion magnet tape (Ismaning / Munich)
  theva: {
    detect: (u) => (/theva\.de/i.test(u) ? 'theva' : null),
    async fetch(slug, entry = {}) {
      const url = 'https://www.theva.de/karriere/';
      const html = await get(url, { json: false, timeoutMs: 20000 });
      const re = /<a[^>]+href=["'](https:\/\/www\.theva\.de\/wp-content\/uploads\/[^"']+\.pdf)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      const out = [], seen = new Set();
      while ((m = re.exec(html)) !== null) {
        const pdfUrl = m[1];
        const titleRaw = plain(m[2]);
        if (!titleRaw || seen.has(pdfUrl)) continue;
        if (/datenschutz|privacy|impressum/i.test(titleRaw) || /datenschutzerkl/i.test(pdfUrl)) continue;
        seen.add(pdfUrl);
        out.push({
          title: titleRaw,
          url: pdfUrl,
          location: 'Ismaning / Munich, Germany',
          department: 'High-Temperature Superconductors (HTS)',
          postedAt: '',
        });
      }
      return out;
    },
  },

  // GomSpace: nanosatellite systems, cubesats & constellation solutions (Aalborg, Denmark / Luxembourg)
  gomspace: {
    detect: (u) => (/gomspace\.com/i.test(u) ? 'gomspace' : null),
    async fetch(slug, entry = {}) {
      const url = 'https://gomspace.com/open-positions/';
      const html = await get(url, { json: false, timeoutMs: 20000 });
      const re = /<a[^>]+href=["'](https:\/\/gomspace\.hr-on\.com\/show-job\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      const out = [], seen = new Set();
      while ((m = re.exec(html)) !== null) {
        const jobUrl = m[1].replace(/&#038;/g, '&');
        const title = plain(m[2]).replace(/^SEE\s+/i, '');
        if (!title || seen.has(jobUrl)) continue;
        seen.add(jobUrl);
        let loc = 'Aalborg, Denmark / Luxembourg / Europe';
        if (/aalborg/i.test(title)) loc = 'Aalborg, Denmark';
        else if (/luxembourg/i.test(title)) loc = 'Luxembourg';
        else if (/\(DK\/LU\)/i.test(title)) loc = 'Denmark / Luxembourg';
        out.push({
          title,
          url: jobUrl,
          location: loc,
          department: 'Nanosatellite Systems',
          postedAt: '',
        });
      }
      return out;
    },
  },

  // Qascom: GNSS cybersecurity & space navigation security (Bassano del Grappa, Italy)
  qascom: {
    detect: (u) => (/qascom\.com/i.test(u) ? 'qascom' : null),
    async fetch(slug, entry = {}) {
      const url = 'https://www.qascom.com/careers/';
      const html = await get(url, { json: false, timeoutMs: 20000 });
      const re = /<(?:h[2-4]|strong)[^>]*>([\s\S]*?)<\/(?:h[2-4]|strong)>/gi;
      let m;
      const out = [], seen = new Set();
      while ((m = re.exec(html)) !== null) {
        const t = plain(m[1]);
        if (t.length < 5 || !/\b(?:Engineer|Manager|Developer|Architect|Director|Lead)\b/i.test(t)) continue;
        if (/satellite navigation and communication security\s+engineers/i.test(t)) continue;
        if (/\b(?:architectures|team|department)\b/i.test(t)) continue;
        if (seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        out.push({
          title: t,
          url: 'https://www.qascom.com/careers/',
          location: 'Bassano del Grappa, Italy / Europe',
          department: 'GNSS & PNT Security',
          postedAt: '',
        });
      }
      return out;
    },
  },

  join: {
    detect: (u) => {
      const m = u.match(/join\.com\/companies\/([\w-]+)/);
      return m ? m[1] : null;
    },
    async fetch(slug) {
      const url = `https://join.com/companies/${slug}`;
      const html = await get(url, { json: false });
      const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!nextMatch) return [];
      const data = JSON.parse(nextMatch[1]);
      const state = data.props?.pageProps?.initialState;
      const items = state?.jobs?.items || [];
      return items.map((j) => {
        const idParam = j.idParam || j.id;
        const jobUrl = `https://join.com/companies/${slug}/jobs/${idParam}`;
        const locParts = [j.city?.cityName, j.city?.countryName || j.country?.iso3166].filter(Boolean);
        return {
          title: j.title || '',
          url: jobUrl,
          location: locParts.join(', ') || 'Remote',
          department: j.category?.name || '',
          postedAt: j.createdAt ? isoDate(j.createdAt) : '',
        };
      });
    },
    async fetchDescription(job) {
      try {
        const html = await get(job.url, { json: false });
        const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (nextMatch) {
          const data = JSON.parse(nextMatch[1]);
          const j = data.props?.pageProps?.initialState?.job;
          if (j?.sanitizedDescription || j?.description) {
            return plain(j.sanitizedDescription || j.description);
          }
        }
        return plain(html);
      } catch {
        return '';
      }
    },
  },

  siigroup: {
    detect: (u) => (/sii-group\.de/i.test(u) ? 'sii-germany' : null),
    async fetch(slug, entry = {}) {
      const base = 'https://sii-group.de';
      const res = await get(`${base}/jobs-api.php`, { json: true });
      const rawJobs = Array.isArray(res.jobs) ? res.jobs : [];
      return rawJobs.map((j) => {
        const locParts = [j.postalCode, j.city, j.state].filter(Boolean);
        return {
          title: plain(j.title || ''),
          url: `${base}/stelle/${encodeURIComponent(j.id)}`,
          location: locParts.join(', ') || 'Germany',
          department: plain(j.discipline || ''),
          postedAt: j.date ? isoDate(j.date) : '',
        };
      });
    },
    async fetchDescription(job) {
      try {
        const html = await get(job.url, { json: false });
        const body = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html;
        return plain(body);
      } catch {
        return '';
      }
    },
  },

  hrlab: {
    detect: (u) => {
      const m = u.match(/app\.hrlab\.de\/(?:[a-z]{2}\/)?jobs\/([\w-]+)/);
      return m ? m[1] : null;
    },
    async fetch(slug) {
      const base = `https://app.hrlab.de/en/jobs/${slug}`;
      const html = await get(base, { json: false });
      const cardRegex = /<a[^>]*href="([^"]*\/jobs\/[^/]+\/(\d+))"[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      const jobs = [];
      const seen = new Set();
      while ((m = cardRegex.exec(html)) !== null) {
        const id = m[2];
        if (seen.has(id)) continue;
        const text = plain(m[3]).replace(/\s+/g, ' ').trim();
        if (!text || /Go to Vacancy|View/i.test(text)) continue;
        seen.add(id);
        const url = `https://app.hrlab.de${m[1]}`;
        const parts = text.split(/\s*-\s*/);
        const titleAndType = parts[0] || text;
        const loc = parts[1] || 'Garching bei München, Germany';
        jobs.push({
          title: titleAndType.replace(/\s+(?:Full time|Part time|Vollzeit|Teilzeit)$/i, '').trim(),
          url,
          location: loc,
          postedAt: '',
        });
      }
      return jobs;
    },
    async fetchDescription(job) {
      try {
        const html = await get(job.url, { json: false });
        const body = html.match(/<main[\s\S]*?<\/main>|<article[\s\S]*?<\/article>/i)?.[0] ?? html;
        return plain(body);
      } catch {
        return '';
      }
    },
  },

  eso: {
    detect: (u) => (/recruitment\.eso\.org/i.test(u) ? 'https://recruitment.eso.org/jobs.rss' : null),
    async fetch(slug, entry = {}) {
      const url = slug && slug.startsWith('http') ? slug : 'https://recruitment.eso.org/jobs.rss';
      const xml = await get(url, { json: false });
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
      return items.map((m) => {
        const item = m[1];
        const title = item.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? '';
        const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? '';
        const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim();
        const desc = item.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim() ?? '';
        return {
          title,
          url: link,
          location: 'Garching bei München, Germany',
          department: 'Astronomy & Engineering',
          postedAt: isoDate(pubDate),
          description: plain(desc),
        };
      }).filter((j) => j.title && j.url);
    },
  },

  // ---- ATS vendors added from the space-board harvest (crawler/ats-resolve.mjs). Each lists open jobs from the vendor's
  // public candidate-facing endpoint; none needs credentials. ----

  // ADP WorkforceNow (recruitment.html?cid=...&ccId=...): public JSON requisition list. slug = "cid|ccId".
  adp: {
    detect: (u) => {
      const cid = u.match(/workforcenow\.adp\.com[^#]*[?&]cid=([0-9a-f-]{36})/i)?.[1];
      if (!cid) return null;
      return `${cid}|${u.match(/[?&]ccId=([\w]+)/i)?.[1] ?? '19000101_000001'}`;
    },
    async fetch(slug) {
      const [cid, ccId] = slug.split('|');
      const out = [];
      for (let skip = 0; skip < 2000; skip += 100) {
        const d = await get(`https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions?cid=${cid}&ccId=${ccId}&lang=en_US&locale=en_US&$top=100&$skip=${skip}`);
        const reqs = d.jobRequisitions ?? [];
        for (const j of reqs) {
          const loc = j.requisitionLocations?.[0];
          out.push({
            title: (j.requisitionTitle ?? '').trim(),
            url: `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${cid}&ccId=${ccId}&lang=en_US&jobId=${String(j.itemID ?? '').split('_')[0]}`,
            location: loc?.nameCode?.shortName ?? [loc?.address?.cityName, loc?.address?.countrySubdivisionLevel1?.codeValue].filter(Boolean).join(', '),
            postedAt: (j.postDate ?? '').slice(0, 10),
          });
        }
        if (reqs.length < 100) break;
      }
      return out.filter((j) => j.title);
    },
  },

  // UKG Pro Recruiting / UltiPro job boards: POST search endpoint. slug = "host|tenant|boardGuid".
  ultipro: {
    detect: (u) => {
      const m = u.match(/(recruiting\d*\.ultipro\.(?:com|ca))\/([A-Za-z0-9]+)\/JobBoard\/([0-9a-f-]{36})/i);
      return m ? `${m[1]}|${m[2]}|${m[3]}` : null;
    },
    async fetch(slug) {
      const [host, tenant, guid] = slug.split('|');
      const base = `https://${host}/${tenant}/JobBoard/${guid}`;
      const out = [];
      for (let skip = 0; skip < 3000; skip += 50) {
        const res = await fetch(`${base}/JobBoardView/LoadSearchResults`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
          body: JSON.stringify({ opportunitySearch: { Top: 50, Skip: skip, QueryString: '', OrderBy: [{ Value: 'postedDateDesc', PropertyName: 'PostedDate', Ascending: false }], Filters: [] } }),
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${base}`);
        const d = await res.json();
        const rows = d.opportunities ?? [];
        for (const j of rows) {
          const a = j.Locations?.[0]?.Address;
          out.push({
            title: (j.Title ?? '').trim(),
            url: `${base}/OpportunityDetail?opportunityId=${j.Id}`,
            location: [a?.City, a?.State?.Name, a?.Country?.Name].filter(Boolean).join(', ') || (j.Locations?.[0]?.LocalizedDescription ?? ''),
            department: j.JobCategoryName ?? '',
            postedAt: (j.PostedDate ?? '').slice(0, 10),
          });
        }
        if (rows.length < 50 || skip + 50 >= (d.totalCount ?? 0)) break;
      }
      return out.filter((j) => j.title);
    },
  },

  // iCIMS career portals (careers-<tenant>.icims.com): server-rendered search results, ~20 per page. slug = the portal host.
  icims: {
    detect: (u) => u.match(/([\w-]+\.icims\.com)/i)?.[1],
    async fetch(slug) {
      const out = [], seen = new Set();
      let pages = 1;
      for (let pr = 0; pr < Math.min(pages, 60); pr++) {
        const html = await get(`https://${slug}/jobs/search?ss=1&in_iframe=1&pr=${pr}`, { json: false });
        if (pr === 0) pages = Number(html.match(/Page \d+ of (\d+)/)?.[1] ?? 1);
        for (const card of html.split('<li class="iCIMS_JobCardItem">').slice(1)) {
          const a = card.match(/<a href="([^"]*\/jobs\/\d+\/[^"]*)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/);
          if (!a) continue;
          const url = decode(a[1]).replace(/[?&]in_iframe=1$/, '');
          if (seen.has(url)) continue;
          seen.add(url);
          const loc = card.match(/Job Locations<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/)?.[1];
          out.push({ title: plain(a[2]), url, location: plain(loc ?? '').replace(/^[A-Z]{2}-/, '').replace(/-/g, ', '), postedAt: '' });
        }
        if (pr > 0) await new Promise((r) => setTimeout(r, 150));
      }
      return out;
    },
  },

  // Jibe (iCIMS career sites on a company domain, e.g. careers.viasat.com): public JSON API. slug = host.
  jibe: {
    detect: (u) => u.match(/^https?:\/\/([\w.-]+)\/(?:[\w-]+\/)?jobs\/[\w-]+\?lang=[a-z-]+/i)?.[1],
    async fetch(slug) {
      const out = [];
      for (let page = 1; page <= 60; page++) {
        const d = await get(`https://${slug}/api/jobs?limit=100&page=${page}`);
        const rows = d.jobs ?? [];
        for (const r of rows) {
          const j = r.data ?? r;
          out.push({
            title: (j.title ?? '').trim(),
            url: `https://${slug}/jobs/${j.slug ?? j.req_id}?lang=${j.language ?? 'en-us'}`,
            location: j.location_name ? [j.location_name, j.state, j.country].filter(Boolean).join(', ') : [j.city, j.state, j.country].filter(Boolean).join(', '),
            department: j.department ?? '',
            postedAt: (j.posted_date ?? j.create_date ?? '').slice(0, 10),
            description: plain(`${j.description ?? ''} ${j.responsibilities ?? ''} ${j.qualifications ?? ''}`),
          });
        }
        if (rows.length < 100 || out.length >= (d.totalCount ?? 0)) break;
      }
      return out.filter((j) => j.title);
    },
  },

  // Comeet careers pages (comeet.com/jobs/<company>/<uid>): the page embeds the API token. slug = "company/uid".
  comeet: {
    detect: (u) => {
      const m = u.match(/comeet\.(?:com|co)\/jobs\/([\w-]+)\/([0-9A-F.]+)/i);
      return m ? `${m[1]}/${m[2]}` : null;
    },
    async fetch(slug) {
      const [company, uid] = slug.split('/');
      const html = await get(`https://www.comeet.com/jobs/${company}/${uid}`, { json: false });
      const token = html.match(/"token":\s*"([0-9A-Fa-f]+)"/)?.[1];
      if (!token) throw new Error(`comeet: no token for ${slug}`);
      const d = await get(`https://www.comeet.co/careers-api/2.0/company/${uid}/positions?token=${token}&details=false`);
      return (Array.isArray(d) ? d : []).map((j) => ({
        title: (j.name ?? '').trim(),
        url: j.url_comeet_hosted_page ?? j.url_active_page ?? `https://www.comeet.com/jobs/${company}/${uid}/${j.uid}`,
        location: [j.location?.city, j.location?.country].filter(Boolean).join(', ') || (j.location?.is_remote ? 'Remote' : j.location?.name ?? ''),
        department: j.department ?? '',
        postedAt: (j.time_updated ?? '').slice(0, 10),
      })).filter((j) => j.title);
    },
  },

  // Gem job boards (jobs.gem.com/<board>): public GraphQL. slug = board id.
  gem: {
    detect: (u) => u.match(/jobs\.gem\.com\/([\w-]+)/i)?.[1],
    async fetch(slug) {
      const res = await fetch('https://jobs.gem.com/api/public/graphql/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
        body: JSON.stringify([{ operationName: 'JobBoardList', variables: { boardId: slug }, query: 'query JobBoardList($boardId: String!) { oatsExternalJobPostings(boardId: $boardId) { jobPostings { id extId title locations { name } job { department { name } locationType } } } }' }]),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} gem ${slug}`);
      const d = await res.json();
      return (d?.[0]?.data?.oatsExternalJobPostings?.jobPostings ?? []).map((j) => ({
        title: (j.title ?? '').trim(),
        url: `https://jobs.gem.com/${slug}/${j.extId ?? j.id}`,
        location: (j.locations ?? []).map((l) => l.name).join(' | ') + (j.job?.locationType === 'REMOTE' ? ' (Remote)' : ''),
        department: j.job?.department?.name ?? '',
        postedAt: '',
      })).filter((j) => j.title);
    },
  },

  // Deel ATS (jobs.deel.com/<board>): the board lists job URLs in JSON-LD; each job page carries a JobPosting. slug = board id.
  deel: {
    detect: (u) => u.match(/jobs\.deel\.com\/(?:job-boards\/)?([\w-]+)/i)?.[1],
    async fetch(slug) {
      const html = await get(`https://jobs.deel.com/job-boards/${slug}`, { json: false });
      const urls = [...new Set([...html.matchAll(/https:\/\/jobs\.deel\.com\/[\w-]+\/job-details\/[0-9a-f-]{36}\/overview/g)].map((m) => m[0]))].slice(0, 300);
      const out = [];
      for (let i = 0; i < urls.length; i += 5) {
        await Promise.all(urls.slice(i, i + 5).map(async (u) => {
          try {
            const page = await get(u, { json: false });
            const ld = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).find((x) => x?.['@type'] === 'JobPosting');
            if (!ld?.title) return;
            const a = ld.jobLocation?.address;
            out.push({ title: ld.title.trim(), url: u, location: [a?.addressLocality, a?.addressCountry?.name ?? a?.addressCountry].filter(Boolean).join(', '), postedAt: (ld.datePosted ?? '').slice(0, 10), description: plain(ld.description ?? '') });
          } catch { /* a single job page failing leaves it out of this cycle */ }
        }));
      }
      return out;
    },
  },

  // Paylocity Recruiting (recruiting.paylocity.com/recruiting/jobs/All/<board guid>/<name>): the board page embeds
  // window.pageData with every job. slug = "guid/name". A single job URL (/Jobs/Details/<id>) does not name its board.
  paylocity: {
    detect: (u) => {
      const m = u.match(/recruiting\.paylocity\.com\/recruiting\/jobs\/(?:All|Details)\/([0-9a-f-]{36})(?:\/([\w-]+))?/i);
      return m ? `${m[1]}/${m[2] ?? 'jobs'}` : null;
    },
    async fetch(slug) {
      const html = await get(`https://recruiting.paylocity.com/recruiting/jobs/All/${slug}`, { json: false });
      const raw = html.match(/window\.pageData\s*=\s*(\{[\s\S]*?\});\s*(?:<\/script>|window\.)/)?.[1];
      if (!raw) throw new Error(`paylocity: no pageData for ${slug}`);
      return (JSON.parse(raw).Jobs ?? []).filter((j) => !j.IsInternal).map((j) => ({
        title: (j.JobTitle ?? '').trim(),
        url: `https://recruiting.paylocity.com/Recruiting/Jobs/Details/${j.JobId}`,
        location: j.LocationName ?? [j.JobLocation?.City, j.JobLocation?.State].filter(Boolean).join(', '),
        department: j.HiringDepartment ?? '',
        postedAt: (j.PublishedDate ?? '').slice(0, 10),
        description: plain(j.Description ?? ''),
      })).filter((j) => j.title);
    },
  },

  // Zoho Recruit career sites (<tenant>.zohorecruit.<tld>/jobs/Careers or a company domain with /jobs/Careers): the page
  // embeds the job list as JSON in a hidden input. slug = the careers origin, e.g. https://careers.galaxeye.space.
  zohorecruit: {
    detect: (u) => u.match(/^(https?:\/\/[\w.-]+)\/jobs\/Careers/i)?.[1],
    async fetch(slug) {
      const html = await get(`${slug.replace(/\/+$/, '')}/jobs/Careers`, { json: false });
      const raw = html.match(/<input[^>]*value="(\[[^"]*)"[^>]*id="jobs"/)?.[1] ?? html.match(/id="jobs"[^>]*value="(\[[^"]*)"/)?.[1];
      if (!raw) throw new Error(`zohorecruit: no job list at ${slug}`);
      const arr = JSON.parse(raw.replace(/&#34;/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'"));
      return arr.filter((j) => j.Publish !== false).map((j) => ({
        title: (j.Posting_Title ?? j.Job_Opening_Name ?? '').trim(),
        url: `${slug.replace(/\/+$/, '')}/jobs/Careers/${j.id}/${encodeURIComponent((j.Posting_Title ?? '').trim().replace(/[^\w]+/g, '-'))}`,
        location: [j.City, j.State, j.Country].filter(Boolean).join(', '),
        department: j.Industry ?? '',
        postedAt: '',
      })).filter((j) => j.title);
    },
  },

  // Odoo Recruitment websites (<tenant>.odoo.com/jobs): server-rendered cards, paged at /jobs/page/N. slug = tenant host.
  odoo: {
    detect: (u) => u.match(/([\w-]+\.odoo\.com)\/jobs/i)?.[1],
    async fetch(slug) {
      const out = [], seen = new Set();
      for (let page = 1; page <= 30; page++) {
        const html = await get(`https://${slug}/jobs${page > 1 ? `/page/${page}` : ''}`, { json: false });
        const cards = html.split('<a href="/jobs/detail/').slice(1);
        let fresh = 0;
        for (const c of cards) {
          const path = c.match(/^([^"]+)"/)?.[1];
          const title = plain(c.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? '');
          if (!path || !title || seen.has(path)) continue;
          seen.add(path); fresh++;
          const when = c.match(/Publication date[\s\S]*?<span>(\d{2})\/(\d{2})\/(\d{4})/);
          out.push({
            title,
            url: `https://${slug}/jobs/detail/${path}`,
            location: plain(c.match(/itemprop="streetAddress">([\s\S]*?)<\/span>/)?.[1] ?? ''),
            postedAt: when ? `${when[3]}-${when[1]}-${when[2]}` : '',
          });
        }
        if (!fresh) break;
      }
      return out;
    },
  },

  // JobScore career sites (careers.jobscore.com/careers/<slug>): public Atom feed. slug = company slug.
  jobscore: {
    detect: (u) => u.match(/jobscore\.com\/(?:careers|jobs)\/([\w-]+)/i)?.[1],
    async fetch(slug) {
      const xml = await get(`https://careers.jobscore.com/jobs/${slug}/feed.atom`, { json: false });
      return xml.split('<entry>').slice(1).map((e) => ({
        title: plain(tag(e, 'title')),
        url: decode(e.match(/<link rel="alternate" href="([^"]+)"/)?.[1] ?? '').replace(/[?&]ref=rss.*$/, ''),
        location: decode(e.match(/atom#location" term="([^"]*)"/)?.[1] ?? '').replace(/\s+,/g, ','),
        department: decode(e.match(/atom#department" term="([^"]*)"/)?.[1] ?? ''),
        postedAt: (tag(e, 'published') || tag(e, 'updated') || '').slice(0, 10),
      })).filter((j) => j.title && j.url);
    },
  },
};

// Providers ported from career-ops (see providers-extra.mjs). Appended after the built-ins and never overriding one, so resolve() order is unchanged.
for (const [id, p] of Object.entries(extraProviders)) if (!(id in providers)) providers[id] = p;
// USAJOBS Search API (providers-usajobs.mjs; key from the environment). Registered from its hoisted functions, not its `usajobs` object:
// that module imports plain() and metaOf() from here, and function declarations exist before either module runs, so the cycle is safe.
providers.usajobs = { detect: usajobsDetect, fetch: usajobsFetch };

/** Work out { provider, slug } for a config entry from explicit fields or its careers URL. */
export function resolve(entry) {
  if (entry.provider && entry.slug) return { provider: entry.provider, slug: entry.slug };
  if (entry.provider && providers[entry.provider]) {
    const detected = providers[entry.provider].detect(entry.careers_url ?? '');
    return { provider: entry.provider, slug: detected || entry.slug || entry.careers_url || '' };
  }
  for (const [name, p] of Object.entries(providers)) {
    const slug = p.detect(entry.careers_url ?? '');
    if (slug) return { provider: name, slug };
  }
  return null;
}
