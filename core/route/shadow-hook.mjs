// Strangler-fig shadow hook for the legacy crawl (design §0.1, phase 1a). The cycle's own answers are teed into the new per-board path, so
// a shadow costs no extra employer request. Nothing here can change what the legacy crawl writes or publishes: crawl.mjs calls it after
// every legacy output of the cycle is written, the new path writes only into its own folder (outside the data folder and outside any git
// work tree), and every failure is caught and logged.
//
// Armed only when BOTH hold:
//   JOBCRAWL_SHADOW=1|true|yes|on            the arm switch (default off)
//   JOBCRAWL_ROUTING=<file>                  a routing/v1 file; a missing file warns once and shadows nothing
// Per board: routeFor() decides (provider = the result's provider, else the entry's). legacy -> nothing; shadow -> the board's answer is
// applied to its state; new -> treated as shadow in phase 1 (the legacy crawl stays authoritative). The kill switch wins over everything.
// Shadow store: JOBCRAWL_SHADOW_DATA, else <JOBCRAWL_HOME or ~/.local/state/jobcrawl>/shadow/<data folder tag> (core/paths.mjs); a path
// inside the data folder or a git work tree is refused.
// Budgets: per board JOBCRAWL_SHADOW_BOARD_MS (default 2000: the lease wait is capped to it; a board over it is logged as slow) and per
// cycle JOBCRAWL_SHADOW_BUDGET_MS (default 60000: once spent, the remaining boards are skipped and counted). One summary line per cycle
// with the hook's run time. Rules: today's live departure rule (LEGACY_RULES), so parity is like for like.
// Note: shadow parity checks the delta engine on the LEGACY parser's output; it does not qualify a parser change for cut-over.
import { existsSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { loadRouting, routeFor } from './router.mjs';
import { applyRun, LEGACY_RULES } from '../delta/board-delta.mjs';
import { commitRun, lease, openBoard } from '../state/board-store.mjs';
import { checkPlacement, defaultDir } from '../paths.mjs';

const isOn = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
export const armed = (env = process.env) => isOn(env.JOBCRAWL_SHADOW) && Boolean(env.JOBCRAWL_ROUTING);
let warnedMissing = false;

/** The run a legacy board result corresponds to (the same shape core/run-board.mjs produces). */
export function runOfLegacyResult(res) {
  if (!res || res.skipped) return null;                       // skipped by the breaker: no observation at all
  if (res.error || !Array.isArray(res.jobs)) return { ok: false, items: [], error: { cls: res.triage?.cls ?? 'OTHER', detail: String(res.error ?? '') } };
  return { ok: true, items: res.jobs, complete: !res.jobs.incomplete, emptyOk: res.jobs.emptyOk === true };
}

export function shadowRoot(dataDir, env = process.env) {
  return checkPlacement(env.JOBCRAWL_SHADOW_DATA ? pathResolve(env.JOBCRAWL_SHADOW_DATA) : defaultDir('shadow', dataDir, env), dataDir, 'shadow store');
}

/**
 * Applies the cycle's answers of the routed boards to the shadow store. companies[i] <-> results[i] (crawl.mjs pool order).
 * Returns a summary { armed, shadowed, legacy, skipped, slow, over_budget, failed, ops, ms } (never throws).
 */
export async function runShadow({ dataDir, companies, results, env = process.env, now = () => new Date(), log = console.log, clock = Date.now }) {
  const t0 = clock();
  const sum = { armed: armed(env), shadowed: 0, legacy: 0, skipped: 0, slow: 0, over_budget: 0, failed: 0, ops: {}, ms: 0 };
  if (!sum.armed) return sum;
  if (!existsSync(env.JOBCRAWL_ROUTING)) {
    if (!warnedMissing) { warnedMissing = true; log(`[shadow] routing file ${env.JOBCRAWL_ROUTING} not found: nothing shadowed (warned once)`); }
    sum.missing_routing = true;
    return sum;
  }
  let routing, root;
  try { routing = loadRouting(env.JOBCRAWL_ROUTING); } catch (e) { log(`[shadow] routing unreadable, nothing shadowed: ${e.message}`); sum.failed++; return sum; }
  try { root = shadowRoot(dataDir, env); } catch (e) { log(`[shadow] ${e.message}; nothing shadowed`); sum.failed++; return sum; }
  const boardMs = Number(env.JOBCRAWL_SHADOW_BOARD_MS) || 2000, budgetMs = Number(env.JOBCRAWL_SHADOW_BUDGET_MS) || 60000;
  for (let i = 0; i < companies.length; i++) {
    const entry = companies[i], res = results[i];
    try {
      const provider = res?.r?.provider ?? res?.provider ?? entry.provider ?? null;
      const { route, why } = routeFor(routing, { board: entry.name, provider }, env);
      if (route === 'legacy') { sum.legacy++; if (why === 'kill switch') sum.killed = true; continue; }
      if (clock() - t0 > budgetMs) { sum.over_budget++; continue; }
      const run = runOfLegacyResult(res);
      if (!run) { sum.skipped++; continue; }
      const b0 = clock();
      const release = await lease(root, entry.name, 5 * 60e3, Date.now, { busyMs: boardMs });
      if (!release) { sum.skipped++; continue; }
      try {
        const { state, events } = applyRun(openBoard(root, entry.name, { log }), run, { board: entry.name, now: now(), rules: LEGACY_RULES, maxJobs: Number(entry.max_jobs) || null });
        commitRun(root, entry.name, state, events);
        for (const e of events) sum.ops[e.op] = (sum.ops[e.op] ?? 0) + 1;
        sum.shadowed++;
      } finally { release(); }
      if (clock() - b0 > boardMs) { sum.slow++; if (sum.slow <= 3) log(`[shadow] ${entry.name}: slow (${clock() - b0} ms > ${boardMs} ms)`); }
    } catch (e) { sum.failed++; if (sum.failed <= 5) log(`[shadow] ${entry?.name}: ${e?.message ?? e}`); }
  }
  sum.ms = clock() - t0;
  log(`[shadow] ${sum.killed && !sum.shadowed ? 'kill switch on: nothing shadowed' : `boards shadowed ${sum.shadowed}, legacy ${sum.legacy}, skipped ${sum.skipped}, slow ${sum.slow}, over budget ${sum.over_budget}, failed ${sum.failed}, events ${JSON.stringify(sum.ops)}`} in ${sum.ms} ms -> ${root}`);
  return sum;
}
