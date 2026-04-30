#!/bin/bash
# Firewolf — double-click this file to start the local multiplayer server.
# It opens automatically in Terminal on macOS.

cd "$(dirname "$0")"

echo ""
echo "  🎮  Firewolf Local Server"
echo "  ─────────────────────────────────────────"

# Install dependencies if needed
if [ ! -d "node_modules/ws" ]; then
  echo "  Installing dependencies (one-time)..."
  npm install --silent
fi

# Detect local IP
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "unknown")

echo ""
echo "  YOUR URL:  http://localhost:8080"
if [ "$IP" != "unknown" ]; then
  echo "  KIDS URL:  http://$IP:8080  ← type this on their device"
fi
echo ""
echo "  Keep this window open while playing."
echo "  Press Ctrl+C to stop the server."
echo "  ─────────────────────────────────────────"
echo ""

node server.js
