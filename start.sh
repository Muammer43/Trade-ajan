#!/usr/bin/env bash
# Start QuantForge AI Pro in the background (PAPER mode unless every live gate passes).
. "$(dirname "$0")/scripts/termux/common.sh"
if pid="$(running_pid)"; then say "QuantForge is already running (PID $pid)."; exit 0; fi
[ -f "$PID_FILE" ] && { warn "removing stale PID file"; rm -f "$PID_FILE"; }
mkdir -p "$LOG_DIR"
node_ok || die "Node.js >= $MIN_NODE_MAJOR.$MIN_NODE_MINOR required"
wake_lock
cd "$APP_DIR" || exit 1
nohup node --disable-warning=ExperimentalWarning "$CLI" run >> "$DAEMON_OUT" 2>&1 < /dev/null &
for _ in $(seq 1 30); do
  sleep 1
  if pid="$(running_pid)"; then
    say "QuantForge started (PID $pid). Log: $DAEMON_OUT"
    port="$(node -e "try{const c=require(process.env.QF_HOME+'/config.json');console.log(c.dashboard?.port??8787)}catch{console.log(8787)}")"
    say "Dashboard: http://127.0.0.1:${port}/"
    exit 0
  fi
done
warn "QuantForge did not report a PID within 30 s. Last log lines:"
tail -n 20 "$DAEMON_OUT" >&2
exit 1
