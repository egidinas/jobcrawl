// Migration ledger (design §5.3): which board runs on which path, its parity history and whether it may move on.
//
// ledger.json (schema ledger/v1): { schema, updated, boards: { <board>: { provider, route, since, parity: [{ t, verdict, overlap }],
//   eligible, batch?, note? } } }
// A board is ELIGIBLE for the next step (legacy -> shadow is always allowed; shadow -> new needs this) when its last PASSES_NEEDED
// parity reports are all "pass" (or "empty" for a board that lists nothing on both paths) and none is older than MAX_AGE_H.
// Cut-over policy (owner 2026-11-27: "if it works we transition, no waiting, but no hurry either"): eligible boards move to "new" in
// batches, one provider family at a time; each batch is watched for one full cadence of its boards before the next; the kill switch
// (router.mjs) returns every board to legacy at once.
// Legacy deletion criteria (design §5.3): a legacy module is removed only when no board routes to a path that uses it, the ledger shows
// every board on "new" for 14 days without a kill-switch use, and the compatibility shims that re-export it have no importer left.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { routeFor } from './router.mjs';

export const LEDGER_SCHEMA = 'ledger/v1';
export const PASSES_NEEDED = 3;
export const MAX_AGE_H = 72;
const KEEP = 10;

export function loadLedger(file) {
  if (file && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  return { schema: LEDGER_SCHEMA, updated: null, boards: {} };
}

export function saveLedger(file, ledger) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 1));
  renameSync(tmp, file);
}

export function isEligible(parity = [], now = Date.now()) {
  const last = parity.slice(-PASSES_NEEDED);
  if (last.length < PASSES_NEEDED) return false;
  return last.every((p) => (p.verdict === 'pass' || p.verdict === 'empty') && now - Date.parse(p.t) <= MAX_AGE_H * 3600e3);
}

/** Adds one parity round to the ledger and refreshes every board's route from the routing config. */
export function recordParity(ledger, reports, routing, { now = new Date() } = {}) {
  const t = now.toISOString();
  for (const r of reports) {
    const b = (ledger.boards[r.board] ??= { provider: r.provider ?? null, route: 'legacy', since: t, parity: [] });
    b.provider = r.provider ?? b.provider;
    b.parity.push({ t, verdict: r.error ? 'error' : r.verdict, overlap: r.overlap ?? null });
    if (b.parity.length > KEEP) b.parity = b.parity.slice(-KEEP);
  }
  for (const [board, b] of Object.entries(ledger.boards)) {
    const { route } = routeFor(routing, { board, provider: b.provider });
    if (route !== b.route) { b.route = route; b.since = t; }
    b.eligible = isEligible(b.parity, now.getTime());
  }
  ledger.updated = t;
  return ledger;
}

/** Counts for a report line: { boards, legacy, shadow, new, eligible }. */
export function ledgerSummary(ledger) {
  const s = { boards: 0, legacy: 0, shadow: 0, new: 0, eligible: 0 };
  for (const b of Object.values(ledger.boards)) { s.boards++; s[b.route] = (s[b.route] ?? 0) + 1; if (b.eligible) s.eligible++; }
  return s;
}
