#!/usr/bin/env bash
# ============================================================
# One-command Cloudflare Workers + Durable Objects deploy
# Usage:  cd server/cloudflare && ./deploy.sh
# Idempotent: running twice produces the same final state.
# ============================================================

set -euo pipefail

cd "$(dirname "$0")"

# 1. Verify wrangler installed
if ! command -v wrangler >/dev/null 2>&1; then
  cat <<EOF
[deploy] ERROR: wrangler CLI not found.
Install:  npm install -g wrangler
Then re-run: ./deploy.sh
EOF
  exit 1
fi

WRANGLER_VERSION="$(wrangler --version 2>&1 | head -n1 || true)"
echo "[deploy] wrangler: $WRANGLER_VERSION"

# 2. Verify auth (wrangler whoami)
if ! wrangler whoami >/dev/null 2>&1; then
  cat <<EOF
[deploy] You are not logged in to Cloudflare.
Running 'wrangler login' will open a browser.
EOF
  read -rp "Continue? [Y/n] " ans
  if [[ "${ans:-Y}" =~ ^[Yy]$ ]]; then
    wrangler login
  else
    echo "[deploy] aborted"; exit 1
  fi
fi

WHOAMI="$(wrangler whoami 2>&1 | grep -E 'You are logged in|email' | head -n1 || true)"
echo "[deploy] Authenticated as: ${WHOAMI:-<unknown>}"

# 3. Sanity-check the bundle compiles by doing a dry-run first
echo "[deploy] Validating bundle (wrangler deploy --dry-run)…"
if ! wrangler deploy --dry-run 2>&1 | tee /tmp/wrangler_dry.log; then
  echo "[deploy] ERROR: dry-run failed. See /tmp/wrangler_dry.log"
  exit 1
fi

# 4. Real deploy
echo "[deploy] Deploying to Cloudflare Workers…"
if wrangler deploy 2>&1 | tee /tmp/wrangler_deploy.log; then
  URL="$(grep -E 'https?://[a-z0-9-]+\.workers\.dev' /tmp/wrangler_deploy.log | head -n1 | grep -oE 'https?://[a-z0-9.-]+')"
  cat <<EOF

============================================================
[deploy] SUCCESS
============================================================
Worker URL:   ${URL:-(see log)}
Health check: ${URL:-WORKER_URL}/health
Lobby browser: ${URL:-WORKER_URL}/lobbies
WebSocket:    wss://${URL#https://}/ws

Next steps:
  1. Set window.__TRIBES_SERVER_URL in index.html (or via build flag)
     to '${URL:-WORKER_URL}/ws' so clients connect to your deployed Worker.
  2. Run 'curl ${URL:-WORKER_URL}/health' to verify the Worker is responding.
  3. Open https://uptuse.github.io/tribes/?multiplayer=remote in a browser.

To rollback: wrangler rollback (lists prior deployments)
============================================================
EOF
else
  cat <<EOF
[deploy] ERROR: deploy failed. See /tmp/wrangler_deploy.log
Common causes:
  - Account out of free-tier DO quota (upgrade to Workers Paid \$5/mo)
  - Compatibility flag mismatch (check wrangler.toml compatibility_date)
  - Network issue talking to Cloudflare API
Rollback (if a prior deploy exists): wrangler rollback
EOF
  exit 1
fi
