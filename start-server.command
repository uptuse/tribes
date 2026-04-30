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

# Kill any previous instance on port 3000
OLD=$(lsof -ti:3000 2>/dev/null)
if [ -n "$OLD" ]; then
  echo "  Stopping previous server (PID $OLD)..."
  kill "$OLD" 2>/dev/null
  sleep 0.5
fi

# Detect local IP
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "unknown")

echo ""
echo "  YOUR URL:  http://localhost:3000"
if [ "$IP" != "unknown" ]; then
  echo "  KIDS URL:  http://$IP:3000  ← type this on their device"
fi
echo ""
echo "  Keep this window open while playing."
echo "  Press Ctrl+C to stop the server."
echo "  ─────────────────────────────────────────"
echo ""

node server.js
