#!/usr/bin/env node
// Cycle checker for the authority swap (review_authority.md F3). Reads one cycle log (or crawl log) and the routing file that cycle ran
// with; prints one JSON line and exits 0 (green), 2 (red) or 1 (cannot check). Red when:
//   - "kept open N" with N > 0 (the new path kept a row open the legacy rule closes: the divergence alarm), or a "KEPT OPEN" line;
//   - "[authority] off this cycle", "commit failed", "setup failed", "error, legacy rule";
//   - the routing has allow_new: true with boards routed new, no kill switch, the log has the crawl's end (a "[shadow]" line or a
//     "[cycle] result:" line) and no "[authority] boards routed new" line.
//   authority-check.mjs <log> --routing <routing.json> [--boards "A|B"]   (--boards: also red when one of them is refused by the router)
import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const logFile = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const out = (o, code) => { console.log(JSON.stringify(o)); process.exit(code); };
if (!logFile || !existsSync(logFile)) out({ verdict: 'unknown', why: `no log ${logFile ?? ''}` }, 1);
let routing = null;
try { routing = JSON.parse(readFileSync(opt('routing'), 'utf8')); } catch (e) { out({ verdict: 'unknown', why: `routing: ${e.message}` }, 1); }
const text = readFileSync(logFile, 'utf8');
const lines = text.split('\n');
const auth = lines.filter((l) => l.includes('[authority]'));
const summary = auth.filter((l) => /\[authority\] boards routed new \d+/.test(l)).at(-1) ?? null;
const routedNew = Object.entries(routing.boards ?? {}).filter(([, r]) => r === 'new').map(([b]) => b);
const armedNew = routing.allow_new === true && routing.kill_switch !== true && routedNew.length > 0 && !/^(1|true|yes|on)$/i.test(process.env.JOBCRAWL_ROUTE_KILL ?? '');
const crawlEnded = lines.some((l) => l.includes('[shadow] ') || l.includes('[cycle] result:'));
const red = [];
const kept = summary ? Number((summary.match(/kept open (\d+)/) ?? [])[1] ?? 0) : 0;
if (kept > 0) red.push(`kept open ${kept}`);
for (const l of auth) {
  if (/\[authority\] boards routed new \d+/.test(l)) continue;   // the summary line: judged by its counts below
  if (l.includes('KEPT OPEN')) red.push(l.slice(l.indexOf('[authority]'), 400));
  else if (/off this cycle|commit failed|setup failed|error, legacy rule/.test(l)) red.push(l.slice(l.indexOf('[authority]'), 300));
}
for (const k of ['errors', 'setup failed']) { const n = summary ? Number((summary.match(new RegExp(`${k} (\\d+)`)) ?? [])[1] ?? 0) : 0; if (n > 0) red.push(`${k} ${n}`); }
if (armedNew && crawlEnded && !summary) red.push('no [authority] line while boards are routed new');
if (summary && opt('boards')) {
  const refused = Number((summary.match(/provider routes refused (\d+)/) ?? [])[1] ?? 0);
  if (refused) red.push(`provider routes refused ${refused}`);
}
const num = (k) => summary ? Number((summary.match(new RegExp(`${k} (\\d+)`)) ?? [])[1] ?? 0) : null;
const o = { verdict: red.length ? 'red' : (summary ? 'green' : (armedNew ? (crawlEnded ? 'red' : 'pending') : 'not-armed')), red: [...new Set(red)], armed: armedNew, crawl_ended: crawlEnded,
  routed: num('boards routed new'), decided: num('decided'), committed: num('committed'), closed: num('closed by the new path'), kept, fallback: num('legacy fallback rows'), summary };
out(o, o.verdict === 'red' ? 2 : (o.verdict === 'pending' ? 1 : 0));
