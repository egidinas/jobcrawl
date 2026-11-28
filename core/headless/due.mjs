// `jobcrawl run --due` (row 2A.1, design §3.3): short processes, each board on its own cadence, no global cycle.
//   * selectDue: the boards whose own next_due has passed (store table board_cadence), oldest first, up to --max-boards. Pure, so the
//     selection is deterministic for a fixed `now`.
// Clocks: `now` (selection and cadence; --now fixes it) is separate from the store's own clock, which stamps slots, cooldowns and the breaker.
//   * runDue: per board a hard time budget (the ambient ctx.signal aborts its requests in flight; a source that ignores the signal is cut
//     at budget + grace and its result discarded), shared host slots + cooldowns + breaker from the SQLite store (so two processes on one
//     data folder respect one host budget), and the cadence update (next_due, last_ok, consecutive failures, capped exponential backoff).
//   * makeThrottleFetch: a 429/503 answer (Retry-After, else a default) puts the host on a store cooldown.
//   * makeWorkerReader: optional worker thread per board read (--isolate worker), terminated at the budget: the only way to stop a parser
//     that hangs the event loop (catastrophic regex).
// No run.lock here: several `run --due` processes coexist on purpose; per-board leases keep two of them off one board.
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { runBoardOn } from '../run-board.mjs';
import { StateError } from '../state/board-store.mjs';
import { hostOf as entryHost } from '../../crawler/resilience.mjs';
import { entryTimeoutMs } from '../../crawler/profile.mjs';
import { resolve as resolveEntry } from '../../crawler/providers.mjs';

export const MIN_INTERVAL_MS = 15 * 60e3;
export const MAX_INTERVAL_MS = 48 * 3600e3;   // the 48 h cap stays: liveness is confirmed at least this often
export const BACKOFF_BASE_MS = 15 * 60e3;
export const DEFAULT_INTERVAL_HOURS = 24;
const TIMEOUT_CLS = 'TIMEOUT_TLS';
/** Failure classes that say the host (not the board's config or parser) is unwell: only these feed the breaker. */
const HOST_FAILURE = new Set(['TIMEOUT_TLS', 'WAF', 'HTTP_5XX', 'DNS']);

/** The board's own interval in ms: interval_hours of the entry, else the default, clamped to [15 min, 48 h]. */
export function intervalMs(entry, defaultHours = DEFAULT_INTERVAL_HOURS) {
  const h = Number(entry?.interval_hours);
  const ms = (h > 0 ? h : defaultHours) * 3600e3;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, ms));
}
/** Wait after the n-th consecutive failure: base * 2^(n-1), capped. */
export const backoffMs = (failures, { base = BACKOFF_BASE_MS, cap = MAX_INTERVAL_MS } = {}) => Math.min(cap, base * 2 ** Math.max(0, Math.min(failures, 30) - 1));

/**
 * Due boards in run order. boards: entries ({ name, interval_hours? }); rows: cadence rows (array or Map by board).
 * A board without a row is due at once. Order: next_due ascending, then name. Returns [{ entry, nextDue, failures }].
 */
export function selectDue(boards, rows, { now, maxBoards = null } = {}) {
  const by = rows instanceof Map ? rows : new Map((rows ?? []).map((r) => [r.board, r]));
  const due = boards.map((entry) => ({ entry, nextDue: Number(by.get(entry.name)?.next_due ?? 0), failures: Number(by.get(entry.name)?.failures ?? 0) }))
    .filter((d) => d.nextDue <= now)
    .sort((a, b) => a.nextDue - b.nextDue || (a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0));
  return maxBoards > 0 ? due.slice(0, maxBoards) : due;
}

const retryAfterMs = (v, now) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - now) : null;
};

/** Wraps a fetch: a 429 (or 503) answer sets the host's store cooldown from Retry-After (else 30 s / 10 s), capped at capMs. */
export function makeThrottleFetch(base, { store, now = Date.now, capMs = 3600e3, onCooldown = () => {} } = {}) {
  return async function throttleFetch(input, init) {
    const res = await base(input, init);
    if (res && (res.status === 429 || res.status === 503)) {
      try {
        const host = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url).hostname;
        const ms = Math.min(capMs, retryAfterMs(res.headers?.get?.('retry-after'), now()) ?? (res.status === 429 ? 30e3 : 10e3));
        store.setCooldown(host, now() + ms, `HTTP ${res.status}`);
        onCooldown(host, res.status, ms);
      } catch { /* a cooldown that cannot be written must not fail the request */ }
    }
    return res;
  };
}

/** The host key of a board: the host of its URL/slug, else provider:<name>. */
export function hostKeyOf(entry) {
  let r = null; try { r = resolveEntry(entry); } catch { /* unsupported entry: below */ }
  return entryHost(entry, r?.slug) || (r?.provider ? `provider:${r.provider}` : `board:${entry.name}`);
}
const providerOfEntry = (entry) => { try { return resolveEntry(entry)?.provider ?? null; } catch { return null; } };

const WORKER_FILE = fileURLToPath(new URL('./board-worker.mjs', import.meta.url));
/** A reader that runs readBoard in a worker thread per board and terminates it at budget + grace. readerModule: test seam (exports read(entry, {timeoutMs})). */
export function makeWorkerReader({ profileDir = null, data = null, readerModule = null, graceMs = 1500 } = {}) {
  return (entry, { budgetMs }) => new Promise((resolve) => {
    const t0 = Date.now();
    const fail = (cls, detail, code = '') => resolve({ ok: false, items: [], error: { cls, code, detail }, ms: Date.now() - t0 });
    let done = false;
    const w = new Worker(WORKER_FILE, { workerData: { entry, profileDir, data, readerModule, timeoutMs: budgetMs } });
    const timer = setTimeout(() => { if (done) return; done = true; w.terminate().catch(() => {}); fail(TIMEOUT_CLS, `worker terminated at the board budget (${Math.round(budgetMs / 1000)}s)`, 'budget'); }, budgetMs + graceMs);
    const end = (fn) => { if (done) return; done = true; clearTimeout(timer); fn(); };
    w.once('message', (run) => end(() => { w.terminate().catch(() => {}); resolve(run); }));
    w.once('error', (e) => end(() => fail('OTHER', `worker error: ${String(e?.message ?? e).slice(0, 160)}`)));
    w.once('exit', (c) => end(() => fail('OTHER', `worker exited (${c}) without a result`)));
  });
}

/**
 * Runs the due boards. store: the SQLite store. boards: routed entries. Options:
 *   now: () => ms (selection and cadence clock; --now fixes it)   maxBoards, maxMs: how many boards / minutes of starting new ones
 *   boardMs(entry): hard budget per board (default entryTimeoutMs)   graceMs: extra time before a source that ignores the signal is cut
 *   concurrency (4), perHost (1), hostWaitMs (60 s: longest wait for a busy host slot before the board is deferred)
 *   breaker: { threshold, windowMs, openMs } per host; providerThreshold (10)   defaultIntervalHours
 *   readFor(entry) -> a read (replay, tests) | undefined; isolatedRead(entry, { budgetMs }) -> a run (worker); readOptions: passed to readBoard
 *   signal: outer abort (SIGTERM)   log, metrics, runBoardImpl, sleep: plumbing and test seams
 * Returns { selected, ran, ok, failed, timedOut, deferred, skipped, left, interrupted, results[] }.
 */
export async function runDue(store, boards, { now = Date.now, maxBoards = null, maxMs = null, boardMs = entryTimeoutMs, graceMs = 2000, concurrency = 4, perHost = 1,
  hostWaitMs = 60e3, breaker = {}, providerThreshold = 10, defaultIntervalHours = DEFAULT_INTERVAL_HOURS, readFor = () => undefined, isolatedRead = null,
  readOptions = {}, signal, log, metrics, runBoardImpl = runBoardOn, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), hostOf: hostFn = hostKeyOf } = {}) {
  if (!store?.supports?.('cadenceGet')) throw new StateError('run --due needs the sqlite store (per-board cadence, shared host slots and breaker)');
  const L = log ?? { info() {}, warn() {}, error() {} };
  const t0 = Date.now();
  const t = now();
  const picked = selectDue(boards, store.cadenceList(), { now: t, maxBoards });
  const out = { selected: picked.length, ran: 0, ok: 0, failed: 0, timedOut: 0, deferred: 0, skipped: 0, left: 0, interrupted: false, results: [] };
  L.info('due-start', { boards: boards.length, due: picked.length, max_boards: maxBoards, concurrency, per_host: perHost });
  const queue = picked.slice();
  let storeError = null;

  const defer = (entry, until, why) => {
    store.cadenceSet(entry.name, { next_due: Math.max(until, now() + 1000) });
    out.deferred++; out.results.push({ board: entry.name, status: 'deferred', why });
    L.warn('board-deferred', { board: entry.name, why, until: new Date(Math.max(until, now() + 1000)).toISOString() });
  };

  async function one(item) {
    const { entry } = item;
    const host = hostFn(entry), prov = providerOfEntry(entry);
    const hostKey = `host:${host}`, provKey = prov ? `provider:${prov}` : null;
    const budget = Math.max(1, boardMs(entry));
    // breaker: an open key defers the board to its open_until; half-open lets ONE probe through (a host limit of 1)
    let limit = perHost;
    for (const k of [hostKey, provKey].filter(Boolean)) {
      const b = store.breakerState(k);
      if (b.state === 'open') return defer(entry, b.until, `breaker open (${k})`);
      if (b.state === 'half-open') limit = 1;
    }
    // shared host slot (cooldown first, then a free slot; a crashed holder blocks for at most its ttl)
    const ttlMs = budget + graceMs + 5000;
    const w0 = Date.now();
    let slot;
    for (;;) {
      if (signal?.aborted) { out.interrupted = true; return; }
      const r = store.acquireHost(host, { limit, ttlMs });
      if (r.token) { slot = r; break; }
      if (r.reason === 'cooldown') return defer(entry, r.until, `cooldown (${r.detail ?? 'host'})`);
      if (Date.now() - w0 >= hostWaitMs) return defer(entry, now() + 60e3, 'host slots busy');
      await sleep(Math.min(Math.max(r.wait, 20), 250));
    }
    const b0 = Date.now();
    const hard = new AbortController();
    const hardTimer = setTimeout(() => hard.abort(new Error('hard budget')), budget + graceMs);
    const sig = signal ? AbortSignal.any([signal, hard.signal]) : hard.signal;
    let r;
    try {
      const run = runBoardImpl(store, entry, { read: readFor(entry) ?? (isolatedRead ? await isolatedRead(entry, { budgetMs: budget }) : undefined),
        signal: sig, timeoutMs: budget, leaseMs: budget + graceMs + 5000, ...readOptions });
      run.catch(() => {});
      r = await Promise.race([run, new Promise((res) => hard.signal.addEventListener('abort', () => res({ hardCut: true }), { once: true }))]);
    } catch (e) {
      if (e instanceof StateError) { storeError = e; return; }
      r = { board: entry.name, run: { ok: false, error: { cls: 'OTHER', detail: String(e?.message ?? e).slice(0, 200) } } };
    } finally { clearTimeout(hardTimer); slot.release(); }
    if (r.skipped) { out.skipped++; out.results.push({ board: entry.name, status: 'skipped', why: r.skipped }); L.warn('board-skipped', { board: entry.name, why: r.skipped }); return; }
    if (r.aborted && !r.hardCut && signal?.aborted) { out.interrupted = true; L.info('board-discarded', { board: entry.name, why: 'interrupted mid-read' }); return; }
    const run = r.hardCut || r.aborted ? { ok: false, error: { cls: TIMEOUT_CLS, code: 'budget', detail: `hard budget (${Math.round((budget + graceMs) / 1000)}s) exceeded; result discarded` } } : r.run;
    const cls = run.ok ? 'ok' : (run.error?.cls ?? 'OTHER');
    const timedOut = !run.ok && cls === TIMEOUT_CLS && /budget|Timed out/i.test(`${run.error?.code ?? ''} ${run.error?.detail ?? ''}`);
    const tn = now();
    const prev = store.cadenceGet(entry.name);
    const interval = intervalMs(entry, defaultIntervalHours);
    let row;
    if (run.ok) row = { next_due: tn + interval, last_run: tn, last_ok: tn, failures: 0, last_cls: 'ok', last_error: null, interval_ms: interval };
    else {
      const failures = (prev?.failures ?? 0) + 1;
      const cd = store.cooldown(host);
      row = { next_due: Math.max(tn + backoffMs(failures), cd?.until ?? 0), last_run: tn, failures, last_cls: cls, last_error: String(run.error?.detail ?? '').slice(0, 200), interval_ms: interval };
    }
    store.cadenceSet(entry.name, row);
    for (const [k, th] of [[hostKey, breaker.threshold ?? 5], [provKey, providerThreshold]]) {
      if (!k) continue;
      if (run.ok) store.breakerRecord(k, true, breaker);
      else if (HOST_FAILURE.has(cls)) { const s = store.breakerRecord(k, false, { ...breaker, threshold: th }); if (s.state === 'open') L.warn('breaker-open', { key: k, until: new Date(s.until).toISOString(), failures: s.failures }); }
    }
    out.ran++; if (run.ok) out.ok++; else out.failed++; if (timedOut) out.timedOut++;
    out.results.push({ board: entry.name, status: run.ok ? 'ok' : 'failed', cls, ms: Date.now() - b0, ...(timedOut ? { timedOut: true } : {}), next_due: row.next_due });
    metrics?.boardRun(run.provider ?? prov, cls);
    L.info(timedOut ? 'board-timeout' : 'board', { board: entry.name, ok: run.ok, cls, ms: Date.now() - b0, next_due: new Date(row.next_due).toISOString(), failures: row.failures ?? 0, ...(run.ok ? { seq_from: r.seqFrom ?? null, seq_to: r.seqTo ?? null } : { error: row.last_error }) });
  }

  async function worker() {
    for (;;) {
      if (signal?.aborted) { out.interrupted = true; return; }
      if (storeError) return;
      if (maxMs && Date.now() - t0 >= maxMs) { L.warn('budget-hit', { max_minutes: maxMs / 60e3, left: queue.length }); return; }
      const item = queue.shift();
      if (!item) return;
      try { await one(item); } catch (e) { if (e instanceof StateError) { storeError = e; return; } L.error('board-error', { board: item.entry.name, error: String(e?.message ?? e) }); }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, picked.length || 1)) }, worker));
  out.left = queue.length;
  if (storeError) { out.storeError = storeError; L.error('store-error', { error: String(storeError.message) }); }
  L.info('due-end', { due: out.selected, ran: out.ran, ok: out.ok, failed: out.failed, timed_out: out.timedOut, deferred: out.deferred, skipped: out.skipped, left: out.left, ms: Date.now() - t0 });
  return out;
}
