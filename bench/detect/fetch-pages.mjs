#!/usr/bin/env node
// Fetch the detector benchmark pages (split v2): per row the input URL and its first follow (core/detect followTarget).
//
//   node bench/detect/fetch-pages.mjs --split bench/detect/split-v2.jsonl --cache <dir> --log <file> [--budget 600] [--gap-ms 1500]
//        [--user-agent "<ua>"] [--dry-run]
//
// Polite by construction: ONE request at a time over the whole run, request starts >= --gap-ms apart (a robots.txt Crawl-delay above
// that is honoured per host), robots.txt read once per origin and obeyed strictly (a disallowed URL is skipped and recorded), every
// request through the egress guard (public addresses only, every redirect hop checked), 20 s timeout, no retries. Every request counts
// against --budget (robots.txt included; redirect hops inside one fetch count once). Resumable: rows already in --cache are skipped.
// Output: <cache>/<id>.json = { url, final, status, html, cname, error, follow: { url, final, status, html, error } | null, robots }.
// Progress goes to --log (one line per row, a summary line every 10 rows, a result line); the console stays terse.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRobots, robotsAllows } from '../../crawler/policy.mjs';
import { cnameOf } from '../../crawler/profiler/platforms.mjs';
import { makeGuardedFetch } from '../../core/fetch/guard.mjs';
import { followTarget } from '../../core/detect/index.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const flag = (n) => args.includes(`--${n}`);
if (flag('help') || !opt('split') || !opt('cache') || !opt('log')) { console.log('usage: node bench/detect/fetch-pages.mjs --split <jsonl> --cache <dir> --log <file> [--budget 600] [--gap-ms 1500] [--user-agent <ua>] [--dry-run]'); process.exit(flag('help') ? 0 : 2); }
const CACHE = opt('cache'), LOG = opt('log'), BUDGET = Number(opt('budget', 600)), GAP = Math.max(1500, Number(opt('gap-ms', 1500)));
const UA = opt('user-agent', 'Mozilla/5.0 (compatible; MADE-jobs-crawler; +https://madenetwork.de/jobs.html)');
const TOKEN = UA.match(/compatible;\s*([^;)]+)/)?.[1]?.trim() ?? 'jobcrawl';
mkdirSync(CACHE, { recursive: true });
const t0 = Date.now();
const say = (m) => appendFileSync(LOG, `${new Date().toISOString()} [${Math.round((Date.now() - t0) / 1000)}s] ${m}\n`);

const rows = readFileSync(opt('split'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const todo = rows.filter((r) => !existsSync(join(CACHE, r.id + '.json')));
say(`start rows=${rows.length} todo=${todo.length} budget=${BUDGET} gap_ms=${GAP} ua_token=${TOKEN} dry_run=${flag('dry-run')}`);
if (flag('dry-run')) { console.log(`dry run: ${todo.length} rows to fetch, nothing requested`); process.exit(0); }

const guarded = makeGuardedFetch(globalThis.fetch);
let used = 0, last = 0;
const hostNext = new Map();   // per-host earliest next start (Crawl-delay)
const robotsCache = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function slot(host, delayS = 0) {
  const now = Date.now();
  const wait = Math.max(last + GAP, hostNext.get(host) ?? 0) - now;
  if (wait > 0) await sleep(wait);
  last = Date.now();
  if (delayS > 0) hostNext.set(host, last + delayS * 1000);
}
async function get(url, accept = 'text/html,application/xhtml+xml,*/*;q=0.8') {
  const host = new URL(url).host;
  used++;
  await slot(host, robotsCache.get(new URL(url).origin)?.delay ?? 0);
  const res = await guarded(url, { headers: { 'user-agent': UA, accept }, signal: AbortSignal.timeout(20000) });
  const type = res.headers.get('content-type') ?? '';
  const body = /html|xml|text|json/i.test(type) ? (await res.text()).slice(0, 3_000_000) : '';
  return { status: res.status, final: res.url || url, body };
}
async function robotsFor(url) {
  const origin = new URL(url).origin;
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  let r = { rules: [], delay: 0, note: '' };
  try {
    const x = await get(`${origin}/robots.txt`, 'text/plain,*/*');
    if (x.status >= 200 && x.status < 300) r = { ...parseRobots(x.body, TOKEN), note: 'ok' };
    else if (x.status >= 500) r = { rules: [{ allow: false, path: '/' }], delay: 0, note: `robots ${x.status}: treated as disallow-all` };
    else r = { rules: [], delay: 0, note: `robots ${x.status}` };
  } catch (e) { r = { rules: [], delay: 0, note: `robots error ${String(e?.cause?.code ?? e?.name ?? e).slice(0, 40)}` }; }
  robotsCache.set(origin, r);
  return r;
}
async function page(url) {
  const rb = await robotsFor(url);
  const u = new URL(url);
  if (!robotsAllows(rb, u.pathname + u.search)) return { url, final: url, status: 0, html: '', error: 'robots_disallow', robots: rb.note };
  try { const x = await get(url); return { url, final: x.final, status: x.status, html: x.body, error: '', robots: rb.note }; }
  catch (e) { return { url, final: url, status: 0, html: '', error: String(e?.cause?.code ?? e?.name ?? e?.message ?? e).slice(0, 80), robots: rb.note }; }
}

let done = 0, stopped = false;
const tally = { ok: 0, follow: 0, robots: 0, error: 0 };
for (const r of todo) {
  // a row needs up to 4 requests (two robots.txt, two pages): stop cleanly before the budget could be overrun
  if (used + 4 > BUDGET) { stopped = true; say(`budget stop: used=${used} of ${BUDGET}; rows left undone: ${todo.length - done}`); break; }
  const p1 = await page(r.url);
  const rec = { ...p1, cname: await cnameOf(new URL(r.url).hostname), follow: null };
  if (p1.html && p1.status < 400) {
    const next = followTarget(p1.html, p1.final);
    if (next) { rec.follow = await page(next); if (rec.follow.html) tally.follow++; }
  }
  writeFileSync(join(CACHE, r.id + '.json'), JSON.stringify(rec));
  if (p1.error === 'robots_disallow') tally.robots++; else if (p1.error || p1.status >= 400) tally.error++; else tally.ok++;
  done++;
  say(`row ${done}/${todo.length} ${r.id} status=${p1.status}${p1.error ? ' error=' + p1.error : ''} bytes=${p1.html.length} follow=${rec.follow ? `${rec.follow.status}${rec.follow.error ? ' ' + rec.follow.error : ''}` : '-'} used=${used}`);
  if (done % 10 === 0) say(`progress ${done}/${todo.length} used=${used}/${BUDGET} ${JSON.stringify(tally)} rate=${(used / ((Date.now() - t0) / 60000)).toFixed(1)} req/min`);
}
say(`result rows_done=${done} of ${todo.length} requests=${used} ${JSON.stringify(tally)}${stopped ? ' (budget stop)' : ''}`);
console.log(`done ${done}/${todo.length} rows, ${used} requests, ${JSON.stringify(tally)}${stopped ? ' (budget stop)' : ''}`);
