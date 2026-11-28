#!/usr/bin/env node
// Pin the fetched benchmark pages (split v2) before any evaluation: one line per row with the sha1 of page 1 and of its follow.
//   node bench/detect/pin-pages.mjs --split bench/detect/split-v2.jsonl --cache <dir> --out bench/detect/split-v2.pages.jsonl
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
if (!opt('split') || !opt('cache') || !opt('out')) { console.log('usage: node bench/detect/pin-pages.mjs --split <jsonl> --cache <dir> --out <jsonl>'); process.exit(2); }
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');
const rows = readFileSync(opt('split'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const out = [];
for (const r of rows) {
  const f = join(opt('cache'), r.id + '.json');
  if (!existsSync(f)) { out.push({ id: r.id, usable: false, error: 'not fetched' }); continue; }
  const p = JSON.parse(readFileSync(f, 'utf8'));
  const usable = !!(p.html && !p.error && p.status && p.status < 400);
  const fu = p.follow && p.follow.html && !p.follow.error && p.follow.status < 400;
  out.push({ id: r.id, usable, status: p.status, error: p.error || '', robots: p.robots || '', html_sha1: p.html ? sha1(p.html) : null,
    follow_url: p.follow?.url ?? null, follow_status: p.follow?.status ?? null, follow_error: p.follow?.error || '', follow_sha1: p.follow ? sha1(p.follow.html ?? '') : null, follow_usable: !!fu });
}
writeFileSync(opt('out'), out.map((x) => JSON.stringify(x)).join('\n') + '\n');
const n = (f) => out.filter(f).length;
console.log(`rows=${out.length} usable=${n((x) => x.usable)} with_follow=${n((x) => x.follow_usable)} robots_disallow=${n((x) => x.error === 'robots_disallow')} not_fetched=${n((x) => x.error === 'not fetched')}`);
