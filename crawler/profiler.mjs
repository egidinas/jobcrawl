#!/usr/bin/env node
// Career-site profiler: given employer careers URLs (or websites), discover ONCE how to read each job list and write a registry entry,
// so the regular crawl reads it over plain HTTP, with no browser and no model. Cascade and verification: crawler/profiler/cascade.mjs.
//
//   node crawler/profiler.mjs run --profile <dir> --input sites.jsonl --out report.jsonl [--log run.log] [--concurrency 4] [--limit N]
//        [--budget 10] [--browser] [--llm http://127.0.0.1:8091] [--steps ats,jsonld,sitemap,rss,dom,xhr,llm] [--save-pages <dir>]
//        [--date YYYY-MM-DD] [--no-resume]
//   node crawler/profiler.mjs splice --profile <dir> --report report.jsonl [--companies <file>] [--date D] [--max N] [--replace] [--dry-run]
//   node crawler/profiler.mjs reprofile-queue --profile <dir> [--data <dir>] --out sites.jsonl
//
// sites.jsonl: one JSON object per line { key, name, website, careers_url, posting_url, country, source, signal } (website or a URL needed).
// run appends one record per site to --out (resumable: keys already there are skipped) and logs start / progress / result lines to --log.
// splice appends the VERIFIED entries (probation: true, a profile baseline, a "profiled <method> <date>" note) to the companies file,
// skipping names and hosts the registry already has. reprofile-queue turns the crawl's reprofile_due flags (source-health.json) into input.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setCacheDir } from './providers.mjs';
import { loadProfile, profileDirFromArgs, resolveDataDir } from './profile.mjs';
import { UA, setUserAgent } from './useragent.mjs';
import { makeNet } from './profiler/net.mjs';
import { profileSite } from './profiler/cascade.mjs';
import { hostOf, regDomain, decode } from './profiler/detect.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const flag = (n) => args.includes(`--${n}`);
let PROFILE;
try { PROFILE = loadProfile(profileDirFromArgs(args)); } catch (e) { console.error(`profiler: ${e.message}`); process.exit(2); }
if (!PROFILE) { console.error('profiler: no profile. Pass --profile <dir> (or set JOBCRAWL_PROFILE).'); process.exit(2); }
setUserAgent(PROFILE.userAgent);
const DATE = opt('date', new Date().toISOString().slice(0, 10));
const LOG = opt('log');
const t0 = Date.now();
const say = (msg, console_ = false) => {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} [${String(Math.round((Date.now() - t0) / 1000)).padStart(6)}s] ${msg}`;
  if (LOG) appendFileSync(LOG, line + '\n');
  if (console_ || !LOG) console.log(line);
};
const readJsonl = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

if (cmd === 'run') { await run(); process.exit(0); }   // a browser pipe or a pending verification timer must not keep a finished run alive
else if (cmd === 'splice') splice();
else if (cmd === 'reprofile-queue') reprofileQueue();
else { console.error('usage: node crawler/profiler.mjs run|splice|reprofile-queue --profile <dir> ... (see the header of crawler/profiler.mjs)'); process.exit(2); }

async function run() {
  const input = opt('input'), out = opt('out');
  if (!input || !out) { console.error('profiler run: --input and --out are required'); process.exit(2); }
  const done = new Set(flag('no-resume') ? [] : readJsonl(out).map((r) => r.key));
  let sites = readJsonl(input).filter((s) => s.key && !done.has(s.key));
  const limit = Number(opt('limit', 0));
  if (limit) sites = sites.slice(0, limit);
  const conc = Math.max(1, Number(opt('concurrency', 4)));
  const budget = Number(opt('budget', 10));
  const steps = opt('steps') ? new Set(opt('steps').split(',')) : null;   // ats,jsonld,sitemap,rss,dom,xhr,llm (default: all)
  const token = UA.match(/compatible;\s*([^;)]+)/)?.[1]?.trim() ?? 'jobcrawl';
  setCacheDir(mkdtempSync(join(tmpdir(), 'profiler-cache-')));   // verification runs keep no crawl state
  const net = makeNet({ token, budget, log: (m) => say(m) });
  net.install();
  let sniffer = null, llm = null;
  if (flag('browser')) {
    const { makeSniffer } = await import('./profiler/sniff.mjs');
    sniffer = await makeSniffer({ ua: UA, log: (m) => say(m) });
  }
  if (opt('llm')) {
    const { makeLlm } = await import('./profiler/llm.mjs');
    llm = makeLlm({ url: opt('llm'), log: (m) => say(m) });
  }
  // --save-pages <dir>: keep every fetched page (<key>-<n>-<role>.html, with its URL in a comment) for fixtures and failure analysis
  const saveDir = opt('save-pages');
  const savePages = saveDir ? (site, i, p) => {
    try { mkdirSync(saveDir, { recursive: true }); writeFileSync(join(saveDir, `${String(site.key).replace(/[^\w.-]+/g, '_')}-${i}-${p.role}.html`), `<!-- ${p.url} -->\n${p.html}`); } catch {}
  } : null;
  say(`=== profiler run start: ${sites.length} sites (${done.size} already in ${out}), concurrency ${conc}, budget ${budget}/site, browser ${sniffer ? 'on' : 'off'}, llm ${llm ? opt('llm') : 'off'}, UA token "${token}"`, true);
  const tally = {};
  let n = 0, lastProgress = Date.now(), i = 0;
  const progress = (force) => {
    if (!force && n % 10 && Date.now() - lastProgress < 60000) return;
    lastProgress = Date.now();
    const el = (Date.now() - t0) / 1000;
    say(`progress ${n}/${sites.length}: ${Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')} | requests ${net.stats.requests}, robots-blocked ${net.stats.robots_blocked}, ${(n / el * 60).toFixed(1)} sites/min`, force);
  };
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < sites.length) {
      const site = sites[i++];
      let rec;
      try {
        rec = await net.run(site, () => profileSite(site, { net, sniff: sniffer ? (u) => sniffer.sniff(u) : null, llm, ua: UA, date: DATE, log: (m) => say(m), savePages, steps }), budget);
      } catch (e) { rec = { key: site.key, name: site.name, verified: false, reason: `crash: ${String(e.stack ?? e).slice(0, 300)}` }; }
      const k = rec.verified ? `ok:${rec.method}` : `fail:${rec.reason}`;
      tally[k] = (tally[k] ?? 0) + 1;
      n++;
      appendFileSync(out, JSON.stringify(rec) + '\n');
      say(`${rec.verified ? 'OK  ' : 'FAIL'} ${site.name} (${site.key}): ${rec.verified ? `${rec.method} ${rec.items} items, e.g. ${rec.samples?.[0]?.title ?? ''}` : rec.reason} [${rec.requests ?? '?'} req${rec.browser_requests ? ` + ${rec.browser_requests} browser` : ''}, ${Math.round((rec.ms ?? 0) / 1000)}s]`);
      progress(false);
    }
  }));
  if (sniffer) await Promise.race([sniffer.close(), new Promise((r) => setTimeout(r, 15000))]);
  net.uninstall();
  progress(true);
  say(`=== profiler run done: ${n} sites in ${Math.round((Date.now() - t0) / 1000)}s; verified ${Object.entries(tally).filter(([k]) => k.startsWith('ok:')).reduce((a, [, v]) => a + v, 0)}; report ${out}`, true);
}

function splice() {
  const report = opt('report');
  const file = resolve(opt('companies', PROFILE.companiesFile));
  const max = Number(opt('max', 0));
  const raw = readFileSync(file, 'utf8');
  const cfg = JSON.parse(raw);
  const EOL = raw.includes('\r\n') ? '\r\n' : '\n';   // keep the file's line endings (the madenetwork.de blob is CRLF)
  const names = new Set(cfg.tracked_companies.map((c) => c.name.toLowerCase()));
  const hostsOf = (c) => [c.careers_url, c.slug, c.list?.url].filter((u) => /^https?:\/\//.test(u ?? '')).map((u) => hostOf(u));
  const hosts = new Set(cfg.tracked_companies.flatMap(hostsOf));
  const doms = new Map();
  for (const c of cfg.tracked_companies) for (const h of hostsOf(c)) doms.set(regDomain(h), c.name);
  const added = [], skipped = {}, replaced = [];
  const REPLACE = flag('replace');
  const BOARD_KEYS = ['careers_url', 'provider', 'slug', 'list', 'job_url_pattern', 'url_pattern', 'link_hosts', 'jsonld_only', 'pages', 'sitemap', 'max_jobs',
    'page_budget_ms', 'page_concurrency', 'api', 'feed_url', 'queries', 'search_text', 'filter_text', 'facets', 'region', 'profile'];
  const skip = (why, r) => { (skipped[why] ??= []).push(r.name); };
  const all = readJsonl(report);
  const latest = new Map();
  for (const r of all.filter((x) => x.verified && x.entry)) latest.set(r.key, r);   // a later run of the same key wins
  // WATCH (owner 2026-11-06: "no job is no reason to not be on the crawl"): an in-scope employer whose careers page says it has no
  // openings today gets a slow probation entry on that page (JobPosting JSON-LD only, so nothing but real postings is ever read);
  // `reprofile-queue` hands watch entries back to the profiler after 30 days, when the page may carry a readable list.
  // a real careers page (not the home page): it says "no openings", or it has no list the cascade could read today
  const watchable = (r) => r.reason === 'no_openings' || (['no_job_list_found', 'few_or_unreadable_items'].includes(r.reason) && /^ok:(?:careers|careers-guess|list|posting-parent)$/.test(r.steps?.landing ?? ''));
  for (const r of all) {
    if (r.verified || latest.has(r.key) || !r.careers_page || !watchable(r)) continue;
    latest.set(r.key, { ...r, watch: true, items: 0, samples: [],
      entry: { name: r.name, careers_url: r.careers_page, provider: 'jsonld_direct', slug: r.careers_page, max_jobs: 30, profile: { method: 'watch', at: DATE, items: 0, expected_min: 0, expected_max: 20 } } });
  }
  for (const r of latest.values()) {
    if (max && added.length >= max) break;
    // the verification's site-title guard, re-applied to the stored samples (records written before the guard existed)
    const st = new Set((r.samples ?? []).map((s) => String(s.title).toLowerCase()));
    if ((r.samples ?? []).length >= 2 && st.size === 1 && /\s[-|–]\s/.test(r.samples[0].title)) { skip('samples_are_site_titles', r); continue; }
    // an ATS board larger than the profiling budget is a multinational's whole tenant (Accenture, the Airbus Workday behind Tesat):
    // never auto-added, listed for review
    if (/larger than the profiling budget/.test(r.steps?.ats ?? '')) { skip('board_larger_than_budget', r); continue; }
    const e = { ...r.entry };
    // "Bayern Photonics: inno-spec" / "Pixel Photonics › QBN": the list's prefix or breadcrumb is the source, not the employer
    e.name = decode(String(r.name_display ?? r.name_suggested ?? e.name ?? r.name)).replace(/^[^:]{3,40}:\s+/, '').replace(/\s+[›»|]\s+.*$/, '').trim();
    // a dataset row without an employer name ("[url]"): the site's own name, else its domain
    if (/^\[?(?:url|link|none|null|n\/a)?\]?$/i.test(e.name)) e.name = decode(r.name_suggested ?? '') || regDomain(hostOf(e.careers_url ?? ''));
    if (!e.name) { skip('no_name', r); continue; }
    if (names.has(e.name.toLowerCase())) {
      // --replace: a re-profiled or re-resolved board replaces the board fields of the entry with exactly this name (the rest - tags,
      // any_location, probation, interval - stays); the entry is enabled again
      const old = REPLACE && !r.watch ? cfg.tracked_companies.find((c) => c.name === e.name) : null;
      if (!old) { skip('name_tracked', r); continue; }
      for (const k of BOARD_KEYS) delete old[k];
      for (const [k, v] of Object.entries(e)) if (k !== 'name' && k !== 'profile') old[k] = v;
      if (old.provider === 'jsonld_direct') old.jsonld_only = true;
      old.profile = e.profile; old.enabled = true;
      old.note = `${old.note ? `${old.note} | ` : ''}re-profiled ${e.profile.method} ${DATE}: ${r.items} items (expected ${e.profile.expected_min}-${e.profile.expected_max})`.slice(-900);
      replaced.push(old.name);
      continue;
    }
    const h = hostsOf(e);
    // a shared ATS host (boards.greenhouse.io) is not a duplicate; the board slug is. A company domain already tracked is.
    const ats = e.provider !== 'paginated_list' && e.provider !== 'jsonld_direct' && e.provider !== 'sitemap';
    if (ats ? cfg.tracked_companies.some((c) => c.provider === e.provider && c.slug === e.slug) : h.some((x) => hosts.has(x) || doms.has(regDomain(x)))) { skip('host_tracked', r); continue; }
    const sample = decode((r.samples ?? []).slice(0, 3).map((s) => s.title).join(' | '));
    const entry = { name: e.name, careers_url: e.careers_url, provider: e.provider, ...(e.slug ? { slug: e.slug } : {}) };
    for (const [k, v] of Object.entries(e)) if (!(k in entry) && k !== 'profile' && k !== 'name') entry[k] = v;
    const empty = !(r.items > 0);
    Object.assign(entry, { enabled: true, probation: true, interval_hours: empty ? 168 : 24 });
    if (entry.provider === 'jsonld_direct') entry.jsonld_only = true;   // verified on JobPosting markup: never read other pages as postings
    // the first fill of a big jsonld_direct board reads one page per posting (2 at a time): more than the crawl's default 35 s
    if (entry.provider === 'jsonld_direct' && r.items > 40) entry.timeout_ms = 120000;
    if (r.collect_only) entry.collect_only = true;
    entry.profile = e.profile;
    const src = `source ${r.input?.source ?? '?'}${r.input?.signal ? `, in-scope signal ${r.input.signal}` : ''}`;
    entry.note = (empty
      ? `profiled: empty at ${DATE} (${!r.watch ? `${e.profile.method}: the board answered with 0 postings` : r.reason === 'no_openings' ? 'the careers page says there are no openings' : 'careers page found, no readable job list'}); weekly, JobPosting pages only, until postings appear; ${src}`
      : `profiled ${e.profile.method} ${DATE}: ${r.items} items on the profiling day (expected ${e.profile.expected_min}-${e.profile.expected_max}); ${src}; sample: ${sample}`).slice(0, 600);
    names.add(entry.name.toLowerCase());
    for (const x of h) { hosts.add(x); if (!ats) doms.set(regDomain(x), entry.name); }
    added.push(entry);
  }
  say(`splice: ${added.length} entries to add (${added.filter((x) => x.interval_hours === 168).length} watch/empty) from ${latest.size} verified or watch records; skipped ${Object.entries(skipped).map(([k, v]) => `${k} ${v.length}`).join(', ') || 'none'}`, true);
  for (const [k, v] of Object.entries(skipped)) say(`splice: skipped ${k}: ${v.slice(0, 40).join('; ')}`, true);
  if (replaced.length) say(`splice: replaced the board of ${replaced.length} tracked entries: ${replaced.join('; ')}`, true);
  if (flag('dry-run') || (!added.length && !replaced.length)) { if (flag('dry-run')) console.log(JSON.stringify(added.slice(0, 3), null, 2)); return; }
  if (replaced.length) {
    // replacing in place rewrites the file: only when it is in canonical form (JSON.stringify, 2 spaces), so the diff stays the entries
    const canon = (o) => JSON.stringify(o, null, 2) + '\n';
    if (canon(JSON.parse(raw)) !== raw.replace(/\r\n/g, '\n')) throw new Error('splice --replace: the companies file is not in canonical JSON form; replace by hand');
    cfg.tracked_companies.push(...added);
    writeFileSync(file, canon(cfg).replace(/\n/g, EOL));
    say(`splice: wrote ${added.length} new and ${replaced.length} replaced entries to ${file}`, true);
    return;
  }
  // textual append before the closing "]" of tracked_companies, so the rest of the hand-kept file is untouched
  const block = added.map((e) => JSON.stringify(e, null, 2).replace(/^/gm, '    ')).join(',\n');
  const m = raw.match(/\n(\s*)\]\s*\}\s*$/);
  if (!m) throw new Error('splice: tracked_companies is not the last key of the companies file');
  const head = raw.slice(0, m.index).replace(/\s*$/, '');
  const next = `${head},\n${block}\n${m[1]}]\n}\n`;
  JSON.parse(next);
  writeFileSync(file, next.replace(/\r?\n/g, EOL));
  say(`splice: wrote ${added.length} entries to ${file}`, true);
}

function reprofileQueue() {
  const data = resolveDataDir(opt('data'), PROFILE);
  const out = opt('out');
  const health = JSON.parse(readFileSync(join(data, 'source-health.json'), 'utf8'));
  const cfg = JSON.parse(readFileSync(PROFILE.companiesFile, 'utf8'));
  // flagged by the crawl, plus watch entries (empty careers pages) whose last profile is 30 days old
  const stale = (c) => c.profile?.method === 'watch' && Date.now() - Date.parse(c.profile.at) > 30 * 864e5;
  const due = cfg.tracked_companies.filter((c) => health[c.name]?.reprofile_due || stale(c));
  const lines = due.map((c) => JSON.stringify({ key: `reprofile:${c.name}`, name: c.name, careers_url: c.careers_url ?? '', website: '', source: 'reprofile', reason: health[c.name]?.reprofile_reason ?? (stale(c) ? 'watch entry, 30 days' : ''), previous: { provider: c.provider, method: c.profile?.method } }));
  writeFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''));
  say(`reprofile-queue: ${due.length} companies flagged reprofile_due in ${join(data, 'source-health.json')} -> ${out}`, true);
}
