#!/usr/bin/env bash
# Health check. Exit 0 healthy, 1 down, 3 degraded (stale data while the market is open).
#   ./healthcheck.sh                 check once
#   ./healthcheck.sh --restart       restart QuantForge when it is down (watchdog; use from cron/Termux:Boot)
. "$(dirname "$0")/scripts/termux/common.sh"
qf health
code=$?
if [ "$code" = 1 ] && [ "${1:-}" = "--restart" ]; then
  warn "QuantForge is down; restarting"
  "$APP_DIR/start.sh"
  exit $?
fi
exit "$code"
