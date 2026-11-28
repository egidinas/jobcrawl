#!/bin/bash
# Fixture test of authority-check.mjs and authority-flip.sh with a fake HOME (no systemd needed; nothing outside the temp folder).
#   bash bench/ops/authority-flip.test.sh   -> prints PASS or the first failure, exit 0/1
set -u
OPS=$(cd "$(dirname "$0")" && pwd); command -v cygpath >/dev/null && OPS=$(cygpath -m "$OPS")
T=$(mktemp -d); command -v cygpath >/dev/null && T=$(cygpath -m "$T"); export HOME=$T
fail() { echo "FAIL: $*"; exit 1; }
B="Acme|Beta"
mkdir -p "$T/atlas/jcx/shadow-v3/boards" "$T/atlas/crawl/code/jobcrawl/core/route" "$T/atlas/crawl/code/jobcrawl/crawler" "$T/atlas/logs/cycle"
echo '{"schema":"routing/v1","allow_new":false,"providers":{"greenhouse":"shadow"},"boards":{}}' > "$T/atlas/jcx/routing.json"
now=$(node -e 'console.log(new Date().toISOString())')
ledger() { node -e 'const [f, t, v] = process.argv.slice(1); const p = (n) => Array.from({ length: n }, () => ({ t, verdict: v }));
  require("fs").writeFileSync(f, JSON.stringify({ schema: "ledger/v1", boards: { Acme: { parity: p(3) }, Beta: { parity: p(Number(process.argv[4])) } } }));' "$T/atlas/jcx/ledger-v3.json" "$now" pass "$1"; }
# --- checker
R=$T/r.json; echo '{"allow_new":true,"boards":{"Acme":"new"}}' > "$R"
printf '[authority] boards routed new 1, decided 1 (committed 1, not reached 0, errors 0), closed by the new path 2, kept open 0, legacy fallback rows 0, no baseline 0, lease busy 0, failed reads 0, setup failed 0, low memory 0, provider routes refused 0\n[shadow] boards shadowed 3\n' > "$T/g.log"
node "$OPS/authority-check.mjs" "$T/g.log" --routing "$R" > /dev/null || fail "green log not green"
sed 's/kept open 0/kept open 1/' "$T/g.log" > "$T/k.log"; node "$OPS/authority-check.mjs" "$T/k.log" --routing "$R" > /dev/null; [ $? = 2 ] || fail "kept open not red"
printf '[shadow] boards shadowed 3\n' > "$T/n.log"; node "$OPS/authority-check.mjs" "$T/n.log" --routing "$R" > /dev/null; [ $? = 2 ] || fail "missing line not red"
printf '[authority] off this cycle: x\n[cycle] result: OK\n' > "$T/o.log"; node "$OPS/authority-check.mjs" "$T/o.log" --routing "$R" > /dev/null; [ $? = 2 ] || fail "off this cycle not red"
printf '[shadow] boards shadowed 3\n' > "$T/n2.log"; echo '{"allow_new":false,"boards":{"Acme":"new"}}' > "$T/r2.json"
node "$OPS/authority-check.mjs" "$T/n2.log" --routing "$T/r2.json" > /dev/null || fail "not armed should be ok"
# --- flip: waiting (ledger short, fixes missing)
ledger 2
bash "$OPS/authority-flip.sh" "$B"; grep -q 'waiting: ledger not: Beta' "$T/atlas/jcx/flip/flip.log" || fail "not waiting on the ledger: $(tail -1 "$T/atlas/jcx/flip/flip.log")"
grep -q 'review fixes not live' "$T/atlas/jcx/flip/flip.log" || fail "not waiting on the fixes"
ledger 3
echo "provider routes refused / all routed boards unread" > "$T/atlas/crawl/code/jobcrawl/core/route/authority.mjs"
echo "try { byNew = authMod.decide(AUTH" > "$T/atlas/crawl/code/jobcrawl/crawler/crawl.mjs"
bash "$OPS/authority-flip.sh" "$B"
[ "$(cat "$T/atlas/jcx/flip/state")" = flipped ] || fail "not flipped: $(tail -1 "$T/atlas/jcx/flip/flip.log")"
node -e 'const r = require(process.argv[1]); if (!(r.allow_new === true && r.boards.Acme === "new" && r.boards.Beta === "new" && r.providers.greenhouse === "shadow")) process.exit(1)' "$T/atlas/jcx/routing.json" || fail "routing not flipped"
# --- flipped: a green cycle, then a red one -> rollback
sleep 1
cp "$T/g.log" "$T/atlas/logs/cycle/cycle_1.log"; echo '[cycle] result: OK' >> "$T/atlas/logs/cycle/cycle_1.log"
sed -i 's/boards routed new 1, decided 1/boards routed new 2, decided 2/' "$T/atlas/logs/cycle/cycle_1.log"
bash "$OPS/authority-flip.sh" "$B"
[ "$(cat "$T/atlas/jcx/flip/state")" = flipped ] || fail "green cycle rolled back: $(tail -2 "$T/atlas/jcx/flip/flip.log")"
cp "$T/k.log" "$T/atlas/logs/cycle/cycle_2.log"; echo '[cycle] result: OK' >> "$T/atlas/logs/cycle/cycle_2.log"
bash "$OPS/authority-flip.sh" "$B"
[ "$(cat "$T/atlas/jcx/flip/state")" = rolled-back ] || fail "red cycle not rolled back: $(tail -2 "$T/atlas/jcx/flip/flip.log")"
cmp -s "$T/atlas/jcx/routing.json" "$T/atlas/jcx/flip/routing.pre-flip.json" || fail "routing not restored"
[ -f "$T/atlas/jcx/ROLLED_BACK.flag" ] || fail "no flag"
echo "PASS ($T)"
