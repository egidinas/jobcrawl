#!/usr/bin/env node
// Common Crawl board harvester + candidate board matcher for jobcrawl.
// Node 22, no dependencies. Public data only: Common Crawl's static index files and the ATS vendors' public job feeds.
//
//   node crawler/cc-harvest.mjs --run [--apply]       harvest -> probe -> names -> match [-> apply]
//   node crawler/cc-harvest.mjs --harvest             stage 1 only (slug extraction from the newest 3 snapshots)
//   node crawler/cc-harvest.mjs --probe               stage 2 only (resumable)
//   node crawler/cc-harvest.mjs --match               stage 3+4: score boards, write candidates.csv
//   node crawler/cc-harvest.mjs --apply [--out F]     splice HIGH + MEDIUM boards into companies.json (or into F)
//
// Flags: --state-dir D (default $CC_HARVEST_DIR or crawler/data/cc-harvest)  --slugs-dir D (default <state>/slugs)  --vendors a,b,c
//        --limit N (probe at most N new slugs per vendor, deterministic sample)  --snapshots N (default 3)
//        --companies F (default crawler/companies.json)  --out F (apply target; default = --companies)
//        --max-apply N (default 1500)  --dry-run (apply: print, write nothing)  --total N / --per-host N (probe concurrency, max 4 / 2)
//        --retry-errors (re-probe slugs whose last probe was an error or timeout)  --no-names (skip the board-name lookups)
//
// Design after github.com/strelov1/freehire cmd/harvest-boards (MIT): Common Crawl as the only enumeration of tenant ids, a
// counting transport that separates refusals (429) from absences (404) so a rate-limited run is reported as "did not happen"
// instead of "found few", the Workday host/site slicing, and the expected-posting-id check (an id is evidence, a name is a
// resemblance). See crawler/CC_HARVEST_NOTES.md.
//
// Never publishes, never commits, never touches crawl.mjs/run.mjs/publish.mjs. providers*.mjs are imported read-only.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, copyFileSync, renameSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve as pathResolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { providers, resolve as resolveEntry } from './providers.mjs';
import { loadProfile } from './profile.mjs';
import { useRelevance } from './relevance.mjs';
import { setUserAgent } from './useragent.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);

const PROFILE = opt('profile') ? loadProfile(opt('profile')) : null;
if (PROFILE) {
  useRelevance(PROFILE.relevance);
  setUserAgent(PROFILE.userAgent);
}

const DATA = pathResolve(opt('data') ?? PROFILE?.dataDir ?? join(HERE, 'data'));
const STATE_DIR = pathResolve(opt('state-dir', process.env.CC_HARVEST_DIR ?? join(DATA, 'cc-harvest')));
const SLUGS_DIR = pathResolve(opt('slugs-dir', join(STATE_DIR, 'slugs')));
const IDX_DIR = pathResolve(opt('idx-dir', join(STATE_DIR, 'idx')));
const COMPANIES = pathResolve(opt('companies', PROFILE?.companiesFile ?? join(HERE, 'companies.json')));
const OUT_FILE = pathResolve(opt('out', COMPANIES));
const CATALOGUE = pathResolve(opt('catalogue', PROFILE?.companiesCatalogue ?? join(HERE, '..', 'site', 'content', 'companies.json')));
const WIKIDATA = pathResolve(opt('wikidata', join(STATE_DIR, 'companies_wikidata.json')));   // optional seed names: [{name, website}]
const RESOLVE_CACHE = pathResolve(opt('resolve-cache', join(DATA, 'ats-resolve-cache.json')));   // optional: slugs ats-resolve.mjs already probed
const HISTORY = pathResolve(DATA, 'scan-history.tsv');
const STATE_FILE = join(STATE_DIR, 'state.json');
const RESULTS = join(STATE_DIR, 'results.jsonl');
const NAMES = join(STATE_DIR, 'names.jsonl');
const CSV = join(STATE_DIR, 'candidates.csv');
const MAX_JOBS_PER_ENTRY = 40, JD_KB = 9, JD_BUDGET_MB = 200;
// Cap per run: 400 by default, lowered further if the worst-case JD storage (entries x max_jobs x 9 KB) would exceed 200 MB.
const MAX_APPLY = Math.min(Number(opt('max-apply', 400)), Math.floor((JD_BUDGET_MB * 1024) / (MAX_JOBS_PER_ENTRY * JD_KB)));
const N_SNAP = Number(opt('snapshots', 3));
const TOTAL_CONC = Math.min(4, Number(opt('total', 4)));
const HOST_CONC = Math.min(2, Number(opt('per-host', 2)));

const UA = PROFILE?.userAgent ?? 'jobcrawl-research (+https://github.com/egidinas/jobcrawl)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`${new Date().toISOString().slice(0, 19)}Z ${m}`);
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(SLUGS_DIR, { recursive: true });

// ---------------------------------------------------------------- state
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { version: 1, harvest: { snapshots: [], done: {} }, probe: {}, applied: [] }; }
}
let state = loadState();
function saveState() {
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, STATE_FILE);
}

// ---------------------------------------------------------------- vendors
// SURT key prefixes (host reversed, comma separated) per vendor. `slug(url)` returns the board id from a crawled URL.
const NOT_SLUG = /^(www|api|embed|jobs|careers|app|static|assets|help|support|blog|status|mail|cdn|developers?|docs|login|auth|admin|apply|boards|v1|v0|j|robots\.txt|favicon\.ico|sitemap\.xml|_next|companies|about|pricing|cdn-cgi|oauth|sso|signin|signup|partners|marketing|learn|go|hr|info|email|ftp|test|demo|staging|dev|secure|connect|home|my|portal|careers-page|hrm|hiring|talent|recruiting|recruit|accounts?|id|sandbox|oneclick-ui|company|search|sitemap|wp-content|wp-json|static-assets)$/;
const SLUG_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const firstSeg = (u) => u.pathname.split('/').filter(Boolean)[0];
const subdomain = (u, depth) => { const h = u.hostname.split('.'); return h.length === depth ? h[0] : undefined; };
const VENDORS = {
  greenhouse: { provider: 'greenhouse', prefixes: ['io,greenhouse,boards)/', 'io,greenhouse,job-boards)/', 'io,greenhouse,boards,eu)/', 'io,greenhouse,job-boards,eu)/'],
    slug: (u) => (/^\/embed\//.test(u.pathname) ? u.searchParams.get('for') : firstSeg(u)) },
  ashby: { provider: 'ashby', prefixes: ['com,ashbyhq,jobs)/'], slug: firstSeg },
  workable: { provider: 'workable', prefixes: ['com,workable,apply)/'], slug: firstSeg },
  lever: { provider: 'lever', prefixes: ['co,lever,jobs)/'], slug: firstSeg },
  'lever-eu': { provider: 'lever', region: 'eu', prefixes: ['co,lever,jobs,eu)/'], slug: firstSeg },
  personio: { provider: 'personio', prefixes: ['de,personio,jobs,'], slug: (u) => subdomain(u, 4) },
  'personio-com': { provider: 'personio', tld: 'com', prefixes: ['com,personio,jobs,'], slug: (u) => subdomain(u, 4) },
  recruitee: { provider: 'recruitee', prefixes: ['com,recruitee,'], slug: (u) => subdomain(u, 3) },
  teamtailor: { provider: 'teamtailor', prefixes: ['com,teamtailor,'], slug: (u) => subdomain(u, 3) },
  join: { provider: 'join', prefixes: ['com,join)/companies/'], slug: (u) => { const p = u.pathname.split('/').filter(Boolean); return p[0] === 'companies' ? p[1] : undefined; } },
  bamboohr: { provider: 'bamboohr', prefixes: ['com,bamboohr,'], slug: (u) => subdomain(u, 3) },
  smartrecruiters: { provider: 'smartrecruiters', prefixes: ['com,smartrecruiters,jobs)/', 'com,smartrecruiters,careers)/'], slug: firstSeg },
  workday: { provider: 'workday', prefixes: ['com,myworkdayjobs,wd'], slug: null },
};
const WD_HOST = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/;
const WD_LOCALE = /^[a-z]{2}-[A-Za-z]{2}$/;
const WD_NONSITE = /^(?:robots\.txt|sitemap.*|favicon.*|[a-z]{2}|wday|static|assets|api|images?|login|cxs|userhome|job|jobs)$/i;
function workdaySlug(u) {
  const m = WD_HOST.exec(u.hostname.toLowerCase());
  if (!m) return undefined;
  for (const part of u.pathname.split('/')) {
    if (!part || WD_LOCALE.test(part)) continue;
    if (WD_NONSITE.test(part)) return undefined;
    return `${m[1]}|${m[2]}|${part}`;
  }
  return undefined;
}
function extractSlug(vendor, rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return undefined; }
  if (vendor === 'workday') return workdaySlug(u);
  let s = VENDORS[vendor].slug(u);
  if (!s) return undefined;
  try { s = decodeURIComponent(s); } catch { return undefined; }
  if (NOT_SLUG.test(s.toLowerCase()) || !SLUG_OK.test(s)) return undefined;
  return s;
}

// ---------------------------------------------------------------- stage 1: harvest
async function fetchRetry(url, init, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...init, headers: { 'user-agent': UA, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(180000) });
      if (r.status === 429 || r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(5000 * (i + 1)); continue; }
      return r;
    } catch (e) { last = e; await sleep(3000 * (i + 1)); }
  }
  throw last;
}
async function newestSnapshots(n) {
  try {
    const r = await fetchRetry('https://index.commoncrawl.org/collinfo.json');
    if (r.ok) { const j = await r.json(); return j.slice(0, n).map((x) => x.id); }
  } catch { /* fall through */ }
  if (state.harvest.snapshots.length) return state.harvest.snapshots;
  throw new Error('cannot list Common Crawl snapshots (collinfo.json unreachable and no state)');
}
async function downloadIdx(snap) {
  const file = join(IDX_DIR, `${snap}.cluster.idx`);
  if (existsSync(file) && statSync(file).size > 1e7) return file;
  mkdirSync(IDX_DIR, { recursive: true });
  const r = await fetchRetry(`https://data.commoncrawl.org/cc-index/collections/${snap}/indexes/cluster.idx`);
  if (!r.ok) throw new Error(`cluster.idx ${snap}: HTTP ${r.status}`);
  const tmp = `${file}.part`;
  await new Promise((res, rej) => {
    const ws = createWriteStream(tmp);
    (async () => { try { for await (const chunk of r.body) if (!ws.write(chunk)) await new Promise((x) => ws.once('drain', x)); ws.end(res); } catch (e) { rej(e); } })();
    ws.on('error', rej);
  });
  renameSync(tmp, file);
  return file;
}
function loadBlocks(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    const [a, f, o, n] = l.split('\t');
    return { key: a.slice(0, a.lastIndexOf(' ')), f, o: +o, n: +n };
  });
}
function blocksFor(L, prefixes) {
  const set = new Map();
  for (const p of prefixes) {
    let lo = 0, hi = L.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (L[m].key < p) lo = m + 1; else hi = m; }
    let last = lo - 1;
    for (let i = lo; i < L.length && L[i].key.startsWith(p); i++) last = i;
    for (let k = Math.max(0, lo - 1); k <= Math.max(last, lo - 1); k++) set.set(k, L[k]);
  }
  return [...set.values()];
}
async function harvestVendorSnapshot(snap, vendor, L) {
  const bl = blocksFor(L, VENDORS[vendor].prefixes);
  const slugs = new Map();   // lowercase -> Map(variant -> count)
  let urls = 0, fail = 0, refused = 0;
  for (const b of bl) {
    try {
      const r = await fetch(`https://data.commoncrawl.org/cc-index/collections/${snap}/indexes/${b.f}`, { headers: { 'user-agent': UA, range: `bytes=${b.o}-${b.o + b.n - 1}` }, signal: AbortSignal.timeout(90000) });
      if (r.status === 429 || r.status === 503) { refused++; await sleep(10000); continue; }
      if (r.status !== 206 && r.status !== 200) { fail++; continue; }
      const txt = gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8');
      for (const line of txt.split('\n')) {
        if (!line) continue;
        const sp = line.indexOf(' ');
        const key = line.slice(0, sp);
        if (!VENDORS[vendor].prefixes.some((p) => key.startsWith(p))) continue;
        const m = line.match(/"url":\s*"([^"]+)"/);
        if (!m) continue;
        urls++;
        const s = extractSlug(vendor, m[1]);
        if (!s) continue;
        const lc = s.toLowerCase();
        const v = slugs.get(lc) ?? new Map();
        v.set(s, (v.get(s) ?? 0) + 1);
        slugs.set(lc, v);
      }
    } catch { fail++; }
    await sleep(300);
  }
  const lines = [...slugs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([lc, v]) => [...v.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  writeFileSync(join(SLUGS_DIR, `raw_${snap}_${vendor}.txt`), lines.join('\n'));
  return { blocks: bl.length, urls, distinct: lines.length, fail, refused };
}
async function harvest() {
  const vendors = (opt('vendors') ?? Object.keys(VENDORS).join(',')).split(',');
  const snaps = await newestSnapshots(N_SNAP);
  state.harvest.snapshots = snaps;
  log(`[harvest] snapshots ${snaps.join(', ')}; vendors ${vendors.join(', ')}`);
  for (const snap of snaps) {
    const pending = vendors.filter((v) => !state.harvest.done[`${snap}/${v}`]);
    if (!pending.length) continue;
    const file = await downloadIdx(snap);
    const L = loadBlocks(file);
    log(`[harvest] ${snap}: ${L.length} index blocks`);
    for (const v of pending) {
      const st = await harvestVendorSnapshot(snap, v, L);
      // A unit with refusals or failures dominating is not "done": it will be redone on the next run.
      const bad = st.refused + st.fail > st.blocks / 2 || (st.blocks > 0 && st.distinct === 0 && v !== 'lever-eu' && v !== 'lever' && v !== 'personio-com');
      if (!bad) state.harvest.done[`${snap}/${v}`] = st;
      log(`[harvest] ${snap} ${v}: ${JSON.stringify(st)}${bad ? '  NOT MARKED DONE (refused/failed blocks dominate or nothing extracted)' : ''}`);
      saveState();
    }
  }
  // Union of the snapshots per vendor, tagged with how many snapshots saw each slug.
  for (const v of vendors) {
    const count = new Map(), variant = new Map();
    let have = 0;
    for (const snap of snaps) {
      const f = join(SLUGS_DIR, `raw_${snap}_${v}.txt`);
      if (!existsSync(f) || !state.harvest.done[`${snap}/${v}`]) continue;
      have++;
      for (const s of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
        const lc = s.toLowerCase();
        count.set(lc, (count.get(lc) ?? 0) + 1);
        if (!variant.has(lc) || (s !== lc && variant.get(lc) === lc)) variant.set(lc, s);
      }
    }
    const rows = [...count.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([lc, n]) => `${variant.get(lc)}\t${n}`);
    writeFileSync(join(SLUGS_DIR, `${v}.txt`), rows.join('\n') + '\n');
    log(`[harvest] union ${v}: ${rows.length} slugs from ${have} snapshots`);
  }
  // The cluster.idx files are ~100 MB each and only needed during harvest.
  if (!flag('keep-idx')) for (const f of existsSync(IDX_DIR) ? readdirSync(IDX_DIR) : []) if (f.endsWith('.cluster.idx')) { try { unlinkSync(join(IDX_DIR, f)); } catch { /* ignore */ } }
  saveState();
}

// ---------------------------------------------------------------- filters (mirror of crawl.mjs compileMatcher / verdicts)
const norm = (s) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
function compileMatcher(list = []) {
  if (!list || !list.length) return () => false;
  const words = [], subs = [];
  for (const k of list) { if (k.startsWith('word:')) words.push(norm(k.slice(5)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); else subs.push(norm(k)); }
  const re = words.length ? new RegExp(`\\b(?:${words.join('|')})\\b`, 'i') : null;
  return (t) => { if (!t) return false; if (re && re.test(t)) return true; for (let i = 0; i < subs.length; i++) if (t.includes(subs[i])) return true; return false; };
}
function makeFilters(cfg) {
  const tf = cfg.title_filter ?? {}, lf = cfg.location_filter ?? {};
  const neg = compileMatcher(tf.negative), pos = compileMatcher(tf.positive), blk = compileMatcher(lf.block_hard), alw = compileMatcher(lf.allow);
  const hasPos = (tf.positive ?? []).length > 0, allowUnknown = lf.allow_unknown !== false;
  return {
    title: (t) => { const n = norm(t); if (neg(n)) return false; return !hasPos || pos(n); },
    loc: (l) => { const n = norm(l); if (!n) return allowUnknown; if (blk(n)) return false; return alw(n); },
  };
}

// ---------------------------------------------------------------- relevance keywords (English + German)
const SPACE_FP = /\b(?:white|office|retail|work|parking|storage|living|shared|open|floor|desk|data)[ -]?space\b|\bspace (?:planning|planner|management|manager)\b|\bworkspace\b|\bcollaborat\w* space\b/g;
const REL = [
  ['space', /\bspace\b/], ['spacecraft', /\bspace ?craft/], ['satellite', /\bsatellit/], ['satcom', /\bsatcom\b/], ['launch', /\blaunch(?:er|ers)\b|\blaunch (?:vehicle|operations?|site|pad|systems?|services?|integration|engineer\w*|campaign)\b/],
  ['rocket', /\brocket/], ['aerospace', /\baerospace|\baeronaut/], ['aircraft', /\baircraft|\bairframe|\bavionic/], ['defence', /\bdefen[cs]e\b|\bmilitary\b/], ['missile', /\bmissile|\bmunition|\bballistic/],
  ['propulsion', /\bpropulsi|\bthruster|\bturbopump|\bcombustion chamber/], ['GNC', /\bgnc\b|\badcs\b|\bguidance,? navigation|\bflight dynamics|\bflight software/],
  ['photonics', /\bphotoni/], ['laser', /\blaser/], ['optical', /\boptic(?:al|s)?\b|\boptoelectron|\blidar\b/], ['quantum', /\bquantum/],
  ['fusion', /\bfusion\b/], ['hypersonic', /\bhypersonic/], ['drone', /\bdrones?\b|\buas\b|\buav\b|\buncrewed|\bunmanned/], ['radar', /\bradar/], ['RF', /\brf\b|\bmicrowave|\bantenna|\bgnss\b/],
  ['cryogenic', /\bcryo/], ['vacuum', /\bvacuum|\btvac\b/], ['AIT/AIV', /\bait\b|\baiv\b|\bassembly,? integration/], ['ECSS', /\becss\b/], ['DO-178', /\bdo-?178|\bdo-?254|\bdo-?160/],
  ['orbit', /\borbit/], ['earth-observation', /\bearth observation|\bground segment|\bremote sensing/], ['cleanroom', /\bclean ?room/],
  ['Raumfahrt', /\braumfahrt|\braumflug|\braumfahrzeug/], ['Luftfahrt', /\bluftfahrt|\bflugzeug|\bflugkorper|\bluft- und raumfahrt/], ['Satellit', /\bsatellit/], ['Rakete', /\braket/],
  ['Wehrtechnik', /\bwehrtechnik|\bverteidigung|\brustung|\bsicherheit und verteidigung/], ['Triebwerk', /\btriebwerk|\braketenantrieb/], ['Photonik', /\bphotonik|\boptik\b|\bhochfrequenz/],
  ['Quanten', /\bquanten/], ['Kryo/Vakuum', /\bkryo|\bvakuum/], ['Hyperschall', /\bhyperschall/], ['Drohne', /\bdrohne/], ['Reinraum', /\breinraum/], ['Fernerkundung', /\bfernerkundung|\bbodenstation/],
];
const FUSION_FP = /\boracle fusion|\bsensor fusion|\bdata fusion|\bfusion (?:cloud|apps?|hcm|erp)\b|\bfusion (?:middleware|bi|financials)\b/;
function relevance(title, dept = '', slugKey = '') {
  const t = norm(`${title} ${dept}`).replace(SPACE_FP, ' ');
  const hits = [];
  for (const [name, re] of REL) {
    const m = re.exec(t);
    if (!m) continue;
    // A keyword that is part of the board's own name ("Rocket Travel" on rocketmiles) says nothing about the sector.
    const word = m[0].replace(/[^a-z0-9]/g, '');
    if (slugKey && word.length >= 4 && slugKey.includes(word)) continue;
    if (name === 'fusion' && FUSION_FP.test(t)) continue;
    if (!hits.includes(name)) hits.push(name);
  }
  return hits;
}

// ---------------------------------------------------------------- dedupe sets
function existingKeys(cfg) {
  const keys = new Set();
  for (const e of cfg.tracked_companies ?? []) {
    let r = null;
    try { r = resolveEntry(e); } catch { /* unresolvable entry */ }
    const provider = r?.provider ?? e.provider, slug = r?.slug ?? e.slug;
    if (provider && slug) keys.add(`${provider}:${String(slug).toLowerCase()}`);
  }
  return keys;
}
function resolveCacheKeys() {
  const keys = new Set();
  try {
    const c = JSON.parse(readFileSync(RESOLVE_CACHE, 'utf8'));
    for (const part of [c.miss, c.hit]) for (const k of Object.keys(part ?? {})) {
      const i = k.indexOf(':');
      const p = k.slice(0, i), s = k.slice(i + 1).toLowerCase();
      keys.add(`${p === 'lever-eu' ? 'lever-eu' : p}:${s}`);
    }
  } catch { /* cache optional */ }
  return keys;
}
const boardKey = (vendor, slug) => `${vendor}:${slug.toLowerCase()}`;   // vendor id (lever-eu, personio-com are their own ids)
const dedupeKeyFor = (vendor, slug) => {
  const v = VENDORS[vendor];
  return `${v.provider === 'lever' && v.region ? 'lever-eu' : v.provider}:${slug.toLowerCase()}`;
};

// ---------------------------------------------------------------- stage 2: probe
const jobId = (url = '') => {
  const m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (m) return m[0].toLowerCase();
  const segs = url.split('?')[0].split('/').filter(Boolean);
  const last = segs[segs.length - 1] ?? '';
  const num = last.match(/^(\d{6,})/);
  if (num) return num[1];
  const jid = url.match(/[?&](?:gh_jid|ashby_jid|jid)=([\w-]+)/);
  if (jid) return jid[1];
  if (/^[A-Z0-9]{8,12}$/.test(last)) return last;   // workable shortcode
  return '';
};
async function workdayProbe(slug) {
  const [tenant, wd, site] = slug.split('|');
  const base = `https://${tenant}.${wd}.myworkdayjobs.com`;
  const res = await fetch(`${base}/wday/cxs/${tenant}/${site}/jobs`, {
    method: 'POST', headers: { 'user-agent': UA, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' }), signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} workday`);
  const d = await res.json();
  const jobs = (d.jobPostings ?? []).filter((j) => j.externalPath).map((j) => ({ title: j.title ?? '', url: `${base}/${site}${j.externalPath}`, location: j.locationsText ?? '' }));
  return { jobs, total: d.total ?? jobs.length };
}
function classifyError(e) {
  const msg = String(e?.message ?? e);
  const m = msg.match(/HTTP (\d{3})/);
  if (m) { const c = Number(m[1]); if (c === 429) return { status: 'refused', http: c }; if (c === 404 || c === 410) return { status: 'notfound', http: c }; return { status: 'error', http: c, err: msg.slice(0, 80) }; }
  if (/abort|timeout|timed out/i.test(msg)) return { status: 'error', err: 'timeout' };
  return { status: 'error', err: msg.slice(0, 80) };
}
async function probeOne(vendor, slug, F, hist) {
  const v = VENDORS[vendor];
  const t0 = Date.now();
  const rec = { k: boardKey(vendor, slug), vendor, provider: v.provider, slug, t: new Date().toISOString().slice(0, 19) };
  try {
    let jobs, total;
    if (vendor === 'workday') ({ jobs, total } = await workdayProbe(slug));
    else {
      const entry = { provider: v.provider, slug, ...(v.region ? { region: v.region } : {}), ...(v.tld ? { careers_url: `https://${slug}.jobs.personio.${v.tld}` } : {}) };
      let timer;
      const tmo = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout 35s')), 35000); });
      try { jobs = await Promise.race([providers[v.provider].fetch(slug, entry), tmo]); } finally { clearTimeout(timer); }
      total = jobs.length;
    }
    rec.status = 'ok';
    rec.jobs = total;
    const slugAlnum = norm(slug.split('|')[0]).replace(/[^a-z0-9]/g, '');
    let pass = 0, titlePass = 0, relRoles = 0, relPass = 0;
    const relKw = {}, samples = [];
    const ids = [];
    for (const j of jobs) {
      const hits = relevance(j.title, j.department, slugAlnum);
      const tp = F.title(j.title), lp = F.loc(j.location);
      if (tp) titlePass++;
      if (tp && lp) pass++;
      if (hits.length) { relRoles++; if (tp && lp) relPass++; for (const h of hits) relKw[h] = (relKw[h] ?? 0) + 1; }
      samples.push({ t: j.title, l: j.location, p: tp && lp ? 1 : 0, r: hits.length });
      if (ids.length < 300) { const id = jobId(j.url); if (id) ids.push(id); }
    }
    samples.sort((a, b) => b.r - a.r || b.p - a.p);
    Object.assign(rec, { pass, titlePass, relRoles, relPass, relKw, samples: samples.slice(0, 8).map((s) => `${s.t}${s.l ? ` [${s.l.slice(0, 40)}]` : ''}`), ids });
    // Posting-id check against aggregator / apply URLs already in the crawler history.
    const idHits = [];
    for (const id of ids) { const h = hist.ids.get(id); if (h) idHits.push({ id, company: h.company, url: h.url }); if (idHits.length >= 3) break; }
    if (idHits.length) rec.idHits = idHits;
  } catch (e) {
    Object.assign(rec, classifyError(e));
    // A Workday site that answers 422, or a BambooHR subdomain without a careers embed, is an absence, not a failure.
    if (rec.status === 'error' && ((vendor === 'workday' && rec.http === 422) || (vendor === 'bamboohr' && /JSON/.test(rec.err ?? '')))) rec.status = 'notfound';
  }
  rec.ms = Date.now() - t0;
  return rec;
}
function loadResults() {
  const m = new Map();
  if (!existsSync(RESULTS)) return m;
  for (const l of readFileSync(RESULTS, 'utf8').split('\n')) { if (!l) continue; try { const r = JSON.parse(l); m.set(r.k, r); } catch { /* truncated last line */ } }
  return m;
}
function loadHistoryIndex() {
  // id -> {company,url} from rows whose URL is NOT a direct feed of a board we are about to probe (aggregator / apply URLs).
  const ids = new Map(), companies = new Set();
  if (!existsSync(HISTORY)) return { ids, companies };
  for (const line of readFileSync(HISTORY, 'utf8').split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [url, company] = line.split('\t');
    if (!url) continue;
    const name = (company ?? '').replace(/\s*\(via [^)]*\)\s*$/i, '').trim();
    if (name) companies.add(name);
    const id = jobId(url);
    if (id && !ids.has(id)) ids.set(id, { company: name, url });
  }
  return { ids, companies };
}
function planProbes(cfg, results) {
  const known = existingKeys(cfg), cached = resolveCacheKeys();
  const vendors = (opt('vendors') ?? Object.keys(VENDORS).join(',')).split(',');
  const limit = opt('limit') ? Number(opt('limit')) : Infinity;
  const queues = {}, skipped = {};
  for (const v of vendors) {
    const f = join(SLUGS_DIR, `${v}.txt`);
    if (!existsSync(f)) { log(`[probe] no slug file for ${v} (run --harvest first)`); continue; }
    skipped[v] = { inCompanies: 0, inResolveCache: 0, done: 0 };
    let list = [];
    for (const row of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      const slug = row.split('\t')[0];
      const dk = dedupeKeyFor(v, slug);
      if (known.has(dk)) { skipped[v].inCompanies++; continue; }
      if (cached.has(dk)) { skipped[v].inResolveCache++; continue; }
      const prev = results.get(boardKey(v, slug));
      if (prev && (prev.status === 'ok' || prev.status === 'notfound' || (prev.status === 'error' && !flag('retry-errors')))) { skipped[v].done++; continue; }
      list.push(slug);
    }
    // Deterministic shuffle so --limit samples the whole alphabet and a vendor's load is spread out.
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    list = list.map((s) => [rnd(), s]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    queues[v] = list.slice(0, limit);
  }
  return { queues, skipped };
}
async function probe(cfg) {
  const F = makeFilters(cfg);
  const hist = loadHistoryIndex();
  const results = loadResults();
  const { queues, skipped } = planProbes(cfg, results);
  const total = Object.values(queues).reduce((a, q) => a + q.length, 0);
  log(`[probe] to probe ${total}; per vendor ${JSON.stringify(Object.fromEntries(Object.entries(queues).map(([k, q]) => [k, q.length])))}; skipped ${JSON.stringify(skipped)}`);
  if (!total) return;
  const hosts = {};
  for (const [v, q] of Object.entries(queues)) hosts[v] = { q: q.slice(), inflight: 0, next: 0, pauseUntil: 0, backoff: 30000, consecRefused: 0, dropped: false };
  // Workable's widget API answers ~10 requests and then 429s a burst (seen in the slice test): one request at a time, 4 s apart.
  const gap = { greenhouse: 200, ashby: 200, workable: 4000, workday: 400 };
  const hostCap = { workable: 1 };
  const counts = { ok: 0, notfound: 0, refused: 0, error: 0, live: 0 };
  const perVendor = {};
  let inflight = 0, done = 0;
  const t0 = Date.now();
  const order = Object.keys(hosts);
  let rr = 0;
  const startTask = (v, slug) => {
    const h = hosts[v];
    h.inflight++; inflight++;
    probeOne(v, slug, F, hist).then((rec) => {
      appendFileSync(RESULTS, JSON.stringify(rec) + '\n');
      results.set(rec.k, rec);
      counts[rec.status] = (counts[rec.status] ?? 0) + 1;
      if (rec.status === 'ok' && rec.jobs > 0) counts.live++;
      const pv = (perVendor[v] ??= { ok: 0, notfound: 0, refused: 0, error: 0 });
      pv[rec.status]++;
      if (rec.status === 'refused') {
        h.consecRefused++;
        h.pauseUntil = Date.now() + h.backoff; h.backoff = Math.min(h.backoff * 2, 600000);
        if (h.consecRefused >= 25) { h.dropped = true; h.q.length = 0; log(`[probe] ${v}: 25 consecutive 429s - dropping the rest of this vendor for this run (it will be retried on the next run)`); }
      } else { h.consecRefused = 0; if (rec.status === 'ok' || rec.status === 'notfound') h.backoff = 30000; }
    }).catch((e) => log(`[probe] internal error ${v}:${slug}: ${e.message}`)).finally(() => {
      h.inflight--; inflight--; done++;
      h.next = Date.now() + (gap[v] ?? 250);
      if (done % 500 === 0) {
        const el = (Date.now() - t0) / 1000, rate = done / el;
        log(`[probe] ${done}/${total} ok=${counts.ok} (live ${counts.live}) notfound=${counts.notfound} refused=${counts.refused} error=${counts.error} rate=${rate.toFixed(1)}/s eta=${Math.round((total - done) / Math.max(rate, 0.01) / 60)}min`);
        state.probe = { updated: new Date().toISOString(), done, total, counts, perVendor }; saveState();
      }
    });
  };
  while (true) {
    const remaining = order.some((v) => hosts[v].q.length);
    if (!remaining && inflight === 0) break;
    let started = false;
    if (inflight < TOTAL_CONC) {
      for (let i = 0; i < order.length; i++) {
        const v = order[(rr + i) % order.length], h = hosts[v];
        if (!h.q.length || h.inflight >= (hostCap[v] ?? HOST_CONC) || Date.now() < h.next || Date.now() < h.pauseUntil) continue;
        rr = (rr + i + 1) % order.length;
        startTask(v, h.q.shift());
        started = true;
        break;
      }
    }
    if (!started) await sleep(20);
  }
  const el = Math.round((Date.now() - t0) / 1000);
  state.probe = { updated: new Date().toISOString(), done, total, counts, perVendor, seconds: el };
  // Refusal verdicts (freehire rule): a vendor with more refusals than answers did not happen.
  const verdicts = {};
  for (const [v, pv] of Object.entries(perVendor)) {
    const answered = pv.ok + pv.notfound;
    verdicts[v] = pv.refused > answered ? 'DID NOT HAPPEN (refusals dominate)' : pv.refused ? 'partial (some refusals; refused slugs are re-probed next run)' : 'ok';
  }
  state.probe.verdicts = verdicts;
  saveState();
  log(`[probe] finished ${done} probes in ${el}s: ${JSON.stringify(counts)}`);
  for (const [v, pv] of Object.entries(perVendor)) log(`[probe] ${v}: ${JSON.stringify(pv)} -> ${verdicts[v]}`);
}

// ---------------------------------------------------------------- stage 2b: board names
async function jget(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const NAME_FETCH = {
  greenhouse: async (s) => (await jget(`https://boards-api.greenhouse.io/v1/boards/${s}`)).name,
  workable: async (s) => (await jget(`https://apply.workable.com/api/v1/widget/accounts/${s}`)).name,
  recruitee: async (s) => (await jget(`https://${s}.recruitee.com/api/offers/`)).offers?.[0]?.company_name,
  smartrecruiters: async (s) => (await jget(`https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=1`)).content?.[0]?.company?.name,
};
function loadNames() {
  const m = new Map();
  if (!existsSync(NAMES)) return m;
  for (const l of readFileSync(NAMES, 'utf8').split('\n')) { if (!l) continue; try { const r = JSON.parse(l); m.set(r.k, r); } catch { /* ignore */ } }
  return m;
}
async function names() {
  if (flag('no-names')) return;
  const results = loadResults(), have = loadNames();
  const todo = [...results.values()].filter((r) => r.status === 'ok' && r.jobs > 0 && (r.pass > 0 || r.relRoles > 0) && NAME_FETCH[r.provider] && !have.has(r.k) && !r.vendor.includes('-'));
  log(`[names] ${todo.length} board-name lookups`);
  let i = 0, got = 0, refused = 0;
  const t0 = Date.now();
  const lastHit = {};
  await Promise.all(Array.from({ length: Math.min(2, TOTAL_CONC) }, async () => {
    while (i < todo.length) {
      const r = todo[i++];
      const wait = (lastHit[r.provider] ?? 0) + 200 - Date.now();
      if (wait > 0) await sleep(wait);
      lastHit[r.provider] = Date.now();
      let name = '', status = 'ok';
      try { name = (await NAME_FETCH[r.provider](r.slug)) ?? ''; got += name ? 1 : 0; } catch (e) { status = /429/.test(e.message) ? 'refused' : 'error'; if (status === 'refused') { refused++; await sleep(5000); } }
      if (status !== 'refused') appendFileSync(NAMES, JSON.stringify({ k: r.k, name: String(name).trim(), status }) + '\n');
      if ((i % 500) === 0) log(`[names] ${i}/${todo.length} named=${got} refused=${refused}`);
    }
  }));
  log(`[names] done in ${Math.round((Date.now() - t0) / 1000)}s: named ${got}, refused ${refused}`);
}

// ---------------------------------------------------------------- stage 3: match + relevance
const LEGAL = new Set('gmbh ag se kg ug mbh co inc incorporated ltd limited llc llp plc sa sas sarl srl spa bv nv oy ab as aps corp corporation company holding holdings pte pty gesellschaft mit beschrankter haftung ohg ev eg kgaa ltda lp'.split(' '));
const GENERIC_TAIL = new Set('technologies technology systems solutions labs lab group international europe deutschland germany the careers career jobs job hiring recruiting space aerospace'.split(' '));
function tokens(name) {
  return norm(name).replace(/\(.*?\)/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}
function keyVariants(name) {
  let t = tokens(name);
  while (t.length > 1 && LEGAL.has(t[t.length - 1])) t = t.slice(0, -1);
  const out = new Set();
  const add = (a) => { const k = a.join(''); if (k.length >= 4) out.add(k); };
  add(t);
  let u = t.slice();
  while (u.length > 1 && GENERIC_TAIL.has(u[u.length - 1])) { u = u.slice(0, -1); add(u); }
  return [...out];
}
function domainKey(website) {
  try {
    const h = new URL(/^https?:/.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, '').split('.');
    while (h.length > 1 && /^(com|org|net|edu|gov|ac|co|de|eu|io|ai|fr|uk|us|nl|ch|at|it|es|se|no|dk|fi|pl|cz|ro|jp|kr|cn|in|sg|ae|au|ca|nz|tech|space|aero|group)$/.test(h[h.length - 1])) h.pop();
    const k = (h[h.length - 1] ?? '').replace(/[^a-z0-9]/g, '');
    return k.length >= 4 ? k : '';
  } catch { return ''; }
}
function buildNameIndex(cfg, histCompanies) {
  const idx = new Map();   // key -> [{src, name}]
  const add = (key, src, name) => { if (!key) return; const a = idx.get(key) ?? []; if (!a.some((x) => x.src === src && x.name === name)) a.push({ src, name }); idx.set(key, a); };
  try {
    const cat = JSON.parse(readFileSync(CATALOGUE, 'utf8')).companies ?? [];
    for (const c of cat) {
      for (const n of [c.name, ...(c.aliases ?? [])]) if (n) for (const k of keyVariants(n)) add(k, 'catalogue', c.name);
      add(domainKey(c.domain ?? ''), 'catalogue-domain', c.name);
    }
  } catch (e) { log(`[match] catalogue unreadable: ${e.message}`); }
  try {
    for (const c of JSON.parse(readFileSync(WIKIDATA, 'utf8'))) { for (const k of keyVariants(c.name)) add(k, 'wikidata', c.name); add(domainKey(c.website ?? ''), 'wikidata-domain', c.name); }
  } catch (e) { log(`[match] wikidata unreadable: ${e.message}`); }
  for (const e of cfg.tracked_companies ?? []) for (const k of keyVariants(e.name)) add(k, 'tracked', e.name);
  for (const n of histCompanies) for (const k of keyVariants(n)) add(k, 'history', n);
  return idx;
}
function slugKeys(slug) {
  const base = slug.includes('|') ? slug.split('|')[0] : slug;
  let t = norm(base).split(/[^a-z0-9]+/).filter(Boolean);
  const out = new Set();
  const add = (a) => { const k = a.join(''); if (k.length >= 4) out.add(k); };
  add(t);
  while (t.length > 1 && (GENERIC_TAIL.has(t[t.length - 1]) || LEGAL.has(t[t.length - 1]))) { t = t.slice(0, -1); add(t); }
  const joined = norm(base).replace(/[^a-z0-9]/g, '');
  for (const suf of ['careers', 'jobs', 'gmbh', 'hiring', 'inc']) if (joined.endsWith(suf) && joined.length - suf.length >= 4) out.add(joined.slice(0, -suf.length));
  return [...out];
}
const SRC_WEIGHT = { catalogue: 30, 'catalogue-domain': 28, wikidata: 25, 'wikidata-domain': 22, tracked: 15, history: 15 };
function matchNames(rec, boardName, idx) {
  const found = [];
  const tryKeys = (keys, via) => { for (const k of keys) for (const m of idx.get(k) ?? []) found.push({ ...m, via, key: k }); };
  tryKeys(slugKeys(rec.slug), 'slug');
  if (boardName) tryKeys(keyVariants(boardName), 'board-name');
  found.sort((a, b) => (SRC_WEIGHT[b.src] ?? 0) - (SRC_WEIGHT[a.src] ?? 0));
  // The board's own name settles it where the vendor publishes one (freehire expectid: a name is a resemblance, so a contradicting
  // published name rejects it): a slug match whose key is not among the board name's keys is dropped.
  if (boardName) { const bk = new Set(keyVariants(boardName)); if (bk.size) return found.filter((m) => m.via === 'board-name' || bk.has(m.key)); }
  return found;
}
const prettify = (slug) => {
  const base = slug.includes('|') ? slug.split('|')[0] : slug;
  const parts = base.split(/[-_.]+/).filter(Boolean);
  return parts.map((p) => (p.length <= 3 && /^[a-z]+$/.test(p) && parts.length > 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1))).join(' ');
};
function score(rec, name, found) {
  const idv = !!rec.idHits?.length;
  const nm = found[0];
  let s = 0;
  if (idv) s += 40;
  if (nm) s += SRC_WEIGHT[nm.src] ?? 10;
  s += 8 * Math.min(rec.relRoles ?? 0, 6) + 4 * Math.min(rec.relPass ?? 0, 5);
  s += 2 * Math.min(rec.pass ?? 0, 10);
  s += Math.min(Math.round(Math.log2(1 + (rec.jobs ?? 0))), 5);
  // tier
  const strongSrc = nm && ['catalogue', 'wikidata', 'catalogue-domain', 'wikidata-domain'].includes(nm.src);
  const minKey = nm && nm.src.endsWith('-domain') ? 6 : 5;
  const nameStrong = !!strongSrc && (nm.key.length >= minKey || (rec.relRoles ?? 0) >= 1);
  // Relevance density: one hit among hundreds of roles is a big generalist employer, not a sector company.
  const dens = (rec.relRoles ?? 0) / Math.max(rec.jobs ?? 1, 1);
  const relOK = (rec.relRoles ?? 0) >= 3 ? dens >= 0.02 || rec.relRoles >= 10 : (rec.relRoles ?? 0) >= 1 && (dens >= 0.02 || (rec.jobs ?? 0) < 100);
  let tier;
  if (rec.status !== 'ok' || !rec.jobs) tier = 'REJECT';
  else if (idv || nameStrong || ((rec.relRoles ?? 0) >= 3 && relOK)) tier = 'HIGH';
  else if (relOK && (rec.pass ?? 0) >= 1) tier = 'MEDIUM';
  else if (nm && (rec.pass ?? 0) >= 1) tier = 'MEDIUM';   // short/generic name match that passes the filters: kept generous
  else if ((rec.pass ?? 0) >= 1) tier = 'LOW';
  else tier = 'REJECT';
  return { score: s, tier, level: idv ? 'verified' : nm ? 'plausible' : 'none' };
}
function csvCell(v) { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function matchStage(cfg) {
  const results = loadResults(), nameMap = loadNames();
  const hist = loadHistoryIndex();
  const idx = buildNameIndex(cfg, hist.companies);
  const known = existingKeys(cfg);
  const rows = [];
  for (const rec of results.values()) {
    if (rec.status !== 'ok') continue;
    const dk = dedupeKeyFor(rec.vendor, rec.slug);
    if (known.has(dk)) continue;   // spliced in an earlier run (or added by hand since)
    const boardName = nameMap.get(rec.k)?.name || '';
    const found = matchNames(rec, boardName, idx);
    const sc = score(rec, boardName, found);
    const ev = [];
    if (rec.idHits?.length) ev.push(`posting-id ${rec.idHits[0].id} also at ${rec.idHits[0].url.slice(0, 80)} (${rec.idHits[0].company})`);
    if (found[0]) ev.push(`${found[0].src}:"${found[0].name}" via ${found[0].via}`);
    if (rec.relRoles) ev.push(`${rec.relRoles} relevance roles: ${Object.entries(rec.relKw).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k}x${n}`).join(' ')}`);
    rows.push({ ...sc, rec, name: boardName || prettify(rec.slug), nameSource: boardName ? 'board' : 'slug', evidence: ev.join('; '), match: found[0] ? `${found[0].src}:${found[0].name}` : '' });
  }
  const T = { HIGH: 0, MEDIUM: 1, LOW: 2, REJECT: 3 };
  rows.sort((a, b) => T[a.tier] - T[b.tier] || b.score - a.score);
  const selected = new Set(rows.filter((r) => r.tier === 'HIGH' || r.tier === 'MEDIUM').slice(0, MAX_APPLY).map((r) => r.rec.k));
  const estReq = selected.size, estMb = Math.round((selected.size * MAX_JOBS_PER_ENTRY * JD_KB) / 1024);
  log(`[match] apply selection ${selected.size} (cap ${MAX_APPLY}): +${estReq} requests per cycle, worst-case JD storage ${estMb} MB (${MAX_JOBS_PER_ENTRY} jobs x ${JD_KB} KB x entries)`);
  state.estimate = { entries: estReq, requests_per_cycle: estReq, worst_case_jd_mb: estMb };
  const head = ['selected_for_apply', 'est_added_requests_per_cycle', 'est_worst_case_jd_mb', 'tier', 'score', 'provider', 'vendor', 'slug', 'name', 'name_source', 'jobs', 'pass_roles', 'title_pass', 'relevance_roles', 'relevance_pass', 'match_level', 'match', 'evidence', 'sample_titles', 'board_url'];
  const boardUrl = (r) => ({ greenhouse: `https://boards.greenhouse.io/${r.slug}`, ashby: `https://jobs.ashbyhq.com/${r.slug}`, lever: `https://jobs.${r.vendor === 'lever-eu' ? 'eu.' : ''}lever.co/${r.slug}`, workable: `https://apply.workable.com/${r.slug}`, personio: `https://${r.slug}.jobs.personio.${r.vendor === 'personio-com' ? 'com' : 'de'}`, recruitee: `https://${r.slug}.recruitee.com`, teamtailor: `https://${r.slug}.teamtailor.com`, join: `https://join.com/companies/${r.slug}`, bamboohr: `https://${r.slug}.bamboohr.com/careers`, smartrecruiters: `https://jobs.smartrecruiters.com/${r.slug}`, workday: (() => { const [t, w, s] = r.slug.split('|'); return `https://${t}.${w}.myworkdayjobs.com/${s}`; })() }[r.provider] ?? '');
  const lines = [head.join(',')];
  for (const r of rows) {
    const x = r.rec;
    lines.push([selected.has(x.k) ? 'yes' : '', selected.has(x.k) ? 1 : '', selected.has(x.k) ? ((MAX_JOBS_PER_ENTRY * JD_KB) / 1024).toFixed(2) : '', r.tier, r.score, x.provider, x.vendor, x.slug, r.name, r.nameSource, x.jobs, x.pass, x.titlePass, x.relRoles, x.relPass, r.level, r.match, r.evidence, (x.samples ?? []).slice(0, 5).join(' | '), boardUrl(x)].map(csvCell).join(','));
  }
  writeFileSync(CSV, lines.join('\n') + '\n');
  const tc = {};
  for (const r of rows) tc[r.tier] = (tc[r.tier] ?? 0) + 1;
  state.match = { updated: new Date().toISOString(), boards: rows.length, tiers: tc };
  saveState();
  log(`[match] ${rows.length} live-or-empty boards scored -> ${CSV}; tiers ${JSON.stringify(tc)}`);
  return rows;
}

// ---------------------------------------------------------------- stage 4: apply (text splice)
function entryText(r) {
  const x = r.rec;
  const e = { name: r.name, provider: x.provider, slug: x.slug };
  if (x.vendor === 'lever-eu') e.region = 'eu';
  if (x.vendor === 'personio-com') e.careers_url = `https://${x.slug}.jobs.personio.com`;
  e.enabled = true;
  e.note = `CC harvest ${r.tier} score ${r.score}; prune by classification later`;
  e.interval_hours = 12;
  e.probation = true;
  e.max_jobs = MAX_JOBS_PER_ENTRY;
  return JSON.stringify(e, null, 2).split('\n').map((l) => `    ${l}`).join('\n');
}
function apply(rows, cfg) {
  const pick = rows.filter((r) => r.tier === 'HIGH' || r.tier === 'MEDIUM');
  const sel = pick.slice(0, MAX_APPLY);   // rows are already sorted tier, score
  // Names must be unique enough to not collide visually; duplicates of an existing tracked name keep the provider as a hint.
  const used = new Set((cfg.tracked_companies ?? []).map((e) => norm(e.name)));
  for (const r of sel) { const k = norm(r.name); if (used.has(k)) r.name = `${r.name} (${r.rec.provider})`; used.add(norm(r.name)); }
  log(`[apply] ${pick.length} HIGH+MEDIUM boards, applying ${sel.length} (cap ${MAX_APPLY}); HIGH ${sel.filter((r) => r.tier === 'HIGH').length}, MEDIUM ${sel.filter((r) => r.tier === 'MEDIUM').length}`);
  if (flag('dry-run') || !sel.length) return;
  const src = readFileSync(COMPANIES === OUT_FILE ? COMPANIES : COMPANIES, 'utf8');
  const target = OUT_FILE === COMPANIES ? src : (existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : src);
  const end = target.lastIndexOf('\n  ]');
  if (end < 0) throw new Error('companies.json: closing "  ]" of tracked_companies not found; refusing to splice');
  const tail = target.slice(end);
  if (!/^\n  \]\s*\n\}\s*$/.test(tail)) throw new Error('companies.json: unexpected tail after tracked_companies; refusing to splice');
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bak = join(STATE_DIR, `companies.json.bak-${ts}`);
  if (OUT_FILE === COMPANIES) copyFileSync(COMPANIES, bak);
  const next = target.slice(0, end) + ',\n' + sel.map(entryText).join(',\n') + tail;
  // Validate before anything is written to the real path.
  const parsed = JSON.parse(next);
  const seen = new Set();
  for (const e of parsed.tracked_companies) { let r = null; try { r = resolveEntry(e); } catch { /* ignore */ } const k = `${r?.provider ?? e.provider}:${String(r?.slug ?? e.slug ?? e.name).toLowerCase()}`; if (seen.has(k) && e.note?.startsWith('CC harvest')) throw new Error(`duplicate after splice: ${k}`); seen.add(k); }
  const tmp = `${OUT_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, next);
  renameSync(tmp, OUT_FILE);
  // node --check on the crawler scripts that read this config (parse only; nothing is executed).
  for (const f of ['crawl.mjs', 'providers.mjs', 'cc-harvest.mjs']) {
    const c = spawnSync(process.execPath, ['--check', join(HERE, f)], { encoding: 'utf8' });
    if (c.status !== 0) log(`[apply] WARNING node --check ${f} failed: ${(c.stderr ?? '').slice(0, 200)}`);
  }
  state.applied = [...(state.applied ?? []), ...sel.map((r) => r.rec.k)];
  state.lastApply = { at: new Date().toISOString(), count: sel.length, out: OUT_FILE, backup: OUT_FILE === COMPANIES ? bak : null };
  saveState();
  log(`[apply] spliced ${sel.length} entries into ${OUT_FILE}${OUT_FILE === COMPANIES ? `; backup ${bak}` : ''}; JSON valid, ${parsed.tracked_companies.length} tracked companies now`);
}

// ---------------------------------------------------------------- main
(async () => {
  const cfg = JSON.parse(readFileSync(COMPANIES, 'utf8'));
  const run = flag('run');
  log(`cc-harvest start: ${args.join(' ')} (pid ${process.pid})`);
  if (run || flag('harvest')) await harvest();
  if (run || flag('probe')) await probe(cfg);
  if (run || flag('names')) await names();
  let rows;
  if (run || flag('match') || flag('apply')) rows = matchStage(cfg);
  if (flag('apply')) apply(rows, cfg);
  log('cc-harvest finished');
})().catch((e) => { log(`FATAL ${e.stack ?? e}`); process.exit(1); });
