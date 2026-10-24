#!/usr/bin/env node
// Builds the job catalog from the crawl state: every open role in <data>/scan-history.tsv plus a plain-text
// excerpt of its job description (from <data>/jd/). Raw facts only, no ranking or scoring of any kind.
//
//   node crawler/catalog.mjs [--profile <dir>] [--data <dir>]      writes <data>/catalog.json
//   (--data: else the profile's data_dir, else ./data)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProfile, profileDirFromArgs, resolveDataDir } from './profile.mjs';

const args = process.argv.slice(2);
const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const DATA = resolveDataDir(opt('data'), loadProfile(profileDirFromArgs(args)));
const HISTORY = resolve(DATA, 'scan-history.tsv');
const OUT = resolve(DATA, 'catalog.json');
const EXCERPT = 1200;

// Board metadata of the open roles (crawl.mjs writes <data>/job-meta.json). Only what the board states: a missing value is simply absent.
let JOBMETA = {};
try { JOBMETA = JSON.parse(readFileSync(resolve(DATA, 'job-meta.json'), 'utf8')).jobs ?? {}; } catch {}
const first = (v) => (Array.isArray(v) ? v[0] : v) || '';
const workplaceOf = (m) => {
  const w = String(m.workplace ?? '').toLowerCase().replace(/[-\s]/g, '');
  if (['remote', 'onsite', 'hybrid'].includes(w)) return w;
  if (m.hybrid === true) return 'hybrid';
  if (m.remote === true) return 'remote';
  return m.remote === false && m.hybrid === false ? 'onsite' : '';
};
const employmentOf = (m) => {
  const v = String(m.employment ?? '');
  if (/intern|praktik|werkstudent|student|trainee|apprentic|ausbildung/i.test(v)) return 'intern';
  if (/contract|temporary|freelance|befrist|fixed/i.test(v)) return 'contract';
  if (/part.?time|teilzeit/i.test(v)) return 'part_time';
  if (/full.?time|vollzeit|permanent|regular|unbefrist/i.test(v)) return 'full_time';
  return '';
};

if (!existsSync(HISTORY)) { console.error(`[catalog] no crawl history at ${HISTORY}; run crawler/crawl.mjs --profile <dir> first`); process.exit(1); }

// Plain-text excerpt cut at a word boundary.
function summarize(text = '', max = EXCERPT) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, '') + ' …';
}

const jdText = (url) => {
  const f = resolve(DATA, 'jd', createHash('sha1').update(url).digest('hex').slice(0, 10) + '.md');
  if (!existsSync(f)) return '';
  return readFileSync(f, 'utf8').replace(/^# .*\n+(?:- .*\n)+/, '');
};

const via = (company) => {
  const m = company.match(/\(via ([^)]+)\)\s*$/);
  return m ? m[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'ats_direct';
};

const metaFields = (m) => {
  if (!m) return {};
  const dept = String(first(m.departments) || first(m.teams)).trim().slice(0, 60), wp = workplaceOf(m), et = employmentOf(m);
  return { ...(dept ? { dept } : {}), ...(wp ? { wp } : {}), ...(et ? { et } : {}) };
};

const items = [];
for (const line of readFileSync(HISTORY, 'utf8').split(/\r?\n/).slice(1)) {
  if (!line.trim()) continue;
  const [url, company, title, location, first_seen, last_seen, status, posted] = line.split('\t');
  if (status !== 'open' || !url || !title) continue;
  items.push({
    title: title.trim(),
    url: url.trim(),
    company: company.trim(),
    location: location.trim() || 'Unspecified',
    source: via(company),
    posted: posted || '',   // original publish date when the source gives one
    first_seen,             // when the crawler first saw the role
    last_seen,
    description: summarize(jdText(url)),
    ...metaFields(JOBMETA[url.trim()]),
  });
}

// One entry per URL; the first occurrence wins.
const seen = new Set();
const unique = items.filter((i) => (seen.has(i.url) ? false : seen.add(i.url)));
const next = JSON.stringify(unique) + '\n';
const changed = !existsSync(OUT) || readFileSync(OUT, 'utf8') !== next;
if (changed) writeFileSync(OUT, next, 'utf8');   // unchanged: keep the mtime so the board and the private rebuild can skip
console.log(`[catalog] ${unique.length} open jobs (${unique.filter((i) => i.description).length} with a description) ${changed ? '->' : 'unchanged,'} ${OUT}`);
