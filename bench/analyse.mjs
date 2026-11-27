#!/usr/bin/env node
// Analysis of a benchmark recording (bench/record.mjs) for the byte-win decision (design §0.1, phase 0.6 / 1e):
//   * per provider and per host: boards, failures by class, requests, wire bytes (Content-Length, else estimate), decoded bytes
//   * validator support and the TRUE 304 rate from the conditional probes (304 / 200-same / 200-diff = jitter)
//   * change rates of the same list URLs from the live raw-capture index (--live-index, last --days days): how often the body changed
//     between two reads, and how often the live crawl reads it per day
//   * projected list bytes per day with conditional requests on the hosts that really answer 304, per provider and in total
//   * the hosts to switch on (crawl.conditional_cache.hosts): 304 rate >= --min-304 over at least --min-probes probes
// Writes <out>/report.json and <out>/report.md; prints a start line, a progress line per input file and a result line.
//
//   node bench/analyse.mjs --recording <out dir of record.mjs> [--live-index <dir>] [--days 7] [--out <dir>] [--min-304 0.9] [--min-probes 3]
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const isMain = Boolean(process.argv[1]) && pathResolve(process.argv[1]) === fileURLToPath(import.meta.url);
const say = (m) => console.log(`${new Date().toISOString()} [analyse] ${m}`);

async function* lines(file) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const l of rl) { if (!l) continue; try { yield JSON.parse(l); } catch {} }
}
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return '?'; } };
const add = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };
const PER_POSTING = new Set(['jsonld_direct', 'sitemap']);

export async function analyse({ rec, live = null, days = 7, min304 = 0.9, minProbes = 3, log = () => {} }) {
  const P = {}, H = {}, failures = {};
  // boards
  const boardsFile = join(rec, 'boards.jsonl');
  const boardProv = new Map();
  if (existsSync(boardsFile)) for await (const b of lines(boardsFile)) {
    boardProv.set(b.board, b.provider);
    const p = (P[b.provider] ??= { boards: 0, ok: 0, failed: 0, jobs: 0, req: 0, wire: 0, bytes: 0, validator_boards: 0, probes: 0, p304: 0, p200same: 0, p200diff: 0, pother: 0, fail_cls: {} });
    p.boards++; p.jobs += b.jobs ?? 0;
    if (b.ok) p.ok++; else { p.failed++; add(p.fail_cls, b.cls ?? 'OTHER'); add(failures, b.cls ?? 'OTHER'); }
    if (b.validators) p.validator_boards++;
  }
  // responses
  const firstSha = new Map();            // url -> sha of the first non-probe 200 answer
  const boardFirst = new Set();
  const urlInfo = new Map();             // url -> { provider, host, wire, honours: null|bool, probed }
  const idxDir = join(rec, 'index');
  const files = existsSync(idxDir) ? readdirSync(idxDir).filter((f) => f.endsWith('.jsonl')).sort() : [];
  const probeLines = [];
  for (const f of files) {
    let n = 0;
    for await (const l of lines(join(idxDir, f))) {
      n++;
      const prov = l.provider ?? boardProv.get(l.board) ?? '?';
      const h = (H[hostOf(l.url)] ??= { req: 0, wire: 0, bytes: 0, status: {}, validators: 0, probes: 0, p304: 0, p200same: 0, p200diff: 0, pother: 0, providers: {} });
      if (l.probe) { probeLines.push(l); continue; }
      h.req++; h.wire += l.wire ?? 0; h.bytes += l.bytes ?? 0; add(h.status, l.status === 0 ? `err:${l.err ?? '?'}` : `${String(l.status)[0]}xx`); add(h.providers, prov);
      if (l.etag || l.lm) h.validators++;
      const p = P[prov] ??= { boards: 0, ok: 0, failed: 0, jobs: 0, req: 0, wire: 0, bytes: 0, validator_boards: 0, probes: 0, p304: 0, p200same: 0, p200diff: 0, pother: 0, fail_cls: {} };
      p.req++; p.wire += l.wire ?? 0; p.bytes += l.bytes ?? 0;
      // list URLs: every GET of a list-API board; for per-posting sources (sitemap, jsonld_direct) only the board's first URL (its list
      // or sitemap; the posting pages behind it already use the sources' own lastmod/TTL page cache)
      const perPosting = PER_POSTING.has(prov);
      if (perPosting && l.board && boardFirst.has(l.board)) continue;
      if (perPosting && l.board) boardFirst.add(l.board);
      if (l.method === 'GET' && l.status === 200 && !firstSha.has(l.url)) {
        firstSha.set(l.url, l.sha256);
        urlInfo.set(l.url, { provider: prov, host: hostOf(l.url), wire: l.wire ?? l.bytes ?? 0, honours: null, probed: false });
      }
    }
    log(`read ${f}: ${n} lines`);
  }
  for (const l of probeLines) {
    const prov = l.provider ?? boardProv.get(l.board) ?? '?';
    const h = H[hostOf(l.url)], p = P[prov];
    const outcome = l.status === 304 ? 'p304' : l.status === 200 ? (l.sha256 && l.sha256 === firstSha.get(l.url) ? 'p200same' : 'p200diff') : 'pother';
    for (const o of [h, p]) if (o) { o.probes++; o[outcome]++; }
    const u = urlInfo.get(l.url);
    if (u) { u.probed = true; u.honours = outcome === 'p304'; }
  }
  // change rates and polls per day from the live index
  const obs = new Map();                  // url -> [sha...] in time order (only URLs the recording read as list URLs)
  let liveFiles = [], liveLines = 0;
  if (live && existsSync(live)) {
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    liveFiles = readdirSync(live).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) >= since).sort();
    for (const f of liveFiles) {
      let n = 0;
      for await (const l of lines(join(live, f))) {
        n++;
        if (!urlInfo.has(l.url) || !l.sha256) continue;
        (obs.get(l.url) ?? obs.set(l.url, []).get(l.url)).push(l.sha256);
      }
      liveLines += n;
      log(`live ${f}: ${n} lines`);
    }
  }
  const provChange = {};
  for (const [url, shas] of obs) {
    if (shas.length < 2) continue;
    let ch = 0;
    for (let i = 1; i < shas.length; i++) if (shas[i] !== shas[i - 1]) ch++;
    const u = urlInfo.get(url);
    u.change = ch / (shas.length - 1);
    u.polls_per_day = shas.length / Math.max(1, liveFiles.length);
    const pc = (provChange[u.provider] ??= { urls: 0, sum: 0 });
    pc.urls++; pc.sum += u.change;
  }
  // projection: list bytes per day now vs with conditional requests on hosts that answer 304
  const hostOn = {};
  for (const [h, x] of Object.entries(H)) if (x.probes >= minProbes && x.p304 / x.probes >= min304) hostOn[h] = true;
  const proj = {};
  let nowDay = 0, condDay = 0;
  for (const u of urlInfo.values()) {
    const polls = u.polls_per_day ?? 1;
    const change = u.change ?? (provChange[u.provider]?.urls ? provChange[u.provider].sum / provChange[u.provider].urls : 1);
    const cur = u.wire * polls;
    const withCond = hostOn[u.host] ? u.wire * polls * change + 400 * polls * (1 - change) : cur;
    const pp = (proj[u.provider] ??= { urls: 0, now_bytes_day: 0, cond_bytes_day: 0 });
    pp.urls++; pp.now_bytes_day += cur; pp.cond_bytes_day += withCond;
    nowDay += cur; condDay += withCond;
  }
  for (const [prov, pc] of Object.entries(provChange)) if (P[prov]) P[prov].change_rate = +(pc.sum / pc.urls).toFixed(3);
  // provider-level suggestion: a provider whose probes answer 304 at the threshold, with its hosts' common two-label suffix as a pattern
  const providerPatterns = {};
  for (const [prov, p] of Object.entries(P)) {
    if (p.probes < minProbes || p.p304 / p.probes < min304) continue;
    const hs = [...new Set([...urlInfo.values()].filter((u) => u.provider === prov).map((u) => u.host))];
    const sfx = [...new Set(hs.map((h) => h.split('.').slice(-2).join('.')))];
    providerPatterns[prov] = sfx.length === 1 && hs.length > 1 ? [`*.${sfx[0]}`, ...(hs.includes(sfx[0]) ? [sfx[0]] : [])] : hs.sort();
  }
  return {
    t: new Date().toISOString(), recording: rec, live_index: live, live_days: liveFiles.length, live_lines: liveLines,
    totals: { boards: boardProv.size, failures, requests: Object.values(P).reduce((s, p) => s + p.req, 0), wire_bytes: Object.values(P).reduce((s, p) => s + p.wire, 0),
      decoded_bytes: Object.values(P).reduce((s, p) => s + p.bytes, 0), probes: probeLines.length, list_urls: urlInfo.size, list_urls_with_live_history: [...urlInfo.values()].filter((u) => u.change != null).length },
    projection: { note: 'list URLs only (every GET of a list-API board; the first URL of a sitemap/jsonld_direct board, whose posting pages already use their own lastmod cache)',
      hosts_to_switch_on: Object.keys(hostOn).sort(), provider_patterns: providerPatterns, now_bytes_day: Math.round(nowDay), cond_bytes_day: Math.round(condDay),
      saving: nowDay ? +(1 - condDay / nowDay).toFixed(3) : 0, by_provider: proj },
    providers: P, hosts: H,
  };
}

const mb = (b) => (b / 1e6).toFixed(1);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : '-');
export function toMarkdown(r) {
  const prov = Object.entries(r.providers).sort((a, b) => b[1].wire - a[1].wire);
  const hosts = Object.entries(r.hosts).sort((a, b) => b[1].wire - a[1].wire).slice(0, 40);
  return [
    `# Benchmark recording analysis (${r.t.slice(0, 16)} UTC)`, '',
    `Recording \`${r.recording}\`; live index \`${r.live_index ?? '-'}\` (${r.live_days} days, ${r.live_lines} lines).`, '',
    `Boards ${r.totals.boards}; requests ${r.totals.requests}; wire ${mb(r.totals.wire_bytes)} MB; decoded ${mb(r.totals.decoded_bytes)} MB; probes ${r.totals.probes}; failures ${JSON.stringify(r.totals.failures)}.`, '',
    `**Projection (list URLs):** ${mb(r.projection.now_bytes_day)} MB/day now -> ${mb(r.projection.cond_bytes_day)} MB/day with conditional requests (saving ${Math.round(r.projection.saving * 100)} %). ${r.projection.note}.`, '',
    `Hosts that answer 304 (switch on): ${r.projection.hosts_to_switch_on.length ? r.projection.hosts_to_switch_on.map((h) => `\`${h}\``).join(', ') : 'none'}.`, '',
    `Per provider (crawl.conditional_cache.hosts candidates): ${Object.entries(r.projection.provider_patterns).map(([p, h]) => `${p}: ${h.join(' ')}`).join('; ') || 'none'}.`, '',
    '| provider | boards | failed | req | wire MB | decoded MB | validator boards | probes | 304 | 200 same | 200 diff | change rate |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...prov.map(([k, p]) => `| ${k} | ${p.boards} | ${p.failed} | ${p.req} | ${mb(p.wire)} | ${mb(p.bytes)} | ${p.validator_boards} | ${p.probes} | ${pct(p.p304, p.probes)} | ${pct(p.p200same, p.probes)} | ${pct(p.p200diff, p.probes)} | ${p.change_rate ?? '-'} |`), '',
    '| host (top 40 by wire) | req | wire MB | validators | probes | 304 |', '|---|---:|---:|---:|---:|---:|',
    ...hosts.map(([k, h]) => `| ${k} | ${h.req} | ${mb(h.wire)} | ${pct(h.validators, h.req)} | ${h.probes} | ${pct(h.p304, h.probes)} |`), '',
  ].join('\n');
}

if (isMain) {
  const args = process.argv.slice(2);
  const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
  if (args.includes('--help') || args.includes('-h') || !opt('recording')) {
    console.log('usage: node bench/analyse.mjs --recording <dir> [--live-index <dir>] [--days 7] [--out <dir>] [--min-304 0.9] [--min-probes 3]');
    process.exit(args.includes('--help') || args.includes('-h') ? 0 : 2);
  }
  const REC = pathResolve(opt('recording'));
  const OUT = pathResolve(opt('out', join(REC, 'analysis')));
  const LIVE = opt('live-index') ? pathResolve(opt('live-index')) : null;
  const T0 = Date.now();
  say(`start recording=${REC} live=${LIVE ?? '-'} days=${opt('days', 7)} out=${OUT}`);
  const r = await analyse({ rec: REC, live: LIVE, days: Number(opt('days', 7)), min304: Number(opt('min-304', 0.9)), minProbes: Number(opt('min-probes', 3)), log: say });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(r, null, 1));
  writeFileSync(join(OUT, 'report.md'), toMarkdown(r));
  say(`result boards=${r.totals.boards} requests=${r.totals.requests} wireMB=${mb(r.totals.wire_bytes)} probes=${r.totals.probes} hosts_304=${r.projection.hosts_to_switch_on.length} saving=${Math.round(r.projection.saving * 100)}% -> ${join(OUT, 'report.md')} in ${((Date.now() - T0) / 1000).toFixed(0)} s`);
}
