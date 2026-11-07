// Crawl policy: the rules every request of the crawler follows, in one place (owner, 2026-11-07: "keep ambitious with probing and be
// generous with pages, small print in robots.txt aside"). The commands that fetch from employer sites (crawl, detail-backfill,
// cc-harvest, ats-resolve, discover) install the guard (installGuard) over globalThis.fetch, so the providers' own requests pass
// through it; the career-site profiler applies the same rules in its network layer (profiler/net.mjs).
//
// HARD RULES (no setting turns them off):
//   * Never log in. A login, sign-in or authentication URL is never requested (noFetchReason), and neither is a URL with credentials
//     in it. Redirects of GET requests are followed hop by hop by the guard, so a redirect into a login page stops before that page
//     is requested. A URL that answers 401 or 407 (or a redirect into a login page) is recorded in <data>/auth-walls.json and never
//     requested again. No credentials or tokens are added to any request.
//   * deeplist.tech: its /api and its login pages are never requested (the owner's account there is not used for crawling).
//   * Explicit opt-outs: hosts listed in crawl.opt_out_hosts (e.g. a terms page that forbids automated access to job data) are never
//     requested. A response with the TDM reservation header (tdm-reservation: 1, W3C TDMRep) flags its host for the owner in
//     <data>/optout-flags.json and the host is not requested again until the owner lists it in crawl.opt_out_cleared.
//   * HTTP 429 and 503 put the host on a cooldown (Retry-After in seconds or as a date, else 30 s for 429 and 10 s for 503). Every
//     later request to that host waits the cooldown out, or fails at once when more than 20 s are left.
//   * Crawl-delay (robots.txt, the group naming the crawler's user-agent token, else "*") is a floor between two request starts to
//     that host, in both robots modes. A request that would wait more than 60 s for its slot fails instead of queueing.
// robots.txt Disallow (crawl.robots): "advisory" (the default) fetches the URL anyway and logs it (<data>/robots-audit.jsonl, a
// count per host in the cycle notes); "strict" refuses it (RobotsError). crawl.robots_hosts sets the mode per host (and subdomains).
// robots.txt is read once per origin and kept for 24 hours in <data>/robots-cache.json. A robots.txt that answers 5xx counts as
// "disallow everything" (RFC 9309), any other failure as "no rules".
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UA } from './useragent.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class PolicyError extends Error {}
export class RobotsError extends PolicyError {}
export class NoFetchError extends PolicyError {}
export class CooldownError extends PolicyError {}

export const MAX_COOLDOWN_WAIT_MS = 20000;
export const MAX_SLOT_WAIT_MS = 60000;
const ROBOTS_TTL_MS = 24 * 36e5;
const AUDIT_LINES_PER_HOST = 50;     // per process; the count in the notes is complete

// ---------- robots.txt ----------

/** robots.txt -> { rules: [{ allow, path }], delay } for the first group naming `token`, else the "*" group. */
export function parseRobots(txt, token) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [], delay: 0 }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (k === 'disallow' && v) cur.rules.push({ allow: false, path: v });
    else if (k === 'allow' && v) cur.rules.push({ allow: true, path: v });
    else if (k === 'crawl-delay' && Number(v) > 0) cur.delay = Number(v);
  }
  const t = String(token).toLowerCase();
  const g = groups.find((x) => x.agents.some((a) => a !== '*' && t.includes(a))) ?? groups.find((x) => x.agents.includes('*'));
  return g ? { rules: g.rules, delay: g.delay } : { rules: [], delay: 0 };
}
const ruleRe = (p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
/** Is path (pathname + search) allowed by parsed robots rules? Longest match wins, Allow on a tie. */
export function robotsAllows(robots, path) {
  let best = null;
  for (const r of robots?.rules ?? []) {
    if (!ruleRe(r.path).test(path)) continue;
    const len = r.path.replace(/\*/g, '').length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

/** The product token robots.txt groups are matched against: "MADE-jobs-crawler" from "Mozilla/5.0 (compatible; MADE-jobs-crawler; +...)". */
export const uaToken = () => UA.match(/compatible;\s*([^;)]+)/)?.[1]?.trim() ?? 'jobcrawl';

// ---------- configuration and state ----------

const fresh = () => ({
  mode: 'advisory', hosts: [], optOut: [], cleared: [], dataDir: null, base: null,
  robots: new Map(), robotsDisk: null, robotsDirty: false,
  nextSlot: new Map(), cooldown: new Map(),
  authWalls: {}, authDirty: false, optFlags: {}, optDirty: false,
  auditByHost: new Map(),
  stats: { robots_disallowed_fetched: 0, robots_refused: 0, no_fetch: 0, cooldown_waits: 0, cooldown_fails: 0, slot_waits: 0, slot_fails: 0, auth_walls: 0, optout_flags: 0 },
  noFetchByReason: {},
});
let st = fresh();

const normHost = (h) => String(h ?? '').toLowerCase().replace(/^\*?\./, '').replace(/\.$/, '');
const hostMatch = (host, key) => { host = normHost(host); key = normHost(key); return !!key && (host === key || host.endsWith('.' + key)); };
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const file = (name) => (st.dataDir ? join(st.dataDir, name) : null);

/**
 * robots: 'advisory' | 'strict'; robotsHosts: { host: 'advisory'|'strict' }; optOutHosts: [host | { host, reason }];
 * optOutCleared: [host] (flags the owner reviewed); dataDir: where the audit, caches and flags live (none: memory only).
 */
export function configurePolicy({ robots = 'advisory', robotsHosts = {}, optOutHosts = [], optOutCleared = [], dataDir = null } = {}) {
  flushPolicy();
  st = fresh();
  if (robots !== 'advisory' && robots !== 'strict') throw new Error(`crawl.robots must be "advisory" or "strict", not ${JSON.stringify(robots)}`);
  st.mode = robots;
  st.hosts = Object.entries(robotsHosts ?? {}).map(([host, mode]) => ({ host: normHost(host), mode }));
  st.optOut = (optOutHosts ?? []).map((o) => (typeof o === 'string' ? { host: normHost(o), reason: 'listed in crawl.opt_out_hosts' } : { host: normHost(o.host), reason: o.reason || 'listed in crawl.opt_out_hosts' }));
  st.cleared = (optOutCleared ?? []).map(normHost);
  st.dataDir = dataDir;
  if (dataDir) {
    st.authWalls = readJson(file('auth-walls.json'), {});
    st.optFlags = readJson(file('optout-flags.json'), {});
    const audit = file('robots-audit.jsonl');
    try { if (statSync(audit).size > 20e6) renameSync(audit, `${audit}.1`); } catch { /* none yet */ }
  }
  return st;
}

/** configurePolicy options from a loaded profile (profile.mjs) and the data folder. */
export const policyFromProfile = (profile, dataDir) => ({
  robots: profile?.robots ?? 'advisory', robotsHosts: profile?.robotsHosts ?? {}, optOutHosts: profile?.optOutHosts ?? [],
  optOutCleared: profile?.optOutCleared ?? [], dataDir,
});

/** The robots mode for a host: the most specific crawl.robots_hosts entry, else crawl.robots. */
export function robotsModeFor(host) {
  const hit = st.hosts.filter((h) => hostMatch(host, h.host)).sort((a, b) => b.host.length - a.host.length)[0];
  return hit?.mode ?? st.mode;
}

/** Writes the robots cache, the auth walls and the opt-out flags (called at exit too). */
export function flushPolicy() {
  if (!st.dataDir || !(st.robotsDirty || st.authDirty || st.optDirty)) return;
  try {
    mkdirSync(st.dataDir, { recursive: true });
    if (st.robotsDirty && st.robotsDisk) { writeFileSync(file('robots-cache.json'), JSON.stringify(st.robotsDisk)); st.robotsDirty = false; }
    if (st.authDirty) { writeFileSync(file('auth-walls.json'), JSON.stringify(st.authWalls, null, 1)); st.authDirty = false; }
    if (st.optDirty) { writeFileSync(file('optout-flags.json'), JSON.stringify(st.optFlags, null, 1)); st.optDirty = false; }
  } catch (e) { console.error(`policy: could not write the policy state in ${st.dataDir}: ${e.message}`); }
}
process.on('exit', () => flushPolicy());

// ---------- the never-fetch rules ----------

// A path segment that is a login, sign-in or authentication page (exact segment, so a job titled "Login Specialist" is not one).
const LOGIN_SEGMENT = /^(?:log-?in|log-?on|sign-?in|sign_in|sign-?on|sso|saml2?|oauth2?|openid(?:-connect)?|auth|authenticate|authorize|wp-login\.php|wp-admin|my-?account|candidate-?login|user-?login)(?:\.\w{1,5})?$/i;

/** Why a URL must not be requested, or null. Pure apart from the recorded auth walls and the opt-out lists. */
export function noFetchReason(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (u.username || u.password) return 'credentials in the URL';
  if (hostMatch(host, 'deeplist.tech') && /^\/(?:api|login|log-in|signin|sign-in|signup|sign-up|auth|account|dashboard)(?:[/?#.]|$)/i.test(u.pathname)) {
    return 'deeplist.tech /api and login are never used';
  }
  let segs = [];
  try { segs = u.pathname.split('/').map((s) => decodeURIComponent(s)); } catch { segs = u.pathname.split('/'); }
  if (segs.some((s) => LOGIN_SEGMENT.test(s))) return 'a login or authentication page';
  const wall = st.authWalls[u.origin + u.pathname];
  if (wall) return `behind a login (${wall.why}, seen ${wall.at})`;
  const opt = st.optOut.find((o) => hostMatch(host, o.host));
  if (opt) return `explicit opt-out: ${opt.reason}`;
  const flagged = Object.entries(st.optFlags).find(([h]) => hostMatch(host, h));
  if (flagged && !st.cleared.some((c) => hostMatch(host, c))) return `flagged for the owner: ${flagged[1].signal} (seen ${flagged[1].at}); list the host in crawl.opt_out_cleared to crawl it`;
  return null;
}

function refuse(url, why) {
  st.stats.no_fetch++;
  const key = why.replace(/ \(seen.*$/, '').replace(/^explicit opt-out: .*/, 'explicit opt-out').replace(/^flagged for the owner: .*/, 'flagged for the owner');
  st.noFetchByReason[key] = (st.noFetchByReason[key] ?? 0) + 1;
  return new NoFetchError(`not fetched: ${url} (${why})`);
}

function recordAuthWall(u, why) {
  const key = u.origin + u.pathname;
  if (st.authWalls[key]) return;
  st.authWalls[key] = { why, at: new Date().toISOString().slice(0, 10) };
  st.authDirty = true;
  st.stats.auth_walls++;
}

function flagOptOut(host, signal, url) {
  if (st.optFlags[host] || st.cleared.some((c) => hostMatch(host, c))) return;
  st.optFlags[host] = { signal, url, at: new Date().toISOString().slice(0, 10) };
  st.optDirty = true;
  st.stats.optout_flags++;
}

// ---------- rate rules ----------

/** Retry-After as seconds (a number of seconds or an HTTP date), or null. */
export function retryAfterSeconds(v, now = Date.now()) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, Math.ceil((t - now) / 1000));
}

/** Milliseconds the host still asks us to wait (after a 429 or 503), 0 when none. */
export function cooldownLeftMs(host, now = Date.now()) { return Math.max(0, (st.cooldown.get(normHost(host)) ?? 0) - now); }

function setCooldown(host, seconds) {
  host = normHost(host);
  st.cooldown.set(host, Math.max(st.cooldown.get(host) ?? 0, Date.now() + seconds * 1000));
}

async function waitCooldown(host, url) {
  const left = cooldownLeftMs(host);
  if (!left) return;
  if (left > MAX_COOLDOWN_WAIT_MS) { st.stats.cooldown_fails++; throw new CooldownError(`not fetched: ${url} (${host} asked to wait ${Math.ceil(left / 1000)} s more after HTTP 429/503)`); }
  st.stats.cooldown_waits++;
  await sleep(left);
}

/** Reserve the host's next request slot, gapMs after the previous one (the Crawl-delay floor). */
export async function pace(host, gapMs, url = host) {
  host = normHost(host);
  const now = Date.now();
  const at = Math.max(now, st.nextSlot.get(host) ?? 0);
  if (at - now > MAX_SLOT_WAIT_MS) { st.stats.slot_fails++; throw new CooldownError(`not fetched: ${url} (Crawl-delay ${gapMs / 1000} s of ${host}: no request slot within ${MAX_SLOT_WAIT_MS / 1000} s)`); }
  st.nextSlot.set(host, at + gapMs);
  if (at > now) { st.stats.slot_waits++; await sleep(at - now); }
}

// ---------- robots ----------

function robotsDisk() {
  if (!st.robotsDisk) st.robotsDisk = file('robots-cache.json') ? readJson(file('robots-cache.json'), {}) : {};
  return st.robotsDisk;
}

/** Parsed robots.txt of an origin ({ rules, delay, status }), read once per origin and process (and cached for 24 h on disk). */
export function robotsFor(origin, fetchImpl = st.base ?? globalThis.fetch) {
  if (!st.robots.has(origin)) {
    st.robots.set(origin, (async () => {
      const disk = robotsDisk()[origin];
      if (disk && Date.now() - disk.t < ROBOTS_TTL_MS) return disk;
      let r;
      try {
        const res = await fetchImpl(`${origin}/robots.txt`, { headers: { 'user-agent': UA, accept: 'text/plain,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
        if (res.status >= 500) r = { rules: [{ allow: false, path: '/' }], delay: 0, status: res.status };
        else if (!res.ok) r = { rules: [], delay: 0, status: res.status };
        else r = { ...parseRobots((await res.text()).slice(0, 500000), uaToken()), status: res.status };
      } catch { r = { rules: [], delay: 0, status: 0 }; }
      r.t = Date.now();
      if (r.status) { robotsDisk()[origin] = r; st.robotsDirty = true; }
      return r;
    })());
  }
  return st.robots.get(origin);
}

/** Logs a request robots.txt disallows that is made anyway (advisory mode). who: the caller (provider, profiler, rmk). */
export function auditRobots(url, who = '') {
  let u;
  try { u = new URL(url); } catch { return; }
  st.stats.robots_disallowed_fetched++;
  const n = (st.auditByHost.get(u.hostname) ?? 0) + 1;
  st.auditByHost.set(u.hostname, n);
  if (n > AUDIT_LINES_PER_HOST || !st.dataDir) return;
  try { appendFileSync(file('robots-audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), host: u.hostname, url: u.href, who, mode: 'advisory' }) + '\n'); } catch { /* the count still reaches the notes */ }
}

/**
 * The robots decision for one URL: { allowed, delayMs }. Disallowed in strict mode: throws RobotsError. Disallowed in advisory mode:
 * logged, and allowed. robots.txt itself is always allowed.
 */
export async function robotsCheck(url, who = '', fetchImpl) {
  const u = new URL(url);
  if (u.pathname === '/robots.txt') return { allowed: true, delayMs: 0 };
  const rb = await robotsFor(u.origin, fetchImpl);
  const delayMs = (rb.delay || 0) * 1000;
  if (robotsAllows(rb, u.pathname + u.search)) return { allowed: true, delayMs };
  if (robotsModeFor(u.hostname) === 'strict') { st.stats.robots_refused++; throw new RobotsError(`robots.txt disallows ${url}`); }
  auditRobots(url, who);
  return { allowed: true, disallowed: true, delayMs };
}

/** After a response: cooldown on 429/503, auth walls, the TDM opt-out flag. Returns a reason to refuse the response, or null. */
export function checkResponse(url, res) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (res.status === 429 || res.status === 503) setCooldown(u.hostname, retryAfterSeconds(res.headers.get('retry-after')) ?? (res.status === 429 ? 30 : 10));
  if (res.status === 401 || res.status === 407) recordAuthWall(u, `HTTP ${res.status}`);
  if (String(res.headers.get('tdm-reservation') ?? '').trim() === '1' && !st.cleared.some((c) => hostMatch(u.hostname, c))) {
    flagOptOut(u.hostname.toLowerCase(), 'tdm-reservation: 1 (TDMRep header)', u.href);
    return `${u.hostname} reserves text and data mining (tdm-reservation: 1); flagged for the owner`;
  }
  return null;
}

// ---------- the guard ----------

/** A fetch that applies every rule above around `base`. */
export function makeGuard(base) {
  st.base = base;
  return async function guardedFetch(input, init = {}) {
    const isReq = typeof input !== 'string' && !(input instanceof URL);
    const url = isReq ? input?.url ?? String(input) : String(input);
    let u;
    try { u = new URL(url); } catch { return base(input, init); }
    if (!/^https?:$/.test(u.protocol)) return base(input, init);
    const method = String(init.method ?? (isReq ? input.method : 'GET') ?? 'GET').toUpperCase();
    const manual = !isReq && (init.redirect ?? 'follow') === 'follow' && (method === 'GET' || method === 'HEAD');
    let cur = u, hops = 0;
    for (;;) {
      const why = noFetchReason(cur.href);
      if (why) {
        if (hops && /login|authentication/.test(why)) recordAuthWall(u, `redirects to a login page (${cur.host}${cur.pathname})`);
        throw refuse(cur.href, hops ? `redirect from ${url}: ${why}` : why);
      }
      await waitCooldown(cur.hostname, cur.href);
      const { delayMs } = await robotsCheck(cur.href, 'crawl', base);
      if (delayMs > 0) await pace(cur.hostname, delayMs, cur.href);
      const res = await base(hops || !isReq ? cur.href : input, manual ? { ...init, redirect: 'manual' } : init);
      const bad = checkResponse(cur.href, res);
      if (bad) { try { await res.body?.cancel(); } catch { /* nothing to drop */ } throw refuse(cur.href, bad); }
      const loc = manual && res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc) {
        if (hops) Object.defineProperty(res, 'redirected', { value: true });
        return res;
      }
      if (++hops > 10) throw new Error(`too many redirects from ${url}`);
      try { await res.body?.cancel(); } catch { /* nothing to drop */ }
      cur = new URL(loc, cur);
    }
  };
}

let installed = null;
/** Wraps globalThis.fetch with the guard (once). Returns a function that removes it. */
export function installGuard() {
  if (installed) return installed;
  const base = globalThis.fetch;
  globalThis.fetch = makeGuard(base);
  installed = () => { globalThis.fetch = base; installed = null; };
  return installed;
}

// ---------- reporting ----------

export const policyStats = () => ({ ...st.stats, mode: st.mode });

/** Lines for the cycle's notes: what robots.txt disallowed and was fetched anyway, refusals, waits, flags for the owner. */
export function policySummary() {
  const s = st.stats, out = [];
  if (s.robots_disallowed_fetched) {
    const top = [...st.auditByHost.entries()].sort((a, b) => b[1] - a[1]);
    out.push(`robots.txt (advisory): ${s.robots_disallowed_fetched} requests to disallowed paths made anyway on ${top.length} hosts: ${top.slice(0, 10).map(([h, n]) => `${h} ${n}`).join(', ')}${top.length > 10 ? `, and ${top.length - 10} more` : ''}${st.dataDir ? ' (robots-audit.jsonl)' : ''}`);
  }
  if (s.robots_refused) out.push(`robots.txt (strict): ${s.robots_refused} requests refused`);
  if (s.no_fetch) out.push(`not fetched by policy: ${Object.entries(st.noFetchByReason).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (s.cooldown_waits || s.cooldown_fails) out.push(`HTTP 429/503 cooldowns: ${s.cooldown_waits} requests waited, ${s.cooldown_fails} gave up (Retry-After longer than ${MAX_COOLDOWN_WAIT_MS / 1000} s)`);
  if (s.slot_waits || s.slot_fails) out.push(`Crawl-delay: ${s.slot_waits} requests waited for their slot, ${s.slot_fails} gave up (no slot within ${MAX_SLOT_WAIT_MS / 1000} s)`);
  if (s.auth_walls) out.push(`login walls: ${s.auth_walls} new URLs answered 401/407 or redirected to a login page; never requested again (auth-walls.json)`);
  const flags = Object.entries(st.optFlags);
  if (flags.length) out.push(`OPT-OUT FLAGS for the owner (not crawled): ${flags.map(([h, f]) => `${h} (${f.signal}, ${f.at})`).join(', ')}`);
  return out;
}

/** Test helper: forget all state (configuration, caches, counters). */
export function resetPolicy() { st = fresh(); if (installed) installed(); }
