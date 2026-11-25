// Advertiser attribution (owner 2026-11-25 07:21: "Roles should show up under the entity they are advertised by"; FEED_DROPS.md, ATTRIBUTION).
//
// The company a role is shown under is the advertiser the posting itself declares, mapped to one of our company entries by a reviewed
// rules file. The board we fetched it from never decides the name when the posting declares one.
//   declared   Workday: the job detail's hiringOrganization (a legal entity, often with an entity code: "922E Airbus Defence and Space
//              GmbH"), read when the crawl fetches the description; JSON-LD pages: hiringOrganization (provider field `organization`).
//              Aggregator rows already carry the employer their record names ("X (via Board)") and are left as they are.
//   mapping    the profile's crawl.advertisers_file: { version, rules: [{ match, company, note }] }. match is a regular expression on the
//              folded declared name (lower case, accents and punctuation removed, a leading entity code dropped); the first rule that
//              matches wins. company is the name of an existing company entry; null = known, deliberately left with the board's company.
//              No rule: the role keeps the board's company (inferred) and the name is listed in <data>/advertisers-unknown.tsv for review.
//              A company is never created from a declared name.
//   ownership  a relabelled row keeps the board that listed it as its owner for closes and the liveness guard (ownerBoard), so a name
//              that happens to equal another board (Leonardo UK Ltd) never lets that board close it.
//   history    a row is relabelled when a board lists it again; when its rule goes away the board's company comes back.
// State: <data>/advertisers.json { v, at, urls: { url: [declared, source, owner board, label before attribution] } }. First run without
// state: seeded from the raw capture (JOBCRAWL_RAW_DIR: the Workday detail answers already stored), so existing roles move at their next
// listing without a single extra request. R3: one notes line per run; every fallback one `[degraded] crawl/advertiser: ... (1)` line.
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';

export const ADVERTISER_VERSION = 1;
export const degradedLine = (reason) => `[degraded] crawl/advertiser: ${reason} (1)`;
const oneLine = (m) => String(m ?? '').split(/\r?\n/)[0].slice(0, 160);
const VIA = /\s*\(via [^)]*\)\s*$/i;
const LEAD_CODE = /^[0-9a-z]{0,2}\d{2,6}[a-z]?\s+/;

/** The declared name as the rules see it: lower case, no accents, punctuation as blanks, a leading entity code ("922e ", "2164 ") dropped. */
export function foldName(s) {
  const f = String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9()&]+/g, ' ').trim();
  return f.replace(LEAD_CODE, '').trim();
}

const LEGAL = new Set('gmbh ggmbh mbh ag se kg kgaa co ohg ug ev eg inc incorporated ltd limited llc llp lp plc corp corporation company sa sas sarl srl spa bv nv ab as asa oy oyj aps sro pte pty sl sau personnel the'.split(' '));
/** Same entity for the review list: equal once folded, legal forms, brackets and crawl decorations ("(workday) [tenant]") are dropped. */
export function sameEntity(a, b) {
  const key = (s) => foldName(String(s ?? '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')).split(' ').filter((w) => w && !LEGAL.has(w)).join(' ');
  const x = key(a), y = key(b);
  return Boolean(x) && x === y;
}

/** -> [{ rx, company }] (throws on a bad file: the caller falls back and counts it). */
export function loadRules(file) {
  const t = JSON.parse(readFileSync(file, 'utf8'));
  if (t?.version !== 1 || !Array.isArray(t.rules)) throw new Error('not a version 1 rules file');
  return t.rules.map((r, i) => {
    if (typeof r?.match !== 'string' || !(r.company === null || (typeof r.company === 'string' && r.company.trim()))) throw new Error(`rule ${i + 1}: match must be a string and company a name or null`);
    return { rx: new RegExp(r.match), company: r.company };
  });
}

/** Rule for a declared name -> { hit, company } (company null: keep the board's company). */
export function ruleFor(rules, declared) {
  const f = foldName(declared);
  if (!f) return { hit: false, company: null };
  for (const r of rules) if (r.rx.test(f)) return { hit: true, company: r.company };
  return { hit: false, company: null };
}

/** Workday detail answers in the raw capture -> Map(public job url -> hiringOrganization name), the newest answer per url. */
export function seedFromRawCapture(rawDir, wanted) {
  const out = new Map();
  const idx = join(rawDir, 'index');
  if (!existsSync(idx)) return out;
  const latest = new Map();
  const re = /^(https:\/\/[^/]+)\/wday\/cxs\/[^/]+\/([^/]+)\/job\/(.+)$/;
  for (const f of readdirSync(idx).filter((x) => x.endsWith('.jsonl')).sort()) {
    for (const l of readFileSync(join(idx, f), 'utf8').split('\n')) {
      if (!l.includes('/wday/cxs/') || !l.includes('/job/')) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      const m = re.exec(r.url ?? '');
      if (!m || r.status !== 200 || !r.sha256) continue;
      const u = `${m[1]}/${m[2]}/job/${m[3]}`;
      if (!wanted || wanted.has(u)) latest.set(u, r.sha256);
    }
  }
  for (const [u, sha] of latest) {
    try {
      const d = JSON.parse(gunzipSync(readFileSync(join(rawDir, 'objects', sha.slice(0, 2), `${sha}.gz`))).toString('utf8'));
      const name = d?.hiringOrganization?.name;
      if (typeof name === 'string' && name.trim()) out.set(u, name.trim());
    } catch { /* an unreadable object: that url has no declared advertiser yet */ }
  }
  return out;
}

/**
 * -> attribution {declare, applyTo, ownerBoard, summaryLine, degradedLines, save, stats}. rulesFile null: off (declared names are still
 * recorded, nothing is relabelled). history: Map url -> row (read for the seed and the unknown report).
 */
export function openAdvertisers(dataDir, { rulesFile = null, rawDir = '', history = new Map(), log = console.log, now = Date.now() } = {}) {
  const file = resolve(dataDir, 'advertisers.json');
  const stats = { declaredNew: 0, relabelled: 0, restored: 0, unknownListed: 0, errors: 0, seeded: 0 };
  const moves = new Map();
  const degraded = [];
  let rules = null;
  if (rulesFile) {
    try { rules = loadRules(rulesFile); }
    catch (e) { degraded.push(degradedLine(`rules ${rulesFile} unreadable (${oneLine(e.message)}), continuing without relabelling`)); }
  }
  const urls = new Map();   // url -> [declared, source, owner board, label before attribution]
  let loaded = false;
  try {
    if (existsSync(file)) {
      const s = JSON.parse(readFileSync(file, 'utf8'));
      if (s?.v !== ADVERTISER_VERSION || typeof s.urls !== 'object' || !s.urls) throw new Error('unknown format');
      for (const [u, v] of Object.entries(s.urls)) if (Array.isArray(v) && typeof v[0] === 'string') urls.set(u, [v[0], v[1] ?? '', v[2] ?? '', v[3] ?? '']);
      loaded = true;
    }
  } catch (e) {
    degraded.push(degradedLine(`advertisers.json unreadable (${oneLine(e.message)}), continuing with a fresh record from the raw capture`));
  }
  if (!loaded && rawDir) {
    try {
      const wanted = new Set([...history.keys()].filter((u) => u.includes('.myworkdayjobs.com/')));
      for (const [u, name] of seedFromRawCapture(rawDir, wanted)) { urls.set(u, [name, 'workday_detail', '', '']); stats.seeded++; }
      log(`[advertiser] no record yet: ${stats.seeded} declared advertisers read from the raw capture (${wanted.size} Workday roles in the history)`);
    } catch (e) { degraded.push(degradedLine(`raw capture seed failed (${oneLine(e.message)}), continuing with names read from new fetches only`)); }
  }
  for (const l of degraded) log(l);
  const unknown = new Map();   // declared name -> { n, boards: Set, url }

  return {
    stats,
    on: Boolean(rules),
    /** The posting at `url` declares `name` (source: workday_detail, jsonld). */
    declare(url, name, source, board) {
      try {
        const n = String(name ?? '').trim();
        if (!n || /^(confidential|anonymous|n\/a|-)$/i.test(n)) return;
        const cur = urls.get(url);
        if (!cur) { urls.set(url, [n, source, board ?? '', '']); stats.declaredNew++; return; }
        if (cur[0] !== n) { cur[0] = n; cur[1] = source; stats.declaredNew++; }
      } catch { stats.errors++; }
    },
    /** A board listed `row`: show it under its declared advertiser (or give the board's name back when no rule maps it any more). */
    applyTo(row, board) {
      try {
        if (!rules || !row?.url || VIA.test(row.company ?? '')) return null;
        const rec = urls.get(row.url);
        if (!rec) return null;
        const { hit, company } = ruleFor(rules, rec[0]);
        if (!hit && !sameEntity(rec[0], row.company) && !sameEntity(rec[0], board)) {
          const k = rec[0]; const x = unknown.get(k) ?? unknown.set(k, { n: 0, boards: new Set(), url: row.url }).get(k);
          x.n++; x.boards.add(board); stats.unknownListed++;
        }
        if (hit && company) {
          rec[2] = board;
          if (row.company !== company) {
            if (!rec[3]) rec[3] = row.company;
            const k = `${row.company} -> ${company}`; moves.set(k, (moves.get(k) ?? 0) + 1);
            row.company = company; stats.relabelled++;
            return 'relabelled';
          }
          return null;
        }
        if (rec[3] && row.company !== rec[3]) {   // relabelled before, no rule maps it now: the board's company comes back
          const k = `${row.company} -> ${rec[3]} (rule gone)`; moves.set(k, (moves.get(k) ?? 0) + 1);
          row.company = rec[3]; rec[3] = ''; rec[2] = ''; stats.restored++;
          return 'restored';
        }
        return null;
      } catch { stats.errors++; return null; }
    },
    /** The board that owns a relabelled row for closes and the liveness guard, or '' (the row's company decides, as before). */
    ownerBoard(url) { const r = urls.get(url); return r && r[3] ? r[2] : ''; },
    /** One notes line per run (R3). */
    summaryLine() {
      if (!rules) return `advertiser attribution: off (${rulesFile ? 'rules unreadable' : 'no crawl.advertisers_file in the profile'}); ${urls.size} declared advertisers recorded`;
      const top = [...moves].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${v}`).join(', ');
      const shown = [...urls.values()].filter((r) => r[3]).length;
      return `advertiser attribution: ${shown} roles shown under their declared advertiser; this run ${stats.relabelled} relabelled, ${stats.restored} given back to their board${top ? ` (${top})` : ''}; ` +
        `${unknown.size} declared names without a rule on ${stats.unknownListed} listed roles (advertisers-unknown.tsv)`;
    },
    /** R3: the fallbacks of this run, one watcher-counted line each (the load-time ones were logged already). */
    degradedLines() { return stats.errors ? [degradedLine(`${stats.errors} attribution call(s) failed, continuing with the board's company for those roles`)] : []; },
    /** Write the record (atomic) and the review list of declared names no rule maps. */
    save() {
      const out = {};
      for (const [u, v] of urls) if (history.has(u)) out[u] = v;
      writeFileSync(`${file}.tmp`, JSON.stringify({ v: ADVERTISER_VERSION, at: new Date(now).toISOString(), urls: out }));
      renameSync(`${file}.tmp`, file);
      const rows = [...unknown].sort((a, b) => b[1].n - a[1].n).map(([k, x]) => [k, x.n, [...x.boards].join(' | '), x.url].join('\t'));
      writeFileSync(resolve(dataDir, 'advertisers-unknown.tsv'), ['declared\troles_listed\tboards\texample_url', ...rows].join('\n') + '\n');
    },
  };
}
