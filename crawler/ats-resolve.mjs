#!/usr/bin/env node
// Finds the ATS board of every company on the specialised space job boards (or of any seed list), in two stages:
//
//   1. HARVEST. The boards link to the employer's own apply page (Space Capital/Getro: 34k jobs, Space Individuals, Space-Careers,
//      SpaceJobSearch). An apply URL on greenhouse/lever/personio/... IS the answer, no guessing. The employer's own domain
//      (Getro `domain`, JSON-LD `sameAs`, non-ATS apply hosts) is kept for stage 2.
//   2. FUZZ the rest. Slugs are generated in tiers from patterns seen on the boards we already resolved (see TIERS), probed
//      with a cheap per-provider existence request, and every hit is VERIFIED: the board's own company name (Greenhouse,
//      Recruitee, Workable, Personio, JOIN, Breezy, SmartRecruiters, Teamtailor) or the employer's domain/name in its
//      postings must match, otherwise the guess is `name-mismatch` (e.g. `esri` is not Esri Deutschland, `open` is not OPEN MIND).
//
// Nothing is added to the companies file automatically; review the CSV/JSON and paste the wanted entries.
//
//   node crawler/ats-resolve.mjs --profile <dir> [--data <dir>] [--label space_boards] [--seed <file.json|names.txt>] [--tiers 3]
//        [--providers greenhouse,lever,...] [--no-fuzz] [--no-site] [--no-harvest] [--refresh] [--limit N] [--concurrency 16]
//        [--max-minutes N] [--retest]
//
// --seed takes a JSON array of { name | unitName, website | companyWebsite | domain } or one name per line.
// Without --seed the space boards are harvested (the harvest stage is specific to those boards; --seed works for any list).
// State (positive/negative probe cache, harvest cache) is kept in <data>/ats-resolve-cache.json so reruns and later seed lists are incremental.
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { providers, resolve as resolveEntry } from './providers.mjs';
import { harvestTable } from './providers-extra.mjs';
import { loadProfile, profileDirFromArgs, resolveDataDir } from './profile.mjs';

const args = process.argv.slice(2);
const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const flag = (n) => args.includes(`--${n}`);
let PROFILE;
try { PROFILE = loadProfile(profileDirFromArgs(args)); } catch (e) { console.error(`ats-resolve: ${e.message}`); process.exit(2); }
if (!PROFILE) { console.error('ats-resolve: no profile. Pass --profile <dir> (or set JOBCRAWL_PROFILE).'); process.exit(2); }
const DATA = resolveDataDir(opt('data'), PROFILE);
const LABEL = opt('label') ?? 'space_boards';
const MAX_TIER = Number(opt('tiers') ?? 2);
const CONC = Number(opt('concurrency') ?? 16);
const LIMIT = Number(opt('limit') ?? 0);
const DEADLINE = opt('max-minutes') ? Date.now() + Number(opt('max-minutes')) * 60000 : 0;   // stop starting new companies after this
const NEG_TTL_DAYS = 14;
const UA = 'Mozilla/5.0 (compatible; jobcrawl; +https://github.com/egidinas/jobcrawl)';
const cfg = JSON.parse(readFileSync(PROFILE.companiesFile, 'utf8'));

// ---------- text helpers ----------
const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase();
const LEGAL = new Set('gmbh ag se inc ltd llc bv kg mbh sa sas srl spa oy ab as plc limited corp corporation co company ug eg ev kgaa nv pte pty'.split(' '));
const GENERIC = new Set('deutschland germany europe europa international global group holding holdings the and for von der die und of'.split(' '));
const words = (name) => fold(name).replace(/\([^)]*\)/g, ' ').replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
const stripLegal = (name) => words(name).filter((w) => !LEGAL.has(w));
const stripMore = (name) => stripLegal(name).filter((w) => !GENERIC.has(w) && !['systems', 'solutions', 'technologies', 'technology'].includes(w));
const sigTokens = (name) => { const t = stripMore(name).filter((w) => w.length >= 3); return t.length ? t : stripLegal(name).filter((w) => w.length >= 3); };
const recKey = (name) => stripLegal(name).join('');
const acronym = (name) => stripMore(name).map((w) => w[0]).join('');

function domainOf(u) {
  if (!u) return '';
  try { return new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}
const SLD = new Set(['co', 'com', 'org', 'ac', 'gov', 'net']);
function domainStem(host) {
  const l = host.split('.');
  if (l.length < 2) return '';
  return SLD.has(l[l.length - 2]) && l.length >= 3 ? l[l.length - 3] : l[l.length - 2];
}

// ---------- HTTP with per-host-family limits and 429 back-off ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostGates = new Map();
// One shared API host (greenhouse, lever, ashby...) gets few parallel requests; families where every company has its own
// subdomain (personio, recruitee, ...) spread over many hosts and tolerate more.
const SUBDOMAIN_FAMILY = /^(personio\.(de|com)|recruitee\.com|teamtailor\.com|softgarden\.io|bamboohr\.com|breezy\.hr|pinpointhq\.com)$/;
const stats = { requests: 0, rate: 0, transient: 0, errs: {} };
const inflight = new Map();   // probe key -> start time, for the heartbeat
function gateOf(url) {
  const h = new URL(url).hostname.split('.').slice(-2).join('.');
  if (!hostGates.has(h)) hostGates.set(h, { active: 0, q: [], pauseUntil: 0, max: h === 'workable.com' ? 2 : SUBDOMAIN_FAMILY.test(h) ? 20 : 8 });
  return hostGates.get(h);
}
async function acquire(g) { if (g.active < g.max) { g.active++; return; } await new Promise((r) => g.q.push(r)); }
function release(g) { const n = g.q.shift(); if (n) n(); else g.active--; }
async function req(url, { method = 'GET', headers = {}, body } = {}) {
  const g = gateOf(url);
  await acquire(g);
  try {
    for (let a = 0; a < 3; a++) {
      if (g.pauseUntil > Date.now()) await sleep(g.pauseUntil - Date.now());
      stats.requests++;
      let r;
      try {
        r = await fetch(url, { method, headers: { 'user-agent': UA, accept: 'application/json, text/xml, text/html, */*', ...headers }, body, redirect: 'follow', signal: AbortSignal.timeout(9000) });
      } catch (e) { const code = e.cause?.code || e.name || e.message; stats.errs[code] = (stats.errs[code] || 0) + 1; return { status: 0, text: '', err: code }; }
      if (r.status === 429 || r.status === 503) { stats.rate++; g.pauseUntil = Date.now() + 4000; if (a >= 1) break; continue; }
      return { status: r.status, text: (await r.text()).slice(0, 6000000), url: r.url };
    }
    return { status: 429, text: '' };
  } finally { release(g); }
}
class Transient extends Error {}
async function preq(url, o) {
  const r = await req(url, o);
  if (r.status === 0 || r.status === 429) throw new Transient(`${r.status} ${r.err ?? ''} ${url}`);
  return r;
}
function withTimeout(p, ms, label) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Transient(`timeout ${label}`)), ms); })]).finally(() => clearTimeout(t));
}
const jsonOf = (r) => { try { return JSON.parse(r.text); } catch { return null; } };

// ---------- cache ----------
const CACHE = resolve(DATA, 'ats-resolve-cache.json');
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : { miss: {}, hit: {}, harvest: null };
cache.miss ??= {}; cache.hit ??= {}; cache.site ??= {};
function saveCache() { const t = CACHE + '.tmp'; writeFileSync(t, JSON.stringify(cache)); renameSync(t, CACHE); }
const missFresh = (k) => cache.miss[k] && Date.now() - cache.miss[k] < NEG_TTL_DAYS * 864e5;

// ---------- existence probes (cheap, one request unless the board answers) ----------
// Each returns null (no board with jobs) or { board_name, jobs, titles[], text }.
// Vendors from providers-extra.mjs get their probe from harvestTable (below the hand-written ones).
const firstN = (a, n = 6) => a.slice(0, n);
const PROBES = {
  async greenhouse(s) {
    const r = await preq(`https://boards-api.greenhouse.io/v1/boards/${s}`);
    const b = r.status === 200 ? jsonOf(r) : null;
    if (!b?.name) return null;
    const jr = await preq(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`);
    const jobs = jsonOf(jr)?.jobs ?? [];
    if (!jobs.length) return null;
    return { board_name: b.name, jobs: jobs.length, titles: firstN(jobs.map((j) => `${j.title} (${j.location?.name ?? '?'})`)), text: jobs.slice(0, 5).map((j) => `${j.title} ${j.absolute_url}`).join(' ') };
  },
  async lever(s, host = 'api.lever.co') {
    const r = await preq(`https://${host}/v0/postings/${s}?mode=json&limit=50`);
    const a = r.status === 200 ? jsonOf(r) : null;
    if (!Array.isArray(a) || !a.length) return null;
    return { board_name: '', jobs: a.length, titles: firstN(a.map((j) => `${j.text} (${j.categories?.location ?? '?'})`)), text: a.slice(0, 4).map((j) => `${j.text} ${j.hostedUrl} ${(j.descriptionPlain ?? '').slice(0, 1500)}`).join(' ') };
  },
  async 'lever-eu'(s) { return PROBES.lever(s, 'api.eu.lever.co'); },
  async ashby(s) {
    const r = await preq(`https://api.ashbyhq.com/posting-api/job-board/${s}`);
    const j = r.status === 200 ? jsonOf(r) : null;
    const a = j?.jobs ?? [];
    if (!a.length) return null;
    return { board_name: '', jobs: a.length, titles: firstN(a.map((x) => `${x.title} (${x.location ?? '?'})`)), text: a.slice(0, 4).map((x) => `${x.title} ${x.jobUrl} ${(x.descriptionPlain ?? '').slice(0, 1500)}`).join(' ') };
  },
  async personio(s) {
    for (const tld of ['de', 'com']) {
      const r = await preq(`https://${s}.jobs.personio.${tld}/xml`);
      if (r.status !== 200 || !/<position>/.test(r.text)) continue;
      const names = [...new Set([...r.text.matchAll(/<subcompany>([^<]*)</g)].map((m) => m[1].trim()).filter(Boolean))];
      if (names.some((n) => /^(Kolhorn|Mutter AG|Tochter \d)/i.test(n))) continue;   // Personio's demo data, not a real board
      const titles = [...r.text.matchAll(/<name>([^<]*)<\/name>/g)].map((m) => m[1].trim());
      return { board_name: names.join(' | '), jobs: (r.text.match(/<position>/g) ?? []).length, titles: firstN(titles), text: r.text.slice(0, 6000), tld };
    }
    return null;
  },
  async recruitee(s) {
    const r = await preq(`https://${s}.recruitee.com/api/offers/`);
    const o = r.status === 200 ? jsonOf(r)?.offers : null;
    if (!o?.length) return null;
    return { board_name: o[0].company_name ?? '', jobs: o.length, titles: firstN(o.map((x) => `${x.title} (${x.location ?? '?'})`)), text: o.slice(0, 3).map((x) => `${x.title} ${x.careers_url ?? ''}`).join(' ') };
  },
  async join(s) {
    const r = await preq(`https://join.com/companies/${s}`);
    if (r.status !== 200) return null;
    const raw = r.text.match(/<script[^>]+__NEXT_DATA__[^>]*>([\s\S]*?)<\/script>/)?.[1];
    let st; try { st = JSON.parse(raw)?.props?.pageProps?.initialState; } catch { return null; }
    const items = st?.jobs?.items ?? [];
    if (!items.length) return null;
    return { board_name: st.company?.name ?? '', jobs: st.jobs.pagination?.total ?? items.length, titles: firstN(items.map((x) => `${x.title} (${x.city?.cityName ?? '?'})`)), text: `${st.company?.domain ?? ''} ${st.company?.websiteUrl ?? ''} ${items.slice(0, 3).map((x) => x.title).join(' ')}` };
  },
  async workable(s) {
    const r = await preq(`https://apply.workable.com/api/v1/widget/accounts/${s}`);
    const j = r.status === 200 ? jsonOf(r) : null;
    if (!j?.jobs?.length) return null;
    return { board_name: j.name ?? '', jobs: j.jobs.length, titles: firstN(j.jobs.map((x) => `${x.title} (${x.city ?? '?'})`)), text: j.jobs.slice(0, 3).map((x) => x.title).join(' ') };
  },
  async teamtailor(s) {
    const r = await preq(`https://${s}.teamtailor.com/jobs.rss`);
    if (r.status !== 200 || !/<item>/.test(r.text)) return null;
    const ch = r.text.match(/<channel>[\s\S]*?<title>([^<]*)</)?.[1] ?? '';
    const titles = [...r.text.matchAll(/<item>[\s\S]*?<title>([^<]*)</g)].map((m) => m[1].trim());
    return { board_name: ch.replace(/^\s*(jobs? at|careers? at)\s*/i, '').trim(), jobs: titles.length, titles: firstN(titles), text: r.text.slice(0, 5000) };
  },
  async softgarden(s) {
    const r = await preq(`https://${s}.softgarden.io/de/widgets/jobs`);
    if (r.status !== 200 || !/job_id_/.test(r.text)) return null;
    const titles = [...r.text.matchAll(/<a href="[^"]*\/job\/[^"]+"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
    return { board_name: '', jobs: titles.length || 1, titles: firstN(titles), text: r.text.slice(0, 6000) };
  },
  async bamboohr(s) {
    const r = await preq(`https://${s}.bamboohr.com/jobs/embed2.php`);
    if (r.status !== 200) return null;
    const j = jsonOf(r);
    const a = [...(j?.departments ?? []).flatMap((d) => d.positions ?? []), ...(j?.result ?? [])];
    if (!a.length) return null;
    return { board_name: '', jobs: a.length, titles: firstN(a.map((x) => `${x.name ?? x.jobOpeningName ?? x.title} (${typeof x.location === 'string' ? x.location : x.location?.city ?? '?'})`)), text: a.slice(0, 4).map((x) => `${x.name ?? ''} ${x.jobOpeningName ?? ''}`).join(' ') };
  },
  async breezy(s) {
    const r = await preq(`https://${s}.breezy.hr/json`);
    const a = r.status === 200 ? jsonOf(r) : null;
    if (!Array.isArray(a) || !a.length) return null;
    return { board_name: a[0].company?.name ?? '', jobs: a.length, titles: firstN(a.map((x) => `${x.name} (${x.location?.name ?? '?'})`)), text: a.slice(0, 3).map((x) => x.name).join(' ') };
  },
  async pinpoint(s) {
    const r = await preq(`https://${s}.pinpointhq.com/postings.json`);
    const a = r.status === 200 ? jsonOf(r)?.data : null;
    if (!a?.length) return null;
    return { board_name: '', jobs: a.length, titles: firstN(a.map((x) => x.title)), text: a.slice(0, 3).map((x) => `${x.title} ${x.url ?? ''}`).join(' ') };
  },
  async smartrecruiters(s) {
    const r = await preq(`https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=5`);
    const j = r.status === 200 ? jsonOf(r) : null;
    if (!j?.totalFound) return null;
    return { board_name: j.content?.[0]?.company?.name ?? '', jobs: j.totalFound, titles: firstN((j.content ?? []).map((x) => `${x.name} (${x.location?.city ?? '?'})`)), text: (j.content ?? []).map((x) => x.name).join(' ') };
  },
};
for (const t of harvestTable) {
  if (PROBES[t.providerId]) continue;
  PROBES[t.providerId] = async (slug) => {
    const r = await t.probe(slug);
    return r.exists ? { board_name: r.companyName ?? '', jobs: r.jobCount ?? r.jobIds.length, titles: r.sample ?? [], text: (r.sample ?? []).join(' ') } : null;
  };
}
// Providers with few hits on the boards resolved so far (reference profile: join 44, personio 22, bamboohr 15, greenhouse 12, softgarden 6, teamtailor 4)
// are only tried with the tier-1 slugs.
const TIER1_ONLY = new Set(['lever-eu', 'smartrecruiters', 'pinpoint', 'breezy']);
const FUZZ_PROVIDERS = (opt('providers') ?? 'greenhouse,lever,lever-eu,ashby,personio,recruitee,join,teamtailor,softgarden,bamboohr,breezy,pinpoint,smartrecruiters').split(',');
// What the probe name maps to in companies.json.
const entryFor = (provider, slug, name, probe) => {
  const base = provider === 'lever-eu' ? 'lever' : provider;
  const careers = {
    greenhouse: `https://boards.greenhouse.io/${slug}`, ashby: `https://jobs.ashbyhq.com/${slug}`, lever: `https://jobs.${provider === 'lever-eu' ? 'eu.' : ''}lever.co/${slug}`,
    personio: `https://${slug}.jobs.personio.${probe?.tld ?? 'de'}`, recruitee: `https://${slug}.recruitee.com`, join: `https://join.com/companies/${slug}`,
    workable: `https://apply.workable.com/${slug}`, teamtailor: `https://${slug}.teamtailor.com`, softgarden: `https://${slug}.softgarden.io`,
    bamboohr: `https://${slug}.bamboohr.com/careers`, breezy: `https://${slug}.breezy.hr`, pinpoint: `https://${slug}.pinpointhq.com`,
    smartrecruiters: `https://careers.smartrecruiters.com/${slug}`,
  }[provider] ?? '';
  return { name, careers_url: careers, provider: base, slug: base === 'softgarden' ? `${slug}.softgarden.io` : slug, ...(provider === 'lever-eu' ? { region: 'eu' } : {}), enabled: true };
};

// ---------- slug candidates, in tiers by observed hit rate on the boards resolved so far ----------
const uniq = (a) => [...new Set(a.filter((s) => s && s.length >= 3 && s.length <= 60))];
function candidates(rec, tier) {
  const L = stripLegal(rec.name), M = stripMore(rec.name), R = words(rec.name);
  const flat = (w) => w.join(''), dash = (w) => w.join('-');
  const doms = [...rec.domains].map(domainOf).filter(Boolean);
  const stems = doms.map(domainStem).filter(Boolean);
  if (tier === 1) return uniq([flat(L), dash(L), flat(M), dash(M), ...stems, ...stems.map((s) => s.replace(/-/g, ''))]);
  if (tier === 2) {
    const f = flat(L), d = dash(L);
    return uniq([flat(R), dash(R), flat(L.slice(0, 2)), dash(L.slice(0, 2)), `${f}gmbh`, `${d}-gmbh`, `${f}inc`, `${d}-inc`, `${f}industries`, `${f}corporation`, `${f}group`, `${d}-group`,
      `${f}se`, `${f}ag`, `${f}space`, `${d}-space`, `${f}aerospace`, `${f}technologies`, `${f}-careers`, ...doms.map((h) => h.replace(/\./g, '')), ...doms.map((h) => h.replace(/\./g, '-'))]);
  }
  const ac = acronym(rec.name);
  return uniq([L[0], M[0], ac.length >= 3 ? ac : '', `${flat(L)}-prod`, `${d2(L)}-prod`, `${flat(L)}careers`, `${flat(L)}jobs`, `${flat(L)}-de`, `${flat(L)}de`]);
}
const d2 = (w) => w.join('-');

// ---------- verification ----------
function verify(rec, probe, slug, tier) {
  const toks = sigTokens(rec.name);
  // A domain is evidence only when it relates to the company's own name: a seed whose website is a parent, host or unrelated site
  // (the slug would then come from that domain and the board would "confirm" itself) must not verify anything.
  const flatName = toks.join('');
  const related = (s) => {
    const x = s.replace(/[^a-z0-9]/g, '');
    let n = 0;
    while (n < x.length && n < flatName.length && x[n] === flatName[n]) n++;
    return x.length >= 4 && flatName.length >= 3 && (n >= Math.min(4, flatName.length) || flatName.includes(x) || x.includes(flatName));
  };
  const stems = [...rec.domains].map(domainOf).map(domainStem).filter((s) => s.length >= 4 && related(s));
  const text = fold(`${probe.board_name} ${probe.text}`);
  const domHit = stems.some((s) => text.includes(s));
  let status;
  if (probe.board_name) {
    const bn = fold(probe.board_name);
    const bt = toks.filter((t) => bn.includes(t)).length;
    const bnFlat = bn.replace(/[^a-z0-9]/g, '');
    // a board named just "HTM" for "HTM Helicopter Travel Munich": its whole name is the company's first word or initials
    const nameOk = toks.length && (bt / toks.length >= 0.6 || bnFlat.includes(toks.join('')) || (bnFlat.length >= 3 && (bnFlat === toks[0] || bnFlat === toks.map((x) => x[0]).join(''))));
    const domInName = stems.some((x) => bn.replace(/[^a-z0-9]/g, '').includes(x.replace(/[^a-z0-9]/g, '')));
    status = nameOk || domInName ? 'verified' : bt === 0 ? 'name-mismatch' : 'plausible';
  } else {
    const tt = toks.filter((t) => text.includes(t)).length;
    const exact = [stripLegal(rec.name).join(''), toks.join('')].includes(slug) && slug.length >= 6;
    status = domHit ? 'verified' : (toks.length && tt === toks.length && toks.join('').length >= 6) || exact ? 'plausible' : 'name-mismatch';
  }
  // Short or generic slugs and tier-3 guesses are only accepted when verified outright.
  if (status === 'plausible' && (tier >= 3 || slug.length < 5)) status = 'name-mismatch';
  return status;
}

// ---------- stage 1: harvest company names + apply links from the space boards ----------
const ATS_BASE = ['greenhouse', 'ashby', 'lever', 'personio', 'smartrecruiters', 'teamtailor', 'recruitee', 'workable', 'join', 'softgarden', 'bamboohr', 'breezy', 'pinpoint', 'rippling', 'csod', 'workday', 'successfactors', 'umantis', 'avature', 'eightfold', 'oraclecloud',
  'adp', 'ultipro', 'icims', 'jibe', 'comeet', 'gem', 'deel', 'paylocity', 'zohorecruit', 'odoo', 'jobscore', 'jazzhr', 'lucca', 'onlyfy', 'hrlab', 'factorial'];
// Vendors from providers-extra.mjs (harvestTable) are detected from apply/careers links too; the table is the single source of host patterns.
const ATS = [...ATS_BASE, ...harvestTable.map((t) => t.providerId).filter((id) => !ATS_BASE.includes(id) && providers[id])];
const records = new Map();   // recKey -> { name, domains:Set, sources:Set, links:Map(key->{provider,slug,n}), applyHosts:Set }
function rec(name, source) {
  const clean = String(name ?? '').replace(/\s*\(via [^)]*\)\s*$/, '').trim();
  const k = recKey(clean);
  if (!k || k.length < 2) return null;
  if (!records.has(k)) records.set(k, { name: clean, domains: new Set(), sources: new Set(), links: new Map(), applyHosts: new Set() });
  const r = records.get(k);
  r.sources.add(source);
  return r;
}
const AGGREGATOR_HOST = /spacetalent\.org|eurosciencejobs|eurotechjobs|googleapis\.|gstatic\.|linkedin\.|indeed\.|glassdoor\.|spacecapital\.com|getro\.com|space-careers|spaceindividuals|spacejobsearch|google\.|facebook\.|twitter\.|x\.com|xing\.|stepstone|monster\.|jobs\.ch|euroengineerjobs|eurojobsites|euroclimatejobs|browsehappy|applytojob\.com|workday\.com\/?$/i;
const JUNK_SLUG = new Set(['www', 'app', 'apply', 'jobs', 'careers', 'api', 'static', 'cdn', 'help', 'support']);
// ATS vendors the crawler has no provider for: an unresolved company that applies through one is reported as such.
const UNSUPPORTED = [[/clarityloop|hr\.clarity/i, 'Clarity'],
  [/careers-page\.com/i, 'careers-page.com'], [/brassring/i, 'BrassRing'], [/werecruit\.io/i, 'WeRecruit'], [/hrmos\.co/i, 'HRMOS'], [/applicantpro/i, 'ApplicantPro'], [/jobylon/i, 'Jobylon'],
  [/dayforce|ceridian/i, 'Dayforce'], [/paychex|isolvedhire|trinet|zohorecruit|zoho\./i, 'Payroll-ATS'], [/phenom|radancy|tmp\./i, 'Phenom/Radancy'],
  [/amazon\.jobs/i, 'Amazon Jobs'], [/github\.io/i, 'own page (github.io)']];
function link(r, url) {
  if (!r || !url) return;
  for (const [rx, label] of UNSUPPORTED) if (rx.test(url)) r.unsupported = (r.unsupported ?? new Set()).add(label);
  for (const p of ATS) {
    let s = null;
    try { s = providers[p]?.detect(url); } catch { /* detect may reject odd URLs */ }
    if (!s || JUNK_SLUG.has(String(s).toLowerCase())) continue;
    const k = `${p}:${String(s).toLowerCase()}`;
    const e = r.links.get(k) ?? { provider: p, slug: s, n: 0 };
    e.n++; r.links.set(k, e);
    return;
  }
  const h = domainOf(url);
  if (h && !AGGREGATOR_HOST.test(url)) { r.domains.add(h); r.applyHosts.add(h); }
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const it = items[i++]; try { await fn(it); } catch { /* one failing source item must not stop the harvest */ } } }));
}
const getroPost = (path, body) => req(`https://api.getro.com/api/v2/collections/338/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }).then(jsonOf);

async function harvestBoards() {
  const t0 = Date.now();
  // Space Capital / Getro: all companies (name + domain), then every job's apply URL.
  for (let page = 0; page < 200; page++) {
    const j = await getroPost('search/companies', { hitsPerPage: 12, page, query: '' });
    const cs = j?.results?.companies ?? [];
    if (!cs.length) break;
    for (const c of cs) { const r = rec(c.name, 'Space Capital'); if (r && c.domain) r.domains.add(c.domain.toLowerCase()); }
  }
  const first = await getroPost('search/jobs', { hitsPerPage: 20, page: 0, query: '' });
  const pages = Math.min(Math.ceil((first?.results?.count ?? 0) / 20), 3000);
  await pool(Array.from({ length: pages }, (_, i) => i), 6, async (page) => {
    const j = await getroPost('search/jobs', { hitsPerPage: 20, page, query: '' });
    for (const x of j?.results?.jobs ?? []) { const r = rec(x.organization?.name, 'Space Capital'); link(r, x.url); }
  });
  // Space Individuals: one JSON document.
  const si = jsonOf(await req('https://spaceindividuals.com/get-all-jobs-published')) ?? [];
  for (const x of si) link(rec(x.companyName, 'Space Individuals'), x.applyExternalSiteInput);
  // Space-Careers: paged HTML list, apply targets are on the job pages (employer name is on the list).
  const rx = /<h3><a href="(\/job_display\/[^"]+)">[^<]+<\/a><\/h3>\s*<div class="companyName">([^<]+)<\/div>/g;
  const seen = new Set();
  for (let page = 1; page <= 40; page++) {
    const html = (await req(`https://www.space-careers.com/job_search${page > 1 ? `?page=${page}` : ''}`)).text;
    const rows = [...html.matchAll(rx)].filter((m) => !seen.has(m[1]));
    if (!rows.length) break;
    await pool(rows, 4, async (m) => {
      seen.add(m[1]);
      const r = rec(m[2].replace(/&amp;/g, '&'), 'Space-Careers');
      const jp = (await req(`https://www.space-careers.com${m[1]}`)).text;
      for (const u of jp.matchAll(/href="(https?:\/\/[^"]+)"/g)) link(r, u[1]);
    });
  }
  // SpaceJobSearch: sitemap of job pages; JSON-LD names the employer and links its careers page.
  const sm = (await req('https://spacejobsearch.com/sitemap.xml')).text;
  const jobPages = [...sm.matchAll(/<loc>([^<]+\/jobs\/[^<]+)<\/loc>/g)].map((m) => m[1]);
  await pool(jobPages, 6, async (u) => {
    const h = (await req(u)).text;
    const org = h.match(/"hiringOrganization"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]+)"(?:[^}]*?"sameAs"\s*:\s*"([^"]+)")?/);
    if (org) { const r = rec(org[1], 'SpaceJobSearch'); link(r, org[2]); }
  });
  console.log(`harvest: ${records.size} companies from the space boards in ${Math.round((Date.now() - t0) / 1000)}s`);
}

// ---------- seeds ----------
function loadSeed(file) {
  const raw = readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    for (const x of JSON.parse(raw)) {
      const r = rec(x.name ?? x.unitName, 'seed');
      const d = domainOf(x.website ?? x.companyWebsite ?? x.domain);
      if (r && d) r.domains.add(d);
    }
  } else for (const l of raw.split(/\r?\n/)) if (l.trim()) rec(l.trim(), 'seed');
}

// ---------- main ----------
const known = new Set();
const trackedNames = new Set();
for (const c of cfg.tracked_companies) {
  trackedNames.add(recKey(c.name));
  const r = resolveEntry(c);
  if (r) known.add(`${r.provider}:${String(r.slug).toLowerCase().replace(/\.softgarden\.io$/, '')}`);
}

// --retest: ignore what is already tracked, to measure how many known boards the fuzzer rediscovers.
if (flag('retest')) { known.clear(); trackedNames.clear(); }
if (opt('seed')) loadSeed(opt('seed'));
else if (!flag('no-harvest')) {
  const h = cache.harvest;
  if (h && !flag('refresh') && Date.now() - h.at < 864e5) {
    for (const x of h.records) {
      const r = rec(x.name, x.sources[0]); x.sources.forEach((s) => r.sources.add(s)); x.domains.forEach((d) => r.domains.add(d));
      x.links.forEach((l) => r.links.set(`${l.provider}:${String(l.slug).toLowerCase()}`, l)); x.applyHosts.forEach((a) => r.applyHosts.add(a));
    }
    console.log(`harvest: ${records.size} companies from cache`);
  } else {
    await harvestBoards();
    cache.harvest = { at: Date.now(), records: [...records.values()].map((r) => ({ name: r.name, sources: [...r.sources], domains: [...r.domains], links: [...r.links.values()], applyHosts: [...r.applyHosts] })) };
    saveCache();
  }
}

// Stage 1b: the employer's own site. Its home and careers pages usually embed or link the ATS board, ~4 requests per company.
const CAREER_HREF = /career|karriere|jobs?\b|stellen|join|work-with|openings/i;
async function siteScan(r) {
  const k = recKey(r.name);
  if (cache.site[k]) { for (const l of cache.site[k]) r.links.set(`${l.provider}:${String(l.slug).toLowerCase()}`, l); return; }
  const before = r.links.size;
  const found = [];
  for (const d of [...r.domains].slice(0, 2)) {
    const pages = [`https://${d}`, `https://${d}/careers`, `https://${d}/jobs`, `https://www.${d}/careers`];
    const hops = new Set();
    for (const u of pages) {
      const p = await req(u);
      if (p.status !== 200) continue;
      for (const m of p.text.matchAll(/(?:https?:)?\/\/[\w.-]+\.[a-z]{2,}[^\s"'<>)\\]*/gi)) link(r, m[0].startsWith('//') ? 'https:' + m[0] : m[0]);
      for (const m of p.text.matchAll(/href="(\/[^"#?]*|https?:\/\/[^"#?]*)"/gi)) if (CAREER_HREF.test(m[1]) && !/\.(png|jpe?g|svg|css|js|pdf|webp)$/i.test(m[1])) hops.add(m[1].startsWith('/') ? `https://${d}${m[1]}` : m[1]);
      if (r.links.size > before) break;
    }
    if (r.links.size === before) for (const h of [...hops].filter((h) => domainOf(h).endsWith(d)).slice(0, 3)) {
      const p = await req(h);
      if (p.status !== 200) continue;
      for (const m of p.text.matchAll(/(?:https?:)?\/\/[\w.-]+\.[a-z]{2,}[^\s"'<>)\\]*/gi)) link(r, m[0].startsWith('//') ? 'https:' + m[0] : m[0]);
      if (r.links.size > before) break;
    }
    if (r.links.size > before) break;
  }
  for (const l of r.links.values()) found.push(l);
  cache.site[k] = found.length ? found : [{ none: true, provider: 'none', slug: '' }];
  if (!found.length) cache.site[k] = [];
}
if (!flag('no-site')) {
  const need = [...records.values()].filter((r) => !trackedNames.has(recKey(r.name)) && !r.links.size && r.domains.size);
  let gained = 0, n = 0;
  await pool(need, 12, async (r) => { await siteScan(r); if (r.links.size) { gained++; r.viaSite = true; } if (++n % 50 === 0) saveCache(); });
  saveCache();
  console.log(`site scan: ${need.length} company sites, ${gained} gained an ATS link`);
}

const out = [];
const linkRows = [];
const todo = [];
let linked = 0, tracked = 0;
for (const r of records.values()) {
  if (trackedNames.has(recKey(r.name))) { tracked++; continue; }
  const best = [...r.links.values()].sort((a, b) => b.n - a.n)[0];
  if (best) {
    if (known.has(`${best.provider}:${String(best.slug).toLowerCase()}`)) { tracked++; continue; }
    linked++;
    const o = { name: r.name, status: 'link', provider: best.provider, slug: best.slug, jobs: '', board_name: '', tier: 0, sources: [...r.sources].join(','), domain: [...r.domains][0] ?? '', note: r.viaSite ? 'found on the careers page' : `apply links: ${best.n}`, sample: '', entry: { name: r.name, provider: best.provider, slug: best.slug, enabled: true } };
    out.push(o); linkRows.push(o);
    continue;
  }
  todo.push(r);
}
console.log(`${records.size} companies: ${tracked} already tracked, ${linked} resolved from apply links, ${todo.length} to fuzz`);

// Providers whose full fetch is cheap enough to double as a liveness check.
const LIGHT = new Set(['adp', 'ultipro', 'icims', 'jibe', 'comeet', 'gem', 'deel', 'paylocity', 'zohorecruit', 'odoo', 'jobscore', 'jazzhr', 'rippling', 'factorial']);
// Link-resolved boards: confirm they are alive and count their jobs where a cheap probe exists.
await pool(linkRows, 12, async (o) => {
  const probe = PROBES[o.provider] ?? (LIGHT.has(o.provider) ? async (slug) => {
    const jobs = await providers[o.provider].fetch(slug, {});
    return jobs.length ? { board_name: '', jobs: jobs.length, titles: jobs.slice(0, 6).map((j) => `${j.title} (${j.location || '?'})`), text: '' } : null;
  } : null);
  if (!probe) { o.note += '; no probe for this ATS'; return; }
  const p = await probe(o.provider === 'softgarden' ? String(o.slug).replace(/\.softgarden\.io$/, '') : o.slug).catch(() => null);
  if (!p) { o.note += '; board empty or not answering'; return; }
  o.jobs = p.jobs; o.board_name = p.board_name; o.sample = p.titles.slice(0, 3).join(' | ');
});

if (!flag('no-fuzz')) {
  const hb = setInterval(() => console.log(`  ... ${stats.requests} requests, ${stats.rate} rate-limited, queued ${[...hostGates.entries()].filter(([, g]) => g.q.length).map(([h, g]) => h + ':' + g.q.length).join(' ')} | in flight ${inflight.size}${[...inflight].filter(([, t]) => Date.now() - t > 30000).slice(0, 3).map(([k]) => ' STUCK ' + k).join('')}`), 30000);
  const list = LIMIT ? todo.slice(0, LIMIT) : todo;
  let done = 0, hits = 0;
  await pool(list, CONC, async (r) => {
    if (DEADLINE && Date.now() > DEADLINE) { out.push({ name: r.name, status: 'unresolved', provider: '', slug: '', jobs: '', board_name: '', tier: '', sources: [...r.sources].join(','), domain: [...r.domains][0] ?? '', note: 'not fuzzed yet (time budget); rerun resumes from the cache', sample: '', entry: null }); return; }
    const found = [], rejected = [];
    for (let tier = 1; tier <= MAX_TIER && !found.length; tier++) {
      const jobs = [];
      for (const slug of candidates(r, tier)) for (const p of FUZZ_PROVIDERS) {
        if (tier >= 2 && TIER1_ONLY.has(p)) continue;
        const key = `${p === 'lever-eu' ? 'lever-eu' : p}:${slug}`;
        if (known.has(`${p === 'lever-eu' ? 'lever' : p}:${slug}`)) continue;
        jobs.push({ p, slug, key });
      }
      await Promise.all(jobs.map(async ({ p, slug, key }) => {
        if (missFresh(key)) return;
        let probe = cache.hit[key];
        if (!probe) {
          let transient = false;
          for (let a = 0; a < 3; a++) {
            try {
              inflight.set(key, Date.now());
              probe = await withTimeout(PROBES[p](slug), 25000, key);
              transient = false; break;
            } catch (e) { if (!(e instanceof Transient)) { probe = null; transient = false; break; } transient = true; await sleep(1000 * (a + 1) ** 2); } finally { inflight.delete(key); }
          }
          if (transient) { stats.transient++; return; }
          if (!probe) { cache.miss[key] = Date.now(); return; }
          cache.hit[key] = { ...probe, text: fold(probe.text).slice(0, 3000) };
        }
        const status = verify(r, probe, slug, tier);
        (status === 'name-mismatch' ? rejected : found).push({ p, slug, tier, status, probe });
      }));
    }
    for (const f of rejected) out.push(row(r, f));
    for (const f of found) out.push(row(r, f));
    if (!found.length) out.push({ name: r.name, status: 'unresolved', provider: '', slug: '', jobs: '', board_name: '', tier: '', sources: [...r.sources].join(','), domain: [...r.domains][0] ?? '', note: r.unsupported ? `unsupported ATS: ${[...r.unsupported].join(', ')}` : [...r.applyHosts].slice(0, 2).join(' '), sample: '', entry: null });
    else hits++;
    if (++done % 10 === 0) { console.log(`fuzz ${done}/${list.length}, ${hits} with a hit, ${stats.requests} requests, ${stats.rate} rate-limited`); saveCache(); }
  });
  clearInterval(hb);
}
function row(r, f) {
  return { name: r.name, status: f.status, provider: f.p, slug: f.slug, jobs: f.probe.jobs, board_name: f.probe.board_name, tier: f.tier, sources: [...r.sources].join(','), domain: [...r.domains][0] ?? '', note: '', sample: f.probe.titles.slice(0, 3).join(' | '),
    entry: f.status === 'verified' || f.status === 'plausible' ? entryFor(f.p, f.slug, r.name, f.probe) : null };
}
saveCache();

const order = { link: 0, verified: 1, plausible: 2, 'name-mismatch': 3, unresolved: 4 };
out.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const COLS = ['name', 'status', 'provider', 'slug', 'jobs', 'board_name', 'tier', 'sources', 'domain', 'note', 'sample'];
writeFileSync(resolve(DATA, `ats_resolve_${LABEL}.csv`), [COLS.join(','), ...out.map((o) => COLS.map((c) => csv(o[c])).join(','))].join('\n'));
writeFileSync(resolve(DATA, `ats_resolve_${LABEL}.json`), JSON.stringify(out, null, 1));
const count = (s) => out.filter((o) => o.status === s).length;
console.log(`\nresolved by link: ${count('link')} | verified by fuzz: ${count('verified')} | plausible: ${count('plausible')} | name-mismatch (rejected): ${count('name-mismatch')} | unresolved: ${count('unresolved')}`);
console.log(`${stats.requests} requests, ${stats.rate} rate-limited, ${stats.transient} inconclusive probes (not cached), network errors: ${JSON.stringify(stats.errs)}. Review ${resolve(DATA, `ats_resolve_${LABEL}.csv`)}, then paste the wanted "entry" objects from the .json into ${PROFILE.companiesFile}.`);
