// USAJOBS Search API: US federal job announcements, read from the source (data.usajobs.gov) rather than from an aggregator.
//   API reference   https://developer.usajobs.gov/api-reference/get-api-search
//   Authentication  https://developer.usajobs.gov/Guides/Authentication   (headers Host, User-Agent = the e-mail the key was issued to, Authorization-Key)
//   Limits          https://developer.usajobs.gov/guides/rate-limiting      (500 rows per page, 10,000 rows per query)
//
// A tracked "board" is a query. Its slug is the normalised query string of the Search endpoint, e.g. "DatePosted=60&Organization=NN;CM54"
// (Organization = agency codes, semicolon list; Keyword; PositionTitle; LocationName; DatePosted = 0-60 days). detect() also reads a
// www.usajobs.gov search URL (/Search/Results?k=satellite -> Keyword=satellite). Fields=Full puts the whole announcement text into the
// search response, so there is no fetchDescription.
//
// Credentials are read from the environment at call time, USAJOBS_KEY and USAJOBS_EMAIL, and never written anywhere (the request URL
// carries no secret, so it may appear in error messages; the headers never do). Without them fetch() throws, so a misconfigured board
// fails loudly instead of reporting 0 jobs.
//
// Terms: the announcements are public data that may be copied and redistributed; attribution (USAJOBS as the source, a link to the
// announcement) is encouraged, so every job carries meta.source = 'USAJOBS' and its url is the announcement on usajobs.gov.
//
// Registered in providers.mjs from the hoisted functions usajobsDetect/usajobsFetch rather than from the `usajobs` object: this module
// imports plain() and metaOf() from providers.mjs, and function declarations exist before either module runs, so the import cycle
// resolves in any load order (the tests load this module first; crawl.mjs loads providers.mjs first).

import { metaOf, plain } from './providers.mjs';

const API = 'https://data.usajobs.gov/api/Search';
const PAGE_ROWS = 500;      // ResultsPerPage maximum
const MAX_ROWS = 10000;     // rows per query maximum
const PAGE_DELAY_MS = 1000;
const TIMEOUT_MS = 30000;
// www.usajobs.gov search parameters -> Search API parameters. Anything else of the www form (page, sort, ...) is dropped.
const WWW_PARAMS = { k: 'Keyword', l: 'LocationName', a: 'Organization', d: 'Organization', hp: 'HiringPath', rmi: 'RemoteIndicator' };
// Code tables from the API reference (the response gives codes; PositionSchedule names are often empty).
const SCHEDULE = { 1: 'Full-Time', 2: 'Part-Time', 3: 'Shift Work', 4: 'Intermittent', 5: 'Job Sharing', 6: 'Multiple Schedules' };
const TRAVEL = { 0: 'Not Required', 1: 'Occasional Travel', 2: '25% or Less', 5: '50% or Less', 7: '75% or Less', 8: '76% or Greater' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v) => (v == null ? '' : String(v).trim());
const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const uniq = (a) => [...new Set(a.filter(Boolean))];
const bool = (v) => v === true || /^true$/i.test(str(v));
/** The API's own list separator stays readable in slugs and URLs; everything else is percent-encoded. */
const enc = (v) => encodeURIComponent(v).replace(/%3B/gi, ';').replace(/%2C/gi, ',');
/** USAJOBS dates are "2026-10-19T12:56:14.5100" (no zone), elsewhere "10/19/2026 12:56:14" (US order): the day only, never a guessed zone. */
const usDate = (raw) => {
  const s = str(raw);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return s && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '';
};
/** PositionURI/ApplyURI come as https://www.usajobs.gov:443/job/<id>; the URL class drops the default port. */
const canonUrl = (u) => { try { return new URL(str(u)).href; } catch { return str(u); } };
/** Names of {Name, Code} entries; a code is translated through the table when the name is empty, otherwise dropped. */
const named = (entries, table = {}) => uniq(list(entries).map((e) => str(e?.Name) || table[str(e?.Code)] || ''));

/**
 * Query pairs -> canonical slug pairs: trimmed, empty values and Page dropped (fetch() pages itself), repeated names merged into the
 * API's semicolon list, sorted by name so the same query always gives the same slug.
 */
function canonPairs(pairs) {
  const merged = new Map();
  for (const [k, v] of pairs) {
    const name = str(k), value = str(v);
    if (!name || !value || name.toLowerCase() === 'page') continue;
    const prev = merged.get(name);
    merged.set(name, prev && prev !== value ? `${prev};${value}` : value);
  }
  return [...merged].sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
const slugOf = (pairs) => pairs.map(([k, v]) => `${k}=${enc(v)}`).join('&');
const pairsOf = (slug) => canonPairs([...new URLSearchParams(str(slug).replace(/^\?/, ''))]);

/**
 * A Search API URL (https://data.usajobs.gov/api/Search?Organization=NN;CM54&DatePosted=60) or a www search
 * (https://www.usajobs.gov/Search/Results?k=satellite) -> the query slug; null for anything else, including a query without parameters
 * (all of USAJOBS is not a board) and a single announcement (/job/<id>).
 */
export function usajobsDetect(url) {
  let u;
  try { u = new URL(String(url ?? '')); } catch { return null; }
  const host = u.hostname.toLowerCase();
  let pairs;
  if (host === 'data.usajobs.gov' && /^\/api\/search\/?$/i.test(u.pathname)) pairs = [...u.searchParams];
  else if (/^(www\.)?usajobs\.gov$/.test(host) && /^\/search(\/results)?\/?$/i.test(u.pathname)) {
    pairs = [...u.searchParams].flatMap(([k, v]) => (WWW_PARAMS[k.toLowerCase()] ? [[WWW_PARAMS[k.toLowerCase()], v]] : []));
  } else return null;
  return slugOf(canonPairs(pairs)) || null;
}

async function api(pairs, key, email) {
  const url = `${API}?${slugOf(pairs)}`;
  const res = await fetch(url, {
    headers: { host: 'data.usajobs.gov', 'user-agent': email, 'authorization-key': key, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

/**
 * Every announcement of the query: pages of 500 (ResultsPerPage=500, Fields=Full and SortField=opendate are added unless the slug sets
 * them) until SearchResultCountAll rows, or the API's 10,000-row ceiling, are fetched, one second between pages. Each page's items go
 * through usajobsJob(). Note crawl.mjs gives an entry 35 s: keep a board to a few pages (one agency, DatePosted=60) rather than all of USAJOBS.
 */
export async function usajobsFetch(slug) {
  const key = process.env.USAJOBS_KEY, email = process.env.USAJOBS_EMAIL;
  if (!key || !email) throw new Error('usajobs: USAJOBS_KEY and USAJOBS_EMAIL must be set');
  const params = pairsOf(slug);
  if (!params.length) throw new Error(`usajobs: the slug must be a Search query, e.g. "Organization=NN&DatePosted=60" (got "${slug}")`);
  const given = new Set(params.map(([k]) => k.toLowerCase()));
  for (const [k, v] of [['ResultsPerPage', String(PAGE_ROWS)], ['Fields', 'Full'], ['SortField', 'opendate']]) if (!given.has(k.toLowerCase())) params.push([k, v]);
  const out = [], seen = new Set();
  let fetched = 0;
  for (let page = 1; ; page++) {
    if (page > 1) await sleep(PAGE_DELAY_MS);
    const d = await api([...params, ['Page', String(page)]], key, email);
    const items = d?.SearchResult?.SearchResultItems;
    if (!Array.isArray(items)) throw new Error(`usajobs: unexpected response (keys: ${d && typeof d === 'object' ? Object.keys(d).join(', ') : typeof d})`);
    const total = Math.min(Number(d.SearchResult.SearchResultCountAll) || 0, MAX_ROWS);
    fetched += items.length;
    for (const item of items) {
      const j = usajobsJob(item);
      if (j.title && j.url && !seen.has(j.url)) { seen.add(j.url); out.push(j); }
    }
    if (!items.length || fetched >= total) break;
  }
  return out;
}

/**
 * One SearchResultItems[] entry (Fields=Full) -> the crawler's job shape. company is the hiring organisation (OrganizationName; the
 * department, e.g. NASA, is meta.department); location is every PositionLocation joined with ' | ', plus 'Remote' when the
 * announcement is remote; description is the announcement's own sections under plain headings (Summary, Duties, Requirements,
 * Qualifications, Education), HTML removed if a section carries any.
 */
export function usajobsJob(item) {
  const d = item?.MatchedObjectDescriptor ?? {};
  const u = d.UserArea?.Details ?? {};
  const location = uniq(list(d.PositionLocation).map((l) => str(l?.LocationName)));
  if (bool(u.RemoteIndicator)) location.push('Remote');
  const duties = list(u.MajorDuties).map((x) => plain(str(x))).filter(Boolean);
  const section = (heading, text) => (text ? `${heading}\n${text}` : '');
  const description = [
    section('Summary', plain(str(u.JobSummary))),
    section('Duties', duties.length > 1 ? duties.map((x) => `- ${x}`).join('\n') : duties[0] ?? ''),
    section('Requirements', plain(str(u.Requirements))),
    section('Qualifications', plain(str(d.QualificationSummary))),
    section('Education', plain(str(u.Education))),
  ].filter(Boolean).join('\n\n');
  const plans = uniq(list(d.JobGrade).map((g) => str(g?.Code))).join('/');
  const low = str(u.LowGrade), high = str(u.HighGrade);
  const span = low && high && low !== high ? `${low}-${high}` : low || high;
  const pay = list(d.PositionRemuneration)[0] ?? {};
  const categories = list(d.JobCategory);
  return {
    id: str(item?.MatchedObjectId) || str(d.PositionID),
    title: str(d.PositionTitle),
    url: canonUrl(d.PositionURI),
    company: str(d.OrganizationName),
    location: location.join(' | '),
    postedAt: usDate(d.PublicationStartDate),
    description,
    meta: metaOf({
      department: d.DepartmentName,
      grade: [plans, span].filter(Boolean).join(' '),
      pay_min: pay.MinimumRange,
      pay_max: pay.MaximumRange,
      pay_interval: pay.RateIntervalCode,
      close_date: usDate(d.ApplicationCloseDate),
      schedule: named(d.PositionSchedule, SCHEDULE),
      offering: named(d.PositionOfferingType),
      clearance: u.SecurityClearance,
      telework: bool(u.TeleworkEligible),
      remote: bool(u.RemoteIndicator),
      travel: TRAVEL[str(u.TravelCode)] ?? str(u.TravelCode),
      category: categories.map((c) => str(c?.Name)),
      category_code: categories.map((c) => str(c?.Code)),
      org_code: u.OrganizationCodes,
      apply_url: canonUrl(list(d.ApplyURI)[0]),
      source: 'USAJOBS',
    }),
  };
}

export const usajobs = { detect: usajobsDetect, fetch: usajobsFetch };
