// Posting lifecycle observations (MADE_LIFECYCLE=shadow|on; design: ~/work/lifecycle/DESIGN.md on the Atlas NUC, coordinator 2026-11-23).
//
// Status is an observation of the source, never a side effect of filtering. This module records WHAT THE SOURCE SAID, and nothing else:
//   fetch    one line per board fetch: class (OK, EMPTY_OK, INCOMPLETE, SUSPECT_DROP, SKIPPED, an error class), jobs, complete yes/no
//   seen     a url listed by a successful fetch: the first sighting ever, the first of each UTC day, and every sighting after a miss
//   missed   a url this board listed before and a COMPLETE fetch of the same board no longer lists (n = consecutive misses so far)
// Whether a posting is open or closed is derived downstream from these lines (scripts/atlas/lifecycle in the Jobsearch repo), with K and
// the time floor in a versioned config, so a change of K needs no change here. A failed, skipped, partial or suspect fetch is never a miss.
// An empty answer counts as complete only with the provider's positive empty signal (res.jobs.emptyOk).
//
// Files under <data>/lifecycle/:
//   state.json                  url -> [board that last listed it, last day seen (YYYY-MM-DD), consecutive misses]
//   events/<day>/ev-<ts>.jsonl  the cycle's lines, append-only, one file per cycle (never rewritten)
// The mode is read from MADE_LIFECYCLE: off (default) writes nothing. shadow records only and changes nothing else in the crawl.
// 'on' is reserved for the crawl's own K rule (stage 3, not implemented yet) and behaves like shadow.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const LIFECYCLE_VERSION = 'lifecycle_obs_v1';
const PRUNE_MISSES = 6, PRUNE_DAYS = 60;
// An answer of exactly a provider page cap is a truncated listing (live check 2026-11-23: SmartRecruiters boards answering 500 on every
// fetch while the postings beyond the cap stay live): never a complete answer, so it produces no misses.
export const PAGE_CAPS = new Set([100, 200, 250, 500, 1000, 2000, 5000, 10000]);

export function lifecycleMode(env = process.env) {
  const m = String(env.MADE_LIFECYCLE ?? 'off').trim().toLowerCase();
  return m === 'shadow' || m === 'on' ? m : 'off';
}

/** -> null when off, else a recorder {fetched, skippedOrFailed, flush, stats}. now() gives the cycle clock (tests pass their own). */
export function openLifecycle(dataDir, { mode = lifecycleMode(), now = () => new Date(), log = console.log } = {}) {
  if (mode === 'off') return null;
  if (mode === 'on') log('[lifecycle] mode on is not implemented in the crawl yet (stage 3); recording as shadow');
  const dir = resolve(dataDir, 'lifecycle');
  const stateFile = resolve(dir, 'state.json');
  let urls = {};
  try { urls = JSON.parse(readFileSync(stateFile, 'utf8')).urls ?? {}; } catch { /* first cycle, or unreadable: start empty (said below) */ }
  const byBoard = new Map();
  for (const [u, s] of Object.entries(urls)) (byBoard.get(s[0]) ?? byBoard.set(s[0], new Set()).get(s[0])).add(u);
  const started = now();
  const cycleTs = started.toISOString().replace(/[-:]/g, '').slice(0, 15);
  const lines = [];
  const stats = { fetches: 0, complete: 0, seen: 0, first: 0, missed: 0, urls_before: Object.keys(urls).length };
  log(`[lifecycle] start: mode ${mode}, ${stats.urls_before} urls in state${existsSync(stateFile) ? '' : ' (no state yet)'}`);
  const fid = (board, ts) => createHash('sha1').update(`${board}\n${ts}`).digest('hex').slice(0, 12);

  function fetchLine(board, meta, cls, jobs, complete, extra = {}) {
    const ts = now().toISOString();
    const fetch_id = fid(board, ts);
    lines.push({ ts, kind: 'fetch', board, provider: meta.provider ?? '', host: meta.host ?? '', cls, jobs, complete, fetch_id, v: LIFECYCLE_VERSION, ...extra });
    stats.fetches++; if (complete) stats.complete++;
    return { ts, fetch_id };
  }

  return {
    mode, stats,
    /** A board that was not fetched (circuit breaker) or failed: one fetch line, no url touched. */
    skippedOrFailed(board, meta, cls) { fetchLine(board, meta, cls, 0, false); },
    /** A board answered. listed = every url of the answer (before any filter); complete = the answer is the whole board. */
    fetched(board, meta, listed, { cls = 'OK', complete = true, emptyOk = false } = {}) {
      const set = listed instanceof Set ? listed : new Set(listed);
      const n = Number(meta?.jobs ?? set.size);
      const capped = complete && PAGE_CAPS.has(n);
      if (capped) complete = false;
      // the crawl's mass-drop guard counts only its 'open' rows; the same test over every url this board listed before marks the fetch
      // suspect (misses still recorded, flagged): the deriver decides how many suspect fetches in a row count (resilience.mjs GUARD)
      const prior = byBoard.get(board) ?? new Set();
      let keptPrior = 0; for (const u of prior) if (set.has(u)) keptPrior++;
      const suspect = complete && prior.size > 5 && keptPrior < 0.5 * prior.size && !emptyOk;
      const { ts, fetch_id } = fetchLine(board, meta, cls, set.size, complete,
        { ...(suspect ? { suspect: true, prior: prior.size, kept: keptPrior } : {}), ...(capped ? { capped: n } : {}) });
      const day = ts.slice(0, 10);
      for (const u of set) {
        const s = urls[u];
        if (!s) { lines.push({ ts, kind: 'seen', url: u, board, fetch_id, first: true }); stats.first++; stats.seen++; }
        else if (s[1] !== day || s[2] > 0) { lines.push({ ts, kind: 'seen', url: u, board, fetch_id, ...(s[2] > 0 ? { after_misses: s[2] } : {}) }); stats.seen++; }
        if (s && s[0] !== board) byBoard.get(s[0])?.delete(u);
        urls[u] = [board, day, 0];
        (byBoard.get(board) ?? byBoard.set(board, new Set()).get(board)).add(u);
      }
      if (!complete) return;
      for (const u of byBoard.get(board) ?? []) {
        if (set.has(u)) continue;
        const s = urls[u];
        s[2] += 1;
        lines.push({ ts, kind: 'missed', url: u, board, fetch_id, n: s[2], last_seen: s[1], ...(suspect ? { suspect: true } : {}) });
        stats.missed++;
      }
    },
    /** Write the cycle's lines and the state (atomic). dry = count only. */
    flush({ dry = false } = {}) {
      const today = now().toISOString().slice(0, 10);
      const cutoff = new Date(Date.parse(today) - PRUNE_DAYS * 864e5).toISOString().slice(0, 10);
      let pruned = 0;
      for (const [u, s] of Object.entries(urls)) if (s[2] >= PRUNE_MISSES && s[1] < cutoff) { delete urls[u]; pruned++; }
      if (dry) { log(`[lifecycle] dry run: ${lines.length} lines not written; ${JSON.stringify(stats)}`); return stats; }
      const evDir = resolve(dir, 'events', started.toISOString().slice(0, 10));
      mkdirSync(evDir, { recursive: true });
      if (lines.length) writeFileSync(resolve(evDir, `ev-${cycleTs}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const tmp = stateFile + '.tmp';
      writeFileSync(tmp, JSON.stringify({ v: LIFECYCLE_VERSION, at: now().toISOString(), urls }));
      renameSync(tmp, stateFile);
      Object.assign(stats, { lines: lines.length, pruned, urls_after: Object.keys(urls).length });
      log(`[lifecycle] result: ${JSON.stringify(stats)}`);
      return stats;
    },
  };
}
