#!/usr/bin/env node
// Build the frozen detector benchmark split (JOBCRAWLX row 2A.5). Run ONCE; the output is committed and never rebuilt after tuning starts.
//
//   node bench/detect/build-split.mjs --companies <companies.json> [--cache <evalcache dir>] --out bench/detect/split-v1.jsonl
//
// Labels: every tracked entry with an http(s) careers_url whose provider is a board source (aggregators and EURES searches are left out).
// label = the provider; class = 'custom' for the generic readers (jsonld_direct, sitemap, paginated_list). Split by COMPANY: entries that
// share a normalised name or an employer registrable domain are one group (union-find), and a group goes to the hold-out when
// sha1(SALT + group key) % 4 == 0 (25 %). With --cache (the eval-detect page cache: <sha1(url)[:16]>.json = { url, final, status, html,
// cname }) each row records whether a usable page exists and the sha1 of its HTML, so a later run can prove it read the same pages.
// No network.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { regDomain, hostOf } from '../../crawler/profiler/detect.mjs';
import { isVendorHost } from '../../crawler/profiler/platforms.mjs';   // the legacy host list, so the split never depends on v2 data

export const SALT = 'jcx-detect-2a5-v1';
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
if (!opt('companies') || !opt('out')) { console.log('usage: node bench/detect/build-split.mjs --companies <file> [--cache <dir>] --out <split.jsonl>'); process.exit(2); }

const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');
const GENERIC = new Set(['jsonld_direct', 'sitemap', 'paginated_list']);
const NOT_LABEL = new Set(['eures', 'usajobs', 'consider', 'spacecareers', 'spacecapital', 'spaceindividuals', 'jobsinphotonics', 'mycareersfuture', 'flowxtra']);
const normName = (n) => String(n).toLowerCase().replace(/\(via [^)]*\)/g, '').replace(/\b(gmbh|ag|se|ab|as|oy|oyj|inc|ltd|llc|plc|sa|sas|srl|spa|bv|nv|kg|co|corp|group|gruppe|holding|limited|company|aps|a\/s)\b\.?/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

const cfg = JSON.parse(readFileSync(opt('companies'), 'utf8'));
const entries = (cfg.tracked_companies ?? []).filter((c) => c.careers_url && /^https?:\/\//i.test(c.careers_url) && c.provider && !NOT_LABEL.has(c.provider));

// union-find over name and employer-domain keys
const parent = new Map();
const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
const union = (a, b) => { add(a); add(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
const keysOf = (c) => {
  const k = [`n:${normName(c.name) || sha1(c.name).slice(0, 8)}`];
  const h = hostOf(c.careers_url);
  if (h && !isVendorHost(h)) k.push(`d:${regDomain(h)}`);
  return k;
};
for (const c of entries) { const k = keysOf(c); add(k[0]); for (const x of k.slice(1)) union(k[0], x); }

const CACHE = opt('cache');
const rows = [];
const seen = new Set();
for (const c of entries) {
  const id = sha1(c.careers_url).slice(0, 16);
  if (seen.has(id)) continue;   // the same careers URL twice: keep the first entry
  seen.add(id);
  const group = find(keysOf(c)[0]);
  const split = parseInt(sha1(SALT + group).slice(0, 8), 16) % 4 === 0 ? 'holdout' : 'dev';
  const row = { id, name: c.name, url: c.careers_url, provider: c.provider, slug: c.slug ?? null, label: GENERIC.has(c.provider) ? 'custom' : c.provider,
    vendor_url: isVendorHost(hostOf(c.careers_url)), enabled: c.enabled !== false, group, split, page: null };
  if (CACHE) {
    const f = join(CACHE, id + '.json');
    if (existsSync(f)) {
      const p = JSON.parse(readFileSync(f, 'utf8'));
      row.page = { usable: !!(p.html && !p.error && p.status && p.status < 400), status: p.status ?? 0, error: p.error || '', final: p.final ?? null, cname: p.cname || '', html_sha1: p.html ? sha1(p.html) : null };
    }
  }
  rows.push(row);
}
writeFileSync(opt('out'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const n = (f) => rows.filter(f).length;
console.log(`rows=${rows.length} holdout=${n((r) => r.split === 'holdout')} groups=${new Set(rows.map((r) => r.group)).size} pages_usable=${n((r) => r.page?.usable)} holdout_pages_usable=${n((r) => r.page?.usable && r.split === 'holdout')}`);
