#!/bin/bash
# One-shot switch of the greenhouse shadow to the v2 store (JOBCRAWLX baseline fixes, jobcrawl e4ce973 / madenetwork 89716e7116).
# Runs from jcx-switch-v2.timer every 2 min until done. Each run: does nothing while the NUC crawl checkout does not contain 89716e7116
# or while a made-cycle is running (the import reads the live history, which the cycle rewrites). Then, between two cycles:
#   1 a plain `jobcrawl import` (never --replace) of the routed (greenhouse) boards into ~/atlas/jcx/shadow-v2, from the crawl checkout's
#     own code; companies = companies.json + the companies overlay (as the cycle uses them); live history read-only
#   2 the drop-in's JOBCRAWL_SHADOW_DATA -> %h/atlas/jcx/shadow-v2 and the marker ~/atlas/jcx/v2_armed_at (epoch seconds)
#   3 daemon-reload, start jcx-first-cycle-v2.timer, stop this timer
# The old store ~/atlas/jcx/shadow is kept. Log ~/atlas/jcx/switch_v2.log; result ~/atlas/jcx/switch_v2.txt. A failure stops with a
# reason in both and leaves the drop-in as it was (still on the old store).
set -u
J=$HOME/atlas/jcx
CODE=$HOME/atlas/crawl/code
DROPIN=$HOME/.config/systemd/user/made-cycle.service.d/jcx-shadow.conf
LOG=$J/switch_v2.log
OUT=$J/switch_v2.txt
say() { echo "$(date -Is) [switch-v2] $*" >> "$LOG"; }
stop() { say "STOPPED: $*"; echo "switch to shadow-v2 STOPPED $(date -Is): $*" > "$OUT"; systemctl --user stop jcx-switch-v2.timer; exit 1; }

git -C "$CODE" merge-base --is-ancestor 89716e7116 HEAD 2>/dev/null || { say "waiting: crawl checkout at $(git -C "$CODE" rev-parse --short=10 HEAD), not yet 89716e7116"; exit 0; }
st=$(systemctl --user show made-cycle.service -p ActiveState --value)
[ "$st" = active ] || [ "$st" = activating ] && { say "waiting: made-cycle is $st"; exit 0; }
[ -e "$J/shadow-v2/boards" ] && stop "$J/shadow-v2 already has boards; not importing over it"
[ -f "$DROPIN" ] || stop "drop-in $DROPIN missing (rolled back?); not switching"

say "start: checkout $(git -C "$CODE" rev-parse --short=10 HEAD), made-cycle $st, free $(df -BG --output=avail "$J" | tail -1 | tr -dc 0-9) GB"
node -e '
  const fs = require("fs"); const [code, overlay, out] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(`${code}/crawler/companies.json`, "utf8"));
  let o = { tracked_companies: [] }; try { o = JSON.parse(fs.readFileSync(overlay, "utf8")); } catch {}
  const names = new Set(c.tracked_companies.map((e) => e.name));
  for (const e of o.tracked_companies ?? []) if (!names.has(e.name)) c.tracked_companies.push(e);
  fs.writeFileSync(out, JSON.stringify(c)); console.log(`companies ${c.tracked_companies.length}`);
' "$CODE" "$HOME/atlas/crawl/eco_state/companies_overlay.json" "$J/companies-import-v2.json" >> "$LOG" 2>&1 || stop "could not build the companies file"
res=$(cd "$CODE" && node --no-warnings jobcrawl/cli/jobcrawl.mjs import --profile jobcrawl-profile --companies "$J/companies-import-v2.json" \
  --data "$J/shadow-v2" --legacy-data "$HOME/atlas/crawl/scan" --boards routed --routing "$J/routing.json" --json 2>>"$LOG") || stop "import failed (exit $?): $res"
say "import: $res"
echo "$res" | grep -q '"imported":[1-9]' || stop "import imported nothing: $res"
sed -i 's#^Environment=JOBCRAWL_SHADOW_DATA=.*#Environment=JOBCRAWL_SHADOW_DATA=%h/atlas/jcx/shadow-v2#' "$DROPIN" || stop "drop-in edit failed"
grep -q 'JOBCRAWL_SHADOW_DATA=%h/atlas/jcx/shadow-v2' "$DROPIN" || stop "drop-in does not point at shadow-v2 after the edit"
date +%s > "$J/v2_armed_at"
systemctl --user daemon-reload || stop "daemon-reload failed"
systemctl --user start jcx-first-cycle-v2.timer || stop "could not start jcx-first-cycle-v2.timer"
{ echo "switched to shadow-v2 at $(date -Is)"; echo "import: $res"; echo "drop-in: $(grep JOBCRAWL_SHADOW_DATA "$DROPIN")"; echo "first-cycle checker: jcx-first-cycle-v2.timer started -> $J/first_cycle_v2.txt"; } > "$OUT"
say "done: $(tr '\n' ' ' < "$OUT")"
systemctl --user stop jcx-switch-v2.timer
