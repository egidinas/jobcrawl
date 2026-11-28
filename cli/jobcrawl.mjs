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
                                             baseline epoch from the legacy history, without events (read-only on the legacy side)
  snapshot --data <dir> [--status open|departed|all]   full read as NDJSON (header with per-board watermarks, then postings)
  feed --data <dir> [--since <board=seq,...> | --since-json '{"board": seq}']   committed delta events as NDJSON
  doctor [--profile <dir>] [--data <dir>] [--routing <file>] [--json] [--strict]
                                             read-only checks: Node, node:sqlite, profile, user agent, data folder, routing;
                                             --strict exits 5 when a check warns

  --help, -h, help                           this text (no network, no writes)
exit codes: 0 ok, 1 some boards failed, 2 usage or config error (or a live read the routing does not allow), 3 lease held,
            5 doctor --strict found a warning
environment: JOBCRAWL_ROUTE_KILL=1|true|yes|on sends every board to legacy (no live read by this tool); JOBCRAWL_ROUTING=<file>`;

const out = (obj, text) => { if (JSON_OUT) process.stdout.write(JSON.stringify(obj) + '\n'); else console.log(text ?? JSON.stringify(obj, null, 1)); };
const fail = (msg, code = 2) => { if (JSON_OUT) process.stdout.write(JSON.stringify({ error: msg }) + '\n'); else console.error(`jobcrawl ${cmd}: ${msg}`); process.exit(code); };

if (cmd === 'help' || flag('help') || rest.includes('-h')) { console.log(USAGE); process.exit(0); }

const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
const { join, dirname, resolve: pathResolve } = await import('node:path');
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
      pol.installGuard();
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
  case 'snapshot': {
    const data = pathResolve(opt('data') ?? fail('--data <dir> is required'));
    const { snapshot } = await import('../core/state/board-store.mjs');
    const st = opt('status', 'open');
    for (const line of snapshot(data, { status: st === 'all' ? null : st })) process.stdout.write(JSON.stringify(line) + '\n');
    break;
  }
  case 'feed': {
    const data = pathResolve(opt('data') ?? fail('--data <dir> is required'));
    let since;
    if (opt('since-json')) { try { since = JSON.parse(opt('since-json')); } catch (e) { fail(`--since-json: ${e.message}`); } }
    else since = Object.fromEntries(String(opt('since', '')).split(',').filter(Boolean).map((p) => { const i = p.lastIndexOf('='); return [p.slice(0, i), Number(p.slice(i + 1))]; }));
    const { readEvents } = await import('../core/state/board-store.mjs');
    for (const e of readEvents(data, since)) process.stdout.write(JSON.stringify(e) + '\n');
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
