#!/bin/bash
# Crash-aware one-shot check of the first made-cycle on shadow-v3 (after the heap fixes). Runs from jcx-first-cycle-v3.timer every
# 10 min. Waits for a cycle that STARTED after ~/atlas/jcx/v3_armed_at and FINISHED, then writes its [shadow] line, heap figures and
# crawl-step result to ~/atlas/jcx/first_cycle_v3.txt and stops its own timer.
# Rolls the shadow back (removes the drop-in + daemon-reload) when the cycle log shows ANY of: a crawl-step failure, a heap OOM or other
# FATAL ERROR, a board-path FAIL, a shadow error, failed or low-memory boards, boards over budget, or no [shadow] line at all.
OUT=$HOME/atlas/jcx/first_cycle_v3.txt
LOG=$HOME/atlas/jcx/first_cycle_check_v3.log
DROPIN=$HOME/.config/systemd/user/made-cycle.service.d/jcx-shadow.conf
say() { echo "$(date -Is) $*" >> "$LOG"; }
ARMED=$(cat "$HOME/atlas/jcx/v3_armed_at" 2>/dev/null)
[ -n "$ARMED" ] || { say "no v3_armed_at marker; nothing to check"; exit 0; }
f=""
for c in $(ls -t "$HOME"/atlas/logs/cycle/cycle_*.log 2>/dev/null); do
  ts=$(basename "$c" .log | sed -E 's/^cycle_([0-9-]+)_([0-9]{2})-([0-9]{2})$/\1 \2:\3/')
  s=$(date -d "$ts" +%s 2>/dev/null) || continue
  [ "$s" -ge "$ARMED" ] && f=$c
done
[ -n "$f" ] || { say "waiting: no cycle started after $(date -d @"$ARMED" -Is)"; exit 0; }
newest=$(ls -t "$HOME"/atlas/logs/cycle/cycle_*.log | head -1)
if [ "$newest" = "$f" ]; then
  st=$(systemctl --user show made-cycle.service -p ActiveState --value)
  if [ "$st" = active ] || [ "$st" = activating ]; then say "waiting: $f still running ($st)"; exit 0; fi
fi
shadow=$(grep -h -E "\[shadow\]" "$f" | tail -3)
crawl=$(grep -h -E '\[run\] step "crawl"' "$f" | tail -2)
crash=$(grep -h -E 'heap out of memory|FATAL ERROR|step "crawl" failed|result: FAIL|later steps skipped' "$f" | head -3)
{ echo "first cycle on shadow-v3: $f"; echo "crawl step: ${crawl:-(no line)}"; echo "shadow: ${shadow:-(no [shadow] line)}"; [ -n "$crash" ] && echo "CRASH: $crash"; } > "$OUT"
if [ -n "$crash" ] || [ -z "$shadow" ] || echo "$shadow" | grep -q -E "skipped this cycle|capture failed|capture skipped|unreadable|not found|failed [1-9]|over budget [1-9]|low memory [1-9]"; then
  rm -f "$DROPIN" && systemctl --user daemon-reload && echo "ROLLED BACK: drop-in removed, daemon-reload done ($(date -Is))" >> "$OUT"
fi
say "result written to $OUT"
systemctl --user stop jcx-first-cycle-v3.timer
