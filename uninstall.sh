#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
#  Team Time Tracker — Uninstaller
#
#  Usage:
#    curl -fsSL https://team-tracker.onrender.com/uninstall.sh | bash
# ═══════════════════════════════════════════════════════════════════════

set -e

PLIST="$HOME/Library/LaunchAgents/com.opendoor.teamtracker.plist"
APP_DIR="$HOME/Applications/TeamTimeTracker.app"
INSTALL_DIR="$HOME/Library/TeamTracker"

echo "═══════════════════════════════════════════════════════════"
echo "  Team Time Tracker — Uninstaller"
echo "═══════════════════════════════════════════════════════════"

echo "[1/4] Stopping app..."
launchctl unload "$PLIST" 2>/dev/null || true
pkill -f TeamTimeTracker 2>/dev/null || true
echo "      ✅ Stopped"

echo "[2/4] Removing LaunchAgent..."
rm -f "$PLIST"
echo "      ✅ Removed"

echo "[3/4] Removing app bundle..."
rm -rf "$APP_DIR"
echo "      ✅ Removed"

echo "[4/4] Removing local files..."
rm -rf "$INSTALL_DIR"
echo "      ✅ Removed"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✅ Uninstalled cleanly."
echo "  To reinstall: curl -fsSL https://team-tracker.onrender.com/install.sh | bash"
echo "═══════════════════════════════════════════════════════════"
