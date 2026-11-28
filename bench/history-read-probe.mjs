#!/usr/bin/env node
// Memory and equality probe for loadHistory (follow-up to the 2026-11-28 heap incident). Reads a history file with the OLD whole-file
// code or the NEW streaming reader (crawler/history-read.mjs) and prints one JSON line:
//   { mode, rows, map_sha256, heap_after_load_mb, ms }
// map_sha256 hashes the Map in iteration order ([key, row] per entry, row keys in insertion order), so equal hashes mean the same keys,
// the same order (first insertion position of a duplicate url, last row's values) and the same fields.
// For the heap peak of the read run with --expose-gc --trace-gc: the largest heap size the GC lines report between READ_START and
// READ_END. Run each mode in its own process under made-cycle's limits:
//   systemd-run --user --wait --pipe -p MemoryHigh=12G -p MemoryMax=16G node --expose-gc --trace-gc bench/history-read-probe.mjs --history <tsv> --mode old|new
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readHistoryFile } from '../crawler/history-read.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
if (args.includes('--help') || !opt('history')) { console.log('usage: node bench/history-read-probe.mjs --history <tsv> --mode old|new'); process.exit(args.includes('--help') ? 0 : 2); }
const MB = 1048576, mode = opt('mode', 'new'), file = opt('history');
const HEADER = ['url', 'company', 'title', 'location', 'first_seen', 'last_seen', 'status', 'posted'];
function loadOld(f) {                         // crawl.mjs loadHistory() before 2026-11-28, verbatim apart from the file argument
  const map = new Map();
  if (!existsSync(f)) return map;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const row = Object.fromEntries(line.split('\t').map((v, i) => [HEADER[i], v]));
    map.set(row.url, row);
  }
  return map;
}
if (globalThis.gc) globalThis.gc();
const t0 = Date.now();
console.log('READ_START');
const map = mode === 'old' ? loadOld(file) : readHistoryFile(file, HEADER);
console.log('READ_END');
const ms = Date.now() - t0;
if (globalThis.gc) globalThis.gc();
const heapAfter = process.memoryUsage().heapUsed;
const h = createHash('sha256');
for (const [k, row] of map) h.update(JSON.stringify([k, Object.entries(row)]) + '\n');
console.log(JSON.stringify({ mode, rows: map.size, map_sha256: h.digest('hex'), heap_after_load_mb: Math.round(heapAfter / MB), max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024), ms }));
