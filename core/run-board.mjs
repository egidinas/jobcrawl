// The new path for one board (strangler fig, design §3.3): read the board through the existing source code (crawler/providers.mjs;
// sources are shared by both paths while the orchestration moves), then apply the read to the board's own state and append its deltas.
// One board = one job: its own lease, state and sequence; a failure or timeout affects only this board.
import { providers as defaultProviders, resolve as defaultResolve } from '../crawler/providers.mjs';
import { entryTimeoutMs } from '../crawler/profile.mjs';
import { classifyError } from '../crawler/resilience.mjs';
import { runWithSignal } from './fetch/context.mjs';
import { applyRun, DEFAULT_RULES } from './delta/board-delta.mjs';
import { commitRun, lease, openBoard } from './state/board-store.mjs';

/** Reads one board. Returns a run: { ok, items, complete, emptyOk, incomplete, error, ms, provider, slug }. Never throws. */
export async function readBoard(entry, { providers = defaultProviders, resolve = defaultResolve, timeoutMs } = {}) {
  const t0 = Date.now();
  const r = resolve(entry);
  if (!r || !providers[r.provider]) return { ok: false, items: [], error: { cls: 'CONFIG', detail: 'no supported source for this entry' }, ms: 0 };
  const ms = timeoutMs ?? entryTimeoutMs(entry);
  // readBoard never swaps the process-wide fetch: the entry point (CLI, MCP) installs the engine fetch (core/fetch/guard.mjs). The board's
  // time budget aborts the requests in flight through the ambient signal and ctx.signal.
  const ac = new AbortController();
  let timer;
  try {
    const jobs = await Promise.race([
      runWithSignal(ac.signal, () => providers[r.provider].fetch(r.slug, entry, { signal: ac.signal })),
      new Promise((_, rej) => { timer = setTimeout(() => { const err = new Error(`Timed out after ${Math.round(ms / 1000)}s (${entry.name})`); rej(err); ac.abort(err); }, ms); }),
    ]);
    const list = Array.isArray(jobs) ? jobs : [];
    return { ok: true, items: list, complete: !list.incomplete, emptyOk: list.emptyOk === true, incomplete: list.incomplete ?? null,
      ms: Date.now() - t0, provider: r.provider, slug: r.slug };
  } catch (e) {
    const tri = classifyError(e);
    return { ok: false, items: [], error: { cls: tri.cls, detail: tri.detail ?? String(e?.message ?? e) }, ms: Date.now() - t0, provider: r.provider, slug: r.slug };
  } finally { clearTimeout(timer); ac.abort(); }
}

/**
 * Runs one board on the new path into the store at root. `read` may be supplied (replay, tests); otherwise the board is fetched.
 * Returns { board, skipped?, run, events, seqFrom, seqTo, state }.
 */
export async function runBoard(root, entry, { read, rules = DEFAULT_RULES, now = () => new Date(), leaseMs = 15 * 60e3, ...readOpts } = {}) {
  const board = entry.name;
  const release = await lease(root, board, leaseMs);
  if (!release) return { board, skipped: 'lease held by another run' };
  try {
    const run = read ?? (await readBoard(entry, readOpts));
    const prev = openBoard(root, board);
    const { state, events } = applyRun(prev, run, { board, now: now(), rules, maxJobs: Number(entry.max_jobs) || null });
    const { seqFrom, seqTo } = commitRun(root, board, state, events);
    return { board, run, events, seqFrom, seqTo, state };
  } finally { release(); }
}
