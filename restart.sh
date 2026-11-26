#!/usr/bin/env bash
. "$(dirname "$0")/scripts/termux/common.sh"
"$APP_DIR/stop.sh" && "$APP_DIR/start.sh"
