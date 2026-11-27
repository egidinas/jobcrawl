// Strangler-fig shadow hook for the legacy crawl (design §0.1, phase 1a). The cycle's own answers are teed into the new per-board path, so
// a shadow costs no extra employer request. Nothing here can change what the legacy crawl writes or publishes: the new path writes only
// into its own folder, every failure is caught and logged, and the hook returns before the legacy crawl reads its results.
//
// Armed only when BOTH hold:
//   JOBCRAWL_SHADOW=1                       the arm switch (default off: the crawl does not even load this module)
//   a routing file                          JOBCRAWL_ROUTING=<file> (routing/v1); without one every board is legacy
// Per board: routeFor() decides. legacy -> nothing; shadow -> the board's answer is applied to its state in the shadow store;
// new -> treated as shadow in phase 1 (the legacy crawl stays authoritative until the cut-over step wires `new`). The kill switch
// (JOBCRAWL_ROUTE_KILL or kill_switch in the file) wins over everything: no board is shadowed.
// Shadow store: JOBCRAWL_SHADOW_DATA, else <legacy data>/jcx-shadow. Rules: today's live departure rule (LEGACY_RULES), so parity is
// like for like. One summary line per cycle: boards shadowed, events by op, failures.
import { join, resolve as pathResolve } from 'node:path';
import { loadRouting, routeFor } from './router.mjs';
import { applyRun, LEGACY_RULES } from '../delta/board-delta.mjs';
import { commitRun, lease, openBoard } from '../state/board-store.mjs';

export const armed = (env = process.env) => /^(1|true|yes|on)$/i.test(String(env.JOBCRAWL_SHADOW ?? '').trim()) && Boolean(env.JOBCRAWL_ROUTING);

/** The run a legacy board result corresponds to (the same shape core/run-board.mjs produces). */
export function runOfLegacyResult(res) {
  if (!res || res.skipped) return null;                       // skipped by the breaker: no observation at all
  if (res.error || !Array.isArray(res.jobs)) return { ok: false, items: [], error: { cls: res.triage?.cls ?? 'OTHER', detail: String(res.error ?? '') } };
  return { ok: true, items: res.jobs, complete: !res.jobs.incomplete, emptyOk: res.jobs.emptyOk === true };
}

/**
 * Applies the cycle's answers of the routed boards to the shadow store. companies[i] <-> results[i] (crawl.mjs pool order).
 * Returns a summary { armed, shadowed, skipped, failed, ops } (never throws).
 */
export async function runShadow({ dataDir, companies, results, env = process.env, now = () => new Date(), log = console.log }) {
  const sum = { armed: armed(env), shadowed: 0, legacy: 0, skipped: 0, failed: 0, ops: {} };
  if (!sum.armed) return sum;
  let routing;
  try { routing = loadRouting(env.JOBCRAWL_ROUTING); } catch (e) { log(`[shadow] routing unreadable, nothing shadowed: ${e.message}`); sum.failed++; return sum; }
  const root = env.JOBCRAWL_SHADOW_DATA ? pathResolve(env.JOBCRAWL_SHADOW_DATA) : join(dataDir, 'jcx-shadow');
  for (let i = 0; i < companies.length; i++) {
    const entry = companies[i], res = results[i];
    try {
      const provider = res?.r?.provider ?? entry.provider ?? null;
      const { route, why } = routeFor(routing, { board: entry.name, provider }, env);
      if (route === 'legacy') { sum.legacy++; if (why === 'kill switch') { sum.killed = true; } continue; }
      const run = runOfLegacyResult(res);
      if (!run) { sum.skipped++; continue; }
      const release = await lease(root, entry.name, 5 * 60e3);
      if (!release) { sum.skipped++; continue; }
      try {
        const { state, events } = applyRun(openBoard(root, entry.name, { log }), run, { board: entry.name, now: now(), rules: LEGACY_RULES, maxJobs: Number(entry.max_jobs) || null });
        commitRun(root, entry.name, state, events);
        for (const e of events) sum.ops[e.op] = (sum.ops[e.op] ?? 0) + 1;
        sum.shadowed++;
      } finally { release(); }
    } catch (e) { sum.failed++; if (sum.failed <= 5) log(`[shadow] ${entry?.name}: ${e?.message ?? e}`); }
  }
  log(`[shadow] ${sum.killed ? 'kill switch on: nothing shadowed' : `boards shadowed ${sum.shadowed}, legacy ${sum.legacy}, skipped ${sum.skipped}, failed ${sum.failed}, events ${JSON.stringify(sum.ops)}`} -> ${root}`);
  return sum;
}
