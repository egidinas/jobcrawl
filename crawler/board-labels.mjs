#!/usr/bin/env node
// Board labels: what the aggregator boards themselves say about an employer (industry tags, SSIC code, size, a description).
// The crawl keeps them per employer in <data>/board-labels.json. A later scope step may use them as one vote among several,
// never as the only reason to drop or add a company.
//
//   node crawler/board-labels.mjs enumerate [--profile <dir>] [--data <dir>]
//        pull the whole Space Capital company list and the Find a Space Job directory (the two aerospace-oriented boards)
//
// The crawl itself merges the labels it sees on every fetched job (merge() below), so they refresh with each cycle.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, profileDirFromArgs, resolveDataDir } from './profile.mjs';

import { UA, setUserAgent } from './useragent.mjs';
const FILE_NAME = 'board-labels.json';

export const labelKey = (board, name) => `${board}|${String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;

export function loadLabels(dir) {
  try { return JSON.parse(readFileSync(pathResolve(dir, FILE_NAME), 'utf8')); } catch { return {}; }
}

export function saveLabels(dir, labels) {
  mkdirSync(dir, { recursive: true });
  const f = pathResolve(dir, FILE_NAME);
  writeFileSync(`${f}.tmp`, JSON.stringify(labels) + '\n');
  renameSync(`${f}.tmp`, f);
}

// Keep the richest value per field; lists are replaced by the latest non-empty one.
export function merge(labels, meta, date) {
  if (!meta?.name || !meta.board) return false;
  const k = labelKey(meta.board, meta.name);
  const cur = labels[k] ?? { first_seen: date };
  const next = { ...cur };
  for (const [f, v] of Object.entries(meta)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    next[f] = v;
  }
  next.last_seen = date;
  if (JSON.stringify(cur) === JSON.stringify(next)) return false;
  labels[k] = next;
  return true;
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// Space Capital's Getro collection lists every portfolio company, also those with no open role right now.
export async function enumerateSpaceCapital(collection = '338') {
  const out = [];
  for (let page = 0; page < 200; page++) {
    const r = await post(`https://api.getro.com/api/v2/collections/${collection}/search/companies`, { hitsPerPage: 100, page, query: '' });
    const rows = r.results?.companies ?? [];
    if (!rows.length) break;
    for (const c of rows) {
      out.push({
        board: 'space-capital', id: String(c.id), name: c.name, domain: c.domain ?? '', description: (c.description ?? '').slice(0, 1500),
        industry_tags: c.industry_tags ?? [], topics: c.topics ?? [], head_count: c.head_count ?? null, stage: c.stage ?? null,
        locations: (c.locations ?? []).slice(0, 5), active_jobs: c.active_jobs_count ?? 0,
      });
    }
    await new Promise((r2) => setTimeout(r2, 150));
  }
  return out;
}

// Find a Space Job lists its directory (name, website, description, country, founded year) in the page data of /companies?page=N.
export async function enumerateFindASpaceJob() {
  const out = new Map();
  for (let page = 1; page < 30; page++) {
    const res = await fetch(`https://www.findaspacejob.com/companies${page > 1 ? `?page=${page}` : ''}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) break;
    const html = await res.text();
    const text = [...html.matchAll(/self\.__next_f\.push\(\[1,"(.*?)"\]\)/gs)].map((m) => { try { return JSON.parse(`"${m[1]}"`); } catch { return ''; } }).join('');
    let found = 0;
    for (const m of text.matchAll(/\{"id":"[0-9a-f-]{36}","slug":/g)) {
      let depth = 0, i = m.index, end = -1, inStr = false;
      for (; i < text.length; i++) {
        const ch = text[i];
        if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}' && --depth === 0) { end = i + 1; break; }
      }
      if (end < 0) continue;
      try {
        const c = JSON.parse(text.slice(m.index, end));
        if (!out.has(c.id)) { out.set(c.id, { board: 'findaspacejob', id: c.id, name: c.name, domain: String(c.website ?? '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0],
          description: `${c.description ?? ''} ${c.short_description ?? ''}`.trim().slice(0, 1500), country: c.hq_country_code ?? '', founded: c.founded_year ?? null, active_jobs: c.active_jobs_count ?? 0 }); found++; }
      } catch {}
    }
    if (!found) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return [...out.values()];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === pathResolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const dataArg = args.includes('--data') ? args[args.indexOf('--data') + 1] : undefined;
  const profile = loadProfile(profileDirFromArgs(args));
  setUserAgent(profile?.userAgent);
  const dir = resolveDataDir(dataArg, profile);
  if (args[0] === 'enumerate') {
    const labels = loadLabels(dir);
    const date = new Date().toISOString().slice(0, 10);
    const rows = await enumerateSpaceCapital();
    let changed = 0;
    for (const m of rows) if (merge(labels, m, date)) changed++;
    saveLabels(dir, labels);
    let fasj = [];
    try { fasj = await enumerateFindASpaceJob(); } catch (e) { console.log(`[board-labels] Find a Space Job skipped: ${e.message}`); }
    for (const m of fasj) if (merge(labels, m, date)) changed++;
    saveLabels(dir, labels);
    console.log(`[board-labels] Space Capital: ${rows.length}, Find a Space Job: ${fasj.length}; ${changed} new or changed, ${Object.keys(labels).length} labels in total`);
  } else console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n'));
}
