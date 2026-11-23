// Crawl resilience: a triage class for every failed board fetch, and a per-provider circuit breaker (2026-11-21, crawl_resilience).
//
// classifyError(err) -> { cls, code, detail }   cls is one of
//   DNS         name does not resolve (ENOTFOUND, EAI_AGAIN)
//   TIMEOUT_TLS timeout, refused/reset connection, TLS or certificate failure
//   WAF         HTTP 403 or 429 (and 503 with Retry-After): a bot wall or a rate limit
//   HTTP_4XX    other 4xx (code in `code`)
//   MOVED       HTTP 404/410, a 3xx or a redirect loop: the board URL is probably dead or relocated
//   HTTP_5XX    5xx (code in `code`)
//   PARSE       the answer arrived but is not what the provider reads (not JSON, no listing, schema)
//   POLICY      refused by the crawl policy (opt-out, login page, robots strict, cooldown too long)
//   CONFIG      the entry itself is unusable (no supported ATS, bad slug)
//   OTHER       anything else (message kept in detail)
// EMPTY_OK is not an error: an answer with 0 jobs, counted by the caller.
//
// Breaker: when at least 50 % (minimum 3) of one provider's boards, among those tried in a cycle, fail with the same class, the rest
// of that provider is skipped for 1, 2, 4, 8 cycles (a trip while the provider is still failing doubles; a clean cycle resets).
// State in <data>/provider-breaker.json. The alert is ONE flag file (CRAWL_PROVIDER_DOWN.flag) in the health folder, same
// "<timestamp> <what is down>" shape as DOWN.flag, removed when no provider is open any more.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const msgOf = (e) => String(e?.message ?? e ?? '');
const tail = (s) => String(s).replace(/\s+/g, ' ').slice(0, 160);

export function classifyError(err) {
  const msg = msgOf(err);
  const cause = err?.cause;
  const ccode = String(cause?.code ?? err?.code ?? '');
  const cmsg = msgOf(cause);
  const cname = err?.constructor?.name ?? '';
  if (/^(?:Robots|NoFetch|Cooldown|Policy)Error$/.test(cname)) return { cls: 'POLICY', code: cname, detail: tail(msg) };
  if (/no supported ATS|bad slug|needs url and kind|slug must be/i.test(msg)) return { cls: 'CONFIG', code: '', detail: tail(msg) };
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(ccode + cmsg + msg)) return { cls: 'DNS', code: ccode || 'ENOTFOUND', detail: tail(cmsg || msg) };
  const http = msg.match(/HTTP (\d{3})\b/);
  if (http) {
    const n = Number(http[1]);
    if (n === 403 || n === 429 || (n === 503 && /Retry-After/i.test(msg))) return { cls: 'WAF', code: n, detail: tail(msg) };
    if (n === 404 || n === 410 || (n >= 300 && n < 400)) return { cls: 'MOVED', code: n, detail: tail(msg) };
    if (n >= 500) return { cls: 'HTTP_5XX', code: n, detail: tail(msg) };
    if (n >= 400) return { cls: 'HTTP_4XX', code: n, detail: tail(msg) };
  }
  if (/redirect/i.test(msg) && !/Timed out/.test(msg)) return { cls: 'MOVED', code: 'redirect', detail: tail(msg) };
  const net = ccode + ' ' + cmsg + ' ' + msg + ' ' + (err?.name ?? '');
  if (/Timed out|timeout|aborted|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|UND_ERR|certificate|CERT_|TLS|SSL|socket|EPIPE|terminated/i.test(net)) {
    return { cls: 'TIMEOUT_TLS', code: ccode || (/Timed out|timeout|abort/i.test(net) ? 'timeout' : ''), detail: tail(cmsg || msg) };
  }
  if (/^fetch failed$/i.test(msg.trim())) return { cls: 'TIMEOUT_TLS', code: ccode || 'fetch failed', detail: tail(cmsg || msg) };
  if (/JSON|Unexpected token|parse|schema|no listing|unexpected|is not (?:an? )?(?:array|object)|undefined|Cannot read|is not iterable|no postings|no job/i.test(msg) || err instanceof SyntaxError || err instanceof TypeError) {
    return { cls: 'PARSE', code: '', detail: tail(msg) };
  }
  return { cls: 'OTHER', code: '', detail: tail(msg) };
}

export const hostOf = (entry, slug) => {
  for (const s of [entry?.careers_url, entry?.list?.url, entry?.api, slug]) {
    try { if (s && /^https?:/i.test(s)) return new URL(s).hostname; } catch { /* next */ }
  }
  return '';
};

const BACKOFF = [1, 2, 4, 8];
// Providers whose boards live on arbitrary hosts (one board is one site): the breaker is per provider AND host there.
const GENERIC = new Set(['jsonld_direct', 'paginated_list', 'sitemap']);
// Providers that never trip it: EURES has its own slow lane (answers come from lane files), usajobs is deferred.
const EXEMPT = new Set(['eures', 'usajobs']);

export function makeBreaker({ dataDir, healthDir, dryRun = false, log = console.log } = {}) {
  const file = dataDir ? join(dataDir, 'provider-breaker.json') : null;
  const flagFile = join(healthDir ?? process.env.MADE_HEALTH_DIR ?? join(homedir(), 'atlas', 'health'), 'CRAWL_PROVIDER_DOWN.flag');
  let state = { cycle: 0, providers: {} };
  try { if (file && existsSync(file)) state = JSON.parse(readFileSync(file, 'utf8')); } catch { /* fresh */ }
  state.providers ??= {};
  state.cycle = (state.cycle ?? 0) + 1;
  const cycle = state.cycle;
  const run = new Map();   // key -> { tried, ok, fails: {cls: n}, skipped, tripped }
  const keyOf = (provider, host) => (GENERIC.has(provider) ? `${provider}@${host || '?'}` : provider);
  const r = (k) => run.get(k) ?? run.set(k, { tried: 0, ok: 0, fails: {}, skipped: 0, tripped: null }).get(k);

  return {
    cycle,
    /** true: the breaker of this provider is open this cycle, skip the board (counted, never a failure) */
    shouldSkip(provider, host) {
      if (EXEMPT.has(provider)) return false;
      const k = keyOf(provider, host), s = state.providers[k], x = r(k);
      if (x.tripped || (s && cycle <= s.open_until)) { x.skipped++; return true; }
      return false;
    },
    /** records one board outcome; returns the breaker key when the failures now qualify for a trip (then confirm and commit()) */
    record(provider, host, ok, triage) {
      if (EXEMPT.has(provider)) return null;
      const k = keyOf(provider, host), x = r(k);
      if (ok) { x.tried++; x.ok++; return null; }
      const cls = triage?.cls ?? 'OTHER';
      if (cls === 'CONFIG' || cls === 'POLICY') return null;   // says nothing about the provider
      x.tried++;
      x.fails[cls] = (x.fails[cls] ?? 0) + 1;
      const n = x.fails[cls];
      if (!x.tripped && !x.pending && n >= 3 && n / x.tried >= 0.5) { x.pending = { cls, triage, host, n, tried: x.tried }; return k; }   // a candidate: the caller confirms it, then commit()
      return null;
    },
    /**
     * Second look at a candidate (record() returned its key): the caller retries one failed board after a pause and says whether it still
     * fails the same way. A burst of connect timeouts from this host's own network load (several providers at once) is no provider outage:
     * not confirmed = no trip and the count of that class starts again.
     */
    commit(k, stillFailing) {
      const x = r(k), pend = x.pending; x.pending = null;
      if (!pend) return;
      if (!stillFailing) { x.fails[pend.cls] = 0; log(`[breaker] ${k}: ${pend.n} of ${pend.tried} boards failed with ${pend.cls}, but the retry answered: no trip (transient)`); return; }
      const level = Math.min(4, (state.providers[k]?.level ?? 0) + 1), wait = BACKOFF[level - 1];
      x.tripped = { cls: pend.cls, level, wait };
      state.providers[k] = { level, cls: pend.cls, tripped_cycle: cycle, open_until: cycle + wait, tripped_at: new Date().toISOString(), example: pend.triage?.detail ?? '', code: pend.triage?.code ?? '', host: pend.host };
      log(`[breaker] ${k}: ${pend.n} of ${pend.tried} boards failed with ${pend.cls}${pend.triage?.code ? ` ${pend.triage.code}` : ''}, the retry failed too; the rest are skipped for ${wait} cycle(s) (level ${level})`);
    },
    /** end of the run: providers that ran clean after their backoff reset; writes the state and the flag file */
    finish() {
      for (const [k, x] of run) {
        const s = state.providers[k];
        if (s && !x.tripped && x.tried >= 1 && x.ok / x.tried >= 0.5 && cycle > s.open_until) { delete state.providers[k]; log(`[breaker] ${k}: recovered (${x.ok} of ${x.tried} boards ok), breaker closed`); }
      }
      const open = Object.entries(state.providers).filter(([, s]) => cycle <= s.open_until);
      const skipped = [...run].filter(([, x]) => x.skipped).map(([k, x]) => `${k} ${x.skipped}`).join(', ');
      if (dryRun || !file) { log(`[breaker] dry run: state and flag not written${open.length ? `; would flag ${open.map(([k]) => k).join(', ')}` : ''}`); return { open, skipped }; }
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1) + '\n'); renameSync(`${file}.tmp`, file);
      try {
        if (open.length) {
          mkdirSync(join(flagFile, '..'), { recursive: true });
          const what = open.map(([k, s]) => `${k}: ${s.cls}${s.code ? ' ' + s.code : ''}, skipped until cycle ${s.open_until} (level ${s.level}; ${s.example})`).join(' | ');
          writeFileSync(flagFile, `${new Date().toISOString()} crawl provider down (circuit breaker) ${what}\n`);
        } else if (existsSync(flagFile)) rmSync(flagFile, { force: true });
      } catch (e) { log(`[breaker] flag file ${flagFile}: ${e.message}`); }
      return { open, skipped };
    },
  };
}

// ---------- liveness guard (2026-11-21) ----------
// A board that had more than MIN_OPEN open roles and now answers with fewer than half of them (or none), without a positive empty-OK
// signal (jobs.emptyOk === true, set by a provider that read an explicit "no openings" answer), is treated as a failed fetch: its roles
// stay open and the board is counted (class SUSPECT_DROP). Only CONFIRM consecutive such fetches close them, so one bad answer from a
// provider that swallows an error cannot make roles vanish. State per board in <data>/liveness-guard.json.
export const GUARD = { MIN_OPEN: 5, KEEP_RATIO: 0.5, CONFIRM: 3 };
/** state: { board: { n, at, open, kept } } (mutated). Returns { hold, n, confirmed } for this fetch of `board`. */
// An answer of exactly one of these sizes is a provider's page or result cap, not a whole board (live check 2026-11-23: SmartRecruiters
// boards answering exactly 500 on every fetch while the postings beyond it stayed live). crawl.mjs reads such an answer as partial: nothing
// it does not list is marked gone, and the posting lifecycle records no miss for it.
export const CAPPED_COUNTS = new Set([500, 1000, 2000, 5000, 10000]);
export const isCappedAnswer = (n) => CAPPED_COUNTS.has(Number(n));

export function livenessGuard(state, board, openCount, keptCount, { emptyOk = false, date = '' } = {}) {
  const suspect = openCount > GUARD.MIN_OPEN && keptCount < GUARD.KEEP_RATIO * openCount && !emptyOk;
  if (!suspect) { delete state[board]; return { hold: false, n: 0, confirmed: false }; }
  const g = (state[board] ??= { n: 0 });
  g.n++; g.at = date; g.open = openCount; g.kept = keptCount;
  if (g.n < GUARD.CONFIRM) return { hold: true, n: g.n, confirmed: false };
  delete state[board];
  return { hold: false, n: g.n, confirmed: true };
}
