#!/usr/bin/env node
// Finds company job boards (ATS feeds) the crawler does not track yet, from URLs you already have:
// the apply links in the crawl history (aggregators link straight to the employer's ATS) and any extra URLs
// you pass in (search results, LinkedIn/Indeed company pages resolved to a careers URL, ...).
// Every candidate is probed against its live feed; nothing is added automatically.
//
//   node crawler/discover.mjs [--data <dir>] [--urls <file with one URL per line>] [--names "A, B" | <file>] [--min-jobs 1]
//
// Prints one line per new board: provider/slug, how many jobs it lists, how many of them pass the crawler's
// broad filter, the company name(s) seen, and a ready-to-paste companies.json entry.
//
//   node crawler/discover.mjs --profile <dir> [--data <dir>] [--urls <file>] [--names "A, B" | <file>] [--sites <file>] [--catalog] [--min-jobs 1]
//   --catalog probes the employers of the profile's crawl.catalogue_file (optional key).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { providers, resolve as resolveEntry } from './providers.mjs';
import { harvestTable } from './providers-extra.mjs';
import { loadProfile, profileDirFromArgs, resolveDataDir, applyProfileFilters } from './profile.mjs';

const args = process.argv.slice(2);
const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
let PROFILE;
try { PROFILE = loadProfile(profileDirFromArgs(args)); } catch (e) { console.error(`discover: ${e.message}`); process.exit(2); }
if (!PROFILE) { console.error('discover: no profile. Pass --profile <dir> (or set JOBCRAWL_PROFILE).'); process.exit(2); }
const DATA = resolveDataDir(opt('data'), PROFILE);
const MIN_JOBS = Number(opt('min-jobs') ?? 1);
const cfg = applyProfileFilters(JSON.parse(readFileSync(PROFILE.companiesFile, 'utf8')), PROFILE);

// Only real per-company ATS providers; the aggregators in providers.mjs are sources, not employers.
const ATS_BASE = ['greenhouse', 'ashby', 'lever', 'personio', 'smartrecruiters', 'teamtailor', 'recruitee', 'workable', 'csod', 'join', 'softgarden', 'eightfold', 'oraclecloud', 'workday', 'rippling', 'bamboohr', 'concludis', 'factorial', 'umantis', 'breezy', 'pinpoint', 'avature', 'successfactors', 'adp', 'ultipro', 'icims', 'jibe', 'comeet', 'gem', 'deel', 'paylocity', 'zohorecruit', 'odoo', 'jobscore', 'jazzhr'];
// Vendors from providers-extra.mjs (harvestTable) are detected from URLs too.
const ATS = [...ATS_BASE, ...harvestTable.map((t) => t.providerId).filter((id) => !ATS_BASE.includes(id) && providers[id])];
const key = (p, s) => `${p}:${String(s).toLowerCase()}`;

const known = new Set(cfg.tracked_companies.map((c) => resolveEntry(c)).filter(Boolean).map((r) => key(r.provider, r.slug)));
const found = new Map();   // key -> { provider, slug, names:Set, urls:Set }
function consider(url, name) {
  for (const p of ATS) {
    let slug = null;
    try { slug = providers[p].detect(url); } catch {}
    if (!slug) continue;
    const k = key(p, slug);
    if (known.has(k)) return;
    if (!found.has(k)) found.set(k, { provider: p, slug, names: new Set(), urls: new Set() });
    const f = found.get(k);
    if (name) f.names.add(name.replace(/\s*\(via [^)]*\)\s*$/, ''));
    if (f.urls.size < 2) f.urls.add(url);
    return;
  }
}

const HISTORY = resolve(DATA, 'scan-history.tsv');
if (existsSync(HISTORY)) {
  for (const line of readFileSync(HISTORY, 'utf8').split(/\r?\n/).slice(1)) {
    const [url, company] = line.split('\t');
    if (url) consider(url, company);
  }
}
if (opt('urls')) for (const u of readFileSync(opt('urls'), 'utf8').split(/\r?\n/)) if (u.trim()) consider(u.trim(), '');

// --names "Company A, Company B" (or a file with one name per line): try likely board slugs on every supported ATS.
if (opt('names')) {
  const raw = existsSync(opt('names')) ? readFileSync(opt('names'), 'utf8').split(/\r?\n/) : opt('names').split(',');
  for (const name of raw.map((n) => n.trim()).filter(Boolean)) {
    const base = name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]+/g, '').trim();
    const flat = base.replace(/ +/g, ''), dash = base.replace(/ +/g, '-');
    const slugs = [...new Set([flat, dash, `${flat}gmbh`, `${dash}-gmbh`, `${flat}space`, `${flat}inc`, `${flat}ag`])];
    for (const p of (opt('providers') ?? 'greenhouse,ashby,lever,personio,smartrecruiters,teamtailor,recruitee,workable,join,softgarden,breezy,pinpoint').split(',')) {
      for (const base of slugs) {
        const slug = p === 'softgarden' ? `${base}.softgarden.io` : base;   // that provider's slug is the tenant host
        const k = key(p, slug);
        if (known.has(k) || found.has(k)) continue;
        found.set(k, { provider: p, slug, names: new Set([name]), urls: new Set(), guessed: true });
      }
    }
  }
}

// --catalog: probe all untracked companies of the profile's catalogue file (crawl.catalogue_file)
if (args.includes('--catalog')) {
  const catPath = PROFILE.catalogueFile;
  if (catPath && existsSync(catPath)) {
    const cat = JSON.parse(readFileSync(catPath, 'utf8'));
    const trackedNames = new Set(cfg.tracked_companies.map((c) => c.name.toLowerCase()));
    for (const c of cat.companies ?? []) {
      if (trackedNames.has(c.name.toLowerCase())) continue;
      const base = c.name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]+/g, '').trim();
      const flat = base.replace(/ +/g, ''), dash = base.replace(/ +/g, '-');
      const slugs = [...new Set([flat, dash, `${flat}gmbh`, `${dash}-gmbh`, `${flat}space`, `${flat}inc`, `${flat}ag`])];
      for (const p of (opt('providers') ?? 'greenhouse,ashby,lever,personio,smartrecruiters,teamtailor,recruitee,workable,join,softgarden,breezy,pinpoint').split(',')) {
        for (const b of slugs) {
          const slug = p === 'softgarden' ? `${b}.softgarden.io` : b;
          const k = key(p, slug);
          if (known.has(k) || found.has(k)) continue;
          found.set(k, { provider: p, slug, names: new Set([c.name]), urls: new Set(), guessed: true });
        }
      }
    }
  }
}

// --sites <file>: lines of "Company | https://company.example/careers" (or just a URL). The page is fetched, plus
// the career/job links found on it (one hop), and searched for embedded ATS links. If none is found, the site's
// sitemap is checked for job URLs and the job pages for schema.org JobPosting markup, so the entry can use the
// generic `sitemap` provider.
const UA = 'Mozilla/5.0 (compatible; jobcrawl; +https://github.com/egidinas/jobcrawl)';
const page = async (u) => {
  try {
    const r = await fetch(u, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    return r.ok ? { url: r.url, html: await r.text() } : null;
  } catch { return null; }
};
const urlsIn = (html) => [...new Set([...html.matchAll(/(?:https?:)?\/\/[\w.-]+\.[a-z]{2,}[^\s"'<>)\\]*/gi)].map((m) => (m[0].startsWith('//') ? 'https:' + m[0] : m[0])))];
// Job systems we have no provider for yet (Taleo, Jobvite, PageUp and the freehire vendors are supported now, see providers-extra.mjs), with the career-ops (MIT) implementation to read before writing one.
// Rule of thumb for an unknown system: look it up in SUPPORTED_JOB_BOARDS.md first; if career-ops has a provider,
// port the approach into providers.mjs (own code, one function, same output shape) and add a detect marker here.
const CAREER_OPS = 'https://github.com/career-ops-hq/career-ops/blob/main';
const KNOWN_SYSTEMS = [
  ['SAP SuccessFactors', /successfactors|sapsf\./i, 'successfactors', 'Try provider "sitemap" first (real dates).'],
  ['iCIMS', /icims\.com/i, 'icims'], ['Phenom', /phenompeople|phenom\.com/i, 'phenom'],
  ['Avature', /avature\.net/i, 'avature'], ['Breezy HR', /breezy\.hr/i, 'breezy'],
  ['Comeet', /comeet\.(?:co|com)/i, 'comeet'], ['Pinpoint', /pinpointhq\.com/i, 'pinpoint'], ['JazzHR', /applytojob\.com|jazz\.co/i, 'jazzhr'],
  ['UKG Pro / UltiPro', /ultipro\.com|ukg\.com/i, 'ultipro'], ['JibeApply', /jibeapply|jibe\.com/i, 'jibeapply'],
  ['Radancy / TMP', /radancy|tmpwebeng/i, 'radancy'], ['Gem', /jobs\.gem\.com/i, 'gem'], ['Getro', /getro\.com/i, 'getro'],
  ['d.vinci', /d-vinci/i, null], ['rexx', /rexx-systems/i, null],
];


const notes = [];
if (opt('sites')) {
  const lines = readFileSync(opt('sites'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  await Promise.all(lines.map(async (line) => {
    const [a, b] = line.includes('|') ? line.split('|').map((x) => x.trim()) : ['', line];
    const first = await page(b);
    if (!first) return notes.push(`${a || b}: not reachable`);
    const pages = [first];
    const hops = urlsIn(first.html).filter((u) => new URL(u).host === new URL(first.url).host && /career|karriere|jobs?\b|stellen|join/i.test(u) && !/\.(png|jpe?g|svg|css|js|pdf)(\?|$)/i.test(u)).slice(0, 4);
    for (const h of hops) { const p = await page(h); if (p) pages.push(p); }
    const before = found.size;
    for (const p of pages) for (const u of urlsIn(p.html)) consider(u, a);
    if (found.size > before) return;
    const html = pages.map((p) => p.html).join(' ');
    const hits = KNOWN_SYSTEMS.filter(([, rx]) => rx.test(html));
    for (const [name, , ref, hint] of hits) notes.push(`${a || b}: uses ${name} - not supported yet. ${hint ? hint + ' ' : ''}Reference implementation: ${ref ? `${CAREER_OPS}/providers/${ref}.mjs` : `${CAREER_OPS}/docs/SUPPORTED_JOB_BOARDS.md`}`);
    const origin = new URL(first.url).origin;
    const sm = await page(origin + '/sitemap.xml');
    const jobUrls = sm ? [...sm.html.matchAll(/<loc>([^<]*\/(?:jobs?|stellen|stellenangebote|karriere|career|careers)\/[^<]+)<\/loc>/gi)].map((m) => m[1]) : [];
    const ld = pages.some((p) => /"JobPosting"|schema\.org\/JobPosting/.test(p.html));
    notes.push(`${a || b}: no known ATS link${jobUrls.length ? `; sitemap lists ${jobUrls.length} job-like URLs, e.g. ${jobUrls[0]} -> try provider "sitemap"` : ''}${ld ? '; JobPosting markup on the page' : ''}${!jobUrls.length && !ld ? '; JS-rendered or custom, needs manual work; check ' + CAREER_OPS + '/docs/SUPPORTED_JOB_BOARDS.md for a known implementation' : ''}`);
  }));
}

console.log(`${found.size} candidate boards not yet tracked; probing...`);
const norm = (s) => (s ?? '').toLowerCase();
const pass = (j) => {
  const f = cfg.title_filter, l = cfg.location_filter;
  const hit = (list = [], t) => list.some((k) => (k.startsWith('word:') ? new RegExp(`\\b${norm(k.slice(5))}\\b`).test(norm(t)) : norm(t).includes(norm(k))));
  return !hit(f.negative, j.title) && hit(f.positive, j.title) && (!j.location || hit(l.allow, j.location));
};
const rows = [];
let i = 0;
await Promise.all(Array.from({ length: 12 }, async () => {
  const list = [...found.values()];
  while (i < list.length) {
    const c = list[i++];
    try {
      const jobs = await providers[c.provider].fetch(c.slug, {});
      if (jobs.length >= MIN_JOBS) rows.push({ ...c, jobs: jobs.length, matching: jobs.filter(pass).length, sample: jobs.filter(pass).slice(0, 2).map((j) => `${j.title} (${j.location || '?'})`) });
    } catch {}
  }
}));
rows.sort((a, b) => b.matching - a.matching || b.jobs - a.jobs);
for (const r of rows) {
  const name = [...r.names][0] ?? r.slug;
  const careers = [...r.urls][0] ?? '';
  console.log(`${r.provider}/${r.slug}  jobs=${r.jobs} matching=${r.matching}  seen as: ${[...r.names].slice(0, 3).join(' | ') || '-'}`);
  if (r.sample.length) console.log(`    e.g. ${r.sample.join('; ')}`);
  console.log(`    ${JSON.stringify({ name, careers_url: careers || undefined, provider: r.provider, slug: r.slug, enabled: true })}`);
}
for (const n of notes) console.log(`note: ${n}`);
console.log(`\n${rows.length} boards answer with jobs. Review them, then paste the wanted entries into ${PROFILE.companiesFile}.`);
