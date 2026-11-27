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
  detect <url> [--page] [--json]             which source reads this URL; --page also fetches the page (public addresses only)
  route [--routing <file>] [--board <name>] [--provider <id>] [--json]
                                             the strangler-fig route of a board (legacy | shadow | new)
  crawl --board <name> --profile <dir> --data <dir> [--replay <recording>] [--json]
                                             one board on the new per-board path, into its own data folder (never a live one)
  dual-run --profile <dir> --data <dir> --legacy-data <dir> --replay <recording> [--routing <file>] [--ledger <file>]
           [--boards all|routed] [--report <file>] [--json]
                                             shadow run from a recording (no second live crawl), compared with the legacy history
  snapshot --data <dir> [--status open|departed|all]   full read as NDJSON (header with per-board watermarks, then postings)
  feed --data <dir> [--since <board=seq,...>]          delta events as NDJSON
  doctor [--profile <dir>] [--data <dir>] [--routing <file>] [--json]
                                             read-only checks: Node, node:sqlite, profile, user agent, data folder, routing

  --help, -h, help                           this text (no network, no writes)
exit codes: 0 ok, 1 some boards failed, 2 usage or config error, 3 lease held`;

const out = (obj, text) => { if (JSON_OUT) process.stdout.write(JSON.stringify(obj) + '\n'); else console.log(text ?? JSON.stringify(obj, null, 1)); };
const fail = (msg, code = 2) => { if (JSON_OUT) process.stdout.write(JSON.stringify({ error: msg }) + '\n'); else console.error(`jobcrawl ${cmd}: ${msg}`); process.exit(code); };

if (cmd === 'help' || flag('help') || rest.includes('-h')) { console.log(USAGE); process.exit(0); }

const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
const { join, resolve: pathResolve } = await import('node:path');
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
  const cfg = JSON.parse(readFileSync(p.companiesFile, 'utf8'));
  return { profile: p, companies: (cfg.tracked_companies ?? []).filter((e) => e.enabled !== false && e.name) };
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
    const { resolve } = await import('../crawler/providers.mjs');
    const hit = resolve({ careers_url: url });
    const res = { url, hits: hit ? [{ provider: hit.provider, slug: hit.slug, evidence: [{ type: 'url' }] }] : [] };
    if (flag('page')) {
      const { safeFetch } = await import('../core/fetch/ssrf.mjs');
      const { atsFingerprints } = await import('../crawler/profiler/detect.mjs');
      const { UA } = await import('../crawler/useragent.mjs');
      try {
        const r = await safeFetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
        const html = await r.text();
        for (const f of atsFingerprints(html, url) ?? []) res.hits.push({ provider: f.provider, slug: f.slug, evidence: [{ type: 'page', via: f.via, hits: f.hits }] });
        res.page = { status: r.status, bytes: html.length };
      } catch (e) { res.page = { error: String(e?.message ?? e) }; }
    }
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
    const { legacyRowsByBoard, compareBoard, byProvider, PARITY_SCHEMA } = await import('../core/route/parity.mjs');
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
    const legacyRows = await legacyRowsByBoard(join(pathResolve(legacy), 'scan-history.tsv'), picked.map(({ e }) => e.name));
    const reports = [];
    let k = 0;
    for (const { e, provider } of picked) {
      const read = loadRecordedRun(pathResolve(rec), e.name, boardKey);
      if (!read) reports.push({ board: e.name, provider, error: 'not in the recording' });
      else {
        const r = await runBoard(data, e, { read, rules: LEGACY_RULES });
        if (r.skipped) reports.push({ board: e.name, provider, error: r.skipped });
        else reports.push({ board: e.name, provider, ...compareBoard(legacyRows.get(e.name) ?? [], openPostings(r.state)) });
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
    const v = { pass: 0, near: 0, fail: 0, empty: 0, error: 0 };
    for (const r of reports) v[r.error ? 'error' : r.verdict]++;
    console.error(`[dual-run] result boards=${reports.length} ${JSON.stringify(v)} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    out({ verdicts: v, ledger: summary, report: opt('report') ?? null }, `verdicts ${JSON.stringify(v)}${summary ? `; ledger ${JSON.stringify(summary)}` : ''}`);
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
    const since = Object.fromEntries(String(opt('since', '')).split(',').filter(Boolean).map((p) => { const i = p.lastIndexOf('='); return [p.slice(0, i), Number(p.slice(i + 1))]; }));
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
    add('route kill switch (env)', true, process.env.JOBCRAWL_ROUTE_KILL === '1' ? 'ON: every board on legacy' : 'off');
    const bad = checks.filter((c) => !c.ok).length;
    out({ checks, ok: bad === 0 }, checks.map((c) => `${c.ok ? 'ok  ' : 'WARN'} ${c.name}: ${c.detail}`).join('\n'));
    process.exit(flag('strict') && bad ? 5 : 0);
  }
  default:
    fail(`unknown command "${cmd}" (jobcrawl --help)`);
}
