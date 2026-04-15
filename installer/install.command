#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  Team Time Tracker - Native Mac App Installer
#  Opendoor Photo Review QC Team
# ═══════════════════════════════════════════════════════════

xattr -c "$0" 2>/dev/null
clear
echo "═══════════════════════════════════════════════════════════"
echo "  Team Time Tracker - Native App Installer"
echo "  Opendoor Photo Review QC Team"
echo "═══════════════════════════════════════════════════════════"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$HOME"
APP_DIR="$HOME_DIR/Applications/TeamTimeTracker.app"
INSTALL_DIR="$HOME_DIR/Library/TeamTracker"
LAUNCH_AGENTS="$HOME_DIR/Library/LaunchAgents"
PLIST_NAME="com.opendoor.teamtracker"

# Step 1: Compile the native app
echo "[1/4] Building native Team Time Tracker app..."
mkdir -p "$INSTALL_DIR"

if [ ! -f "$SCRIPT_DIR/TeamTimeTracker.swift" ]; then
    echo "      ❌ ERROR: TeamTimeTracker.swift not found!"
    echo "Press any key to exit..."
    read -n 1
    exit 1
fi

swiftc -O -o "$INSTALL_DIR/TeamTimeTracker" "$SCRIPT_DIR/TeamTimeTracker.swift" -framework Cocoa -framework CoreGraphics -framework IOKit 2>/dev/null
if [ $? -ne 0 ]; then
    echo "      ❌ ERROR: Failed to compile."
    echo "      Make sure Xcode Command Line Tools are installed:"
    echo "      xcode-select --install"
    echo ""
    echo "Press any key to exit..."
    read -n 1
    exit 1
fi
chmod +x "$INSTALL_DIR/TeamTimeTracker"
echo "      ✅ Compiled"

# Step 2: Create .app bundle
echo "[2/4] Creating app bundle..."
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp "$INSTALL_DIR/TeamTimeTracker" "$APP_DIR/Contents/MacOS/TeamTimeTracker"
chmod +x "$APP_DIR/Contents/MacOS/TeamTimeTracker"
xattr -c "$APP_DIR/Contents/MacOS/TeamTimeTracker" 2>/dev/null

cat > "$APP_DIR/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>TeamTimeTracker</string>
    <key>CFBundleDisplayName</key>
    <string>Team Time Tracker</string>
    <key>CFBundleIdentifier</key>
    <string>com.opendoor.teamtimetracker</string>
    <key>CFBundleVersion</key>
    <string>2.0</string>
    <key>CFBundleExecutable</key>
    <string>TeamTimeTracker</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSAppSleepDisabled</key>
    <true/>
</dict>
</plist>
PLIST
echo "      ✅ App bundle created at ~/Applications/TeamTimeTracker.app"

# Step 3: Stop old version + setup LaunchAgent
echo "[3/4] Setting up auto-start..."
launchctl unload "$LAUNCH_AGENTS/$PLIST_NAME.plist" 2>/dev/null
mkdir -p "$LAUNCH_AGENTS"

cat > "$LAUNCH_AGENTS/$PLIST_NAME.plist" << AGENT
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_NAME</string>
    <key>ProgramArguments</key>
    <array>
        <string>$APP_DIR/Contents/MacOS/TeamTimeTracker</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/teamtracker.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/teamtracker-error.log</string>
</dict>
</plist>
AGENT
echo "      ✅ LaunchAgent configured"

# Step 4: Start the app
echo "[4/4] Starting Team Time Tracker..."
launchctl load "$LAUNCH_AGENTS/$PLIST_NAME.plist" 2>&1
sleep 2
if launchctl list | grep -q "$PLIST_NAME"; then
    echo "      ✅ Running!"
else
    echo "      ⚠️  May need a restart to take effect."
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✅ INSTALLATION COMPLETE!"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  This is a NATIVE Mac app — no Chrome needed!"
echo ""
echo "  What happens now:"
echo "  • Every screen unlock → full-screen 'Start Production' blocker"
echo "  • Click 'Start Production' → tracking dashboard opens"
echo "  • 15 min idle → auto-break starts"
echo "  • Break time tracked (1 hour limit)"
echo "  • All data synced to Google Sheets"
echo ""
echo "  App installed at: ~/Applications/TeamTimeTracker.app"
echo ""
echo "  To UNINSTALL:"
echo "  launchctl unload ~/Library/LaunchAgents/com.opendoor.teamtracker.plist"
echo "  rm -rf ~/Applications/TeamTimeTracker.app"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Press any key to close..."
read -n 1
