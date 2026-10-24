// Relevance gate and probation bookkeeping for the crawler.
//
//  - Relevance lists (keywords, negative, ssic_deeptech) come from the profile: useRelevance(profile.relevance).
//    Syntax as in companies.json title_filter: plain entries are substrings, "word:" entries match whole words. Text is matched
//    case- and accent-insensitively (Pruf matches Prüfer).
//  - Probation: companies.json entries with "probation": true are gated on the relevance lists until they show one relevant role.
//  - Singapore feed: strict employer-and-role gate for MyCareersFuture ("relevance": "strict", the default for that provider).
// Dependency free; imports only crosslist.mjs for canonical employer names.
import { existsSync, readFileSync } from 'node:fs';
import { canonCompany } from './crosslist.mjs';

// The lists come from the profile (profile.json, crawl.relevance): call useRelevance() once before using the checks below.
// Until then nothing is relevant. Keys: keywords, negative, ssic_deeptech (see profiles/schema.md).
let hit = () => false, hitNegative = () => false;
let ssicDeeptech = [];
export function useRelevance({ keywords = [], negative = [], ssic_deeptech: ssic = [] } = {}) {
  hit = makeMatcher(keywords);
  hitNegative = makeMatcher(negative);
  ssicDeeptech = ssic.map(String);
}

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function makeMatcher(list) {
  const words = [], subs = [];
  for (const k of list) (k.startsWith('word:') ? words : subs).push(k.startsWith('word:') ? esc(norm(k.slice(5))) : norm(k));
  const re = words.length ? new RegExp(`(?<![a-z0-9])(?:${words.join('|')})(?![a-z0-9])`) : null;
  return (text) => { const t = norm(text); return !!t && ((re && re.test(t)) || subs.some((s) => t.includes(s))); };
}

/** True when a title (or department/team text) matches the relevance list. */
export const isRelevantText = (text) => hit(text) && !hitNegative(text);
/** A role is relevant when its title, or the department/team the provider returned, matches. */
export const isRelevantRole = (job) => isRelevantText(job?.title) || isRelevantText(job?.department);

// ---------- employer index (protected / trusted names) ----------
const stripVia = (n) => String(n ?? '').replace(/\s*\(via [^)]*\)\s*$/i, '');
/** Set of canonical employer names. has() also accepts a whole-word prefix of at least 5 characters in either direction. */
export function makeEmployerIndex(names = []) {
  const exact = new Set(), byFirst = new Map();
  const idx = {
    add(name) {
      const k = canonCompany(stripVia(name));
      if (!k || exact.has(k)) return;
      exact.add(k);
      const f = k.split(' ')[0];
      if (!byFirst.has(f)) byFirst.set(f, []);
      byFirst.get(f).push(k);
    },
    has(name) {
      const k = canonCompany(stripVia(name));
      if (!k) return false;
      if (exact.has(k)) return true;
      return (byFirst.get(k.split(' ')[0]) ?? []).some((o) => (o.length >= 5 && k.startsWith(o + ' ')) || (k.length >= 5 && o.startsWith(k + ' ')));
    },
    get size() { return exact.size; },
  };
  for (const n of names) idx.add(n);
  return idx;
}

// Company names that the industry aggregators carry (the "protected" set): the suffix "(via X)" the providers add, per aggregator.
export const INDUSTRY_VIA = /\(via (?:Space Individuals|Space-Careers|Space Capital|SpaceJobSearch|Jobs-in-Photonics)\)\s*$/i;
export const INDUSTRY_AGGREGATOR_PROVIDERS = new Set(['spacecareers', 'spacecapital', 'spaceindividuals', 'jobsinphotonics']);

/** Names from the history's company column that came through an industry aggregator. MyCareersFuture is deliberately not one. */
export function protectedFromHistory(historyRows) {
  const out = [];
  for (const row of historyRows) if (INDUSTRY_VIA.test(row.company ?? '')) out.push(stripVia(row.company));
  return out;
}

/**
 * Names (and aliases) of an employer catalogue file (profile key crawl.catalogue_file, optional). A catalogue may also be seeded from every
 * employer a Singapore-style feed ever showed (recruiter shells included, domain mycareersfuture.gov.sg, unreviewed); those are not evidence
 * of relevance and are skipped.
 */
export function loadCatalogueNames(path) {
  if (!path || !existsSync(path)) return [];
  let c;
  try { c = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  const out = [];
  for (const e of c.companies ?? []) {
    if (e.kind === 'board') continue;
    if (!e.reviewed && /mycareersfuture\.gov\.sg/i.test(e.domain ?? '')) continue;
    out.push(e.name, ...(e.aliases ?? []));
  }
  return out.filter(Boolean);
}

// ---------- Singapore (MyCareersFuture) employer-and-role gate ----------
// Recruiters, staffing and HR shells: always dropped.
const AGENCY_NAME = /(?<![a-z])(?:recruit\w*|staffing|staffking|manpower|headhunt\w*|executive search|search associates|search personnel|asia search|talent\w*|personnel|placement|resourcing|outsourc\w*|human (?:capital|resources?)|workforce|job ?(?:express|hub)|career\w*|labour|randstad|adecco|persol|quess|kelly services|michael page|robert walters|robert half|hays|rn care|wecruit)(?![a-z])/;
const CONSULT_NAME = /(?<![a-z])consult\w*(?![a-z])/;
// SSIC (2020) 78xxx = employment agencies, temp-staff and other HR provision.
const SSIC_AGENCY = /^78/;
// Deep-tech SSIC prefixes come from the profile (crawl.relevance.ssic_deeptech), e.g. aerospace 303x/304x, defence, electronics, optics.

function sgFacts(j) {
  const sg = j.sg ?? {};
  const ssic = (sg.ssic ?? []).map(String);
  return { employer: sg.employer ?? stripVia(j.company), hiring: sg.hiring ?? '', ssic, skills: sg.skills ?? [], onBehalf: !!sg.onBehalf, posted: sg.employer ?? stripVia(j.company) };
}

/**
 * Verdict for a job of a strict feed: null = keep, otherwise the reason. `trusted` is an employer index (catalogue, protected, tracked).
 * Order: agency (always dropped) -> trusted employer -> relevant title -> deep-tech SSIC / employer name / skills -> drop.
 */
export function strictVerdict(j, trusted, mode = 'strict') {
  if (mode === 'off') return null;
  const f = sgFacts(j);
  const names = [f.employer, f.hiring].filter(Boolean);
  const isTrusted = names.some((n) => trusted.has(n));
  if (f.onBehalf && !(f.hiring && trusted.has(f.hiring))) return 'recruitment agency (posted on behalf)';
  if (f.ssic.some((s) => SSIC_AGENCY.test(s)) && !isTrusted) return 'recruitment agency (SSIC 78)';
  if (!isTrusted && names.some((n) => AGENCY_NAME.test(norm(n)))) return 'recruitment agency (name)';
  if (mode === 'broad') return null;
  if (isTrusted) return null;
  if (names.some((n) => CONSULT_NAME.test(norm(n))) && !f.ssic.some((s) => ssicDeeptech.some((p) => s.startsWith(p)))) return 'consulting shell';
  if (isRelevantRole(j)) return null;
  if (f.ssic.some((s) => ssicDeeptech.some((p) => s.startsWith(p)))) return null;
  if (names.some((n) => isRelevantText(n))) return null;
  if (f.skills.filter((s) => isRelevantText(s)).length >= 2) return null;
  return 'not relevant (strict)';
}

// ---------- probation ----------
export const PROBATION_CYCLES = 5;
export const PROBATION_VERDICT = 'probation: not relevant';

export function newProbation(now) {
  return { state: 'probation', probation_disabled: false, relevant_seen: 0, irrelevant_seen: 0, cycles_ok: 0, wrong_streak: 0, first_cycle: now, last_cycle: null, sample_irrelevant: [] };
}

/**
 * Fold one finished cycle of a probation company into its state (mutates and returns it).
 *   cyc = { ok, total, relevant, irrelevant, protectedNow, now, samples, needed }
 * A failed or empty cycle changes nothing (it neither counts toward the streak nor resets it). Promotion on one relevant role;
 * disable only after `needed` consecutive successful cycles that showed irrelevant roles and no relevant one.
 */
export function probationCycle(st, cyc) {
  const needed = cyc.needed ?? PROBATION_CYCLES;
  if (st.reenable) {   // re-enabled by hand: forget the streak
    Object.assign(st, { state: 'probation', probation_disabled: false, wrong_streak: 0, reenabled_at: cyc.now });
    delete st.reenable; delete st.reason; delete st.disabled_at;
  }
  if (st.state === 'disabled' && cyc.protectedNow) Object.assign(st, { state: 'protected', probation_disabled: false, wrong_streak: 0 });
  if (st.state === 'disabled') return st;
  if (!cyc.ok || !(cyc.total > 0)) return st;
  st.cycles_ok += 1;
  st.relevant_seen += cyc.relevant;
  st.irrelevant_seen += cyc.irrelevant;
  st.last_cycle = { at: cyc.now, total: cyc.total, relevant: cyc.relevant, irrelevant: cyc.irrelevant };
  if (cyc.samples?.length) st.sample_irrelevant = [...new Set([...cyc.samples, ...(st.sample_irrelevant ?? [])])].slice(0, 5);
  if (st.state === 'promoted' || st.state === 'protected') return st;
  if (cyc.protectedNow) { st.state = 'protected'; st.wrong_streak = 0; return st; }
  if (cyc.relevant > 0) { st.state = 'promoted'; st.wrong_streak = 0; st.promoted_at = cyc.now; return st; }
  if (cyc.irrelevant > 0) {
    st.wrong_streak += 1;
    if (st.wrong_streak >= needed) {
      st.state = 'disabled';
      st.probation_disabled = true;
      st.disabled_at = cyc.now;
      st.reason = `WRONG jobs: ${st.wrong_streak} consecutive successful cycles with irrelevant roles only (${st.irrelevant_seen} irrelevant, 0 relevant seen)`;
    }
  }
  return st;
}

// ---------- catalogue seeding gate (see CATALOGUE_NOTES.md) ----------
// Employers that only the Singapore feed (MyCareersFuture) brought in are added to a catalogue only when they
// pass seedVerdict(): not an agency/shell by name, and with a sector signal in the name or in one of their roles.
// One shared constant: names (case-insensitive, whole words) of recruiters and non-sector shells that the generic regexes miss.
export const RECRUITER_BLOCKLIST = [
  'elitez', 'jondavidson', 'chris hunter', 'intellipro', 'cornerstone global', 'wecruit', 'adecco', 'manpower', 'kelly services', 'hays',
  'infotech', 'quantum leap', 'xinsha', 'worq', 'hypercal', 'aesthetic', 'aesthetics', 'clinic', 'cataract', 'surgery', 'hospital', 'medical centre',
  'ship management', 'shipping', 'hospitality', 'hotel', 'restaurant', 'catering', 'general trading', 'trading', 'holdings', 'citibank', 'insurance',
  'advisors', 'advisory', 'care',
];
const BLOCK_RE = new RegExp('(?<![a-z0-9])(?:' + RECRUITER_BLOCKLIST.map((s) => esc(s).split(' ').join('\\s+')).join('|') + ')(?![a-z0-9])');

/**
 * Verdict for seeding a Singapore-feed employer into the catalogue: null = seed, otherwise the reason.
 * `jobs` are the feed rows of that employer (may be empty). Names that are reviewed/tracked/trusted must be checked by the caller first.
 */
export function seedVerdict(name, jobs = []) {
  const n = norm(stripVia(name));
  if (AGENCY_NAME.test(n)) return 'recruitment agency (name)';
  if (BLOCK_RE.test(n)) return 'recruiter/non-sector shell (blocklist)';
  const deep = (jobs ?? []).some((j) => (j.sg?.ssic ?? []).map(String).some((s) => ssicDeeptech.some((p) => s.startsWith(p))));
  if (CONSULT_NAME.test(n) && !deep) return 'consulting shell';
  if (isRelevantText(stripVia(name)) || deep || (jobs ?? []).some(isRelevantRole)) return null;
  return 'no sector signal';
}
