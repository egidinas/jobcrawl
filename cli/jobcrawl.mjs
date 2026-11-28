#!/usr/bin/env node
// jobcrawl: one command line for the multitool (design §5.1). Phase 0: additive. The live crawl keeps running on crawler/crawl.mjs;
// the commands here use the new per-board path (core/) only on their own data folders, or read files.
//
// Contract: no arguments, `help`, `--help` or `-h` print the usage and exit 0 before any module that can touch the network is loaded.
// `--json` puts machine output on stdout and nothing else there. Never prompts. Exit codes: 0 ok, 1 some boards failed, 2 usage or
// config error, 3 lease held by another run.
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help';
const rest = argv.slice(cmd === 'help' && argv[0] !== 'help' ? 0 : 1);
const flag = (n) => rest.includes(`--${n}`);
const opt = (n, d) => (rest.includes(`--${n}`) ? rest[rest.indexOf(`--${n}`) + 1] : d);
const JSON_OUT = flag('json');

const USAGE = `jobcrawl <command> [options]

commands (phase 0):
  providers [--json]                         list the sources (ATS adapters and readers)
  detect <url> [--page] [--json]             which source reads this URL; --page also fetches the page (public addresses only) and
                                             scores platform signals (fingerprints.json: hosts, CNAME, embeds, markup)
  route [--routing <file>] [--board <name>] [--provider <id>] [--json]
                                             the strangler-fig route of a board (legacy | shadow | new)
  crawl --board <name> --profile <dir> --data <dir> [--replay <recording>] [--routing <file>] [--json]
                                             one board on the new per-board path, into its own data folder (never a live one);
                                             a live read (no --replay) needs the board routed shadow or new and the kill switch off
  dual-run --profile <dir> --data <dir> --legacy-data <dir> --replay <recording> [--routing <file>] [--ledger <file>]
           [--boards all|routed] [--companies <file>] [--lifecycle <state.json> | --no-lifecycle] [--skew-min 60] [--report <file>] [--json]
                                             shadow run from a recording (no second live crawl), compared with the legacy history
  import --profile <dir> --data <dir> --legacy-data <dir> [--companies <file>] [--boards all|routed] [--routing <file>] [--replace] [--json]
  ledger-shadow --shadow <store> --lifecycle <state.json> --ledger <file> [--routing <file>] [--companies <file>] [--max-gap-min 90] [--json]
                                             per-cycle same-fetch parity of the shadow store into the migration ledger
                                             baseline epoch from the legacy history, without events (read-only on the legacy side)
  snapshot --data <dir> [--status open|departed|all] [--store json|sqlite]
           [--format ndjson|jsonfeed|rss [--from delta|resolved] [--fields a,b] [--out <file>] [--title t] [--link url] [--feed-url url]]
                                             a full snapshot, rendered (default fields: title, company, location, url, date_posted, first_seen,
                                             excerpt; description only by naming it in --fields; private fields are refused)
                                             full read as NDJSON (header with per-board watermarks, then postings; sqlite adds the
                                             global event_id watermark)
  feed --data <dir> [--since <board=seq,...> | --since-json '{"board": seq}'] [--store json|sqlite]   committed delta events as NDJSON
  feed --data <dir> --store sqlite [--after <event_id> | --consumer <name> [--commit]] [--limit <n>]
       [--format ndjson|jsonfeed|rss [--from delta|resolved] [--fields a,b] [--out <file>]]
                                             with --format: the additions after the bookmark, rendered; --commit moves the consumer's
                                             bookmark only after the file is written (resolved stream: its own seq cursor)
                                             records after a global event_id (or a consumer's bookmark; --commit moves the bookmark
                                             to the last record written)
  bookmark get|set|list --data <dir> [--consumer <name>] [--event-id <n>] [--json]   named consumer bookmarks (sqlite store)
  store-import --data <dir> [--from <json data dir>] [--replace] [--json]
                                             JSON board states -> <data>/store.sqlite, without events (read-only on the JSON side)
  run [--profile <dir>] [--data <dir>] [--routing <file>] [--board <name>] [--replay <recording>] [--max-minutes <n>] [--every-min <n>]
      [--daemon [--interval-min <n>]] [--metrics [host]:port] [--log-format json|text] [--log-file <file>] [--strict] [--stale-hours <n>]
      [--store json|sqlite] [--resolve [--legacy-data <dir>]] [--json]
                                             headless run of every routed board on the new path; resumable, SIGTERM-safe, never prompts
                                             (profile and data may come from JOBCRAWL_PROFILE and JOBCRAWL_DATA); see docs/HEADLESS.md;
                                             --resolve (default off): then one resolver run over what the boards committed (sqlite)
  resolve --data <dir> [--store sqlite] [--profile <dir> | --companies <file>] [--legacy-data <dir>] [--rules legacy|lifecycle]
          [--batch <n>] [--max-events <n>] [--json]
                                             the cross-board resolver job (row 1.4): crosslist dups, admission, protected set, the
                                             3-day sweep and unknown, over the store's per-board events from its bookmark; one lease,
                                             one checkpoint per batch, writes the resolved/v1 stream (sqlite store only)
  resolved --data <dir> [--after <seq>] [--limit <n>] | [--groups [--status open|dup|hidden|departed|unknown]] | [--derived]
                                             the resolved/v1 stream as NDJSON, the resolver's groups, or its derived protected set
  doctor [--profile <dir>] [--data <dir>] [--routing <file>] [--json] [--strict]
                                             read-only checks: Node, node:sqlite, profile, user agent, data folder, routing;
                                             --strict exits 5 when a check warns

  --no-excerpt                               (crawl, run) do not store the description excerpt (stored by default for these two; opt-in elsewhere:
                                             JOBCRAWL_STORE_TEXT=1 or "store": { "excerpt": true } in profile.json)
  --keep-description                         (crawl, run, import and the store commands) also keep the full description beside the stored excerpt;
                                             same as JOBCRAWL_KEEP_DESCRIPTION=1 or "store": { "keep_description": true } in profile.json; default off

  --help, -h, help                           this text (no network, no writes)
exit codes: 0 ok, 1 some boards failed, 2 usage or config error (or a live read the routing does not allow), 3 lease or run lock held,
            4 state store error, 5 --strict found a warning (doctor, run), 130/143 interrupted by SIGINT/SIGTERM with the state consistent
environment: JOBCRAWL_ROUTE_KILL=1|true|yes|on sends every board to legacy (no live read by this tool); JOBCRAWL_ROUTING=<file>`;

const out = (obj, text) => { if (JSON_OUT) process.stdout.write(JSON.stringify(obj) + '\n'); else console.log(text ?? JSON.stringify(obj, null, 1)); };
const fail = (msg, code = 2) => { if (JSON_OUT) process.stdout.write(JSON.stringify({ error: msg }) + '\n'); else console.error(`jobcrawl ${cmd}: ${msg}`); process.exit(code); };

if (cmd === 'help' || flag('help') || rest.includes('-h')) { console.log(USAGE); process.exit(0); }
// node:sqlite (leases, the SQLite store, the queue) prints one ExperimentalWarning on Node 22; the CLI drops that warning only
(await import('../core/state/sqlite-load.mjs')).quietSqliteWarning();

const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
const { join, dirname, resolve: pathResolve } = await import('node:path');
// store.keep_description: the flag, the environment or the profile; the stores and runBoard read the environment variable
// The description excerpt is opt-in: on for run and crawl (unless --no-excerpt), or with store.excerpt in the profile, or JOBCRAWL_STORE_TEXT=1.
if (flag('keep-description')) process.env.JOBCRAWL_KEEP_DESCRIPTION = '1';
let profileStore = {};
if (opt('profile')) { try { profileStore = JSON.parse(readFileSync(join(pathResolve(opt('profile')), 'profile.json'), 'utf8')).store ?? {}; } catch {} }
if (!process.env.JOBCRAWL_KEEP_DESCRIPTION && profileStore.keep_description === true) process.env.JOBCRAWL_KEEP_DESCRIPTION = '1';
if (!flag('no-excerpt') && (cmd === 'run' || cmd === 'crawl' || profileStore.excerpt === true)) process.env.JOBCRAWL_STORE_TEXT ||= '1';
const { gunzipSync } = await import('node:zlib');

function guardDataDir(dir) {
  if (!dir) fail('--data <dir> is required');
  const d = pathResolve(dir);
  if (existsSync(join(d, 'scan-history.tsv')) || existsSync(join(d, 'crawl-state.json'))) fail(`${d} holds a legacy crawl state (scan-history.tsv / crawl-state.json); the new path never writes into a legacy data folder`);
  return d;
}
function loadRecordedRun(recDir, board, boardKey) {
  const f = join(recDir, 'lists', `${boardKey(board)}.json.gz`);
  if (!existsSync(f)) return null;
  const l = JSON.parse(gunzipSync(readFileSync(f)).toString('utf8'));
  return { ok: true, items: l.items, complete: l.complete !== false, emptyOk: l.emptyOk === true, provider: l.provider, recorded_at: l.t };
}
function companiesOf(profileDir) {
  const { loadProfile } = PROFILE_MOD;
  const p = loadProfile(profileDir);
  if (!p) fail('--profile <dir> is required');
  const file = opt('companies') ? pathResolve(opt('companies')) : p.companiesFile;
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const seen = new Set();
  return { profile: p, companies: (cfg.tracked_companies ?? []).filter((e) => e.enabled !== false && e.name && !seen.has(e.name) && seen.add(e.name)) };
}
/** The per-board outcome lines of a recording (bench/record.mjs boards.jsonl): Map(board -> line). */
function recordedOutcomes(recDir) {
  const f = join(recDir, 'boards.jsonl'), m = new Map();
  if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n')) { try { const o = JSON.parse(l); m.set(o.board, o); } catch {} }
  return m;
}
let PROFILE_MOD;
const storeKind = () => { const k = opt('store', process.env.JOBCRAWL_STORE || 'json'); if (k !== 'json' && k !== 'sqlite') fail(`--store expects json or sqlite (got "${k}")`); return k; };
async function openStoreOr(data, kind, code = 4) {
  const { openStore } = await import('../core/state/store.mjs');
  try { return await openStore(data, { kind, keepDescription: /^(1|true|yes|on)$/i.test(process.env.JOBCRAWL_KEEP_DESCRIPTION ?? ''), storeText: /^(1|true|yes|on)$/i.test(process.env.JOBCRAWL_STORE_TEXT ?? '') }); } catch (e) { fail(e.message, code); }
}

/** Resolver config: the registry entries (aggregator boards, providers, probation) and the catalogue names, from --profile or --companies. */
async function resolverConfig() {
  let companies = [], catalogue = [];
  if (opt('profile')) {
    PROFILE_MOD ??= await import('../crawler/profile.mjs');
    let p;
    try { ({ profile: p, companies } = companiesOf(opt('profile'))); } catch (e) { fail(`profile: ${e.message}`); }
    catalogue = (await import('../crawler/relevance.mjs')).loadCatalogueNames(p.catalogueFile);
  } else if (opt('companies')) {
    try { companies = JSON.parse(readFileSync(pathResolve(opt('companies')), 'utf8')).tracked_companies ?? []; } catch (e) { fail(`--companies: ${e.message}`); }
  }
  return { companies, catalogue };
}
/** Resolver facts: from a legacy data folder (read-only) with --legacy-data, else from the events' own fields. */
async function resolverFacts(config) {
  const f = await import('../core/resolve/facts.mjs');
  if (!opt('legacy-data')) return f.defaultFacts;
  const dir = pathResolve(opt('legacy-data'));
  if (!existsSync(join(dir, 'scan-history.tsv'))) fail(`--legacy-data ${dir} has no scan-history.tsv`);
  const { isAggregatorEntry, isAggregatorRow } = await import('../crawler/crosslist.mjs');
  const boardNames = new Set(config.companies.filter(isAggregatorEntry).map((c) => c.name));
  return f.legacyFacts(dir, { isAggregator: (row) => isAggregatorRow(row, boardNames) });
}

/** Output options of snapshot/feed --format: format, source stream, field allowlist (private fields refused, exit 2), render options. */
async function outputOptions() {
  const { FORMATS } = await import('../core/outputs/render.mjs');
  const { parseFields, FieldError } = await import('../core/outputs/fields.mjs');
  const { SOURCES } = await import('../core/outputs/source.mjs');
  const format = opt('format');
  if (!FORMATS.includes(format)) fail(`--format expects ${FORMATS.join(', ')} (got "${format}")`);
  const from = opt('from', 'delta');
  if (!SOURCES.includes(from)) fail(`--from expects ${SOURCES.join(' or ')} (got "${from}")`);
  let fields;
  try { fields = parseFields(opt('fields')); } catch (e) { if (e instanceof FieldError) fail(e.message); throw e; }
  const now = opt('now') ? new Date(opt('now')) : new Date();
  if (Number.isNaN(now.getTime())) fail(`--now expects an ISO time (got "${opt('now')}")`);
  const r = { fields, from, now };
  for (const [k, n] of [['title', 'title'], ['link', 'link'], ['feedUrl', 'feed-url'], ['description', 'description']]) if (opt(n)) r[k] = opt(n);
  return { format, from, out: opt('out'), render: r };
}
function writeOutput(file, text) {
  if (!file) { process.stdout.write(text); return; }
  const f = pathResolve(file);
  try { writeFileSync(f, text); } catch (e) { fail(`--out ${f}: ${e.message}`, 4); }
}

switch (cmd) {
  case 'providers': {
    const { providers } = await import('../crawler/providers.mjs');
    const rows = Object.entries(providers).map(([id, p]) => ({ id, detail: typeof p.fetchDescription === 'function', detects: typeof p.detect === 'function' }));
    out(JSON_OUT ? { providers: rows } : null, `${rows.length} sources\n` + rows.map((r) => `${r.id}${r.detail ? ' (detail)' : ''}`).join('\n'));
    break;
  }
  case 'detect': {
    const url = rest.find((a) => !a.startsWith('--'));
    if (!url) fail('detect <url>');
    // crawler/profiler/detect-page.mjs: URL match, and with --page the page through the SSRF guard, link fingerprints and detector v2
    const { detectPage } = await import('../crawler/profiler/detect-page.mjs');
    const res = await detectPage(url, { page: flag('page') });
    out(res, res.hits.length ? res.hits.map((h) => `${h.provider}:${h.slug} (${h.evidence.map((e) => e.type).join(',')})`).join('\n') : 'no source recognised');
    break;
  }
  case 'route': {
    const { loadRouting, routeFor } = await import('../core/route/router.mjs');
    let routing;
    try { routing = loadRouting(opt('routing')); } catch (e) { fail(e.message); }
    const r = routeFor(routing, { board: opt('board'), provider: opt('provider') });
    out({ ...r, routing: opt('routing') ?? null }, `${r.route} (${r.why})`);
    break;
  }
  case 'crawl': {
    const board = opt('board');
    if (!board) fail('--board <name> is required');
    const data = guardDataDir(opt('data'));
    PROFILE_MOD = await import('../crawler/profile.mjs');
    const { profile, companies } = companiesOf(opt('profile'));
    const entry = companies.find((e) => e.name === board);
    if (!entry) fail(`no enabled board named "${board}" in ${profile.companiesFile}`);
    const { boardKey } = await import('../core/state/board-store.mjs');
    let read;
    if (opt('replay')) { read = loadRecordedRun(pathResolve(opt('replay')), board, boardKey); if (!read) fail(`board "${board}" is not in the recording ${opt('replay')}`); }
    else {
      // a live read obeys the strangler-fig façade: kill switch off and the board routed shadow or new
      const { loadRouting, routeFor } = await import('../core/route/router.mjs');
      let routing;
      try { routing = loadRouting(opt('routing') ?? process.env.JOBCRAWL_ROUTING); } catch (e) { fail(e.message); }
      const { resolve: resolveEntry } = await import('../crawler/providers.mjs');
      const rt = routeFor(routing, { board, provider: resolveEntry(entry)?.provider ?? null });
      if (rt.route === 'legacy') fail(`board "${board}" is routed legacy (${rt.why}): no live read on the new path (use --replay, or route it shadow)`);
      (await import('../crawler/useragent.mjs')).setUserAgent(profile.userAgent);
      const pol = await import('../crawler/policy.mjs');
      pol.configurePolicy({ ...pol.policyFromProfile(profile, data) });
      pol.installGuard({ egress: true });   // new path: the egress guard sits inside the policy guard, so robots.txt and policy redirects pass it (JOBCRAWL_ALLOW_PRIVATE_TARGETS=1 opts out)
      (await import('../crawler/providers.mjs')).setCacheDir(join(data, 'cache'));
    }
    const { runBoard } = await import('../core/run-board.mjs');
    const r = await runBoard(data, entry, { read });
    if (r.skipped) fail(r.skipped, 3);
    const counts = {};
    for (const e of r.events) counts[e.op] = (counts[e.op] ?? 0) + 1;
    out({ board, ok: r.run.ok, error: r.run.error ?? null, seqFrom: r.seqFrom, seqTo: r.seqTo, counts },
      `${board}: ${r.run.ok ? 'ok' : `failed (${r.run.error?.cls})`}; events ${JSON.stringify(counts)}; seq ${r.seqFrom}..${r.seqTo}`);
    process.exit(r.run.ok ? 0 : 1);
  }
  case 'dual-run': {
    const data = guardDataDir(opt('data'));
    const legacy = opt('legacy-data'), rec = opt('replay');
    if (!legacy || !rec) fail('--legacy-data <dir> and --replay <recording> are required (shadow runs replay a recording; they never crawl live)');
    if (pathResolve(legacy) === data) fail('--data must differ from --legacy-data');
    PROFILE_MOD = await import('../crawler/profile.mjs');
    const { companies } = companiesOf(opt('profile'));
    const { loadRouting, routeFor } = await import('../core/route/router.mjs');
    const { legacyRowsByBoard, compareBoard, byProvider, PARITY_SCHEMA, lifecycleIndex, lifecycleFirstSeen, historyRowsForUrls } = await import('../core/route/parity.mjs');
    const { loadLedger, saveLedger, recordParity, ledgerSummary } = await import('../core/route/ledger.mjs');
    const { boardKey } = await import('../core/state/board-store.mjs');
    const { runBoard } = await import('../core/run-board.mjs');
    const { openPostings, LEGACY_RULES } = await import('../core/delta/board-delta.mjs');
    const { resolve } = await import('../crawler/providers.mjs');
    let routing;
    try { routing = loadRouting(opt('routing')); } catch (e) { fail(e.message); }
    const all = opt('boards', 'routed') === 'all';
    const picked = companies.map((e) => ({ e, provider: resolve(e)?.provider ?? null }))
      .filter(({ e, provider }) => all || routeFor(routing, { board: e.name, provider }).route !== 'legacy');
    const t0 = Date.now();
    console.error(`[dual-run] start boards=${picked.length} replay=${rec} legacy=${legacy} data=${data}`);
    const outcomes = recordedOutcomes(pathResolve(rec));
    // The legacy side: with --lifecycle (or <legacy data>/lifecycle/state.json when present) the legacy crawl's latest answer of the SAME
    // board, attributed by url, with its fetch time (the gap to the replayed answer is reported; a differing board with a gap over
    // --skew-min minutes is 'skew', not 'fail'); otherwise the history rows of the board's company name (the first method).
    const lcFile = opt('lifecycle') ? pathResolve(opt('lifecycle')) : join(pathResolve(legacy), 'lifecycle', 'state.json');
    const useLc = !flag('no-lifecycle') && existsSync(lcFile);
    const skewMin = Number(opt('skew-min', 60));
    let legacyRows, fetches = null, urlBoard = null, firstSeen = null;
    try {
      if (useLc) {
        const idx = lifecycleIndex(lcFile);
        urlBoard = idx.urlBoard;
        fetches = new Map(picked.map(({ e }) => [e.name, idx.fetches.get(e.name)]).filter(([, f]) => f));
        firstSeen = lifecycleFirstSeen(join(dirname(lcFile), 'events'), [...fetches.values()].flatMap((f) => f.urls));
        const rowsByUrl = await historyRowsForUrls(join(pathResolve(legacy), 'scan-history.tsv'), [...fetches.values()].flatMap((f) => f.urls));
        legacyRows = new Map([...fetches].map(([b, f]) => [b, f.urls.map((u) => rowsByUrl.get(u) ?? { url: u, title: '', location: '' })]));
      } else legacyRows = await legacyRowsByBoard(join(pathResolve(legacy), 'scan-history.tsv'), picked.map(({ e }) => e.name));
    } catch (e) { fail(e.message); }
    console.error(`[dual-run] legacy side: ${useLc ? `lifecycle state ${lcFile} (latest fetch per board)` : 'history by company name'}`);
    const reports = [];
    let k = 0;
    for (const { e, provider } of picked) {
      const read = loadRecordedRun(pathResolve(rec), e.name, boardKey);
      const recLine = outcomes.get(e.name);
      if (!read && recLine && !recLine.ok) reports.push({ board: e.name, provider, error: `recorded failure ${recLine.cls ?? 'OTHER'}` });
      else if (!read) reports.push({ board: e.name, provider, error: 'not in the recording' });
      else {
        const r = await runBoard(data, e, { read, rules: LEGACY_RULES });
        if (r.skipped) reports.push({ board: e.name, provider, error: r.skipped });
        else {
          const f = fetches?.get(e.name);
          const c = compareBoard(legacyRows.get(e.name) ?? [], openPostings(r.state), { sameFetch: useLc, ownBoard: e.name, urlBoard, complete: read.complete !== false, newAt: read.recorded_at ? Date.parse(read.recorded_at) : null, firstSeen });
          if (useLc && !f && c.verdict !== 'empty') c.verdict = 'no-legacy';   // the legacy crawl has no answer of this board (probation-disabled, not due, ...)
          const gap = f && read.recorded_at ? Math.round(Math.abs(Date.parse(read.recorded_at) - f.at) / 60000) : null;
          if (useLc && (c.verdict === 'fail' || c.verdict === 'near') && gap != null && gap > skewMin) c.verdict = 'skew';
          reports.push({ board: e.name, provider, ...c, ...(useLc ? { gap_min: gap, legacy_fetch: f ? new Date(f.at).toISOString() : null } : {}) });
        }
      }
      if (++k % 100 === 0) console.error(`[dual-run] ${k}/${picked.length} boards, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
    const report = { schema: PARITY_SCHEMA, t: new Date().toISOString(), source: `replay:${rec}`, boards: reports, providers: byProvider(reports) };
    if (opt('report')) writeFileSync(pathResolve(opt('report')), JSON.stringify(report, null, 1));
    let summary = null;
    if (opt('ledger')) {
      const lf = pathResolve(opt('ledger'));
      const ledger = recordParity(loadLedger(lf), reports, routing);
      saveLedger(lf, ledger);
      summary = ledgerSummary(ledger);
    }
    const v = { pass: 0, near: 0, fail: 0, skew: 0, incomplete: 0, 'no-legacy': 0, empty: 0, error: 0 };
    for (const r of reports) v[r.error ? 'error' : r.verdict]++;
    console.error(`[dual-run] result boards=${reports.length} ${JSON.stringify(v)} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    out({ verdicts: v, ledger: summary, report: opt('report') ?? null }, `verdicts ${JSON.stringify(v)}${summary ? `; ledger ${JSON.stringify(summary)}` : ''}`);
    process.exit(v.error ? 1 : 0);
  }
  case 'import': {
    const data = guardDataDir(opt('data'));
    const legacy = opt('legacy-data');
    if (!legacy) fail('--legacy-data <dir> is required (read-only: its scan-history.tsv)');
    if (pathResolve(legacy) === data) fail('--data must differ from --legacy-data');
    PROFILE_MOD = await import('../crawler/profile.mjs');
    const { companies } = companiesOf(opt('profile'));
    let boards = companies.map((e) => e.name);
    if (opt('boards', 'all') === 'routed') {
      const { loadRouting, routeFor } = await import('../core/route/router.mjs');
      const { resolve } = await import('../crawler/providers.mjs');
      let routing;
      try { routing = loadRouting(opt('routing') ?? process.env.JOBCRAWL_ROUTING); } catch (e) { fail(e.message); }
      boards = companies.filter((e) => routeFor(routing, { board: e.name, provider: resolve(e)?.provider ?? null }).route !== 'legacy').map((e) => e.name);
    }
    const { importBaseline } = await import('../core/route/baseline.mjs');
    let sum;
    try { sum = await importBaseline({ historyFile: join(pathResolve(legacy), 'scan-history.tsv'), root: data, boards, replace: flag('replace'), log: (m) => console.error(m) }); }
    catch (e) { fail(e.message); }
    out(sum, `imported ${sum.imported} boards, replaced ${sum.replaced} (${sum.rows} rows), kept ${sum.kept}, lease busy ${sum.busy}, without rows ${sum.empty}`);
    if (sum.busy) process.exit(3);
    break;
  }
  case 'ledger-shadow': {
    // Per-cycle parity of the shadow store against the legacy crawl's answer of the SAME fetch (lifecycle state), into the ledger: a
    // board earns a pass when the postings the shadow saw in its last read equal the urls of the legacy fetch of that cycle (shared
    // postings excluded). Only a legacy fetch at most --max-gap-min (90) minutes before the shadow's read and newer than the last one
    // recorded for the board counts, so each fetch is recorded once. Read-only on the shadow store and the lifecycle state.
    const store = opt('shadow'), lc = opt('lifecycle'), lf = opt('ledger');
    if (!store || !lc || !lf) fail('--shadow <store> --lifecycle <state.json> --ledger <file> are required');
    const maxGap = Number(opt('max-gap-min', 90)) * 60000;
    const { lifecycleIndex, compareBoard } = await import('../core/route/parity.mjs');
    const { loadLedger, saveLedger, recordParity, ledgerSummary } = await import('../core/route/ledger.mjs');
    const { loadRouting } = await import('../core/route/router.mjs');
    const { listBoards, boardKey } = await import('../core/state/board-store.mjs');
    let routing;
    // the routes the ledger records come from this file: without it every board would be rewritten to 'legacy' (and its since reset)
    const routingFile = opt('routing') ?? process.env.JOBCRAWL_ROUTING;
    if (!routingFile) fail('ledger-shadow needs --routing <file> (or JOBCRAWL_ROUTING): the ledger records the route of each board from it');
    try { routing = loadRouting(routingFile); } catch (e) { fail(e.message); }
    const idx = lifecycleIndex(pathResolve(lc));
    const ledger = loadLedger(pathResolve(lf));
    // the provider of each board (for the provider routes in the ledger), from --companies when given
    const providerOf = new Map();
    if (opt('companies')) {
      const { resolve: resolveEntry } = await import('../crawler/providers.mjs');
      for (const e of JSON.parse(readFileSync(pathResolve(opt('companies')), 'utf8')).tracked_companies ?? []) if (e?.name) providerOf.set(e.name, resolveEntry(e)?.provider ?? e.provider ?? null);
    }
    const reports = [], skipped = { no_read: 0, no_fetch: 0, gap: 0, recorded: 0 };
    for (const board of listBoards(pathResolve(store))) {
      // read-only: state.json as committed (openBoard could repair a log a running shadow hook is just committing)
      let st;
      try { st = JSON.parse(readFileSync(join(pathResolve(store), 'boards', boardKey(board), 'state.json'), 'utf8')); } catch { skipped.no_read++; continue; }
      const readAt = Date.parse(st.last_ok ?? '');
      if (!readAt) { skipped.no_read++; continue; }
      const f = idx.fetches.get(board);
      if (!f) { skipped.no_fetch++; continue; }
      if (f.at > readAt || readAt - f.at > maxGap) { skipped.gap++; continue; }
      if ((ledger.boards[board]?.last_fetch ?? 0) >= f.at) { skipped.recorded++; continue; }
      const seen = Object.entries(st.postings).filter(([, p]) => p.status === 'open' && Date.parse(p.last_seen) === readAt).map(([id, p]) => ({ id, ...p }));
      const c = compareBoard(f.urls.map((u) => ({ url: u, title: '', location: '' })), seen, { sameFetch: true, ownBoard: board, urlBoard: idx.urlBoard });
      reports.push({ board, provider: providerOf.get(board) ?? null, ...c, legacy_fetch: new Date(f.at).toISOString() });
      (ledger.boards[board] ??= { provider: providerOf.get(board) ?? null, route: 'legacy', since: new Date().toISOString(), parity: [] }).last_fetch = f.at;
    }
    recordParity(ledger, reports, routing);
    saveLedger(pathResolve(lf), ledger);
    const v = {};
    for (const r of reports) v[r.verdict] = (v[r.verdict] ?? 0) + 1;
    const summary = ledgerSummary(ledger);
    console.error(`[ledger-shadow] recorded ${reports.length} board(s) ${JSON.stringify(v)}; skipped ${JSON.stringify(skipped)}; ledger ${JSON.stringify(summary)}`);
    out({ recorded: reports.length, verdicts: v, skipped, ledger: summary, failing: reports.filter((r) => r.verdict !== 'pass' && r.verdict !== 'empty').map((r) => ({ board: r.board, verdict: r.verdict, only_legacy: r.only_legacy, only_new: r.only_new })) },
      `recorded ${reports.length}: ${JSON.stringify(v)}; eligible ${summary.eligible}`);
    break;
  }
  case 'snapshot': {
    const data = pathResolve(opt('data') ?? fail('--data <dir> is required'));
    const st = opt('status', 'open');
    if (opt('format')) {
      const o = await outputOptions();
      const store = await openStoreOr(data, o.from === 'resolved' ? 'sqlite' : storeKind());
      let text;
      try {
        const { readSnapshot } = await import('../core/outputs/source.mjs');
        const { render } = await import('../core/outputs/render.mjs');
        const snap = readSnapshot(store, { from: o.from, status: st });
        text = render(o.format, snap.records, { ...o.render, kind: 'snapshot', watermark: snap.header.watermark });
      } catch (e) { store.close(); fail(e.message, 4); }
      store.close();
      writeOutput(o.out, text);
      break;
    }
    if (opt('fields') != null || opt('from') != null || opt('out') != null) fail('--fields, --from and --out need --format ndjson|jsonfeed|rss');
    const store = await openStoreOr(data, storeKind());
    for (const line of store.snapshot({ status: st === 'all' ? null : st })) process.stdout.write(JSON.stringify(line) + '\n');
    store.close();
    break;
  }
  case 'feed': {
    const data = pathResolve(opt('data') ?? fail('--data <dir> is required'));
    let since;
    if (opt('since-json')) { try { since = JSON.parse(opt('since-json')); } catch (e) { fail(`--since-json: ${e.message}`); } }
    else since = Object.fromEntries(String(opt('since', '')).split(',').filter(Boolean).map((p) => { const i = p.lastIndexOf('='); return [p.slice(0, i), Number(p.slice(i + 1))]; }));
    if (opt('format')) {
      const o = await outputOptions();
      const store = await openStoreOr(data, 'sqlite');
      const consumer = opt('consumer');
      let text, res;
      try {
        const src = await import('../core/outputs/source.mjs');
        const { render } = await import('../core/outputs/render.mjs');
        const after = consumer ? src.bookmarkGet(store, consumer, o.from) : Number(opt('after', 0));
        if (!(after >= 0)) fail(`--after expects a cursor >= 0 (got "${opt('after')}")`);
        res = src.readAfter(store, { from: o.from, after, limit: Number(opt('limit', 1000)) });
        text = render(o.format, res.records, { ...o.render, kind: 'delta', watermark: { from: after, to: res.last } });
        writeOutput(o.out, text);
        if (consumer && flag('commit') && res.last > after) src.bookmarkSet(store, consumer, o.from, res.last);
      } catch (e) { store.close(); fail(e.message, 4); }
      store.close();
      break;
    }
    if (opt('fields') != null || opt('from') != null || opt('out') != null) fail('--fields, --from and --out need --format ndjson|jsonfeed|rss');
    const store = await openStoreOr(data, storeKind());
    if (opt('after') != null || opt('consumer')) {
      if (store.kind !== 'sqlite') fail('--after and --consumer need --store sqlite (a global event_id)');
      const consumer = opt('consumer');
      const after = consumer ? store.bookmarkGet(consumer) : Number(opt('after'));
      if (!(after >= 0)) fail(`--after expects an event_id >= 0 (got "${opt('after')}")`);
      const recs = store.events({ after, limit: Number(opt('limit', 1000)) });
      for (const e of recs) process.stdout.write(JSON.stringify(e) + '\n');
      if (consumer && flag('commit') && recs.length) store.bookmarkSet(consumer, recs.at(-1).event_id);
    } else for (const e of store.readEvents(since)) process.stdout.write(JSON.stringify(e) + '\n');
    store.close();
    break;
  }
  case 'bookmark': {
    const data = pathResolve(opt('data') ?? fail('--data <dir> is required'));
    const sub = rest[0] && !rest[0].startsWith('-') ? rest[0] : 'list';
    const store = await openStoreOr(data, 'sqlite');
    if (sub === 'list') { const b = store.bookmarks(); out(b, b.map((x) => `${x.consumer}\t${x.event_id}\t${x.updated_at}`).join('\n')); }
    else {
      const consumer = opt('consumer') ?? fail('--consumer <name> is required');
      if (sub === 'get') { const v = store.bookmarkGet(consumer); out({ consumer, event_id: v }, String(v)); }
      else if (sub === 'set') {
        const raw = opt('event-id') ?? fail('--event-id <n> is required');
        let v; try { v = store.bookmarkSet(consumer, Number(raw)); } catch (e) { fail(e.message); }
        out({ consumer, event_id: v }, String(v));
      } else fail(`unknown bookmark command "${sub}" (get, set or list)`);
    }
    store.close();
    break;
  }
  case 'store-import': {
    const data = guardDataDir(opt('data'));
    const from = pathResolve(opt('from') ?? data);
    const { openSqliteStore } = await import('../core/state/sqlite-store.mjs');
    let store, sum;
    try { store = await openSqliteStore(data); sum = store.importJson(from, { replace: flag('replace'), log: (m) => console.error(m) }); }
    catch (e) { store?.close(); fail(e.message, 4); }
    store.close();
    out(sum, `imported ${sum.imported} boards, replaced ${sum.replaced}, kept ${sum.kept}, skipped ${sum.skipped.length}; ${sum.postings} postings, ${sum.ids} ids, ${sum.aliases} aliases, ${sum.events} events`);
    break;
  }
  case 'run': {
    // Headless multi-board run on the new path (design §3.9, docs/HEADLESS.md). Never prompts; logs are JSON lines on stderr or a file;
    // stdout carries only the --json result. A live read follows the same rules as `crawl` (routing, kill switch, egress guard).
    const env = process.env;
    const profileDir = opt('profile') ?? env.JOBCRAWL_PROFILE, dataArg = opt('data') ?? env.JOBCRAWL_DATA;
    if (!profileDir) fail('--profile <dir> (or JOBCRAWL_PROFILE) is required');
    if (!dataArg) fail('--data <dir> (or JOBCRAWL_DATA) is required');
    const data = guardDataDir(dataArg);
    const { createLogger, defaultFormat } = await import('../core/headless/log.mjs');
    const { createMetrics, serveMetrics, parseListen } = await import('../core/headless/metrics.mjs');
    const { runCycle, acquireLock } = await import('../core/headless/runner.mjs');
    const { EXIT, exitForSignal } = await import('../core/headless/exit.mjs');
    const num = (n, d) => { const v = opt(n, d); const x = Number(v); if (v != null && !(x >= 0)) fail(`--${n} expects a number >= 0 (got "${v}")`); return v == null ? null : x; };
    const maxMin = num('max-minutes'), everyMin = num('every-min'), intervalMin = num('interval-min', 60), staleH = num('stale-hours', 48), delayMs = num('replay-delay-ms');
    const logDir = env.JOBCRAWL_LOG_DIR;
    const logFile = opt('log-file') ?? (logDir ? join(pathResolve(logDir), 'jobcrawl.jsonl') : null);
    let log;
    try { log = createLogger({ format: opt('log-format') ?? env.JOBCRAWL_LOG_FORMAT ?? (logFile ? 'json' : defaultFormat()), file: logFile ? pathResolve(logFile) : null }); } catch (e) { fail(e.message); }
    let listen = null;
    if (opt('metrics')) { try { listen = parseListen(opt('metrics')); } catch (e) { fail(e.message); } }
    PROFILE_MOD = await import('../crawler/profile.mjs');
    let profile, companies;
    try { ({ profile, companies } = companiesOf(profileDir)); } catch (e) { fail(`profile: ${e.message}`); }
    const { loadRouting, routeFor } = await import('../core/route/router.mjs');
    const { resolve: resolveEntry } = await import('../crawler/providers.mjs');
    let routing;
    try { routing = loadRouting(opt('routing') ?? env.JOBCRAWL_ROUTING); } catch (e) { fail(e.message); }
    const providerOf = (e) => resolveEntry(e)?.provider ?? null;
    let boards = companies.filter((e) => routeFor(routing, { board: e.name, provider: providerOf(e) }).route !== 'legacy');
    if (opt('board')) boards = boards.filter((e) => e.name === opt('board'));
    let readFor = () => undefined;
    if (opt('replay')) {
      const { boardKey } = await import('../core/state/board-store.mjs');
      const rec = pathResolve(opt('replay'));
      readFor = (e) => loadRecordedRun(rec, e.name, boardKey) ?? { ok: false, items: [], error: { cls: 'CONFIG', detail: 'not in the recording' } };
    } else if (boards.length) {
      (await import('../crawler/useragent.mjs')).setUserAgent(profile.userAgent);
      const pol = await import('../crawler/policy.mjs');
      pol.configurePolicy({ ...pol.policyFromProfile(profile, data) });
      pol.installGuard({ egress: true });
      (await import('../crawler/providers.mjs')).setCacheDir(join(data, 'cache'));
    }
    const store = await openStoreOr(data, storeKind());
    const metrics = createMetrics();
    const ac = new AbortController();
    let signalled = 0;
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
      if (++signalled > 1) { log.warn('forced-exit', { signal: sig }); process.exit(exitForSignal(sig)); }   // second signal: no more waiting
      log.warn('signal', { signal: sig, note: 'finishing: the board in flight is discarded, state stays consistent' });
      metrics.set('stopping', true);
      ac.abort(sig);
    });
    let server = null;
    if (listen) {
      try { server = await serveMetrics(metrics, listen); } catch (e) { fail(`--metrics ${opt('metrics')}: ${e.message}`); }
      log.info('metrics-listening', { host: server.host, port: server.port });
    }
    const sleepAbortable = (ms) => new Promise((ok) => { if (ac.signal.aborted) return ok(); const t = setTimeout(ok, ms); ac.signal.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true }); });
    const common = { readFor, signal: ac.signal, maxMs: maxMin ? maxMin * 60e3 : null, strict: flag('strict'), staleMs: staleH * 3600e3, providerOf, log, metrics, store };
    if (delayMs) {   // test seam (with --replay): a slow board, so a signal can arrive mid-run
      const { runBoard } = await import('../core/run-board.mjs');
      common.runBoardImpl = async (d, e, o) => { await sleepAbortable(delayMs); return o.signal?.aborted ? { board: e.name, aborted: true } : runBoard(d, e, o); };
    }
    log.info('start', { pid: process.pid, node: process.versions.node, boards: boards.length, data, store: store.kind, daemon: flag('daemon'), mode: opt('replay') ? 'replay' : 'live' });
    let code = EXIT.OK, summary = null;
    try {
      if (flag('daemon')) {
        const lk = acquireLock(data);
        if (!lk) { log.error('lock-held', { data }); code = EXIT.LOCKED; }
        else {
          try {
            while (!ac.signal.aborted) {
              const r = await runCycle(data, boards, { ...common, lock: false });
              summary = r.summary; log.info('daemon-cycle', { code: r.code });
              if (r.code === EXIT.STATE || r.code === EXIT.SIGINT || r.code === EXIT.SIGTERM) { code = r.code; break; }
              code = r.code; lk.renew();
              metrics.set('nextDueAt', Date.now() + intervalMin * 60e3);
              await sleepAbortable(intervalMin * 60e3);
            }
            if (ac.signal.aborted && code !== EXIT.STATE) code = exitForSignal(ac.signal.reason);
          } finally { lk.release(); }
        }
      } else {
        const r = await runCycle(data, boards, { ...common, everyMs: everyMin ? everyMin * 60e3 : 0 });
        code = r.code; summary = r.summary;
      }
    } catch (e) { log.error('fatal', { error: String(e?.stack ?? e) }); code = EXIT.STATE; }
    if (flag('resolve') && code !== EXIT.STATE && !ac.signal.aborted) {
      // opt-in (default off): one resolver run over what the boards just committed; a resolver failure never changes the run's code
      if (store.kind !== 'sqlite') log.warn('resolve-skipped', { reason: 'the resolver needs --store sqlite' });
      else {
        try {
          const config = await resolverConfig();
          const { runResolver } = await import('../core/resolve/resolver.mjs');
          const r = await runResolver(store, { facts: await resolverFacts(config), config, log: (m) => log.info('resolver', { line: m }) });
          const { engine, ...sum } = r;
          log.info('resolved', sum);
          if (summary) summary.resolver = sum;
        } catch (e) { log.error('resolver-failed', { error: String(e?.message ?? e) }); }
      }
    }
    await server?.close();
    store.close();
    log.info('exit', { code });
    if (JSON_OUT) process.stdout.write(JSON.stringify({ code, ...(summary ?? {}) }) + '\n');
    process.exit(code);
  }
  case 'resolve': {
    const data = guardDataDir(opt('data') ?? process.env.JOBCRAWL_DATA);
    const kind = opt('store', process.env.JOBCRAWL_STORE || 'sqlite');
    if (kind !== 'sqlite') fail(`the resolver needs --store sqlite (a global event_id, bookmarks and transactions); got "${kind}"`);
    const rules = opt('rules', 'legacy');
    if (rules !== 'legacy' && rules !== 'lifecycle') fail(`--rules expects legacy or lifecycle (got "${rules}")`);
    const num = (n) => { const v = opt(n); if (v == null) return null; const x = Number(v); if (!(Number.isInteger(x) && x > 0)) fail(`--${n} expects a whole number > 0 (got "${v}")`); return x; };
    const config = await resolverConfig();
    const store = await openStoreOr(data, 'sqlite');
    const { runResolver } = await import('../core/resolve/resolver.mjs');
    let r;
    try { r = await runResolver(store, { facts: await resolverFacts(config), config: { ...config, rules }, batch: num('batch') ?? 5000, maxEvents: num('max-events'), log: (m) => console.error(m) }); }
    catch (e) { store.close(); fail(e.message, 4); }
    store.close();
    if (r.skipped) { out({ skipped: r.skipped }, `resolve: ${r.skipped}`); process.exit(3); }
    const { engine, ...sum } = r;
    out(sum, `resolved: event_id ${sum.from ?? 'none'} -> ${sum.bookmark}, ${sum.applied} records applied, ${sum.records} resolved records (seq ${sum.seq})${sum.bootstrapped ? ', bootstrapped from the stored postings' : ''}`);
    break;
  }
  case 'resolved': {
    const data = pathResolve(opt('data') ?? process.env.JOBCRAWL_DATA ?? fail('--data <dir> is required'));
    const store = await openStoreOr(data, 'sqlite');
    const m = await import('../core/resolve/resolver.mjs');
    let rows;
    try {
      rows = flag('derived') ? m.derivedSet(store).map((name) => ({ kind: 'protected', name }))
        : flag('groups') ? m.resolvedGroups(store, { status: opt('status') ?? null })
        : m.resolvedRecords(store, { after: Number(opt('after', 0)), limit: Number(opt('limit', 1000)) });
    } catch (e) { store.close(); fail(e.message, 4); }
    store.close();
    for (const r of rows) process.stdout.write(JSON.stringify(r) + '\n');
    break;
  }
  case 'doctor': {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, detail });
    const [maj, min] = process.versions.node.split('.').map(Number);
    add('node', maj > 22 || (maj === 22 && min >= 5), process.versions.node);
    try { await import('node:sqlite'); add('node:sqlite', true, 'available (experimental on Node 22)'); } catch (e) { add('node:sqlite', false, 'not available: the files store is used'); }
    if (opt('profile')) {
      try {
        const { loadProfile } = await import('../crawler/profile.mjs');
        const { DEFAULT_UA } = await import('../crawler/useragent.mjs');
        const p = loadProfile(opt('profile'));
        add('profile', true, p.file);
        add('user agent', Boolean(p.userAgent && p.userAgent !== DEFAULT_UA), p.userAgent ? p.userAgent : 'the package default; set crawl.user_agent with a URL or contact for your site');
        add('companies file', existsSync(p.companiesFile), p.companiesFile);
      } catch (e) { add('profile', false, e.message); }
    }
    if (opt('data')) {
      const d = pathResolve(opt('data'));
      add('data folder', existsSync(d), d);
      if (existsSync(join(d, 'source-health.json'))) {
        try {
          const h = JSON.parse(readFileSync(join(d, 'source-health.json'), 'utf8'));
          const rows = Object.values(h.boards ?? h);
          const failing = rows.filter((r) => (r?.consecutive_failures ?? r?.fail_streak ?? 0) >= 3).length;
          add('legacy source health', failing === 0, `${rows.length} boards, ${failing} failing 3+ times in a row`);
        } catch (e) { add('legacy source health', false, e.message); }
      }
    }
    if (opt('routing')) {
      try { const { loadRouting } = await import('../core/route/router.mjs'); const r = loadRouting(opt('routing')); add('routing', true, `default ${r.default}, kill_switch ${r.kill_switch}, allow_new ${r.allow_new}`); } catch (e) { add('routing', false, e.message); }
    }
    { const { killSwitchEnv } = await import('../core/route/router.mjs'); add('route kill switch (env)', true, killSwitchEnv() ? 'ON: every board on legacy' : 'off'); }
    const bad = checks.filter((c) => !c.ok).length;
    out({ checks, ok: bad === 0 }, checks.map((c) => `${c.ok ? 'ok  ' : 'WARN'} ${c.name}: ${c.detail}`).join('\n'));
    process.exit(flag('strict') && bad ? 5 : 0);
  }
  default:
    fail(`unknown command "${cmd}" (jobcrawl --help)`);
}
