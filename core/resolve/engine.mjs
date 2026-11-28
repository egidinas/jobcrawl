// The cross-board resolver (design §3.3, row 1.4): the four pieces of logic that assume one cycle sees every board, ported from the
// legacy crawl (crawler/crawl.mjs scan(), crawler/admission.mjs, crawler/crosslist.mjs) onto per-board event streams. Pure: no I/O,
// no clock of its own (every decision takes the event time or the `now` it is given), so a replay and a crash-resume decide the same.
//
// Input: per-board records in global event_id order (delta/v1 plus the store's seq-null 'refreshed' records), each with the facts the
// events do not carry (facts.mjs: employer name, description fingerprint, apply links, the board's own keep/hide verdict).
// State: one MEMBER per (board, posting id): what that board last said about the posting; one GROUP per posting id: the posting across
// boards, with its admissions (board -> last listing in ms) and its resolved status. Output: resolved/v1 records (status transitions).
//
// Resolved status of a group (legacy row status in brackets):
//   open      a board lists it and keeps it [open]
//   dup       an open cross-listing of another open group (crosslist.mjs isCrossListing) [dup]
//   hidden    listed only by boards whose filters hide it (hide: 'extra' | 'filtered') [extra / filtered]
//   departed  no board lists it any more and no other board admitted it within the hold [gone]
//   unknown   (lifecycle rules only) nothing listed it for UNKNOWN_DAYS and no evidence closes it [unknown]
//
// Ported rules, each pinned by a test (core/tests/resolver.test.mjs):
//   admission  only the admitting board may hide or close a role another board admitted within ADMIT_HOLD_H (48 h). A board admits when
//              it lists the posting and keeps it; its own hide or a complete miss (board state misses >= 1) withdraws its admission.
//   crosslist  a new or reopened open group is a dup of the FIRST open group (arrival order) that isCrossListing() matches; a direct
//              posting swaps over an aggregator original (the aggregator copy becomes the dup); every run also sweeps all open
//              aggregator groups against the open direct groups (the legacy startup sweep). A dup group closes only in the sweep, and
//              takes over (becomes open again) when its original is no longer open.
//   sweep      a group nothing confirmed for SWEEP_DAYS (day granularity, as the legacy `last_seen < cutoff`) with status open, dup or
//              hidden/extra is departed (rules 'legacy', today's live mode MADE_LIFECYCLE=shadow); with rules 'lifecycle' only on the
//              K-miss + floor evidence, else 'unknown' after UNKNOWN_DAYS (lifecycle.mjs D1: never a close).
//   protected  derived employer set (relevance.mjs): catalogue names, employers named "(via <industry aggregator>)" in any member,
//              tracked non-probation non-aggregator entries, employers the industry aggregator boards list right now.
import { isCrossListing, isAggregatorRow, isAggregatorEntry, canonTitle, rowPostingKeys, setApplyKeys } from '../../crawler/crosslist.mjs';
import { protectedFromHistory, makeEmployerIndex, INDUSTRY_AGGREGATOR_PROVIDERS } from '../../crawler/relevance.mjs';
import { postingKey } from '../../crawler/postingkey.mjs';
import { canonicalKey } from '../id.mjs';

export const RESOLVED_SCHEMA = 'resolved/v1';
export const ADMIT_HOLD_H = 48;
export const SWEEP_DAYS = 3;
export const K_MISSES = 3, FLOOR_H = 24, UNKNOWN_DAYS = 14;
export const RULES = Object.freeze({ legacy: 'legacy', lifecycle: 'lifecycle' });
const HOLD_MS = ADMIT_HOLD_H * 3600e3;
const DAY = 864e5;
const ms = (t) => (typeof t === 'number' ? t : Date.parse(t));
const day = (t) => new Date(ms(t)).toISOString().slice(0, 10);

/** The apply links of a description that name an ATS posting (the URLs textPostingKeys reads), at most 5: stored instead of the text. */
export function applyUrls(text) {
  const out = [];
  for (const raw of String(text ?? '').match(/https?:\/\/[^\s)\]>"'<]+/g) ?? []) {
    const u = raw.replace(/[.,;]+$/, '');
    if (postingKey(u) && !out.includes(u)) { out.push(u); if (out.length >= 5) break; }
  }
  return out;
}

/**
 * Creates a resolver over a state (or a fresh one). config: { companies: [registry entries], catalogue: [names], rules: 'legacy'|'lifecycle' }.
 * Returns { state, apply(record, facts), boardOk(board, t, view), tick(now), drain(), dirty(), protectedEmployers(), groupOf(id), stats }.
 */
export function createResolver(state = null, config = {}) {
  const st = state ?? { v: 1, seq: 0, ord: 0, members: {}, groups: {} };
  const rules = config.rules === RULES.lifecycle ? RULES.lifecycle : RULES.legacy;
  const companies = config.companies ?? [];
  const boardNames = new Set(companies.filter(isAggregatorEntry).map((c) => c.name));
  const providerOf = new Map(companies.map((c) => [c.name, c.provider ?? null]));
  const out = [];                       // resolved records not yet drained
  const dirtyG = new Set(), dirtyM = new Set();
  const stats = { records: 0, ignored: 0, dupMarked: 0, swaps: 0, takeovers: 0, swept: 0, unknown: 0, blockedHide: 0, blockedClose: 0, withdrawn: 0, suspectAlias: 0 };
  const mk = (board, id) => `${board}\u0000${id}`;
  // legacy row objects per group (crosslist.mjs keeps apply keys in a WeakMap keyed by the row object): built on demand, cached
  const rows = new Map();

  // ---- members and groups ----
  const membersOf = (g) => g.members.map((b) => st.members[mk(b, g.id)]).filter(Boolean);
  function group(id) {
    let g = st.groups[id];
    if (!g) { g = st.groups[id] = { id, status: null, members: [], adm: {}, ord: ++st.ord, dup_of: null, first_open: null, last_change: null }; dirtyG.add(id); }
    return g;
  }
  function rowOf(g) {
    const m = rep(g);
    if (!m) return null;
    let r = rows.get(g.id);
    if (!r || r.url !== m.url || r.company !== m.company || r.title !== m.title || r.location !== m.location || r._ak !== (m.ak ?? []).join(' ')) {
      r = { url: m.url, company: m.company, title: m.title, location: m.location, _ak: (m.ak ?? []).join(' '), fp: m.fp ?? '' };
      if (r._ak && isAggregatorRow(r, boardNames)) setApplyKeys(r, r._ak);
      rows.set(g.id, r);
    }
    return r;
  }
  /** The member that speaks for the group: the earliest listed open-and-kept one, else the earliest open, else the earliest. */
  function rep(g) {
    const ms_ = membersOf(g);
    const by = (a, b) => (a.first_seen < b.first_seen ? -1 : a.first_seen > b.first_seen ? 1 : a.board < b.board ? -1 : 1);
    return ms_.filter((m) => m.status === 'open' && m.kept).sort(by)[0] ?? ms_.filter((m) => m.status === 'open').sort(by)[0] ?? ms_.sort(by)[0] ?? null;
  }
  const isAgg = (g) => { const r = rowOf(g); return r ? isAggregatorRow(r, boardNames) : false; };
  const indexed = (g) => { const r = rowOf(g); return Boolean(r && (r.fp || rowPostingKeys(r).length)); };

  /** The boards that list the posting now (member open), sorted: the `boards` of a resolved record. */
  const listing = (g) => membersOf(g).filter((m) => m.status === 'open').map((m) => m.board).sort();
  function emit(g, op, t, extra = {}) {
    if (op !== 'changed') g.boards_sig = listing(g).join('');
    const m = rep(g);
    out.push({ schema: RESOLVED_SCHEMA, seq: ++st.seq, t: new Date(ms(t)).toISOString(), op, id: g.id, status: g.status,
      boards: listing(g), admitting: Object.keys(g.adm).sort(),
      ...(g.dup_of ? { dup_of: g.dup_of } : {}),
      ...(m ? { url: m.url, title: m.title, company: m.company, location: m.location || undefined, first_seen: g.first_open ?? m.first_seen, ...(m.ex ? { excerpt: m.ex } : {}) } : {}),
      ...extra });
  }

  // ---- admission (admission.mjs) ----
  const fresh = (g, now) => Object.entries(g.adm).filter(([, t]) => ms(now) - t < HOLD_MS).map(([b]) => b);
  function admit(g, board, t) { if (g.adm[board] !== ms(t)) { g.adm[board] = Math.max(g.adm[board] ?? 0, ms(t)); dirtyG.add(g.id); } }
  function withdraw(g, board) { if (board in g.adm) { delete g.adm[board]; stats.withdrawn++; dirtyG.add(g.id); return true; } return false; }

  /** The status the members and admissions say, before the dup overlay (see the header). */
  function baseStatus(g, now) {
    const ms_ = membersOf(g);
    const holders = new Set(fresh(g, now));
    const openKept = ms_.filter((m) => m.status === 'open' && m.kept);
    if (openKept.some((m) => holders.has(m.board))) return { s: 'open' };
    // a board that kept it but has not listed it within the hold (not read since): it stays open unless another board's later verdict
    // (its own hide or close) came after that board's last listing; that later verdict goes ahead, as in the legacy crawl
    const lastKept = Math.max(-Infinity, ...openKept.map((m) => ms(m.last_seen)));
    const later = ms_.filter((m) => !(m.status === 'open' && m.kept) && ms(m.vt ?? m.last_seen) > lastKept);
    if (openKept.length && !later.length) return { s: 'open' };
    const hiddenM = ms_.filter((m) => m.status === 'open' && !m.kept).sort((a, b) => ms(b.vt ?? b.last_seen) - ms(a.vt ?? a.last_seen));
    if (hiddenM.length) return { s: 'hidden', hide: hiddenM[0].hide ?? 'filtered' };
    if (ms_.some((m) => m.status === 'unknown')) return { s: 'unknown' };
    return { s: 'departed' };
  }

  function setStatus(g, s, t, extra = {}) {
    const prev = g.status;
    if (prev === s) return false;
    g.status = s; g.last_change = new Date(ms(t)).toISOString(); dirtyG.add(g.id);
    let op = s;   // dup | hidden | departed | unknown
    if (s === 'open') {
      op = g.first_open == null ? 'added' : prev === 'dup' ? 'undup' : 'reappeared';
      if (g.first_open == null) g.first_open = g.last_change;
    }
    emit(g, op, t, extra.why ? { reason: extra.why } : {});
    return true;
  }

  // ---- crosslist (crawl.mjs findOriginal / startup sweep / takeover) ----
  const byKey = new Map(), byTok = new Map();   // over open, indexed groups; rebuilt lazily
  let indexValid = false;
  const keyOf = (k) => `${k.vendor}|${k.id}`;
  function rebuildIndex() {
    byKey.clear(); byTok.clear();
    for (const g of Object.values(st.groups)) if (g.status === 'open' && indexed(g)) addToIndex(g);
    indexValid = true;
  }
  function addToIndex(g) {
    const r = rowOf(g);
    for (const k of rowPostingKeys(r)) { const x = keyOf(k); (byKey.get(x) ?? byKey.set(x, new Set()).get(x)).add(g.id); }
    if (r.fp) for (const tk of new Set(canonTitle(r.title).split(' ').filter(Boolean))) (byTok.get(tk) ?? byTok.set(tk, new Set()).get(tk)).add(g.id);
  }
  function candidates(g, onlyDirect = false) {
    if (!indexValid) rebuildIndex();
    const r = rowOf(g);
    const cand = new Set();
    for (const k of rowPostingKeys(r)) for (const id of byKey.get(keyOf(k)) ?? []) cand.add(id);
    if (r.fp) {
      // titleMatch needs token Jaccard >= 0.8: the floor(0.2 n) + 1 rarest tokens of this title include one any matching title has
      const toks = [...new Set(canonTitle(r.title).split(' ').filter(Boolean))].sort((x, y) => (byTok.get(x)?.size ?? 0) - (byTok.get(y)?.size ?? 0));
      for (const tk of toks.slice(0, Math.floor(0.2 * toks.length) + 1)) for (const id of byTok.get(tk) ?? []) cand.add(id);
    }
    cand.delete(g.id);
    const list = [...cand].map((id) => st.groups[id]).filter((o) => o && o.status === 'open' && (!onlyDirect || !isAgg(o)));
    return list.sort((a, b) => a.ord - b.ord);   // legacy openIndex order: the first match wins
  }
  function findOriginal(g) {
    const r = rowOf(g);
    if (!r || !(r.fp || rowPostingKeys(r).length)) return null;
    for (const o of candidates(g)) { const ro = rowOf(o); if (ro.url !== r.url && isCrossListing(r.fp, r, ro.fp, ro, boardNames)) return o; }
    return null;
  }
  /** g is about to be (or stay) open: the legacy new-row / relisted-dup rule. Returns the status it gets. */
  function crosslist(g, t) {
    const orig = findOriginal(g);
    if (orig && isAgg(orig) && !isAgg(g)) {             // the employer's own posting replaces the aggregator copy
      orig.dup_of = g.id; setStatus(orig, 'dup', t, { why: 'aggregator copy of a direct posting' }); stats.swaps++;
      return { s: 'open' };
    }
    if (orig) return { s: 'dup', of: orig.id };
    return { s: 'open' };
  }

  /** Recomputes one group's status at time t (an event time, or the tick's now). */
  function recompute(g, t, why) {
    const b = baseStatus(g, t);
    if (b.s === 'open') {
      if (g.swept && !membersOf(g).some((m) => ms(m.last_seen) > g.swept)) return;   // swept: only a new listing reopens it
      if (g.swept) { delete g.swept; dirtyG.add(g.id); }
      if (g.status === 'open') { if (indexValid && indexed(g)) addToIndex(g); return; }   // a changed title or text adds its new keys
      if (g.status === 'dup') {
        const o = st.groups[g.dup_of];
        if (o && o.status === 'open') return;            // the original is still open: stays a dup
      }
      // legacy: only a new row and a relisted dup are matched against the open rows; a filtered, extra or gone row that is kept again
      // turns open directly (an aggregator one is caught by the next sweep)
      // a seeded group whose recorded verdict is 'open' (facts.verdict at the baseline epoch: the legacy row was open) is adopted as is,
      // like the legacy crawl, which never re-matches a row it already holds
      const adoptOpen = g.status === null && g.adopt === 'open';
      const c = (g.status === null && !adoptOpen) || g.status === 'dup' ? crosslist(g, t) : { s: 'open' };
      if (c.s === 'dup') { const was = g.status; g.dup_of = c.of; if (setStatus(g, 'dup', t, { why: 'cross-listing' })) stats.dupMarked++; else if (was === 'dup') dirtyG.add(g.id); return; }
      const wasDup = g.status === 'dup';
      g.dup_of = null;
      if (setStatus(g, 'open', t, { why }) && wasDup) stats.takeovers++;
      if (indexValid && indexed(g)) addToIndex(g);   // the index only grows; candidates() skips groups that are no longer open
      return;
    }
    // legacy: dup and extra rows are not closed by a board's miss (only open rows are); the 3-day sweep retires them
    // and a filtered row is never closed at all
    if (b.s === 'departed' && (g.status === 'dup' || g.status === 'hidden')) return;
    if (g.swept && g.status === 'departed' && b.s !== 'open') return;
    const wasOpen = g.status === 'open';
    if (b.s === 'hidden') { g.hide = b.hide; }
    if (setStatus(g, b.s, t, { why })) { if (g.status !== 'dup') g.dup_of = null; }
    void wasOpen;
  }

  /** A visible group whose set of listing boards changed without a status change: a 'changed' record (design §3.3: a posting that leaves
   *  board A and stays on board B is changed, not departed). */
  function boardsChanged(g, t) {
    if (g.status !== 'open' && g.status !== 'dup') return;
    const sig = listing(g).join('');
    if (g.boards_sig === undefined) { g.boards_sig = sig; return; }
    if (sig === g.boards_sig) return;
    emit(g, 'changed', t, { fields: ['boards'] });
    g.boards_sig = sig; dirtyG.add(g.id);
  }

  // ---- input ----
  function upsertMember(rec, f, status) {
    const p = rec.posting ?? {};
    const id = rec.id;
    const key = mk(rec.board, id);
    const prev = st.members[key];
    const url = p.url ?? prev?.url ?? '';
    if (prev && prev.url && url && prev.url !== url) {
      // 1.1 risk: two postings that share a normalised URL can resolve to one id across runs (a false 'reappeared'). Two different
      // strong posting keys under one id are flagged on the resolved record and counted; the id is kept (it is a stored fact).
      const a = canonicalKey(prev.url), b = canonicalKey(url);
      if (a !== b && a.startsWith('pk:') && b.startsWith('pk:')) { stats.suspectAlias++; rec._suspect = 'shared-url'; }
    }
    const m = st.members[key] = {
      board: rec.board, id, url,
      title: p.title ?? prev?.title ?? '', location: p.jobLocation?.[0]?.address?.name ?? prev?.location ?? '',
      posted: p.datePosted ?? prev?.posted ?? '',
      first_seen: prev?.first_seen ?? p.jobcrawl?.first_seen ?? rec.t,
      last_seen: status === 'open' ? (maxT(prev?.last_seen, p.jobcrawl?.last_seen ?? rec.t)) : (prev?.last_seen ?? p.jobcrawl?.last_seen ?? rec.t),
      status, misses: 0,
      company: f.company ?? prev?.company ?? rec.board,
      fp: f.fp ?? prev?.fp ?? '',
      ex: p.jobcrawl?.excerpt ?? prev?.ex,
      ak: f.applyText != null ? applyUrls(f.applyText) : (prev?.ak ?? []),
      kept: f.kept !== false,
      hide: f.kept === false ? (f.hide ?? 'filtered') : undefined,
      vt: rec.t,
    };
    if (!m.ak.length) delete m.ak;
    if (!m.ex) delete m.ex;
    if (m.hide === undefined) delete m.hide;
    dirtyM.add(key);
    const g = group(id);
    if (!g.members.includes(rec.board)) { g.members.push(rec.board); dirtyG.add(id); }
    rows.delete(id);
    return { m, g };
  }
  const maxT = (a, b) => (!a ? b : !b ? a : ms(a) >= ms(b) ? a : b);

  /**
   * Applies one per-board record (delta/v1 or a store 'refreshed' record) with its facts ({ company, fp, applyText, kept, hide }).
   * board-ok needs the board's view (boardOk below) and board-failed changes nothing.
   */
  function apply(rec, f = {}) {
    stats.records++;
    const t = rec.t;
    switch (rec.op) {
      case 'added': case 'reappeared': case 'changed': {
        const { m, g } = upsertMember(rec, f, 'open');
        if (m.kept) admit(g, rec.board, t);
        else {
          const held = fresh(g, t).filter((b) => b !== rec.board);
          withdraw(g, rec.board);
          if (held.length && (g.status === 'open' || g.status === 'dup')) stats.blockedHide++;
        }
        recompute(g, t, rec.op === 'changed' ? 'changed' : undefined);
        if (rec._suspect && g.status) emit(g, 'changed', t, { suspect: rec._suspect });
        else if (rec.op === 'changed' && (g.status === 'open' || g.status === 'dup')) emit(g, 'changed', t, { fields: rec.fields });
        boardsChanged(g, t);
        return;
      }
      case 'refreshed': {
        const s = rec.posting?.jobcrawl?.status;
        const status = s === 'departed' ? 'departed' : s === 'unknown' ? 'unknown' : 'open';
        const { g } = upsertMember(rec, f, status);
        if (status === 'open' && f.kept !== false) admit(g, rec.board, t);
        recompute(g, t);
        return;
      }
      case 'departed': case 'unknown': {
        const key = mk(rec.board, rec.id);
        const m = st.members[key];
        if (!m) { stats.ignored++; return; }
        m.status = rec.op; m.vt = t; if (rec.last_seen) m.last_seen = maxT(m.last_seen, rec.last_seen); m.misses = rec.misses ?? m.misses;
        dirtyM.add(key);
        const g = group(rec.id);
        const held = fresh(g, t).filter((b) => b !== rec.board);
        withdraw(g, rec.board);
        if (held.length && g.status === 'open') stats.blockedClose++;
        recompute(g, t);
        boardsChanged(g, t);
        return;
      }
      default: stats.ignored++;
    }
  }

  /**
   * A successful read of `board` at t. view: Map(id -> { last_seen, misses, status }) of the board's committed postings (the store's
   * postings rows). Listed postings refresh their last sighting and the board's admission; a posting a complete answer lacked
   * (misses >= 1) withdraws the board's admission, as the legacy withdrawFromAnswers does at the first complete miss.
   */
  function boardOk(board, t, view) {
    if (!view) return;
    const touched = new Set();
    for (const [id, v] of view) {
      const key = mk(board, id);
      const m = st.members[key];
      if (!m) continue;
      const g = st.groups[id];
      if (!g) continue;
      if (m.status === 'open' && v.last_seen && ms(v.last_seen) > ms(m.last_seen)) {
        m.last_seen = v.last_seen; dirtyM.add(key);
        if (m.kept) admit(g, board, v.last_seen);
        touched.add(g);
      }
      if (m.status === 'open' && (v.misses ?? 0) >= 1 && m.misses !== v.misses) {
        m.misses = v.misses; dirtyM.add(key);
        withdraw(g, board); touched.add(g);
      }
    }
    for (const g of touched) recompute(g, t);
  }

  /**
   * Facts that arrive late: a description read after the listing (a lazy detail fetch, an enrichment) gives a fingerprint or apply links
   * the arrival lacked. For every member of an open or dup group that still lacks them, facts are asked again (op 'refresh'); a newly
   * known fingerprint feeds later matches against this group and the aggregator sweep, as the legacy crawl's index reads the saved
   * descriptions every cycle. The group's own arrival decision is not re-taken (the legacy rule).
   */
  function refresh(factsFn, t) {
    if (typeof factsFn !== 'function') return 0;
    let n = 0;
    for (const g of Object.values(st.groups)) {
      if (g.status !== 'open' && g.status !== 'dup') continue;
      for (const m of membersOf(g)) {
        if (m.fp && m.ak) continue;
        const f = factsFn({ board: m.board, id: m.id, op: 'refresh', t, posting: { url: m.url, title: m.title } }) ?? {};
        let changed = false;
        if (!m.fp && f.fp) { m.fp = f.fp; changed = true; }
        if (!m.ak && f.applyText) { const ak = applyUrls(f.applyText); if (ak.length) { m.ak = ak; changed = true; } }
        if (changed) { n++; dirtyM.add(mk(m.board, m.id)); rows.delete(g.id); if (g.status === 'open' && indexValid) addToIndex(g); }
      }
    }
    return n;
  }

  /**
   * End of a resolver run at `now`: hold expiry, takeovers whose original left, the cross-listing sweep of open aggregator groups, and the
   * 3-day sweep. Idempotent for one `now`.
   */
  function tick(now) {
    const t = ms(now);
    // admissions older than the hold are dropped (admission.mjs save()); a group whose last holder expired is recomputed
    for (const g of Object.values(st.groups)) {
      let changed = false;
      for (const [b, x] of Object.entries(g.adm)) if (t - x >= HOLD_MS) { delete g.adm[b]; changed = true; }
      if (changed) { dirtyG.add(g.id); recompute(g, t); }
    }
    // takeover: a dup whose original is no longer open
    for (const g of Object.values(st.groups)) {
      if (g.status !== 'dup') continue;
      const o = st.groups[g.dup_of];
      if (!o || o.status !== 'open') recompute(g, t, 'original left');
    }
    // startup sweep: every open aggregator group against the open direct groups
    for (const g of Object.values(st.groups)) {
      if (g.status !== 'open' || !isAgg(g) || !indexed(g)) continue;
      const r = rowOf(g);
      for (const o of candidates(g, true)) {
        if (isCrossListing(r.fp, r, rowOf(o).fp, rowOf(o), boardNames)) { g.dup_of = o.id; setStatus(g, 'dup', t, { why: 'cross-listing sweep' }); stats.dupMarked++; break; }
      }
    }
    // 3-day sweep (crawl.mjs end of scan): day granularity, as the legacy string compare. config.sweep === false turns it off (a replay
    // whose boards are not read every day)
    if (config.sweep === false) return;
    const cutoff = day(t - SWEEP_DAYS * DAY);
    for (const g of Object.values(st.groups)) {
      if (!(g.status === 'open' || g.status === 'dup' || (g.status === 'hidden' && g.hide === 'extra'))) continue;
      const ms_ = membersOf(g);
      const last = ms_.reduce((a, m) => maxT(a, m.last_seen), null);
      if (!last || day(last) >= cutoff) continue;
      if (rules === RULES.legacy) { g.swept = t; setStatus(g, 'departed', t, { why: 'sweep' }); stats.swept++; continue; }
      const closable = ms_.some((m) => (m.misses ?? 0) >= K_MISSES && t - ms(m.last_seen) >= FLOOR_H * 3600e3);
      if (closable) { g.swept = t; setStatus(g, 'departed', t, { why: 'sweep' }); stats.swept++; }
      else if (t - ms(last) >= UNKNOWN_DAYS * DAY && g.status !== 'unknown') { g.swept = t; setStatus(g, 'unknown', t, { why: 'sweep' }); stats.unknown++; }
    }
  }

  /** The derived protected employer set (relevance.mjs makeEmployerIndex over the four sources), as an index with has(name). */
  function protectedEmployers() { return makeEmployerIndex(protectedNames()); }
  /** The input names of the protected set, deduplicated (stored as the derived set). */
  function protectedNames() {
    const names = [...(config.catalogue ?? [])];
    names.push(...protectedFromHistory(Object.values(st.members)));
    names.push(...companies.filter((c) => !c.probation && !isAggregatorEntry(c)).map((c) => c.name));
    for (const m of Object.values(st.members)) if (m.status === 'open' && INDUSTRY_AGGREGATOR_PROVIDERS.has(providerOf.get(m.board)) && m.company) names.push(m.company);
    return [...new Set(names.filter(Boolean))].sort();
  }

  return {
    state: st, stats, rules,
    apply, boardOk, tick, refresh,
    /** Seeds a member from a stored posting record (bootstrap from an imported store: a baseline epoch, no resolved records). */
    seed(board, id, rec, f = {}, t = rec.last_seen) {
      const status = rec.status === 'departed' ? 'departed' : rec.status === 'unknown' ? 'unknown' : 'open';
      const { m, g } = upsertMember({ board, id, t, posting: { url: rec.url, title: rec.title, datePosted: rec.posted, jobLocation: rec.location ? [{ address: { name: rec.location } }] : undefined, jobcrawl: { first_seen: rec.first_seen, last_seen: rec.last_seen } } }, f, status);
      m.first_seen = rec.first_seen ?? m.first_seen; m.last_seen = rec.last_seen ?? m.last_seen; m.misses = rec.misses ?? 0;
      if (status === 'open' && m.kept) admit(g, board, m.last_seen);
      if (f.verdict === 'open' || f.verdict === 'dup') { g.adopt = g.adopt === 'open' ? 'open' : f.verdict; dirtyG.add(g.id); }
      return g;
    },
    /** After seeding: computes every seeded group's status silently (the baseline epoch emits nothing). */
    settleSeed(now) {
      const ids = Object.keys(st.groups).filter((id) => st.groups[id].status === null)
        .sort((a, b) => (rep(st.groups[a])?.first_seen ?? '').localeCompare(rep(st.groups[b])?.first_seen ?? '') || (a < b ? -1 : 1));
      for (const id of ids) recompute(st.groups[id], now);
      for (const id of ids) delete st.groups[id].adopt;
      tick(now);
      out.length = 0;
    },
    drain() { return out.splice(0); },
    pending: () => out.length,
    dirty() { const r = { groups: [...dirtyG], members: [...dirtyM] }; dirtyG.clear(); dirtyM.clear(); return r; },
    protectedEmployers, protectedNames,
    groupOf: (id) => st.groups[id] ?? null,
    memberOf: (board, id) => st.members[mk(board, id)] ?? null,
    repOf: (id) => (st.groups[id] ? rep(st.groups[id]) : null),
    boardNames,
  };
}
