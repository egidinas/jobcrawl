#!/bin/bash
# One-shot re-arm of the greenhouse shadow on a fresh store, after the heap fixes (jobcrawl 5d187f9 / madenetwork 657a804afa).
# Runs from jcx-rearm-v3.timer every 2 min until done. Each run does nothing while the NUC crawl checkout does not contain
# $NEED (the madenetwork commit with both fixes) or while a made-cycle is running. Then, between two cycles:
#   1 a plain `jobcrawl import` (never --replace) of the routed (greenhouse) boards into ~/atlas/jcx/shadow-v3 from the crawl checkout's
#     own code; companies = companies.json + the companies overlay; live history read-only
#   2 writes the drop-in made-cycle.service.d/jcx-shadow.conf (shadow on, routing ~/atlas/jcx/routing.json, store shadow-v3) and the
#     marker ~/atlas/jcx/v3_armed_at
#   3 daemon-reload, start jcx-first-cycle-v3.timer (crash-aware checker), stop this timer
# Log ~/atlas/jcx/rearm_v3.log; result ~/atlas/jcx/rearm_v3.txt. A failure stops with its reason and leaves shadow off.
set -u
NEED=657a804afa
J=$HOME/atlas/jcx
CODE=$HOME/atlas/crawl/code
DROPIN=$HOME/.config/systemd/user/made-cycle.service.d/jcx-shadow.conf
LOG=$J/rearm_v3.log
OUT=$J/rearm_v3.txt
say() { echo "$(date -Is) [rearm-v3] $*" >> "$LOG"; }
stop() { say "STOPPED: $*"; echo "re-arm on shadow-v3 STOPPED $(date -Is): $*" > "$OUT"; systemctl --user stop jcx-rearm-v3.timer; exit 1; }

git -C "$CODE" merge-base --is-ancestor "$NEED" HEAD 2>/dev/null || { say "waiting: crawl checkout at $(git -C "$CODE" rev-parse --short=10 HEAD), not yet $NEED"; exit 0; }
st=$(systemctl --user show made-cycle.service -p ActiveState --value)
[ "$st" = active ] || [ "$st" = activating ] && { say "waiting: made-cycle is $st"; exit 0; }
[ -e "$J/shadow-v3/boards" ] && stop "$J/shadow-v3 already has boards; not importing over it"
[ -f "$DROPIN" ] && stop "a jcx-shadow drop-in already exists: $(tr '\n' ' ' < "$DROPIN")"
[ -f "$J/routing.json" ] || stop "routing file $J/routing.json missing"
grep -q '"greenhouse": "shadow"' "$J/routing.json" && grep -q '"allow_new": false' "$J/routing.json" || stop "routing.json is not greenhouse-shadow with allow_new false"

say "start: checkout $(git -C "$CODE" rev-parse --short=10 HEAD), made-cycle $st, free $(df -BG --output=avail "$J" | tail -1 | tr -dc 0-9) GB"
node -e '
  const fs = require("fs"); const [code, overlay, out] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(`${code}/crawler/companies.json`, "utf8"));
  let o = { tracked_companies: [] }; try { o = JSON.parse(fs.readFileSync(overlay, "utf8")); } catch {}
  const names = new Set(c.tracked_companies.map((e) => e.name));
  for (const e of o.tracked_companies ?? []) if (!names.has(e.name)) c.tracked_companies.push(e);
  fs.writeFileSync(out, JSON.stringify(c)); console.log(`companies ${c.tracked_companies.length}`);
' "$CODE" "$HOME/atlas/crawl/eco_state/companies_overlay.json" "$J/companies-import-v3.json" >> "$LOG" 2>&1 || stop "could not build the companies file"
res=$(cd "$CODE" && node --no-warnings jobcrawl/cli/jobcrawl.mjs import --profile jobcrawl-profile --companies "$J/companies-import-v3.json" \
  --data "$J/shadow-v3" --legacy-data "$HOME/atlas/crawl/scan" --boards routed --routing "$J/routing.json" --json 2>>"$LOG") || stop "import failed (exit $?): $res"
say "import: $res"
echo "$res" | grep -q '"imported":[1-9]' || stop "import imported nothing: $res"
mkdir -p "$(dirname "$DROPIN")"
cat > "$DROPIN" <<EOF
# JOBCRAWLX strangler-fig shadow for the greenhouse provider family, store shadow-v3 (re-armed $(date -Is) by jcx-rearm-v3 after the
# heap fixes). Rollback: delete this file + systemctl --user daemon-reload.
[Service]
Environment=JOBCRAWL_SHADOW=1
Environment=JOBCRAWL_ROUTING=%h/atlas/jcx/routing.json
Environment=JOBCRAWL_SHADOW_DATA=%h/atlas/jcx/shadow-v3
EOF
date +%s > "$J/v3_armed_at"
systemctl --user daemon-reload || { rm -f "$DROPIN"; stop "daemon-reload failed (drop-in removed)"; }
systemctl --user start jcx-first-cycle-v3.timer || { rm -f "$DROPIN"; systemctl --user daemon-reload; stop "could not start jcx-first-cycle-v3.timer (drop-in removed)"; }
{ echo "re-armed on shadow-v3 at $(date -Is)"; echo "import: $res"; echo "drop-in: $DROPIN"; echo "checker: jcx-first-cycle-v3.timer -> $J/first_cycle_v3.txt"; } > "$OUT"
say "done: $(tr '\n' ' ' < "$OUT")"
systemctl --user stop jcx-rearm-v3.timer
