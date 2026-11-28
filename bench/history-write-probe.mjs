#!/usr/bin/env node
// Memory and byte-equality probe for saveHistory (heap incident 2026-11-28). Loads a history file the way crawl.mjs loadHistory() does,
// changes one row (so the write is a real change, as in every cycle), then writes it with the OLD code (full string + full read-back)
// or the NEW streaming writer, into its own copy of the file. Prints one JSON line:
//   { mode, rows, bytes, sha256, heap_before_mb, heap_after_mb, rss_before_mb, max_rss_mb, write_rss_delta_mb, ms }
// write_rss_delta_mb = max RSS minus RSS just before the write (an upper bound only when the write is the process's peak).
// For the heap peak of the write itself run with --expose-gc --trace-gc: the largest heap size the GC lines report between the
// WRITE_START and WRITE_END markers; or run each mode under a tight --max-old-space-size to see which one fits.
// Run each mode in its own process under made-cycle's limits:
//   systemd-run --user --wait --pipe -p MemoryHigh=12G -p MemoryMax=16G node bench/history-write-probe.mjs --history <tsv> --mode old|new --out <dir>
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import v8 from 'node:v8';
import { writeHistoryFile } from '../crawler/history-write.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
if (args.includes('--help') || !opt('history') || !opt('out')) { console.log('usage: node bench/history-write-probe.mjs --history <tsv> --mode old|new --out <dir>'); process.exit(args.includes('--help') ? 0 : 2); }
const MB = 1048576, mode = opt('mode', 'new'), out = opt('out');
const HEADER = ['url', 'company', 'title', 'location', 'first_seen', 'last_seen', 'status', 'posted'];
mkdirSync(out, { recursive: true });
const target = join(out, `scan-history-${mode}.tsv`);
copyFileSync(opt('history'), target);                 // the "old file" the write compares against (a copy; the source is only read)

function loadHistory(file) {                           // crawl.mjs loadHistory(), verbatim apart from the file argument
  const map = new Map();
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const row = Object.fromEntries(line.split('\t').map((v, i) => [HEADER[i], v]));
    map.set(row.url, row);
  }
  return map;
}
function saveOld(file, map) {                          // crawl.mjs saveHistory() before 2026-11-28, verbatim apart from the file argument
  const lines = [HEADER.join('\t'), ...[...map.values()].map((r) => HEADER.map((h) => String(r[h] ?? '').replace(/[\t\n]/g, ' ')).join('\t'))];
  const next = lines.join('\n') + '\n';
  if (existsSync(file) && readFileSync(file, 'utf8') === next) return;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, file);
}

const map = loadHistory(target);
const last = [...map.values()].at(-1);
if (last) last.last_seen = '2099-01-01';               // one real change, like every cycle's last_seen updates
if (globalThis.gc) globalThis.gc();
const heapBefore = process.memoryUsage().heapUsed, rssBefore = process.memoryUsage().rss;
const t0 = Date.now();
console.log('WRITE_START');   // markers for a --trace-gc reader: the heap sizes between them are the write's
if (mode === 'old') saveOld(target, map); else writeHistoryFile(target, HEADER, map.values());
console.log('WRITE_END');
const ms = Date.now() - t0;
const maxRss = process.resourceUsage().maxRSS * 1024;
const buf = readFileSync(target);
console.log(JSON.stringify({ mode, rows: map.size, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'),
  heap_limit_mb: Math.round(v8.getHeapStatistics().heap_size_limit / MB), heap_before_mb: Math.round(heapBefore / MB), heap_after_mb: Math.round(process.memoryUsage().heapUsed / MB),
  rss_before_mb: Math.round(rssBefore / MB), max_rss_mb: Math.round(maxRss / MB), write_rss_delta_mb: Math.round((maxRss - rssBefore) / MB), ms }));
