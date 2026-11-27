// Junk gate for probation boards (PROVIDERS review 2026-11-27: 14 of 55 profiled link-group boards listed navigation, product or project
// pages, and probation promotes a board for good on one relevant title, so a URL or a project name could promote one).
//
// junkVerdict(jobs, entry) reads one list answer of a board read by a generic reader (paginated_list, jsonld_direct, sitemap; ATS
// answers are postings by construction and are never judged) and holds it when its titles do not look like a job list:
//   not_job_like  fewer than 40 % of the titles look like job titles, or fewer than 70 % while fewer than 20 % of the posting URLs carry
//                 a job-like token (the "postings" are the site's own pages)
//   junk_titles   >= 2 titles and >= 25 % are a URL, a bare navigation word, link text like "Visit project" / "Data sheet.pdf", or one
//                 title on more than 3 posting URLs
// Job-likeness: the profiler's titleScore, plus role words in further languages, Nordic/German compounds (Maskinoperatör,
// Bauingenieur*in) and gender tags (H/F, m/w/d, :in). A verdict needs at least 3 titles.
// Calibration 2026-11-27 (crawl/notes in the PROVIDERS report): the 14 junk boards of the review held 13 (VITO's department names
// pass), the 3 good link-group boards (JCB AERO, euroAtlantic, RegenRate) held 0; of 61 promoted generic boards, 7 would be held.
// crawl.mjs applies it to probation boards that are not yet promoted, by profile setting crawl.junk_gate:
//   "report" (default): the verdict is recorded in probation-state.json (junk) and listed in the cycle notes; nothing else changes
//   "hold":             a board with a verdict is not promoted by a relevant title (it stays gated, like an employer mismatch)
//   "off":              not computed
import { titleScore, JOB_URL_TOKENS } from './profiler/detect.mjs';

export const JUNK_GATE_MODES = ['off', 'report', 'hold'];
const GENERIC = new Set(['paginated_list', 'jsonld_direct', 'sitemap']);
const NAV_WORD = /^(?:jobs?|karriere|careers?|stellen(?:angebote)?|offene stellen|vacancies|vacatures|join us|platform|products?|services?|solutions?|about(?: us)?|news|blog|team|contact|kontakt|home|more|read more|learn more|apply(?: now)?|impressum|privacy|datenschutz)$/i;
const IS_URL = /^(?:https?:\/\/|www\.)\S+$|^\S+\.(?:com|de|eu|io|net|org|ai|space|fr|nl|it|es|se|at|ch)(?:\/\S*)?$/i;
// job-title words in further languages, so a French/Spanish/Nordic list is not "not job-like" for its language alone
const MORE_ROLE_WORDS = /\b(?:ingénieur|ingeniero|ingegnere|ingenjör|insinööri|inżynier|technicien|técnico|tecnico|tekniker|chef de projet|responsable|directeur|director|jefe|gerente|responsabile|stagiaire|stage|alternance|alternant|becario|prácticas|tirocinio|stagista|praktikant|chargé|chargée|développeur|desarrollador|sviluppatore|utvecklare|kehittäjä|konsult|specialist|projektledare|operatör|montör|mécanicien|mecánico|meccanico|opérateur|operario|operaio|commercial|comptable|contable|analyste|analista|architecte|arquitecto|consultant|consultor|coordinateur|coordinador|assistant|asistente|doctorant|postdoc|thèse|tesi|tesis|vedoucí|specjalista|kierownik|mérnök|technik)\b/i;

const GENDER_MORE = /\b[HF]\s*\/\s*[FH]\b|\(\s*[HF]\s*\/\s*[FH]\s*\)|\b[mwfdx]\s*\/\s*[mwfdx]\s*\/\s*[mwfdx]\b/i;
// phrases of link text that are never a job: "Visit project", "View product", "Data sheet.pdf", "Create free account" ...
const JUNK_PHRASE = /\b(?:visit|view|see) (?:the )?(?:project|product|case|story)s?\b|data ?sheet|\.pdf$|read more|learn more|create (?:a |free )?account|customer stories|@\S+\.\w+/i;
// role words that also end compounds (Maskinoperatör, Produktionstekniker, Bauingenieur, Triebfahrzeugführer, Co-worker) and gendered
// German forms (Kundenberater:in, Gruppenleiter*in): the profiler's titleScore misses many Nordic and German titles
const ROLE_SUFFIX = /(?:tekniker|operatör|ingenjör|chef|säljare|ingenieur|techniker|leiter|leitung|führer|berater|mitarbeiter|arbeiter|fahrer|manager|engineer|specialist|spezialist|koordinator|planer|entwickler|developer|worker|assistent|assistant|inköpare|ekonom|konsult|elektriker|mekaniker|montör|svetsare|handläggare|inkoper|medewerker|monteur|scientist|wissenschaftler|lehrling|azubi|kaufmann|kauffrau|sachbearbeiter|referent|direktor|director|officer|representative|analyst|designer|architect)(?:in|innen|en|e|s)?(?:[*:_/]in(?:nen)?)?\b/i;
const jobLike = (t) => { const s = String(t ?? ''); return !JUNK_PHRASE.test(s) && (titleScore(s) >= 0.6 || ((MORE_ROLE_WORDS.test(s) || GENDER_MORE.test(s) || ROLE_SUFFIX.test(s) || /\w[*:_]in(?:nen)?\b|\(all genders?\)/i.test(s)) && s.length <= 160)); };

/** { hold: bool, reasons: string[], n, jobLikeFrac, junkTitles, tokenFrac } for one list answer. */
export function junkVerdict(jobs = [], entry = {}) {
  const rows = (jobs ?? []).filter((j) => j && j.title);
  const n = rows.length;
  const out = { hold: false, reasons: [], n, jobLikeFrac: null, junkTitles: 0, tokenFrac: null };
  if (n < 3 || !GENERIC.has(entry.provider)) return out;   // ATS answers are postings by construction
  const titles = rows.map((j) => String(j.title).replace(/\s+/g, ' ').trim());
  out.jobLikeFrac = +(titles.filter(jobLike).length / n).toFixed(3);
  const urlsPerTitle = new Map();
  for (const j of rows) { const t = String(j.title).trim().toLowerCase(); if (!urlsPerTitle.has(t)) urlsPerTitle.set(t, new Set()); urlsPerTitle.get(t).add(j.url); }
  const repeated = new Set([...urlsPerTitle].filter(([, u]) => u.size > 3).map(([t]) => t));
  out.junkTitles = titles.filter((t) => IS_URL.test(t) || NAV_WORD.test(t) || JUNK_PHRASE.test(t) || repeated.has(t.toLowerCase())).length;
  const paths = rows.map((j) => { try { const u = new URL(j.url); return u.pathname + u.search; } catch { return ''; } });
  out.tokenFrac = +(paths.filter((p) => JOB_URL_TOKENS.test(p)).length / n).toFixed(3);
  if (out.jobLikeFrac < 0.4 || (out.jobLikeFrac < 0.7 && out.tokenFrac < 0.2)) out.reasons.push(`not_job_like (${Math.round(out.jobLikeFrac * 100)} % of ${n} titles look like jobs, ${Math.round(out.tokenFrac * 100)} % of URLs carry a job token)`);
  if (out.junkTitles >= 2 && out.junkTitles / n >= 0.25) out.reasons.push(`junk_titles (${out.junkTitles} of ${n} are URLs, navigation or product link text, or repeated)`);
  out.hold = out.reasons.length > 0;
  return out;
}
