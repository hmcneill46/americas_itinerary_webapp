#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ -d .venv ]; then . .venv/bin/activate; fi
TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
export ITINERARY_HOST="${ITINERARY_HOST:-${TAILSCALE_IP:-0.0.0.0}}"
export ITINERARY_PORT="${ITINERARY_PORT:-8765}"
echo "Starting on http://${ITINERARY_HOST}:${ITINERARY_PORT}"
python app.py
