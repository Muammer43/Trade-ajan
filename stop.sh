#!/usr/bin/env bash
# Stop QuantForge gracefully (SIGTERM, then SIGKILL after 25 s).
. "$(dirname "$0")/scripts/termux/common.sh"
if ! pid="$(running_pid)"; then
  say "QuantForge is not running."
  rm -f "$PID_FILE"
  wake_unlock
  exit 0
fi
kill -TERM "$pid" 2>/dev/null || true
for _ in $(seq 1 25); do
  sleep 1
  kill -0 "$pid" 2>/dev/null || { say "QuantForge stopped."; wake_unlock; exit 0; }
done
warn "graceful shutdown timed out; sending SIGKILL (state is crash-safe and recovers at next start)"
kill -KILL "$pid" 2>/dev/null || true
rm -f "$PID_FILE"
wake_unlock
