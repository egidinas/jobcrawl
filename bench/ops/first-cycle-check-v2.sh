#!/bin/bash
# One-shot check of the first made-cycle run on the v2 shadow store (JOBCRAWLX, baseline fixes e4ce973).
# Runs from jcx-first-cycle-v2.timer every 10 min. Waits for a cycle that STARTED after the switch (~/atlas/jcx/v2_armed_at, epoch
# seconds, written when JOBCRAWL_SHADOW_DATA was pointed at ~/atlas/jcx/shadow-v2) and FINISHED; then writes its [shadow] line(s) to
# ~/atlas/jcx/first_cycle_v2.txt, rolls the drop-in back (removes it + daemon-reload) on a shadow error, failed boards or over budget,
# and stops its own timer. Log: ~/atlas/jcx/first_cycle_check_v2.log.
OUT=$HOME/atlas/jcx/first_cycle_v2.txt
LOG=$HOME/atlas/jcx/first_cycle_check_v2.log
DROPIN=$HOME/.config/systemd/user/made-cycle.service.d/jcx-shadow.conf
say() { echo "$(date -Is) $*" >> "$LOG"; }
ARMED=$(cat "$HOME/atlas/jcx/v2_armed_at" 2>/dev/null)
[ -n "$ARMED" ] || { say "no v2_armed_at marker; nothing to check"; exit 0; }
f=""
for c in $(ls -t "$HOME"/atlas/logs/cycle/cycle_*.log 2>/dev/null); do
  ts=$(basename "$c" .log | sed -E 's/^cycle_([0-9-]+)_([0-9]{2})-([0-9]{2})$/\1 \2:\3/')
  s=$(date -d "$ts" +%s 2>/dev/null) || continue
  [ "$s" -ge "$ARMED" ] && f=$c
done
[ -n "$f" ] || { say "waiting: no cycle started after $(date -d @"$ARMED" -Is)"; exit 0; }
newer=$(ls -t "$HOME"/atlas/logs/cycle/cycle_*.log | head -1)
if [ "$newer" = "$f" ]; then
  st=$(systemctl --user show made-cycle.service -p ActiveState --value)
  if [ "$st" = active ] || [ "$st" = activating ]; then say "waiting: $f still running ($st)"; exit 0; fi
fi
line=$(grep -h -E "\[shadow\]" "$f" | tail -3)
[ -n "$line" ] || line="(cycle finished without a [shadow] line: $f)"
{ echo "first cycle on shadow-v2: $f"; echo "$line"; } > "$OUT"
if echo "$line" | grep -q -E "skipped this cycle|unreadable|failed [1-9]|over budget [1-9]|without a \[shadow\]|not found"; then
  rm -f "$DROPIN" && systemctl --user daemon-reload && echo "ROLLED BACK: drop-in removed, daemon-reload done ($(date -Is))" >> "$OUT"
fi
say "result written to $OUT"
systemctl --user stop jcx-first-cycle-v2.timer
