// Hide only by the admitting board (2026-11-25, FEED_DROPS.md): the one rule for who may hide or close a role that several boards list.
//
// The crawl history is keyed by URL, and two boards often list the same URL: two entries on one ATS tenant (a site whitelist on one,
// all sites on the other), or an aggregator and the employer's own board. Before this rule the last board to run decided: a whitelist
// or an aggregator's "shadowed by the employer ATS" verdict hid a role that the other board had just admitted, and the next run of that
// board brought it back (Leonardo 397 -> 3 -> 394, ESA 120 -> 19 -> 122 on 24 Nov).
//
// The rule. A board ADMITS a role when it lists the URL and its own filters keep it (the row is or becomes open or dup). Per URL this
// module keeps the boards that admitted it and when each last did so. A board that is not an admitting board may hide the role
// (filtered, extra) or close it (gone) only when no other board has admitted it within ADMIT_HOLD_H hours. An admitting board itself
// hides and closes exactly as before:
//   * its own hide withdraws its admission;
//   * a complete answer of it that no longer lists the URL withdraws its admission before any board of the cycle is processed
//     (withdrawFromAnswers), so a role the admitting board says is gone is closed exactly when it would have been without this rule.
// Never touched: the policy verdicts in POLICY_VERDICTS (the profile's hard location block), the 3-day sweep, the lifecycle's own
// close rule, cross-listing duplicates (different URLs), and everything the board build decides later (noise employers, overrides,
// the scope cut, the US cap, the catalogue blocklist).
//
// State: <data>/admit-state.json { v, at, boards: [name], urls: { url: [[board index, ms], ...] } }, written atomically, entries older
// than ADMIT_HOLD_H dropped on save. No state yet (first run after the deploy) or an unreadable file: the open and dup rows of the history
// are seeded as admitted by the board that last listed them (lifecycle state, when the lifecycle records it) or else by the board their
// company names, at their last sighting. Older code ignores the file, so a rollback needs nothing.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ADMIT_HOLD_H = 48;
export const ADMIT_VERSION = 1;
// R3: a fallback prints ONE line per case and run that both watchers count: the live pattern `step failed|continuing with` and the batch
// form `[degraded] <stage>/<step>: <reason> (1)`.
export const oneLine = (m) => String(m ?? '').split(/\r?\n/)[0].slice(0, 160);
export const degraded = (reason) => `[degraded] crawl/admission: ${reason} (1)`;
// verdicts that are policy, not a board's own view: they hide whatever any other board admitted
export const POLICY_VERDICTS = new Set(['blocked-location']);
// the guard's test (resilience.mjs GUARD) for an answer that lost most of what the board had admitted: such an answer withdraws nothing
const SUSPECT_MIN = 5, SUSPECT_KEEP = 0.5;

/** The board a history row belongs to by its company: "X (via Board)" -> Board, else the company itself. */
export const boardOfCompany = (company = '') => {
  const m = String(company).match(/\(via ([^)]*)\)\s*$/);
  return m ? m[1] : String(company);
};

/**
 * -> admissions {admit, mayHide, mayClose, withdrawFromAnswers, summaryLine, save, stats}. now: ms of the cycle clock.
 * history: Map url -> row (only read, for the seed). lifecycleState: { url: [board, day, misses, ms] } or null.
 */
export function openAdmissions(dataDir, { now = Date.now(), history = new Map(), lifecycleState = null, log = console.log } = {}) {
  const file = resolve(dataDir, 'admit-state.json');
  const holdMs = ADMIT_HOLD_H * 3600e3;
  const urls = new Map();   // url -> Map(board -> ms)
  const stats = { blockedHide: 0, blockedClose: 0, withdrawn: 0, seeded: 0, errors: 0 };
  const pairs = new Map();   // "hider > holder" -> count
  let loaded = false;
  try {
    if (existsSync(file)) {
      const s = JSON.parse(readFileSync(file, 'utf8'));
      if (s?.v !== ADMIT_VERSION || !Array.isArray(s.boards) || typeof s.urls !== 'object') throw new Error('unknown format');
      for (const [u, list] of Object.entries(s.urls)) {
        const m = new Map();
        for (const [bi, ms] of list) if (s.boards[bi] && Number.isFinite(ms)) m.set(s.boards[bi], ms);
        if (m.size) urls.set(u, m);
      }
      loaded = true;
    }
  } catch (e) {
    log(degraded(`admit-state.json unreadable (${oneLine(e.message)}), continuing with a fresh seed from the history`));
  }
  if (!loaded) {
    // first run (or a lost file): every open or dup row counts as admitted by the board that last listed it, at that time
    let fromLc = 0, fromCompany = 0;
    if (typeof lifecycleState === 'function') {
      try { lifecycleState = lifecycleState(); } catch (e) { lifecycleState = null; log(degraded(`lifecycle state unreadable (${oneLine(e.message)}), continuing with a seed by company name`)); }
    }
    for (const row of history.values()) {
      try {
        if (row.status !== 'open' && row.status !== 'dup') continue;
        const s = lifecycleState?.[row.url];
        let board, ms;
        if (s && s[0]) { board = s[0]; ms = Number.isFinite(s[3]) ? s[3] : Date.parse(`${s[1]}T23:59:59Z`); fromLc++; }
        else { board = boardOfCompany(row.company); ms = Date.parse(`${row.last_seen}T23:59:59Z`); fromCompany++; }
        if (!board || !Number.isFinite(ms)) continue;
        urls.set(row.url, new Map([[board, Math.min(ms, now)]]));
      } catch { stats.errors++; }
    }
    stats.seeded = fromLc + fromCompany;
    log(`[admission] no state yet: ${stats.seeded} open roles seeded as admitted (${fromLc} by the board that last listed them, ${fromCompany} by the board their company names)`);
  }
  const fresh = (ms) => now - ms < holdMs;
  /** another board than `board` whose admission of `url` is fresh, or null */
  const otherHolder = (url, board) => {
    const m = urls.get(url);
    if (!m) return null;
    for (const [b, ms] of m) if (b !== board && fresh(ms)) return b;
    return null;
  };
  const count = (hider, holder) => { const k = `${hider} > ${holder}`; pairs.set(k, (pairs.get(k) ?? 0) + 1); };
  const withdraw = (url, board) => { const m = urls.get(url); if (m?.delete(board)) { stats.withdrawn++; if (!m.size) urls.delete(url); return true; } return false; };
  // withdrawals of this cycle per board: a board whose own answer dropped the URL is an admitting board saying it is gone
  const saidGone = new Map();

  return {
    stats,
    /** `board` listed `url` and its filters keep it. */
    admit(url, board) {
      try { (urls.get(url) ?? urls.set(url, new Map()).get(url)).set(board, now); } catch { stats.errors++; }
    },
    /**
     * `board` would hide `url` (verdict `why`; extra when why is empty). -> null when the hide may go ahead, else the board that holds it.
     * The board's own admission is withdrawn either way. A policy verdict always goes ahead, and so does any hide of a row that is not
     * open or dup (visible = false: nothing to keep). An error lets the hide go ahead (as before).
     */
    mayHide(url, board, why, visible = true) {
      try {
        withdraw(url, board);
        if (!visible || POLICY_VERDICTS.has(why)) return null;
        const h = otherHolder(url, board);
        if (h) { stats.blockedHide++; count(board, h); }
        return h;
      } catch { stats.errors++; return null; }
    },
    /** `board`'s complete answer lacks `url`, an open row it owns by company. -> null when it may close, else the holder. */
    mayClose(url, board) {
      try {
        if (saidGone.get(board)?.has(url)) return null;   // an admitting board says it is gone: exactly as before
        const h = otherHolder(url, board);
        if (h) { stats.blockedClose++; count(board, h); }
        return h;
      } catch { stats.errors++; return null; }
    },
    /**
     * Before the boards are processed: every complete answer withdraws its board's admissions of the URLs it no longer lists, unless
     * the answer lost more than half of them (a suspect answer, the liveness guard's own test), which withdraws nothing.
     * answers: [{ board, listed: Set(url), complete: bool, emptyOk: bool }]
     */
    withdrawFromAnswers(answers) {
      const byBoard = new Map();
      for (const [u, m] of urls) for (const b of m.keys()) (byBoard.get(b) ?? byBoard.set(b, []).get(b)).push(u);
      for (const a of answers) {
        try {
          if (!a.complete) continue;
          const mine = byBoard.get(a.board) ?? [];
          const gone = mine.filter((u) => !a.listed.has(u));
          if (!gone.length) continue;
          if (mine.length > SUSPECT_MIN && mine.length - gone.length < SUSPECT_KEEP * mine.length && !a.emptyOk) continue;
          const s = saidGone.get(a.board) ?? saidGone.set(a.board, new Set()).get(a.board);
          for (const u of gone) { withdraw(u, a.board); s.add(u); }
        } catch { stats.errors++; }
      }
    },
    /** The URLs `board` admitted and its complete answer of this cycle no longer lists (withdrawFromAnswers). */
    saidGone(board) { return saidGone.get(board) ?? new Set(); },
    /** One notes line per run (R3): hides and closes kept back, per board pair (hider > admitting board), largest first. */
    summaryLine() {
      const top = [...pairs].sort((a, b) => b[1] - a[1]);
      const n = stats.blockedHide + stats.blockedClose;
      const list = top.slice(0, 15).map(([k, v]) => `${k} ${v}`).join(', ');
      const more = top.length > 15 ? ` (and ${top.length - 15} more pairs, ${top.slice(15).reduce((t, [, v]) => t + v, 0)} roles)` : '';
      return `hides kept back (another board admitted the role within ${ADMIT_HOLD_H} h): ${n ? `${stats.blockedHide} hides, ${stats.blockedClose} closes, by board pair (hider > admitting board): ${list}${more}` : 'none'}` +
        `${stats.withdrawn ? `; ${stats.withdrawn} admissions withdrawn` : ''}`;
    },
    /** R3: one watcher-counted line when rule calls failed this run (each went ahead as before), else null. */
    degradedLine() {
      return stats.errors ? degraded(`${stats.errors} rule call(s) failed, continuing with the hides and closes as before`) : null;
    },
    /** Write the state (atomic), dropping admissions older than the hold. */
    save() {
      const boards = [], idx = new Map(), out = {};
      for (const [u, m] of urls) {
        const list = [];
        for (const [b, ms] of m) {
          if (!fresh(ms)) continue;
          if (!idx.has(b)) { idx.set(b, boards.length); boards.push(b); }
          list.push([idx.get(b), ms]);
        }
        if (list.length) out[u] = list;
      }
      writeFileSync(`${file}.tmp`, JSON.stringify({ v: ADMIT_VERSION, at: new Date(now).toISOString(), hold_h: ADMIT_HOLD_H, boards, urls: out }));
      renameSync(`${file}.tmp`, file);
    },
  };
}
