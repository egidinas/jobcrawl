#!/usr/bin/env node
// Detector benchmark split v2 (JOBCRAWLX 2A.5 round 2). Run ONCE before any page is fetched; the output is committed and frozen.
//
//   node bench/detect/build-split-v2.mjs --companies <companies.json> --split-v1 bench/detect/split-v1.jsonl --out bench/detect/split-v2.jsonl
//        [--sites sites_v2.jsonl] [--target 190]
//
// Fresh companies only: a group (union of normalised name and employer domain, as in v1) is left out when any of its rows was in the
// v1 hold-out (spent) or had a cached page in v1 (v2 was tuned on those). The rest are ordered by sha1(SALT + group), and the first
// --target rows are taken, at most PER_ATS per ATS provider and PER_CUSTOM generic rows, so that the many generic boards do not
// crowd out the ATS classes. Every row is hold-out: nothing is tuned on this set, and the evaluation runs once.
// Input = the employer's own careers page, never the ATS URL: the careers_url when it is on the employer's host, else (--sites, the
// profiler's company list: name -> website, careers_url) that company's careers page or homepage, matched by normalised name.
// Label = today's provider; the generic readers are 'custom'.
// stand_in: a 'custom' row whose config itself names an ATS (a vendor host in its slug, list config, link_hosts or note), so that
// "the generic reader stands in for an ATS" rows can be reported separately. Computed from the config only, never from pages.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { regDomain, hostOf } from '../../crawler/profiler/detect.mjs';
import { isVendorHost as legacyVendor, PLATFORMS } from '../../crawler/profiler/platforms.mjs';
import { FINGERPRINTS } from '../../core/detect/index.mjs';

export const SALT = 'jcx-detect-2a5-r2';
const PER_ATS = 12, PER_CUSTOM = 100;
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
if (!opt('companies') || !opt('split-v1') || !opt('out')) { console.log('usage: node bench/detect/build-split-v2.mjs --companies <file> --split-v1 <jsonl> --out <jsonl> [--target 190]'); process.exit(2); }
const TARGET = Number(opt('target', 190));

const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');
const GENERIC = new Set(['jsonld_direct', 'sitemap', 'paginated_list']);
const NOT_LABEL = new Set(['eures', 'usajobs', 'consider', 'spacecareers', 'spacecapital', 'spaceindividuals', 'jobsinphotonics', 'mycareersfuture', 'flowxtra']);
const normName = (n) => String(n).toLowerCase().replace(/\(via [^)]*\)/g, '').replace(/\b(gmbh|ag|se|ab|as|oy|oyj|inc|ltd|llc|plc|sa|sas|srl|spa|bv|nv|kg|co|corp|group|gruppe|holding|limited|company|aps|a\/s)\b\.?/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

// vendor hosts for the stand-in tag: the legacy list and the v2 rows (config text only)
const hostRx = [...PLATFORMS.flatMap((p) => p.hostRx.map((r) => [p.provider ?? p.id, r])), ...FINGERPRINTS.filter((p) => p.kind === 'ats').flatMap((p) => p.hostRx.map((r) => [p.provider ?? p.platform, r]))];
const vendorOf = (h) => hostRx.find(([, r]) => r.test(h))?.[0] ?? null;
const ATS_NAMES = FINGERPRINTS.filter((p) => p.kind === 'ats' && p.provider).map((p) => p.provider);
function standIn(entry) {
  const text = JSON.stringify({ ...entry, careers_url: undefined, name: undefined });
  for (const m of text.matchAll(/https?:\\?\/\\?\/([\w.-]+)/g)) { const v = vendorOf(m[1].toLowerCase()); if (v) return v; }
  for (const h of entry.link_hosts ?? []) { const v = vendorOf(String(h).toLowerCase()); if (v) return v; }
  const note = String(entry.note ?? '').toLowerCase();
  return ATS_NAMES.find((n) => n.length > 4 && new RegExp(`\\b${n}\\b`).test(note)) ?? null;
}

const v1 = readFileSync(opt('split-v1'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const keysOf = (c) => { const k = [`n:${normName(c.name) || sha1(c.name).slice(0, 8)}`]; const h = hostOf(c.careers_url); if (h && !legacyVendor(h)) k.push(`d:${regDomain(h)}`); return k; };
const burned = new Set();
for (const r of v1) if (r.split === 'holdout' || r.page) for (const k of keysOf({ name: r.name, careers_url: r.url })) burned.add(k);

const cfg = JSON.parse(readFileSync(opt('companies'), 'utf8'));
const sites = new Map(), byLabel = new Map();
if (opt('sites')) for (const l of readFileSync(opt('sites'), 'utf8').split('\n')) {
  if (!l.trim()) continue;
  try { const x = JSON.parse(l); const k = normName(x.name); const u = x.careers_url || x.website; if (k && /^https?:\/\//i.test(u ?? '') && !sites.has(k)) sites.set(k, u);
    // second key: the website's domain label (pasqal.com -> pasqal), matched against the ATS slug of an entry (acme.teamtailor.com)
    const lab = normName(regDomain(hostOf(x.website || u)).split('.')[0]); if (lab && lab.length >= 4 && !byLabel.has(lab)) byLabel.set(lab, u); } catch { /* skip */ }
}
const seen = new Set();
const cands = [];
for (const c of cfg.tracked_companies ?? []) {
  if (c.enabled === false || !c.provider || NOT_LABEL.has(c.provider) || !/^https?:\/\//i.test(c.careers_url ?? '')) continue;
  const h = hostOf(c.careers_url);
  if (!h) continue;
  let input = c.careers_url, inputFrom = 'config';
  if (legacyVendor(h) || isVendorV2(h)) {
    input = sites.get(normName(c.name)) ?? (c.slug && !/^https?:/i.test(c.slug) ? byLabel.get(normName(String(c.slug).split(/[|:/]/)[0])) : undefined);
    inputFrom = 'sites';
    const ih = hostOf(input ?? '');
    if (!ih || legacyVendor(ih) || isVendorV2(ih)) continue;
  }
  const keys = keysOf(c);
  if (inputFrom === 'sites') keys.push(`d:${regDomain(hostOf(input))}`);
  if (keys.some((k) => burned.has(k))) continue;
  const id = sha1(input).slice(0, 16);
  if (seen.has(id)) continue;
  seen.add(id);
  const label = GENERIC.has(c.provider) ? 'custom' : c.provider;
  cands.push({ id, name: c.name, url: input, input_from: inputFrom, careers_url: c.careers_url, provider: c.provider, slug: c.slug ?? null, label, stand_in: label === 'custom' ? standIn(c) : null, group: keys.sort()[0], order: sha1(SALT + keys.sort()[0]) });
}
function isVendorV2(h) { return FINGERPRINTS.some((p) => p.kind === 'ats' && p.hostRx.some((r) => r.test(h))); }
cands.sort((a, b) => a.order.localeCompare(b.order));
const per = new Map(), groups = new Set(), rows = [];
for (const c of cands) {
  if (rows.length >= TARGET) break;
  if (groups.has(c.group)) continue;
  const cap = c.label === 'custom' ? PER_CUSTOM : PER_ATS;
  if ((per.get(c.label) ?? 0) >= cap) continue;
  per.set(c.label, (per.get(c.label) ?? 0) + 1);
  groups.add(c.group);
  const { order, ...row } = c;
  rows.push({ ...row, split: 'holdout' });
}
writeFileSync(opt('out'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`candidates=${cands.length} rows=${rows.length} labels=${JSON.stringify(Object.fromEntries([...per].sort((a, b) => b[1] - a[1])))} stand_in=${rows.filter((r) => r.stand_in).length}`);
