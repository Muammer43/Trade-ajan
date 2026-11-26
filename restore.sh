#!/usr/bin/env bash
# Restore a backup: ./restore.sh <backup file>   (QuantForge must be stopped; the old database is kept)
. "$(dirname "$0")/scripts/termux/common.sh"
[ $# -ge 1 ] || { qf backups; die "usage: ./restore.sh <backup file>"; }
if pid="$(running_pid)"; then die "QuantForge is running (PID $pid); run ./stop.sh first"; fi
qf restore "$1"
