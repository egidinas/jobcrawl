// Research-organisation job portals (Germany) that run their own list pages instead of an ATS, merged into the registry by
// providers.mjs after the built-ins (never overriding one). Each provider reads the public list page(s) only; the posting's
// description, location and date come from the posting page through the generic fallback in providers.mjs (pageDescription:
// JSON-LD JobPosting on mpg.de and hzdr.de, the <main> text on desy.de), fetched once per new role by crawl.mjs --jd.
//
//   mpg    Max Planck Society job board, www.mpg.de/jobboard. The page lists 5 postings and a "Show more" button that calls
//          /jobboard/<node>/more_items?offset=N&limit=20 (an XHR fragment of <li class="teaser"> items, 20 per call); the crawler
//          walks it until a short page. slug = the board URL (default https://www.mpg.de/jobboard); entry.max_pages caps the walk.
//          Also /feeds/jobs.rss (last 30 only), not used. robots.txt of www.mpg.de disallows nothing.
//   desy   DESY, www.desy.de/career/job_offers/index_eng.html: one HTML table (ZMS object set), a row per vacancy with the posting
//          date (data-attr_active_start), the record URL (onclick), title, occupational group, employment type and location.
//          slug = the list URL. robots.txt allows it.
//   hzdr   Helmholtz-Zentrum Dresden-Rossendorf, www.hzdr.de/db/!JobList?pNid=490: <div class="cJob"> blocks with a German and an
//          English title link (Cms?pNid=490&pOid=<id>&pContLang=xx). slug = the list URL. robots.txt disallows only internal paths.
//
// The pure parsers are exported so the tests run them on captured pages (crawler/tests/fixtures/research-*.html).
import { UA } from './useragent.mjs';

const DELAY_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s = '') => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
const text = (s = '') => decode(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

async function getText(url, { xhr = false, timeoutMs = 20000 } = {}) {
  const headers = { 'user-agent': UA, accept: 'text/html,*/*' };
  if (xhr) headers['x-requested-with'] = 'XMLHttpRequest';   // mpg.de answers more_items with a 303 to the page unless asked as XHR
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
/** "October 29, 2026" -> "2026-10-29"; '' when it is not that shape. */
export function mpgDate(raw = '') {
  const m = raw.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  const mon = m && MONTHS[m[1].toLowerCase()];
  return mon ? `${m[3]}-${String(mon).padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
}

/** mpg.de list items (the jobboard page or a more_items fragment) -> jobs. "Institute, City" splits at the last comma. */
export function parseMpgList(html, origin = 'https://www.mpg.de') {
  const out = [];
  for (const m of html.matchAll(/<li class="teaser teaser-horizontal">([\s\S]*?)<\/li>/g)) {
    const li = m[1];
    const a = li.match(/<h3>\s*<a href="([^"]+)">([\s\S]*?)<\/a>/);
    if (!a) continue;
    const title = text(a[2]);
    if (!title) continue;
    const where = text(li.match(/<\/div>\s*<div>\s*([^<]+?)\s*<\/div>/)?.[1] ?? '');
    const comma = where.lastIndexOf(',');
    const institute = comma > 0 ? where.slice(0, comma).trim() : where;
    const city = comma > 0 ? where.slice(comma + 1).trim() : '';
    out.push({
      title,
      url: new URL(decode(a[1]), origin).href,
      location: city || where,
      department: institute,
      postedAt: mpgDate(text(li.match(/<span class="date">([^<]*)<\/span>/)?.[1] ?? '')),
    });
  }
  return out;
}

/** The DESY job table -> jobs (date from data-attr_active_start, URL from the row's onclick). */
export function parseDesyList(html) {
  const out = [];
  for (const m of html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)) {
    const [, attrs, row] = m;
    const url = attrs.match(/document\.location\.href='([^']+)'/)?.[1];
    if (!url) continue;
    const td = (cls) => text(row.match(new RegExp(`<td class="${cls}"[^>]*>([\\s\\S]*?)</td>`))?.[1] ?? '');
    const title = td('title');
    if (!title) continue;
    const id = attrs.match(/title="([A-Z]{2,6}\d{2,4}\/\d{4})\b/)?.[1] ?? '';
    out.push({
      title,
      url: decode(url),
      location: td('location'),
      department: [td('occupational_group'), td('employment_type')].filter(Boolean).join(' / '),
      postedAt: attrs.match(/data-attr_active_start="(\d{4}-\d{2}-\d{2})/)?.[1] ?? '',
      ...(id ? { reference: id } : {}),
    });
  }
  return out;
}

/** HZDR !JobList blocks -> jobs; the English title link is preferred, the German one is the fallback. */
export function parseHzdrList(html, listUrl = 'https://www.hzdr.de/db/!JobList?pNid=490') {
  const out = [], seen = new Set();
  for (const m of html.matchAll(/<div class="cJob">([\s\S]*?)(?=<div class="cJob">|$)/g)) {
    const block = m[1];
    const links = [...block.matchAll(/<h2>\s*<a href="([^"]+)">([\s\S]*?)<\/a>\s*<\/h2>/g)].map((l) => ({ href: decode(l[1]), title: text(l[2]) }));
    const pick = links.find((l) => /pContLang=en/.test(l.href)) ?? links[0];
    if (!pick?.title) continue;
    const url = new URL(pick.href, listUrl).href;
    const id = url.match(/pOid=(\d+)/)?.[1] ?? url;
    if (seen.has(id)) continue;
    seen.add(id);
    // After the title links come one teaser paragraph per language (German first, English second).
    const teasers = [...block.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((t) => text(t[1])).filter((t) => t && !/^Online application|^PDF-Print|^Online-Bewerbung/i.test(t)).slice(0, 2);
    const teaser = teasers[1] ?? teasers[0] ?? '';
    out.push({ title: pick.title, url, location: 'Dresden-Rossendorf', department: '', postedAt: '', ...(teaser ? { teaser } : {}) });
  }
  return out;
}

export const researchProviders = {
  mpg: {
    detect: (u) => (/^https?:\/\/(?:www\.)?mpg\.de\/jobboard(?:[/?#]|$)/i.test(u) ? u.split(/[?#]/)[0] : null),
    async fetch(slug, entry = {}) {
      const board = slug && slug.startsWith('http') ? slug.replace(/\/$/, '') : 'https://www.mpg.de/jobboard';
      const origin = new URL(board).origin;
      const page = await getText(board);
      const more = page.match(/href="(\/jobboard\/\d+\/more_items)"/)?.[1];
      const limit = 20, maxPages = Number(entry.max_pages) > 0 ? Number(entry.max_pages) : 200;
      const out = new Map();
      for (const j of parseMpgList(page, origin)) out.set(j.url, j);
      if (!more) return [...out.values()];
      // The page shows the first 5; more_items continues from offset 5, 20 at a time (a larger limit is clamped to 20).
      for (let offset = 5, n = 0; n < maxPages; offset += limit, n++) {
        await sleep(DELAY_MS);
        const frag = await getText(`${origin}${more}?offset=${offset}&limit=${limit}&region=&subject=&job_type=`, { xhr: true });
        const jobs = parseMpgList(frag, origin);
        for (const j of jobs) out.set(j.url, j);
        if (jobs.length < limit) break;
      }
      return [...out.values()];
    },
  },

  desy: {
    detect: (u) => (/^https?:\/\/(?:www\.)?desy\.de\/(?:career\/job_offers|karriere\/stellenangebote)\//i.test(u) ? u : null),
    async fetch(slug) {
      const url = slug && slug.startsWith('http') ? slug : 'https://www.desy.de/career/job_offers/index_eng.html';
      return parseDesyList(await getText(url));
    },
  },

  hzdr: {
    detect: (u) => (/^https?:\/\/(?:www\.)?hzdr\.de\/db\/!JobList\b/i.test(u) ? u : null),
    async fetch(slug) {
      const url = slug && slug.startsWith('http') ? slug : 'https://www.hzdr.de/db/!JobList?pNid=490';
      return parseHzdrList(await getText(url), url);
    },
  },
};
