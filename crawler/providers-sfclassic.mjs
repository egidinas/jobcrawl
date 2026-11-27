// SAP SuccessFactors classic career site (career<N>.successfactors.eu|com/career?company=<ID>): the job search an anonymous visitor
// sees, which is neither a Recruiting Marketing site (no /tile-search-results/) nor a Career Site Builder (no /services/recruiting/).
// OPT-IN: detect() never claims a URL; an entry sets provider "successfactors_classic" and slug = the career URL (or "<host>|<company>").
// Approved 2026-11-27 (PROVIDERS round 3, coordinator): the page sets a session cookie and a CSRF key for any visitor and its own
// search calls (DWR remoting) carry them; this provider replays exactly those anonymous calls. It never logs in: a login page, a 401 or a
// reply that is not a DWR callback fails the board.
// Approach learnt from career-ops providers/successfactors-classic.mjs (MIT License, (c) 2026 Santiago Fernandez de Valderrama,
// https://github.com/career-ops-hq/career-ops); written afresh for this crawler's provider shape. Flow:
//   1 GET  /career?company=<ID>&navBarLevel=JOB_SEARCH           -> cookies, ajaxSecKey (CSRF), view id, page language
//   2 POST careerJobSearchControllerProxy.getInitialJobSearchData -> filter fields and keyword languages
//   3 POST updateUserSelectedValues (no criteria, every language)   -> the whole inventory is selected
//   4 POST search, 50 per page, newest first                         -> postings {id, title, postingDate, defaultLocale}, detailURLPrefix
import { randomBytes, randomInt } from 'node:crypto';
import { UA } from './useragent.mjs';

const HOST = /^career\d*\.(?:successfactors|sapsf)\.(?:eu|com)$/i;
const COMPANY = /^[A-Za-z0-9_-]{1,64}$/;
const LOCALE = /^[a-z]{2}_[A-Z]{2}$/;
const CONTROLLER = 'careerJobSearchControllerProxy';
const PAGE_SIZE = 50;
const DEFAULT_PAGES = 20;   // 1,000 postings; entry.max_pages raises it (at most 100)
const PAGE_DELAY_MS = 400;  // well under 3 requests per second per host

/** { origin, company } from "https://career5.successfactors.eu/career?company=X..." or "career5.successfactors.eu|X"; null otherwise. */
export function sfClassicConfig(slug) {
  const s = String(slug ?? '').trim();
  let host, company;
  if (s.includes('|') && !/^https?:/i.test(s)) [host, company] = s.split('|');
  else { try { const u = new URL(s); host = u.hostname; company = u.searchParams.get('company') ?? u.searchParams.get('career_company'); } catch { return null; } }
  host = String(host ?? '').toLowerCase();
  if (!HOST.test(host) || !COMPANY.test(company ?? '')) return null;
  return { origin: `https://${host}`, company };
}

/** DWR call parameters: c0-paramN lines, objects and arrays flattened into c0-eN references (the format the page's own engine sends). */
export function dwrParams(params) {
  const lines = [];
  let n = 0;
  const enc = (v) => {
    if (v == null) return 'null:null';
    if (typeof v === 'string') return `string:${encodeURIComponent(v)}`;
    if (typeof v === 'number') return `number:${v}`;
    if (typeof v === 'boolean') return `boolean:${v}`;
    const ref = (x) => { const id = `c0-e${++n}`; lines.push(`${id}=${enc(x)}`); return `reference:${id}`; };
    if (Array.isArray(v)) return `Array:[${v.map(ref).join(',')}]`;
    return `Object_Object:{${Object.entries(v).map(([k, x]) => `${k}:${ref(x)}`).join(', ')}}`;
  };
  const top = params.map((p, i) => `c0-param${i}=${enc(p)}`);
  return [...lines, ...top];
}

const unescapeJs = (s) => s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e) => (e.length > 1 ? String.fromCharCode(parseInt(e.slice(1), 16)) : ({ n: '\n', r: '\r', t: '\t' }[e] ?? e)));

/** The objects a DWR reply builds (var sN={}/[]; sN.key=value;), in order. Throws on an exception reply or a non-DWR answer. */
export function parseDwr(text) {
  if (/dwr\.engine\._remoteHandleException\(/.test(text)) throw new Error(`successfactors_classic: DWR error ${/"message":"([^"]*)"/.exec(text)?.[1] ?? ''}`.trim());
  if (!/dwr\.engine\._remoteHandleCallback\(/.test(text)) throw new Error('successfactors_classic: not a DWR reply (session or CSRF key refused, or a login page)');
  // blank the string literals so the statement regexes cannot match inside them, then read the values from the original text
  const code = text.replace(/"(?:[^"\\]|\\.)*"/g, (lit) => `"${' '.repeat(lit.length - 2)}"`);
  const vars = new Map();
  for (const m of code.matchAll(/var (s\d+)=(\{\}|\[\]);/g)) vars.set(m[1], m[2] === '{}' ? {} : []);
  const val = (tok) => {
    if (tok[0] === '"') return unescapeJs(tok.slice(1, -1));
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    return /^s\d+$/.test(tok) ? vars.get(tok) : Number(tok);
  };
  for (const m of code.matchAll(/(s\d+)(?:\.(\w+)|\['([^']*)'\]|\[(\d+)\])=("(?:[^"\\]|\\.)*"|-?[\d.]+|true|false|null|s\d+);/dg)) {
    const target = vars.get(m[1]);
    const [a, b] = m.indices[5];
    if (target) target[m[2] ?? m[3] ?? m[4]] = val(text.slice(a, b));
  }
  return [...vars.values()];
}

/** "dd/mm/yyyy", "dd.mm.yyyy" or "mm/dd/yyyy" -> ISO date; the order is read from the dates themselves (a part > 12), else from the page language. */
export function sfDates(dates, lang) {
  let dayFirst = !/^en/i.test(lang ?? '');
  for (const d of dates) {
    const [a, b] = String(d).split(/[./-]/).map(Number);
    if (a > 12) { dayFirst = true; break; }
    if (b > 12) { dayFirst = false; break; }
  }
  return (d) => {
    const [a, b, y] = String(d ?? '').split(/[./-]/).map(Number);
    const [day, month] = dayFirst ? [a, b] : [b, a];
    if (!y || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return '';
    const t = new Date(Date.UTC(y, month - 1, day));
    return t.getUTCDate() === day ? t.toISOString().slice(0, 10) : '';
  };
}

/** One search reply -> { jobs, raw, total }. */
export function sfSearchRows(objects, cfg, lang) {
  const res = objects.find((o) => o && !Array.isArray(o) && Array.isArray(o.postings));
  if (!res) throw new Error('successfactors_classic: no postings in the search reply (protocol changed?)');
  const prefix = typeof res.detailURLPrefix === 'string' ? res.detailURLPrefix : '';
  const rows = res.postings.filter((p) => p && typeof p === 'object');
  if (rows.length && !/^\/career\?/.test(prefix)) throw new Error('successfactors_classic: no usable detailURLPrefix (protocol changed?)');
  const toIso = sfDates(rows.map((p) => p.postingDate).filter(Boolean), lang);
  const jobs = [];
  for (const p of rows) {
    const id = p.id == null ? '' : String(p.id);
    const title = String(p.title ?? '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
    if (!id || !title) continue;
    const locale = LOCALE.test(p.defaultLocale ?? '') ? p.defaultLocale : null;
    const path = prefix.replace(/%5f/gi, '_').replace(/(rcm_site_locale=)[A-Za-z_]+/, (m, k) => (locale ? k + locale : m));
    // the list carries no place; its first filter value is the tenant's own category (often the function: "Einkauf / Beschaffung")
    const dept = Array.isArray(p.otherValues?.[0]) ? String(p.otherValues[0][0]?.shortVal ?? '') : '';
    jobs.push({ id, title, url: `${cfg.origin}${path}${encodeURIComponent(id)}`, location: '', postedAt: toIso(p.postingDate), department: dept });
  }
  return { jobs, raw: res.postings.length, total: Number.isInteger(res.postingCount) ? res.postingCount : null };
}

const cookiesOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const sfClassicProvider = {
  detect: () => null,   // opt-in only
  async fetch(slug, entry = {}) {
    const t0 = Date.now();
    const cfg = sfClassicConfig(slug || entry.careers_url);
    if (!cfg) throw new Error(`successfactors_classic: slug must be a career?company= URL on a successfactors host or "<host>|<company>": ${slug}`);
    const searchPage = `/career?company=${encodeURIComponent(cfg.company)}&navBarLevel=JOB_SEARCH`;
    const searchUrl = `${cfg.origin}${searchPage}`;
    const boot = await fetch(searchUrl, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!boot.ok) throw new Error(`successfactors_classic: HTTP ${boot.status} ${searchUrl}`);
    const html = await boot.text();
    const key = /ajaxSecKey="([^"]+)"/.exec(html)?.[1];
    if (!key) throw new Error(`successfactors_classic: no ajaxSecKey on ${searchUrl} (login page or changed markup)`);
    const cookie = cookiesOf(boot);
    const viewId = /AjaxService\.setViewId\('([^']+)'\)/.exec(html)?.[1] ?? '/ui/rcmcareer/pages/careersite/career.jsp.xhtml';
    const lang = /<html[^>]*\blang="([^"]+)"/i.exec(html)?.[1] ?? 'en';
    let batch = 0;
    const dwr = async (method, page, params) => {
      const body = ['callCount=1', `page=${page}`, 'httpSessionId=', `scriptSessionId=${randomBytes(16).toString('hex').toUpperCase()}${randomInt(1000)}`,
        `c0-scriptName=${CONTROLLER}`, `c0-methodName=${method}`, 'c0-id=0', ...dwrParams(params), `batchId=${batch++}`, ''].join('\n');
      const res = await fetch(`${cfg.origin}/xi/ajax/remoting/call/plaincall/${CONTROLLER}.${method}.dwr`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000), body,
        headers: { 'user-agent': UA, 'content-type': 'text/plain', accept: '*/*', origin: cfg.origin, referer: searchUrl, 'x-csrf-token': key, 'x-ajax-token': key,
          viewid: viewId, 'x-subaction': '0', 'x-sap-page-info': `companyId=${cfg.company}`, ...(cookie ? { cookie } : {}) },
      });
      if (res.status !== 200) throw new Error(`successfactors_classic: HTTP ${res.status} on ${method}`);
      return parseDwr(await res.text());
    };
    const init = await dwr('getInitialJobSearchData', searchPage, [{ filterOnly: 'Y', jobAlertId: '', returnToList: '', browserTimeZone: 'UTC' }]);
    const filters = init.filter((o) => o && !Array.isArray(o) && typeof o.fieldName === 'string' && 'fieldType' in o);
    const languages = init.filter((o) => o && !Array.isArray(o) && typeof o.value === 'string' && LOCALE.test(o.value)).map((o) => o.value);
    if (!filters.length || !languages.length) throw new Error('successfactors_classic: no filters or keyword languages in the initial data (protocol changed?)');
    const searchScope = init.find((o) => o && !Array.isArray(o) && typeof o.searchScope === 'string')?.searchScope ?? '1';
    await dwr('updateUserSelectedValues', searchPage, [{
      daysPostedWithin: null, exactMatch: false, fullySelectedPicklists: {}, jobReqId: null, keyword: '', keywordLanguageSelectedValues: languages, objSelectedValues: {},
      picklistSelectedValues: Object.fromEntries(filters.filter((f) => f.fieldType === 'picklist').map((f) => [f.fieldName, []])), radialField: null, searchScope,
    }, null]);
    const summaryPage = `/career?company=${encodeURIComponent(cfg.company)}&career%5fns=job%5flisting%5fsummary&navBarLevel=JOB%5fSEARCH&_s.crb=${encodeURIComponent(key)}`;
    const maxPages = Number.isInteger(entry.max_pages) && entry.max_pages > 0 ? Math.min(entry.max_pages, 100) : DEFAULT_PAGES;
    const out = [], seen = new Set();
    let total = null, complete = false;
    for (let page = 1; page <= maxPages; page++) {
      if (page > 1) await sleep(PAGE_DELAY_MS);
      const reply = await dwr('search', summaryPage, [{ pagination: { currentPage: page, endRow: page * PAGE_SIZE, increaseCandSummaryPagination: false, pageSize: String(PAGE_SIZE),
        startRow: (page - 1) * PAGE_SIZE + 1, totalCount: total ?? 0 }, sortByColumn: 'JOB_POSTING_DATE', sortOrder: 'DESC' }]);
      const r = sfSearchRows(reply, cfg, lang);
      total = r.total ?? total;
      let fresh = 0;
      for (const j of r.jobs) if (!seen.has(j.id)) { seen.add(j.id); fresh++; const { id, ...job } = j; out.push(job); }
      if (r.raw < PAGE_SIZE || !fresh || (total !== null && seen.size >= total)) { complete = true; break; }
    }
    if (total && !out.length) throw new Error('successfactors_classic: postings counted but none read (protocol changed?)');
    // Places: the list carries none. Each posting page has schema.org microdata (addressLocality/Region/Country); it is read once per
    // posting and kept in the page cache, within the board's page budget, so a first fill spreads over cycles (entry.detail_places:
    // false turns it off).
    let placesLeft = 0;
    if (entry.detail_places !== false && out.length) {
      const { loadSitemapCache, saveSitemapCache, parseJobPage, pageBudget } = await import('./providers.mjs');
      const key = `sfclassic-${cfg.origin.replace(/^https:\/\//, '')}-${cfg.company}`;
      const cache = loadSitemapCache(key), keep = {}, budget = pageBudget(entry, t0);
      let dirty = false;
      for (const j of out) {
        let c = cache[j.url];
        if (!c && !budget.spent()) {
          try {
            const res = await fetch(j.url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(budget.pageTimeout(15000)) });
            if (res.ok) { const p = parseJobPage(await res.text(), j.url); c = { location: p?.location ?? '', postedAt: p?.postedAt ?? '' }; dirty = true; }
          } catch { /* next cycle */ }
          await sleep(PAGE_DELAY_MS);
        }
        if (!c) { placesLeft++; continue; }
        keep[j.url] = c;
        j.location = c.location || j.location;
        if (!j.postedAt && c.postedAt) j.postedAt = c.postedAt;
      }
      if (dirty || Object.keys(keep).length !== Object.keys(cache).length) saveSitemapCache(key, keep);
    }
    if (placesLeft && complete) Object.defineProperty(out, 'incomplete', { value: { left: placesLeft, note: `${placesLeft} posting pages left to read for places` }, enumerable: false });
    if (!complete) Object.defineProperty(out, 'incomplete', { value: { left: 0, note: `page stop: ${maxPages} pages read` }, enumerable: false });
    return out;
  },
};
