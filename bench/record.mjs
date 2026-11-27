#!/usr/bin/env node
// Benchmark recording run (design §3.5 and §6, phase 0.4): reads every enabled board of a companies file ONCE through the normal source
// code and the normal crawl policy, and stores what came back for offline replay:
//   <out>/objects/ab/<sha256>.gz     each response body once, gzipped
//   <out>/index/<day>.jsonl          one line per response: t, board, provider, url, method, status, ct, wire bytes (content-length),
//                                    decoded bytes, content-encoding, etag, last-modified, cache-control, sha256, probe flag
//   <out>/lists/<board key>.json.gz  the parsed list of each board (url, title, location, postedAt, description hash) + completeness
//   <out>/boards.jsonl               one line per board: ok, class, jobs, requests, bytes, ms (also the resume record)
//   <out>/summary.json               totals per provider, rewritten at every progress line and at the end
// Conditional probe: for each board, the first GET answered 200 with an ETag or Last-Modified is asked again with If-None-Match /
// If-Modified-Since right after the board is read. 304 = the server honours validators; 200 = it does not (then the body hash shows
// whether the content jittered between the two reads). One probe per board; at least one per host for every host with validators.
//
// It never touches a live crawl: its own out dir holds the policy state (robots cache, auth walls), the sitemap page cache (seeded from a
// COPY of the live cache with --seed-cache, so per-posting sources read like a normal cycle instead of a first fill) and everything else.
// Stops cleanly: no new board after --stop-at, everything ends at --hard-stop (logged), and when free disk under --out drops below
// --min-free-gb. Resumable: boards already in boards.jsonl are skipped.
//
//   node bench/record.mjs --profile <dir> --companies <file> --out <dir> [--log <file>] [--concurrency 8] [--host-concurrency 2]
//        [--host-gap-ms 500] [--exclude eures,usajobs] [--stop-at ISO] [--hard-stop ISO] [--min-free-gb 45] [--seed-cache <dir>]
//        [--limit N] [--dry-run]
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const flag = (n) => args.includes(`--${n}`);
const USAGE = 'usage: node bench/record.mjs --profile <dir> --companies <file> --out <dir> [--log <file>] [--concurrency 8] [--host-concurrency 2] '
  + '[--host-gap-ms 500] [--exclude eures,usajobs] [--stop-at ISO] [--hard-stop ISO] [--min-free-gb 45] [--seed-cache <dir>] [--limit N] [--dry-run]';
if (flag('help') || flag('h') || !opt('profile') || !opt('companies') || !opt('out')) { console.log(USAGE); process.exit(flag('help') || flag('h') ? 0 : 2); }

// Imports that touch the network layer only after the argument check (a --help never loads them).
const { providers, resolve, setCacheDir } = await import('../crawler/providers.mjs');
const { loadProfile, entryTimeoutMs } = await import('../crawler/profile.mjs');
const uaMod = await import('../crawler/useragent.mjs');
const { setUserAgent } = uaMod;
const { configurePolicy, policyFromProfile, installGuard, flushPolicy, interleaveByProvider } = await import('../crawler/policy.mjs');
const { classifyError } = await import('../crawler/resilience.mjs');
const { boardKey } = await import('../core/state/board-store.mjs');

const OUT = pathResolve(opt('out'));
const LOG = opt('log') ? pathResolve(opt('log')) : join(OUT, 'record.log');
const CONC = Number(opt('concurrency', 8));
const HOST_CONC = Number(opt('host-concurrency', 2));
const HOST_GAP = Number(opt('host-gap-ms', 500));
const EXCLUDE = new Set(String(opt('exclude', 'eures,usajobs')).split(',').filter(Boolean));
const STOP_AT = opt('stop-at') ? Date.parse(opt('stop-at')) : Infinity;
const HARD_STOP = opt('hard-stop') ? Date.parse(opt('hard-stop')) : Infinity;
const MIN_FREE = Number(opt('min-free-gb', 45)) * 1024 ** 3;
const LIMIT = Number(opt('limit', 0)) || Infinity;
mkdirSync(join(OUT, 'index'), { recursive: true });
mkdirSync(join(OUT, 'lists'), { recursive: true });

const log = (msg) => { const line = `${new Date().toISOString()} ${msg}`; appendFileSync(LOG, line + '\n'); console.log(line); };
const freeBytes = () => { try { const s = statfsSync(OUT); return s.bavail * s.bsize; } catch { return Infinity; } };

// ---- inputs ----
const profile = loadProfile(opt('profile'));
setUserAgent(profile.userAgent);
const cfg = JSON.parse(readFileSync(pathResolve(opt('companies')), 'utf8'));
const done = new Set();
if (existsSync(join(OUT, 'boards.jsonl'))) for (const l of readFileSync(join(OUT, 'boards.jsonl'), 'utf8').split('\n')) { try { done.add(JSON.parse(l).board); } catch {} }
const seenNames = new Set();
let boards = [];
for (const e of cfg.tracked_companies ?? []) {
  if (e.enabled === false || !e.name || seenNames.has(e.name)) continue;
  seenNames.add(e.name);
  const r = resolve(e);
  if (!r || !providers[r.provider] || EXCLUDE.has(r.provider)) continue;
  boards.push({ ...e, provider: r.provider, _slug: r.slug });
}
const total = boards.length;
boards = interleaveByProvider(boards).filter((b) => !done.has(b.name)).slice(0, LIMIT === Infinity ? undefined : LIMIT);
const byProv = {};
for (const b of boards) byProv[b.provider] = (byProv[b.provider] ?? 0) + 1;
log(`start out=${OUT} boards=${total} todo=${boards.length} resumed=${done.size} conc=${CONC} host_conc=${HOST_CONC} gap_ms=${HOST_GAP} ua="${uaMod.UA}" robots=${profile.robots} stop_at=${opt('stop-at') ?? '-'} hard_stop=${opt('hard-stop') ?? '-'} free_gb=${(freeBytes() / 1024 ** 3).toFixed(1)} min_free_gb=${MIN_FREE / 1024 ** 3}`);
log(`providers ${Object.entries(byProv).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p}:${n}`).join(' ')}`);
if (flag('dry-run')) { log('dry-run: nothing fetched'); process.exit(0); }

// ---- the page cache of per-posting sources: a copy of the live cache, never the live folder ----
const CACHE = join(OUT, 'cache');
mkdirSync(CACHE, { recursive: true });
if (opt('seed-cache') && !existsSync(join(CACHE, '.seeded'))) {
  const src = pathResolve(opt('seed-cache'));
  let n = 0;
  for (const f of readdirSync(src)) if (/^sitemap-cache-[0-9a-f]+\.json$/.test(f)) { copyFileSync(join(src, f), join(CACHE, f)); n++; }
  writeFileSync(join(CACHE, '.seeded'), `${new Date().toISOString()} ${n} files from ${src}\n`);
  log(`seed-cache copied ${n} cache files from ${src}`);
}
setCacheDir(CACHE);

// ---- network: crawl policy (own data dir), then per-host limits and capture around it ----
configurePolicy({ ...policyFromProfile(profile, OUT) });
installGuard();
const als = new AsyncLocalStorage();
const guarded = globalThis.fetch;
const hosts = new Map();   // host -> { active, last, queue: [] }
async function hostSlot(host) {
  const h = hosts.get(host) ?? (hosts.set(host, { active: 0, last: 0, queue: [] }).get(host));
  while (h.active >= HOST_CONC) await new Promise((res) => h.queue.push(res));
  h.active++;
  const wait = h.last + HOST_GAP - Date.now();
  h.last = Math.max(Date.now(), h.last + HOST_GAP);
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  return () => { h.active--; h.queue.shift()?.(); };
}
const T = { req: 0, wire: 0, bytes: 0, objects: 0, capErr: 0, probes: 0, p304: 0, p200same: 0, p200diff: 0, pOther: 0 };
const H = (res, n) => res.headers.get(n) ?? undefined;
function storeBody(buf) {
  const sha = createHash('sha256').update(buf).digest('hex');
  const dir = join(OUT, 'objects', sha.slice(0, 2)), f = join(dir, `${sha}.gz`);
  if (!existsSync(f)) { mkdirSync(dir, { recursive: true }); writeFileSync(`${f}.tmp`, gzipSync(buf)); renameSync(`${f}.tmp`, f); T.objects++; }
  return sha;
}
function indexLine(o) { appendFileSync(join(OUT, 'index', `${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify(o) + '\n'); }

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  let host = '';
  try { host = new URL(url).host; } catch {}
  const ctx = als.getStore();
  const release = await hostSlot(host);
  const t0 = Date.now();
  let res;
  try { res = await guarded(input, init); } finally { release(); }
  try {
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    const ct = H(res, 'content-type') ?? '';
    const line = { t: new Date().toISOString(), board: ctx?.board ?? null, provider: ctx?.provider ?? null, url, method, status: res.status, ct,
      enc: H(res, 'content-encoding'), wire: Number(H(res, 'content-length')) || null, etag: H(res, 'etag'), lm: H(res, 'last-modified'),
      cc: H(res, 'cache-control'), ms: Date.now() - t0, probe: ctx?.probe ? true : undefined };
    T.req++; if (ctx) ctx.req++;
    if (res.ok && (/json|html|xml|text|javascript/i.test(ct) || !ct)) {
      const buf = Buffer.from(await res.clone().arrayBuffer());
      line.bytes = buf.length; line.sha256 = storeBody(buf);
      T.bytes += buf.length; if (ctx) ctx.bytes += buf.length;
    }
    T.wire += line.wire ?? line.bytes ?? 0;
    if (ctx && !ctx.probe && !ctx.first && method === 'GET' && res.status === 200 && (line.etag || line.lm)) ctx.first = { url, etag: line.etag, lm: line.lm, sha: line.sha256, accept: init?.headers?.accept ?? init?.headers?.Accept };
    indexLine(line);
  } catch { T.capErr++; }
  return res;
};

async function probe(ctx) {
  const f = ctx.first;
  const headers = { 'user-agent': uaMod.UA };
  if (f.accept) headers.accept = f.accept;
  if (f.etag) headers['if-none-match'] = f.etag;
  if (f.lm) headers['if-modified-since'] = f.lm;
  const pctx = { ...ctx, probe: true };
  try {
    const res = await als.run(pctx, () => globalThis.fetch(f.url, { headers, signal: AbortSignal.timeout(20000) }));
    T.probes++;
    if (res.status === 304) { T.p304++; return '304'; }
    if (res.status === 200) {
      const sha = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
      if (sha === f.sha) { T.p200same++; return '200-same'; }
      T.p200diff++; return '200-diff';
    }
    T.pOther++; return String(res.status);
  } catch (e) { T.pOther++; return `error:${classifyError(e).cls}`; }
}

// ---- boards ----
const P = {};   // provider -> totals
let n = 0, ok = 0, failed = 0, stopReason = null;
const started = Date.now();
let lastProgress = Date.now();
function progress(cur) {
  const el = (Date.now() - started) / 60000;
  log(`progress ${n}/${boards.length} ok=${ok} failed=${failed} req=${T.req} MB=${(T.bytes / 1e6).toFixed(0)} wireMB=${(T.wire / 1e6).toFixed(0)} probes=${T.probes} 304=${T.p304} min=${el.toFixed(1)} rate=${(n / Math.max(el, 0.01)).toFixed(1)}/min free_gb=${(freeBytes() / 1024 ** 3).toFixed(1)} current="${cur ?? ''}"`);
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ t: new Date().toISOString(), done: n, todo: boards.length, ok, failed, totals: T, providers: P, stop: stopReason }, null, 1));
}

async function recordBoard(b) {
  const ctx = { board: b.name, provider: b.provider, req: 0, bytes: 0, first: null };
  const t0 = Date.now();
  const ms = entryTimeoutMs(b);
  let timer, jobs = null, err = null;
  try {
    jobs = await als.run(ctx, () => Promise.race([providers[b.provider].fetch(b._slug, b),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Timed out after ${Math.round(ms / 1000)}s (${b.name})`)), ms); })]));
  } catch (e) { err = classifyError(e); } finally { clearTimeout(timer); }
  const probeResult = ctx.first ? await probe(ctx) : null;
  const items = Array.isArray(jobs) ? jobs : [];
  const dh = (d) => (d ? createHash('sha256').update(String(d)).digest('hex').slice(0, 16) : null);
  const rec = { board: b.name, provider: b.provider, slug: b._slug, ok: !err, cls: err?.cls ?? null, detail: err ? String(err.detail ?? '').slice(0, 200) : undefined,
    jobs: items.length, incomplete: items.incomplete ? true : undefined, emptyOk: items.emptyOk === true || undefined,
    req: ctx.req, bytes: ctx.bytes, ms: Date.now() - t0, validators: ctx.first ? { etag: Boolean(ctx.first.etag), lm: Boolean(ctx.first.lm) } : null, probe: probeResult };
  if (!err) {
    const list = { board: b.name, provider: b.provider, slug: b._slug, t: new Date().toISOString(), complete: !items.incomplete, emptyOk: items.emptyOk === true,
      max_jobs: b.max_jobs ?? null, items: items.map((j) => ({ url: j.url, title: j.title, location: j.location, postedAt: j.postedAt, dh: dh(j.description) })) };
    writeFileSync(join(OUT, 'lists', `${boardKey(b.name)}.json.gz`), gzipSync(JSON.stringify(list)));
  }
  appendFileSync(join(OUT, 'boards.jsonl'), JSON.stringify(rec) + '\n');
  const p = (P[b.provider] ??= { boards: 0, ok: 0, failed: 0, jobs: 0, req: 0, bytes: 0, ms: 0, validators: 0, p304: 0, p200same: 0, p200diff: 0 });
  p.boards++; p.req += rec.req; p.bytes += rec.bytes; p.ms += rec.ms; p.jobs += rec.jobs;
  if (err) p.failed++; else p.ok++;
  if (rec.validators) p.validators++;
  if (probeResult === '304') p.p304++; else if (probeResult === '200-same') p.p200same++; else if (probeResult === '200-diff') p.p200diff++;
  if (err) failed++; else ok++;
}

const hardTimer = Number.isFinite(HARD_STOP) ? setTimeout(() => {
  stopReason = 'hard-stop reached';
  progress('hard stop');
  log(`result STOPPED at hard stop: ${n}/${boards.length} boards done, ${boards.length - n} left for a resume (in-flight boards were cut and are not in boards.jsonl)`);
  flushPolicy();
  process.exit(0);
}, Math.max(0, HARD_STOP - Date.now())) : null;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopReason = `signal ${sig}`; });

let i = 0;
async function worker() {
  while (i < boards.length) {
    if (stopReason) return;
    if (Date.now() >= STOP_AT) { stopReason ??= 'stop-at reached'; return; }
    if (freeBytes() < MIN_FREE) { stopReason ??= `free disk below ${MIN_FREE / 1024 ** 3} GB`; return; }
    const b = boards[i++];
    try { await recordBoard(b); } catch (e) { failed++; log(`board-error ${b.name}: ${e?.message ?? e}`); }
    n++;
    if (n % 50 === 0 || Date.now() - lastProgress > 60000) { lastProgress = Date.now(); progress(b.name); }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
if (hardTimer) clearTimeout(hardTimer);
progress('end');
flushPolicy();
log(`result ${stopReason ? `STOPPED (${stopReason})` : 'done'}: ${n}/${boards.length} boards, ok=${ok} failed=${failed}, requests=${T.req}, MB=${(T.bytes / 1e6).toFixed(0)}, wireMB=${(T.wire / 1e6).toFixed(0)}, objects=${T.objects}, probes=${T.probes} (304 ${T.p304}, 200-same ${T.p200same}, 200-diff ${T.p200diff}, other ${T.pOther}), capture errors=${T.capErr}, min=${((Date.now() - started) / 60000).toFixed(1)}`);
process.exit(0);
