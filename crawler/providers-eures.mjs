// EURES (the European Employment Services portal, run by the European Labour Authority) as a job source. The portal
// https://europa.eu/eures/portal/ is an Angular app; this provider calls the backend that app calls, anonymously:
//   POST https://europa.eu/eures/api/jv-searchengine/public/jv-search/search   (50 per page at most; more answers HTTP 400)
//   GET  https://europa.eu/eures/api/jv-searchengine/public/jv/id/<id>?requestLang=en   (fetchDescription: one vacancy in full)
// The endpoints are undocumented and may change without notice: treat every failure here as "EURES changed", not as a bug in a
// profile. What was observed, the request/response schema and the code lists are in docs/sources/eures-api.md (2026-11-01).
// Legal: vacancies are (c) ELA, re-use authorised with ELA acknowledged as the source (https://eures.europa.eu/legal-notice_en);
// every job carries meta.source = 'EURES (ELA)'. A profile entry: { provider: 'eures', slug: '<keyword>|<country codes>' } or a
// portal search URL as careers_url. Pages are read newest first (MOST_RECENT = lastModificationDate desc), until the results run
// out, 2,000 vacancies (entry.max_jobs) or the time budget (crawl.mjs gives an entry 35 s), whichever comes first.
// Politeness: the crawl runs several boards at once (crawl.mjs CONCURRENCY) and hundreds of them are EURES boards, so pacing per
// board is not enough. Every request this module makes (search pages, the detail call, the ESCO label call) passes through one
// host-wide limiter (euresLimiter): at most one request starts per EURES_MIN_GAP_MS (default 1000 ms) in the whole process, however
// many boards call at once. A 429 is retried once after its Retry-After (else 10 s, capped at 60 s) and doubles the gap for 60 s.
// Across processes (the crawl and crawler/eures-employer-detail.mjs may call EURES at the same time): when a rate file is set
// (setEuresRateFile(<data>/eures-rate.json), crawl.mjs and the sweep set it in the same data directory), every slot is also claimed
// in that file, so the gap holds for all processes together (claimSharedSlot).
// Employer mode (slug 'employer:<name>|<codes>', one board per tracked EEA employer, eures-employer-boards.mjs writes them) collects
// the EURES copies of an employer's own postings for the cross-listing and their richer metadata: the name goes to the backend as
// specificSearchCode EMPLOYER, which is a FUZZY full-text match ("OHB" also finds every "oHG"; probe 2026-11-01 in eures-api.md), so
// that mode sorts BEST_MATCH (the exact employer comes first), keeps only vacancies whose employer name contains the searched name as
// whole words (euresEmployerMatches) and stops at the first page without one. 'legalid:<id>|<codes>' sends LEGAL_ID the same way.
// EURES is an aggregator (the national public employment services feed it), so like the other aggregator providers the employer
// name gets the "(via EURES)" suffix (crosslist.mjs isAggregatorRow): an EURES copy of a role the employer lists on its own ATS is
// a cross-listing, not a second role. 'eures' is in crosslist.mjs AGGREGATOR_PROVIDERS.
//
// This module is imported by providers.mjs, so it must not import helpers back from there (an ESM cycle); it has its own
// text and meta helpers with the same rules as providers.mjs's plain() and metaOf().

import { openSync, closeSync, writeSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { UA } from './useragent.mjs';

export const EURES_API = 'https://europa.eu/eures/api';
export const EURES_PORTAL = 'https://europa.eu/eures/portal/jv-se';
/** The backend's page-size limit: resultsPerPage 100 answers 400 "Too many results per page were requested"; 50 works. */
export const EURES_PAGE_SIZE = 50;
export const EURES_MAX_JOBS = 2000;
/**
 * Knobs; tests set the delays to 0. minGapMs is the host-wide gap between two request starts (EURES_MIN_GAP_MS, read once at load);
 * retryDelayMs the pause before the one retry on a 5xx or network error; retry429Ms the pause before the one retry on a 429 without a
 * usable Retry-After, retryAfterCapMs the most a Retry-After is honoured for, backoffWindowMs how long the gap stays doubled after a
 * 429. budgetMs stays under the 35 s crawl.mjs allows one entry.
 */
export const tuning = {
  minGapMs: (() => { const n = Number(process.env.EURES_MIN_GAP_MS); return process.env.EURES_MIN_GAP_MS !== undefined && Number.isFinite(n) && n >= 0 ? n : 1000; })(),
  retryDelayMs: 2000, retry429Ms: 10000, retryAfterCapMs: 60000, backoffWindowMs: 60000, budgetMs: 28000, timeoutMs: 25000,
};

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

/**
 * The host-wide request gate: one shared queue for every request of this module, whatever board makes it. acquire() resolves when the
 * caller may start its request: slots are handed out in call order, each at least gap() after the previous one (a promise chain plus a
 * timestamp, no polling). gap() is tuning.minGapMs, doubled while a 429 backoff is in force (backOff() arms it for tuning.backoffWindowMs).
 * Exported for the tests and the crawl's diagnostics; nextAt / backoffUntil are epoch ms.
 */
export const euresLimiter = {
  nextAt: 0,
  backoffUntil: 0,
  chain: Promise.resolve(),
  gap() { return Date.now() < this.backoffUntil ? tuning.minGapMs * 2 : tuning.minGapMs; },
  acquire() {
    const turn = this.chain.then(async () => {
      for (let wait = this.nextAt - Date.now(); wait > 0; wait = this.nextAt - Date.now()) await sleep(wait);   // the loop covers an early timer
      if (rateFile) {
        const at = await claimSharedSlot(rateFile, this.gap());
        for (let wait = at - Date.now(); wait > 0; wait = at - Date.now()) await sleep(wait);
      }
      this.nextAt = Date.now() + this.gap();
    });
    this.chain = turn.catch(() => {});
    return turn;
  },
  backOff() { this.backoffUntil = Date.now() + tuning.backoffWindowMs; },
  reset() { this.nextAt = 0; this.backoffUntil = 0; },
};

let rateFile = null;
/** Share the host-wide gap with other processes through this file (null: this process only). The file's directory must exist. */
export function setEuresRateFile(file) { rateFile = file || null; }
const MUTEX_STALE_MS = 10000;

/**
 * Claims the next free request slot in a rate file shared by several processes, gap ms after the previous claim of any of them, and
 * returns its start time (epoch ms; the caller sleeps until then). The file holds {nextAt, pid}: the earliest start the next claimer
 * may take. It is read and rewritten under a mutex, <file>.lock, created with the exclusive flag (atomic on Windows and POSIX) and
 * removed straight after, so it is held for a millisecond, never while waiting for the slot. A mutex older than 10 s belongs to a
 * crashed process and is removed. Slots are reserved ahead: two processes asking at once get slots one gap apart, not the same one.
 * On an unreadable file the claim counts from now. Errors other than a held mutex (a missing directory, a full disk) fall back to
 * now: the in-process limiter still holds.
 */
export async function claimSharedSlot(file, gap, now = () => Date.now()) {
  const mutex = `${file}.lock`;
  for (let spins = 0; ; spins++) {
    let fd;
    try { fd = openSync(mutex, 'wx'); } catch (e) {
      if (e.code !== 'EEXIST') return now();
      try { if (now() - statSync(mutex).mtimeMs > MUTEX_STALE_MS) unlinkSync(mutex); } catch { /* gone meanwhile */ }
      await sleep(5 + (spins % 10));
      continue;
    }
    try {
      writeSync(fd, String(process.pid));
      let nextAt = 0;
      try { nextAt = Number(JSON.parse(readFileSync(file, 'utf8')).nextAt) || 0; } catch { /* first claim or unreadable */ }
      const at = Math.max(now(), nextAt);
      writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify({ nextAt: at + gap, pid: process.pid }));
      renameSync(`${file}.${process.pid}.tmp`, file);
      return at;
    } catch { return now(); } finally {
      try { closeSync(fd); } catch { /* closed */ }
      try { unlinkSync(mutex); } catch { /* removed as stale by another process */ }
    }
  }
}

/**
 * How long a 429 asks us to wait, in ms: its Retry-After as delay-seconds or an HTTP date (RFC 9110), capped at tuning.retryAfterCapMs;
 * tuning.retry429Ms when the header is missing or unreadable; never negative.
 */
export function retryAfterMs(header, now = Date.now()) {
  const h = String(header ?? '').trim();
  let ms = NaN;
  if (/^\d+$/.test(h)) ms = Number(h) * 1000;
  else if (h) { const t = Date.parse(h); if (Number.isFinite(t)) ms = t - now; }
  if (!Number.isFinite(ms)) ms = tuning.retry429Ms;
  return Math.max(0, Math.min(ms, tuning.retryAfterCapMs));
}

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
// Two more modes, told apart by a prefix on the keyword part: "employer:<name>|<codes>" searches the employer name only
// (specificSearchCode EMPLOYER) and "legalid:<id>|<codes>" the employer's legal id (LEGAL_ID). A keyword that itself starts with
// "employer:" or "legalid:" cannot be searched in keyword mode.
const CODE = /^[a-z]{2}(?:-NS|[a-z0-9]{1,3})?$/;
const MODE_PREFIX = /^(employer|legal[-_]?id):\s*/i;
/** The slug prefix of each search mode; the mode of a slug without one is EVERYWHERE (the keyword mode). */
export const SLUG_PREFIX = { EVERYWHERE: '', EMPLOYER: 'employer:', LEGAL_ID: 'legalid:' };
/** The portal URL parameter that carries the keyword of each mode (keywordsEverywhere is the portal's own; the other two are this crawler's, see detectEures). */
const URL_PARAM = { EVERYWHERE: 'keywordsEverywhere', EMPLOYER: 'keywordsEmployer', LEGAL_ID: 'keywordsLegalId' };

/**
 * { keyword, codes, mode } of a slug. mode is 'EVERYWHERE' (keyword mode), 'EMPLOYER' or 'LEGAL_ID' (the specificSearchCode sent); the
 * prefix is removed from the keyword. Codes are lowercased ("-NS" kept upper) and deduplicated; anything that is not a country/NUTS code is dropped.
 */
export function parseSlug(slug = '') {
  const i = String(slug).indexOf('|');
  let keyword = (i === -1 ? String(slug) : slug.slice(0, i)).trim();
  let mode = 'EVERYWHERE';
  const m = MODE_PREFIX.exec(keyword);
  if (m) { mode = m[1].toLowerCase().startsWith('employer') ? 'EMPLOYER' : 'LEGAL_ID'; keyword = keyword.slice(m[0].length).trim(); }
  const codes = i === -1 ? [] : [...new Set(slug.slice(i + 1).split(/[,\s]+/).map((c) => c.trim().toLowerCase().replace(/-ns$/, '-NS')).filter((c) => CODE.test(c)))];
  return { keyword, codes, mode };
}

/** The portal search URL of a slug (the inverse of detect): keywordsEverywhere, keywordsEmployer or keywordsLegalId by mode. */
export function euresBoardUrl(slug) {
  const { keyword, codes, mode } = parseSlug(slug);
  const u = new URL(`${EURES_PORTAL}/search`);
  u.searchParams.set('page', '1');
  u.searchParams.set('resultsPerPage', '10');
  u.searchParams.set('orderBy', mode === 'EVERYWHERE' ? 'MOST_RECENT' : 'BEST_MATCH');
  if (keyword) u.searchParams.set(URL_PARAM[mode], keyword);
  for (const c of codes) u.searchParams.append('locationCodes', c);
  u.searchParams.set('lang', 'en');
  return u.href;
}

/**
 * A tracked EURES "board" is a portal search: https://europa.eu/eures/portal/jv-se/search?keywordsEverywhere=satellite&locationCodes=de
 * (the portal's own parameters; several locationCodes repeated or comma-joined), or the short form ?keyword=satellite&location=de,fr.
 * Employer mode: ?keywordsEmployer=<name> or the short form ?employer=<name>; legal-id mode: ?keywordsLegalId=<id> or ?legalId=<id>
 * (this crawler's parameter names, modelled on keywordsEverywhere; the portal's advanced form has the fields but their URL parameters
 * were not verified). One keyword per board: an employer parameter wins over a legal id, which wins over an everywhere keyword.
 * Returns "<keyword>|<codes>", "employer:<name>|<codes>" or "legalid:<id>|<codes>", or null for anything else (other pages of the
 * portal, a search with neither keyword nor location).
 */
export function detectEures(url = '') {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (!/^(?:www\.)?europa\.eu$/i.test(u.hostname) || !/^\/eures\/portal\/jv-se\/(?:search|advanced)\/?$/i.test(u.pathname)) return null;
  const p = u.searchParams;
  const employer = (p.get('keywordsEmployer') ?? p.get('employer') ?? '').trim();
  const legalId = (p.get('keywordsLegalId') ?? p.get('legalId') ?? p.get('legalid') ?? '').trim();
  const everywhere = (p.get('keywordsEverywhere') ?? p.get('keyword') ?? p.get('keywords') ?? p.get('q') ?? '').trim();
  const mode = employer ? 'EMPLOYER' : legalId ? 'LEGAL_ID' : 'EVERYWHERE';
  const keyword = employer || legalId || everywhere;
  const raw = [...p.getAll('locationCodes'), ...p.getAll('location'), ...p.getAll('locations')];
  const { codes } = parseSlug(`|${raw.join(',')}`);
  if (!keyword && !codes.length) return null;
  return `${SLUG_PREFIX[mode]}${keyword}|${codes.join(',')}`;
}

/**
 * Does an employer name the backend returned belong to the employer searched for? The searched name's words must appear in the
 * returned name as whole words, in order and adjacent: "OHB System" matches "OHB-System AG" and "OHB System AG", not "OHB Digital
 * Connect GmbH"; "OHB" matches all three, not "K2Trans OHG". Case, diacritics (ü = ue) and punctuation do not count, and the
 * connectors "and"/"und"/"&" are ignored on both sides ("Airbus Defence and Space" = "Airbus Defence & Space"). Needed because the
 * backend's EMPLOYER search is fuzzy (eures-api.md).
 */
export function euresEmployerMatches(searched, actual) {
  const want = nameTokens(searched), have = nameTokens(actual);
  if (!want.length || want.length > have.length) return false;
  for (let i = 0; i + want.length <= have.length; i++) {
    let j = 0;
    while (j < want.length && have[i + j] === want[j]) j++;
    if (j === want.length) return true;
  }
  return false;
}
const CONNECTORS = new Set(['and', 'und', 'et', 'en']);
const UMLAUTS = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' };
/** The words of an employer name as euresEmployerMatches compares them (lowercase, umlauts spelled out, diacritics and connectors dropped). */
export function nameTokens(s) {
  return String(s ?? '').toLowerCase().replace(/[äöüß]/g, (c) => UMLAUTS[c]).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !CONNECTORS.has(w));
}

// ---- API ----

/**
 * The search request body the portal sends, with this crawler's defaults (English labels, 50 per page). mode is the specificSearchCode
 * of the keyword: 'EVERYWHERE' (default; sorted newest first) or 'EMPLOYER' / 'LEGAL_ID' (sorted BEST_MATCH, so the exact employer comes
 * before the fuzzy matches). Anything else falls back to EVERYWHERE.
 */
export function searchBody({ keyword = '', codes = [], page = 1, size = EURES_PAGE_SIZE, extra = {}, mode = 'EVERYWHERE' } = {}) {
  const code = Object.hasOwn(SLUG_PREFIX, mode) ? mode : 'EVERYWHERE';
  const body = {
    resultsPerPage: size, page, sortSearch: code === 'EVERYWHERE' ? 'MOST_RECENT' : 'BEST_MATCH',
    keywords: keyword ? [{ keyword, specificSearchCode: code }] : [],
    publicationPeriod: null, occupationUris: [], skillUris: [], requiredExperienceCodes: [], positionScheduleCodes: [], sectorCodes: [],
    educationAndQualificationLevelCodes: [], positionOfferingCodes: [], locationCodes: codes, euresFlagCodes: [], otherBenefitsCodes: [],
    requiredLanguages: [], minNumberPost: null, sessionId: 'jobcrawl', userPreferredLanguage: null, requestLanguage: 'en',
  };
  for (const k of FILTER_KEYS) if (extra && extra[k] !== undefined) body[k] = extra[k];
  body.resultsPerPage = Math.max(1, Math.min(Number(body.resultsPerPage) || EURES_PAGE_SIZE, EURES_PAGE_SIZE));
  return body;
}

/**
 * One JSON call to the backend, through the host-wide limiter (every attempt takes a slot). A 5xx or network error is retried once after
 * 2 s; a 429 arms the limiter's backoff and is retried once after its Retry-After (retryAfterMs); other errors fail at once.
 */
async function api(path, body) {
  const url = `${EURES_API}${path}`;
  const init = { method: body === undefined ? 'GET' : 'POST', headers: { 'user-agent': UA, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) };
  for (let attempt = 0; ; attempt++) {
    await euresLimiter.acquire();
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(tuning.timeoutMs) });
    } catch (err) {
      if (attempt) throw err;
      await sleep(tuning.retryDelayMs);
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 429) euresLimiter.backOff();
    if (!attempt && res.status === 429) { await sleep(retryAfterMs(res.headers.get('retry-after'))); continue; }
    if (!attempt && res.status >= 500) { await sleep(tuning.retryDelayMs); continue; }
    let detail = '';
    try { detail = JSON.parse(await res.text()).errorMessage ?? ''; } catch { /* no JSON error body */ }
    throw new Error(`HTTP ${res.status} eures ${path}${detail ? `: ${detail}` : ''}`);
  }
}

/**
 * The detail document of one vacancy (GET /jv-searchengine/public/jv/id/<id>?requestLang=en), parsed, through the host-wide limiter with
 * its retries; throws "HTTP <status> eures ..." on failure (a vacancy no longer published answers 404). The raw capture stores the body.
 */
export function euresDetail(id) {
  return api(`/jv-searchengine/public/jv/id/${encodeURIComponent(id)}?requestLang=en`);
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
    try { d = await euresDetail(id); } catch { return own; }
    const text = euresText(euresProfile(d)?.description ?? '') || own;
    return [text, euresDetailSection(d)].filter(Boolean).join('\n\n');
  },
  /**
   * slug "<keyword>|<codes>", "employer:<name>|<codes>" or "legalid:<id>|<codes>"; entry.max_jobs caps the result (default and maximum
   * 2,000); entry.eures sets extra search filters (publicationPeriod, positionOfferingCodes, sectorCodes, requiredLanguages, ...; see
   * docs/sources/eures-api.md). Employer mode keeps only the vacancies whose employer name matches (euresEmployerMatches) and stops at the
   * first page that holds none: the BEST_MATCH order puts the exact employer first and the fuzzy rest (thousands for a short name) after it.
   */
  async fetch(slug, entry = {}) {
    const { keyword, codes, mode } = parseSlug(slug);
    if (mode !== 'EVERYWHERE' && !keyword) throw new Error(`eures: ${SLUG_PREFIX[mode]} mode needs a name; the slug is "${SLUG_PREFIX[mode]}<name>|<country codes>" (got "${slug}")`);
    if (!keyword && !codes.length) throw new Error(`eures: refusing an unfiltered search; the slug is "<keyword>|<country codes>" (got "${slug}")`);
    const cap = Number.isInteger(entry.max_jobs) && entry.max_jobs > 0 ? Math.min(entry.max_jobs, EURES_MAX_JOBS) : EURES_MAX_JOBS;
    const extra = entry.eures && typeof entry.eures === 'object' ? entry.eures : {};
    const keep = mode === 'EMPLOYER' ? (v) => euresEmployerMatches(keyword, v.employer?.name) : () => true;
    const out = [], seen = new Set(), t0 = Date.now();
    for (let page = 1; out.length < cap; page++) {
      if (page > 1 && Date.now() - t0 > tuning.budgetMs) break;   // the pacing between pages is the host-wide limiter's (api)
      const d = await api('/jv-searchengine/public/jv-search/search', searchBody({ keyword, codes, page, extra, mode }));
      if (!Array.isArray(d?.jvs)) throw new Error(`eures: unexpected search response (keys: ${d && typeof d === 'object' ? Object.keys(d).join(', ') : typeof d})`);
      const picked = [];
      let fresh = 0;
      for (const v of d.jvs) {
        if (!v?.id || seen.has(v.id)) continue;
        seen.add(v.id); fresh++;
        if (keep(v)) picked.push(v);
      }
      const labels = picked.length ? await escoLabels(picked.flatMap((v) => v.jobCategoriesCodes ?? [])) : {};
      for (const v of picked) {
        out.push(euresJob(v, labels));
        if (out.length >= cap) break;
      }
      const total = Number.isFinite(d.numberRecords) ? d.numberRecords : Infinity;
      if (!fresh || d.jvs.length < EURES_PAGE_SIZE || out.length >= Math.min(cap, total)) break;
      if (mode === 'EMPLOYER' && !picked.length) break;   // past the exact matches: the rest of the fuzzy result is other employers
    }
    return out;
  },
};
