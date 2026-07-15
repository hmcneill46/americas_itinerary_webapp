#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ -d .venv ]; then . .venv/bin/activate; fi
export ITINERARY_HOST="${ITINERARY_HOST:-127.0.0.1}"
export ITINERARY_PORT="${ITINERARY_PORT:-8765}"
python app.py
