// Pure pieces of the career-site profiler (no network): ATS fingerprints, career/list links, the repeated link group of a page and the
// paginated_list configuration that reads it, job-like JSON arrays (for sniffed XHR responses), job sitemaps and RSS feeds.
// Every function takes a document and returns data, so the tests run them on captured pages (crawler/tests/fixtures/profiler-*).
import { providers } from '../providers.mjs';

// Providers that are boards of many employers, search backends or config-driven: never the answer to "which ATS does this site use".
export const NOT_AN_ATS = new Set(['spacecareers', 'spacecapital', 'spaceindividuals', 'jobsinphotonics', 'mycareersfuture', 'eures', 'usajobs',
  'paginated_list', 'jsonld_direct', 'sitemap', 'jibe']);

export const decode = (s = '') => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
export const textOf = (s = '') => decode(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
export const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Registrable domain (last two labels, three for co.uk-like suffixes). */
export function regDomain(host = '') {
  const h = String(host).toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const p = h.split('.');
  if (p.length <= 2) return h;
  const sld = p[p.length - 2];
  return (['co', 'com', 'org', 'ac', 'gov', 'net', 'or', 'ne'].includes(sld) && p[p.length - 1].length === 2) ? p.slice(-3).join('.') : p.slice(-2).join('.');
}
export const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };

// ---------- job-likeness ----------
const TITLE_WORDS = /\b(?:engineer|ingenieur|entwickler|developer|techniker|technician|technologist|manager|leiter|leitung|head of|lead|director|specialist|spezialist|mitarbeiter|scientist|wissenschaftl|physicist|physiker|chemi(?:st|ker)|researcher|doktorand|postdoc|phd|praktik|werkstudent|intern(?:ship)?|student|abschlussarbeit|thesis|ausbildung|azubi|trainee|consultant|berater|analyst|architect|architekt|operator|bediener|mechani(?:ker|c)|elektroni(?:ker|c)|elektriker|mechatroni(?:ker|c)|designer|konstrukteur|officer|assistant|assistenz|sachbearbeiter|referent|kauf(?:mann|frau|leute)|administrator|programmer|programmierer|expert|experte|coordinator|koordinator|planner|planer|controller|buyer|einkäufer|einkaeufer|accountant|buchhalter|monteur|schlosser|fachkraft|fachinformatiker|meister|inspector|prüfer|pruefer|tester|qualit|software|hardware|firmware|embedded|devops|data|system|projekt|project|produkt|product|vertrieb|sales|marketing|recruit|personal|hr\b|professor|lecturer|dozent|pilot|avionic|machinist|welder|schweißer|lagerist|logisti|fertigung|produktion|production|service|support|associate|executive|counsel|jurist|legal)\b/i;
const GENDER = /\((?:[mwfdx]\s*[/|,]\s*){1,3}[mwfdx]\)|\b[mwf]\/[mwf]\/[dx]\b|\(all genders?\)|\(gn\)|\(w\/m\/d\)/i;
const NAV_TEXT = /^(?:jobs?|karriere|careers?|stellen(?:angebote)?|offene stellen|vacancies|join us|mehr(?: erfahren)?|weiterlesen|read more|more|details?|zur stelle|zum job|jetzt bewerben|bewerben|apply(?: now)?|learn more|view(?: job| all| details)?|show more|alle jobs|all jobs|see all|zurück|back|next|weiter|home|start(?:seite)?|kontakt|contact|impressum|datenschutz|privacy|login|anmelden|initiativbewerbung|unsolicited application|\d+)$/i;
export const JOB_URL_TOKENS = /(?:^|[/_.?&=-])(?:jobs?|stellen\w*|stelle|karriere|careers?|positions?|vacanc(?:y|ies)|vacatures?|offene[-_]?stellen|jobangebot\w*|jobboerse|ausschreibung\w*|lediga[-_]?jobb|jobb|emplois?|offres?|posting|requisition|opening|jobid|job_id|stellenid|job-detail|jobdetail|apply|bewerb\w*|recruiting)(?:$|[/_.?&=-]|\d)/i;

/** 0..1: how much a text looks like a job title. */
export function titleScore(t) {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  if (s.length < 5 || s.length > 160 || NAV_TEXT.test(s)) return 0;
  let v = 0.25;
  if (TITLE_WORDS.test(s)) v += 0.5;
  if (GENDER.test(s)) v += 0.4;
  if (/[a-zäöü]{3,}/i.test(s) && s.split(' ').length <= 16) v += 0.1;
  if (/cookie|newsletter|©|copyright|datenschutz|privacy|impressum/i.test(s)) v = 0;
  return Math.min(1, v);
}
export const isJobLike = (t) => titleScore(t) >= 0.6;

// ---------- 1. ATS fingerprint ----------
/** Every URL a page mentions: href/src/action/data-* attributes and absolute URLs in inline scripts. */
export function urlsOf(html, pageUrl) {
  const out = new Set();
  const add = (raw) => { try { const u = new URL(decode(raw.trim()), pageUrl); if (/^https?:$/.test(u.protocol)) out.add(u.href); } catch {} };
  for (const m of html.matchAll(/\b(?:href|src|action|data-[\w-]*(?:url|src|href)[\w-]*)\s*=\s*["']([^"'<>\s]{4,500})["']/gi)) add(m[1]);
  for (const m of html.matchAll(/https?:\\?\/\\?\/[\w.-]+(?:\\?\/[^"'<>\s\\)]*)?/g)) add(m[0].replace(/\\\//g, '/'));
  return [...out];
}

const ATS_HOST = /greenhouse\.io|lever\.co|ashbyhq|personio\.|smartrecruiters|teamtailor|recruitee|myworkdayjobs|workday|rippling|bamboohr|join\.com|softgarden|workable|breezy\.hr|pinpointhq|applytojob|successfactors|sapsf|csod\.com|eightfold|oraclecloud|jobvite|dover\.|b-ite\.|concludis|factorial|umantis|avature|lucca|onlyfy|cvwarehouse|hrlab|adp\.com|ultipro|ukg|icims|comeet|jobs\.gem\.com|deel\.com|paylocity|zohorecruit|odoo\.com|jobscore|phenom/i;

/** Known ATS boards a page points at: [{ provider, slug, via, hits }], most-mentioned first. */
export function atsFingerprints(html, pageUrl) {
  const found = new Map();
  const note = (provider, slug, via) => {
    const k = `${provider}\t${slug}`;
    const f = found.get(k) ?? { provider, slug, via, hits: 0 };
    f.hits++; found.set(k, f);
  };
  const pageDom = regDomain(hostOf(pageUrl));
  const tryUrl = (u) => {
    const h = hostOf(u);
    for (const [name, p] of Object.entries(providers)) {
      if (NOT_AN_ATS.has(name) || typeof p.detect !== 'function') continue;
      let slug;
      try { slug = p.detect(u); } catch { slug = null; }
      if (!slug || typeof slug !== 'string') continue;
      // A hosted ATS lives on its own host (boards.greenhouse.io, x.jobs.personio.de); a company-specific provider (bwi.de, tttech.com)
      // or an ATS on the company's domain counts only when the URL is on the page's own registrable domain, never on a link elsewhere.
      if (!(ATS_HOST.test(h) || regDomain(h) === pageDom)) continue;
      if (/^(?:embed|js|job_board|jobs|careers|api|v\d+|www)$/i.test(slug)) continue;   // a path word, not a tenant (greenhouse .../embed/job_board/js)
      note(name, slug, u); break;
    }
  };
  tryUrl(pageUrl);
  for (const u of urlsOf(html, pageUrl)) {
    // SuccessFactors Career Site Builder on a company host: its search links carry searchResultView= or createNewAlert= (the provider's
    // own detect() needs a posting URL or a successfactors host)
    if (/\/search\/?\?(?:[^"'#]*&)?(?:searchResultView|createNewAlert|q=&(?:amp;)?locationsearch)=/i.test(u)) { note('successfactors', hostOf(u), u); continue; }
    const gh = u.match(/greenhouse\.io\/embed\/job_board(?:\/js)?\?(?:[^#]*&)?for=([\w-]+)/i);   // the embed script names the board in ?for=
    if (gh) { note('greenhouse', gh[1], u); continue; }
    // Company-specific providers detect on their own domain (rheinmetall.com, bwi.de ...): only count them when that domain IS the page's.
    tryUrl(u);
  }
  // Providers that detect on markup (BITE embeds carry the tenant in a data attribute).
  for (const name of ['bite']) {
    const p = providers[name];
    if (!p) continue;
    try { const slug = p.detect(html); if (slug) note(name, slug, 'markup'); } catch {}
  }
  return [...found.values()].sort((a, b) => b.hits - a.hits);
}

// ---------- careers page and list links ----------
const CAREER_TEXT = /karriere|career|jobs?\b|stellen|offene positionen|vacanc|join (?:us|our team)|arbeiten bei|work(?:ing)? (?:with|at|for) us|jobb|lediga|vacatures|emplois?|carri[eè]re|lavora con noi|empleo|trabaja/i;
const CAREER_PATH = /karriere|career|jobs?(?:[/._-]|$)|stellen|vacanc|jobb|vacature|emploi|carriere|join-?us/i;
const LIST_TEXT = /offene stellen|stellenangebote|alle (?:jobs|stellen)|aktuelle (?:jobs|stellen|stellenangebote)|jobangebote|job ?börse|jobboerse|current (?:openings|vacancies|jobs)|open (?:positions|roles|jobs)|all (?:jobs|positions|openings)|see (?:all )?(?:jobs|openings)|view (?:all )?(?:jobs|openings|positions)|job ?openings|vacancies|lediga jobb|vacatures|nos offres|stellenmarkt|zu den (?:jobs|stellen)|jobs anzeigen|jobsuche|job search/i;

function anchorsOf(html, pageUrl) {
  const out = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href || /^(?:mailto:|tel:|javascript:|#)/i.test(href.trim())) continue;
    let u;
    try { u = new URL(decode(href.trim()), pageUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    u.hash = '';
    const title = m[1].match(/\btitle\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
    out.push({ url: u.href, text: textOf(m[2]) || textOf(title) || textOf(m[2].match(/alt=["']([^"']*)["']/i)?.[1] ?? '') });
  }
  return out;
}

/** Links from a home page to the careers page, best first (same registrable domain or a known career host). */
export function careerLinks(html, pageUrl) {
  const dom = regDomain(hostOf(pageUrl));
  const seen = new Map();
  for (const a of anchorsOf(html, pageUrl)) {
    const u = new URL(a.url);
    const path = u.pathname + u.search;
    let s = 0;
    if (CAREER_TEXT.test(a.text) && a.text.length < 60) s += 2;
    if (CAREER_PATH.test(path)) s += 2;
    if (!s) continue;
    if (regDomain(u.host) !== dom) s -= 1;
    if (/linkedin|xing|indeed|stepstone|glassdoor|kununu|facebook|instagram|twitter|youtube/i.test(u.host)) continue;
    if (/\.(?:pdf|jpe?g|png|docx?)$/i.test(u.pathname)) continue;
    if (u.href === pageUrl) continue;
    seen.set(u.href, Math.max(seen.get(u.href) ?? -9, s));
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([url, score]) => ({ url, score }));
}

/** On a careers landing page: links to the actual list ("Offene Stellen", "All jobs"), best first. */
export function listLinks(html, pageUrl) {
  const dom = regDomain(hostOf(pageUrl));
  const out = new Map();
  for (const a of anchorsOf(html, pageUrl)) {
    if (a.url === pageUrl || a.text.length > 60) continue;
    let s = 0;
    if (LIST_TEXT.test(a.text)) s += 3;
    const path = new URL(a.url).pathname;
    if (/stellenangebote|offene-stellen|jobs\/?$|job-?search|jobsuche|vacancies|openings|positions|stellenboerse|jobboerse|lediga-jobb/i.test(path)) s += 1;
    if (!s) continue;
    if (regDomain(hostOf(a.url)) !== dom) s -= 1;
    out.set(a.url, Math.max(out.get(a.url) ?? -9, s));
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).map(([url, score]) => ({ url, score }));
}

/** RSS/Atom feeds a page announces. */
export function feedLinks(html, pageUrl) {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const t = m[0];
    if (!/rel=["']alternate["']/i.test(t) || !/application\/(?:rss|atom)\+xml/i.test(t)) continue;
    const href = t.match(/href=["']([^"']+)["']/i)?.[1];
    if (href) try { out.push(new URL(decode(href), pageUrl).href); } catch {}
  }
  return out;
}

// ---------- 4. repeated link group ----------
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'iframe', 'select']);
const AUTO_CLOSE = new Set(['li', 'p', 'tr', 'td', 'th', 'option', 'dt', 'dd']);

/** A tolerant HTML tree: { tag, cls, id, href, children, parent, text } (skips script/style/svg/head bodies). */
export function parseTree(html) {
  const root = { tag: '#root', cls: '', id: '', children: [], parent: null };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!(?:[^>])*>|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+|<)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) { const t = m[4]; if (t.trim()) cur.children.push({ text: t }); continue; }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {   // closing tag: pop to the nearest open element of that name, if any
      let n = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n && n.parent) cur = n.parent;
      continue;
    }
    if (SKIP.has(tag)) {
      if (/\/\s*$/.test(m[3])) continue;
      const end = html.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
      re.lastIndex = end < 0 ? html.length : end;
      continue;
    }
    const attrs = m[3] ?? '';
    const attr = (k) => attrs.match(new RegExp(`(?:^|\\s)${k}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(1).find((x) => x !== undefined) ?? '';
    if (AUTO_CLOSE.has(tag) && cur.tag === tag) cur = cur.parent;
    const node = { tag, cls: attr('class').trim().replace(/\s+/g, ' '), id: attr('id'), children: [], parent: cur };
    if (tag === 'a') node.href = attr('href');
    cur.children.push(node);
    if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) cur = node;
  }
  return root;
}
export function nodeText(n) {
  if (n.text !== undefined) return decode(n.text);
  return n.children.map(nodeText).join(' ');
}
const clean = (s) => s.replace(/\s+/g, ' ').trim();
// A class token that names a structure (job-item) rather than a state or an instance (active, col-md-6, item-123, css-1x2y3z).
const stableClasses = (cls) => cls.split(' ').filter((c) => c && !/\d{2,}|^(?:active|selected|odd|even|first|last|show|hide|hidden|visible|open|is-|has-|js-|col-|row$|d-|m[tblrxy]?-|p[tblrxy]?-|w-|h-|text-|bg-|flex|grid|css-|sc-|jsx-|svelte-)/i.test(c));
const sig = (n) => `${n.tag}${stableClasses(n.cls).slice(0, 3).map((c) => '.' + c).join('')}`;

function walk(n, fn) { fn(n); for (const c of n.children ?? []) if (c.text === undefined) walk(c, fn); }

/** Common path prefix of URLs at segment granularity, plus the first segment's common string prefix as a fallback. */
function hrefPattern(urls, pageUrl) {
  const us = urls.map((u) => new URL(u));
  const hosts = new Set(us.map((u) => u.host));
  if (hosts.size !== 1) return null;
  const host = [...hosts][0];
  const segs = us.map((u) => u.pathname.split('/').filter(Boolean));
  const common = [];
  for (let i = 0; ; i++) {
    const s = segs[0][i];
    if (s === undefined || !segs.every((x) => x[i] === s) || segs.every((x) => x.length === i + 1)) break;
    common.push(s);
  }
  let prefix = '/' + common.map((s) => s).join('/') + (common.length ? '/' : '');
  if (!common.length || common.join('/').length < 3) {
    // one segment that differs per job: its common string prefix ("/job-", "/stellenangebot-")
    const firsts = segs.map((x) => x[common.length] ?? '');
    let p = firsts[0];
    for (const f of firsts) while (p && !f.startsWith(p)) p = p.slice(0, -1);
    if (p.length >= 3) prefix = prefix + p;
    else {
      // a query key that identifies the posting (?jobid=, ?id=)
      const keys = us.map((u) => [...u.searchParams.keys()].join('&'));
      if (keys.every((k) => k && k === keys[0]) && us.every((u) => u.pathname === us[0].pathname)) {
        const k0 = [...us[0].searchParams.keys()].find((k) => new Set(us.map((u) => u.searchParams.get(k))).size === us.length);
        if (!k0) return null;
        return { host, prefix: us[0].pathname + '?', query: k0, sameHost: host === hostOf(pageUrl) };
      }
      return null;
    }
  }
  return { host, prefix, sameHost: host === hostOf(pageUrl) };
}

/** Regex source matching the href of a group's links, absolute or relative. */
export function hrefRegex(hp) {
  const hostPart = `(?:https?:)?(?://${reEscape(hp.host)})?`;
  if (hp.query) return `${hostPart}${reEscape(hp.prefix)}(?:[^"'#]*?&(?:amp;)?)?${reEscape(hp.query)}=[^"'#]+`;
  return `${hostPart}${reEscape(hp.prefix)}[^"'#\\s]*`;
}

/**
 * The repeated link groups of a page: anchors that share their ancestors' structure (tag + stable classes, 4 levels) and a
 * common link prefix. Each group: { n, urls, titles, score, hp, container, titleSource }. Best (most job-like) first.
 */
export function linkGroups(html, pageUrl) {
  const root = parseTree(html);
  const groups = new Map();
  walk(root, (n) => {
    if (n.tag !== 'a' || !n.href || /^(?:mailto:|tel:|javascript:|#)/i.test(n.href.trim())) return;
    let url;
    try { url = new URL(decode(n.href.trim()), pageUrl); } catch { return; }
    if (!/^https?:$/.test(url.protocol) || /\.(?:pdf|docx?|jpe?g|png|gif|svg|zip|mp4|ics)$/i.test(url.pathname)) return;
    url.hash = '';
    const chain = [];
    for (let p = n.parent, i = 0; p && p.tag !== '#root' && i < 4; p = p.parent, i++) chain.push(sig(p));
    const key = `${sig(n)}<${chain.join('<')}|${url.host}`;
    const g = groups.get(key) ?? { key, nodes: [], urls: [] };
    g.nodes.push(n); g.urls.push(url.href);
    groups.set(key, g);
  });
  const out = [];
  for (const g of groups.values()) {
    const uniq = [...new Set(g.urls)];
    if (uniq.length < 3) continue;
    const page = (() => { try { const u = new URL(pageUrl); u.hash = ''; return u.href; } catch { return pageUrl; } })();
    const urls = uniq.filter((u) => u !== page);
    if (urls.length < 3) continue;
    const hp = hrefPattern(urls, pageUrl);
    if (!hp) continue;
    // Title of each link: its text, or the heading/title element of its own container when the link text is generic ("Mehr erfahren").
    const byUrl = new Map();
    for (const n of g.nodes) {
      let u; try { u = new URL(decode(n.href.trim()), pageUrl); u.hash = ''; u = u.href; } catch { continue; }
      if (byUrl.has(u)) continue;
      const own = clean(nodeText(n));
      byUrl.set(u, { node: n, own });
    }
    const container = itemContainer(g.nodes);
    const titles = [];
    let titleSource = 'anchor', titleHint = null;
    for (const [, v] of byUrl) {
      let t = v.own;
      const heading = findHeading(v.node);
      const ht = heading ? clean(nodeText(heading)) : '';
      if (ht && titleScore(ht) >= titleScore(t) && titleScore(ht) > 0) { t = ht; titleSource = 'heading'; titleHint ??= hintOf(heading); }
      else if (container && titleScore(t) < 0.6) {
        const c = ancestorMatching(v.node, container);
        const h = c && firstHeading(c);
        if (h && titleScore(clean(nodeText(h))) > titleScore(t)) { t = clean(nodeText(h)); titleSource = 'container-heading'; titleHint ??= hintOf(h); }
      }
      titles.push(t);
    }
    const tsc = titles.map(titleScore);
    const titleFrac = tsc.filter((s) => s >= 0.6).length / titles.length;
    const tokenFrac = urls.filter((u) => { const x = new URL(u); return JOB_URL_TOKENS.test(x.pathname + x.search); }).length / urls.length;
    const avgLen = titles.reduce((a, t) => a + t.length, 0) / titles.length;
    const navPenalty = /nav|menu|footer|header|breadcrumb|pagination|social|lang/i.test(g.key) ? 0.3 : 1;
    const score = urls.length ** 0.7 * (0.3 + tokenFrac) * (0.1 + titleFrac) * navPenalty * (avgLen >= 8 ? 1 : 0.3);
    out.push({ n: urls.length, urls, titles, titleFrac, tokenFrac, score, hp, container, titleSource, titleHint, key: g.key });
  }
  return out.sort((a, b) => b.score - a.score);
}

const HEADING = /^h[1-6]$/;
const TITLE_CLASS = /(?:^|[\s_-])(?:title|titel|job-?name|position-?name|headline)(?:$|[\s_-])/i;
const hintOf = (n) => (HEADING.test(n.tag) ? { tag: n.tag } : { tag: n.tag, cls: n.cls.split(' ').find((c) => TITLE_CLASS.test(` ${c} `)) ?? stableClasses(n.cls)[0] });
function findHeading(a) {   // a heading or a title-classed element inside the anchor
  let best = null;
  walk(a, (n) => { if (!best && n !== a && (HEADING.test(n.tag) || /(?:^|[\s_-])(?:title|titel|job-?name|position-?name|headline)(?:$|[\s_-])/i.test(n.cls))) best = n; });
  return best;
}
function firstHeading(c) {
  let best = null;
  walk(c, (n) => { if (!best && (HEADING.test(n.tag) || /(?:^|[\s_-])(?:title|titel|job-?name|headline)(?:$|[\s_-])/i.test(n.cls))) best = n; });
  return best;
}
function ancestorMatching(n, c) {
  for (let p = n.parent; p; p = p.parent) if (p.tag === c.tag && stableClasses(p.cls).join(' ') === c.classes.join(' ')) return p;
  return null;
}
/** The per-item container: the nearest ancestor (same tag + stable classes for every link) that holds one posting's links only. */
function itemContainer(nodes) {
  for (let depth = 1; depth <= 4; depth++) {
    const anc = nodes.map((n) => { let p = n; for (let i = 0; i < depth && p; i++) p = p.parent; return p; });
    if (anc.some((p) => !p || p.tag === '#root')) return null;
    const s0 = sig(anc[0]);
    if (!anc.every((p) => sig(p) === s0)) return null;
    const uniq = new Set(anc);
    if (uniq.size < Math.min(3, nodes.length)) return null;   // several links share one ancestor: that is the list, not the item
    const classes = stableClasses(anc[0].cls);
    if ((classes.length || anc[0].id === '') && ['li', 'article', 'tr', 'div', 'section', 'dl'].includes(anc[0].tag) && classes.length) {
      return { tag: anc[0].tag, classes, depth };
    }
  }
  return null;
}

/**
 * A paginated_list html configuration for a link group: the items are the per-posting containers (up to the next one) when the page
 * has them, else the links themselves; title from the heading or the link text, url from the link, location when a location-classed
 * element is there. `page` adds a {page} template (from pagination links); returns the entry's `list`.
 */
export function htmlListConfig(group, pageUrl, html, page = null) {
  const href = hrefRegex(group.hp);
  const list = { kind: 'html', url: page?.template ?? pageUrl, page_size: Math.max(group.n, 1), max_pages: page ? 10 : 1, delay_ms: 1100 };
  if (page?.first_page !== undefined) list.first_page = page.first_page;
  if (page?.offset) list.page_size = page.page_size ?? group.n;
  const c = group.container;
  if (c && ['li', 'article', 'tr', 'div', 'section', 'dl'].includes(c.tag)) {
    const cls = c.classes.map((x) => `(?=[^"']*\\b${reEscape(x)}\\b)`).join('');
    const open = `<${c.tag}\\b[^>]*class=["']${cls}[^"']*["'][^>]*>`;
    list.items = `${open}[\\s\\S]*?(?=${open}|<footer\\b|$)`;
  } else {
    list.items = `<a\\b[^>]*href=["']${href}["'][^>]*>[\\s\\S]*?</a>`;
  }
  list.fields = { url: `href=["'](${href})["']` };
  const th = group.titleHint;
  if ((group.titleSource === 'heading' || group.titleSource === 'container-heading') && th) {
    list.fields.title = th.cls ? `<${th.tag}\\b[^>]*class=["'][^"']*\\b${reEscape(th.cls)}\\b[^"']*["'][^>]*>([\\s\\S]*?)</${th.tag}>` : `<${th.tag}\\b[^>]*>([\\s\\S]*?)</${th.tag}>`;
  } else list.fields.title = `<a\\b[^>]*href=["']${href}["'][^>]*>([\\s\\S]*?)</a>`;
  if (c && /class=["'][^"']*(?:location|standort|ort\b|city|place|einsatzort|arbeitsort)/i.test(html)) {
    const lm = html.match(/class=["']([^"']*\b(?:job-?location|location|standort|einsatzort|arbeitsort|city|place)\b[^"']*)["']/i);
    if (lm) {
      const key = lm[1].split(/\s+/).find((k) => /location|standort|einsatzort|arbeitsort|city|place/i.test(k));
      if (key) list.fields.location = `class=["'][^"']*\\b${reEscape(key)}\\b[^"']*["'][^>]*>([\\s\\S]*?)</`;
    }
  }
  return list;
}

/** "Next page" links of a list page that differ from it by one page/offset number: { template, first_page | offset }. */
export function pagination(html, pageUrl, nItems) {
  const page = new URL(pageUrl);
  const cands = [];
  for (const a of anchorsOf(html, pageUrl)) {
    const u = new URL(a.url);
    if (u.host !== page.host) continue;
    for (const k of ['page', 'p', 'seite', 'pg', 'paged', 'pagenum', 'currentpage', 'start', 'offset', 'from', 'skip']) {
      const v = u.searchParams.get(k);
      if (v === null || !/^\d+$/.test(v) || u.pathname !== page.pathname) continue;
      const n = Number(v);
      const offsetKey = /start|offset|from|skip/.test(k);
      if (offsetKey ? n === nItems : n === 2) {
        const t = new URL(u.href);
        t.searchParams.set(k, '__P__');
        cands.push({ template: t.href.replace('__P__', offsetKey ? '{offset}' : '{page}'), first_page: offsetKey ? undefined : 1, offset: offsetKey, page_size: offsetKey ? n : undefined, text: a.text });
      }
    }
    const pm = u.pathname.match(/^(.*\/(?:page|seite)\/)(\d+)\/?$/i);
    if (pm && Number(pm[2]) === 2 && page.pathname.replace(/\/$/, '').startsWith(pm[1].replace(/\/(?:page|seite)\/$/i, ''))) {
      cands.push({ template: `${u.origin}${pm[1]}{page}/${u.search}`, first_page: 1, offset: false, text: a.text });
    }
  }
  return cands[0] ?? null;
}

// ---------- 3. JSON arrays that look like jobs (sniffed XHR responses) ----------
const TITLE_KEYS = /^(?:title|jobtitle|job_title|name|position|positiontitle|positionname|bezeichnung|stellenbezeichnung|titel|text|label|headline|jobname|job_name|displayname|requisitiontitle|postingtitle)$/i;
const URL_KEYS = /^(?:url|link|href|absolute_url|absoluteurl|applyurl|apply_url|jobUrl|job_url|detailurl|detail_url|detailsurl|joburl|externalurl|external_url|hostedurl|permalink|canonicalurl|publicurl|posting_url|careersiteurl|externalpath|path|slug)$/i;
const ID_KEYS = /^(?:id|jobid|job_id|postingid|requisitionid|reqid|uuid|refnr|reference|ref|shortcode|jobadid|stellenid)$/i;
const LOC_KEYS = /^(?:location|locations|city|ort|standort|arbeitsort|place|workplace|joblocation|locationname|location_name|office|offices|region|country|einsatzort)$/i;
const DATE_KEYS = /^(?:date|dateposted|date_posted|posted|postedat|posted_at|postingdate|publishdate|published|publishedat|published_at|created|createdat|created_at|startdate|releasedate|onlinesince|first_published)$/i;
const DEPT_KEYS = /^(?:department|departments|team|category|categories|function|division|bereich|abteilung|jobfamily|job_family|discipline|businessunit)$/i;

/** Arrays of objects anywhere in a JSON document whose items look like postings: [{ path, items, fields, score }]. */
export function jobArrays(data) {
  const out = [];
  const visit = (v, path, depth) => {
    if (depth > 8 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      const objs = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length >= 3 && objs.length >= v.length * 0.8) {
        const r = scoreArray(objs);
        if (r) out.push({ path: path.join('.'), n: objs.length, ...r });
      }
      // arrays of arrays are not walked (path syntax needs fixed indexes); the first element only, for wrappers like [ {jobs: [...]} ]
      if (v.length && typeof v[0] === 'object' && !Array.isArray(v[0]) && objs.length < 3) visit(v[0], [...path, '0'], depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) if (/^[\w$@-]+$/.test(k)) visit(x, [...path, k], depth + 1);
  };
  visit(data, [], 0);
  return out.sort((a, b) => b.score - a.score);
}

function keyFor(objs, re, test = () => true, nested = true) {
  // a direct key, or one level down (title.text, location.name, _source.title)
  const counts = new Map();
  for (const o of objs.slice(0, 50)) {
    for (const [k, v] of Object.entries(o)) {
      if (re.test(k) && v != null && v !== '' && test(v)) counts.set(k, (counts.get(k) ?? 0) + 1);
      if (nested && v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) {
        if (re.test(k2) && v2 != null && v2 !== '' && test(v2)) counts.set(`${k}.${k2}`, (counts.get(`${k}.${k2}`) ?? 0) + 0.9);
      }
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= Math.min(3, objs.length) * 0.8 ? best[0] : null;
}
const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
const strv = (v) => (v == null ? '' : typeof v === 'object' ? String(v.name ?? v.label ?? v.title ?? v.text ?? v.city ?? v.value ?? '') : String(v));

function scoreArray(objs) {
  const tk = keyFor(objs, TITLE_KEYS, (v) => typeof v === 'string' || (typeof v === 'object' && !Array.isArray(v)));
  if (!tk) return null;
  const titles = objs.map((o) => strv(getPath(o, tk)).replace(/\s+/g, ' ').trim());
  const titleFrac = titles.filter(isJobLike).length / titles.length;
  if (titleFrac < 0.3) return null;
  const uk = keyFor(objs, URL_KEYS, (v) => typeof v === 'string' && v.length > 1);
  const ik = keyFor(objs, ID_KEYS, (v) => typeof v === 'string' || typeof v === 'number');
  const fields = { title: tk };
  if (uk) fields.url = uk;
  if (ik) fields.id = ik;
  const lk = keyFor(objs, LOC_KEYS, (v) => typeof v === 'string' || typeof v === 'object');
  if (lk) fields.location = /s$/.test(lk) && Array.isArray(getPath(objs[0], lk)) ? `${lk}.*` : lk;
  const dk = keyFor(objs, DATE_KEYS, (v) => typeof v === 'string' && /\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4}/.test(v));
  if (dk) fields.postedAt = dk;
  const ck = keyFor(objs, DEPT_KEYS, (v) => typeof v === 'string' || typeof v === 'object');
  if (ck) fields.department = /s$/.test(ck) && Array.isArray(getPath(objs[0], ck)) ? `${ck}.*` : ck;
  const score = objs.length ** 0.5 * titleFrac * (uk ? 1.5 : ik ? 1 : 0.4) * (lk ? 1.2 : 1);
  return { fields, titles: titles.slice(0, 5), titleFrac, score };
}

/** Find the numeric paging knob of a request (query or JSON body): { where, key, value, kind: 'page' | 'offset' }. */
export function pagingParam(url, body) {
  const KEYS = [['page', 'page'], ['pagenumber', 'page'], ['pageindex', 'page'], ['currentpage', 'page'], ['p', 'page'], ['seite', 'page'],
    ['offset', 'offset'], ['start', 'offset'], ['from', 'offset'], ['skip', 'offset'], ['startindex', 'offset']];
  const u = new URL(url);
  for (const [k, v] of u.searchParams) {
    const hit = KEYS.find(([n]) => n === k.toLowerCase());
    if (hit && /^\d+$/.test(v)) return { where: 'query', key: k, value: Number(v), kind: hit[1] };
  }
  if (body) {
    try {
      const j = JSON.parse(body);
      const find = (o, path) => {
        if (!o || typeof o !== 'object') return null;
        for (const [k, v] of Object.entries(o)) {
          const hit = KEYS.find(([n]) => n === k.toLowerCase());
          if (hit && typeof v === 'number') return { where: 'body', key: [...path, k].join('.'), value: v, kind: hit[1] };
          if (v && typeof v === 'object' && !Array.isArray(v)) { const r = find(v, [...path, k]); if (r) return r; }
        }
        return null;
      };
      return find(j, []);
    } catch {}
  }
  return null;
}

// ---------- 2. sitemaps and feeds ----------
export function sitemapLocs(xml) {
  const isIndex = /<sitemapindex/i.test(xml);
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decode(m[1]).trim());
  return { isIndex, locs };
}
export function robotsSitemaps(robotsTxt = '') {
  return [...String(robotsTxt).matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]);
}
/** Job-posting URLs of a sitemap: the largest group of locs sharing a job-like path prefix. */
export function sitemapJobGroup(locs) {
  const groups = new Map();
  for (const u of locs) {
    let x; try { x = new URL(u); } catch { continue; }
    const segs = x.pathname.split('/').filter(Boolean);
    for (let i = 0; i < Math.min(segs.length - 1, 4); i++) {
      if (!JOB_URL_TOKENS.test('/' + segs[i] + '/')) continue;
      const prefix = '/' + segs.slice(0, i + 1).join('/') + '/';
      const g = groups.get(prefix) ?? [];
      g.push(u); groups.set(prefix, g);
      break;
    }
  }
  const best = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  return best && best[1].length >= 3 ? { prefix: best[0], urls: best[1] } : null;
}
export function rssItems(xml) {
  return [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => {
    const t = m[0].match(/<title[^>]*>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/i)?.[1] ?? '';
    const l = m[0].match(/<link>\s*(?:<!\[CDATA\[)?([^<\]]+)/i)?.[1] ?? m[0].match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ?? '';
    return { title: textOf(t), url: decode(l.trim()) };
  });
}
export const RSS_LIST = (url) => ({
  kind: 'html', url, page_size: 100000, max_pages: 1,
  items: '<(item|entry)\\b[\\s\\S]*?</(?:item|entry)>',
  fields: { title: '<title[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</title>', url: '<link>\\s*(?:<!\\[CDATA\\[)?\\s*([^<\\]\\s]+)', postedAt: '<pubDate>([^<]+)</pubDate>' },
});

/** Inline JSON state a JS app ships in its HTML (__NEXT_DATA__, __NUXT__, window.__INITIAL_STATE__): job arrays inside it. */
export function inlineJsonJobs(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/(?:json|ld\+json)["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const arr = jobArrays(JSON.parse(m[1])); if (arr.length) out.push(...arr); } catch {}
  }
  return out.sort((a, b) => b.score - a.score);
}
