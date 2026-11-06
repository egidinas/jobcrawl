// Two config-driven providers for boards without an ATS, merged into the registry by providers.mjs (after the built-ins, never
// overriding one). Both are explicit (`detect()` never matches): the entry names the provider and carries the configuration.
//
//   paginated_list   A list endpoint walked page by page: JSON (items at a dot path, fields at dot paths) or HTML (items by one
//                    regular expression, fields by one capture group each). For multi-employer boards and company sites with a
//                    search page. Config in entry.list, documented at `paginatedListConfig` below.
//   jsonld_direct    A company careers page: collect the posting links of the list page(s) (or of a job sitemap), fetch each posting
//                    once (cached by URL with a TTL) and read its schema.org JobPosting JSON-LD (title, location, date, description,
//                    hiring organisation). Config in the entry: slug = the list URL, optional pages, job_url_pattern, sitemap, max_jobs.
//
// The pure pieces (jsonPath, itemsOf, fieldsOf, jobLinks, jobsFromJsonLd) are exported so the tests run them on captured documents.
import { UA } from './useragent.mjs';
import { parseJobPage, loadSitemapCache, saveSitemapCache, robotsDisallow, plain } from './providers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s = '') => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
const text = (s = '') => decode(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const num = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt);
const isoDate = (raw = '') => {
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);   // "October 29, 2026" parses as local midnight: format the local date, not the UTC one
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function fetchText(url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  const res = await fetch(url, { method, headers: { 'user-agent': UA, accept: 'application/json, text/html;q=0.9, */*;q=0.8', ...headers }, body, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

/** obj at a dot path ("data.jobs", "items.0.title", "locations.*.city" joins every element). */
export function jsonPath(obj, path) {
  if (path == null || path === '') return obj;
  let cur = [obj];
  for (const key of String(path).split('.')) {
    const next = [];
    for (const c of cur) {
      if (c == null) continue;
      if (key === '*') { if (Array.isArray(c)) next.push(...c); else if (typeof c === 'object') next.push(...Object.values(c)); }
      else next.push(c[key]);
    }
    cur = next;
  }
  if (cur.length === 1) return cur[0];
  const vals = cur.filter((v) => v != null);
  return vals.length ? vals : undefined;
}
const str = (v) => (v == null ? '' : Array.isArray(v) ? v.map(str).filter(Boolean).join(', ') : typeof v === 'object' ? str(v.name ?? v.label ?? v.title ?? v.value ?? v.text ?? v.city ?? '') : String(v));

/** The items of one page: JSON (array at list.items, or the first array found) or HTML (every match of the list.items regex). */
export function itemsOf(body, list) {
  if (list.kind === 'json') {
    let data;
    try { data = JSON.parse(body); } catch { throw new Error('paginated_list: the page is not JSON'); }
    const arr = list.items ? jsonPath(data, list.items) : (Array.isArray(data) ? data : Object.values(data).find(Array.isArray));
    return { items: Array.isArray(arr) ? arr : [], total: list.total ? Number(jsonPath(data, list.total)) || 0 : 0 };
  }
  const re = new RegExp(list.items, 'gs');
  return { items: [...body.matchAll(re)].map((m) => m[0]), total: 0 };
}

/** One item -> job fields. JSON: dot paths. HTML: regexes with one capture group (first match), applied to the item text. */
export function fieldsOf(item, list) {
  const f = list.fields ?? {};
  const pick = (name) => {
    const spec = f[name];
    if (!spec) return '';
    if (list.kind === 'json') return str(jsonPath(item, spec));
    const m = item.match(new RegExp(spec, 's'));
    return m ? text(m[1] ?? m[0]) : '';
  };
  let url = pick('url');
  if (!url && list.kind === 'html') url = text(item.match(/href="([^"]+)"/)?.[1] ?? '');
  if (url && list.url_base) { try { url = new URL(decode(url), list.url_base).href; } catch { url = ''; } }
  const title = pick('title') || (list.kind === 'json' ? '' : text(item.match(/<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? ''));
  const out = { title: text(title), url, location: pick('location'), department: pick('department'), postedAt: isoDate(pick('postedAt')) };
  const desc = pick('description'); if (desc) out.description = list.kind === 'json' ? plain(desc) : desc;
  const company = pick('company'); if (company) out.company = list.company_suffix ? `${company} ${list.company_suffix}` : company;
  return out;
}

/** The posting links of a list page: absolute, on the page's host (or list of hosts), matching pattern, not the page itself. */
export function jobLinks(html, pageUrl, pattern, hosts) {
  const base = new URL(pageUrl);
  const allow = new Set([base.host, ...(hosts ?? [])]);
  const out = new Set();
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    let u;
    try { u = new URL(decode(m[1]), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || !allow.has(u.host)) continue;
    u.hash = '';
    const s = u.href;
    if (s === base.href || s === pageUrl) continue;
    if (pattern.test(u.pathname + u.search)) out.add(s);
  }
  return [...out];
}

/** Every JobPosting in a page's JSON-LD (a single node, @graph, or an ItemList of postings) -> jobs with a URL. */
export function jobsFromJsonLd(html, pageUrl) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const nodes = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      if ([].concat(n['@type'] ?? []).includes('JobPosting')) nodes.push(n);
      for (const k of ['@graph', 'itemListElement', 'item', 'mainEntity']) if (n[k]) walk(n[k]);
    };
    walk(data);
    for (const jp of nodes) {
      const url = jp.url ?? jp.sameAs ?? jp['@id'] ?? '';
      if (!url || !/^https?:/.test(url)) continue;
      const loc = [].concat(jp.jobLocation ?? []).map((l) => [l.address?.addressLocality, l.address?.addressCountry?.name ?? l.address?.addressCountry].filter(Boolean).join(', ')).filter(Boolean).join(' | ');
      const org = [].concat(jp.hiringOrganization ?? []).map((o) => (typeof o === 'string' ? o : o?.name ?? '')).find(Boolean) ?? '';
      out.push({ title: text(jp.title ?? ''), url, location: loc, department: '', postedAt: isoDate(jp.datePosted ?? ''), description: plain(jp.description ?? ''), ...(org ? { organization: text(org) } : {}) });
    }
  }
  return out.filter((j) => j.title);
}

const DEFAULT_JOB_PATTERN = /(?:^|\/)(?:jobs?|stellen(?:angebot|anzeige)?e?n?|karriere|careers?|vacanc(?:y|ies)|positions?|offene-stellen|stellenangebote|job-?detail|jobposting)(?:[/?._-]|$)/i;

export const paginatedListConfig = `entry.list for provider "paginated_list":
  url          list URL template with {page} (first_page, default 1) and/or {offset} ((page - first_page) * page_size); required
  kind         "json" | "html"; required
  items        json: dot path to the item array (default: the first array in the document); html: a regular expression (flags gs), each match one item
  fields       { title, url, location, department, postedAt, description, company }: json dot paths ("*" joins arrays), html regexes with one capture group
  url_base     base for relative item URLs (default: the list URL)
  page_size    items per page (default 20): a shorter page ends the walk;  max_pages (default 30);  delay_ms between pages (default 500)
  total        json: dot path to the total count (optional, ends the walk early)
  method, headers, body   request options; {page}/{offset} are substituted in url and body
  company_suffix          appended to the company field, e.g. "(via Board)" for a multi-employer board`;

export const genericProviders = {
  paginated_list: {
    detect: () => null,
    async fetch(_slug, entry = {}) {
      const list = entry.list;
      if (!list?.url || !/^(json|html)$/.test(list.kind ?? '')) throw new Error(`paginated_list: entry.list needs url and kind.\n${paginatedListConfig}`);
      const first = num(list.first_page, 1), size = num(list.page_size, 20), maxPages = num(list.max_pages, 30), delay = num(list.delay_ms, 500);
      const sub = (s, page) => String(s).replace(/\{page\}/g, page).replace(/\{offset\}/g, (page - first) * size);
      const out = new Map();
      let lastKeys = '';
      for (let page = first, n = 0; n < maxPages; page++, n++) {
        if (n) await sleep(delay);
        const url = sub(list.url, page);
        const body = await fetchText(url, { method: list.method ?? 'GET', headers: list.headers ?? {}, body: list.body ? sub(list.body, page) : undefined });
        const { items, total } = itemsOf(body, { ...list, url_base: list.url_base ?? url });
        const jobs = items.map((it) => fieldsOf(it, { ...list, url_base: list.url_base ?? url })).filter((j) => j.title && j.url);
        const keys = jobs.map((j) => j.url).join('\n');
        if (!jobs.length || keys === lastKeys) break;   // an empty page, or a page that repeats the previous one (past the end)
        lastKeys = keys;
        for (const j of jobs) if (!out.has(j.url)) out.set(j.url, j);
        if (items.length < size || (total && out.size >= total)) break;
      }
      return [...out.values()];
    },
  },

  jsonld_direct: {
    detect: () => null,
    async fetch(slug, entry = {}) {
      const pages = [slug, ...(entry.pages ?? [])].filter((u) => /^https?:/.test(u ?? ''));
      if (!pages.length) throw new Error('jsonld_direct: slug must be the careers list URL');
      const pattern = entry.job_url_pattern ? new RegExp(entry.job_url_pattern, 'i') : DEFAULT_JOB_PATTERN;
      const origin = new URL(pages[0]).origin;
      const disallow = await robotsDisallow(origin);
      const allowed = (u) => { try { const p = new URL(u).pathname; return !disallow.some((d) => p.startsWith(d)); } catch { return false; } };
      const found = new Map();   // url -> job (from the list page's JSON-LD) or null (to fetch)
      for (const p of pages) {
        if (!allowed(p)) throw new Error(`jsonld_direct: ${p} is disallowed by robots.txt`);
        const html = await fetchText(p);
        for (const j of jobsFromJsonLd(html, p)) found.set(j.url, j);
        for (const u of jobLinks(html, p, pattern, entry.link_hosts)) if (!found.has(u)) found.set(u, null);
        await sleep(300);
      }
      if (![...found.keys()].length && entry.sitemap) {
        const xml = await fetchText(entry.sitemap, { timeoutMs: 30000 });
        for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) { const u = decode(m[1]).trim(); try { const p = new URL(u); if (pattern.test(p.pathname + p.search)) found.set(u, null); } catch {} }
      }
      const urls = [...found.keys()].filter(allowed).slice(0, num(entry.max_jobs, 300));
      // Posting pages are read once and kept for detail_ttl_hours (default 72), keyed by URL; the list decides what is live.
      const cacheKey = `jsonld_direct:${slug}`;
      const cache = loadSitemapCache(cacheKey), ttl = num(entry.detail_ttl_hours, 72) * 36e5, now = Date.now();
      const todo = urls.filter((u) => !found.get(u) && !(cache[u] && now - cache[u].t < ttl));
      const workers = Math.min(3, Math.max(1, num(entry.page_concurrency, 2)));
      let i = 0;
      await Promise.all(Array.from({ length: workers }, async () => {
        while (i < todo.length) {
          const u = todo[i++];
          try {
            const html = await fetchText(u, { timeoutMs: 25000 });
            const job = jobsFromJsonLd(html, u)[0] ?? parseJobPage(html, u);
            cache[u] = { t: now, job: job?.title ? { ...job, url: u } : null };
          } catch { if (!cache[u]) cache[u] = { t: now, job: null }; }
          await sleep(300);
        }
      }));
      for (const k of Object.keys(cache)) if (!found.has(k)) delete cache[k];
      saveSitemapCache(cacheKey, cache);
      const orgPat = entry.org_filter ? new RegExp(entry.org_filter, 'i') : null;
      return urls.map((u) => found.get(u) ?? cache[u]?.job).filter((j) => j?.title && (!orgPat || orgPat.test(j.organization ?? '')));
    },
  },
};
