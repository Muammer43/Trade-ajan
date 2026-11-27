#!/usr/bin/env bash
# Update QuantForge: backup, fetch the new version (git pull or a release ZIP), reinstall dependencies,
# rebuild if needed and restart if it was running. Database migrations run automatically at start.
#   ./update.sh                  git pull --ff-only (in a git checkout)
#   ./update.sh <release.zip>    unpack a new QUANTFORGE_AI_TERMUX.zip over this directory
. "$(dirname "$0")/scripts/termux/common.sh"
was_running=0
if running_pid >/dev/null; then was_running=1; fi
[ "$was_running" = 1 ] && "$APP_DIR/stop.sh"
if [ -f "$QF_HOME/quantforge.db" ]; then
  # The application is stopped, so a plain copy is consistent. The CLI backup is tried first; if it cannot
  # run (for example a config.json written for the newer version), the files are copied directly.
  if ! { [ -f "$CLI" ] && qf backup; }; then
    mkdir -p "$QF_HOME/backups"
    stamp="$(date +%Y%m%d-%H%M%S)"
    for f in quantforge.db quantforge.db-wal quantforge.db-shm; do
      [ -f "$QF_HOME/$f" ] && cp "$QF_HOME/$f" "$QF_HOME/backups/pre-update-$stamp-$f"
    done
    chmod 600 "$QF_HOME"/backups/pre-update-"$stamp"-* 2>/dev/null || true
    say "Database copied to $QF_HOME/backups/pre-update-$stamp-quantforge.db"
  fi
fi
cd "$APP_DIR" || exit 1
if [ $# -ge 1 ]; then
  command -v unzip >/dev/null 2>&1 || die "unzip not found (Termux: pkg install unzip)"
  tmp="$(mktemp -d)"
  unzip -q "$1" -d "$tmp" || die "could not unpack $1"
  src="$tmp"
  for d in QUANTFORGE_AI QUANTFORGE_AI_PRO; do [ -d "$tmp/$d" ] && src="$tmp/$d"; done
  cp -R "$src"/. "$APP_DIR"/ || die "copy failed"
  rm -rf "$tmp"
  # Release archives ship a prebuilt dist/: runtime dependencies only.
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund || die "npm ci failed"
elif [ -d .git ]; then
  git pull --ff-only || die "git pull failed"
  # A git checkout has no dist/: build with the portable (pure JavaScript) TypeScript compiler.
  npm ci --ignore-scripts --no-audit --no-fund || die "npm ci failed"
  npm run build:portable || die "build failed"
else
  die "not a git checkout; pass a release ZIP: ./update.sh QUANTFORGE_AI_TERMUX.zip"
fi
say "Updated."
[ "$was_running" = 1 ] && "$APP_DIR/start.sh"
exit 0
