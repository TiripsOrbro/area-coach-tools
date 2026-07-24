#!/usr/bin/env bash
# Install / refresh PM2 "automatic-orders" on Raspberry Pi.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Stopping old PM2 names (if any)…"
pm2 delete mmx-gate-watch automatic-orders 2>/dev/null || true

echo "Starting automatic-orders…"
pm2 start ecosystem.config.cjs
pm2 save

echo ""
echo "To survive Pi reboot, run the command PM2 prints below (once):"
echo "  pm2 startup"
echo ""
pm2 startup || true

echo ""
echo "Logs: pm2 logs automatic-orders --lines 50"
