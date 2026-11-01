#!/usr/bin/env node
// Direct-board candidates from aggregator hits. A direct poll of an employer's own board is always preferable to an aggregator
// copy (owner's rule, 2026-11-01): the copy lags, loses fields and vanishes with the aggregator. This tool lists every employer
// that reached the history through an aggregator (EURES, Space Capital, Space-Careers, Space Individuals, Jobs-in-Photonics,
// MyCareersFuture, LinkedIn: crosslist.mjs AGGREGATOR_PROVIDERS; their providers suffix the employer name "(via <Board>)") with
// its channels, status counts, first/last seen, sample titles and what the board meta knows (EURES: employer_site, NUTS codes,
// ESCO categories, contract), and says whether a tracked board exists (`tracked`), the company is in the catalogue without a
// board (`catalogue`) or neither (`new`). The `new` and `catalogue` employers with enough open postings go into a seed list for
// `node crawler/ats-resolve.mjs --seed <file>` (a JSON array of { name, website }; the site from the EURES meta or the catalogue
// when either names one). Nothing is added to the companies file: a human reviews the CSV and the ats-resolve result.
//
//   node crawler/aggregator-employers.mjs --profile <dir> [--data <dir>] [--min-open 1] [--out <dir>]
//
// Reads <data>/scan-history.tsv and <data>/job-meta.json ({ updated, jobs: { url: meta } }, open roles only), the profile's
// companies file (tracked names; aggregator entries are not employers) and catalogue file (name, aliases, domain/website), all
// read-only. Writes <out>/aggregator-employers.csv and <out>/aggregator-employers.seed.json; --out defaults to the profile's
// review_dir, else the data folder. No network. The grouping and the status decision are pure functions (tests in
// crawler/tests/aggregator-employers.test.mjs).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AGGREGATOR_PROVIDERS, canonCompany, sameEmployer } from './crosslist.mjs';
import { loadProfile, profileDirFromArgs, resolveDataDir } from './profile.mjs';

export const HISTORY_HEADER = ['url', 'company', 'title', 'location', 'first_seen', 'last_seen', 'status', 'posted'];
export const CSV_COLUMNS = ['name', 'status', 'channels', 'open', 'extra', 'gone', 'filtered', 'rows', 'first_seen', 'last_seen', 'sample_titles',
  'employer_site', 'nuts', 'esco', 'contract', 'tracked_board', 'catalogue_name'];
export const STATUSES = ['tracked', 'catalogue', 'new'];
const SAMPLE_TITLES = 3;
const VIA_RE = /\s*\(via ([^)]*)\)\s*$/i;

// ---------- parsing ----------

/** "Acme GmbH (via EURES)" -> { name: 'Acme GmbH', channel: 'EURES' }; null when the company carries no "(via X)" suffix. */
export function splitVia(company) {
  const s = String(company ?? '');
  const m = VIA_RE.exec(s);
  if (!m) return null;
  return { name: s.slice(0, m.index).trim(), channel: m[1].trim() };
}

/** Rows of a scan-history.tsv text. The first line is the header when it starts with "url"; crawl.mjs writes no quoting. */
export function parseHistory(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const hasHeader = /^url\t/.test(lines[0] ?? '');
  const cols = hasHeader ? lines[0].split('\t') : HISTORY_HEADER;
  const rows = [];
  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    if (!line.trim()) continue;
    const v = line.split('\t');
    rows.push(Object.fromEntries(cols.map((h, i) => [h, v[i] ?? ''])));
  }
  return rows;
}

/** Host of a URL or bare domain, lowercased, without "www."; '' for anything that is not one (needs a dot). */
export function domainOf(u) {
  const s = String(u ?? '').trim();
  if (!s || /\s/.test(s)) return '';
  try {
    const h = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, '').toLowerCase();
    return h.includes('.') ? h : '';
  } catch { return ''; }
}

const asList = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
const dateMin = (a, b) => (!a ? b : !b ? a : a < b ? a : b);
const dateMax = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
// Sample titles: open roles first, then extra, then the rest, in the order the rows came.
const TITLE_RANK = { open: 0, extra: 1 };
const COUNTED = new Set(['open', 'extra', 'gone', 'filtered', 'dup']);

// ---------- grouping ----------

/**
 * Employers behind the aggregator rows of a history, one record per canonical name (crosslist.mjs canonCompany with the "(via X)"
 * suffix stripped, so "Acme GmbH (via EURES)" and "ACME (via Space Capital)" are one employer with two channels). `meta` is
 * job-meta.json's `jobs` map (url -> board meta); the EURES provider puts employer_site, nuts, categories (ESCO labels) and
 * contract there. Rows without the suffix are not aggregator rows here (a row named after the board itself has no employer), and
 * "undisclosed" (EURES vacancies that name no employer) is skipped. Unsorted; classifyEmployers sorts.
 */
export function groupAggregatorRows(rows, meta = {}) {
  const byKey = new Map();
  for (const row of rows) {
    const via = splitVia(row.company);
    if (!via || !via.channel) continue;
    const key = canonCompany(via.name);
    if (!key || key === 'undisclosed') continue;
    let e = byKey.get(key);
    if (!e) {
      e = { key, spellings: new Map(), channels: new Map(), rows: 0, open: 0, extra: 0, gone: 0, filtered: 0, dup: 0, first_seen: '', last_seen: '',
        titles: [], employer_site: '', nuts: new Set(), esco: new Set(), contract: new Set(), with_meta: 0 };
      byKey.set(key, e);
    }
    e.spellings.set(via.name, (e.spellings.get(via.name) ?? 0) + 1);
    const ch = e.channels.get(via.channel) ?? { rows: 0, open: 0 };
    ch.rows++;
    e.rows++;
    const st = String(row.status ?? '');
    if (st === 'open') ch.open++;
    if (COUNTED.has(st)) e[st]++;
    e.channels.set(via.channel, ch);
    e.first_seen = dateMin(e.first_seen, String(row.first_seen ?? ''));
    e.last_seen = dateMax(e.last_seen, String(row.last_seen ?? ''));
    if (row.title) e.titles.push({ title: String(row.title).trim(), rank: TITLE_RANK[st] ?? 2 });
    const m = meta && typeof meta === 'object' ? meta[row.url] : undefined;
    if (m && typeof m === 'object') {
      e.with_meta++;
      if (!e.employer_site && m.employer_site && domainOf(m.employer_site)) e.employer_site = String(m.employer_site).trim();
      for (const x of asList(m.nuts)) e.nuts.add(x.toUpperCase());
      for (const x of asList(m.categories)) e.esco.add(x);
      for (const x of asList(m.contract)) e.contract.add(x);
    }
  }
  const out = [];
  for (const e of byKey.values()) {
    let name = '', best = -1;
    for (const [s, n] of e.spellings) if (n > best) { name = s; best = n; }
    const seen = new Set(), sample_titles = [];
    for (const t of [...e.titles].sort((a, b) => a.rank - b.rank)) {
      const k = t.title.toLowerCase();
      if (!t.title || seen.has(k)) continue;
      seen.add(k);
      sample_titles.push(t.title);
      if (sample_titles.length >= SAMPLE_TITLES) break;
    }
    out.push({
      key: e.key, name, channels: [...e.channels.keys()].sort(), per_channel: Object.fromEntries(e.channels),
      rows: e.rows, open: e.open, extra: e.extra, gone: e.gone, filtered: e.filtered, dup: e.dup,
      first_seen: e.first_seen, last_seen: e.last_seen, sample_titles,
      employer_site: e.employer_site, site: domainOf(e.employer_site), nuts: [...e.nuts].sort(), esco: [...e.esco].sort(), contract: [...e.contract].sort(),
      with_meta: e.with_meta,
    });
  }
  return out;
}

// ---------- known names ----------

// Canonical-name index: an exact canonical match, else the strict sameEmployer rule (crosslist.mjs: a whole-word prefix of at least five
// characters followed only by generic words, "isar aerospace" ~ "isar aerospace technologies"). Candidates share the first word.
function nameIndex() {
  const exact = new Map(), byFirst = new Map();
  return {
    add(name, entry) {
      const k = canonCompany(splitVia(name)?.name ?? name);
      if (!k) return;
      if (!exact.has(k)) exact.set(k, []);
      exact.get(k).push(entry);
      const f = k.split(' ')[0];
      if (!byFirst.has(f)) byFirst.set(f, new Set());
      byFirst.get(f).add(k);
    },
    /** Every entry whose name is the same employer as `name`, exact matches first. */
    find(name) {
      const k = canonCompany(splitVia(name)?.name ?? name);
      if (!k) return [];
      const out = [...(exact.get(k) ?? [])];
      for (const o of byFirst.get(k.split(' ')[0]) ?? []) if (o !== k && sameEmployer(k, o)) out.push(...exact.get(o));
      return out;
    },
  };
}

/**
 * The names a profile knows. tracked: companies-file entries ({ name, provider, enabled }); entries of aggregator providers are boards,
 * not employers, and are skipped. catalogue: catalogue entries ({ name, aliases, domain, website, kind, is_aggregator }); board
 * entries are skipped. lookup(name, site) matches the catalogue by name, alias or web-site domain, and the companies file by the
 * employer's name or, failing that, by the matched catalogue entry's name and aliases (so a domain match can reach a tracked board).
 */
export function makeKnownIndex({ tracked = [], catalogue = [] } = {}) {
  const trackedIdx = nameIndex(), catIdx = nameIndex(), byDomain = new Map();
  for (const c of tracked) if (c && c.name && !AGGREGATOR_PROVIDERS.has(c.provider)) trackedIdx.add(c.name, c);
  for (const c of catalogue) {
    if (!c || !c.name || c.kind === 'board' || c.is_aggregator) continue;
    catIdx.add(c.name, c);
    for (const a of asList(c.aliases)) catIdx.add(a, c);
    for (const d of [c.domain, c.website]) { const h = domainOf(d); if (h && !byDomain.has(h)) byDomain.set(h, c); }
  }
  const pick = (entries) => entries.find((c) => c.enabled !== false) ?? entries[0] ?? null;
  return {
    lookup(name, site = '') {
      const cat = catIdx.find(name)[0] ?? (domainOf(site) ? byDomain.get(domainOf(site)) : undefined) ?? null;
      let tr = pick(trackedIdx.find(name));
      if (!tr && cat) tr = pick([cat.name, ...asList(cat.aliases)].flatMap((n) => trackedIdx.find(n)));
      return { tracked: tr, catalogue: cat };
    },
  };
}

/**
 * Status of one grouped employer: `tracked` when an enabled companies-file entry matches, `catalogue` when a catalogue entry matches
 * (and no enabled board), else `new`. A disabled board is named in tracked_board with " (disabled)" but does not count as tracked:
 * the aggregator is then the only live source, which is what the reviewer should see.
 */
export function decideStatus(employer, index) {
  const { tracked, catalogue } = index.lookup(employer.name, employer.site || employer.employer_site);
  const status = tracked && tracked.enabled !== false ? 'tracked' : catalogue ? 'catalogue' : 'new';
  const catalogue_site = catalogue ? [catalogue.website, catalogue.domain].map((x) => String(x ?? '').trim()).find((x) => domainOf(x)) ?? '' : '';
  return { status, tracked_board: tracked ? `${tracked.name}${tracked.enabled === false ? ' (disabled)' : ''}` : '', catalogue_name: catalogue?.name ?? '', catalogue_site };
}

/** The grouped employers with their status, sorted by open count desc, then rows desc, then name. */
export function classifyEmployers(employers, index) {
  return employers.map((e) => ({ ...e, ...decideStatus(e, index) }))
    .sort((a, b) => b.open - a.open || b.rows - a.rows || a.name.localeCompare(b.name));
}

// ---------- output ----------

const csvCell = (v) => {
  const s = Array.isArray(v) ? v.join(' | ') : String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** RFC 4180 CSV of the classified employers, CSV_COLUMNS in order; list fields joined with " | ". */
export function toCsv(employers) {
  return [CSV_COLUMNS.join(','), ...employers.map((e) => CSV_COLUMNS.map((c) => csvCell(e[c])).join(','))].join('\n') + '\n';
}

/**
 * The ats-resolve seed list (--seed <file.json>: a JSON array of { name, website }): the `new` and `catalogue` employers with at least
 * minOpen open postings; `website` when the meta named the employer's site, else the catalogue's website/domain, else absent.
 * `note` is for the reviewer; ats-resolve ignores it.
 */
export function toSeedList(employers, minOpen = 1) {
  return employers.filter((e) => e.status !== 'tracked' && e.open >= minOpen).map((e) => ({
    name: e.name,
    ...(e.employer_site || e.catalogue_site ? { website: e.employer_site || e.catalogue_site } : {}),
    note: `${e.status}; ${e.open} open, ${e.rows} rows via ${e.channels.join(', ')}${e.catalogue_name ? `; catalogue: ${e.catalogue_name}` : ''}${e.tracked_board ? `; board: ${e.tracked_board}` : ''}`,
  }));
}

/** Totals per status and per channel (employers, rows, open rows), and the one-line summary for stdout. */
export function summarize(employers) {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const byChannel = {};
  let open = 0, rows = 0;
  for (const e of employers) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    open += e.open; rows += e.rows;
    for (const [c, n] of Object.entries(e.per_channel ?? {})) {
      byChannel[c] ??= { employers: 0, rows: 0, open: 0 };
      byChannel[c].employers++; byChannel[c].rows += n.rows; byChannel[c].open += n.open;
    }
  }
  return { employers: employers.length, rows, open, byStatus, byChannel };
}
export function summaryLine(s) {
  const st = STATUSES.map((k) => `${k} ${s.byStatus[k] ?? 0}`).join(', ');
  const ch = Object.entries(s.byChannel).sort((a, b) => b[1].open - a[1].open || b[1].rows - a[1].rows)
    .map(([c, n]) => `${c} ${n.employers} employers/${n.open} open/${n.rows} rows`).join('; ');
  return `aggregator-employers: ${s.employers} employers (${st}) from ${s.rows} aggregator rows, ${s.open} open | channels: ${ch || 'none'}`;
}

// ---------- command line ----------

const USAGE = `usage: node crawler/aggregator-employers.mjs --profile <dir> [--data <dir>] [--min-open 1] [--out <dir>]

Lists the employers that reached <data>/scan-history.tsv through an aggregator ("(via <Board>)" rows), with channels, counts,
sample titles and the EURES meta (employer_site, NUTS, ESCO), and whether a tracked board exists (tracked), the company is in
the catalogue without a board (catalogue), or neither (new). Writes <out>/aggregator-employers.csv (every employer, open count
desc) and <out>/aggregator-employers.seed.json (new + catalogue employers with >= --min-open open postings, in the
ats-resolve --seed format). Reads only; nothing is added to the companies file.

options:
  --profile <dir>     profile folder (or set JOBCRAWL_PROFILE); required
  --data <dir>        data folder (default: the profile's data_dir, else ./data)
  --min-open <n>      open postings an employer needs to enter the seed list (default 1)
  --out <dir>         where the CSV and the seed list go (default: the profile's review_dir, else the data folder)
  --help              show this text`;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function main(args) {
  const flag = (n) => args.includes(`--${n}`);
  const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
  const log = (s) => console.log(`aggregator-employers: ${s}`);
  const fail = (code, msg) => { console.error(`aggregator-employers: ${msg}`); return code; };
  if (flag('help')) { console.log(USAGE); return 0; }
  let PROFILE;
  try { PROFILE = loadProfile(profileDirFromArgs(args)); } catch (e) { return fail(2, e.message); }
  if (!PROFILE) return fail(2, 'no profile. Pass --profile <dir> (or set JOBCRAWL_PROFILE). See --help.');
  const minOpen = opt('min-open') === undefined ? 1 : Number(opt('min-open'));
  if (!Number.isInteger(minOpen) || minOpen < 0) return fail(2, `--min-open needs a whole number >= 0 (got "${opt('min-open')}")`);
  const DATA = resolveDataDir(opt('data'), PROFILE);
  const OUT = pathResolve(opt('out') ?? PROFILE.reviewDir ?? DATA);
  const historyFile = pathResolve(DATA, 'scan-history.tsv');
  const metaFile = pathResolve(DATA, 'job-meta.json');
  const t0 = Date.now();
  log(`start | history ${historyFile} | meta ${existsSync(metaFile) ? metaFile : 'none'} | companies ${PROFILE.companiesFile} | catalogue ${PROFILE.catalogueFile && existsSync(PROFILE.catalogueFile) ? PROFILE.catalogueFile : 'none'} | out ${OUT} | min-open ${minOpen}`);
  if (!existsSync(historyFile)) return fail(1, `no history at ${historyFile}: run crawler/crawl.mjs --profile <dir> first`);
  if (!existsSync(PROFILE.companiesFile)) return fail(2, `companies file not found: ${PROFILE.companiesFile} (profile key crawl.companies_file)`);

  const rows = parseHistory(readFileSync(historyFile, 'utf8'));
  let meta = {};
  if (existsSync(metaFile)) {
    try { meta = readJson(metaFile).jobs ?? {}; } catch (e) { log(`warning: ${metaFile} unreadable (${e.message}); continuing without meta`); }
  } else log('warning: no job-meta.json; employer_site/NUTS/ESCO columns stay empty');
  const tracked = readJson(PROFILE.companiesFile).tracked_companies ?? [];
  let catalogue = [];
  if (PROFILE.catalogueFile && existsSync(PROFILE.catalogueFile)) {
    try { const c = readJson(PROFILE.catalogueFile); catalogue = Array.isArray(c) ? c : c.companies ?? []; } catch (e) { log(`warning: catalogue ${PROFILE.catalogueFile} unreadable (${e.message}); every unknown employer is "new"`); }
  } else log('no catalogue file (profile key crawl.catalogue_file): the status is tracked or new');
  const aggRows = rows.filter((r) => splitVia(r.company));
  const boardRows = tracked.filter((c) => AGGREGATOR_PROVIDERS.has(c.provider)).length;
  log(`loaded ${rows.length} history rows, ${aggRows.length} aggregator rows (${aggRows.filter((r) => r.status === 'open').length} open), ${Object.keys(meta).length} meta entries, ${tracked.length} companies entries (${boardRows} aggregator boards), ${catalogue.length} catalogue entries`);

  const grouped = groupAggregatorRows(aggRows, meta);
  log(`grouped ${grouped.length} employers (${grouped.filter((e) => e.with_meta).length} with meta, ${grouped.filter((e) => e.employer_site).length} with employer_site)`);
  const employers = classifyEmployers(grouped, makeKnownIndex({ tracked, catalogue }));
  const seeds = toSeedList(employers, minOpen);

  mkdirSync(OUT, { recursive: true });
  const csvFile = pathResolve(OUT, 'aggregator-employers.csv'), seedFile = pathResolve(OUT, 'aggregator-employers.seed.json');
  writeAtomic(csvFile, toCsv(employers));
  writeAtomic(seedFile, JSON.stringify(seeds, null, 1) + '\n');
  log(`wrote ${csvFile} (${employers.length} rows) and ${seedFile} (${seeds.length} seeds: new + catalogue with >= ${minOpen} open) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(summaryLine(summarize(employers)));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
