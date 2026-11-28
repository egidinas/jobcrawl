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
import { runOfLegacyResult, shadowRoot, armed, heapHeadroomMb } from './shadow-hook.mjs';

const NO_GUARD = Object.freeze({ minOpen: Infinity, keepRatio: 0, confirm: 1 });
const MIN_HEADROOM_MB = 256;

/**
 * { boards: Map(board -> decision), summary } when boards are routed `new` (a line is always printed for such a cycle by
 * commitAuthority, also when none of them could be read); null when nothing is routed `new` or the switch is off. Never throws: a
 * board whose setup fails goes to the legacy rule alone (its lease released), the others keep the new path.
 * Only a board route counts: a provider routed `new` is refused (routing.json boards: { "<name>": "new" } is the only way in).
 */
export async function prepareAuthority({ dataDir, companies, results, history, env = process.env, now = () => new Date(), log = console.log, headroom = heapHeadroomMb }) {
  let routing, root;
  try {
    if (!armed(env) || !existsSync(env.JOBCRAWL_ROUTING)) return null;
    routing = loadRouting(env.JOBCRAWL_ROUTING);
    if (!routing.allow_new) return null;
    root = shadowRoot(dataDir, env);
  } catch (e) { log(`[authority] off this cycle: ${e?.message ?? e}`); return null; }
  const boards = new Map();
  const summary = { boards: 0, routed: 0, no_baseline: 0, busy: 0, skipped: 0, setup_failed: 0, provider_new_refused: 0, low_memory: 0 };
  const minHeadroom = Number(env.JOBCRAWL_SHADOW_MIN_HEADROOM_MB) || MIN_HEADROOM_MB;
  for (let i = 0; i < companies.length; i++) {
    const entry = companies[i], res = results[i];
    let release = null;
    try {
      const provider = res?.r?.provider ?? res?.provider ?? entry.provider ?? null;
      if (routeFor(routing, { board: entry.name, provider }, env).route !== 'new') continue;
      if (!(routing.boards && Object.hasOwn(routing.boards, entry.name) && routing.boards[entry.name] === 'new')) { summary.provider_new_refused++; continue; }
      summary.routed++;
      const run = runOfLegacyResult(res);
      if (!run || !run.ok) { summary.skipped++; continue; }                 // a failed read closes nothing on either path
      const hr = headroom();
      if (Number.isFinite(hr) && hr < minHeadroom) { summary.low_memory++; continue; }
      release = await lease(root, entry.name, 30 * 60e3, Date.now, { busyMs: 2000 });
      if (!release) { summary.busy++; continue; }
      const prev = openBoard(root, entry.name, { log });
      if (!prev.baseline && prev.seq === 0 && !Object.keys(prev.postings).length) { summary.no_baseline++; continue; }
      const rules = { mode: 'legacy', statusOf: (url) => history.get(url)?.status, sweepDays: 3 };
      const readAt = now();
      const { state, events } = applyRun(prev, run, { board: entry.name, now: readAt, rules, guard: NO_GUARD, maxJobs: Number(entry.max_jobs) || null });
      // the new view of every posting after this answer: a missing open row closes when the new state does not hold it open (departed
      // now, or already departed or unknown in the baseline)
      const statusAfter = new Map(Object.entries(state.postings).map(([id, p]) => [id, p.status]));   // by posting id
      const urlAfter = new Map(Object.entries(state.postings).map(([id, p]) => [id, p.url]));       // the url the state holds now
      const departed = new Set(events.filter((e) => e.op === 'departed').map((e) => e.id));
      const known = new Set(Object.keys(prev.postings));
      for (const it of run.items ?? []) known.add(postingId(it.url));
      boards.set(entry.name, { state, events, readAt: readAt.toISOString(), departed, statusAfter, urlAfter, known, complete: isComplete(run, Number(entry.max_jobs) || null), release, reached: false, error: '', closed: 0, kept: 0, keptUrls: [], fallback: 0, fallback_reason: '' });
      release = null;   // owned by the board entry now (released by commitAuthority)
      summary.boards++;
    } catch (e) { summary.setup_failed++; log(`[authority] ${entry?.name}: setup failed, legacy rule this cycle: ${e?.message ?? e}`); }
    finally { if (release) { try { release(); } catch {} } }
  }
  if (!summary.routed && !summary.provider_new_refused) return null;
  return { root, boards, summary };
}

/**
 * The close decision for one missing open row of a board routed `new`: true (close), false (keep open), or null (no new-path decision:
 * the caller applies the legacy rule). Records the reason of a fallback. Never throws: an error puts the board on the legacy rule for
 * the rest of the cycle and its state is not committed.
 */
export function decide(auth, board, url) {
  const b = auth?.boards.get(board);
  if (!b || b.error) return null;
  try {
    b.reached = true;
    if (!b.complete) { b.fallback++; b.fallback_reason ||= 'answer not complete for the new path (empty without empty-OK)'; return null; }
    const id = postingId(url);
    if (!b.known.has(id)) { b.fallback++; b.fallback_reason ||= 'row unknown to the new state'; return null; }
    // the posting id ignores tracking/session parameters, the legacy history does not: a row whose url differs from the one the state
    // holds (the answer now lists another variant of it) is decided by the legacy rule, so the history never keeps two open copies
    if (b.urlAfter.get(id) !== url) { b.fallback++; b.fallback_reason ||= 'url variant (same posting id, other url)'; return null; }
    if (b.departed.has(id) || (b.statusAfter.has(id) && b.statusAfter.get(id) !== 'open')) { b.closed++; return true; }
    b.kept++;
    if (b.keptUrls.length < 50) b.keptUrls.push(url);
    return false;
  } catch (e) { b.error = String(e?.message ?? e); return null; }
}

/** Marks a board as processed by the crawl (its decisions were taken, even with nothing missing). Never throws. */
export function reached(auth, board) { try { const b = auth?.boards.get(board); if (b && !b.error) b.reached = true; } catch {} }

/**
 * Commits the states of the boards whose answers were applied, releases every lease, logs one summary line (always, for a cycle with
 * boards routed `new`). The read time of a committed state is stamped at commit, after the crawl recorded its fetch (lifecycle), so
 * the ledger's same-fetch check keeps observing the boards after the flip.
 */
export function commitAuthority(auth, { log = console.log, now = () => new Date() } = {}) {
  if (!auth) return null;
  const s = { ...auth.summary, committed: 0, not_reached: 0, errors: 0, closed: 0, kept: 0, fallback: 0 };
  for (const [board, b] of auth.boards) {
    try {
      s.closed += b.closed; s.kept += b.kept; s.fallback += b.fallback;
      if (b.error) { s.errors++; log(`[authority] ${board}: error, legacy rule, state not committed: ${b.error}`); continue; }
      if (b.kept) log(`[authority] ${board}: KEPT OPEN ${b.kept} row(s) the legacy rule would close: ${b.keptUrls.join(' ')}`);
      if (b.fallback) log(`[authority] ${board}: ${b.fallback} row(s) decided by the legacy rule (${b.fallback_reason})`);
      if (!b.reached) { s.not_reached++; continue; }
      const at = now().toISOString();
      if (b.state.last_ok === b.readAt) b.state.last_ok = at;
      for (const p of Object.values(b.state.postings)) { if (p.last_seen === b.readAt) p.last_seen = at; if (p.first_seen === b.readAt) p.first_seen = at; }
      commitRun(auth.root, board, b.state, b.events);
      s.committed++;
    } catch (e) { s.errors++; log(`[authority] ${board}: commit failed: ${e?.message ?? e}`); }
    finally { try { b.release(); } catch {} }
  }
  const all = s.routed && !s.boards ? ' (all routed boards unread or unusable)' : '';
  log(`[authority] boards routed new ${s.routed}, decided ${s.boards}${all} (committed ${s.committed}, not reached ${s.not_reached}, errors ${s.errors}), closed by the new path ${s.closed}, kept open ${s.kept}, legacy fallback rows ${s.fallback}, no baseline ${s.no_baseline}, lease busy ${s.busy}, failed reads ${s.skipped}, setup failed ${s.setup_failed}, low memory ${s.low_memory}, provider routes refused ${s.provider_new_refused}`);
  return s;
}

/** Boards whose answer the authority path applied this cycle (the shadow hook skips them; boards not reached stay with the hook). */
export const authorityBoards = (auth) => new Set(auth ? [...auth.boards].filter(([, b]) => b.reached && !b.error).map(([k]) => k) : []);
