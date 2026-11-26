#!/usr/bin/env bash
# QuantForge AI Pro installer for Android Termux (also works on Linux/macOS with Node.js 22.13+).
#   ./install.sh            install dependencies and run the setup wizard
#   ./install.sh --yes      non-interactive (reads TWELVEDATA_API_KEY from the environment)
#   ./install.sh --check    only check prerequisites
#   ./install.sh --no-pkg   never call the Termux package manager
. "$(dirname "$0")/scripts/termux/common.sh"

YES=0; CHECK=0; NO_PKG=0
for a in "$@"; do
  case "$a" in
    --yes|-y) YES=1 ;;
    --check) CHECK=1 ;;
    --no-pkg) NO_PKG=1 ;;
    *) die "unknown option $a" ;;
  esac
done

say "QuantForge AI Pro installer"
say "  app:  $APP_DIR"
say "  home: $QF_HOME"
if is_termux; then say "  platform: Android Termux ${TERMUX_VERSION:-}"; else say "  platform: $(uname -s) $(uname -m) (not Termux)"; fi

if ! node_ok; then
  if [ "$CHECK" = 1 ]; then die "Node.js >= $MIN_NODE_MAJOR.$MIN_NODE_MINOR not found"; fi
  if is_termux && [ "$NO_PKG" = 0 ]; then
    say "Installing Node.js LTS with pkg (Termux)…"
    pkg update -y || warn "pkg update failed; continuing"
    pkg install -y nodejs-lts || pkg install -y nodejs || die "could not install Node.js with pkg"
  else
    die "Node.js >= $MIN_NODE_MAJOR.$MIN_NODE_MINOR is required (found: $(node --version 2>/dev/null || echo none)). On Termux: pkg install nodejs-lts"
  fi
fi
node_ok || die "Node.js is still older than $MIN_NODE_MAJOR.$MIN_NODE_MINOR: $(node --version)"
say "OK  node $(node --version) ($(node -p 'process.platform + "/" + process.arch'))"
sqlite_ok || die "this Node.js build has no node:sqlite module (Node.js 22.13+ includes it). Try: pkg install nodejs-lts (or nodejs)"
say "OK  node:sqlite"
command -v npm >/dev/null 2>&1 || die "npm not found (it ships with Node.js; on Termux reinstall nodejs-lts)"
say "OK  npm $(npm --version)"
[ "$CHECK" = 1 ] && { say "Prerequisites satisfied."; exit 0; }

cd "$APP_DIR" || exit 1
if [ -f "$APP_DIR/dist/quantforge/cli/main.js" ]; then
  say "Installing runtime dependencies (pure JavaScript; no native compilation)…"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund || die "npm ci failed"
else
  say "No prebuilt dist/: installing all dependencies and building with the portable TypeScript compiler…"
  npm ci --ignore-scripts --no-audit --no-fund || die "npm ci failed"
  npm run build:portable || die "build failed"
fi

mkdir -p "$QF_HOME" "$LOG_DIR" "$QF_HOME/import" "$QF_HOME/backups"
chmod 700 "$QF_HOME" 2>/dev/null || true
chmod +x "$APP_DIR"/*.sh "$APP_DIR"/scripts/termux/*.sh "$APP_DIR"/scripts/termux/boot/*.sh "$APP_DIR"/scripts/termux/service/run 2>/dev/null || true

if [ "$YES" = 1 ]; then qf setup --yes; else qf setup; fi
qf doctor || warn "doctor reported a problem (see above)"

cat <<MSG

Installation finished.
  Start:   ./start.sh          Stop: ./stop.sh        Status: ./status.sh
  Dashboard: http://127.0.0.1:8787/ in Chrome on this phone (token in $QF_HOME/dashboard-token)

Android keeps background apps alive only if allowed:
  * Settings → Apps → Termux → Battery → Unrestricted (disable battery optimization)
  * start.sh takes a Termux wake lock (termux-wake-lock) while QuantForge runs
  * optional autostart after reboot: install Termux:Boot and run
      mkdir -p ~/.termux/boot && cp scripts/termux/boot/start-quantforge.sh ~/.termux/boot/
MSG
