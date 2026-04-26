#!/usr/bin/env bash
# ============================================================
# Synthetic load test (R21 acceptance criterion 5)
# Spawns 100 concurrent headless_client.ts instances split across 12 lobbies
# (8 per lobby + 4 spillover). Aggregates stats to loadtest_results.csv.
#
# Usage:
#   cd server/loadtest
#   ./run.sh wss://tribes-lobby.workers.dev/ws 300
#                ^server URL                    ^duration sec (default 300=5min)
# ============================================================

set -euo pipefail

cd "$(dirname "$0")"

SERVER="${1:-ws://localhost:8080/ws}"
DURATION="${2:-300}"
TOTAL=100
LOBBIES=12

echo "[loadtest] server=$SERVER duration=${DURATION}s clients=$TOTAL lobbies=$LOBBIES"

# CSV header
HEADER='clientId,duration,matchStarted,crashed,pingP50,pingP95,pingP99,kbInPerSec,kbOutPerSec,snapshots,deltas'
echo "$HEADER" > loadtest_results.csv

PIDS=()
for i in $(seq 0 $((TOTAL - 1))); do
  LOBBY="LOAD$(printf '%02d' $((i % LOBBIES)))"
  bun run headless_client.ts \
    --server "$SERVER" \
    --lobby-id "$LOBBY" \
    --duration "$DURATION" \
    --client-id "$i" \
    --silent >> loadtest_results.csv 2>/dev/null &
  PIDS+=($!)
  # Stagger starts by 50ms so we don't all hit the server in the same tick
  sleep 0.05
done

echo "[loadtest] $TOTAL clients running. Waiting up to ${DURATION}s…"
for pid in "${PIDS[@]}"; do
  wait "$pid" || true
done

# Quick aggregate stats
echo "[loadtest] All clients exited. Computing summary…"
TOTAL_LINES=$(($(wc -l < loadtest_results.csv) - 1))
CRASHED=$(awk -F, 'NR>1 && $4==1 {n++} END {print n+0}' loadtest_results.csv)
STARTED=$(awk -F, 'NR>1 && $3==1 {n++} END {print n+0}' loadtest_results.csv)
PING_P95_MAX=$(awk -F, 'NR>1 && $6>m {m=$6} END {print m+0}' loadtest_results.csv)
KB_IN_AVG=$(awk -F, 'NR>1 {s+=$8;n++} END {if(n) printf "%.2f", s/n}' loadtest_results.csv)
KB_OUT_AVG=$(awk -F, 'NR>1 {s+=$9;n++} END {if(n) printf "%.2f", s/n}' loadtest_results.csv)

cat <<EOF
============================================================
Load test summary
============================================================
Total clients:        $TOTAL_LINES
Match-started OK:     $STARTED
Crashed clients:      $CRASHED
Worst-case p95 ping:  ${PING_P95_MAX}ms
Avg ↓ bandwidth/cli:  ${KB_IN_AVG} KB/s
Avg ↑ bandwidth/cli:  ${KB_OUT_AVG} KB/s

Pass criteria:
  - Crashes:            0           (actual: $CRASHED)
  - Worst p95 ping:     <80ms       (actual: ${PING_P95_MAX}ms)
  - Avg ↓ bandwidth:    8-12 KB/s   (actual: ${KB_IN_AVG} KB/s)
  - All clients started match: $TOTAL  (actual: $STARTED)

CSV: loadtest_results.csv
============================================================
EOF
