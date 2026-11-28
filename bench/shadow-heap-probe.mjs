#!/usr/bin/env node
// Heap probe for the strangler-fig shadow hook (incident 2026-11-28: the armed crawl ran out of its ~2.1 GB heap at saveHistory).
// Builds the crawl's in-memory picture (history Map of url -> row, every board's answer with descriptions), then measures:
//   capture_retained_mb   heap kept by captureShadowInput()'s result after a full GC (must be small)
//   released_mb           heap freed when the crawl drops its own history/results while the capture is still held (must be most of it:
//                         proves the capture does not pin the crawl's objects)
//   hook_peak_delta_mb    peak heap growth while runShadow() applies the capture (sampled after every board)
// Modes:
//   --synthetic <rows>    a synthetic history of <rows> rows over --boards boards (default 500000 rows, 5000 boards, 40 routed)
//   --history <tsv> --companies <json> --routing <json>   the real history (read-only) and routing; answers are made from each board's
//                         current listing rows (descriptions synthetic, 3 kB) so the picture matches a real cycle's size
// Writes one JSON result line to stdout (and progress lines to stderr). Run with the crawl's heap limit and --expose-gc, e.g.
//   systemd-run --user --wait --pipe -p MemoryHigh=12G -p MemoryMax=16G node --expose-gc bench/shadow-heap-probe.mjs --history ...
import { mkdtempSync, readFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import v8 from 'node:v8';
import { captureShadowInput, runShadow } from '../core/route/shadow-hook.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
if (args.includes('--help')) { console.log('usage: node --expose-gc bench/shadow-heap-probe.mjs [--synthetic 500000 --boards 5000 --routed 40] | [--history <tsv> --companies <json> --routing <json>] [--store <dir>]'); process.exit(0); }
if (typeof globalThis.gc !== 'function') { console.error('run with --expose-gc'); process.exit(2); }
const MB = 1048576;
const heap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };
const say = (m) => process.stderr.write(`${new Date().toISOString()} [heap-probe] ${m}\n`);
const desc = (i) => `<p>${'Responsibilities include systems engineering, testing and integration; ünd Prüfung. '.repeat(40)} #${i}</p>`;

let history = new Map(), companies = [], results = [], routingFile, store = opt('store') ?? mkdtempSync(join(tmpdir(), 'jcx-heap-store-'));
const t0 = Date.now();
if (opt('history')) {
  routingFile = opt('routing');
  const cfg = JSON.parse(readFileSync(opt('companies'), 'utf8'));
  companies = (cfg.tracked_companies ?? []).filter((e) => e.enabled !== false && e.name);
  const rl = createInterface({ input: createReadStream(opt('history'), { encoding: 'utf8' }), crlfDelay: Infinity });
  let head = null;
  for await (const line of rl) {
    if (!line) continue;
    const c = line.split('\t');
    if (!head) { head = c; continue; }
    const row = {}; head.forEach((h, i) => { row[h] = c[i] ?? ''; });
    history.set(row.url, row);
  }
  let byBoard = new Map();   // the probe's own index; dropped below so it does not count as "pinned"
  for (const r of history.values()) if (r.status !== 'gone') (byBoard.get(r.company) ?? byBoard.set(r.company, []).get(r.company)).push(r);
  let k = 0;
  results = companies.map((e) => ({ r: { provider: e.provider }, jobs: (byBoard.get(e.name) ?? []).map((r) => ({ url: r.url, title: r.title, location: r.location, postedAt: r.posted, description: desc(k++) })) }));
  byBoard = null;
  say(`real history: ${history.size} rows, ${companies.length} boards, ${k} answer rows built in ${Date.now() - t0} ms`);
} else {
  const rows = Number(opt('synthetic', 500000)), nb = Number(opt('boards', 5000)), routed = Number(opt('routed', 40));
  const { writeFileSync } = await import('node:fs');
  routingFile = join(store, '..', `routing-${process.pid}.json`);
  writeFileSync(routingFile, JSON.stringify({ schema: 'routing/v1', providers: { greenhouse: 'shadow' } }));
  companies = Array.from({ length: nb }, (_, b) => ({ name: `Board ${b} – Ünternehmen`, provider: b < routed ? 'greenhouse' : 'lever' }));
  for (let i = 0; i < rows; i++) {
    const b = i % nb, url = `https://jobs.example-${b}.com/postings/${i}?ref=board-${b}`;
    history.set(url, { url, company: companies[b].name, title: `Senior Systems Engineer (m/w/d) – Test ${i}`, location: 'München, Bayern, Deutschland', first_seen: '2026-10-01', last_seen: '2026-11-27', status: i % 7 === 0 ? 'gone' : i % 5 === 0 ? 'extra' : 'open', posted: '2026-09-30' });
  }
  let jobsPer = new Map();
  for (const r of history.values()) if (r.status !== 'gone') { const b = Number(/board-(\d+)/.exec(r.url)[1]); if ((jobsPer.get(b)?.length ?? 0) < 12) (jobsPer.get(b) ?? jobsPer.set(b, []).get(b)).push(r); }
  results = companies.map((e, b) => ({ r: { provider: e.provider }, jobs: (jobsPer.get(b) ?? []).map((r, j) => ({ url: r.url, title: r.title, location: r.location, postedAt: r.posted, description: desc(b * 100 + j) })) }));
  jobsPer = null;
  say(`synthetic history: ${history.size} rows, ${companies.length} boards (${routed} routed), answers built in ${Date.now() - t0} ms`);
}
const env = { JOBCRAWL_SHADOW: '1', JOBCRAWL_ROUTING: routingFile, JOBCRAWL_SHADOW_DATA: store, JOBCRAWL_SHADOW_BUDGET_MS: '600000', JOBCRAWL_SHADOW_BOARD_MS: '60000' };
const limit = v8.getHeapStatistics().heap_size_limit;
const base = heap();
const tc = Date.now();
const input = captureShadowInput({ companies, results, history, env, log: (m) => say(m) });
const captureMs = Date.now() - tc;
const withCapture = heap();
const pictureMb = base / MB;
history = null; results = null;                       // the crawl drops its objects after scan()
const released = heap();
const sum = await runShadow({ dataDir: join(store, '..', 'data-not-used'), input, env, log: (m) => say(m) });
const after = heap();
const out = {
  heap_limit_mb: Math.round(limit / MB), picture_mb: Math.round(pictureMb), capture_ms: captureMs,
  capture_retained_mb: +((withCapture - base) / MB).toFixed(1), released_mb: Math.round((withCapture - released) / MB),
  routed_boards: input?.boards.length ?? 0, routed_items: input?.boards.reduce((s, b) => s + (b.run?.items?.length ?? 0), 0) ?? 0, status_rows: input?.statusByUrl.size ?? 0,
  hook_peak_delta_mb: sum.heap?.hook_peak_delta_mb ?? null, hook_ms: sum.ms, shadowed: sum.shadowed, failed: sum.failed, low_memory: sum.low_memory,
  after_hook_mb: Math.round(after / MB), store,
};
console.log(JSON.stringify(out));
