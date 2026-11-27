// Strangler-fig routing façade (design §5.3). Decides, per board, which path a board runs on:
//   legacy   crawler/crawl.mjs as today (the only path that writes the live history and feeds)
//   shadow   legacy stays authoritative; the new path ALSO runs for the board, into its own data dir, and only its output is compared
//   new      the new path is authoritative for the board (legacy skips it)
//
// routing.json (schema routing/v1):
//   { "schema": "routing/v1", "kill_switch": false, "default": "legacy",
//     "providers": { "greenhouse": "shadow" }, "boards": { "Stripe": "new" }, "allow_new": false }
// Precedence: kill switch -> board -> provider -> default. Global kill switch back to legacy: "kill_switch": true in the file, or the
// environment variable JOBCRAWL_ROUTE_KILL=1 (no file edit needed in an incident). "new" is honoured only with "allow_new": true, a
// second explicit switch set after the review of this façade; until then a board routed "new" runs as "shadow".
import { existsSync, readFileSync } from 'node:fs';

export const ROUTES = ['legacy', 'shadow', 'new'];
export const ROUTING_SCHEMA = 'routing/v1';

export function defaultRouting() {
  return { schema: ROUTING_SCHEMA, kill_switch: false, default: 'legacy', providers: {}, boards: {}, allow_new: false };
}

export function loadRouting(file) {
  if (!file || !existsSync(file)) return defaultRouting();
  const r = JSON.parse(readFileSync(file, 'utf8'));
  const errs = validateRouting(r);
  if (errs.length) throw new Error(`${file}: ${errs.join('; ')}`);
  return { ...defaultRouting(), ...r };
}

export function validateRouting(r) {
  const errs = [];
  if (!r || typeof r !== 'object') return ['not an object'];
  if (r.schema !== ROUTING_SCHEMA) errs.push(`schema must be "${ROUTING_SCHEMA}"`);
  if (r.default !== undefined && !ROUTES.includes(r.default)) errs.push(`default must be one of ${ROUTES.join(', ')}`);
  for (const k of ['providers', 'boards']) for (const [n, v] of Object.entries(r[k] ?? {})) if (!ROUTES.includes(v)) errs.push(`${k}.${n} must be one of ${ROUTES.join(', ')}`);
  if (r.kill_switch !== undefined && typeof r.kill_switch !== 'boolean') errs.push('kill_switch must be true or false');
  if (r.allow_new !== undefined && typeof r.allow_new !== 'boolean') errs.push('allow_new must be true or false');
  return errs;
}

/** The route of one board: { route, why }. */
export function routeFor(routing, { board, provider }, env = process.env) {
  if (env.JOBCRAWL_ROUTE_KILL === '1' || routing.kill_switch) return { route: 'legacy', why: 'kill switch' };
  let route = routing.default ?? 'legacy', why = 'default';
  if (provider && routing.providers?.[provider]) { route = routing.providers[provider]; why = `provider ${provider}`; }
  if (board && routing.boards?.[board]) { route = routing.boards[board]; why = `board ${board}`; }
  if (route === 'new' && !routing.allow_new) return { route: 'shadow', why: `${why} (new not allowed yet: allow_new is false)` };
  return { route, why };
}
