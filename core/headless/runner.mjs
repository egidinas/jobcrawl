// The unattended multi-board run (design §3.9): a cycle over the given boards on the new path, resumable, interruptible, one lock per data
// folder. Progress lives in <data>/run-state.json (atomic replace after every board), so a SIGTERM or a crash mid-cycle loses at most the
// board in flight (its read is discarded; its store is untouched) and the next start continues with the boards not yet done.
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { EXIT } from './exit.mjs';
import { runBoard as defaultRunBoard } from '../run-board.mjs';
import { StateError } from '../state/board-store.mjs';

export const RUN_STATE_SCHEMA = 'run-state/v1';
const stateFile = (data) => join(data, 'run-state.json');
const lockFile = (data) => join(data, 'run.lock');
const LOCK_TTL_MS = 20 * 60e3;

function writeAtomic(file, text) { const tmp = `${file}.tmp-${process.pid}`; writeFileSync(tmp, text); renameSync(tmp, file); }
export function readRunState(data) {
  try { const s = JSON.parse(readFileSync(stateFile(data), 'utf8')); return s?.schema === RUN_STATE_SCHEMA ? s : null; } catch { return null; }
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Takes <data>/run.lock (pid, host, expiry). Returns { renew, release } or null while a live run holds it. A dead pid on this host or an expired lock is taken over. */
export function acquireLock(data, { now = Date.now, ttlMs = LOCK_TTL_MS } = {}) {
  mkdirSync(data, { recursive: true });
  const file = lockFile(data), me = { pid: process.pid, host: hostname() };
  const body = () => JSON.stringify({ ...me, started: new Date(now()).toISOString(), expires: now() + ttlMs });
  for (let attempt = 0; ; attempt++) {
    try { writeFileSync(file, body(), { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let cur = null; try { cur = JSON.parse(readFileSync(file, 'utf8')); } catch { /* unreadable: treat as stale */ }
      const live = cur && cur.expires > now() && !(cur.host === me.host && !pidAlive(cur.pid));
      if (live || attempt) return null;
      try { unlinkSync(file); } catch { /* raced: the retry decides */ }
    }
  }
  return { renew: () => { try { writeFileSync(file, body()); } catch { /* best effort */ } },
    release: () => { try { const c = JSON.parse(readFileSync(file, 'utf8')); if (c.pid === me.pid && c.host === me.host) unlinkSync(file); } catch { /* gone */ } } };
}

/**
 * One cycle. boards: entries ({ name, ... }) in run order. Options:
 *   readFor(entry) -> a read (replay, tests) or undefined (live)   signal: AbortSignal (SIGTERM/SIGINT; reason = signal name)
 *   maxMs: wall-clock budget; no new board starts after it (the cycle stays open and the next run continues)
 *   everyMs: skip while the last COMPLETE cycle ended less than this ago   strict/staleMs: health alerts -> exit 5
 *   providerOf(entry) for the metrics label   log, metrics, now, runBoardImpl: plumbing and test seams
 *   store: a store object (core/state/store.mjs); omitted = the JSON files store at `data` (today's behaviour)
 * Returns { code, summary }. Store errors map to exit 4; any other board error is that board's failure.
 */
export async function runCycle(data, boards, { readFor = () => undefined, signal, maxMs = null, everyMs = 0, strict = false, staleMs = 48 * 3600e3,
  providerOf = () => null, log, metrics, now = Date.now, runBoardImpl = defaultRunBoard, leaseMs, lock = true, store } = {}) {
  const t0 = now();
  const L = log ?? { info() {}, warn() {}, error() {} };
  const lk = lock ? acquireLock(data, { now }) : { renew() {}, release() {} };
  if (!lk) { L.error('lock-held', { data, file: lockFile(data) }); return { code: EXIT.LOCKED, summary: { error: 'lock held by another run' } }; }
  try {
    const old = readRunState(data);
    const names = boards.map((b) => b.name);
    if (old?.status === 'complete' && everyMs && t0 - Date.parse(old.ended) < everyMs) {
      L.info('not-due', { last_cycle_end: old.ended, every_min: Math.round(everyMs / 60e3) });
      return { code: EXIT.OK, summary: { skipped: 'not due', cycle: old.cycle } };
    }
    const resumed = Boolean(old && old.status !== 'complete');
    const st = resumed ? old : { schema: RUN_STATE_SCHEMA, cycle: new Date(t0).toISOString(), started: new Date(t0).toISOString(), done: {},
      prevOpen: old?.prevOpen ?? {}, lastOk: old?.lastOk ?? {} };
    st.status = 'running'; delete st.ended; st.pid = process.pid; st.boards = names;
    for (const k of Object.keys(st.done)) if (!names.includes(k)) delete st.done[k];   // a board dropped from the set is not owed
    const todo = boards.filter((b) => !st.done[b.name]);
    L.info('cycle-start', { cycle: st.cycle, resumed, boards: boards.length, todo: todo.length, max_minutes: maxMs ? maxMs / 60e3 : null });
    const failedNow = () => Object.entries(st.done).filter(([, d]) => !d.ok).map(([b]) => b);
    const publish = () => {
      writeAtomic(stateFile(data), JSON.stringify(st)); lk.renew();
      metrics?.setCycle({ id: st.cycle, status: st.status, total: boards.length, done: Object.keys(st.done).length, failed: failedNow().length, failedBoards: failedNow() });
    };
    publish();
    let interrupted = null, budget = false, storeError = null, k = 0;
    for (const entry of todo) {
      if (signal?.aborted) { interrupted = signal.reason; break; }
      if (maxMs && now() - t0 >= maxMs) { budget = true; L.warn('budget-hit', { max_minutes: maxMs / 60e3, left: todo.length - k }); break; }
      const b0 = now();
      let r;
      try { r = await runBoardImpl(data, entry, { read: readFor(entry), signal, ...(leaseMs ? { leaseMs } : {}), ...(store ? { store } : {}) }); }
      catch (e) {
        if (e instanceof StateError || /sqlite|EACCES|ENOSPC|EIO|state\.json|events\.ndjson/i.test(String(e?.message ?? e))) { storeError = e; L.error('store-error', { board: entry.name, error: String(e.message ?? e) }); break; }
        r = { board: entry.name, run: { ok: false, error: { cls: 'OTHER', detail: String(e?.message ?? e) } }, events: [] };
      }
      if (r.aborted) { interrupted = signal?.reason ?? 'SIGTERM'; L.info('board-discarded', { board: entry.name, why: 'interrupted mid-read' }); break; }
      k++;
      if (r.skipped) { L.warn('board-skipped', { board: entry.name, why: r.skipped }); metrics?.boardRun(providerOf(entry), 'skipped'); continue; }   // leased elsewhere: owed to the next run
      const cls = r.run.ok ? 'ok' : (r.run.error?.cls ?? 'OTHER');
      const open = r.state ? Object.values(r.state.postings ?? {}).filter((p) => p.status === 'open').length : null;
      st.done[entry.name] = { ok: r.run.ok, cls, t: new Date(now()).toISOString(), ...(open != null ? { open } : {}), ...(r.run.ok ? {} : { error: String(r.run.error?.detail ?? '').slice(0, 200) }) };
      if (open != null) { metrics?.set('postingsOpen', (metrics.state.postingsOpen ?? 0) + open - (st.prevOpen[entry.name] ?? 0)); }
      metrics?.boardRun(r.run.provider ?? providerOf(entry), cls);
      L.info('board', { board: entry.name, ok: r.run.ok, cls, ms: now() - b0, open, seq_from: r.seqFrom ?? null, seq_to: r.seqTo ?? null, done: Object.keys(st.done).length, total: boards.length });
      publish();
    }
    const done = Object.keys(st.done).length, failed = failedNow();
    const complete = !interrupted && !budget && !storeError && boards.every((b) => st.done[b.name]);
    // health alerts (--strict): a board without a good read for staleMs, or a board that read zero postings after it had some
    const alerts = [];
    if (strict && complete) {
      for (const n of names) {
        const d = st.done[n];
        if (d?.ok && d.open === 0 && st.prevOpen[n] > 0) alerts.push({ board: n, alert: 'zero-jobs' });
        if (!d?.ok && st.lastOk[n] && now() - Date.parse(st.lastOk[n]) > staleMs) alerts.push({ board: n, alert: 'board-stale' });
      }
    }
    st.status = interrupted ? 'interrupted' : complete ? 'complete' : 'open';
    if (complete) {
      st.ended = new Date(now()).toISOString();
      for (const [n, d] of Object.entries(st.done)) if (d.ok) { st.lastOk[n] = d.t; if (d.open != null) st.prevOpen[n] = d.open; }
      metrics?.set('lastCycleAt', now());
    }
    publish();
    for (const a of alerts) L.warn('health-alert', a);
    const summary = { cycle: st.cycle, status: st.status, resumed, boards: boards.length, done, failed: failed.length, failed_boards: failed.slice(0, 50), alerts, ms: now() - t0 };
    L.info('cycle-end', summary);
    let code = EXIT.OK;
    if (storeError) code = EXIT.STATE;
    else if (interrupted) code = interrupted === 'SIGINT' ? EXIT.SIGINT : EXIT.SIGTERM;
    else if (failed.length) code = EXIT.BOARDS_FAILED;
    else if (alerts.length || (strict && !boards.length)) code = EXIT.STRICT;
    return { code, summary };
  } finally { lk.release(); }
}
