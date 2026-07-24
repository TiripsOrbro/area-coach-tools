#!/usr/bin/env bash
# Bootstrap Macromatix session on a headless Pi (no monitor / SSH only).
# Loads .env.production via Node (config.js) — do NOT "source" .env.production in bash
# if values contain spaces unless they are quoted.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Pi login bootstrap (saves session to data/browser-profile)"
echo "Tip: quote values with spaces in .env.production, e.g. MMX_STORE_NAME=\"3811 Chirnside Park\""
echo ""

if command -v xvfb-run >/dev/null 2>&1; then
    echo "Using xvfb-run (virtual display)…"
    SCRAPER_HEADLESS=false xvfb-run -a npm run login
else
    echo "xvfb-run not found — trying headless login (install: sudo apt install xvfb)"
    SCRAPER_HEADLESS=true npm run login
fi
