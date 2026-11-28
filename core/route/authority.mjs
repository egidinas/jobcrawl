// Strangler-fig authority swap (design §0.1; owner decision 2026-11-28): for a board routed `new` (routing.json, with allow_new: true and
// no kill switch), the crawl's decision which of the board's open roles have closed comes from the new per-board path, applied to the
// SAME answer the legacy code got, and is written into the legacy history (row.status = 'gone') exactly where the legacy decision would be.
// Everything else stays legacy for now: the triage of listed roles (filters, probation, cross-listing), the admission hold across boards,
// the liveness guard (a suspect drop holds the board's closes), lifecycle `on` (K misses), the 3-day sweep for extra/dup rows.
//
// prepareAuthority() runs once per cycle after the boards were read and before their answers are processed: for every board routed
// `new` that has a shadow state (a baseline), it applies the answer to that state (departure rule: the legacy rule per row, from the
// pre-cycle history status) WITHOUT committing, and keeps the board's lease. The crawl then asks decide(board, url) for every missing
// open row; after the cycle commitAuthority() commits the states of the boards whose decisions were applied (a board whose answer the
// legacy code did not get to — incomplete, failed, held by the liveness guard — is not committed: the new path saw nothing either).
// Fallbacks to the legacy decision, counted per board: an empty answer without the provider's empty-OK signal (the legacy crawl closes
// on it, the new path does not count it as complete), and a row the new state does not know.
import { existsSync } from 'node:fs';
import { loadRouting, routeFor } from './router.mjs';
import { applyRun, isComplete } from '../delta/board-delta.mjs';
import { postingId } from '../id.mjs';
import { commitRun, lease, openBoard } from '../state/board-store.mjs';
import { runOfLegacyResult, shadowRoot, armed } from './shadow-hook.mjs';

const NO_GUARD = Object.freeze({ minOpen: Infinity, keepRatio: 0, confirm: 1 });

/** { boards: Map(board -> decision), summary } or null when nothing is routed `new` (or the switch is off). Never throws. */
export async function prepareAuthority({ dataDir, companies, results, history, env = process.env, now = () => new Date(), log = console.log }) {
  try {
    if (!armed(env) || !existsSync(env.JOBCRAWL_ROUTING)) return null;
    const routing = loadRouting(env.JOBCRAWL_ROUTING);
    if (!routing.allow_new) return null;
    const root = shadowRoot(dataDir, env);
    const boards = new Map();
    const summary = { boards: 0, no_baseline: 0, busy: 0, skipped: 0 };
    for (let i = 0; i < companies.length; i++) {
      const entry = companies[i], res = results[i];
      const provider = res?.r?.provider ?? res?.provider ?? entry.provider ?? null;
      if (routeFor(routing, { board: entry.name, provider }, env).route !== 'new') continue;
      const run = runOfLegacyResult(res);
      if (!run || !run.ok) { summary.skipped++; continue; }                 // a failed read closes nothing on either path
      const release = await lease(root, entry.name, 30 * 60e3, Date.now, { busyMs: 2000 });
      if (!release) { summary.busy++; continue; }
      const prev = openBoard(root, entry.name, { log });
      if (!prev.baseline && prev.seq === 0 && !Object.keys(prev.postings).length) { release(); summary.no_baseline++; continue; }
      const rules = { mode: 'legacy', statusOf: (url) => history.get(url)?.status, sweepDays: 3 };
      const { state, events } = applyRun(prev, run, { board: entry.name, now: now(), rules, guard: NO_GUARD, maxJobs: Number(entry.max_jobs) || null });
      // the new view of every posting after this answer: a missing open row closes when the new state does not hold it open (departed
      // now, or already departed or unknown in the baseline)
      const statusAfter = new Map(Object.entries(state.postings).map(([id, p]) => [id, p.status]));   // by posting id
      const urlAfter = new Map(Object.entries(state.postings).map(([id, p]) => [id, p.url]));       // the url the state holds now
      const departed = new Set(events.filter((e) => e.op === 'departed').map((e) => e.id));
      const known = new Set(Object.keys(prev.postings));
      for (const it of run.items ?? []) known.add(postingId(it.url));
      boards.set(entry.name, { state, events, departed, statusAfter, urlAfter, known, complete: isComplete(run, Number(entry.max_jobs) || null), release, reached: false, closed: 0, kept: 0, fallback: 0, fallback_reason: '' });
      summary.boards++;
    }
    if (!boards.size && !summary.no_baseline && !summary.busy) return null;
    return { root, boards, summary };
  } catch (e) { log(`[authority] off this cycle: ${e?.message ?? e}`); return null; }
}

/**
 * The close decision for one missing open row of a board routed `new`: true (close), false (keep open), or null (no new-path decision:
 * the caller applies the legacy rule). Records the reason of a fallback.
 */
export function decide(auth, board, url) {
  const b = auth?.boards.get(board);
  if (!b) return null;
  b.reached = true;
  if (!b.complete) { b.fallback++; b.fallback_reason ||= 'answer not complete for the new path (empty without empty-OK)'; return null; }
  const id = postingId(url);
  if (!b.known.has(id)) { b.fallback++; b.fallback_reason ||= 'row unknown to the new state'; return null; }
  // the posting id ignores tracking/session parameters, the legacy history does not: a row whose url differs from the one the state
  // holds (the answer now lists another variant of it) is decided by the legacy rule, so the history never keeps two open copies
  if (b.urlAfter.get(id) !== url) { b.fallback++; b.fallback_reason ||= 'url variant (same posting id, other url)'; return null; }
  if (b.departed.has(id) || (b.statusAfter.has(id) && b.statusAfter.get(id) !== 'open')) { b.closed++; return true; }
  b.kept++;
  return false;
}

/** Marks a board as processed by the crawl (its decisions were taken, even with nothing missing). */
export function reached(auth, board) { const b = auth?.boards.get(board); if (b) b.reached = true; }

/** Commits the states of the boards whose answers were applied, releases every lease, logs one summary line. */
export function commitAuthority(auth, { log = console.log } = {}) {
  if (!auth) return null;
  const s = { ...auth.summary, committed: 0, not_reached: 0, closed: 0, kept: 0, fallback: 0 };
  for (const [board, b] of auth.boards) {
    try {
      if (b.reached) { commitRun(auth.root, board, b.state, b.events); s.committed++; } else s.not_reached++;
      s.closed += b.closed; s.kept += b.kept; s.fallback += b.fallback;
      if (b.fallback) log(`[authority] ${board}: ${b.fallback} row(s) decided by the legacy rule (${b.fallback_reason})`);
    } catch (e) { log(`[authority] ${board}: commit failed: ${e?.message ?? e}`); }
    finally { try { b.release(); } catch {} }
  }
  log(`[authority] boards routed new ${s.boards} (committed ${s.committed}, not reached ${s.not_reached}), closed by the new path ${s.closed}, kept open ${s.kept}, legacy fallback rows ${s.fallback}, no baseline ${s.no_baseline}, lease busy ${s.busy}, failed reads ${s.skipped}`);
  return s;
}

/** Boards decided by the authority path this cycle (the shadow hook skips them: their answer is already applied). */
export const authorityBoards = (auth) => new Set(auth ? [...auth.boards.keys()] : []);
