#!/usr/bin/env bash
# Write a consistent database backup (encrypted when QF_BACKUP_PASSPHRASE is set). Safe while running.
. "$(dirname "$0")/scripts/termux/common.sh"
qf backup
