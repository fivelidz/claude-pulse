#!/usr/bin/env bash
# Claude Pulse — one-command launcher.
# Starts the collector (proxy + web dashboard + live opencode/qalcode2 import),
# then opens the dashboard in your browser. Leave this terminal open.
#
#   ./run.sh
#
# Then open http://localhost:47822 (it auto-opens if a browser is available).
set -e
cd "$(dirname "$0")/collector"
echo "⚡ Starting Claude Pulse collector + dashboard..."
( sleep 3; xdg-open "http://localhost:47822" >/dev/null 2>&1 || true ) &
exec bun run proxy.ts --web
