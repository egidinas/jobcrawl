#!/bin/bash
# Rollback drill for the authority swap, the live way (review_authority.md F2), on COPIES only:
#   - data: the live crawl folder's top-level files and lifecycle/ (state + events), copied twice (A, B); MADE_LIFECYCLE=shadow like made-cycle;
#   - stores: two copies of the live shadow store shadow-v3 (no fresh import);
#   - routing: A = the live routing.json (greenhouse shadow), B = the live routing plus the 5 boards routed `new` with allow_new: true;
#   - boards crawled: the 5, their EURES employer boards, 40 other greenhouse boards (shadowed by the hook beside the authority path)
#     and 10 boards of other providers (legacy), all due on every run; the rest of the companies' rows stay in the history;
#   - 2 open rows per board, known to the store and not listed by the board, seeded into both histories and both stores, so the new
#     path has closes to decide;
#   - A and B crawl in parallel (the same answers as far as the boards are stable), 3 runs routed new, then B back to the live routing.
# After each run: scan-history.tsv, crawl-state.json and lifecycle/state.json of A and B compared whole (times masked), false/missed
# departures on the 5 boards, the cycle checker (authority-check.mjs) on B. Conditional cache off: nothing outside $D is written.
#   rollback-drill-live.sh <jobcrawl checkout with the authority code> "<board 1>|...|<board 5>"
set -u
CODE=${1:?code checkout}; BOARDS=${2:?boards}
OPS=$(cd "$(dirname "$0")" && pwd)
J=$HOME/atlas/jcx
D=$J/drill-live-$(date +%Y%m%d-%H%M%S)
LIVE=$HOME/atlas/crawl/scan
PROFILE=$HOME/atlas/crawl/code/jobcrawl-profile
COMPANIES=$HOME/atlas/crawl/code/crawler/companies.json
mkdir -p "$D"
log() { echo "$(date -Is) $*" | tee -a "$D/drill.log"; }
log "start: code $(git -C "$CODE" rev-parse --short HEAD), checker $(git -C "$OPS" rev-parse --short HEAD), boards $BOARDS -> $D"
for s in A B; do
  mkdir -p "$D/$s/lifecycle"
  for f in "$LIVE"/*; do [ -f "$f" ] && cp "$f" "$D/$s/"; done
  cp "$LIVE/lifecycle/state.json" "$D/$s/lifecycle/" && cp -r "$LIVE/lifecycle/events" "$D/$s/lifecycle/"
  cp -r "$J/shadow-v3" "$D/store-$s" && rm -f "$D/store-$s"/leases.sqlite*
done
log "copied: $(du -sh "$D" | cut -f1)"
LEDGER=$J/ledger-v3.json
node -e '
  const fs = require("fs"); const [src, ledgerFile, out, names] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(src, "utf8")); const want = names.split("|"); const W = new Set(want);
  const L = JSON.parse(fs.readFileSync(ledgerFile, "utf8")).boards;
  const lc = (s) => s.toLowerCase();
  const on = (e) => e.enabled !== false;
  const five = c.tracked_companies.filter((e) => W.has(e.name));
  if (five.length !== W.size) { console.error(`found ${five.length} of ${W.size} boards`); process.exit(2); }
  const eures = c.tracked_companies.filter((e) => e.provider === "eures" && want.some((w) => lc(e.name).includes(lc(w.split(" ")[0]))));
  const gh = c.tracked_companies.filter((e) => on(e) && e.provider === "greenhouse" && !W.has(e.name) && L[e.name]?.parity?.length).slice(0, 40);
  const other = c.tracked_companies.filter((e) => on(e) && ["ashby", "lever", "personio", "teamtailor", "workable"].includes(e.provider)).filter((e, i, a) => a.findIndex((x) => x.provider === e.provider) === i || i % 37 === 0).slice(0, 10);
  const pick = [...five, ...eures, ...gh, ...other].map((e) => ({ ...e, interval_hours: 0, probation: false }));
  fs.writeFileSync(out, JSON.stringify({ ...c, tracked_companies: pick }));
  console.log(`boards ${pick.length}: the 5, eures ${eures.map((e) => e.name).join(", ")}; greenhouse shadow ${gh.length}; other ${other.map((e) => e.name + " (" + e.provider + ")").join(", ")}`);
' "$COMPANIES" "$LEDGER" "$D/companies.json" "$BOARDS" >> "$D/drill.log" 2>&1 || { log "STOPPED: boards"; exit 1; }
tail -1 "$D/drill.log"
cp "$J/routing.json" "$D/routing-A.json"
node -e 'const fs = require("fs"); const [src, out, names] = process.argv.slice(1); const r = JSON.parse(fs.readFileSync(src, "utf8"));
  r.allow_new = true; r.boards = { ...(r.boards ?? {}), ...Object.fromEntries(names.split("|").map((b) => [b, "new"])) }; fs.writeFileSync(out, JSON.stringify(r));' "$J/routing.json" "$D/routing-new.json" "$BOARDS"
cp "$D/routing-new.json" "$D/routing-B.json"
# seed: 2 unlisted open rows per board into both histories and both stores (copies of a real open row/posting under an unlisted url)
(cd "$CODE" && node --input-type=module -e '
  import fs from "node:fs";
  const [hA, hB, sA, sB, names] = process.argv.slice(1);
  const { openBoard, commitRun } = await import((await import("node:url")).pathToFileURL(process.cwd() + "/core/state/board-store.mjs").href);
  const { postingId } = await import((await import("node:url")).pathToFileURL(process.cwd() + "/core/id.mjs").href);
  const want = new Set(names.split("|"));
  const text = fs.readFileSync(hA, "utf8"); const lines = text.split("\n"); const h = lines[0].split("\t");
  const iu = h.indexOf("url"), ic = h.indexOf("company"), is = h.indexOf("status");
  const add = [], per = new Map(), seeds = [];
  for (const l of lines.slice(1)) {
    const c = l.split("\t"); if (c[is] !== "open" || !want.has(c[ic])) continue;
    const n = per.get(c[ic]) ?? 0; if (n >= 2) continue;
    const from = c[iu]; c[iu] = from.replace(/\/?$/, "") + "-jcxdrill" + n;
    per.set(c[ic], n + 1); add.push(c.join("\t")); seeds.push({ board: c[ic], from, url: c[iu] });
  }
  const out = text.replace(/\n?$/, "\n") + add.join("\n") + "\n"; fs.writeFileSync(hA, out); fs.writeFileSync(hB, out);
  let inStore = 0;
  for (const root of [sA, sB]) for (const b of want) {
    const st = openBoard(root, b); const mine = seeds.filter((s) => s.board === b);
    for (const s of mine) { const src = st.postings[postingId(s.from)]; if (!src) continue; st.postings[postingId(s.url)] = { ...src, url: s.url, status: "open" }; inStore++; }
    commitRun(root, b, st, []);
  }
  console.log(`seeded ${add.length} rows (${[...per].map(([k, v]) => k + " " + v).join(", ")}); in the stores ${inStore / 2} of ${add.length}`);
' "$D/A/scan-history.tsv" "$D/B/scan-history.tsv" "$D/store-A" "$D/store-B" "$BOARDS") >> "$D/drill.log" 2>&1 || { log "STOPPED: seeding"; exit 1; }
tail -1 "$D/drill.log"
compare() {   # whole-file comparisons of ~180 MB histories: a bigger heap than a unit's default (~2 GB)
  node --max-old-space-size=8192 -e '
    const fs = require("fs"); const [a, b, names] = process.argv.slice(1); const want = new Set(names.split("|"));
    const mask = (t) => t.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<T>").replace(/\b1\d{12}\b/g, "<EPOCH>");
    const whole = (f) => { try { return mask(fs.readFileSync(a + "/" + f, "utf8")) === mask(fs.readFileSync(b + "/" + f, "utf8")); } catch { return false; } };
    const rows = (d) => { const m = new Map(); const lines = fs.readFileSync(d + "/scan-history.tsv", "utf8").split("\n"); const h = lines[0].split("\t");
      for (const l of lines.slice(1)) { if (!l) continue; const c = l.split("\t"); const r = Object.fromEntries(h.map((k, i) => [k, c[i] ?? ""])); m.set(r.url, r); } return m; };
    const A = rows(a), B = rows(b); let diff = 0, falseDep = 0, missDep = 0; const ex = [], diffBoards = {};
    const k = (x) => x ? [x.status, x.first_seen, x.last_seen].join("|") : "-";
    for (const [u, r] of A) { const s = B.get(u); if (k(r) !== k(s)) { diff++; diffBoards[r.company] = (diffBoards[r.company] ?? 0) + 1; if (ex.length < 4) ex.push(`${r.company}: ${u.slice(-60)} A=${k(r)} B=${k(s)}`);
      if (want.has(r.company)) { if (s?.status === "gone" && r.status !== "gone") falseDep++; if (r.status === "gone" && s && s.status !== "gone") missDep++; } } }
    for (const u of B.keys()) if (!A.has(u)) diff++;
    const seeded = [...A.values()].filter((r) => /-jcxdrill\d$/.test(r.url));
    console.log(JSON.stringify({ rows: A.size, row_diffs: diff, diff_boards: diffBoards, false_departures: falseDep, missed_departures: missDep,
      history_file_equal: whole("scan-history.tsv"), crawl_state_file_equal: whole("crawl-state.json"), lifecycle_state_equal: whole("lifecycle/state.json"),
      seeded_gone_A: seeded.filter((r) => r.status === "gone").length, seeded_gone_B: seeded.filter((r) => B.get(r.url)?.status === "gone").length, examples: ex }));
  ' "$D/A" "$D/B" "$BOARDS"
}
crawl() {   # crawl <A|B>
  (cd "$CODE" && JOBCRAWL_CONDITIONAL_CACHE=0 MADE_LIFECYCLE=shadow JOBCRAWL_SHADOW=1 JOBCRAWL_ROUTING="$D/routing-$1.json" JOBCRAWL_SHADOW_DATA="$D/store-$1" \
    JOBCRAWL_COMPANIES_OVERLAY= node --no-warnings crawler/crawl.mjs --profile "$PROFILE" --config "$D/companies.json" --data "$D/$1") > "$D/$1-run$run.log" 2>&1
}
ok=1; decided=0
for run in 1 2 3 4; do
  [ "$run" = 4 ] && cp "$D/routing-A.json" "$D/routing-B.json"     # rollback: B back to the live routing
  crawl A & pa=$!; crawl B & pb=$!
  wait $pa || { log "run $run: A failed"; ok=0; }
  wait $pb || { log "run $run: B failed"; ok=0; }
  line=$(compare 2>>"$D/compare.err")
  [ -n "$line" ] || { ok=0; line="{}"; log "run $run: compare failed (see compare.err)"; }
  chk=$(node "$OPS/authority-check.mjs" "$D/B-run$run.log" --routing "$D/routing-B.json" --boards "$BOARDS"); crc=$?
  log "run $run ($([ "$run" = 4 ] && echo 'back to live routing' || echo 'routed new')): $line"
  log "run $run checker (exit $crc): $chk"
  log "run $run B: $(grep -h '\[authority\] boards\|\[shadow\] boards' "$D/B-run$run.log" | cut -c1-220 | tr '\n' ' ')"
  for key in '"history_file_equal":true' '"false_departures":0,' '"crawl_state_file_equal":true'; do echo "$line" | grep -q "$key" || { ok=0; log "run $run: not $key"; }; done
  if [ "$run" -le 3 ]; then
    [ "$crc" = 0 ] || { ok=0; log "run $run: checker not green"; }
    decided=$(( decided + $(echo "$chk" | sed -n 's/.*"closed":\([0-9]*\).*/\1/p' | head -1) ))
  else
    grep -q '\[authority\]' "$D/B-run$run.log" && { ok=0; log "run 4: authority line after the switch back"; }
  fi
done
[ "$decided" -gt 0 ] || { ok=0; log "no close was decided by the new path: the drill tested nothing"; }
{ grep -E "run [1-4]" "$D/drill.log"; echo "verdict: $([ $ok = 1 ] && echo "PASS: identical history, crawl state and lifecycle, no false departures, $decided closes by the new path, checker green, clean switch back" || echo 'DIFFERENCES: see drill.log')"; } > "$D/drill.txt"
log "result: $(tail -1 "$D/drill.txt") -> $D/drill.txt"
