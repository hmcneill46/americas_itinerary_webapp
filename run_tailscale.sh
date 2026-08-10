#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ -d .venv ]; then . .venv/bin/activate; fi
if [ -z "${ITINERARY_HOST:-}" ]; then
  TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
  if [ -z "$TAILSCALE_IP" ]; then
    echo "No Tailscale IPv4 address found; refusing to bind to a broader interface." >&2
    exit 1
  fi
  export ITINERARY_HOST="$TAILSCALE_IP"
fi
export ITINERARY_PORT="${ITINERARY_PORT:-8765}"
echo "Starting on http://${ITINERARY_HOST}:${ITINERARY_PORT}"
python app.py
