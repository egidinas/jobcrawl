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
import v8 from 'node:v8';
import { applyRun, LEGACY_RULES, normaliseItem } from '../delta/board-delta.mjs';
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

// ---- memory: capture a compact copy, never pin the crawl's big objects (incident 2026-11-28 00:41 and 01:05) ----
// The crawl holds every board's answer (descriptions included) and the whole history (~450k rows) during scan(). Holding references to
// them for the hook kept them alive past their last use, right when saveHistory() builds the ~170 MB history text, and the crawl ran
// out of its ~2.1 GB heap (V8 sizes it from the made-cycle unit's MemoryHigh). So the crawl now calls captureShadowInput() once, and
// the hook keeps only what it needs for the routed boards: their items reduced to url/title/location/postedAt/description hash, and the
// legacy status of their own history rows. A headroom check skips the shadow (with a log line) when the heap is already short.
const MB = 1048576;
export function heapHeadroomMb() {
  const { heap_size_limit } = v8.getHeapStatistics();
  return Math.round((heap_size_limit - process.memoryUsage().heapUsed) / MB);
}

/**
 * The hook's input, copied out of the crawl's objects: { boards: [{ entry, run }], statusByUrl, legacy, killed, has_history, heap }, or
 * null (not armed, no routing file, low heap, error). companies[i] <-> results[i] (crawl.mjs pool order); history: the crawl's
 * Map(url -> row) after this cycle's verdicts. Never throws; holds no reference to its inputs.
 */
export function captureShadowInput({ companies, results, history = null, env = process.env, log = console.log }) {
  try {
    if (!armed(env)) return null;
    if (!existsSync(env.JOBCRAWL_ROUTING)) {
      if (!warnedMissing) { warnedMissing = true; log(`[shadow] routing file ${env.JOBCRAWL_ROUTING} not found: nothing shadowed (warned once)`); }
      return null;
    }
    const minHeadroom = Number(env.JOBCRAWL_SHADOW_MIN_HEADROOM_MB) || 256;
    const h0 = process.memoryUsage().heapUsed;
    if (heapHeadroomMb() < minHeadroom) { log(`[shadow] skipped this cycle: heap headroom ${heapHeadroomMb()} MB < ${minHeadroom} MB before capture`); return null; }
    const routing = loadRouting(env.JOBCRAWL_ROUTING);
    const boards = [];
    let legacyN = 0, killed = false;
    for (let i = 0; i < companies.length; i++) {
      const entry = companies[i], res = results[i];
      const provider = res?.r?.provider ?? res?.provider ?? entry?.provider ?? null;
      const { route, why } = routeFor(routing, { board: entry?.name, provider }, env);
      if (route === 'legacy') { legacyN++; if (why === 'kill switch') killed = true; continue; }
      const run = runOfLegacyResult(res);
      const compact = run && run.ok
        ? { ok: true, complete: run.complete, emptyOk: run.emptyOk,
          items: run.items.map((j) => { const n = normaliseItem(j); return { url: n.url, title: n.title, location: n.location, postedAt: n.posted, dh: n.dh }; }) }
        : run;
      boards.push({ entry: { name: String(entry.name), provider, max_jobs: entry.max_jobs ?? null }, run: compact });
    }
    // legacy status of the routed boards' own history rows (company = the board, or "... (via <board>)"), and of their listed urls
    const names = new Set(boards.map((b) => b.entry.name));
    const statusByUrl = new Map();
    if (history && typeof history.values === 'function' && names.size) {
      for (const row of history.values()) {
        const c = row?.company ?? '';
        let hit = names.has(c);
        if (!hit) { const m = /\(via ([^)]+)\)\s*$/.exec(c); hit = Boolean(m && names.has(m[1])); }
        if (hit) statusByUrl.set(row.url, row.status);
      }
      for (const b of boards) for (const it of b.run?.items ?? []) if (!statusByUrl.has(it.url)) { const r = history.get(it.url); if (r) statusByUrl.set(it.url, r.status); }
    }
    const heap = { captured_mb: +((process.memoryUsage().heapUsed - h0) / MB).toFixed(1), headroom_mb: heapHeadroomMb() };
    return { boards, statusByUrl, legacy: legacyN, killed, has_history: Boolean(history), heap };
  } catch (e) { log(`[shadow] capture failed, nothing shadowed: ${e?.message ?? e}`); return null; }
}

/**
 * Applies a captured input (captureShadowInput) to the shadow store. Callers and tests that still pass companies/results/history get
 * the capture made here. Returns a summary { armed, shadowed, legacy, skipped, slow, over_budget, low_memory, failed, ops, ms, heap }
 * (never throws).
 */
export async function runShadow({ dataDir, input = undefined, companies, results, history = null, env = process.env, now = () => new Date(), log = console.log, clock = Date.now }) {
  const t0 = clock();
  const sum = { armed: armed(env), shadowed: 0, legacy: 0, skipped: 0, slow: 0, over_budget: 0, low_memory: 0, failed: 0, ops: {}, ms: 0 };
  if (!sum.armed) return sum;
  if (input === undefined) input = captureShadowInput({ companies, results, history, env, log });
  if (!input) { if (!existsSync(env.JOBCRAWL_ROUTING)) sum.missing_routing = true; return sum; }
  sum.legacy = input.legacy; sum.killed = input.killed;
  let root;
  try { root = shadowRoot(dataDir, env); } catch (e) { log(`[shadow] ${e.message}; nothing shadowed`); sum.failed++; return sum; }
  const boardMs = Number(env.JOBCRAWL_SHADOW_BOARD_MS) || 2000, budgetMs = Number(env.JOBCRAWL_SHADOW_BUDGET_MS) || 60000;
  const minHeadroom = Number(env.JOBCRAWL_SHADOW_MIN_HEADROOM_MB) || 256;
  // Departures follow the legacy crawl's own rule per row (its status after this cycle): open rows close on the first complete miss,
  // extra/dup rows in the 3-day sweep, filtered rows never by a miss. Without the history: first complete miss.
  const rules = input.has_history ? { mode: 'legacy', statusOf: (url) => input.statusByUrl.get(url), sweepDays: 3 } : LEGACY_RULES;
  const h0 = process.memoryUsage().heapUsed;
  let peak = h0;
  for (const { entry, run } of input.boards) {
    try {
      if (clock() - t0 > budgetMs) { sum.over_budget++; continue; }
      if (heapHeadroomMb() < minHeadroom) { sum.low_memory++; continue; }
      if (!run) { sum.skipped++; continue; }
      const b0 = clock();
      const release = await lease(root, entry.name, 5 * 60e3, Date.now, { busyMs: boardMs });
      if (!release) { sum.skipped++; continue; }
      try {
        const { state, events } = applyRun(openBoard(root, entry.name, { log }), run, { board: entry.name, now: now(), rules, maxJobs: Number(entry.max_jobs) || null });
        commitRun(root, entry.name, state, events);
        for (const e of events) sum.ops[e.op] = (sum.ops[e.op] ?? 0) + 1;
        sum.shadowed++;
      } finally { release(); }
      peak = Math.max(peak, process.memoryUsage().heapUsed);
      if (clock() - b0 > boardMs) { sum.slow++; if (sum.slow <= 3) log(`[shadow] ${entry.name}: slow (${clock() - b0} ms > ${boardMs} ms)`); }
    } catch (e) { sum.failed++; if (sum.failed <= 5) log(`[shadow] ${entry?.name}: ${e?.message ?? e}`); }
  }
  sum.ms = clock() - t0;
  sum.heap = { ...(input.heap ?? {}), hook_peak_delta_mb: +((peak - h0) / MB).toFixed(1) };
  const what = sum.killed && !sum.shadowed ? 'kill switch on: nothing shadowed'
    : `boards shadowed ${sum.shadowed}, legacy ${sum.legacy}, skipped ${sum.skipped}, slow ${sum.slow}, over budget ${sum.over_budget}, low memory ${sum.low_memory}, failed ${sum.failed}, events ${JSON.stringify(sum.ops)}`;
  log(`[shadow] ${what} in ${sum.ms} ms, heap: capture +${sum.heap.captured_mb ?? '-'} MB, hook peak +${sum.heap.hook_peak_delta_mb} MB, headroom ${heapHeadroomMb()} MB -> ${root}`);
  return sum;
}
