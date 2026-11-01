// EURES (the European Employment Services portal, run by the European Labour Authority) as a job source. The portal
// https://europa.eu/eures/portal/ is an Angular app; this provider calls the backend that app calls, anonymously:
//   POST https://europa.eu/eures/api/jv-searchengine/public/jv-search/search   (50 per page at most; more answers HTTP 400)
//   GET  https://europa.eu/eures/api/jv-searchengine/public/jv/id/<id>?requestLang=en   (fetchDescription: one vacancy in full)
// The endpoints are undocumented and may change without notice: treat every failure here as "EURES changed", not as a bug in a
// profile. What was observed, the request/response schema and the code lists are in docs/sources/eures-api.md (2026-11-01).
// Legal: vacancies are (c) ELA, re-use authorised with ELA acknowledged as the source (https://eures.europa.eu/legal-notice_en);
// every job carries meta.source = 'EURES (ELA)'. A profile entry: { provider: 'eures', slug: '<keyword>|<country codes>' } or a
// portal search URL as careers_url. Pages are read 1 s apart, newest first (MOST_RECENT = lastModificationDate desc), until the
// results run out, 2,000 vacancies (entry.max_jobs) or the time budget (crawl.mjs gives an entry 35 s), whichever comes first.
// EURES is an aggregator (the national public employment services feed it), so like the other aggregator providers the employer
// name gets the "(via EURES)" suffix (crosslist.mjs isAggregatorRow): an EURES copy of a role the employer lists on its own ATS is
// a cross-listing, not a second role. 'eures' is in crosslist.mjs AGGREGATOR_PROVIDERS.
//
// This module is imported by providers.mjs, so it must not import helpers back from there (an ESM cycle); it has its own
// text and meta helpers with the same rules as providers.mjs's plain() and metaOf().

import { UA } from './useragent.mjs';

export const EURES_API = 'https://europa.eu/eures/api';
export const EURES_PORTAL = 'https://europa.eu/eures/portal/jv-se';
/** The backend's page-size limit: resultsPerPage 100 answers 400 "Too many results per page were requested"; 50 works. */
export const EURES_PAGE_SIZE = 50;
export const EURES_MAX_JOBS = 2000;
/** Paging knobs; tests set the delays to 0. budgetMs stays under the 35 s crawl.mjs allows one entry. */
export const tuning = { pageDelayMs: 1000, retryDelayMs: 2000, budgetMs: 28000, timeoutMs: 25000 };

/** The 31 countries the portal covers (GET /shared-data-rest-api/public/reference/countries, 2026-11-01). EL is Greece. */
export const EURES_COUNTRIES = {
  AT: 'Austria', BE: 'Belgium', BG: 'Bulgaria', HR: 'Croatia', CY: 'Cyprus', CZ: 'Czechia', DK: 'Denmark', EE: 'Estonia', FI: 'Finland',
  FR: 'France', DE: 'Germany', EL: 'Greece', HU: 'Hungary', IS: 'Iceland', IE: 'Ireland', IT: 'Italy', LV: 'Latvia', LI: 'Liechtenstein',
  LT: 'Lithuania', LU: 'Luxembourg', MT: 'Malta', NL: 'Netherlands', NO: 'Norway', PL: 'Poland', PT: 'Portugal', RO: 'Romania',
  SK: 'Slovakia', SI: 'Slovenia', ES: 'Spain', SE: 'Sweden', CH: 'Switzerland',
};

// Request-body keys an entry may set through entry.eures (the search filters the portal's advanced form offers).
const FILTER_KEYS = ['publicationPeriod', 'positionOfferingCodes', 'positionScheduleCodes', 'sectorCodes', 'requiredLanguages', 'requiredExperienceCodes',
  'educationAndQualificationLevelCodes', 'euresFlagCodes', 'occupationUris', 'skillUris', 'minNumberPost', 'requestLanguage'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

const decode = (s = '') =>
  String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
/** HTML (the description is HTML for most vacancies, entity-escaped plain text for others) to readable plain text. */
export function euresText(html = '') {
  let s = String(html);
  if (/&lt;\/?[a-z]/i.test(s)) s = decode(s);
  s = s.replace(/<(?:br|\/p|\/li|\/h\d|\/div|\/tr)\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, ' ');
  return decode(s).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const line = (s = '') => euresText(s).replace(/\s+/g, ' ').trim();
const isoMs = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toISOString() : '');

/** Board metadata with providers.mjs's metaOf rules: empty values dropped, arrays deduplicated, single values unwrapped. */
function meta(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    const x = Array.isArray(v) ? [...new Set(v.map((e) => String(e ?? '').trim()).filter(Boolean))] : typeof v === 'boolean' ? v : String(v ?? '').trim();
    if (x === false || x === '' || (Array.isArray(x) && !x.length)) continue;
    out[k] = Array.isArray(x) && x.length === 1 ? x[0] : x;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---- slug <-> portal URL ----
// slug: "<keyword>|<lowercase country or NUTS codes, comma-separated>", e.g. "satellite|de,fr", "satellite|" (all countries), "|lu".
// The backend takes lowercase NUTS codes ("de", "de1", "de147") and "<country>-NS" for vacancies of a country without a region.
const CODE = /^[a-z]{2}(?:-NS|[a-z0-9]{1,3})?$/;

/** { keyword, codes } of a slug. Codes are lowercased ("-NS" kept upper) and deduplicated; anything that is not a country/NUTS code is dropped. */
export function parseSlug(slug = '') {
  const i = String(slug).indexOf('|');
  const keyword = (i === -1 ? String(slug) : slug.slice(0, i)).trim();
  const codes = i === -1 ? [] : [...new Set(slug.slice(i + 1).split(/[,\s]+/).map((c) => c.trim().toLowerCase().replace(/-ns$/, '-NS')).filter((c) => CODE.test(c)))];
  return { keyword, codes };
}

/** The portal search URL of a slug (the inverse of detect). */
export function euresBoardUrl(slug) {
  const { keyword, codes } = parseSlug(slug);
  const u = new URL(`${EURES_PORTAL}/search`);
  u.searchParams.set('page', '1');
  u.searchParams.set('resultsPerPage', '10');
  u.searchParams.set('orderBy', 'MOST_RECENT');
  if (keyword) u.searchParams.set('keywordsEverywhere', keyword);
  for (const c of codes) u.searchParams.append('locationCodes', c);
  u.searchParams.set('lang', 'en');
  return u.href;
}

/**
 * A tracked EURES "board" is a portal search: https://europa.eu/eures/portal/jv-se/search?keywordsEverywhere=satellite&locationCodes=de
 * (the portal's own parameters; several locationCodes repeated or comma-joined), or the short form ?keyword=satellite&location=de,fr.
 * Returns "<keyword>|<codes>", or null for anything else (other pages of the portal, a search with neither keyword nor location).
 */
export function detectEures(url = '') {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (!/^(?:www\.)?europa\.eu$/i.test(u.hostname) || !/^\/eures\/portal\/jv-se\/(?:search|advanced)\/?$/i.test(u.pathname)) return null;
  const p = u.searchParams;
  const keyword = (p.get('keywordsEverywhere') ?? p.get('keyword') ?? p.get('keywords') ?? p.get('q') ?? '').trim();
  const raw = [...p.getAll('locationCodes'), ...p.getAll('location'), ...p.getAll('locations')];
  const { codes } = parseSlug(`|${raw.join(',')}`);
  if (!keyword && !codes.length) return null;
  return `${keyword}|${codes.join(',')}`;
}

// ---- API ----

/** The search request body the portal sends, with this crawler's defaults (newest first, English labels, 50 per page). */
export function searchBody({ keyword = '', codes = [], page = 1, size = EURES_PAGE_SIZE, extra = {} } = {}) {
  const body = {
    resultsPerPage: size, page, sortSearch: 'MOST_RECENT',
    keywords: keyword ? [{ keyword, specificSearchCode: 'EVERYWHERE' }] : [],
    publicationPeriod: null, occupationUris: [], skillUris: [], requiredExperienceCodes: [], positionScheduleCodes: [], sectorCodes: [],
    educationAndQualificationLevelCodes: [], positionOfferingCodes: [], locationCodes: codes, euresFlagCodes: [], otherBenefitsCodes: [],
    requiredLanguages: [], minNumberPost: null, sessionId: 'jobcrawl', userPreferredLanguage: null, requestLanguage: 'en',
  };
  for (const k of FILTER_KEYS) if (extra && extra[k] !== undefined) body[k] = extra[k];
  body.resultsPerPage = Math.max(1, Math.min(Number(body.resultsPerPage) || EURES_PAGE_SIZE, EURES_PAGE_SIZE));
  return body;
}

/** One JSON call to the backend; a 429/5xx or network error is retried once after 2 s, other errors fail at once. */
async function api(path, body) {
  const url = `${EURES_API}${path}`;
  const init = { method: body === undefined ? 'GET' : 'POST', headers: { 'user-agent': UA, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) };
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(tuning.timeoutMs) });
    } catch (err) {
      if (attempt) throw err;
      await sleep(tuning.retryDelayMs);
      continue;
    }
    if (res.ok) return res.json();
    if (!attempt && (res.status === 429 || res.status >= 500)) { await sleep(tuning.retryDelayMs); continue; }
    let detail = '';
    try { detail = JSON.parse(await res.text()).errorMessage ?? ''; } catch { /* no JSON error body */ }
    throw new Error(`HTTP ${res.status} eures ${path}${detail ? `: ${detail}` : ''}`);
  }
}

/** ESCO occupation URIs to English labels (POST /shared-data-rest-api/public/esco/label/en). Best effort: {} when the call fails. */
async function escoLabels(uris) {
  const want = [...new Set(uris.filter((u) => /^https?:\/\/data\.europa\.eu\/esco\//.test(u)))];
  if (!want.length) return {};
  try {
    const d = await api('/shared-data-rest-api/public/esco/label/en', want);
    return d && typeof d === 'object' ? d : {};
  } catch { return {}; }
}

// ---- mapping ----

/** "Germany (DE147)" for a locationMap entry; the country name alone when the region is not given. No NUTS name list is served. */
export function euresPlace(country, region) {
  const cc = String(country ?? '').toUpperCase();
  const name = EURES_COUNTRIES[cc] ?? cc;
  const r = String(region ?? '').toUpperCase();
  return r && r !== cc && !/-NS$/.test(r) ? `${name} (${r})` : name;
}

/**
 * One vacancy of the search response -> job. labels: ESCO URI -> label (optional; URIs stay when unknown). The description in the
 * search response is the whole text (byte-identical to the detail document's); fetchDescription adds only the detail document's
 * application and contact section. The company is "<employer> (via EURES)" as the other aggregator providers suffix it,
 * "undisclosed (via EURES)" when the vacancy names none.
 */
export function euresJob(v, labels = {}) {
  const places = Object.entries(v.locationMap ?? {}).flatMap(([cc, regions]) => (Array.isArray(regions) && regions.length ? regions : [null]).map((r) => [cc, r]));
  const nuts = places.map(([cc, r]) => String(r || cc).toUpperCase());
  const offering = v.positionOfferingCode && v.positionOfferingCode !== 'NS' ? v.positionOfferingCode : '';
  const employer = line(v.employer?.name ?? '');
  return {
    id: v.id,
    title: line(v.title ?? ''),
    url: `${EURES_PORTAL}/jv-details/${encodeURIComponent(v.id ?? '')}?lang=en`,
    company: employer ? `${employer} (via EURES)` : 'undisclosed (via EURES)',
    location: [...new Set(places.map(([cc, r]) => euresPlace(cc, r)))].join(' | '),
    postedAt: isoMs(v.creationDate),
    description: euresText(v.description ?? ''),
    meta: meta({
      nuts,
      contract: offering,
      schedule: (v.positionScheduleCodes ?? []).filter((c) => c && c !== 'NS'),
      categories: (v.jobCategoriesCodes ?? []).map((u) => labels[u] || u),
      number_of_posts: v.numberOfPosts,
      languages: v.availableLanguages ?? [],
      last_modified: isoMs(v.lastModificationDate),
      eures_flag: v.euresFlag === true,
      employer_site: v.employer?.website ?? '',
      source: 'EURES (ELA)',
    }),
  };
}

// ---- detail document ----

/** The vacancy id of a job: the last path segment of its portal URL (.../jv-se/jv-details/<id>?lang=en), percent-decoded, else job.id. */
export function euresIdOf(job = {}) {
  const m = /\/jv-details\/([^/?#]+)/i.exec(String(job?.url ?? ''));
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  return String(job?.id ?? '').trim();
}

/** The profile of a detail document the portal shows: the preferred language's, else the first; null when the document has none. */
export const euresProfile = (d) => { const p = d?.jvProfiles; return p && typeof p === 'object' ? p[d.preferredLanguage] ?? Object.values(p)[0] ?? null : null; };

/**
 * One personContacts entry as "name, role, e-mail, phone, address, <other key>: <value>". The entry's shape is undocumented (the capture
 * behind the fixture had the field removed), so every string leaf is read and classified by its key name: nothing a feed publishes is dropped.
 */
export function euresContactLine(c) {
  const slots = { name: [], role: [], email: [], phone: [], address: [], other: [] };
  const walk = (v, key, depth) => {
    if (v == null || v === '' || typeof v === 'boolean') return;
    if (Array.isArray(v)) { for (const e of v) walk(e, key, depth); return; }
    if (typeof v === 'object') { if (depth < 3) for (const [k, e] of Object.entries(v)) walk(e, k, depth + 1); return; }
    const s = line(String(v));
    if (!s) return;
    const k = key.toLowerCase();
    const slot = /mail/.test(k) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? 'email' : /phone|tel|mobile|fax/.test(k) ? 'phone'
      : /name|salutation/.test(k) && !/^(?:organi[sz]ation|company|employer)/.test(k) ? 'name' : /role|title|position|function|department/.test(k) ? 'role'
      : /address|street|city|postal|zip|country/.test(k) ? 'address' : 'other';
    slots[slot].push(slot === 'other' && key ? `${key}: ${s}` : s);
  };
  walk(c, '', 0);
  const uniq = (a) => [...new Set(a)];
  return [uniq(slots.name).join(' '), ...uniq(slots.role), ...uniq(slots.email), ...uniq(slots.phone), uniq(slots.address).join(' '), ...uniq(slots.other)].filter(Boolean).join(', ');
}

/**
 * The "Application and contact" section of a detail document (GET /jv-searchengine/public/jv/id/<id>), plain text: the application
 * instructions (an <a> keeps its link as "text (url)"), one "Contact:" line per personContacts entry, the application deadline, the
 * employment period, the employer's web site and NACE class, and the locations with postal code and city. '' when the profile has none of it.
 */
export function euresDetailSection(d) {
  const p = euresProfile(d);
  if (!p) return '';
  const out = [];
  const keepLinks = (h) => String(h ?? '').replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => (text.includes(href) ? text : `${text} (${href})`));
  for (const a of list(p.applicationInstructions)) { const t = euresText(keepLinks(a)); if (t) out.push(t); }
  for (const c of list(p.personContacts)) { const t = euresContactLine(c); if (t) out.push(`Contact: ${t}`); }
  const day = (v, text) => line(text ?? '') || (Number.isFinite(Number(v)) ? isoMs(v).slice(0, 10) : line(String(v ?? '')));
  const deadline = day(p.lastApplicationDate);
  if (deadline) out.push(`Application deadline: ${deadline}`);
  const ep = p.employmentPeriod ?? {};
  const start = day(ep.startDate, ep.startDateText), end = day(ep.endDate, ep.endDateText);
  const period = [start && `from ${start}`, end && `until ${end}`, line(ep.periodDescription ?? '')].filter(Boolean).join(', ');
  if (period) out.push(`Employment period: ${period}`);
  const site = line(p.employer?.website ?? '');
  if (site) out.push(`Employer web site: ${site}`);
  const nace = list(p.employer?.sectorCodes).map((c) => line(String(c ?? ''))).filter(Boolean);
  if (nace.length) out.push(`NACE: ${nace.join(', ')}`);
  const places = list(p.locations).map((l) => [[line(l?.postalCode ?? ''), line(l?.cityName ?? '')].filter(Boolean).join(' '), euresPlace(l?.countryCode, l?.region)].filter(Boolean).join(', ')).filter(Boolean);
  if (places.length) out.push(`Location: ${[...new Set(places)].join(' | ')}`);
  return out.length ? `Application and contact\n${out.join('\n')}` : '';
}

export const eures = {
  detect: detectEures,
  /**
   * The detail document (GET /jv-searchengine/public/jv/id/<id>?requestLang=en, one request per vacancy) for what the search response does
   * not carry: the recruiting contacts and application instructions. Returns the description (byte-identical to the search response's)
   * followed by euresDetailSection(). The raw capture (rawcapture.mjs wraps global fetch) stores the detail JSON byte for byte, which is
   * the point; this text is for the saved description. When the detail call fails, the job's own description alone and no log line: the
   * callers (the crawl's lazy-JD pool, the detail backfill) count a short result as the failure.
   */
  async fetchDescription(job) {
    const own = String(job?.description ?? '');
    const id = euresIdOf(job);
    if (!id) return own;
    let d;
    try { d = await api(`/jv-searchengine/public/jv/id/${encodeURIComponent(id)}?requestLang=en`); } catch { return own; }
    const text = euresText(euresProfile(d)?.description ?? '') || own;
    return [text, euresDetailSection(d)].filter(Boolean).join('\n\n');
  },
  /**
   * slug "<keyword>|<codes>"; entry.max_jobs caps the result (default and maximum 2,000); entry.eures sets extra search filters
   * (publicationPeriod, positionOfferingCodes, sectorCodes, requiredLanguages, ...; see docs/sources/eures-api.md).
   */
  async fetch(slug, entry = {}) {
    const { keyword, codes } = parseSlug(slug);
    if (!keyword && !codes.length) throw new Error(`eures: refusing an unfiltered search; the slug is "<keyword>|<country codes>" (got "${slug}")`);
    const cap = Number.isInteger(entry.max_jobs) && entry.max_jobs > 0 ? Math.min(entry.max_jobs, EURES_MAX_JOBS) : EURES_MAX_JOBS;
    const extra = entry.eures && typeof entry.eures === 'object' ? entry.eures : {};
    const out = [], seen = new Set(), t0 = Date.now();
    for (let page = 1; out.length < cap; page++) {
      if (page > 1) { if (Date.now() - t0 > tuning.budgetMs) break; await sleep(tuning.pageDelayMs); }
      const d = await api('/jv-searchengine/public/jv-search/search', searchBody({ keyword, codes, page, extra }));
      if (!Array.isArray(d?.jvs)) throw new Error(`eures: unexpected search response (keys: ${d && typeof d === 'object' ? Object.keys(d).join(', ') : typeof d})`);
      const labels = await escoLabels(d.jvs.flatMap((v) => v?.jobCategoriesCodes ?? []));
      let fresh = 0;
      for (const v of d.jvs) {
        if (!v?.id || seen.has(v.id)) continue;
        seen.add(v.id); fresh++;
        out.push(euresJob(v, labels));
        if (out.length >= cap) break;
      }
      const total = Number.isFinite(d.numberRecords) ? d.numberRecords : Infinity;
      if (!fresh || d.jvs.length < EURES_PAGE_SIZE || out.length >= Math.min(cap, total)) break;
    }
    return out;
  },
};
