#!/data/data/com.termux/files/usr/bin/sh
# Termux:Boot autostart. Copy to ~/.termux/boot/ (requires the Termux:Boot app, opened once).
# Edit APP to the directory QuantForge is installed in.
APP="$HOME/QUANTFORGE_AI_PRO"
termux-wake-lock
cd "$APP" && ./start.sh >> "$HOME/.quantforge/logs/boot.log" 2>&1
