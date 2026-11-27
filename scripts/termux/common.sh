#!/usr/bin/env bash
# Shared helpers for the QuantForge AI shell scripts (Android Termux and plain Linux).
# POSIX-friendly bash: no systemd, no root, no Docker.

set -u

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
QF_HOME="${QF_HOME:-$HOME/.quantforge}"
export QF_HOME
CLI="$APP_DIR/dist/quantforge/cli/main.js"
PID_FILE="$QF_HOME/quantforge.pid"
LOG_DIR="$QF_HOME/logs"
DAEMON_OUT="$LOG_DIR/daemon.out"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=13

say() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

is_termux() {
  [ -n "${TERMUX_VERSION:-}" ] || case "${PREFIX:-}" in *com.termux*) return 0 ;; *) return 1 ;; esac
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>${MIN_NODE_MAJOR}||(a===${MIN_NODE_MAJOR}&&b>=${MIN_NODE_MINOR})?0:1)"
}

sqlite_ok() {
  node -e "require('node:sqlite')" >/dev/null 2>&1
}

qf() {
  [ -f "$CLI" ] || die "QuantForge is not built ($CLI missing). Run ./install.sh first."
  node --disable-warning=ExperimentalWarning "$CLI" "$@"
}

running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(tr -cd '0-9' < "$PID_FILE")"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  # A killed process that nobody has reaped yet (zombie) is not running.
  if [ -r "/proc/$pid/stat" ]; then
    state="$(sed -E 's/^[0-9]+ \(.*\) ([A-Za-z]).*/\1/' "/proc/$pid/stat" 2>/dev/null)"
    [ "$state" = "Z" ] && return 1
  fi
  printf '%s' "$pid"
  return 0
}

wake_lock() {
  if is_termux && command -v termux-wake-lock >/dev/null 2>&1; then termux-wake-lock || true; fi
}

wake_unlock() {
  if is_termux && command -v termux-wake-unlock >/dev/null 2>&1; then termux-wake-unlock || true; fi
}
