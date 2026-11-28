#!/usr/bin/env node
// Detector benchmark (JOBCRAWLX row 2A.5): detector v1 (what ships) vs detector v2 (core/detect) on the frozen split.
//
//   node scripts/eval-detect.mjs --split holdout|dev|all [--cache <evalcache dir>] [--tier page|url|both] [--out report.json]
//        [--split-file bench/detect/split-v1.jsonl] [--pages-file bench/detect/split-v2.pages.jsonl] [--min-conf 0.4] [--boot 2000] [--log <file>] [--misses] [--json-only]
//
// Never touches the network: pages come from --cache only (the eval-detect page cache, <id>.json = { url, final, status, html, cname });
// a row whose cached HTML no longer has the sha1 the split recorded is skipped and counted.
// Tiers:
//   page  rows with a usable cached careers page (the input is the employer's careers page; headline), and its "page-needed" subset
//         (rows the careers URL alone does not answer: providers.resolve gives nothing)
//   url   every row, careers URL only: v2 from data alone must agree with v1 (providers.resolve) on provider and slug (coverage check)
// Metrics: per class P/R/F1; macro-F1 over the multi-tenant ATS classes seen in labels or predictions (custom rows are negatives:
// predicting no ATS on them is right; single-employer readers are left out of the average but their wrong predictions still count);
// a secondary macro-F1 with 'custom' as a class (an empty v1 answer = custom); confusion pairs; wins/losses; paired bootstrap of the gap.
import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const flag = (n) => args.includes(`--${n}`);
if (flag('help')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 18).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }

const SPLIT = opt('split', 'holdout'), TIER = opt('tier', 'both'), CACHE = opt('cache'), MIN = Number(opt('min-conf', 0.4)), BOOT = Number(opt('boot', 2000));
const LOG = opt('log');
const t0 = Date.now();
const say = (m) => { const l = `${new Date().toISOString()} [${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`; if (LOG) appendFileSync(LOG, l + '\n'); console.error(l); };
if (!['holdout', 'dev', 'all'].includes(SPLIT)) { console.error('--split holdout|dev|all'); process.exit(2); }

const { detect, detectOffline, FINGERPRINTS, best } = await import('../core/detect/index.mjs');
const { detectV1 } = await import('../core/detect/v1.mjs');
const { resolve: resolveEntry } = await import('../crawler/providers.mjs');

const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');
const rows = readFileSync(opt('split-file', join(ROOT, 'bench/detect/split-v1.jsonl')), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => SPLIT === 'all' || r.split === SPLIT);
const KIND = new Map(FINGERPRINTS.filter((p) => p.provider).map((p) => [p.provider, p.kind]));
const GENERIC = new Set(['jsonld_direct', 'sitemap', 'paginated_list']);
const cls = (p) => (!p ? 'custom' : GENERIC.has(p) ? 'custom' : p);
say(`start split=${SPLIT} rows=${rows.length} tier=${TIER} cache=${CACHE ?? '(none)'} min_conf=${MIN}`);

// v1 top-1: the first hit with a provider; v2 top-1: the best candidate at or above MIN (generic candidates map to 'custom')
const v1Top = (hits) => hits.find((h) => h.provider) ?? null;
const v2Top = (cands) => best(cands, { minConfidence: MIN });

function scoreSet(list, key, { customClass = false } = {}) {
  const per = {};
  const bump = (k, f) => { per[k] ??= { tp: 0, fp: 0, fn: 0, n: 0 }; per[k][f]++; };
  for (const r of list) {
    const y = r.label, p = r[key];
    const yk = customClass || y !== 'custom' ? y : null;
    const pk = customClass || p !== 'custom' ? p : null;
    if (yk) { per[yk] ??= { tp: 0, fp: 0, fn: 0, n: 0 }; per[yk].n++; }
    if (pk && pk === yk) bump(pk, 'tp');
    else { if (pk) bump(pk, 'fp'); if (yk) bump(yk, 'fn'); }
  }
  const f = (x) => { const P = x.tp + x.fp ? x.tp / (x.tp + x.fp) : 0, R = x.tp + x.fn ? x.tp / (x.tp + x.fn) : 0; return { ...x, p: +P.toFixed(3), r: +R.toFixed(3), f1: +(P + R ? (2 * P * R) / (P + R) : 0).toFixed(3) }; };
  const scored = Object.fromEntries(Object.entries(per).map(([k, x]) => [k, f(x)]));
  // macro over multi-tenant classes (single-employer readers and, unless asked, custom stay out of the average)
  const avgKeys = Object.keys(scored).filter((k) => KIND.get(k) !== 'site' && (customClass || k !== 'custom'));
  const macro = avgKeys.length ? avgKeys.reduce((a, k) => a + scored[k].f1, 0) / avgKeys.length : 0;
  const micro = (() => { const s = avgKeys.reduce((a, k) => ({ tp: a.tp + scored[k].tp, fp: a.fp + scored[k].fp, fn: a.fn + scored[k].fn }), { tp: 0, fp: 0, fn: 0 }); return f({ ...s, n: 0 }); })();
  return { macro_f1: +macro.toFixed(4), classes: avgKeys.length, micro: { p: micro.p, r: micro.r, f1: micro.f1 }, per: Object.fromEntries(Object.entries(scored).sort((a, b) => b[1].n - a[1].n)) };
}

function bootstrap(list, ka, kb, opts) {
  if (!list.length) return null;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const diffs = [];
  for (let i = 0; i < BOOT; i++) {
    const s = Array.from({ length: list.length }, () => list[Math.floor(rnd() * list.length)]);
    diffs.push(scoreSet(s, kb, opts).macro_f1 - scoreSet(s, ka, opts).macro_f1);
  }
  diffs.sort((a, b) => a - b);
  return { lo: +diffs[Math.floor(0.025 * BOOT)].toFixed(4), hi: +diffs[Math.floor(0.975 * BOOT)].toFixed(4), p_le_0: +(diffs.filter((d) => d <= 0).length / BOOT).toFixed(4) };
}

function confusions(list, key, n = 10) {
  const c = new Map();
  for (const r of list) if (r[key] !== r.label) { const k = `${r.label} -> ${r[key]}`; c.set(k, (c.get(k) ?? 0) + 1); }
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([pair, count]) => ({ pair, count }));
}

function report(list, name) {
  const out = { rows: list.length };
  for (const [tag, opts] of [['ats', {}], ['with_custom', { customClass: true }]]) {
    out[tag] = { v1: scoreSet(list, 'v1', opts), v2: scoreSet(list, 'v2', opts), gap_ci95: bootstrap(list, 'v1', 'v2', opts) };
  }
  out.wins = list.filter((r) => r.v2 === r.label && r.v1 !== r.label).length;
  out.losses = list.filter((r) => r.v1 === r.label && r.v2 !== r.label).length;
  out.confusions = { v1: confusions(list, 'v1'), v2: confusions(list, 'v2') };
  out.v2_slug_acc = (() => { const ok = list.filter((r) => r.label !== 'custom' && r.v2 === r.label); return ok.length ? +(ok.filter((r) => r.v2slugOk).length / ok.length).toFixed(3) : null; })();
  out.v2_generic_subtype_acc = (() => { const c = list.filter((r) => r.label === 'custom' && r.v2 === 'custom' && r.v2generic); return c.length ? { n: c.length, acc: +(c.filter((r) => r.v2generic === r.provider).length / c.length).toFixed(3) } : null; })();
  say(`${name}: rows=${list.length} macroF1(ats) v1=${out.ats.v1.macro_f1} v2=${out.ats.v2.macro_f1} gap95=[${out.ats.gap_ci95?.lo}, ${out.ats.gap_ci95?.hi}] | with_custom v1=${out.with_custom.v1.macro_f1} v2=${out.with_custom.v2.macro_f1} | wins=${out.wins} losses=${out.losses}`);
  return out;
}

const normSlug = (s) => String(s ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const result = { at: new Date().toISOString(), split: SPLIT, split_file_rows: rows.length, min_conf: MIN, cache: !!CACHE };

if (TIER === 'page' || TIER === 'both') {
  if (!CACHE) say('page tier skipped: no --cache (URL-only results below)');
  else {
    const list = [], skipped = { no_page: 0, missing_file: 0, sha_mismatch: 0 };
    // --pages-file (split v2): the page manifest frozen after the fetch, { id, usable, html_sha1, follow_url, follow_sha1 } per row
    const pinned = new Map();
    if (opt('pages-file')) for (const l of readFileSync(opt('pages-file'), 'utf8').split('\n')) if (l.trim()) { const x = JSON.parse(l); pinned.set(x.id, x); }
    const publicDns = async () => [{ address: '93.184.216.34' }];   // cached pages only: the guard's DNS hook never resolves anything
    let i = 0;
    for (const r of rows) {
      if (pinned.size) r.page = pinned.get(r.id) ?? null;
      if (!r.page?.usable) { skipped.no_page++; continue; }
      const f = join(CACHE, r.id + '.json');
      if (!existsSync(f)) { skipped.missing_file++; continue; }
      const p = JSON.parse(readFileSync(f, 'utf8'));
      if (sha1(p.html) !== r.page.html_sha1 || (r.page.follow_sha1 && sha1(p.follow?.html ?? '') !== r.page.follow_sha1)) { skipped.sha_mismatch++; continue; }
      const input = { url: r.url, finalUrl: p.final || r.url, html: p.html, cname: p.cname || '' };
      const h1 = v1Top(detectV1(input));
      const res = detectOffline(input);
      const t2 = v2Top(res.candidates);
      const urlOnly = !!resolveEntry({ careers_url: r.url });
      // two-page tier (split v2 caches the first follow): v1 reads the follow page when page 1 gave no provider; v2 runs detect() over
      // the same cached pages through a cache-only fetch (its own follow rule decides; a page not in the cache is a failed request)
      let two = null;
      if ('follow' in p) {
        const f = p.follow && p.follow.html && p.follow.status < 400 ? p.follow : null;
        const h1b = h1 ?? (f ? v1Top(detectV1({ url: f.url, finalUrl: f.final || f.url, html: f.html })) : null);
        const nrm = (u) => { try { return new URL(String(u)).href; } catch { return String(u); } };
        const served = new Map([[nrm(r.url), { final: p.final || r.url, html: p.html, status: p.status }], ...(f ? [[nrm(f.url), { final: f.final || f.url, html: f.html, status: f.status }]] : [])]);
        const cacheFetch = async (u) => {
          const x = served.get(nrm(u));
          if (!x) throw new Error(`not in cache: ${u}`);
          return { status: x.status, url: x.final, headers: new Headers({ 'content-type': 'text/html' }), text: async () => x.html };
        };
        const r2 = await detect({ url: r.url, cname: p.cname || '', fetch: cacheFetch, lookupImpl: publicDns, follow: 1 });
        const t2b = v2Top(r2.candidates);
        two = { v1: cls(h1b?.provider), v2: cls(t2b?.provider), v2slugOk: !!t2b && (!r.slug || normSlug(t2b.slug) === normSlug(r.slug)), v2generic: t2b && GENERIC.has(t2b.provider) ? t2b.provider : null, followed: r2.fetched.length > 1, top3: r2.candidates.slice(0, 3).map((c) => `${c.provider}:${c.confidence}`) };
      }
      list.push({ two, stand_in: r.stand_in ?? null, id: r.id, name: r.name, url: r.url, label: r.label, provider: r.provider, slug: r.slug, urlOnly,
        v1: cls(h1?.provider), v1slug: h1?.slug ?? null, v2: cls(t2?.provider), v2slug: t2?.slug ?? null,
        v2slugOk: !!t2 && (!r.slug || normSlug(t2.slug) === normSlug(r.slug)), v2generic: t2 && GENERIC.has(t2.provider) ? t2.provider : null,
        v2top3: res.candidates.slice(0, 3).map((c) => `${c.provider}:${c.confidence}`) });
      if (++i % 100 === 0) say(`page progress ${i} rows`);
    }
    result.page = { skipped, all: report(list, 'page/all'), page_needed: report(list.filter((r) => !r.urlOnly), 'page/page-needed') };
    const twoList = list.filter((r) => r.two).map((r) => ({ ...r, ...r.two }));
    if (twoList.length) {
      result.page.two_page = report(twoList, 'two-page/all');
      result.page.two_page_followed = twoList.filter((r) => r.followed).length;
      const si = twoList.filter((r) => r.stand_in);
      result.page.stand_in = { rows: si.length, list: si.map((r) => ({ name: r.name, stand_in: r.stand_in, v1: r.v1, v2: r.v2 })) };
      result.page.two_page_without_stand_in = report(twoList.filter((r) => !r.stand_in), 'two-page/no-stand-in');
      // post-hoc diagnostic, not a label: custom rows where both detectors name the same ATS (likely a generic reader standing in)
      result.page.both_name_same_ats_on_custom = twoList.filter((r) => r.label === 'custom' && r.v1 !== 'custom' && r.v1 === r.v2).map((r) => ({ name: r.name, ats: r.v1 }));
      if (flag('misses')) result.page.two_page_misses = twoList.filter((r) => r.v1 !== r.label || r.v2 !== r.label).map((r) => ({ name: r.name, url: r.url, label: r.label, v1: r.v1, v2: r.v2, top3: r.top3 }));
    }
    if (flag('misses')) result.page.misses = list.filter((r) => r.v1 !== r.label || r.v2 !== r.label).map((r) => ({ name: r.name, url: r.url, label: r.label, v1: r.v1, v2: r.v2, top3: r.v2top3 }));
  }
}

if (TIER === 'url' || TIER === 'both') {
  let agree = 0, slugAgree = 0, v1hit = 0, v2only = 0, v1only = 0;
  const disagree = [];
  const list = [];
  for (const r of rows) {
    const h1 = resolveEntry({ careers_url: r.url });
    const t2 = v2Top(detectOffline({ url: r.url }).candidates);
    list.push({ label: r.label, provider: r.provider, v1: cls(h1?.provider), v2: cls(t2?.provider), v2slugOk: !!t2 && (!r.slug || normSlug(t2.slug) === normSlug(r.slug)) });
    if (h1) v1hit++;
    if (h1 && t2 && h1.provider === t2.provider) { agree++; if (normSlug(h1.slug) === normSlug(t2.slug)) slugAgree++; else if (disagree.length < 25) disagree.push({ url: r.url, provider: h1.provider, v1: h1.slug, v2: t2.slug }); }
    else if (h1 && !t2) { v1only++; if (disagree.length < 25) disagree.push({ url: r.url, v1: `${h1.provider}:${h1.slug}`, v2: null }); }
    else if (!h1 && t2) v2only++;
    else if (h1 && t2 && disagree.length < 25) disagree.push({ url: r.url, v1: `${h1.provider}:${h1.slug}`, v2: `${t2.provider}:${t2.slug}` });
  }
  result.url = { rows: rows.length, v1_hits: v1hit, provider_agree: agree, slug_agree: slugAgree, v1_only: v1only, v2_only: v2only, disagreements: disagree, metrics: report(list, 'url/all') };
  say(`url parity: v1 hits ${v1hit}, same provider ${agree}, same slug ${slugAgree}, v1-only ${v1only}, v2-only ${v2only}`);
}

if (opt('out')) writeFileSync(opt('out'), JSON.stringify(result, null, 1));
// the per-class table (both detectors side by side) for each page subset, then the confusion pairs
function table(x, title) {
  if (!x) return;
  const pad = (v, n) => String(v ?? '-').padStart(n);
  const lines = [`\n${title}: ${x.rows} rows; macro-F1 (ATS classes) v1 ${x.ats.v1.macro_f1} | v2 ${x.ats.v2.macro_f1}  gap 95% [${x.ats.gap_ci95?.lo}, ${x.ats.gap_ci95?.hi}]; with custom v1 ${x.with_custom.v1.macro_f1} | v2 ${x.with_custom.v2.macro_f1}; wins ${x.wins} losses ${x.losses}`,
    `${'class'.padEnd(24)}${pad('n', 4)}   ${pad('v1 P', 6)}${pad('R', 6)}${pad('F1', 6)}   ${pad('v2 P', 6)}${pad('R', 6)}${pad('F1', 6)}`];
  const per1 = x.with_custom.v1.per, per2 = x.with_custom.v2.per;
  for (const k of [...new Set([...Object.keys(per1), ...Object.keys(per2)])].sort((a, b) => ((per2[b] ?? per1[b]).n - (per2[a] ?? per1[a]).n) || a.localeCompare(b))) {
    const a = per1[k] ?? {}, b = per2[k] ?? {};
    lines.push(`${(k + (KIND.get(k) === 'site' ? ' (site)' : '')).padEnd(24)}${pad(a.n ?? b.n, 4)}   ${pad(a.p, 6)}${pad(a.r, 6)}${pad(a.f1, 6)}   ${pad(b.p, 6)}${pad(b.r, 6)}${pad(b.f1, 6)}`);
  }
  lines.push(`confusions v1: ${x.confusions.v1.map((c) => `${c.pair} (${c.count})`).join(', ')}`);
  lines.push(`confusions v2: ${x.confusions.v2.map((c) => `${c.pair} (${c.count})`).join(', ')}`);
  console.log(lines.join('\n'));
}
if (!flag('json-only')) { table(result.page?.two_page, `two-page tier, ${SPLIT}`); table(result.page?.all, `page tier, ${SPLIT}`); table(result.page?.page_needed, `page tier (page needed), ${SPLIT}`); }
const brief = (x) => x && { rows: x.rows, ats_macro_f1: { v1: x.ats.v1.macro_f1, v2: x.ats.v2.macro_f1, gap_ci95: x.ats.gap_ci95 }, with_custom_macro_f1: { v1: x.with_custom.v1.macro_f1, v2: x.with_custom.v2.macro_f1 }, wins: x.wins, losses: x.losses, top_confusions_v1: x.confusions.v1.slice(0, 5), top_confusions_v2: x.confusions.v2.slice(0, 5) };
console.log(JSON.stringify({ split: SPLIT, page_all: brief(result.page?.all), page_needed: brief(result.page?.page_needed), url: result.url && { ...brief(result.url.metrics), provider_agree: result.url.provider_agree, slug_agree: result.url.slug_agree, v1_hits: result.url.v1_hits, v1_only: result.url.v1_only } }, null, 1));
say('done');
