// Additional ATS providers for the portal scanner, merged into the registry by providers.mjs.
//
// These are re-implementations, adapted to this crawler's shape ({ detect(url), fetch(slug, entry) } returning
// [{ title, url, location, department, postedAt, ... }]), of the approaches in career-ops
// (MIT License, (c) 2026 Santiago Fernandez de Valderrama, https://github.com/career-ops-hq/career-ops).
// career-ops' Job type, HTTP/SSRF layer and registry are not used. Each provider reads only the vendor's public feed/pages.
//
// Ported providers (registry id: slug convention):
//   jobvite     Jobvite XML feed                 slug = vanity name ("tylertech") or "eid:<companyEId>"; entry.company_eid also works
//   taleo       Oracle Taleo Enterprise (TEE)    slug = career-section URL (https://x.taleo.net/careersection/<sec>/jobsearch.ftl)
//   phenom      Phenom People CareerConnect      explicit only; slug = careers origin; optional entry.phenom { urlPrefix, lang, country }
//   radancy     Radancy / TMP search-jobs        explicit only; slug = any URL on the careers origin
//   beesite     BeeSite (Mercedes-Benz etc.)     slug = host of the *.beesite.de search API
//   pageup      PageUp People                    slug = "<tenant>/<site>/<lang>"
//   consider    Consider (VC portfolio boards)   explicit only; slug = board origin + entry.consider_board; an aggregator
//   applitrack  Frontline AppliTrack             slug = district name
//   neogov      NEOGOV (schooljobs/governmentjobs) slug = "schooljobs|governmentjobs/<agency>[/<folder>]"
//   eploy       Eploy (live-jobs.xml)            explicit only; slug = careers origin
//   flowxtra    Flowxtra central job feed        slug = "global"; an aggregator over all Flowxtra tenants
//   amazon      Amazon Jobs search.json          slug = query spec, e.g. "team_category=team-project-kuiper" (Amazon Leo); explicit filter required
//
// Also re-implemented, from freehire (MIT License, https://github.com/strelov1/freehire), see the second block at the end of this file:
//   trakstar, traffit, paradox, manatal, appone, applicantstack, careerplug, hiringthing, paycor, opencats, hrmdirect, paycom,
//   hireclick, tenstreet, harri, higherme, edjoin, workstream, gupy
//
// Third batch (2026-10-23), independent re-implementations: the request shapes were learnt from the public code of other scrapers and
// then written afresh against the live endpoints; no source was copied. Inspiration / licence per platform:
//   dayforce             open-jobs (CC0-1.0, https://github.com/elliottdehn/open-jobs), ever-jobs (MIT, https://github.com/ever-jobs/ever-jobs)
//   talentsoft, rexx, varbi, emply, easycruit, dvinci, hirehive, digitalrecruiters, flatchr
//                        ever-jobs (MIT); dvinci also jobfeed (MIT, https://github.com/mcs0002/jobfeed)
//   intervieweb          jobseek (MIT, https://github.com/colophon-group/jobseek), jobfeed (MIT)
//   attrax               jobfeed (MIT)
// Deliberately not added although other scrapers have them: reachmee and webcruiter (robots.txt disallows every non-whitelisted agent).
// Exports: extraProviders (merged into the registry by providers.mjs) and harvestTable (for the Common Crawl harvester).
// Not ported: peoplesoft (career-ops version replays PeopleSoft form postbacks with a cookie jar; ~460 lines even without comments).

const UA = 'Mozilla/5.0 (compatible; jobcrawl; +https://github.com/egidinas/jobcrawl)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// crawl.mjs gives one entry 35 s; paging providers stop after this budget and keep what they have.
const BUDGET_MS = 28000;
const PAGE_DELAY_MS = 150;

async function req(url, { method = 'GET', headers = {}, body, redirect = 'follow', timeoutMs = 20000 } = {}) {
  return fetch(url, { method, headers: { 'user-agent': UA, ...headers }, body, redirect, signal: AbortSignal.timeout(timeoutMs) });
}
async function text(url, opts) {
  const res = await req(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}
async function json(url, opts) {
  const res = await req(url, { ...opts, headers: { accept: 'application/json', ...opts?.headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const posInt = (v, dflt, max) => (Number.isInteger(v) && v > 0 ? Math.min(v, max) : dflt);

const decode = (s = '') =>
  String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
/** Markup to a single line of plain text. */
const strip = (s = '') => decode(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
/** Markup to plain text keeping paragraph/list breaks (for descriptions). */
const block = (s = '') =>
  decode((/&lt;\/?[a-z]/i.test(s) ? decode(String(s)) : String(s)).replace(/<(?:br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const isoDate = (raw) => {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const hostOk = (h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(h) && !/^\d+(\.\d+){3}$/.test(h) && !/\.(local|internal)$/i.test(h);

// ---------------------------------------------------------------------------------------------------------------------
// Jobvite: GET app.jobvite.com/CompanyJobs/Xml.aspx?c=<companyEId>. The eId is not in the careers URL; it is read once from
// the board page (companyEId: '...') unless entry.company_eid / slug "eid:..." gives it. app.jobvite.com answers 429 under
// load; there is no retry here, the crawl simply tries again next cycle. A board with no openings 302s to NoJobs.htm.
function jobviteTag(b, name) {
  const open = `<${name}>`, close = `</${name}>`;
  const s = b.indexOf(open);
  if (s === -1) return '';
  const e = b.indexOf(close, s + open.length);
  return e === -1 ? '' : decode(b.slice(s + open.length, e)).trim();
}
function jobviteDate(raw) {
  const m = String(raw).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : isoDate(raw);
}
export function parseJobviteXml(xml) {
  const out = [];
  for (const b of String(xml).split('<job>').slice(1)) {
    const title = strip(jobviteTag(b, 'title'));
    let url = jobviteTag(b, 'detail-url') || jobviteTag(b, 'apply-url');
    if (!title || !/^https?:\/\//i.test(url)) continue;
    url = url.replace(/^http:/i, 'https:');
    out.push({
      title, url,
      location: strip(jobviteTag(b, 'location')),
      department: strip(jobviteTag(b, 'category')),
      postedAt: jobviteDate(jobviteTag(b, 'date')),
      description: block(jobviteTag(b, 'description')),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Taleo Enterprise career sections: the shell page carries the portal id; the job list is POST /careersection/rest/jobboard/searchjobs.
const taleoLoc = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.startsWith('[')) { try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map(strip).filter(Boolean).join('; '); } catch { /* plain text */ } }
  return strip(s);
};
const taleoVal = (v) => (v == null ? '' : Array.isArray(v) ? v.map(taleoVal).filter(Boolean).join(', ') : typeof v === 'object' ? taleoVal(v.value ?? v.text ?? v.label ?? v.name ?? v.displayValue) : strip(String(v)));
export function parseTaleoRows(data, board, heads) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  if (!Array.isArray(data.requisitionList)) {
    if (data.careerSectionUnAvailable) throw new Error('taleo: career section unavailable (private, or needs a portal id: put ?portal=<id> on the URL)');
    if (Object.keys(data).length === 0) return [];
    throw new Error(`taleo: unexpected response (keys: ${Object.keys(data).join(', ')})`);
  }
  const idx = (re) => heads.findIndex((h) => re.test(h));
  const pos = heads.length === 0;
  const ti = pos ? 0 : idx(/title/i), li = pos ? 1 : idx(/location|city/i), di = pos ? 2 : idx(/posting\s*date|date\s*posted|posted/i);
  const lang = board.searchParams.get('lang') || 'en';
  const out = [];
  for (const row of data.requisitionList) {
    const id = String(row?.contestNo ?? row?.jobId ?? '').trim();
    if (!id) continue;
    const v = (Array.isArray(row.column) ? row.column : []).map(taleoVal);
    const title = ti >= 0 ? v[ti] : strip(row.title || row.jobTitle || '');
    if (!title) continue;
    const u = new URL(`https://${board.hostname}/careersection/${encodeURIComponent(board.pathname.split('/')[2])}/jobdetail.ftl`);
    u.searchParams.set('job', id);
    u.searchParams.set('lang', lang);
    out.push({ title, url: u.href, location: li >= 0 ? taleoLoc(v[li]) : taleoLoc(row.location || ''), department: '', postedAt: di >= 0 ? isoDate(v[di]) : '' });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Phenom People: POST <origin>/widgets with ddoKey refineSearch, 100 per page. Job URL: <origin>/<urlPrefix>/job/<id>/<slug>.
const phenomSlug = (t) => String(t).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'job';
export function parsePhenom(data, origin, urlPrefix) {
  const rs = data?.refineSearch;
  const rows = [];
  for (const j of Array.isArray(rs?.data?.jobs) ? rs.data.jobs : []) {
    const id = j?.jobId != null ? String(j.jobId) : '';
    const title = strip(j?.title ?? '');
    if (!id || !title) continue;
    const loc = strip(j.location || j.cityStateCountry || j.cityState || '') || [...new Set([j.city, j.state, j.country].map((p) => String(p ?? '').trim()).filter(Boolean))].join(', ');
    rows.push({ id, title, url: `${origin}/${urlPrefix}/job/${encodeURIComponent(id)}/${phenomSlug(title)}`, location: loc, department: strip(j.category ?? ''), postedAt: isoDate(j.postedDate || j.dateCreated) });
  }
  return { total: typeof rs?.totalHits === 'number' ? rs.totalHits : null, rows };
}

// ---------------------------------------------------------------------------------------------------------------------
// Radancy / TMP "search-jobs" sites: /<lang>/search-jobs/results?... returns JSON { results: "<html>" }; older sites only
// serve server-rendered /search-jobs?p=N.
function radancyRows(html, origin) {
  const out = [], seen = new Set();
  const add = (id, href, inner, locHtml) => {
    const title = strip(inner);
    if (!title || seen.has(id)) return;
    let url; try { url = new URL(decode(href), origin).href; } catch { return; }
    seen.add(id);
    out.push({ id, title, url, location: strip(locHtml ?? ''), department: '', postedAt: '' });
  };
  for (const b of String(html).split(/<li class="search-results-list__item/).slice(1)) {
    const l = b.match(/search-results-list__job-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (l) add(b.match(/data-job-id="([^"]+)"/)?.[1] ?? l[1], l[1], l[2], b.match(/__job-info--location[\s\S]*?<span>([\s\S]*?)<\/span>/)?.[1]);
  }
  if (out.length) return out;
  const anchors = [...String(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  for (const [n, a] of anchors.entries()) {
    const id = a[1].match(/data-job-id="([^"]+)"/i)?.[1], href = a[1].match(/href="([^"]+)"/i)?.[1];
    if (!id || !href || !/\/job\//.test(href)) continue;
    const re = /class="[^"]*(?:\bjob-location\b|job-info\s+location)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|p|div)>/i;
    const loc = a[2].match(re)?.[1] ?? html.slice(a.index + a[0].length, anchors[n + 1]?.index ?? html.length).match(re)?.[1];
    add(id, href, a[2].match(/job-title[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? a[2].match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1] ?? a[2].replace(/<span[\s\S]*?<\/span>/gi, ' '), loc);
  }
  return out;
}
const radancyFragmentUrl = (listUrl, page) =>
  `${listUrl}/results?${new URLSearchParams({ ActiveFacetID: '0', CurrentPage: String(page), RecordsPerPage: '100', Distance: '50', RadiusUnitType: '0', Keywords: '', Location: '', ShowRadius: 'False', IsPagination: 'True', CustomFacetName: '', FacetTerm: '', FacetType: '0', SearchResultsModuleName: 'Search Results', SortCriteria: '0', SortDirection: '0', SearchType: '5', _: Date.now().toString(36) })}`;

// ---------------------------------------------------------------------------------------------------------------------
// BeeSite: GET https://<host>/search?data=<json> with FirstItem/CountItem paging; newest first.
const beesiteUrl = (host, first, cfg) =>
  `https://${host}/search?data=${encodeURIComponent(JSON.stringify({
    LanguageCode: cfg.languageCode ?? 'EN',
    SearchParameters: { FirstItem: first, CountItem: 100, Sort: [{ Criterion: 'PublicationStartDate', Direction: 'DESC' }], MatchedObjectDescriptor: ['PositionID', 'PositionTitle', 'PositionURI', 'PositionLocation.CityName', 'PublicationStartDate'] },
    SearchCriteria: Array.isArray(cfg.searchCriteria) ? cfg.searchCriteria : [],
  }))}`;

// ---------------------------------------------------------------------------------------------------------------------
// PageUp People: careers.pageuppeople.com/<tenant>/<site>/<lang>/listing/?page=N&page-items=100 (server-rendered table).
const PAGEUP = 'https://careers.pageuppeople.com';
const stripComments = (s) => { let o = '', p = 0; for (;;) { const a = s.indexOf('<!--', p); if (a === -1) return o + s.slice(p); o += s.slice(p, a); const b = s.indexOf('-->', a + 4); if (b === -1) return o; p = b + 3; } };
export function parsePageup(html, tenant, site, lang) {
  const open = String(html).match(/<tbody\b[^<>]*\bid=["']search-results-content["'][^<>]*>/i);
  if (!open) return null;
  const start = open.index + open[0].length;
  const close = html.slice(start).search(/<\/tbody\s*>/i);
  const end = close === -1 ? html.length : start + close;
  const body = stripComments(html.slice(start, end));
  const jobs = [];
  let links = 0;
  for (const m of body.matchAll(/<a\b([^<>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    if (!/\bclass=["'][^"']*\bjob-link\b/i.test(m[1])) continue;
    links++;
    const href = m[1].match(/(?<![\w-])href=["']([^"'<>]*)["']/i)?.[1];
    const id = href && decode(href).match(/^(?:https:\/\/careers\.pageuppeople\.com)?\/(\d+)\/([\w-]+)\/[^/]+\/job\/(\d+)/)?.slice(1);
    const title = strip(m[2]);
    if (!id || id[0] !== tenant || id[1] !== site || !title) continue;
    jobs.push({ title, url: `${PAGEUP}/${tenant}/${site}/${lang}/job/${id[2]}`, location: '', department: '', postedAt: '' });
  }
  return { jobs, links, more: /\bmore-link\b/.test(stripComments(html.slice(end))) };
}

// ---------------------------------------------------------------------------------------------------------------------
// AppliTrack: Output.asp?all=1 is a JavaScript snippet that document.writes one <table class='title'> per posting.
const appliDate = (v) => { const m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : ''; };
export function parseApplitrack(body, base, defaultLocation = '') {
  if (!String(body).trim()) return [];
  if (!body.includes('function applyFor')) throw new Error('applitrack: not an AppliTrack Output.asp script');
  const html = body.replace(/\\'/g, "'").replace(/\\"/g, '"');
  const out = [], seen = new Set();
  for (const b of html.split(/<table class='title'/i).slice(1)) {
    const id = b.match(/JobID:\s*(\d+)/i)?.[1];
    const title = strip((b.match(/<td id='wrapword'[^>]*>([\s\S]*?)<\/td>/i) || [])[1] ?? '').replace(/�/g, '');
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const field = (n) => strip((b.match(new RegExp(`${n}:\\s*</span>[\\s\\S]*?<span class=['"]normal['"][^>]*>([\\s\\S]*?)</span>`, 'i')) || [])[1] ?? '');
    const site = field('Location');
    const city = defaultLocation.split(',')[0].trim().toLowerCase();
    out.push({
      title,
      url: `${base}/default.aspx?AppliTrackJobId=${id}&AppliTrackLayoutMode=detail&AppliTrackViewPosting=1`,
      location: site && (!city || site.toLowerCase().includes(city)) ? site : [site, defaultLocation].filter(Boolean).join(' - '),
      department: '',
      postedAt: appliDate(field('Date Posted')),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// NEOGOV (schooljobs.com / governmentjobs.com): /careers/home/index?agency=..&page=N returns an HTML fragment, 10 per page.
export function parseNeogov(html, origin) {
  if (!String(html).trim()) return [];
  const items = html.split(/<li class="list-item"/i).slice(1);
  if (!items.length) {
    if (html.includes('jobs-not-found-container') || html.includes('search-results-listing-container')) return [];
    throw new Error('neogov: not a NEOGOV job list');
  }
  const out = [];
  for (const it of items) {
    const l = it.match(/<a [^>]*class="item-details-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) || it.match(/<a [^>]*href="([^"]+)"[^>]*class="item-details-link"[^>]*>([\s\S]*?)<\/a>/i);
    if (!l) continue;
    let url;
    try {
      const u = new URL(decode(l[1]), origin);
      if (u.origin !== origin || !/^\/careers\/[^/]+\/(?:[^/]+\/)?jobs\/\d+/.test(u.pathname)) continue;
      u.hash = '';
      url = u.href;
    } catch { continue; }
    const title = strip(l[2]);
    if (!title) continue;
    const meta = it.match(/<ul class="list-meta">([\s\S]*?)<\/ul>/i)?.[1] ?? '';
    out.push({ title, url, location: strip(meta.match(/<li>([\s\S]*?)<\/li>/i)?.[1] ?? ''), department: '', postedAt: '' });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Eploy: <careers origin>/live-jobs.xml is a sitemap of /vacancies/<id>/<title-slug>.html. Titles come from the slug (no detail fetch).
const EPLOY_JOB = /^\/vacancies\/(\d+)\/([^/?#]+)\.html\/?$/i;
const ACRONYMS = { ai: 'AI', api: 'API', cio: 'CIO', cto: 'CTO', eu: 'EU', hcm: 'HCM', hr: 'HR', it: 'IT', ml: 'ML', qa: 'QA', uk: 'UK', ui: 'UI', ux: 'UX' };
export function eployTitle(slug) {
  let s = slug; try { s = decodeURIComponent(slug); } catch { /* keep raw */ }
  return s.split(/--+/).map((seg) => seg.replace(/[-_]+/g, ' ').trim().split(/\s+/).map((w) => ACRONYMS[w.toLowerCase()] ?? (w ? w[0].toUpperCase() + w.slice(1) : '')).join(' ')).filter(Boolean).join(' - ');
}
export function parseEploy(xml, host) {
  if (!/<urlset\b/i.test(xml)) throw new Error('eploy: live-jobs.xml is not an XML urlset');
  const out = [], seen = new Set();
  for (const m of xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi)) {
    let u; try { u = new URL(decode(m[1]).trim()); } catch { continue; }
    const h = u.hostname.toLowerCase();
    const p = u.pathname.match(EPLOY_JOB);
    if (u.protocol !== 'https:' || u.search || !p || seen.has(p[1]) || !(h === host || (h.endsWith('.eploy.net') && h !== 'eploy.net'))) continue;
    const title = eployTitle(p[2]);
    if (!title) continue;
    seen.add(p[1]);
    out.push({ title, url: u.href, location: '', department: '', postedAt: '' });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
export const extraProviders = {
  // Jobvite (jobs.jobvite.com/<slug>). slug = vanity name or "eid:<companyEId>"; entry.company_eid skips the board lookup.
  jobvite: {
    detect: (u) => {
      const e = u.match(/app\.jobvite\.com\/CompanyJobs\/Xml\.aspx\?(?:[^#]*&)?c=([\w-]{4,40})/i)?.[1];
      if (e) return `eid:${e}`;
      const m = u.match(/jobs\.jobvite\.com\/(?:careers\/)?([\w-]+)/i)?.[1];
      return m && !/^(api|careers|company)$/i.test(m) ? m : null;
    },
    async fetch(slug, entry = {}) {
      let eid = String(entry.company_eid ?? '').trim() || (slug.startsWith('eid:') ? slug.slice(4) : '');
      if (!eid) {
        const board = await req(`https://jobs.jobvite.com/${encodeURIComponent(slug)}?fr=true&nl=1`, { redirect: 'manual', headers: { 'user-agent': UA, accept: 'text/html' } });
        if (!board.ok) throw new Error(`jobvite: board ${slug} answered HTTP ${board.status} (retired tenant or branded careers site)`);
        eid = (await board.text()).match(/companyEId\s*[:=]\s*['"]([A-Za-z0-9_-]{4,40})['"]/)?.[1];
        if (!eid) throw new Error(`jobvite: no companyEId on the ${slug} board; set company_eid on the entry`);
      }
      const url = `https://app.jobvite.com/CompanyJobs/Xml.aspx?c=${encodeURIComponent(eid)}`;
      const res = await req(url, { redirect: 'manual', timeoutMs: 30000, headers: { accept: 'application/xml,text/xml,*/*' } });
      if (res.status >= 300 && res.status < 400) {
        if (/nojobs\.htm/i.test(res.headers.get('location') ?? '')) return [];   // an empty board redirects here
        throw new Error(`jobvite: feed redirected (${res.status}) ${url}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return parseJobviteXml(await res.text());
    },
  },

  // Taleo Enterprise career sections. slug = https://<tenant>.taleo.net/careersection/<section>/jobsearch.ftl[?lang=xx]. Not Taleo Business Edition (tre.taleo.net).
  taleo: {
    detect: (u) => {
      const m = u.match(/^(https:\/\/(?!tre\.)[\w-]+\.taleo\.net\/careersection\/[\w.-]+\/)(?:jobsearch|joblist|jobdetail)\.ftl(\?[^#]*)?/i);
      const keep = ['lang', 'portal'].map((k) => [k, m?.[2]?.match(new RegExp(`[?&]${k}=([\\w-]+)`))?.[1]]).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
      return m ? `${m[1]}jobsearch.ftl${keep.length ? `?${keep.join('&')}` : ''}` : null;
    },
    async fetch(slug, entry = {}) {
      const board = new URL(slug);
      if (board.protocol !== 'https:' || !/^[\w-]+\.taleo\.net$/i.test(board.hostname) || /^tre\./i.test(board.hostname) || !/^\/careersection\/[\w.-]+\//.test(board.pathname)) throw new Error(`taleo: not a Taleo Enterprise career-section URL: ${slug}`);
      const browser = { 'user-agent': UA };
      const shell = await text(board.href, { headers: browser });
      let portal = [/[?&]portal=(\d+)/i, /["']portal(?:Id)?["']?\s*[:=]\s*["']?(\d+)/i, /name=["']portal["'][^>]*value=["'](\d+)/i].map((re) => shell.match(re)?.[1]).find(Boolean);
      // Some sections (e.g. nato.taleo.net) leave the portal field empty in the shell; the search then works with an empty portal param.
      portal = portal ?? board.searchParams.get('portal') ?? '';
      const head = shell.match(/<table\b[^>]*id=["']jobs["'][^>]*>[\s\S]*?<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1] ?? shell;
      const heads = [...head.matchAll(/<(?:th|label)[^>]*>([\s\S]*?)<\/(?:th|label)>/gi)].map((m) => strip(m[1])).filter((h) => h && !/^(?:icons?|actions?)$/i.test(h));
      const api = `https://${board.hostname}/careersection/rest/jobboard/searchjobs?lang=${encodeURIComponent(board.searchParams.get('lang') || 'en')}&portal=${portal}`;
      const maxPages = posInt(entry.max_pages, 100, 1000), t0 = Date.now(), out = [];
      for (let page = 1; page <= maxPages; page++) {
        if (page > 1) { if (Date.now() - t0 > BUDGET_MS) break; await sleep(PAGE_DELAY_MS); }
        const data = await json(api, {
          method: 'POST',
          headers: { ...browser, accept: 'application/json, text/javascript, */*; q=0.01', 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest', tz: 'America/Toronto', tzname: 'America/Toronto' },
          body: JSON.stringify({ multilineEnabled: false, sortingSelection: { sortBySelectionParam: '5', ascendingSortingOrder: 'true' }, fieldData: { fields: { KEYWORD: '', LOCATION: '' }, valid: true }, filterSelectionParam: { searchFilterSelections: [] }, advancedSearchFiltersSelectionParam: { searchFilterSelections: [] }, pageNo: page }),
        });
        const rows = parseTaleoRows(data, board, heads);
        out.push(...rows);
        const raw = Array.isArray(data?.requisitionList) ? data.requisitionList.length : 0;
        const total = Number(data?.pagingData?.totalCount);
        if (!raw || (Number.isFinite(total) && out.length >= total)) break;
      }
      return out;
    },
  },

  // Phenom People CareerConnect career sites on a company domain. Explicit only (no URL pattern). slug = careers origin
  // (falls back to careers_url). Optional entry.phenom: { urlPrefix: "global/en", lang: "en_global", country: "global", selectedFields: {} }, entry.max_pages.
  phenom: {
    detect: () => null,
    async fetch(slug, entry = {}) {
      const origin = originOf(slug || entry.careers_url);
      if (!origin) throw new Error(`phenom: cannot resolve origin from "${slug}"`);
      const cfg = entry.phenom && typeof entry.phenom === 'object' ? entry.phenom : {};
      const urlPrefix = String(cfg.urlPrefix || 'global/en').replace(/^\/+|\/+$/g, '');
      const country = typeof cfg.country === 'string' ? cfg.country : 'global';
      const maxPages = posInt(entry.max_pages, 20, 300), t0 = Date.now(), out = [], seen = new Set();
      let total = null;
      for (let page = 0; page < maxPages; page++) {
        if (page > 0) { if (Date.now() - t0 > BUDGET_MS) break; await sleep(PAGE_DELAY_MS); }
        const data = await json(`${origin}/widgets`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lang: typeof cfg.lang === 'string' ? cfg.lang : 'en_global', deviceType: 'desktop', country, pageName: 'search-results', ddoKey: 'refineSearch', sortBy: '', subsearch: '', from: page * 100, jobs: true, counts: true, all_fields: ['category', 'country', 'city'], size: 100, clearAll: false, jdsource: 'facets', isSliderEnable: false, pageId: 'page10', siteType: 'external', keywords: '', global: country === 'global', selected_fields: cfg.selectedFields && typeof cfg.selectedFields === 'object' ? cfg.selectedFields : {}, locationData: {} }),
        });
        const r = parsePhenom(data, origin, urlPrefix);
        if (total === null) total = r.total;
        let fresh = 0;
        for (const row of r.rows) if (!seen.has(row.id)) { seen.add(row.id); fresh++; out.push({ title: row.title, url: row.url, location: row.location, department: row.department, postedAt: row.postedAt }); }
        if (!fresh || (total !== null && (page + 1) * 100 >= total)) break;
      }
      return out;
    },
  },

  // Radancy / TMP career sites (/<lang>/search-jobs). Explicit only. slug = any URL on the careers origin (falls back to
  // careers_url); a URL ending in /search-jobs is used as the list URL. Optional entry.max_pages, entry.max_jobs (default 2000).
  radancy: {
    detect: () => null,
    async fetch(slug, entry = {}) {
      const u = new URL(slug || entry.careers_url);
      const listUrl = /\/search-jobs\/?$/.test(u.pathname) ? `${u.origin}${u.pathname.replace(/\/$/, '')}` : `${u.origin}/${u.pathname.match(/^\/([a-z]{2})(?:\/|$)/)?.[1] ?? 'en'}/search-jobs`;
      const maxPages = posInt(entry.max_pages, 200, 200), maxJobs = posInt(entry.max_jobs, 2000, 20000), t0 = Date.now();
      const out = [], seen = new Set();
      let fragment = true, lastPage = maxPages;
      for (let page = 1; page <= lastPage; page++) {
        if (page > 1) { if (Date.now() - t0 > BUDGET_MS) break; await sleep(PAGE_DELAY_MS); }
        let html = '', rows = [];
        if (fragment) {
          try {
            const j = await json(radancyFragmentUrl(listUrl, page), { headers: { 'x-requested-with': 'XMLHttpRequest' } });
            html = typeof j?.results === 'string' ? j.results : '';
            rows = radancyRows(html, u.origin);
          } catch (e) { if (page > 1) break; }
          if (page === 1 && !rows.length) fragment = false;
          if (page === 1 && fragment) lastPage = Math.min(maxPages, Number(html.match(/data-total-pages="(\d+)"/)?.[1]) || maxPages);
        }
        if (!fragment) { html = await text(`${listUrl}?p=${page}`, { headers: { accept: 'text/html' } }); rows = radancyRows(html, u.origin); }
        let fresh = 0;
        for (const r of rows) if (!seen.has(r.id)) { seen.add(r.id); fresh++; out.push({ title: r.title, url: r.url, location: r.location, department: '', postedAt: '' }); }
        if (!fresh || out.length >= maxJobs) break;
      }
      return out.slice(0, maxJobs);
    },
  },

  // BeeSite (*.beesite.de search API, e.g. the Mercedes-Benz tenant). slug = API host. Optional entry.beesite { languageCode, searchCriteria }, entry.max_pages.
  beesite: {
    detect: (u) => u.match(/^https?:\/\/((?:[\w-]+\.)*beesite\.de)(?=[/:?#]|$)/i)?.[1]?.toLowerCase() ?? null,
    async fetch(slug, entry = {}) {
      const host = String(slug).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!/^(?:[\w-]+\.)*beesite\.de$/i.test(host)) throw new Error(`beesite: ${host} is not a beesite.de host`);
      const cfg = entry.beesite && typeof entry.beesite === 'object' ? entry.beesite : {};
      const maxPages = posInt(entry.max_pages, 40, 40), t0 = Date.now(), out = [], seen = new Set();
      for (let page = 0; page < maxPages; page++) {
        if (page > 0) { if (Date.now() - t0 > BUDGET_MS) break; await sleep(PAGE_DELAY_MS); }
        const sr = (await json(beesiteUrl(host, page * 100 + 1, cfg)))?.SearchResult;
        const items = Array.isArray(sr?.SearchResultItems) ? sr.SearchResultItems : [];
        let fresh = 0;
        for (const it of items) {
          const d = it?.MatchedObjectDescriptor;
          const id = String(it?.MatchedObjectId ?? d?.PositionID ?? '');
          const title = strip(d?.PositionTitle ?? ''), url = String(d?.PositionURI ?? '').trim();
          if (!id || !title || !/^https?:\/\//i.test(url) || seen.has(id)) continue;
          seen.add(id); fresh++;
          const cities = [...new Set((Array.isArray(d.PositionLocation) ? d.PositionLocation : []).map((l) => String(l?.CityName ?? '').trim()).filter(Boolean))];
          out.push({ title, url, location: cities.join(' / '), department: '', postedAt: isoDate(d.PublicationStartDate) });
        }
        const total = typeof sr?.SearchResultCountAll === 'number' ? sr.SearchResultCountAll : null;
        if (!fresh || (total !== null && (page + 1) * 100 >= total)) break;
      }
      return out;
    },
  },

  // PageUp People (careers.pageuppeople.com/<tenant>/<site>/<lang>/...). slug = "<tenant>/<site>/<lang>". Optional entry.max_pages (default 20).
  pageup: {
    detect: (u) => u.match(/careers\.pageuppeople\.com\/(\d+)\/([\w-]+)\/([a-z]{2,3}(?:-[\w]{1,8})?)(?=[/?#]|$)/i)?.slice(1).join('/') ?? null,
    async fetch(slug, entry = {}) {
      const [tenant, site, lang] = String(slug).split('/');
      if (!/^\d+$/.test(tenant ?? '') || !site || !lang) throw new Error(`pageup: slug must be "<tenant>/<site>/<lang>", got "${slug}"`);
      const maxPages = posInt(entry.max_pages, 20, 200), t0 = Date.now(), out = [], seen = new Set();
      for (let page = 1; page <= maxPages; page++) {
        if (page > 1) { if (Date.now() - t0 > BUDGET_MS) break; await sleep(250); }
        const p = parsePageup(await text(`${PAGEUP}/${tenant}/${site}/${lang}/listing/?page=${page}&page-items=100`), tenant, site, lang);
        if (!p) { if (page === 1) throw new Error(`pageup: ${slug} returned no results table (login/error page, or the tenant moved off the vendor host)`); break; }
        if (!p.jobs.length && p.links) { if (page === 1) throw new Error(`pageup: ${slug} has job links that could not be read (markup changed)`); break; }
        let fresh = 0;
        for (const j of p.jobs) if (!seen.has(j.url)) { seen.add(j.url); fresh++; out.push(j); }
        if (!fresh || (!p.more && p.links < 100)) break;
      }
      return out;
    },
  },

  // Consider (getconsider.com) VC portfolio boards: an aggregator over many employers. Explicit only. slug = board origin
  // (falls back to careers_url, e.g. https://jobs.founderful.com/jobs); entry.consider_board = board id (required), entry.consider_size (default 500).
  // Roles are attributed as "<employer> (via <entry.name>)" like the other aggregators.
  consider: {
    detect: () => null,
    async fetch(slug, entry = {}) {
      const origin = originOf(slug || entry.careers_url);
      if (!origin || !hostOk(new URL(origin).hostname)) throw new Error(`consider: need an https careers_url on a public host (got "${slug}")`);
      if (!entry.consider_board) throw new Error('consider: set consider_board (the board id, not the host) on the entry');
      let cookie = '', csrf = '';
      try {   // the API wants the session cookie and CSRF token the board page hands out
        const page = await req(`${origin}/jobs`, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, timeoutMs: 8000 });
        if (page.ok) {
          cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
          csrf = (await page.text()).match(/"csrfToken"\s*:\s*"([^"]{8,})"/)?.[1] ?? '';
        }
      } catch { /* try without */ }
      const d = await json(`${origin}/api-boards/search-jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', referer: `${origin}/jobs`, ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) },
        body: JSON.stringify({ meta: { size: posInt(entry.consider_size, 500, 2000) }, board: { id: String(entry.consider_board), isParent: true }, query: { promoteFeatured: true } }),
      });
      const via = entry.name ? ` (via ${entry.name})` : '';
      return (Array.isArray(d?.jobs) ? d.jobs : []).map((j) => {
        let url; try { url = new URL(j.url || j.applyUrl || '', origin).href; } catch { return null; }
        const loc = Array.isArray(j.locations) && j.locations.length ? j.locations.filter((l) => typeof l === 'string').join(', ')
          : Array.isArray(j.normalizedLocations) && j.normalizedLocations.length ? j.normalizedLocations.map((l) => l?.label || l?.value).filter(Boolean).join(', ')
          : j.remote ? 'Remote' : '';
        const ts = typeof j.timeStamp === 'number' && j.timeStamp < 1e12 ? j.timeStamp * 1000 : j.timeStamp;
        return { title: strip(j.title ?? ''), url, company: j.companyName ? `${j.companyName}${via}` : (entry.name ?? ''), location: loc, department: '', postedAt: isoDate(ts) };
      }).filter((j) => j && j.title && j.url);
    },
  },

  // Frontline AppliTrack (www.applitrack.com/<district>/onlineapp). slug = district. Optional entry.default_location.
  applitrack: {
    detect: (u) => u.match(/^https:\/\/(?:www\.)?applitrack\.com\/([a-z0-9][\w-]{0,63})\//i)?.[1]?.toLowerCase() ?? null,
    async fetch(slug, entry = {}) {
      if (!/^[a-z0-9][\w-]{0,63}$/i.test(slug)) throw new Error(`applitrack: bad district "${slug}"`);
      const base = `https://www.applitrack.com/${slug}/onlineapp`;
      return parseApplitrack(await text(`${base}/jobpostings/Output.asp?all=1`, { headers: { accept: 'text/html,*/*' } }), base, typeof entry.default_location === 'string' ? entry.default_location : '');
    },
  },

  // NEOGOV job boards. slug = "schooljobs/<agency>[/<folder>]" or "governmentjobs/<agency>[/<folder>]". Optional entry.max_pages (default 30 = 300 postings).
  neogov: {
    detect: (u) => {
      const m = u.match(/^https:\/\/(?:www\.)?(schooljobs|governmentjobs)\.com\/careers\/([a-z0-9][\w-]{0,63})(?:\/([a-z0-9][\w-]{0,63}))?/i);
      return m && m[2].toLowerCase() !== 'home' ? [m[1], m[2], m[3]].filter(Boolean).join('/').toLowerCase() : null;
    },
    async fetch(slug, entry = {}) {
      const [site, agency, folder] = String(slug).split('/');
      if (!['schooljobs', 'governmentjobs'].includes(site) || !agency) throw new Error(`neogov: slug must be "schooljobs|governmentjobs/<agency>[/<folder>]", got "${slug}"`);
      const origin = `https://www.${site}.com`;
      const maxPages = posInt(entry.max_pages, 30, 200), t0 = Date.now(), out = [], seen = new Set();
      for (let page = 1; page <= maxPages; page++) {
        if (page > 1) { if (Date.now() - t0 > BUDGET_MS) break; await sleep(200); }
        const q = new URLSearchParams({ agency });
        if (folder) q.set('departmentFolder', folder);
        q.set('sort', 'PostingDate'); q.set('isDescendingSort', 'true'); q.set('page', String(page));
        let fresh = 0;
        for (const j of parseNeogov(await text(`${origin}/careers/home/index?${q}`, { headers: { 'x-requested-with': 'XMLHttpRequest' } }), origin)) if (!seen.has(j.url)) { seen.add(j.url); fresh++; out.push(j); }
        if (!fresh) break;
      }
      return out;
    },
  },

  // Eploy career sites on a company domain or *.eploy.net. Explicit only. slug = careers origin (falls back to careers_url).
  // Only the sitemap is read, so titles are rebuilt from the URL slug and there is no location or date.
  eploy: {
    detect: () => null,
    async fetch(slug, entry = {}) {
      let u; try { u = new URL(slug || entry.careers_url); } catch { throw new Error(`eploy: bad careers URL "${slug}"`); }
      const host = u.hostname.toLowerCase().replace(/\.$/, '');
      if (u.protocol !== 'https:' || !hostOk(host)) throw new Error(`eploy: need a public https careers URL (got "${slug}")`);
      // *.eploy.net tenants redirect to their branded domain; job URLs are then on the final host.
      const res = await req(`https://${host}/live-jobs.xml`, { timeoutMs: 15000, headers: { accept: 'application/xml,text/xml,*/*' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.url}`);
      return parseEploy(await res.text(), new URL(res.url).hostname.toLowerCase());
    },
  },

  // Flowxtra central feed (app.flowxtra.com/api/central/jobs): one feed for every Flowxtra customer, so this is an aggregator
  // (roles are attributed "<employer> (via Flowxtra)"). slug = "global". Optional entry.max_pages (default 3 = 300 newest roles).
  flowxtra: {
    detect: (u) => (/(?:^|\/\/|\.)flowxtra\.com/i.test(u) ? 'global' : null),
    async fetch(slug, entry = {}) {
      const maxPages = posInt(entry.max_pages, 3, 50), out = [];
      for (let page = 1; page <= maxPages; page++) {
        const d = await json(`https://app.flowxtra.com/api/central/jobs?status=Live&per_page=100&page=${page}`);
        const rows = d?.data?.data;
        if (!Array.isArray(rows)) throw new Error(`flowxtra: unexpected response (keys: ${d ? Object.keys(d).join(', ') : 'none'})`);
        for (const j of rows) {
          const title = strip(j?.title ?? '');
          let url = ''; try { const p = new URL(String(j?.urlJobApplay ?? '').trim()); if (p.protocol === 'https:' && /(^|\.)flowxtra\.com$/.test(p.hostname)) url = p.href; } catch { /* no usable link */ }
          if (!title || !url) continue;
          const loc = [j.city_company, j.state_company, j.country_company].filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
          if (j.workplace === 'Remote') loc.push('Remote');
          out.push({ title, url, company: typeof j.name_company === 'string' && j.name_company.trim() ? `${j.name_company.trim()} (via Flowxtra)` : 'Flowxtra', location: loc.join(', '), department: '', postedAt: isoDate(j.date_share) });
        }
        if (!d.data.next_page_url || rows.length < 100) break;
      }
      return out;
    },
  },

  // Amazon Jobs (www.amazon.jobs/en/search.json; ported from career-ops providers/amazon.mjs). The board is global (~20k+ roles), so an
  // entry MUST narrow it. slug = a query-string spec; entry.amazon (career-ops style object, arrays = facets) is merged on top. Verified:
  //   team_category=team-project-kuiper       Amazon Leo / Project Kuiper (server-side filter; ~900 live roles, all with team "team-project-kuiper")
  //   base_query=<text>                       fuzzy full-text (NOT an exact filter: "Leo" also hits ~1000 unrelated roles)
  //   category=hardware-development, business_category=<id>, normalized_country_code=DEU, loc_query=<text>, sort=recent|relevant
  // Facet keys get the "[]" suffix automatically; repeat a key (a=1&a=2) for several values. A pasted amazon.jobs search URL also works as
  // careers_url. Unfiltered specs are refused. entry.max_jobs caps the result (default 500, max 2000); sorted newest first. 100 per page.
  amazon: {
    detect: (u) => {
      let p; try { p = new URL(u); } catch { return null; }
      if (!/(^|\.)amazon\.jobs$/i.test(p.hostname) || /^\/(?:[a-z-]+\/)?jobs\/\d+/i.test(p.pathname)) return null;   // single posting: not a board
      return amazonSpec(p.searchParams) || 'unfiltered';
    },
    async fetch(slug, entry = {}) {
      const params = new URLSearchParams(String(slug).replace(/^.*?\?/, '').replace(/^\?/, ''));
      for (const [k, v] of Object.entries(entry.amazon && typeof entry.amazon === 'object' ? entry.amazon : {})) {
        for (const item of Array.isArray(v) ? v : [v]) if (item != null && item !== '') params.append(k, String(item));
      }
      const spec = amazonSpec(params);
      if (!spec) throw new Error(`amazon: refusing an unfiltered board; set slug to e.g. "team_category=team-project-kuiper" (got "${slug}")`);
      const cap = posInt(entry.max_jobs, 500, 2000), t0 = Date.now(), out = [], seen = new Set();
      for (let offset = 0; out.length < cap; offset += 100) {
        if (offset) { if (Date.now() - t0 > BUDGET_MS) break; await sleep(700); }
        const q = new URLSearchParams(spec);
        if (!q.has('base_query')) q.set('base_query', '');
        if (!q.has('loc_query')) q.set('loc_query', '');
        if (!q.has('sort')) q.set('sort', 'recent');
        q.set('result_limit', '100'); q.set('offset', String(offset));
        const d = await json(`https://www.amazon.jobs/en/search.json?${q}`);
        if (!Array.isArray(d?.jobs)) throw new Error(`amazon: unexpected response (keys: ${d ? Object.keys(d).join(', ') : 'none'})`);
        let fresh = 0;
        for (const j of d.jobs) {
          const path = typeof j?.job_path === 'string' ? j.job_path : '';
          const url = path ? `https://www.amazon.jobs${path.startsWith('/') ? '' : '/'}${path}` : '';
          const title = strip(j?.title ?? '');
          if (!title || !url || seen.has(url)) continue;
          seen.add(url); fresh++;
          const primary = String(j.normalized_location || j.location || '').trim();
          const places = primary ? [primary] : [];
          for (const raw of Array.isArray(j.locations) ? j.locations : []) {
            let l; try { l = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
            const n = String(l?.normalizedLocation || l?.location || '').trim();
            if (n && !places.includes(n) && !places.includes(String(l?.location || '').trim())) places.push(n);
          }
          const desc = block([j.description, j.basic_qualifications].filter(Boolean).join('<br/>')).slice(0, 6000);
          const row = { title, url, location: places.join(' · '), department: String(j.job_category || '').trim(), postedAt: amazonDate(j.posted_date) };
          if (desc) row.description = desc;
          out.push(row);
          if (out.length >= cap) break;
        }
        if (!fresh || d.jobs.length < 100) break;   // last page, or the API ignored offset
      }
      return out;
    },
  },
};

// amazon.jobs facet keys take the "[]" form (a bare key is silently ignored). Returns the normalised spec, or '' when nothing narrows the board.
const AMAZON_FACETS = new Set(['category', 'business_category', 'team_category', 'normalized_country_code', 'normalized_state_name', 'normalized_city_name', 'job_function_id', 'schedule_type_id', 'employee_class', 'industry_experience']);
/** "October  3, 2026" to 2026-10-03 (parsed as UTC so the local time zone cannot shift the day). */
function amazonDate(raw) {
  const t = Date.parse(`${String(raw ?? '').replace(/\s+/g, ' ').trim()} UTC`);
  return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10);
}
function amazonSpec(params) {
  const q = new URLSearchParams();
  for (const [k0, v] of params) {
    const k = k0.replace(/\[\]$/, '');
    if (!/^[a-z_]+$/.test(k) || !String(v).trim()) continue;
    if (/^(?:offset|result_limit)$/.test(k)) continue;
    q.append(AMAZON_FACETS.has(k) ? `${k}[]` : k, String(v).trim());
  }
  return [...q.keys()].some((k) => k !== 'sort') ? q.toString() : '';
}

// =====================================================================================================================
// Providers re-implemented from the approaches in freehire (MIT License, https://github.com/strelov1/freehire):
//   trakstar, traffit, paradox, manatal, appone, applicantstack, careerplug, hiringthing, paycor, opencats, hrmdirect, paycom
// They read the listing only (one or a few requests per board, no per-posting detail fetch), so descriptions are empty unless the
// feed carries them; the crawler's page-description fallback fills the rest. Each definition gives: host patterns, boardId(url),
// and page(board, n, state) -> { jobs: [{ id, title, url, location, postedAt }], more, name? }; the registry entry and the
// harvest probe are both built from it. The second batch (hireclick ... gupy) is defined further down and pushed onto the same list.

const FH_MAX = 30;                       // page cap for walked listings
/** All <a href> in a page as { href (absolute), text }. */
function pageLinks(html, base) {
  const out = [];
  for (const m of String(html).matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try { out.push({ href: new URL(decode(m[1]), base).href, text: strip(m[2]) }); } catch { /* unusable href */ }
  }
  return out;
}
/** Posting links to jobs: first non-empty anchor text per id wins. */
function linkJobs(html, base, idOf, urlOf) {
  const byId = new Map();
  for (const l of pageLinks(html, base)) {
    const id = idOf(l.href);
    if (!id) continue;
    const cur = byId.get(id);
    if (!cur) byId.set(id, { id, title: l.text, url: urlOf(id, l.href), location: '', postedAt: '' });
    else if (!cur.title && l.text) cur.title = l.text;
  }
  return [...byId.values()].filter((j) => j.title);
}
const okSlug = (v) => (v && !/^(www|api|app|static|cdn|jobs|careers|help|support)$/i.test(v) ? v : null);

const fhDefs = [
  { // Trakstar Hire (ex Recruiterbox): RSS at <board>.hire.trakstar.com/jobfeeds/<board>. board = subdomain.
    id: 'trakstar',
    hosts: [/\.hire\.trakstar\.com/i],
    boardId: (u) => okSlug(u.match(/([\w-]+)\.hire\.trakstar\.com/i)?.[1]?.toLowerCase()),
    async page(b) {
      const xml = await text(`https://${b}.hire.trakstar.com/jobfeeds/${b}`, { headers: { accept: 'application/rss+xml,application/xml,*/*' } });
      const jobs = xml.split('<item>').slice(1).map((it) => {
        const part = (n) => strip(it.match(new RegExp(`<(?:\\w+:)?${n}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${n}>`, 'i'))?.[1] ?? '');
        const link = part('link').replace(/^http:/, 'https:');
        return { id: link.replace(/\/+$/, '').split('/').pop(), title: part('title'), url: link, location: [part('locationCity'), part('locationState'), part('locationCountry')].filter(Boolean).join(', '), postedAt: isoDate(part('pubDate')), description: block(it.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] ?? '') };
      }).filter((j) => j.title && j.url);
      return { jobs, more: false };
    },
  },
  { // Traffit: <board>.traffit.com/public/an/list/?limit=&offset= (JSON). board = subdomain.
    id: 'traffit',
    hosts: [/\.traffit\.com/i],
    boardId: (u) => okSlug(u.match(/([\w-]+)\.traffit\.com/i)?.[1]?.toLowerCase()),
    async page(b, n) {
      const d = await json(`https://${b}.traffit.com/public/an/list/?limit=100&offset=${(n - 1) * 100}`);
      const items = Array.isArray(d?.items) ? d.items : [];
      const jobs = items.map((it) => {
        let geo = {}; try { geo = it.geolocation ? JSON.parse(it.geolocation) : {}; } catch { /* plain text */ }
        return { id: String(it.advertId ?? it.advertPublishId ?? ''), title: strip(it.title || it.name || ''), url: it.url, location: [geo.locality, geo.region1, geo.country].filter(Boolean).join(', '), postedAt: it.validStart ? isoDate(it.validStart * 1000) : '', description: block(it.description ?? '') };
      }).filter((j) => j.id && j.title && j.url);
      return { jobs, more: n * 100 < (d?.count ?? 0) };
    },
  },
  { // Paradox (Olivia) career sites: board = "<tenant>.paradox.ai/<site>". JSON search API, 100 per page.
    id: 'paradox',
    hosts: [/\.paradox\.ai/i],
    boardId: (u) => { const m = u.match(/^https?:\/\/((?:[\w-]+\.)+paradox\.ai)\/(?:co\/)?([\w.-]+)/i); return m && !/^(api|co)$/i.test(m[2]) ? `${m[1]}/${m[2]}`.toLowerCase() : null; },
    async page(b, n) {
      const [host, site] = b.split('/');
      if (!/^(?:[a-z0-9-]+\.)+paradox\.ai$/.test(host) || !site) throw new Error(`paradox: board must be "<host>.paradox.ai/<site>", got "${b}"`);
      const d = await json(`https://${host}/api/job-list-site-ui/search-job?${new URLSearchParams({ compsite_slug: site, limit: '100', page: String(n) })}`, { headers: { 'x-requested-with': 'XMLHttpRequest' } });
      if (!d?.success) throw new Error(`paradox: ${b} answered success=false`);
      const jobs = (d.jobs ?? []).map((j) => {
        let id = ''; try { id = new URL(j.original_apply_url).searchParams.get('job_id') ?? ''; } catch { /* no link */ }
        return { id, title: strip(j.job_title ?? ''), url: j.original_apply_url, location: [].concat(j.location_name ?? []).filter(Boolean).join(' | '), postedAt: '' };
      }).filter((j) => j.id && j.title);
      return { jobs, more: n * 100 < (d.total_jobs ?? 0) && (d.jobs ?? []).length > 0 };
    },
  },
  { // Manatal career pages (careers-page.com/<board>): open API, cursor by `next`.
    id: 'manatal',
    hosts: [/careers-page\.com/i],
    boardId: (u) => { const v = u.match(/careers-page\.com\/([\w-]+)/i)?.[1]; return v && !/^(job|jobs)$/i.test(v) ? v.toLowerCase() : null; },
    async page(b, n, st) {
      const d = await json(n === 1 ? `https://open.api.manatal.com/open/v3/career-page/${encodeURIComponent(b)}/jobs/` : st.next);
      st.next = d?.next || '';
      const jobs = (d?.results ?? []).map((p) => ({
        id: String(p.hash ?? ''), title: strip(p.position_name ?? ''), url: `https://www.careers-page.com/${b}/job/${p.hash}`,
        location: strip(p.location_display || [p.city, p.state, p.country].filter(Boolean).join(', ')) + (p.is_remote ? ' (Remote)' : ''), postedAt: '',
      })).filter((j) => j.id && j.title);
      return { jobs, more: !!st.next };
    },
  },
  { // AppOne: jobs.appone.com/api/portal/v1/companyjobposts/<board> returns the whole board.
    id: 'appone',
    hosts: [/\.appone\.com/i],
    boardId: (u) => { const v = u.match(/jobs\.appone\.com\/(?:portal\/)?([\w-]+)/i)?.[1]; return v && !/^(api|job|jobs)$/i.test(v) ? v.toLowerCase() : null; },
    async page(b) {
      const d = await json(`https://jobs.appone.com/api/portal/v1/companyjobposts/${encodeURIComponent(b)}`);
      const jobs = (d?.jobPosts ?? []).map((p) => ({ id: String(p.jobPostId ?? ''), title: strip(p.jobTitle ?? ''), url: p.jobPostUrl || `https://apply.appone.com/job/${p.jobPostId}`, location: strip(p.location ?? ''), postedAt: isoDate(p.datePosted) })).filter((j) => j.id && j.title);
      return { jobs, more: false, name: strip(d?.companyName ?? '') };
    },
  },
  { // ApplicantStack: <board>.applicantstack.com/x/openings?pge=N; the pager states the total. robots asks for a 5 s crawl delay.
    id: 'applicantstack',
    hosts: [/\.applicantstack\.com/i],
    delayMs: 5000,
    boardId: (u) => okSlug(u.match(/([\w-]+)\.applicantstack\.com/i)?.[1]?.toLowerCase()),
    async page(b, n, st) {
      const html = await text(`https://${b}.applicantstack.com/x/openings${n > 1 ? `?pge=${n}` : ''}`);
      if (!/id=["']data-table["']/.test(html)) return { jobs: [], more: false };
      const jobs = linkJobs(html, `https://${b}.applicantstack.com/`, (h) => h.match(/\/x\/detail\/([\w-]+)/)?.[1], (id) => `https://${b}.applicantstack.com/x/detail/${id}`);
      const total = Number(html.match(/tablepager[\s\S]{0,400}?\bof\s+(\d+)/)?.[1]);
      st.n = (st.n ?? 0) + jobs.length;
      return { jobs, more: Number.isFinite(total) && st.n < total && jobs.length > 0 };
    },
  },
  { // CareerPlug: <board>.careerplug.com/jobs?page=N, job pages /jobs/<id>.
    id: 'careerplug',
    hosts: [/\.careerplug\.com/i],
    boardId: (u) => okSlug(u.match(/([\w-]+)\.careerplug\.com/i)?.[1]?.toLowerCase()),
    async page(b, n) {
      const html = await text(`https://${b}.careerplug.com/jobs${n > 1 ? `?page=${n}` : ''}`);
      const jobs = linkJobs(html, `https://${b}.careerplug.com/`, (h) => { const u = new URL(h); return u.hostname === `${b}.careerplug.com` ? u.pathname.match(/^\/jobs\/(\d+)\/?$/)?.[1] : null; }, (id) => `https://${b}.careerplug.com/jobs/${id}`);
      for (const j of jobs) {   // anchor text is "<title> Location: <place> Post Date: MM-DD-YY"
        const m = j.title.match(/^(.*?)\s+Location:\s*(.*?)(?:\s+Post Date:\s*(\d{2})-(\d{2})-(\d{2}))?$/);
        if (m) { j.title = m[1]; j.location = m[2]; if (m[3]) j.postedAt = `20${m[5]}-${m[3]}-${m[4]}`; }
      }
      return { jobs: jobs.filter((j) => j.title), more: jobs.length > 0 };
    },
  },
  { // HiringThing: board = full careers host (white-labelled); the site root lists every posting as /job/<id>.
    id: 'hiringthing',
    hosts: [/\.hiringthing\.com/i],
    boardId: (u) => u.match(/^https?:\/\/((?:[\w-]+\.)+hiringthing\.com)(?=[/:?#]|$)/i)?.[1]?.toLowerCase() ?? null,
    async page(b) {
      if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(b)) throw new Error(`hiringthing: bad host "${b}"`);
      const html = await text(`https://${b}/`);
      const jobs = linkJobs(html, `https://${b}/`, (h) => { const u = new URL(h); return u.hostname === b ? u.pathname.match(/^\/job\/(\d+)/)?.[1] : null; }, (id, h) => { const u = new URL(h); return u.origin + u.pathname; });
      return { jobs, more: false };
    },
  },
  { // Paycor Recruiting: board = 32-hex clientId; CareerHome.action lists every open posting (JobIntroduction.action?id=).
    id: 'paycor',
    hosts: [/recruitingbypaycor\.com/i],
    boardId: (u) => u.match(/recruitingbypaycor\.com\/career\/\w+\.action\?(?:[^#]*&)?clientId=([0-9a-f]{32})/i)?.[1]?.toLowerCase() ?? null,
    async page(b) {
      if (!/^[0-9a-f]{32}$/i.test(b)) throw new Error(`paycor: clientId must be 32 hex chars, got "${b}"`);
      const html = await text(`https://recruitingbypaycor.com/career/CareerHome.action?clientId=${b}`);
      const jobs = linkJobs(html, 'https://recruitingbypaycor.com/career/', (h) => { const u = new URL(h); return /JobIntroduction\.action$/i.test(u.pathname) && (u.searchParams.get('clientId') ?? b).toLowerCase() === b.toLowerCase() ? u.searchParams.get('id') : null; }, (id) => `https://recruitingbypaycor.com/career/JobIntroduction.action?clientId=${b}&id=${id}`);
      return { jobs, more: false };
    },
  },
  { // OpenCATS career portals on a company host: https://<host>/index.php?m=careers&p=showAll, postings p=showJob&ID=<n>.
    id: 'opencats',
    hosts: [/index\.php\?m=careers/i],
    boardId: (u) => u.match(/^https?:\/\/([^/?#]+)\/(?:[^?#]*\/)?index\.php\?m=careers/i)?.[1]?.toLowerCase() ?? null,
    async page(b) {
      if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(b)) throw new Error(`opencats: bad host "${b}"`);
      const html = await text(`https://${b}/index.php?m=careers&p=showAll`);
      const jobs = linkJobs(html, `https://${b}/`, (h) => { const u = new URL(h); return u.hostname === b && u.searchParams.get('p') === 'showJob' ? u.searchParams.get('ID') : null; }, (id) => `https://${b}/index.php?m=careers&p=showJob&ID=${id}`);
      return { jobs, more: false };
    },
  },
  { // HRM Direct (ClearCompany): <board>.hrmdirect.com/employment/job-openings.php?search=true, postings job-opening.php?req=<n>.
    id: 'hrmdirect',
    hosts: [/\.hrmdirect\.com/i],
    boardId: (u) => okSlug(u.match(/([\w-]+)\.hrmdirect\.com/i)?.[1]?.toLowerCase()),
    async page(b) {
      const base = `https://${b}.hrmdirect.com/employment/`;
      const res = await req(`${base}job-openings.php?search=true`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.url}`);
      if (!/\.hrmdirect\.com$/i.test(new URL(res.url).hostname)) throw new Error(`hrmdirect: board ${b} moved to ${new URL(res.url).hostname}`);
      const html = await res.text();
      const jobs = linkJobs(html, base, (h) => h.match(/job-opening\.php\?(?:[^#]*&)?req=(\d+)/i)?.[1], (id) => `${base}job-opening.php?req=${id}`);
      return { jobs, more: false };
    },
  },
  { // Paycom ATS portals: board = 32-hex client key. The portal page embeds a session JWT and the Mantle API host; postings via POST search.
    id: 'paycom',
    hosts: [/paycomonline\.net\/v4\/ats/i],
    boardId: (u) => u.match(/paycomonline\.net\/v4\/ats\/web\.php\/(?:portal\/|[^#]*?clientkey=)([0-9a-f]{32})/i)?.[1]?.toLowerCase() ?? null,
    async page(b, n, st) {
      if (!/^[0-9a-f]{32}$/i.test(b)) throw new Error(`paycom: client key must be 32 hex chars, got "${b}"`);
      if (n === 1) {
        const html = await text(`https://www.paycomonline.net/v4/ats/web.php/portal/${b}/jobs/1`);
        const jwt = html.match(/"sessionJWT":"([^"]+)"/)?.[1], host = html.match(/portal-applicant-tracking\.[a-z0-9-]+\.paycomonline\.net/)?.[0];
        if (!jwt || !host) throw new Error(`paycom: no session in portal page for ${b} (board does not exist?)`);
        st.mantle = `https://${host}`; st.auth = { authorization: jwt, locale: 'en-US' };
      }
      const take = 100, skip = (n - 1) * take;
      const d = await json(`${st.mantle}/api/ats/job-posting-previews/search`, {
        method: 'POST', headers: { ...st.auth, 'content-type': 'application/json' },
        body: JSON.stringify({ skip, take, filtersForQuery: { distanceFrom: 0, workEnvironments: [], positionTypes: [], educationLevels: [], categories: [], travelTypes: [], shiftTypes: [], otherFilters: [], keywordSearchText: '', location: '', sortOption: '' } }),
      });
      const jobs = (d?.jobPostingPreviews ?? []).map((p) => ({ id: String(p.jobId ?? ''), title: strip(p.jobTitle ?? p.title ?? ''), url: `https://www.paycomonline.net/v4/ats/web.php/portal/${b}/jobs/${p.jobId}`, location: strip(p.location ?? ''), postedAt: isoDate(p.startDate) })).filter((j) => j.id);
      return { jobs, more: skip + take < (d?.jobPostingPreviewsCount ?? 0) && jobs.length > 0 };
    },
  },
];

// ---- second batch (freehire approaches): hireclick, tenstreet, harri, higherme, edjoin, workstream, gupy ----
/** GET a page but stop reading as soon as `re` matches the text received so far (or `capBytes` are read). Returns the match or null. */
async function sniff(url, re, { capBytes = 8e6, timeoutMs = 25000 } = {}) {
  const res = await req(url, { timeoutMs, headers: { accept: 'text/html,*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const dec = new TextDecoder();
  let buf = '', bytes = 0;
  try {
    for await (const chunk of res.body) {
      bytes += chunk.length; buf += dec.decode(chunk, { stream: true });
      const m = buf.match(re);
      if (m) return m;
      if (bytes > capBytes) break;
    }
  } finally { try { await res.body?.cancel(); } catch { /* already closed */ } }
  return null;
}
const harriBad = /^(job|jobs|search|login|about|careers|api|static|app|www)$/i;

fhDefs.push(
  { // HireClick (<board>.hireclick.com): the org GUID sits in #hdnOrgGuid of a heavy board page, so only the first bytes are streamed.
    id: 'hireclick',
    hosts: [/\.hireclick\.com/i],
    boardId: (u) => okSlug(u.match(/([\w-]+)\.hireclick\.com/i)?.[1]?.toLowerCase()),
    async page(b) {
      const origin = `https://${b}.hireclick.com`;
      const m = await sniff(`${origin}/jobboard/jobboard.aspx`, /<input[^>]*\bid=["']hdnOrgGuid["'][^>]*\bvalue=["']([^"']+)["']|<input[^>]*\bvalue=["']([^"']+)["'][^>]*\bid=["']hdnOrgGuid["']/i);
      const guid = m?.[1] || m?.[2];
      if (!guid) throw new Error(`hireclick: no org GUID for ${b} (board does not exist, or the GUID is beyond the first 8 MB)`);
      let d = await json(`${origin}/api/Controllers/JobBoard/GetSettingsAndJobs?orgGUID=${encodeURIComponent(guid)}`, { timeoutMs: 30000 });
      if (typeof d === 'string') d = JSON.parse(d);   // the endpoint answers a JSON string holding the JSON document
      const jobs = (d?.JobList ?? []).map((j) => {
        const u = String(j.JobURL ?? '');
        return { id: u.match(/\/jb\/[^/]+\/view\/(\d+)/)?.[1] ?? '', title: strip(j.JobTitle ?? ''), url: u.startsWith('http') ? u : origin + u, location: strip(j.City ?? j.Location ?? j.JobLocation ?? ''), postedAt: '' };
      }).filter((j) => j.id && j.title);
      return { jobs, more: false };
    },
  },
  { // Tenstreet (Driver Pulse): board = numeric company id. The listing's onclick handlers carry the posting ids; titles are the element text.
    id: 'tenstreet',
    hosts: [/pulse\.tenstreet\.com/i],
    boardId: (u) => u.match(/pulse\.tenstreet\.com\/[^?#]*\?(?:[^#]*&)?company_id=(\d+)/i)?.[1] ?? null,
    async page(b) {
      if (!/^\d+$/.test(b)) throw new Error(`tenstreet: board must be a numeric company id, got "${b}"`);
      const html = await text(`https://pulse.tenstreet.com/share_app_index.php?company_id=${b}`);
      const name = strip(html.match(/id=["']carrier_detail_company_name["'][^>]*>([\s\S]*?)</)?.[1] ?? '');
      if (!name) throw new Error(`tenstreet: company ${b} not found`);
      const byId = new Map();
      for (const m of html.matchAll(/<(\w+)\b[^>]*\bonclick=["'][^"]*?share_app_show_active_jobs\.php\?([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi)) {
        const q = new URLSearchParams(decode(m[2]));
        const id = q.get('active_job_id');
        if (q.get('company_id') !== b || !/^\d+$/.test(id ?? '')) continue;
        const title = strip(m[3]);
        if (!byId.has(id) || (!byId.get(id).title && title)) byId.set(id, { id, title, url: `https://pulse.tenstreet.com/share_app_show_active_jobs.php?active_job_id=${id}&company_id=${b}&portal_user_id=1`, location: '', postedAt: '' });
      }
      return { jobs: [...byId.values()].map((j) => ({ ...j, title: j.title || `${name} posting ${j.id}` })), more: false, name };
    },
  },
  { // HiBob careers: board = tenant slug (<slug>.careers.hibob.com). One keyless call lists the whole board with descriptions inline; the API
    // answers 401 unless the request carries the tenant's own careers page as Referer (the header the page itself sends). Endpoint shape from freehire (MIT).
    id: 'hibob',
    hosts: [/\.careers\.hibob\.com/i],
    boardId: (u) => u.match(/^https?:\/\/([a-z0-9-]+)\.careers\.hibob\.com(?=[/:?#]|$)/i)?.[1]?.toLowerCase() ?? null,
    async page(b) {
      if (!/^[a-z0-9-]+$/i.test(b)) throw new Error(`hibob: bad tenant slug "${b}"`);
      const d = await json(`https://${b}.careers.hibob.com/api/job-ad`, { headers: { referer: `https://${b}.careers.hibob.com/jobs` } });
      const jobs = (d?.jobAdDetails ?? []).filter((a) => a?.id && a.title).map((a) => ({
        id: String(a.id),
        title: strip(a.title),
        url: `https://${b}.careers.hibob.com/jobs/${encodeURIComponent(a.id)}`,
        location: [a.site, a.country].filter(Boolean).join(', '),
        postedAt: isoDate(a.publishedAt),
        description: [a.description, a.responsibilities ? `Responsibilities\n${block(a.responsibilities)}` : '', a.requirements ? `Requirements\n${block(a.requirements)}` : '', a.benefits ? `Benefits\n${block(a.benefits)}` : '']
          .map((s, i) => (i === 0 ? block(s ?? '') : s)).filter(Boolean).join('\n\n'),
      }));
      return { jobs, more: false };
    },
  },
  { // Harri: board = brand slug (harri.com/<slug>). Slug lookup, then POST search 100 per page.
    id: 'harri',
    hosts: [/(?:^|\/\/|\.)harri\.com/i],
    boardId: (u) => { const v = u.match(/^https?:\/\/(?:www\.)?harri\.com\/([\w.-]+)/i)?.[1]; return v && !harriBad.test(v) ? v.toLowerCase() : null; },
    async page(b, n, st) {
      const gw = 'https://gateway.harri.com';
      if (n === 1) {
        const p = (await json(`${gw}/core/api/v1/profile/slug/${encodeURIComponent(b)}`))?.data;
        if (!p?.id || p.type !== 'brand' || p.is_archived) throw new Error(`harri: ${b} is not a live brand`);
        st.id = p.id;
      }
      const start = (n - 1) * 100;
      const d = (await json(`${gw}/core/api/v1/harri_search/search_jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start, size: 100, source: 'web', brand_level_ids: [st.id], sort: ['publish_date'], sort_type: 'desc', flow: 'CAREER_PORTAL' }) }))?.data;
      const rows = d?.results ?? [];
      const jobs = rows.map((j) => {
        const title = strip(j.aliasPosition || j.position?.name || '');
        const locs = [...new Set((j.locations ?? []).map((l) => [l.city, l.state, l.country].map((x) => strip(x ?? '')).filter(Boolean).join(', ')).filter(Boolean))];
        return { id: String(j.id ?? ''), title, url: `https://harri.com/${j.brand?.slug || b}/job/${j.id}`, location: locs.join(' | '), postedAt: isoDate(j.publishTime) };
      }).filter((j) => j.id && j.title);
      return { jobs, more: rows.length > 0 && start + rows.length < (d?.hits ?? 0) };
    },
  },
  { // HigherMe: board = brand id (app.higherme.com/careers/<brand>); public JSON API filtered by brand.
    id: 'higherme',
    hosts: [/higherme\.com/i],
    boardId: (u) => u.match(/higherme\.com\/careers\/([\w-]+)/i)?.[1] ?? null,
    async page(b, n) {
      const q = new URLSearchParams({ page: String(n), limit: '100', includes: 'location,location.brand', 'filters[brand.id]': b });
      const d = await json(`https://api.higherme.com/classic/jobs?${q}`);
      const jobs = (d?.data ?? []).filter((p) => p.id && p.attributes?.status === 'published').map((p) => {
        const l = p.relations?.location?.attributes ?? {};
        return { id: String(p.id), title: strip(p.attributes.title ?? ''), url: `https://app.higherme.com/jobs/${encodeURIComponent(p.id)}`, location: [l.city, l.state?.name, l.country?.name].filter(Boolean).join(', '), postedAt: '', description: block(p.attributes.summary ?? '') };
      }).filter((j) => j.title);
      return { jobs, more: n < (d?.meta?.last_page ?? 0) && (d?.data ?? []).length > 0 };
    },
  },
  { // EdJoin (California K-12): an aggregator over districts; board = numeric job-type id. 500 per page, capped at 4 pages by default.
    id: 'edjoin',
    hosts: [/edjoin\.org/i],
    defaultPages: 4,
    boardId: (u) => u.match(/edjoin\.org\/[^#]*[?&]jobTypes=(\d+)/i)?.[1] ?? null,
    async page(b, n) {
      if (!/^\d+$/.test(b)) throw new Error(`edjoin: board must be a numeric job-type id, got "${b}"`);
      const q = new URLSearchParams({ rows: '500', page: String(n), sort: 'postingDate', sortVal: '0', order: 'desc', searchType: 'all', jobTypes: b, days: '0', catID: '0', districtID: '0', recruitmentCenterID: '0' });
      const d = await json(`https://www.edjoin.org/Home/LoadJobs?${q}`);
      const jobs = (d?.data ?? []).map((p) => {
        const ms = Number(String(p.postingDate ?? '').match(/^\/Date\((-?\d+)\)\/$/)?.[1]);
        return { id: String(p.postingID ?? ''), title: strip(p.positionTitle ?? ''), url: `https://www.edjoin.org/Home/JobPosting/${p.postingID}`, company: p.districtName ? `${strip(p.districtName)} (via EdJoin)` : 'EdJoin', location: [p.city, p.stateName].map((x) => strip(x ?? '')).filter(Boolean).join(', '), postedAt: Number.isFinite(ms) ? isoDate(ms) : '' };
      }).filter((j) => j.id && j.title);
      return { jobs, more: n * 500 < (d?.totalRecords ?? 0) && jobs.length > 0 };
    },
  },
  { // Workstream (www.workstream.us/j/<8 hex>): server-rendered /positions list with ?page=N.
    id: 'workstream',
    hosts: [/workstream\.us\/j\//i],
    boardId: (u) => u.match(/workstream\.us\/j\/([0-9a-f]{8})(?=[/?#]|$)/i)?.[1]?.toLowerCase() ?? null,
    async page(b, n, st) {
      if (!/^[0-9a-f]{8}$/.test(b)) throw new Error(`workstream: board must be 8 hex chars, got "${b}"`);
      const home = `https://www.workstream.us/j/${b}/positions`;
      let html;
      if (n === 1) {
        html = await text(home);
        st.base = html.match(/var searchBaseUrl = '([^']+)'/)?.[1];
        if (!st.base) throw new Error(`workstream: ${b} is not a career site`);
        if (st.base !== home) html = await text(st.base);
        st.pages = Number(html.match(/var totalPages = (\d+)/)?.[1]) || 1;
        st.name = strip(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/ Careers and.*$/i, '');
      } else html = await text(`${st.base}${st.base.includes('?') ? '&' : '?'}page=${n}`);
      const jobs = linkJobs(html, 'https://www.workstream.us/', (h) => new URL(h).pathname.match(new RegExp(`^/j/${b}/[^/]+/[^/]+/[^/]+-([0-9a-f]{8})$`))?.[1], (id, h) => { const u = new URL(h); return u.origin + u.pathname; });
      return { jobs, more: n < st.pages && jobs.length > 0, name: st.name };
    },
  },
  { // Gupy (Brazil): board = subdomain of <board>.gupy.io; public job-publication API filtered by subdomain.
    id: 'gupy',
    hosts: [/\.gupy\.io/i],
    boardId: (u) => { const v = u.match(/([\w-]+)\.gupy\.io/i)?.[1]?.toLowerCase(); return v && !/^(www|portal|api|private-api|static)$/.test(v) ? v : null; },
    async page(b) {
      const d = await json(`https://private-api.gupy.io/job-publication/public/jobs?subdomain=${encodeURIComponent(b)}`);
      const jobs = (d?.data ?? []).map((p) => ({ id: String(p.id ?? ''), title: strip(p.name ?? ''), url: `https://${b}.gupy.io/jobs/${p.id}`, location: [p.addressCity, p.addressStateShortName, p.addressCountry].filter(Boolean).join(', ') + (p.remoteWorking ? ' (Remote)' : ''), postedAt: '' })).filter((j) => j.id && j.title);
      return { jobs, more: false };
    },
  },
);

// ---- third batch (independent re-implementations; endpoint shapes studied in ever-jobs / open-jobs / jobseek / jobfeed, see header) ----
/** name=value pairs of a response's Set-Cookie headers, joined for a Cookie request header. */
const cookiesOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
/** First <tag>..</tag> of an XML/RSS fragment as plain text ('' when absent). */
const xmlPart = (frag, tag) => strip(frag.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))?.[1] ?? '');
const labelOk = (v) => /^[a-z0-9][a-z0-9-]*$/i.test(v);

fhDefs.push(
  { // Dayforce candidate portal: board = "<namespace>[/<siteCode>]" (jobs.dayforcehcm.com/en-US/<namespace>/<siteCode>). A CSRF token plus its
    // cookie come from /api/auth/csrf; the search POST then pages with paginationStart (25 per page). Shape cross-checked in open-jobs (CC0).
    id: 'dayforce',
    hosts: [/jobs\.dayforcehcm\.com/i],
    delayMs: 500,
    boardId: (u) => {
      const m = u.match(/^https?:\/\/jobs\.dayforcehcm\.com\/(?:[a-z]{2}-[a-z]{2}\/)?([\w-]+)(?:\/([\w-]+))?/i);
      return m && !/^(api|en|_next|static)$/i.test(m[1]) ? `${m[1]}/${m[2] ?? 'CANDIDATEPORTAL'}` : null;
    },
    async page(b, n, st) {
      const [ns, site = 'CANDIDATEPORTAL'] = b.split('/');
      if (!labelOk(ns) || !/^[\w-]+$/.test(site)) throw new Error(`dayforce: bad board "${b}"`);
      if (n === 1) {
        const res = await req('https://jobs.dayforcehcm.com/api/auth/csrf', { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`dayforce: csrf HTTP ${res.status}`);
        const token = (await res.json())?.csrfToken;
        if (!token) throw new Error('dayforce: no csrf token');
        st.h = { 'content-type': 'application/json', 'x-csrf-token': token, cookie: cookiesOf(res) };
      }
      const start = (n - 1) * 25;
      const res = await req(`https://jobs.dayforcehcm.com/api/geo/${ns}/jobposting/search`, { method: 'POST', headers: { accept: 'application/json', ...st.h }, body: JSON.stringify({ clientNamespace: ns, jobBoardCode: site, cultureCode: 'en-US', paginationStart: start }) });
      if (res.status === 404) throw new Error(`dayforce: board ${b} not found`);
      if (!res.ok) throw new Error(`dayforce: search HTTP ${res.status}`);
      const d = await res.json();
      const rows = Array.isArray(d?.jobPostings) ? d.jobPostings : [];
      const jobs = rows.map((p) => {
        const loc = [...new Set((p.postingLocations ?? []).map((l) => strip(l.formattedAddress || [l.cityName, l.stateCode, l.isoCountryCode].filter(Boolean).join(', '))).filter(Boolean))];
        return { id: String(p.jobPostingId ?? ''), title: strip(p.jobTitle ?? ''), url: `https://jobs.dayforcehcm.com/en-US/${ns}/${site}/jobs/${p.jobPostingId}`, location: loc.join(' | ') || (p.hasVirtualLocation ? 'Remote' : ''), postedAt: isoDate(p.postingStartTimestampUTC), description: block(p.jobDescription ?? '') };
      }).filter((j) => j.id && j.title);
      return { jobs, more: rows.length > 0 && start + rows.length < (d?.maxCount ?? 0) };
    },
  },
  { // Talentsoft (France): every tenant publishes its whole offer list as RSS at <tenant>-recrute.talent-soft.com/handlers/offerRss.ashx. board = host.
    id: 'talentsoft',
    hosts: [/\.talent-soft\.com/i],
    boardId: (u) => u.match(/^https?:\/\/((?:[a-z0-9-]+\.)*[a-z0-9-]+\.talent-soft\.com)(?=[/:?#]|$)/i)?.[1]?.toLowerCase() ?? null,
    async page(b) {
      if (!/^(?:[a-z0-9-]+\.)+talent-soft\.com$/i.test(b)) throw new Error(`talentsoft: bad host "${b}"`);
      const xml = await text(`https://${b}/handlers/offerRss.ashx?LCID=1036`, { headers: { accept: 'application/rss+xml,application/xml,*/*' } });
      const jobs = xml.split(/<item\b[^>]*>/i).slice(1).map((it) => {
        const link = xmlPart(it, 'link');
        const title = xmlPart(it, 'title');
        const ref = title.match(/^\s*(\d{2,4}-[0-9A-Za-z]+)\s*[-:–—]\s*/)?.[1];
        const id = ref || link.match(/(?:\/r\/|_|reference=)([\w-]{3,})/)?.[1] || xmlPart(it, 'guid') || link;
        return { id, title: title.replace(/^\s*\d{2,4}-[0-9A-Za-z]+\s*[-:–—]\s*/, ''), url: link, location: '', postedAt: isoDate(xmlPart(it, 'pubDate')), description: block(it.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] ?? '') };
      }).filter((j) => j.id && j.title && /^https?:/.test(j.url));
      return { jobs, more: false };
    },
  },
  { // rexx systems (Germany): <tenant>-portal.rexx-systems.com/stellenangebote.html lists every vacancy as an article card. Listing only.
    id: 'rexx',
    hosts: [/\.rexx-systems\.com/i],
    boardId: (u) => okSlug(u.match(/^https?:\/\/([a-z0-9-]+?)-portal\.rexx-systems\.com/i)?.[1]?.toLowerCase()),
    async page(b) {
      if (!labelOk(b)) throw new Error(`rexx: bad tenant "${b}"`);
      const origin = `https://${b}-portal.rexx-systems.com`;
      const html = await text(`${origin}/stellenangebote.html`);
      const jobs = html.split(/<article\b/i).slice(1).map((card) => {
        const a = card.match(/joboffer_title_text[\s\S]*?<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
        if (!a) return null;
        const url = new URL(decode(a[1]), origin + '/').href;
        const id = url.match(/-(?:de|en|fr)?-?j(\d+)\.html/i)?.[1];
        const loc = strip(card.match(/job_standort[^>]*>([\s\S]*?)<\/(?:div|span|p)>/i)?.[1] ?? '');
        return id ? { id, title: strip(a[2]), url, location: loc, postedAt: '' } : null;
      }).filter((j) => j && j.title);
      return { jobs, more: false };
    },
  },
  { // Varbi (Sweden): <tenant>.varbi.com/en/ lists vacancies as table rows (what:job/jobID:N); the date shown is the application deadline, so no postedAt.
    id: 'varbi',
    hosts: [/\.varbi\.com/i],
    boardId: (u) => okSlug(u.match(/^https?:\/\/([a-z0-9-]+)\.varbi\.com/i)?.[1]?.toLowerCase()),
    async page(b) {
      if (!labelOk(b)) throw new Error(`varbi: bad tenant "${b}"`);
      const origin = `https://${b}.varbi.com`;
      const html = await text(`${origin}/en/`);
      const jobs = [];
      for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const id = row[1].match(/what:job\/jobID:(\d+)/)?.[1];
        const title = strip(row[1].match(/pos-title[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '');
        if (!id || !title) continue;
        const loc = strip(row[1].match(/pos-town[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '');
        jobs.push({ id, title, url: `${origin}/en/what:job/jobID:${id}/`, location: loc, postedAt: '' });
      }
      return { jobs, more: false };
    },
  },
  { // Emply (Denmark): <tenant>.career.emply.com/<locale>/<vacancies page> embeds proceedBatch({vacancies: JSON.parse('...')}) in the HTML.
    id: 'emply',
    hosts: [/\.career\.emply\.com/i],
    boardId: (u) => okSlug(u.match(/^https?:\/\/([a-z0-9-]+)\.career\.emply\.com/i)?.[1]?.toLowerCase()),
    async page(b) {
      if (!labelOk(b)) throw new Error(`emply: bad tenant "${b}"`);
      const origin = `https://${b}.career.emply.com`;
      for (const path of ['en/vacant-positions', 'vacant-positions', 'en/vacancies', 'en/jobs']) {
        const res = await req(`${origin}/${path}`, { redirect: 'manual', headers: { accept: 'text/html,*/*' } });
        if (!res.ok) { await res.body?.cancel(); continue; }
        const m = (await res.text()).match(/proceedBatch\(\s*\{\s*vacancies\s*:\s*JSON\.parse\(\s*'([\s\S]*?)'\s*\)/);
        if (!m) continue;
        // the literal is a single-quoted JS string: undo its escapes, then it is plain JSON
        const raw = m[1].replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e) => (e[0] === 'u' || e[0] === 'x' ? String.fromCharCode(parseInt(e.slice(1), 16)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }[e] ?? e)));
        let list = JSON.parse(raw);
        if (!Array.isArray(list)) list = list?.vacancies ?? [];
        const loc = path.startsWith('en/') ? 'en/' : '';
        const jobs = list.map((v) => {
          const id = String(v.shortId ?? v.publishingId ?? v.number ?? '');
          const slug = v.titleAsUrl ? `${encodeURIComponent(v.titleAsUrl)}/` : '';
          const t = v.translations?.find((x) => x?.title)?.title;
          return { id, title: strip(v.title || t || ''), url: v.externalCseAdLink || `${origin}/${loc}ad/${slug}${encodeURIComponent(id)}`, location: strip(v.location ?? ''), department: strip(v.department ?? ''), postedAt: isoDate(v.published ?? v.created) };
        }).filter((j) => j.id && j.title);
        return { jobs, more: false };
      }
      throw new Error(`emply: no vacancy list found for ${b}`);
    },
  },
  { // EasyCruit (Norway): <tenant>.easycruit.com/export/xml/vacancy/list.xml, one <Vacancy> per posting with language <Version>s.
    id: 'easycruit',
    hosts: [/\.easycruit\.com/i],
    boardId: (u) => okSlug(u.match(/^https?:\/\/([a-z0-9-]+)\.easycruit\.com/i)?.[1]?.toLowerCase()),
    async page(b) {
      if (!labelOk(b)) throw new Error(`easycruit: bad tenant "${b}"`);
      const xml = await text(`https://${b}.easycruit.com/export/xml/vacancy/list.xml`, { headers: { accept: 'application/xml,text/xml,*/*' } });
      const jobs = [];
      for (const m of xml.matchAll(/<Vacancy\b([^>]*)>([\s\S]*?)<\/Vacancy>/gi)) {
        const attr = (n) => decode(m[1].match(new RegExp(`\\b${n}="([^"]*)"`, 'i'))?.[1] ?? '');
        const id = attr('id');
        const versions = [...m[2].matchAll(/<Version\b[^>]*\blanguage="([^"]*)"[^>]*>([\s\S]*?)<\/Version>/gi)];
        const v = (versions.find((x) => /^en/i.test(x[1])) ?? versions[0])?.[2] ?? m[2];
        const title = xmlPart(v, 'Title') || xmlPart(v, 'TitleHeading');
        const dep = m[2].match(/<Department\b[^>]*>([\s\S]*?)<\/Department>/i)?.[1] ?? '';
        const url = xmlPart(dep, 'VacancyURL') || `https://${b}.easycruit.com/vacancy/${id}/`;
        if (id && title) jobs.push({ id, title, url, location: xmlPart(v, 'Location'), department: xmlPart(dep, 'Name'), postedAt: isoDate(attr('date_start')) });
      }
      return { jobs, more: false };
    },
  },
  { // d.vinci (DE/AT/CH): GET <host>/jobPublication/list.json. board = full host (custom career domains are common); "<x>.dvinci-hr.com" is auto-detected.
    id: 'dvinci',
    hosts: [/\.dvinci-hr\.com/i],
    boardId: (u) => u.match(/^https?:\/\/([a-z0-9-]+\.dvinci-hr\.com)(?=[/:?#]|$)/i)?.[1]?.toLowerCase() ?? null,
    async page(b) {
      const host = b.includes('.') ? b : `${b}.dvinci-hr.com`;
      if (!hostOk(host)) throw new Error(`dvinci: bad host "${b}"`);
      const d = await json(`https://${host}/jobPublication/list.json?fields=small`);
      const list = Array.isArray(d) ? d : d?.jobPublications ?? d?.data ?? [];
      const jobs = list.map((p) => {
        const o = p.jobOpening ?? {};
        const locs = (o.locations ?? []).map((l) => strip(l.address?.city || l.name || '')).filter(Boolean);
        return { id: String(p.id ?? ''), title: strip(p.position || p.pageTitle || ''), url: p.jobPublicationURL || `https://${host}/en/jobs/${p.id}`, location: strip(o.location ?? '') || [...new Set(locs)].join(' | '), department: strip(o.department ?? ''), postedAt: isoDate(p.startDate ?? o.createdDate) };
      }).filter((j) => j.id && j.title);
      return { jobs, more: false };
    },
  },
  { // HireHive (Ireland/UK): the tenant career site's own JSON feed, <tenant>.hirehive.com/api/v2/jobs, 100 per page.
    id: 'hirehive',
    hosts: [/\.hirehive\.com/i],
    boardId: (u) => okSlug(u.match(/^https?:\/\/([a-z0-9-]+)\.hirehive\.com/i)?.[1]?.toLowerCase()),
    async page(b, n) {
      if (!labelOk(b)) throw new Error(`hirehive: bad tenant "${b}"`);
      const d = await json(`https://${b}.hirehive.com/api/v2/jobs?page=${n}&page_size=100&source=CareerSite`);
      const jobs = (d?.items ?? []).map((j) => ({
        id: String(j.id ?? ''), title: strip(j.title ?? ''), url: j.hosted_url || `https://${b}.hirehive.com/`,
        location: [j.location, j.state_code, j.country?.name].map((x) => strip(x ?? '')).filter(Boolean).join(', '),
        department: strip(j.category?.name ?? ''), postedAt: isoDate(j.published_date), description: block(j.description?.html ?? j.description?.text ?? ''),
      })).filter((j) => j.id && j.title);
      return { jobs, more: !!d?.meta?.has_next_page && jobs.length > 0 };
    },
  },
  { // DigitalRecruiters (France): the careers SPA's anonymous API. Site config resolves the canonical domain and locale, then job-ads pages (POST, 1-based).
    // board = career host (<tenant>.digitalrecruiters.com or a mapped custom domain).
    id: 'digitalrecruiters',
    hosts: [/\.digitalrecruiters\.com/i],
    boardId: (u) => { const h = u.match(/^https?:\/\/([a-z0-9-]+\.digitalrecruiters\.com)(?=[/:?#]|$)/i)?.[1]?.toLowerCase(); return h && !/^(www|api|app)\./.test(h) ? h : null; },
    async page(b, n, st) {
      if (!hostOk(b)) throw new Error(`digitalrecruiters: bad host "${b}"`);
      const api = 'https://api.digitalrecruiters.com';
      if (n === 1) {
        const c = await json(`${api}/careers/v1/careers-sites/${encodeURIComponent(b)}`);
        if (!c?.domain_name || c.is_online === false) throw new Error(`digitalrecruiters: ${b} is not an online careers site`);
        st.domain = c.domain_name; const iso = String(c.default_locale?.iso_code ?? ''); st.locale = /^[a-z]{2}_[A-Z]{2}$/.test(iso) ? iso : ({ en: 'en_GB', fr: 'fr_FR', de: 'de_DE', es: 'es_ES', it: 'it_IT', pt: 'pt_PT', nl: 'nl_NL' }[iso.slice(0, 2).toLowerCase()] ?? 'en_GB'); st.name = strip(c.name ?? '');
      }
      const q = new URLSearchParams({ domainName: st.domain, limit: '50', page: String(n), locale: st.locale });
      const d = await json(`${api}/public/v1/careers-site/job-ads?${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const items = Array.isArray(d?.items) ? d.items : [];
      const lang = st.locale.slice(0, 2).toLowerCase();
      const jobs = items.map((j) => ({ id: String(j.job_ad_id ?? j.id ?? ''), title: strip(j.title ?? ''), url: j.is_external && /^https?:/.test(j.url ?? '') ? j.url : `https://${st.domain}/${lang}/annonce/${j.url ?? j.job_ad_id}`, location: strip(j.location ?? ''), department: strip(j.job ?? ''), postedAt: '' })).filter((j) => j.id && j.title);
      return { jobs, more: items.length > 0 && (n - 1) * 50 + items.length < (d?.count ?? 0), name: st.name };
    },
  },
  { // Flatchr (France): one JSON document per company, careers.flatchr.io/company/<slug>.json, vacancies embedded in items[].vacancy.
    id: 'flatchr',
    hosts: [/careers\.flatchr\.io/i],
    boardId: (u) => u.match(/^https?:\/\/careers\.flatchr\.io\/(?:[a-z]{2}\/)?company\/([\w-]+)/i)?.[1]?.toLowerCase() ?? null,
    async page(b) {
      if (!/^[\w-]+$/.test(b)) throw new Error(`flatchr: bad slug "${b}"`);
      const d = await json(`https://careers.flatchr.io/company/${b}.json`);
      const jobs = (d?.items ?? []).map((it) => {
        const v = it.vacancy ?? it, a = v.address ?? {};
        const id = String(v.id ?? it.id ?? v.slug ?? '');
        return { id, title: strip(v.title ?? ''), url: `https://careers.flatchr.io/company/${b}/vacancy/${v.slug ?? id}/`, location: [a.locality ?? a.city, a.administrative_area_level_1, a.country].map((x) => strip(x ?? '')).filter(Boolean).join(', '), department: strip(v.metier ?? v.activity ?? ''), postedAt: isoDate(v.created_at ?? it.created_at), description: block([v.description, v.mission, v.profile].filter(Boolean).join('\n')) };
      }).filter((j) => j.id && j.title);
      return { jobs, more: false, name: strip(d?.items?.[0]?.vacancy?.company?.name ?? '') || undefined };
    },
  },
  { // Intervieweb / inRecruiting (Italy): board = career page URL on *.intervieweb.it. Page 1 is HTML; its hidden #url-for-announces and a section token
    // drive POST "vacancyListCareer" calls that return {success, data: html fragment} per page.
    id: 'intervieweb',
    hosts: [/\.intervieweb\.it/i],
    boardId: (u) => { const m = u.match(/^(https:\/\/[a-z0-9-]+\.intervieweb\.it\/[\w-]+\/[a-z]{2}\/career)(?:[/?#]|$)/i); return m ? m[1].toLowerCase() : null; },
    async page(b, n, st) {
      if (!/^https:\/\/[a-z0-9-]+\.intervieweb\.it\//i.test(b)) throw new Error(`intervieweb: bad board "${b}"`);
      const origin = new URL(b).origin;
      // each card is a "vacancy__render" block: <a href=".../jobs/<slug>-<id>/<lang>/"><h3>title</h3></a> plus a location line
      const jobsOf = (html) => {
        const byId = new Map();
        for (const card of html.split(/vacancy__render/).slice(1)) {
          const a = card.match(/<a\b[^>]*\bhref=["']([^"']+\/jobs\/([^/"']+)\/[a-z]{2}\/?)["'][^>]*>([\s\S]*?)<\/a>/i);
          if (!a) continue;
          const url = new URL(decode(a[1]), b);
          const title = strip(a[3]);
          if (url.origin === origin && title && !byId.has(a[2])) byId.set(a[2], { id: a[2], title, url: url.origin + url.pathname, location: strip(card.match(/class=["']sr-only["'][^>]*>[^<]*<\/span>([^<]*)</i)?.[1] ?? ''), postedAt: '' });
        }
        return [...byId.values()];
      };
      if (n === 1) {   // the page itself only carries the endpoint, the section token and a session cookie; the cards arrive by POST (since mid 2026)
        const res = await req(b, { headers: { accept: 'text/html,*/*' } });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${b}`);
        const html = await res.text();
        st.cookie = cookiesOf(res);
        st.ajax = decode(html.match(/id=["']url-for-announces["'][^>]*value=["']([^"']+)["']|value=["']([^"']+)["'][^>]*id=["']url-for-announces["']/i)?.slice(1).find(Boolean) ?? '');
        st.section = html.match(/["']section["']\s*:\s*["']([^"']+)["']/i)?.[1];
        if (!st.ajax || !st.section) throw new Error('intervieweb: no announce endpoint/section on the career page');
        st.pages = Math.max(1, ...[...html.matchAll(/\bPage\s+\d+\s+of\s+(\d+)\b/gi)].map((m) => Number(m[1])));
      }
      const ajax = new URL(st.ajax, b);
      if (ajax.origin !== origin) throw new Error('intervieweb: pagination endpoint left the board origin');
      const body = new URLSearchParams({ act1: 'vacancyListCareer', section: st.section, order: 'name', page: String(n), country: '', region: '', function: '', project: '', text: '', division: '', company: '' });
      const d = await json(ajax.href, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest', referer: b, ...(st.cookie ? { cookie: st.cookie } : {}) }, body: body.toString() });
      if (!d?.success || typeof d.data !== 'string') throw new Error('intervieweb: pagination refused');
      const jobs = jobsOf(d.data);
      const pc = Math.max(0, ...[...d.data.matchAll(/\bPage\s+\d+\s+of\s+(\d+)\b/gi)].map((m) => Number(m[1])));
      return { jobs, more: jobs.length > 0 && n < Math.max(pc, st.pages) };
    },
  },
  { // Attrax (UK/EU corporate career sites): server-rendered vacancy tiles at <search page>?page=N. board = the search page URL (custom domains, so never auto-detected).
    id: 'attrax',
    hosts: [],
    defaultPages: 12,
    boardId: () => null,
    async page(b, n, st) {
      const base = new URL(b);
      if (base.protocol !== 'https:' || !hostOk(base.hostname)) throw new Error(`attrax: bad board "${b}"`);
      base.searchParams.set('page', String(n));
      const html = await text(base.href, { headers: { accept: 'text/html,*/*' } });
      const total = Number(strip(html.match(/attrax-pagination__total-results[^>]*>([\s\S]*?)<\//i)?.[1] ?? '').replace(/[^\d]/g, '')) || 0;
      if (!total && !/attrax-vacancy-tile/.test(html)) throw new Error(`attrax: ${b} does not look like an Attrax vacancy search`);
      const jobs = html.split(/(?=<[^>]*attrax-vacancy-tile\b[^>]*data-jobid)/i).slice(1).map((tile) => {
        const id = tile.match(/data-jobid=["'](\d+)["']/)?.[1];
        const a = tile.match(/<a\b[^>]*attrax-vacancy-tile__title[^>]*>/i)?.[0];
        const href = a?.match(/\bhref=["']([^"']+)["']/i)?.[1];
        const title = strip(tile.match(/attrax-vacancy-tile__title[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '');
        const loc = strip(tile.match(/attrax-vacancy-tile__location-freetext[\s\S]*?attrax-vacancy-tile__item-value[^>]*>([\s\S]*?)<\//i)?.[1] ?? '');
        return id && href && title ? { id, title, url: new URL(decode(href), b).href, location: loc, postedAt: '' } : null;
      }).filter(Boolean);
      st.seen = (st.seen ?? 0) + jobs.length;
      return { jobs, more: jobs.length > 0 && st.seen < total };
    },
  },
);

/** The board's first page as a harvest probe result: { exists, companyName?, jobIds[] }. Errors read as "not verified". */
async function fhProbe(d, board) {
  try {
    const st = {};
    const r = await d.page(board, 1, st);
    let companyName = r.name || undefined;
    if (d.id === 'paycom' && r.jobs.length) { try { companyName = strip((await json(`${st.mantle}/api/ats/company-name`, { headers: st.auth }))?.companyName ?? '') || undefined; } catch { /* optional */ } }
    return { exists: r.jobs.length > 0, companyName, jobIds: r.jobs.map((j) => j.id), jobCount: r.jobs.length, sample: r.jobs.slice(0, 6).map((j) => `${j.title} (${j.location || '?'})`) };
  } catch (e) { return { exists: false, jobIds: [], error: String(e.message).slice(0, 120) }; }
}

const freehireProviders = {};
for (const d of fhDefs) {
  freehireProviders[d.id] = {
    detect: (u) => { try { return d.boardId(String(u)) || null; } catch { return null; } },
    async fetch(slug, entry = {}) {
      const maxPages = posInt(entry.max_pages, d.defaultPages ?? FH_MAX, 200), t0 = Date.now(), st = {}, out = [], seen = new Set();
      for (let n = 1; n <= maxPages; n++) {
        if (n > 1) { if (Date.now() - t0 > BUDGET_MS) break; await sleep(d.delayMs ?? 300); }
        const r = await d.page(String(slug), n, st);
        let fresh = 0;
        for (const j of r.jobs) if (!seen.has(j.id)) { seen.add(j.id); fresh++; const { id, ...job } = j; out.push({ department: '', ...job }); }
        if (!r.more || !fresh) break;
      }
      return out;
    },
    probe: (board) => fhProbe(d, board),
  };
}
Object.assign(extraProviders, freehireProviders);

// Machine-readable table for the Common Crawl harvester / ats-resolve. For each ATS: providerId, hostPatterns (regexes that identify
// its hosts in a URL), boardIdFromUrl(url) -> board id (the slug for companies.json) or null, and probe(boardId) ->
// Promise<{ exists, companyName?, jobIds[] }> (one cheap listing request; exists = at least one posting; jobIds are native posting ids,
// so a board can be verified against an expected id; jobCount and sample titles are for display). The career-ops ATSs probe through fetch({ max_pages: 1 }); their jobs carry no
// native ids, so jobIds is [].
const coProbe = (id) => async (board) => {
  try { const jobs = await extraProviders[id].fetch(board, { max_pages: 1 }); return { exists: jobs.length > 0, jobIds: [], jobCount: jobs.length, sample: jobs.slice(0, 6).map((j) => `${j.title} (${j.location || '?'})`) }; }
  catch (e) { return { exists: false, jobIds: [], error: String(e.message).slice(0, 120) }; }
};
export const harvestTable = [
  ...fhDefs.map((d) => ({ providerId: d.id, hostPatterns: d.hosts, boardIdFromUrl: freehireProviders[d.id].detect, probe: freehireProviders[d.id].probe })),
  ...[['jobvite', [/jobs\.jobvite\.com/i]], ['taleo', [/\.taleo\.net\/careersection/i]], ['beesite', [/\.beesite\.de/i]], ['pageup', [/careers\.pageuppeople\.com/i]], ['applitrack', [/applitrack\.com/i]], ['neogov', [/(?:schooljobs|governmentjobs)\.com\/careers/i]]]
    .map(([id, hostPatterns]) => ({ providerId: id, hostPatterns, boardIdFromUrl: extraProviders[id].detect, probe: coProbe(id) })),
];
