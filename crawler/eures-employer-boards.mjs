// Writes the per-employer EURES enrichment boards: for every employer a profile polls directly (companies.json) and that sits in a country
// the EURES portal covers (the EEA and Switzerland), one `eures` board in employer mode (providers-eures.mjs, slug "employer:<name>|<codes>")
// that collects the EURES copies of that employer's postings once a week. The crawl recognises those copies as cross-listings of the direct
// postings ('eures' is in crosslist.mjs AGGREGATOR_PROVIDERS) and the declared layer merges EURES's richer metadata (NUTS region, NACE
// sector, ESCO occupation, contract and schedule codes, number of posts, required languages, contacts) per channel later.
//
//   node crawler/eures-employer-boards.mjs --profile <dir> [--codes de,fr,...] [--out <file>]
//
// Reads the profile's companies file (PROFILE.companiesFile) and catalogue (PROFILE.catalogueFile; entries with name, aliases, country_code,
// country, location, address, ...). Selects the enabled, non-aggregator boards, one per employer (several boards of one employer collapse),
// and keeps an employer when its country code is a covered one, or its location text names a covered country, or nothing says where it is
// (an empty EURES result costs one request a week; a known non-covered country, a US state among them, drops it). The EURES keyword is the
// employer's short name: the catalogue's name when the board is listed there (its aliases hold the long forms), else the board's name, legal
// forms (GmbH, SE, AG, Ltd, S.A., Inc, ...) stripped, because the backend matches employer names as text. The location codes are --codes for
// every board, else the employer's own country, else none (every country). Employers that already have an EURES employer board are skipped.
// Prints a summary; emits a JSON array of board entries to --out or stdout. companies.json itself is NOT modified: the orchestrator inserts
// the entries. Pure selection logic is exported for the tests (crawler/tests/eures-employer-boards.test.mjs).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, profileDirFromArgs } from './profile.mjs';
import { AGGREGATOR_PROVIDERS, canonCompany } from './crosslist.mjs';
import { EURES_COUNTRIES, euresBoardUrl, detectEures, parseSlug } from './providers-eures.mjs';

export const INTERVAL_HOURS = 168;   // weekly (crawl.mjs caps the effective interval at 48 h; see docs/sources/eures-api.md)

/** Lowercase ISO codes of the countries the portal covers (providers-eures.mjs EURES_COUNTRIES; Greece is EL there, GR in the catalogue). */
export const COVERED_CODES = new Set([...Object.keys(EURES_COUNTRIES).map((c) => c.toLowerCase()), 'gr']);
/** The location code the backend wants for a covered country (the catalogue's ISO code, with GR -> el). */
export const euresCodeOf = (iso) => { const c = String(iso ?? '').toLowerCase(); return c === 'gr' ? 'el' : c; };

// Country names (English and the main native forms) that place an employer in a covered country, by ISO code.
const COVERED_NAMES = {
  at: ['Austria', 'Österreich'], be: ['Belgium', 'Belgique', 'België'], bg: ['Bulgaria'], hr: ['Croatia', 'Hrvatska'], cy: ['Cyprus'],
  cz: ['Czechia', 'Czech Republic', 'Česko'], dk: ['Denmark', 'Danmark'], ee: ['Estonia', 'Eesti'], fi: ['Finland', 'Suomi'], fr: ['France'],
  de: ['Germany', 'Deutschland'], gr: ['Greece', 'Hellas'], hu: ['Hungary', 'Magyarország'], is: ['Iceland', 'Ísland'], ie: ['Ireland', 'Éire'],
  it: ['Italy', 'Italia'], lv: ['Latvia', 'Latvija'], li: ['Liechtenstein'], lt: ['Lithuania', 'Lietuva'], lu: ['Luxembourg', 'Luxemburg'],
  mt: ['Malta'], nl: ['Netherlands', 'The Netherlands', 'Nederland', 'Holland'], no: ['Norway', 'Norge'], pl: ['Poland', 'Polska'], pt: ['Portugal'],
  ro: ['Romania', 'România'], sk: ['Slovakia', 'Slovensko'], si: ['Slovenia', 'Slovenija'], es: ['Spain', 'España'], se: ['Sweden', 'Sverige'],
  ch: ['Switzerland', 'Schweiz', 'Suisse', 'Svizzera'],
};
// Names that place an employer outside the covered countries: countries the profiles track employers in, and the US states (the catalogue's
// `country` field often holds a state name), so a Californian employer does not get a weekly empty request.
const OTHER_NAMES = ['United States', 'United States of America', 'USA', 'U.S.', 'U.S.A.', 'United Kingdom', 'UK', 'U.K.', 'Great Britain', 'England',
  'Scotland', 'Wales', 'Northern Ireland', 'Canada', 'Australia', 'New Zealand', 'Japan', 'China', 'India', 'Singapore', 'Israel', 'United Arab Emirates',
  'UAE', 'South Korea', 'Korea', 'Taiwan', 'Brazil', 'Mexico', 'Turkey', 'Türkiye', 'Russia', 'Ukraine', 'Serbia', 'South Africa', 'Argentina',
  'Chile', 'Saudi Arabia', 'Qatar', 'Hong Kong', 'Indonesia', 'Malaysia', 'Thailand', 'Vietnam', 'Philippines', 'Egypt', 'Nigeria', 'Kenya',
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho',
  'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi',
  'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio',
  'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia',
  'Washington', 'West Virginia', 'Wisconsin', 'Wyoming', 'District of Columbia', 'Washington, D.C.', 'Puerto Rico'];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (names) => new RegExp(`(?:^|[^\\p{L}])(?:${names.map(escapeRe).join('|')})(?![\\p{L}])`, 'iu');
const COVERED_RE = Object.entries(COVERED_NAMES).map(([code, names]) => [code, wordRe(names)]);
const OTHER_RE = wordRe(OTHER_NAMES);

/**
 * Where an employer is, from the catalogue's fields and the board's: { verdict: 'covered' | 'other' | 'unknown', code } (code: the lowercase ISO
 * code when known). A two-letter country_code (or `country`) decides when present; else the texts (location, address, country, state, city,
 * headquarters) are searched for a country name, a covered one winning over another (an employer with a European and a US site is covered).
 */
export function countryVerdict(fields = {}) {
  const codeOf = (v) => (typeof v === 'string' && /^[a-z]{2}$/i.test(v.trim()) ? v.trim().toLowerCase() : '');
  const iso = codeOf(fields.country_code) || codeOf(fields.country);
  if (iso) return COVERED_CODES.has(iso) ? { verdict: 'covered', code: iso } : { verdict: 'other', code: iso };
  const text = ['location', 'address', 'country', 'state', 'city', 'headquarters'].map((k) => fields[k]).filter((v) => typeof v === 'string' && v.trim()).join(' | ')
    .replace(/Northern Ireland/gi, 'UK');   // not the covered Ireland
  if (!text) return { verdict: 'unknown', code: '' };
  for (const [code, re] of COVERED_RE) if (re.test(text)) return { verdict: 'covered', code };
  if (OTHER_RE.test(text)) return { verdict: 'other', code: '' };
  return { verdict: 'unknown', code: '' };
}

// Legal forms stripped from the end of a name, as whole tokens with dots and commas removed (so "S.A.", "SA" and "S.A" are one): German,
// British/American, French, Italian, Spanish, Benelux, Nordic, Polish, Czech, Hungarian and Portuguese forms, and the "& Co." chains.
const LEGAL_FORMS = new Set(['gmbh', 'ggmbh', 'mbh', 'ag', 'se', 'kg', 'kgaa', 'ohg', 'ug', 'ev', 'co', 'cie', 'ltd', 'limited', 'llc', 'llp', 'lp', 'inc',
  'incorporated', 'corp', 'corporation', 'plc', 'pte', 'pty', 'sa', 'sas', 'sarl', 'sàrl', 'sà', 'rl', 'snc', 'scs', 'sca', 'srl', 'spa', 'ss', 'bv', 'nv',
  'cv', 'vof', 'ab', 'oy', 'oyj', 'as', 'a/s', 'asa', 'aps', 'sl', 'slu', 'sau', 'lda', 'sp', 'z', 'oo', 'sro', 'zrt', 'kft', 'nyrt', 'doo', 'eeig',
  'haftungsbeschränkt', '(haftungsbeschränkt)']);
const TRAILING_CONNECTOR = /^(?:&|and|und|et|e|y|\+)$/i;

/**
 * The short name EURES is searched for: of a name listing alternatives with " | " the first ("Applus+ IMA | IMA Materialforschung ..." ->
 * "Applus+ IMA"; a pipe would also break the slug format), then trailing legal forms removed one token at a time ("Rohde & Schwarz GmbH & Co. KG"
 * -> "Rohde & Schwarz", "OHB System AG" -> "OHB System", "Thales Alenia Space" unchanged), then trailing punctuation (a brand's "+" stays).
 * A name that is nothing but legal forms stays as it is.
 */
export function shortName(name) {
  const whole = String(name ?? '').trim();
  const first = whole.split('|').map((s) => s.trim()).find(Boolean) ?? '';
  const tokens = first.split(/\s+/).filter(Boolean);
  let n = tokens.length;
  while (n > 1) {
    const t = tokens[n - 1].toLowerCase().replace(/[.,;]/g, '');
    if (LEGAL_FORMS.has(t) || TRAILING_CONNECTOR.test(tokens[n - 1])) n--;
    else break;
  }
  const out = tokens.slice(0, n).join(' ').replace(/[\s,;:\-–/&]+$/u, '').trim();
  return out || first || whole;
}

/** A tracked board's employer name: the "(via X)" suffix and the "(provider) [tenant]" decorations of a multi-tenant entry removed. */
export const baseName = (name) => String(name ?? '').replace(/\s*\(via [^)]*\)\s*$/i, '').replace(/\s*\[[^\]]*\]\s*$/, '').replace(/\s*\((?:workday|greenhouse|lever|ashby|personio|smartrecruiters|successfactors|oraclecloud|icims|bamboohr)\)\s*$/i, '').trim();

/** name (lowercased) and alias -> catalogue entry, plus canonCompany(name) -> entry for the legal-form-insensitive fallback. */
export function catalogueIndex(catalogue) {
  const exact = new Map(), canon = new Map();
  for (const c of catalogue?.companies ?? []) {
    if (!c?.name) continue;
    for (const n of [c.name, ...(Array.isArray(c.aliases) ? c.aliases : [])]) {
      const k = String(n).trim().toLowerCase();
      if (k && !exact.has(k)) exact.set(k, c);
      const ck = canonCompany(String(n).replace(/\s*\(via [^)]*\)\s*$/i, ''));
      if (ck && !canon.has(ck)) canon.set(ck, c);
    }
  }
  return { exact, canon };
}
const lookup = (index, name) => index.exact.get(name.toLowerCase()) ?? index.canon.get(canonCompany(name)) ?? null;

/** The employer names (lowercased short names) that already have an EURES employer board in the config. */
export function existingEmployerBoards(cfg) {
  const out = new Set();
  for (const c of cfg?.tracked_companies ?? []) {
    if (c?.provider !== 'eures') continue;
    const slug = c.slug ?? detectEures(c.careers_url ?? '');
    if (!slug) continue;
    const { keyword, mode } = parseSlug(slug);
    if (mode === 'EMPLOYER' && keyword) out.add(keyword.toLowerCase());
  }
  return out;
}

/** One board entry (companies.json tracked_companies shape) for an employer; codes [] = every country the portal covers. */
export function boardEntry(employer, codes = []) {
  employer = String(employer).replace(/\s*\|\s*/g, ' ').trim();   // the slug's separator cannot be part of the name
  return {
    name: `EURES employer: ${employer}`,
    careers_url: euresBoardUrl(`employer:${employer}|${codes.join(',')}`),
    provider: 'eures',
    enabled: true,
    interval_hours: INTERVAL_HOURS,
    note: `EURES copies of ${employer}'s postings for cross-listing and metadata; weekly`,
  };
}

/**
 * The boards to add for a config and catalogue. opts.codes: location codes for every board (default: the employer's own country when known,
 * else none). Returns { boards, employers, stats }; employers lists every distinct employer with its verdict and reason, for the summary.
 */
export function selectEmployers(cfg, catalogue, opts = {}) {
  const codesForAll = (opts.codes ?? []).map((c) => String(c).trim().toLowerCase()).filter(Boolean);
  const index = catalogueIndex(catalogue);
  const existing = existingEmployerBoards(cfg);
  const tracked = cfg?.tracked_companies ?? [];
  const stats = { tracked: tracked.length, candidates: 0, employers: 0, covered: 0, unknown: 0, other: 0, existing: 0, emitted: 0 };
  const byKey = new Map();   // short name (lowercased) -> { employer, boards: [names], catalogue, verdict, code }
  for (const c of tracked) {
    if (!c?.name || c.enabled === false || AGGREGATOR_PROVIDERS.has(c.provider)) continue;
    stats.candidates++;
    const base = baseName(c.name);
    const cat = lookup(index, base);
    const employer = shortName(cat?.name ?? base);
    const key = employer.toLowerCase();
    if (!byKey.has(key)) {
      const v = countryVerdict({ ...(cat ?? {}), headquarters: [cat?.headquarters, c.headquarters].filter((x) => typeof x === 'string').join(' | ') });
      byKey.set(key, { employer, boards: [], catalogue: cat?.name ?? null, verdict: v.verdict, code: v.code });
    }
    byKey.get(key).boards.push(c.name);
  }
  stats.employers = byKey.size;
  const boards = [], employers = [];
  for (const e of byKey.values()) {
    stats[e.verdict]++;
    const has = existing.has(e.employer.toLowerCase()) || tracked.some((c) => String(c.name).toLowerCase() === `eures employer: ${e.employer}`.toLowerCase());
    if (has) stats.existing++;
    const emit = e.verdict !== 'other' && !has;
    employers.push({ ...e, existing: has, emitted: emit });
    if (!emit) continue;
    const codes = codesForAll.length ? codesForAll : e.code && COVERED_CODES.has(e.code) ? [euresCodeOf(e.code)] : [];
    boards.push(boardEntry(e.employer, codes));
    stats.emitted++;
  }
  boards.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return { boards, employers, stats };
}

/** The whole run for a profile folder: reads the files, selects, returns { boards, stats, companiesFile, catalogueFile }. */
export function generate(profileDir, opts = {}) {
  const profile = loadProfile(profileDir);
  if (!profile) throw new Error('no profile. Pass --profile <dir> (or set JOBCRAWL_PROFILE).');
  if (!existsSync(profile.companiesFile)) throw new Error(`companies file not found: ${profile.companiesFile} (profile key crawl.companies_file)`);
  const cfg = JSON.parse(readFileSync(profile.companiesFile, 'utf8'));
  let catalogue = { companies: [] };
  if (profile.catalogueFile && existsSync(profile.catalogueFile)) catalogue = JSON.parse(readFileSync(profile.catalogueFile, 'utf8'));
  const { boards, employers, stats } = selectEmployers(cfg, catalogue, opts);
  return { boards, employers, stats, companiesFile: profile.companiesFile, catalogueFile: profile.catalogueFile && existsSync(profile.catalogueFile) ? profile.catalogueFile : null };
}

const USAGE = `usage: node crawler/eures-employer-boards.mjs --profile <dir> [--codes de,fr,...] [--out <file>]
  --profile <dir>   the profile (its companies file and catalogue are read; nothing is written to them)
  --codes <list>    location codes for every board (default: the employer's own country when known, else every country)
  --out <file>      write the JSON array of board entries there (default: stdout; the summary then goes to stderr)
  --help            show this text`;

if (process.argv[1] && fileURLToPath(import.meta.url) === pathResolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
  if (args.includes('--help')) { console.log(USAGE); process.exit(0); }
  const out = opt('out');
  const say = (s) => (out ? console.log : console.error)(`[eures-employer-boards] ${s}`);
  let result;
  try {
    const dir = profileDirFromArgs(args);
    if (!dir) throw new Error('no profile. Pass --profile <dir> (or set JOBCRAWL_PROFILE). See --help.');
    const codes = opt('codes') ? opt('codes').split(/[,\s]+/).filter(Boolean) : [];
    say(`start: profile ${dir}${codes.length ? `, codes ${codes.join(',')}` : ', codes per employer'}`);
    result = generate(dir, { codes });
  } catch (e) { console.error(`eures-employer-boards: ${e.message}`); process.exit(2); }
  const { boards, stats, companiesFile, catalogueFile } = result;
  say(`read ${companiesFile}${catalogueFile ? ` and ${catalogueFile}` : ' (no catalogue)'}`);
  say(`${stats.tracked} tracked boards, ${stats.candidates} enabled non-aggregator, ${stats.employers} distinct employers: ${stats.covered} in covered countries (EEA + CH), ${stats.unknown} of unknown country (included), ${stats.other} elsewhere (skipped), ${stats.existing} already have an EURES employer board; ${stats.emitted} boards emitted`);
  const json = `${JSON.stringify(boards, null, 2)}\n`;
  if (out) {
    mkdirSync(dirname(pathResolve(out)), { recursive: true });
    writeFileSync(out, json);
    say(`wrote ${boards.length} entries to ${pathResolve(out)}; paste the wanted ones into ${companiesFile} (this script does not modify it)`);
  } else process.stdout.write(json);
}
