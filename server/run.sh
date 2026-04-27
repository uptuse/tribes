#!/usr/bin/env bash
# ============================================================
# server/run.sh — R27 process supervisor for the Bun lobby server
# ============================================================
#
# Restarts the server on crash with exponential backoff (5s..60s).
# Crashes are appended to server/crashlog.txt with timestamp + the
# last 100 stderr lines + a tail of the structured event log.
#
# Cloudflare Workers Durable Objects auto-recover on uncaught
# exceptions; this script is for the local Bun development path.
# ============================================================

set -u

cd "$(dirname "$0")/.." || exit 1

BACKOFFS=(5 10 20 40 60 60 60 60)
ATTEMPT=0
LOG=server/crashlog.txt

echo "[run.sh] $(date -u +%FT%TZ) supervisor starting" | tee -a "$LOG"

while true; do
  echo "[run.sh] $(date -u +%FT%TZ) starting bun lobby (attempt=$ATTEMPT)" | tee -a "$LOG"
  # Capture stderr to a temp file so we can attach it on crash
  STDERR=$(mktemp)
  if bun run server/lobby.ts 2> >(tee "$STDERR" >&2); then
    rc=0
  else
    rc=$?
  fi

  if [ "$rc" -eq 0 ]; then
    echo "[run.sh] $(date -u +%FT%TZ) clean exit, supervisor stopping" | tee -a "$LOG"
    rm -f "$STDERR"
    break
  fi

  echo "[run.sh] $(date -u +%FT%TZ) CRASH rc=$rc — appending to crashlog" | tee -a "$LOG"
  {
    echo "------------------------------------------------------------"
    echo "CRASH at $(date -u +%FT%TZ) — exit code $rc"
    echo "Last 100 stderr lines:"
    tail -n 100 "$STDERR" 2>/dev/null
    echo "Tail of structured event log:"
    curl -s http://localhost:8080/events?limit=20 2>/dev/null | head -200
    echo
  } >> "$LOG"
  rm -f "$STDERR"

  IDX=$(( ATTEMPT < ${#BACKOFFS[@]} ? ATTEMPT : ${#BACKOFFS[@]} - 1 ))
  WAIT=${BACKOFFS[$IDX]}
  echo "[run.sh] backing off ${WAIT}s before restart" | tee -a "$LOG"
  sleep "$WAIT"
  ATTEMPT=$((ATTEMPT + 1))
done
