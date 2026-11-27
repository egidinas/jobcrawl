// Per-board state and deltas (design: JOBCRAWLX_DESIGN.md §3.6). Pure functions, no I/O.
//
// applyRun(prev, run, opts) -> { state, events }
//   prev   the board's state (board-state/v1) or null for a first read
//   run    one read of the board: { ok, items, complete?, emptyOk?, incomplete?, error? }
//          items: [{ url, title, location?, postedAt?, description? }] as a source returns them
//   opts   { board, now: Date, rules, guard }
//
// Events (delta/v1), numbered per board by `seq` (+1 per event), so a consumer that remembers the last applied seq of a board can replay
// any log idempotently:
//   added       a posting this board never listed before
//   changed     title, location, posting date or description changed (`fields` names which)
//   reappeared  a departed posting is listed again (same id)
//   departed    the departure rule fired (see below)
//   board-ok    the read succeeded ({ n, complete, held? }); one per successful read
//   board-failed the read failed ({ cls, detail }); never counts a miss, never departs anything
//
// Departure grace. Only a COMPLETE read can count a miss: not marked incomplete by the source, not capped, and non-empty unless the
// source gave its positive empty signal (emptyOk). Rules:
//   { mode: 'misses', k: 3, floorH: 24 }   departed after k consecutive complete misses AND floorH hours since last seen (package default)
//   { mode: 'age', days: 3 }               departed when not seen for `days` days, checked on complete reads
// Today's live rule (crawl.mjs on madenetwork origin/main, MADE_LIFECYCLE=shadow on the NUC): the FIRST complete miss closes a role
// (crawl.mjs ~834-838, after the liveness guard and the admission hold), i.e. LEGACY_RULES = misses k=1, floor 0. The "3 days" rule is
// only the fallback sweep for rows no feed confirms any more (~985-995), which the resolver applies across boards, not this module.
// With MADE_LIFECYCLE=on the live rule becomes k=3 + 24 h (DEFAULT_RULES) and unseen rows become 'unknown' instead of closed.
// Mass-departure guard: when a complete read would drop more than (1 - keepRatio) of a board's open postings (with at least minOpen
// open), the misses are held until `confirm` consecutive reads say the same (the crawl's livenessGuard, resilience.mjs GUARD).
import { postingId, sha256 } from '../id.mjs';
import { PRODUCER } from '../compat/envelope.mjs';

export const STATE_SCHEMA = 'board-state/v1';
export const DELTA_SCHEMA = 'delta/v1';
export const DEFAULT_RULES = Object.freeze({ mode: 'misses', k: 3, floorH: 24 });
export const LEGACY_RULES = Object.freeze({ mode: 'misses', k: 1, floorH: 0 });
export const SWEEP_RULES = Object.freeze({ mode: 'age', days: 3 });
export const DEFAULT_GUARD = Object.freeze({ minOpen: 5, keepRatio: 0.5, confirm: 3 });
export const CAPPED_COUNTS = new Set([500, 1000, 2000, 5000, 10000]);
const HOUR = 3600e3;

export function emptyState(board) {
  return { schema: STATE_SCHEMA, board, seq: 0, runs: 0, last_run: null, last_ok: null, last_complete: null, guard_hold: 0, postings: {} };
}

/** Whether a successful read may count misses (see the header). */
export function isComplete(run, maxJobs = null) {
  const n = run.items?.length ?? 0;
  if (run.complete === false || run.incomplete) return false;
  if (CAPPED_COUNTS.has(n)) return false;
  if (maxJobs && n >= maxJobs) return false;
  return n > 0 || run.emptyOk === true;
}

const fieldsOf = (it) => ({
  url: String(it.url ?? ''),
  title: String(it.title ?? '').trim(),
  location: String(it.location ?? '').trim(),
  posted: String(it.postedAt ?? it.posted ?? '').slice(0, 10),
  dh: it.description ? sha256(String(it.description)).slice(0, 16) : (it.dh ?? null),
});
const COMPARED = ['title', 'location', 'posted', 'dh'];

/** The compact posting carried by added/changed/reappeared events (posting/v1 subset). */
export function toPosting(board, id, rec) {
  return {
    '@type': 'JobPosting', title: rec.title, url: rec.url, datePosted: rec.posted || undefined,
    jobLocation: rec.location ? [{ '@type': 'Place', address: { name: rec.location } }] : undefined,
    jobcrawl: { schema: 'posting/v1', id, board, status: rec.status, first_seen: rec.first_seen, last_seen: rec.last_seen, content_hash: rec.dh ?? undefined },
  };
}

export function applyRun(prev, run, { board, now = new Date(), rules = DEFAULT_RULES, guard = DEFAULT_GUARD, maxJobs = null } = {}) {
  if (!board) throw new Error('applyRun: opts.board is required');
  const state = prev ? structuredClone(prev) : emptyState(board);
  if (state.board !== board) throw new Error(`applyRun: state is for board "${state.board}", not "${board}"`);
  const t = now.toISOString();
  const runId = `${t}#${state.runs}`;
  state.runs++;
  state.last_run = t;
  const events = [];
  const emit = (op, extra) => events.push({ schema: DELTA_SCHEMA, producer: PRODUCER, board, seq: ++state.seq, run: runId, t, op, ...extra });

  if (!run || run.ok === false) {
    emit('board-failed', { cls: run?.error?.cls ?? 'OTHER', detail: String(run?.error?.detail ?? run?.error?.message ?? '').slice(0, 300) });
    return { state, events };
  }
  state.last_ok = t;
  const seen = new Set();
  for (const it of run.items ?? []) {
    if (!it?.url) continue;
    const id = postingId(it.url);
    if (seen.has(id)) continue;       // the same posting twice in one answer: the first wins
    seen.add(id);
    const f = fieldsOf(it);
    const rec = state.postings[id];
    if (!rec) {
      const r = (state.postings[id] = { ...f, first_seen: t, last_seen: t, misses: 0, status: 'open' });
      emit('added', { id, posting: toPosting(board, id, r) });
      continue;
    }
    const diffs = COMPARED.filter((k) => (f[k] ?? null) !== (rec[k] ?? null) && !(k === 'dh' && f.dh == null));
    for (const k of diffs) rec[k] = f[k];
    rec.url = f.url;
    rec.last_seen = t;
    rec.misses = 0;
    if (rec.status === 'departed') {
      rec.status = 'open'; delete rec.departed_at;
      emit('reappeared', { id, posting: toPosting(board, id, rec) });
    } else if (diffs.length) {
      emit('changed', { id, fields: diffs, posting: toPosting(board, id, rec) });
    }
  }

  const complete = isComplete(run, maxJobs);
  let held = 0;
  if (complete) {
    state.last_complete = t;
    const open = Object.entries(state.postings).filter(([, r]) => r.status === 'open');
    const missing = open.filter(([id]) => !seen.has(id));
    const keeps = open.length - missing.length;
    if (open.length >= guard.minOpen && keeps < guard.keepRatio * open.length && run.emptyOk !== true) {
      state.guard_hold++;
      if (state.guard_hold < guard.confirm) held = missing.length;
    } else state.guard_hold = 0;
    if (!held) {
      if (state.guard_hold >= guard.confirm) state.guard_hold = 0;
      for (const [id, rec] of missing) {
        rec.misses++;
        const sinceSeen = now.getTime() - Date.parse(rec.last_seen);
        const gone = rules.mode === 'age'
          ? sinceSeen >= rules.days * 24 * HOUR
          : rec.misses >= rules.k && sinceSeen >= rules.floorH * HOUR;
        if (gone) {
          rec.status = 'departed'; rec.departed_at = t;
          emit('departed', { id, first_seen: rec.first_seen, last_seen: rec.last_seen, misses: rec.misses });
        }
      }
    }
  }
  emit('board-ok', { n: seen.size, complete, ...(held ? { held } : {}) });
  return { state, events };
}

/** Open postings of a state as { id, ...record } rows. */
export const openPostings = (state) => Object.entries(state?.postings ?? {}).filter(([, r]) => r.status === 'open').map(([id, r]) => ({ id, ...r }));
