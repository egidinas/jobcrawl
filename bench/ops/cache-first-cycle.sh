#!/bin/bash
# One-shot watcher for the first made-cycle with the conditional cache (madenetwork 6dddc45376 / jobcrawl 677b33d), from
# jcx-cache-first.timer every 10 min. It picks the first cycle log (started after ~/atlas/jcx/cache_armed_at) whose crawl printed
# "conditional requests on|OFF" (only the new code prints that), waits until that cycle has its "[cycle] result:" line, then writes
# ~/atlas/jcx/cache_first_cycle.txt: the "crawl: conditional cache:" counters, the cycle result, connect/board timeout counts.
# Rollback, without any git change, when the cycle failed (preferred: a made-cycle drop-in with JOBCRAWL_CONDITIONAL_CACHE=0 when the
# crawl code honours it, jobcrawl 3b64151 and later; otherwise the blocking file below) (result not OK, crawl step failed, OOM/FATAL) or cache errors > 5 % of the
# cached requests: the cache folder is renamed to http-cache.disabled-<time> and a FILE named http-cache is put in its place, so the
# crawl's install step fails to create the folder and logs "conditional requests OFF" on the next cycle (core/fetch/conditional.mjs,
# crawl.mjs). Undo: delete the file (the folder is re-created on the next cycle). Then it stops its own timer.
OUT=$HOME/atlas/jcx/cache_first_cycle.txt
LOG=$HOME/atlas/jcx/cache_first_cycle_check.log
CACHE=$HOME/atlas/jcx/http-cache
say() { echo "$(date -Is) $*" >> "$LOG"; }
ARMED=$(cat "$HOME/atlas/jcx/cache_armed_at" 2>/dev/null)
[ -n "$ARMED" ] || { say "no cache_armed_at marker"; exit 0; }
f=""
for c in $(ls -tr "$HOME"/atlas/logs/cycle/cycle_*.log 2>/dev/null); do
  ts=$(basename "$c" .log | sed -E 's/^cycle_([0-9-]+)_([0-9]{2})-([0-9]{2})$/\1 \2:\3/')
  s=$(date -d "$ts" +%s 2>/dev/null) || continue
  [ "$s" -ge "$ARMED" ] || continue
  grep -q -E "conditional requests (on|OFF)" "$c" && { f=$c; break; }
done
[ -n "$f" ] || { say "waiting: no cycle with the cache code yet (checkout $(git -C "$HOME/atlas/crawl/code" rev-parse --short=10 HEAD))"; exit 0; }
result=$(grep -h -E '\[cycle\] result:' "$f" | tail -1)
if [ -z "$result" ]; then
  st=$(systemctl --user show made-cycle.service -p ActiveState --value)
  if [ "$st" = active ] || [ "$st" = activating ]; then say "waiting: $f still running"; exit 0; fi
  result="(no [cycle] result line; made-cycle is $st)"
fi
onoff=$(grep -h -E "conditional requests (on|OFF)" "$f" | head -1)
counters=$(grep -h -E "crawl: conditional cache:" "$f" | tail -1)
crash=$(grep -h -E 'heap out of memory|FATAL ERROR|step "crawl" failed|result: FAIL|later steps skipped' "$f" | head -3)
ct=$(grep -c UND_ERR_CONNECT_TIMEOUT "$f"); to=$(grep -c 'Timed out after' "$f")
# cache error rate: errors / all cached-host requests the counters name
rate=$(echo "$counters" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const n = (re) => Number((s.match(re) ?? [])[1] ?? 0);
    const total = n(/(\d+) served from cache/) + n(/(\d+) stored/) + n(/(\d+) refreshed/) + n(/(\d+) expired/) + n(/(\d+) not cacheable/) + n(/(\d+) corrupt/) + n(/\+ (\d+) recovered/);
    const err = n(/(\d+) errors/);
    console.log(total ? (100 * err / total).toFixed(1) : "0");
  });')
{ echo "first cycle with the conditional cache: $f"; echo "install: ${onoff:-(none)}"; echo "counters: ${counters:-(no counters line)}"; echo "cache error rate: ${rate} %";
  echo "result: $result"; echo "connect timeouts: $ct, board timeouts: $to"; [ -n "$crash" ] && echo "CRASH: $crash"; } > "$OUT"
bad=""
[ -n "$crash" ] && bad="cycle crashed"
echo "$result" | grep -q "result: OK" || bad="${bad:+$bad; }cycle result not OK"
awk -v r="$rate" 'BEGIN{exit !(r+0 > 5)}' && bad="${bad:+$bad; }cache errors ${rate} % > 5 %"
if [ -n "$bad" ] && echo "$onoff" | grep -q "requests on"; then
  stamp=$(date +%Y%m%d-%H%M%S)
  DROPIN=$HOME/.config/systemd/user/made-cycle.service.d/jcx-cache-off.conf
  if grep -q JOBCRAWL_CONDITIONAL_CACHE "$HOME/atlas/crawl/code/jobcrawl/crawler/crawl.mjs" 2>/dev/null; then
    # the crawl honours the switch: a drop-in turns the cache off for the made-cycle unit (undo: delete it + daemon-reload)
    printf '%s
' "# JOBCRAWLX: conditional cache switched off by jcx-cache-first at $(date -Is) ($bad). Undo: delete this file + systemctl --user daemon-reload." '[Service]' 'Environment=JOBCRAWL_CONDITIONAL_CACHE=0' > "$DROPIN"
    systemctl --user daemon-reload
    echo "ROLLED BACK ($bad): $DROPIN sets JOBCRAWL_CONDITIONAL_CACHE=0 for made-cycle; the next cycle logs 'conditional requests OFF'. Undo: rm $DROPIN && systemctl --user daemon-reload ($(date -Is))" >> "$OUT"
  else
    # older crawl without the switch: a file blocks the cache folder, so the install step fails and logs OFF (undo: rm the file)
    { [ -d "$CACHE" ] && mv "$CACHE" "$CACHE.disabled-$stamp"; } ; : > "$CACHE"
    echo "ROLLED BACK ($bad): $CACHE.disabled-$stamp kept; a file now blocks $CACHE, so the next cycle logs 'conditional requests OFF'. Undo: rm $CACHE ($(date -Is))" >> "$OUT"
  fi
fi
say "result written to $OUT${bad:+ (bad: $bad)}"
systemctl --user stop jcx-cache-first.timer
