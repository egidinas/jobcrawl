#!/bin/bash
# Rollback drill for the authority swap on COPIES of the live crawl state (never the live folder). Two copies, A (plain legacy) and
# B (5 greenhouse boards routed `new` with allow_new: true), crawled side by side 3 times; then B goes back to legacy for a 4th run.
# After every run the 5 boards' history rows (url, status, first_seen, last_seen) and crawl-state entries of A and B are compared;
# a row that is gone in B but not in A is a false departure. Writes $D/drill.txt (one line per run + the verdict) and logs to $D/drill.log.
#   rollback-drill.sh <jobcrawl checkout with the authority code> "<board 1>|<board 2>|..."
set -u
CODE=${1:?code checkout}; BOARDS=${2:?boards}
J=$HOME/atlas/jcx
D=$J/drill-$(date +%Y%m%d-%H%M%S)
LIVE=$HOME/atlas/crawl/scan
PROFILE=$HOME/atlas/crawl/code/jobcrawl-profile
COMPANIES=$HOME/atlas/crawl/code/crawler/companies.json
mkdir -p "$D/A" "$D/B" "$D/store"
log() { echo "$(date -Is) $*" | tee -a "$D/drill.log"; }
log "start: copies of $LIVE (top-level files only) into $D/A and $D/B; boards: $BOARDS; code $(git -C "$CODE" rev-parse --short HEAD)"
for f in "$LIVE"/*; do [ -f "$f" ] && cp "$f" "$D/A/" && cp "$f" "$D/B/"; done
# the 5 boards, due on every run (interval 0), with the companies file's filters
node -e '
  const fs = require("fs"); const [src, out, names] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(src, "utf8")); const want = new Set(names.split("|"));
  c.tracked_companies = c.tracked_companies.filter((e) => want.has(e.name)).map((e) => ({ ...e, interval_hours: 0, probation: false }));
  if (c.tracked_companies.length !== want.size) { console.error(`found ${c.tracked_companies.length} of ${want.size} boards`); process.exit(2); }
  fs.writeFileSync(out, JSON.stringify(c)); console.log(`boards ${c.tracked_companies.map((e) => e.name + " (" + e.provider + ")").join(", ")}`);
' "$COMPANIES" "$D/companies.json" "$BOARDS" >> "$D/drill.log" 2>&1 || { log "STOPPED: boards not found"; exit 1; }
route() { node -e 'const [f, on, names] = process.argv.slice(1); require("fs").writeFileSync(f, JSON.stringify({ schema: "routing/v1", allow_new: on === "1", boards: Object.fromEntries(names.split("|").map((b) => [b, on === "1" ? "new" : "legacy"])) }));' "$D/routing.json" "$1" "$BOARDS"; }
route 1
(cd "$CODE" && node --no-warnings cli/jobcrawl.mjs import --profile "$PROFILE" --companies "$D/companies.json" --data "$D/store" --legacy-data "$D/B" --boards all --json) >> "$D/drill.log" 2>&1 || { log "STOPPED: import failed"; exit 1; }
compare() {   # compare the 5 boards in A and B; prints one line
  node -e '
    const fs = require("fs"); const [a, b, names] = process.argv.slice(1); const want = new Set(names.split("|"));
    const rows = (d) => { const m = new Map(); const lines = fs.readFileSync(d + "/scan-history.tsv", "utf8").split("\n"); const h = lines[0].split("\t");
      for (const l of lines.slice(1)) { if (!l) continue; const c = l.split("\t"); const r = Object.fromEntries(h.map((k, i) => [k, c[i] ?? ""])); let board = r.company; const via = /\(via ([^)]+)\)\s*$/.exec(board); if (via) board = via[1]; if (want.has(board) || want.has(r.company)) m.set(r.url, r); } return m; };
    const A = rows(a), B = rows(b); let diff = 0, falseDep = 0, missDep = 0; const ex = [];
    for (const [u, r] of A) { const s = B.get(u); const k = (x) => x ? [x.status, x.first_seen, x.last_seen].join("|") : "-"; if (k(r) !== k(s)) { diff++; if (ex.length < 3) ex.push(`${u.slice(-50)} A=${k(r)} B=${k(s)}`); if (s?.status === "gone" && r.status !== "gone") falseDep++; if (r.status === "gone" && s && s.status !== "gone") missDep++; } }
    for (const u of B.keys()) if (!A.has(u)) diff++;
    // crawl-state: the same boards have an entry on both sides (the due times differ by the seconds between the two runs)
    const cs = (d) => { try { const s = JSON.parse(fs.readFileSync(d + "/crawl-state.json", "utf8")); const o = s.boards ?? s; return JSON.stringify([...want].map((n) => n in o)); } catch { return "?"; } };
    console.log(JSON.stringify({ rows_A: A.size, rows_B: B.size, row_diffs: diff, false_departures: falseDep, missed_departures: missDep, crawl_state_equal: cs(a) === cs(b), examples: ex }));
  ' "$D/A" "$D/B" "$BOARDS"
}
ok=1
for run in 1 2 3 4; do
  [ "$run" = 4 ] && route 0                # rollback: back to legacy
  (cd "$CODE" && node --no-warnings crawler/crawl.mjs --profile "$PROFILE" --config "$D/companies.json" --data "$D/A") > "$D/A-run$run.log" 2>&1 || { log "run $run: A failed"; ok=0; }
  (cd "$CODE" && JOBCRAWL_SHADOW=1 JOBCRAWL_ROUTING="$D/routing.json" JOBCRAWL_SHADOW_DATA="$D/store" node --no-warnings crawler/crawl.mjs --profile "$PROFILE" --config "$D/companies.json" --data "$D/B") > "$D/B-run$run.log" 2>&1 || { log "run $run: B failed"; ok=0; }
  line=$(compare)
  log "run $run ($([ "$run" = 4 ] && echo 'back to legacy' || echo 'routed new')): $line | B: $(grep -h '\[authority\] boards' "$D/B-run$run.log" | tail -1 | cut -c1-200)"
  echo "$line" | grep -q '"row_diffs":0,' || ok=0
  echo "$line" | grep -q '"false_departures":0,' || ok=0
done
{ cat "$D/drill.log" | grep -E "run [1-4]"; echo "verdict: $([ $ok = 1 ] && echo 'PASS: identical history rows, no false departures, across the switch back' || echo 'DIFFERENCES: see drill.log')"; } > "$D/drill.txt"
log "result: $(tail -1 "$D/drill.txt") -> $D/drill.txt"
