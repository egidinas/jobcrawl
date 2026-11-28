#!/bin/bash
# JOBCRAWLX morning chain for the 2026-11-28 benchmark recording (runs unattended from jcx-morning.service).
#   1 wait until jcx-record.service is inactive (max 30 min)
#   2 back up boards.jsonl, drop its TIMEOUT lines, re-read only those boards (same politeness, hard stop 11:00)
#   3 bench/analyse.mjs over the recording + 7 days of the live raw index
#   4 jobcrawl import (baseline epoch, never --replace) into $R/shadow
#   5 jobcrawl dual-run over the recording -> parity.json + ledger.json
#   6 MORNING_SUMMARY.md (+ copies of report.md and the summary in $R/out/)
# Code: the named-commit checkout $R/ops-morning (branch ops/jcx-morning-20261128 = jobcrawl main 64e6686 + this script). Live crawl state is only read (~/atlas/crawl/scan).
# Every step logs a start and a result line to $R/logs/morning.log; a failure stops the chain with its reason. Disk guard: 45 GB free.
#   jcx_morning.sh [--dry-run]
set -u
R=$HOME/atlas/bench/jcx-record-20261128
CODE=$R/ops-morning
REC_CODE=${REC_CODE:-$HOME/atlas/jcx/rec-8726383/code}   # the recorder with pacing and connect retries (jobcrawl fix/record-pacing 8726383)
LOG=$R/logs/morning.log
LIVE_SCAN=$HOME/atlas/crawl/scan
MIN_FREE_GB=45
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
mkdir -p "$R/logs"
say() { echo "$(date -Is) [morning] $*" | tee -a "$LOG"; }
die() { say "STOPPED at step $1: $2"; exit 1; }
freegb() { df -BG --output=avail "$R" | tail -1 | tr -dc 0-9; }
guard() { local f; f=$(freegb); [ "$f" -ge "$MIN_FREE_GB" ] || die "$1" "free disk ${f} GB < ${MIN_FREE_GB} GB"; }
run() {   # run <step> <cmd...>: logs the command; in a dry run only prints it
  local step=$1; shift
  if [ $DRY = 1 ]; then say "dry-run step $step would run: $*"; return 0; fi
  "$@" >> "$LOG" 2>&1
}

say "start dry_run=$DRY code=$CODE ($(git -C "$CODE" rev-parse --short HEAD 2>/dev/null || echo 'no git')) node=$(node --version) free_gb=$(freegb) R=$R"
[ -d "$CODE/.git" ] || die 0 "code checkout $CODE missing"
git -C "$CODE" merge-base --is-ancestor 64e66868484366680a71eaf905aa2930e7653c2f HEAD || die 0 "code checkout does not contain jobcrawl main 64e6686"
if [ ! -f "$R/out/boards.jsonl" ]; then [ $DRY = 1 ] && say "dry-run: no recording at $R/out yet (boards.jsonl missing); continuing the dry run" || die 0 "no recording at $R/out (boards.jsonl missing)"; fi
[ -f "$LIVE_SCAN/scan-history.tsv" ] || die 0 "live history $LIVE_SCAN/scan-history.tsv missing"
cd "$CODE" || die 0 "cannot cd to $CODE"

# 1 ---------------------------------------------------------------------------------------------------------------------
REC_UNIT=${REC_UNIT:-jcx-record2.service}   # the re-run of the recording (the 01:20 run, jcx-record.service, failed on connect timeouts)
WAIT_MIN=${WAIT_MIN:-240}
say "step 1 start: wait for $REC_UNIT to be inactive (max $WAIT_MIN min)"
for i in $(seq 0 "$WAIT_MIN"); do
  st=$(systemctl --user show "$REC_UNIT" -p ActiveState --value)
  [ "$st" = inactive ] || [ "$st" = failed ] && break
  [ $DRY = 1 ] && { say "dry-run: jcx-record is $st (would wait)"; break; }
  [ "$i" = "$WAIT_MIN" ] && die 1 "$REC_UNIT still $st after $WAIT_MIN min"
  sleep 60
done
say "step 1 result: $REC_UNIT is $(systemctl --user show "$REC_UNIT" -p ActiveState --value); recording log: $(tail -1 "$R/logs/record.log" 2>/dev/null | cut -c1-200)"

# 2 ---------------------------------------------------------------------------------------------------------------------
guard 2
say "step 2 start: re-read the boards that timed out"
TO=0; NL=0
if [ -f "$R/out/boards.jsonl" ]; then TO=$(grep -c '"cls":"TIMEOUT' "$R/out/boards.jsonl" || true); NL=$(wc -l < "$R/out/boards.jsonl"); fi
say "step 2: $TO TIMEOUT lines in boards.jsonl ($NL lines)"
if [ "$TO" -gt 0 ]; then
  BK="$R/out/boards.jsonl.bak-$(date +%Y%m%d-%H%M%S)"
  SUB="$R/companies-timeout.json"
  if [ $DRY = 1 ]; then
    say "dry-run step 2 would: cp boards.jsonl -> $BK; drop $TO TIMEOUT lines; write $SUB with those boards; resume record.mjs on it (stop 10:45, hard stop 11:00)"
  else
    cp "$R/out/boards.jsonl" "$BK" || die 2 "backup failed"
    node -e '
      const fs = require("fs"); const [bj, comp, sub] = process.argv.slice(1);
      const lines = fs.readFileSync(bj, "utf8").split("\n").filter(Boolean);
      const to = new Set(); const keep = [];
      for (const l of lines) { let o; try { o = JSON.parse(l); } catch { keep.push(l); continue; } if (/^TIMEOUT/.test(o.cls ?? "")) to.add(o.board); else keep.push(l); }
      fs.writeFileSync(bj + ".tmp", keep.join("\n") + "\n"); fs.renameSync(bj + ".tmp", bj);
      const c = JSON.parse(fs.readFileSync(comp, "utf8"));
      c.tracked_companies = c.tracked_companies.filter((e) => to.has(e.name));
      fs.writeFileSync(sub, JSON.stringify(c));
      console.log(`removed ${lines.length - keep.length} TIMEOUT lines, ${c.tracked_companies.length} boards to re-read`);
    ' "$R/out/boards.jsonl" "$R/companies.json" "$SUB" >> "$LOG" 2>&1 || die 2 "could not prepare the TIMEOUT re-read"
    node --no-warnings "$REC_CODE/bench/record.mjs" --profile "$R/profile" --companies "$SUB" --out "$R/out" --log "$R/logs/record-timeouts.log" \
      --seed-cache "$HOME/atlas/crawl/scan" --live-index "$HOME/atlas/raw/index" --live-gap-ms 60000 --live-max-wait-ms 20000 \
      --global-gap-ms 250 --connect-retries 2 --concurrency 4 --host-concurrency 2 --host-gap-ms 500 --probe-max 5 --exclude eures,usajobs \
      --stop-at "$(date +%F)T10:45:00+01:00" --hard-stop "$(date +%F)T11:00:00+01:00" --min-free-gb $MIN_FREE_GB >> "$LOG" 2>&1 \
      || die 2 "record.mjs re-read failed (exit $?); see $R/logs/record-timeouts.log"
  fi
fi
say "step 2 result: $(tail -1 "$R/logs/record-timeouts.log" 2>/dev/null | cut -c1-220 || echo 'no re-read needed')"

# 3 ---------------------------------------------------------------------------------------------------------------------
guard 3
say "step 3 start: analyse"
run 3 node --no-warnings bench/analyse.mjs --recording "$R/out" --live-index "$HOME/atlas/raw/index" --days 7 --out "$R/out/analysis" || die 3 "analyse.mjs failed (exit $?)"
say "step 3 result: $( [ $DRY = 1 ] && echo dry-run || head -9 "$R/out/analysis/report.md" | grep -E 'Projection|Boards' | tr '\n' ' ' | cut -c1-300)"

# 4 ---------------------------------------------------------------------------------------------------------------------
guard 4
say "step 4 start: baseline import into $R/shadow (no --replace; live history read-only)"
run 4 node --no-warnings cli/jobcrawl.mjs import --profile "$R/profile" --companies "$R/companies.json" --data "$R/shadow" --legacy-data "$LIVE_SCAN" --boards all --json \
  || die 4 "import failed (exit $?)"
say "step 4 result: $( [ $DRY = 1 ] && echo dry-run || grep -h '^\[import\]\|"imported"' "$LOG" | tail -1 | cut -c1-200)"

# 5 ---------------------------------------------------------------------------------------------------------------------
guard 5
say "step 5 start: dual-run over the recording"
rc=0
if [ $DRY = 1 ]; then say "dry-run step 5 would run: node cli/jobcrawl.mjs dual-run --profile $R/profile --companies $R/companies.json --data $R/shadow --legacy-data $LIVE_SCAN --replay $R/out --boards all --report $R/parity.json --ledger $R/ledger.json --json"
else
  node --no-warnings cli/jobcrawl.mjs dual-run --profile "$R/profile" --companies "$R/companies.json" --data "$R/shadow" --legacy-data "$LIVE_SCAN" \
    --replay "$R/out" --boards all --report "$R/parity.json" --ledger "$R/ledger.json" --json >> "$LOG" 2>&1; rc=$?
  [ $rc -le 1 ] || die 5 "dual-run failed (exit $rc)"
fi
say "step 5 result: exit $rc (1 = some boards had no recorded answer, expected)"

# 6 ---------------------------------------------------------------------------------------------------------------------
say "step 6 start: summary"
if [ $DRY = 1 ]; then say "dry-run step 6 would write $R/MORNING_SUMMARY.md and copy it and report.md to $R/out/"
else
  node -e '
    const fs = require("fs"); const [R] = process.argv.slice(1);
    const an = JSON.parse(fs.readFileSync(`${R}/out/analysis/report.json`, "utf8"));
    const par = fs.existsSync(`${R}/parity.json`) ? JSON.parse(fs.readFileSync(`${R}/parity.json`, "utf8")) : null;
    const mb = (b) => (b / 1e6).toFixed(1), pct = (a, b) => (b ? Math.round(100 * a / b) + " %" : "-");
    const P = Object.entries(an.providers).sort((a, b) => b[1].boards - a[1].boards);
    const L = [`# JOBCRAWLX morning summary (${new Date().toISOString().slice(0, 16)} UTC)`, "",
      `Recording: ${an.totals.boards} boards, ${an.totals.requests} requests, wire ${mb(an.totals.wire_bytes)} MB, decoded ${mb(an.totals.decoded_bytes)} MB, ${an.totals.probes} conditional probes.`,
      `Failures by class: ${JSON.stringify(an.totals.failures)}.`,
      `Projected list bytes/day: ${mb(an.projection.now_bytes_day)} MB now -> ${mb(an.projection.cond_bytes_day)} MB with conditional requests (saving ${Math.round(an.projection.saving * 100)} %); live index ${an.live_days} days.`,
      `Hosts answering 304 (candidates): ${an.projection.hosts_to_switch_on.length}; per provider: ${Object.entries(an.projection.provider_patterns).map(([p, h]) => `${p} (${h.slice(0, 3).join(" ")}${h.length > 3 ? " ..." : ""})`).join("; ") || "none"}.`, "",
      "| provider | boards | failed | probes | true 304 | 200 same | 200 diff | change rate | parity pass | near | fail | empty | error |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
    for (const [k, p] of P) { const q = par?.providers?.[k] ?? {}; L.push(`| ${k} | ${p.boards} | ${p.failed} | ${p.probes} | ${pct(p.p304, p.probes)} | ${pct(p.p200same, p.probes)} | ${pct(p.p200diff, p.probes)} | ${p.change_rate ?? "-"} | ${q.pass ?? 0} | ${q.near ?? 0} | ${q.fail ?? 0} | ${q.empty ?? 0} | ${q.error ?? 0} |`); }
    if (par) {
      const fails = par.boards.filter((b) => b.verdict === "fail").sort((a, b) => (b.only_legacy + b.only_new) - (a.only_legacy + a.only_new)).slice(0, 15);
      L.push("", "Top parity failures (boards):", ...fails.map((b) => `- ${b.board} (${b.provider}): legacy ${b.legacy}, new ${b.new}, only legacy ${b.only_legacy}, only new ${b.only_new}, title diff ${b.title_diff}`));
    }
    L.push("", "Files: out/analysis/report.md, parity.json, ledger.json, logs/morning.log. Parity here compares the night recording with the live history as of this morning: boards that changed in between show as near/fail.");
    fs.writeFileSync(`${R}/MORNING_SUMMARY.md`, L.join("\n") + "\n");
    console.log("summary written");
  ' "$R" >> "$LOG" 2>&1 || die 6 "summary failed"
  cp "$R/MORNING_SUMMARY.md" "$R/out/MORNING_SUMMARY.md" && cp "$R/out/analysis/report.md" "$R/out/report.md" || die 6 "copy failed"
fi
say "step 6 result: $R/MORNING_SUMMARY.md"
say "done"
