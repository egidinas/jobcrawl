#!/bin/bash
# One-shot cut-over of the 5 greenhouse boards to the authority path, run by jcx-flip.timer (every 10 min) until it is done or rolled back.
# A small state machine in $F/state (waiting -> flipped -> done | rolled-back); every run appends one line to $F/flip.log.
#   waiting: flips only when ALL hold:
#     - the ledger (ledger-v3.json) marks each of the 5 boards eligible (3 consecutive same-fetch passes, each <= 72 h old);
#     - the review fixes are live in the crawl code the cycle runs (markers in $CODE/jobcrawl/core/route/authority.mjs and crawl.mjs);
#     - no made-cycle is running (the first cycle after the flip runs entirely on the new routing);
#     then routing.json is backed up and rewritten atomically: the 5 boards "new" and allow_new: true (provider routes untouched).
#   flipped: every cycle log that finished after the flip is checked by authority-check.mjs; a red cycle, or a ledger fail for one of
#     the 5 boards, rolls back at once (the pre-flip routing.json restored atomically, ROLLED_BACK.flag written, timer stopped).
#     Done after DONE_H hours (12) with every one of the 5 boards committed by the authority path at least twice and no red: the
#     routing stays, the timer stops, $F/report.txt is written. Rollback after that is by hand: restore $F/routing.pre-flip.json.
#   authority-flip.sh "<board 1>|...|<board 5>"
set -u
BOARDS=${1:?boards}
OPS=$(cd "$(dirname "$0")" && pwd)
J=$HOME/atlas/jcx; F=$J/flip; mkdir -p "$F"
ROUTING=$J/routing.json; LEDGER=$J/ledger-v3.json; STORE=$J/shadow-v3
CODE=$HOME/atlas/crawl/code
CYCLES=$HOME/atlas/logs/cycle
DONE_H=${DONE_H:-12}
STATE=$(cat "$F/state" 2>/dev/null || echo waiting)
log() { echo "$(date -Is) [$STATE] $*" >> "$F/flip.log"; }
write_routing() {   # write_routing <src json> : atomic replace of routing.json
  cp "$1" "$ROUTING.tmp.$$" && mv -f "$ROUTING.tmp.$$" "$ROUTING"
}
stop_timer() { systemctl --user stop jcx-flip.timer >/dev/null 2>&1 || true; }
rollback() {
  write_routing "$F/routing.pre-flip.json"
  echo rolled-back > "$F/state"
  echo "$(date -Is) $*" > "$J/ROLLED_BACK.flag"
  log "ROLLED BACK: $* (routing.json restored from routing.pre-flip.json)"
  stop_timer
  exit 0
}
case "$STATE" in
waiting)
  why=()
  elig=$(cd "$OPS/../.." && node --input-type=module -e '
    const [lf, names] = process.argv.slice(1);
    const { loadLedger, isEligible } = await import((await import("node:url")).pathToFileURL(process.cwd() + "/core/route/ledger.mjs").href);
    const L = loadLedger(lf); const res = names.split("|").map((b) => [b, L.boards[b] ? isEligible(L.boards[b].parity) : false, (L.boards[b]?.parity ?? []).slice(-3).map((p) => p.verdict).join(",")]);
    console.log(res.every(([, e]) => e) ? "ok" : "not: " + res.filter(([, e]) => !e).map(([b, , v]) => `${b} [${v}]`).join("; "));
  ' "$LEDGER" "$BOARDS" 2>&1)
  [ "$elig" = ok ] || why+=("ledger $elig")
  A=$CODE/jobcrawl/core/route/authority.mjs
  if ! { [ -f "$A" ] && grep -q 'provider routes refused' "$A" && grep -q 'all routed boards unread' "$A" && grep -q 'try { byNew = authMod.decide' "$CODE/jobcrawl/crawler/crawl.mjs"; }; then why+=("review fixes not live in $CODE (commit $(git -C "$CODE" rev-parse --short HEAD 2>/dev/null))"); fi
  [ "$(systemctl --user is-active made-cycle.service 2>/dev/null)" = active ] && why+=("a made-cycle is running")
  if [ ${#why[@]} -gt 0 ]; then log "waiting: ${why[*]}"; exit 0; fi
  cp "$ROUTING" "$F/routing.pre-flip.json"
  node -e 'const fs = require("fs"); const [src, out, names] = process.argv.slice(1); const r = JSON.parse(fs.readFileSync(src, "utf8"));
    if (r.kill_switch) { console.error("kill switch set in routing.json"); process.exit(3); }
    r.allow_new = true; r.boards = { ...(r.boards ?? {}), ...Object.fromEntries(names.split("|").map((b) => [b, "new"])) }; fs.writeFileSync(out, JSON.stringify(r, null, 1));' \
    "$ROUTING" "$F/routing.flipped.json" "$BOARDS" || { log "not flipped: routing check failed"; exit 0; }
  write_routing "$F/routing.flipped.json"
  date +%s > "$F/flipped_at"
  echo flipped > "$F/state"; STATE=flipped
  log "FLIPPED: $BOARDS routed new with allow_new: true (code $(git -C "$CODE" rev-parse --short HEAD), ledger ok); pre-flip routing in $F/routing.pre-flip.json"
  exit 0 ;;
flipped)
  T0=$(cat "$F/flipped_at")
  touch -d "@$T0" "$F/.t0"
  touch "$F/checked.txt"
  for c in $(find "$CYCLES" -maxdepth 1 -name 'cycle_*.log' -newer "$F/.t0" | sort); do
    grep -qxF "$c" "$F/checked.txt" && continue
    grep -q '\[cycle\] result:' "$c" || continue           # still running
    chk=$(node "$OPS/authority-check.mjs" "$c" --routing "$ROUTING" --boards "$BOARDS"); rc=$?
    echo "$c" >> "$F/checked.txt"
    log "cycle $(basename "$c"): exit $rc $chk"
    [ "$rc" = 2 ] && rollback "red cycle $(basename "$c"): $chk"
  done
  # a ledger fail for one of the 5 boards after the flip (the state comes from the same answer the history does: any mismatch is a bug)
  lf=$(node -e 'const L = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const t0 = Number(process.argv[3]) * 1000;
    const bad = process.argv[2].split("|").flatMap((b) => (L.boards[b]?.parity ?? []).filter((p) => Date.parse(p.t) > t0 && p.verdict !== "pass" && p.verdict !== "empty").map((p) => `${b} ${p.verdict}`));
    console.log(bad.join("; "));' "$LEDGER" "$BOARDS" "$T0")
  [ -n "$lf" ] && rollback "ledger after the flip: $lf"
  # done: DONE_H hours and each board committed by the authority path at least twice (events after the flip in its store log)
  commits=$(node -e '
    const fs = require("fs"); const crypto = require("crypto"); const [root, names, t0] = process.argv.slice(1);
    const key = (b) => `${String(b).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "board"}-${crypto.createHash("sha256").update(String(b)).digest("hex").slice(0, 8)}`;
    const out = names.split("|").map((b) => { let n = 0; try { for (const l of fs.readFileSync(`${root}/boards/${key(b)}/events.ndjson`, "utf8").split("\n")) { if (!l) continue; const e = JSON.parse(l); if (e.op === "board-ok" && e.by === "authority" && Date.parse(e.t) > Number(t0) * 1000) n++; } } catch {} return `${b}=${n}`; });
    console.log(out.join(" "));' "$STORE" "$BOARDS" "$T0")
  log "commits since the flip: $commits"
  age_h=$(( ( $(date +%s) - T0 ) / 3600 ))
  if [ "$age_h" -ge "$DONE_H" ] && ! echo "$commits" | grep -qE '=[01]( |$)'; then
    echo done > "$F/state"
    { echo "authority cut-over: done after ${age_h} h, no red cycle, no ledger fail"; echo "boards: $BOARDS"; echo "commits since the flip: $commits";
      echo "cycles checked: $(wc -l < "$F/checked.txt")"; echo "rollback by hand: cp $F/routing.pre-flip.json $ROUTING"; } > "$F/report.txt"
    log "DONE: $(head -1 "$F/report.txt")"
    stop_timer
  fi
  exit 0 ;;
*) log "nothing to do (state $STATE)"; stop_timer; exit 0 ;;
esac
