#!/usr/bin/env node
// Evaluate board identification on the registry: the tracked companies whose provider is known are the labelled set.
//
//   node crawler/profiler/eval-detect.mjs --companies <companies.json> --cache <dir> --out <report.json> [--fetch --profile <dir>] [--log <file>]
//        [--concurrency 6] [--per-label 120] [--negatives 300]
//
// Without --fetch nothing goes to the network: pages come from --cache only (a missing page is counted as "not fetched").
// With --fetch each careers page is fetched once (redirects followed, 15 s timeout, one request per company, its CNAME looked up) and
// stored in --cache (network errors are retried by the next --fetch run), so a re-run after tuning fingerprints.json costs no requests.
//
// Labelled rows: enabled entries on an ATS provider whose careers_url is on the EMPLOYER's host (a careers_url on the vendor's host is
// trivially identified and left out), capped at --per-label per provider (Teamtailor alone has ~500); negatives: entries on the generic
// providers (jsonld_direct, sitemap, paginated_list) labelled "none". Split by a hash of the name: 20 % hold-out (fold 0), 80 % tuning.
// Two detectors are scored on the same pages: "links" = atsFingerprints (provider detect() over the page's links, the old step 1) and
// "multi" = identifyPlatforms (fingerprints.json signals + CNAME, top platform with confidence >= 0.5), and "either" = links, else multi.
// Report: precision / recall per provider and micro-averaged, for tuning and hold-out separately, over all rows and over the rows the
// careers URL alone does not answer (headline). One page per company, no hops; the 'none' precision is a lower bound (a generic board
// whose page embeds an ATS counts as a false positive although it is often a real board: see negatives_with_platform).
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const flag = (n) => args.includes(`--${n}`);
if (flag('help') || !opt('companies') || !opt('cache') || !opt('out')) {
  console.log('usage: node crawler/profiler/eval-detect.mjs --companies <file> --cache <dir> --out <report.json> [--fetch] [--log <file>] [--concurrency 6] [--per-label 120] [--negatives 300]');
  process.exit(flag('help') ? 0 : 2);
}
const { atsFingerprints } = await import('./detect.mjs');
const { identifyPlatforms, cnameOf, isVendorHost, PLATFORMS } = await import('./platforms.mjs');
const { UA, setUserAgent } = await import('../useragent.mjs');

const LOG = opt('log');
const t0 = Date.now();
const say = (m) => { const l = `${new Date().toISOString()} [${Math.round((Date.now() - t0) / 1000)}s] ${m}`; if (LOG) appendFileSync(LOG, l + '\n'); else console.log(l); };
const CACHE = opt('cache');
mkdirSync(CACHE, { recursive: true });
// --fetch goes through the crawl policy (robots mode, opt-outs, login-URL rule, cooldowns) with the profile's user agent; its audit
// and flags are written next to the cache, never into a crawl data folder
if (flag('fetch')) {
  const { loadProfile, profileDirFromArgs } = await import('../profile.mjs');
  const { configurePolicy, policyFromProfile, installGuard } = await import('../policy.mjs');
  let profile = null;
  try { profile = loadProfile(profileDirFromArgs(args)); } catch (e) { console.error(`eval-detect: ${e.message}`); process.exit(2); }
  if (!profile) { console.error('eval-detect: --fetch needs --profile <dir> (user agent and crawl policy)'); process.exit(2); }
  setUserAgent(profile.userAgent);
  configurePolicy(policyFromProfile(profile, CACHE));
  installGuard();
}
const GENERIC = new Set(['jsonld_direct', 'sitemap', 'paginated_list']);
const NOT_LABEL = new Set(['eures', 'usajobs', 'consider', 'spacecareers', 'spacecapital', 'spaceindividuals', 'jobsinphotonics', 'mycareersfuture']);
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };
const h8 = (s) => createHash('sha1').update(String(s)).digest('hex');
const fold = (name) => parseInt(h8(name).slice(0, 8), 16) % 5;   // 0 = hold-out

const cfg = JSON.parse(readFileSync(opt('companies'), 'utf8'));
const all = (cfg.tracked_companies ?? []).filter((c) => c.enabled !== false && c.careers_url && /^https?:\/\//.test(c.careers_url) && !NOT_LABEL.has(c.provider));
const byLabel = new Map();
for (const c of all) {
  const h = hostOf(c.careers_url);
  if (!h || isVendorHost(h)) continue;
  const label = GENERIC.has(c.provider) ? 'none' : c.provider;
  if (!byLabel.has(label)) byLabel.set(label, []);
  byLabel.get(label).push(c);
}
const perLabel = Number(opt('per-label', 120)), negatives = Number(opt('negatives', 300));
const rows = [];
for (const [label, list] of byLabel) {
  const cap = label === 'none' ? negatives : perLabel;
  for (const c of list.sort((a, b) => h8(a.name).localeCompare(h8(b.name))).slice(0, cap)) rows.push({ name: c.name, url: c.careers_url, label, fold: fold(c.name) });
}
say(`start rows=${rows.length} labels=${byLabel.size} fetch=${flag('fetch')} cache=${CACHE}`);

const cacheFile = (u) => join(CACHE, h8(u).slice(0, 16) + '.json');
async function page(u) {
  const f = cacheFile(u);
  const cached = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  if (cached && !(cached.error && flag('fetch'))) return cached;   // a network error is fetched again on the next --fetch run
  if (!flag('fetch')) return cached;
  const rec = { url: u, final: u, status: 0, html: '', cname: '', error: '' };
  try {
    const res = await fetch(u, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    rec.status = res.status; rec.final = res.url;
    if (/html|xml|text/i.test(res.headers.get('content-type') ?? '')) rec.html = (await res.text()).slice(0, 1_500_000);
  } catch (e) { rec.error = String(e.cause?.code ?? e.name ?? e.message).slice(0, 60); }
  rec.cname = await cnameOf(hostOf(u));
  writeFileSync(f, JSON.stringify(rec));
  return rec;
}

const preds = [];
let i = 0, done = 0;
const conc = Number(opt('concurrency', 6));
await Promise.all(Array.from({ length: conc }, async () => {
  while (i < rows.length) {
    const r = rows[i++];
    let p = null;
    try { p = await page(r.url); } catch (e) { say(`fail ${r.name}: ${e.message}`); }
    const row = { ...r, fetched: !!p, status: p?.status ?? 0, error: p?.error ?? '', links: null, multi: null, multiConf: 0, multiSlug: null };
    if (p && (p.html || p.final)) {
      const pages = [{ url: p.final, requested: p.url, html: p.html }];
      row.links = atsFingerprints(p.html, p.final)[0]?.provider ?? null;
      // answered by the URL alone (a provider's detect() on the careers URL or where it redirected), without reading the page
      row.urlOnly = !!(atsFingerprints('', p.url)[0] ?? atsFingerprints('', p.final)[0]);
      const top = identifyPlatforms({ pages, cnames: p.cname ? { [hostOf(p.url)]: p.cname } : {} }).filter((x) => x.confidence >= 0.5)[0];
      if (top) { row.multi = top.provider ?? `(${top.id})`; row.multiConf = top.confidence; row.multiSlug = top.slug; }
    }
    preds.push(row);
    if (++done % 50 === 0 || done === rows.length) say(`progress ${done}/${rows.length} current=${r.name.slice(0, 40)}`);
  }
}));

function score(list, key) {
  const per = {};
  const bump = (k, f) => { per[k] ??= { tp: 0, fp: 0, fn: 0, n: 0 }; per[k][f]++; };
  for (const r of list) {
    if (r.label !== 'none') per[r.label] ??= { tp: 0, fp: 0, fn: 0, n: 0 }, per[r.label].n++;
    const p = r[key];
    if (p && p === r.label) bump(p, 'tp');
    else {
      if (p && !p.startsWith('(')) bump(p, 'fp');
      if (r.label !== 'none') bump(r.label, 'fn');
    }
  }
  const f = (x) => { const P = x.tp + x.fp ? x.tp / (x.tp + x.fp) : null, R = x.tp + x.fn ? x.tp / (x.tp + x.fn) : null; return { ...x, precision: P === null ? null : +P.toFixed(3), recall: R === null ? null : +R.toFixed(3) }; };
  const sum = Object.values(per).reduce((a, x) => ({ tp: a.tp + x.tp, fp: a.fp + x.fp, fn: a.fn + x.fn, n: a.n + x.n }), { tp: 0, fp: 0, fn: 0, n: 0 });
  return { micro: f(sum), per: Object.fromEntries(Object.entries(per).sort((a, b) => b[1].n - a[1].n).map(([k, x]) => [k, f(x)])) };
}
for (const r of preds) r.either = r.links ?? r.multi;
// Labels scored: platforms in fingerprints.json (multi-employer ATSs) and "none"; single-employer providers (a site-specific reader
// whose detect() names one host) say nothing about identification and are left out.
const PLATFORM_PROVIDERS = new Set(PLATFORMS.map((x) => x.provider).filter(Boolean));
const usable = preds.filter((r) => r.fetched && !r.error && r.status && r.status < 400 && (r.label === 'none' || PLATFORM_PROVIDERS.has(r.label)));
const pageNeeded = usable.filter((r) => !r.urlOnly);
const report = {
  at: new Date().toISOString(), rows: rows.length, fetched: preds.filter((r) => r.fetched).length, usable: usable.length,
  unusable: Object.entries(preds.filter((r) => !usable.includes(r)).reduce((a, r) => { const k = r.error || (r.fetched ? `HTTP ${r.status}` : 'not fetched'); a[k] = (a[k] ?? 0) + 1; return a; }, {})),
  single_employer_rows_left_out: preds.filter((r) => r.label !== 'none' && !PLATFORM_PROVIDERS.has(r.label)).length,
  url_only_rows: usable.filter((r) => r.urlOnly).length,
  // headline: rows the careers URL alone does not answer (the page has to be read)
  holdout_page_needed: Object.fromEntries(['links', 'multi', 'either'].map((k) => [k, score(pageNeeded.filter((r) => r.fold === 0), k)])),
  tuning_page_needed: Object.fromEntries(['links', 'multi', 'either'].map((k) => [k, score(pageNeeded.filter((r) => r.fold !== 0), k)])),
  holdout: Object.fromEntries(['links', 'multi', 'either'].map((k) => [k, score(usable.filter((r) => r.fold === 0), k)])),
  tuning: Object.fromEntries(['links', 'multi', 'either'].map((k) => [k, score(usable.filter((r) => r.fold !== 0), k)])),
  misses_tuning: usable.filter((r) => r.fold !== 0 && r.label !== 'none' && r.either !== r.label).map((r) => ({ name: r.name, url: r.url, label: r.label, links: r.links, multi: r.multi })),
  // generic-provider boards whose careers page names an ATS: often a real board the generic reader is standing in for (or a false
  // positive); either way worth a look, and the reason the 'none' precision is a lower bound
  negatives_with_platform: usable.filter((r) => r.label === 'none' && r.either && !r.either.startsWith('(')).map((r) => ({ name: r.name, url: r.url, links: r.links, multi: r.multi, slug: r.multiSlug })),
};
writeFileSync(opt('out'), JSON.stringify(report, null, 1));
say(`result page-needed holdout either ${JSON.stringify(report.holdout_page_needed.either.micro)} links ${JSON.stringify(report.holdout_page_needed.links.micro)}; all-rows holdout either micro ${JSON.stringify(report.holdout.either.micro)} links micro ${JSON.stringify(report.holdout.links.micro)} usable=${usable.length}/${rows.length}`);
