═══════════════════════════════════════════════════════════
  Team Time Tracker - Installation Instructions
  Opendoor Photo Review QC Team
═══════════════════════════════════════════════════════════

HOW TO INSTALL:

1. Unzip the TeamTimeTracker-Installer.zip file

2. RIGHT-CLICK on "install.command" → Click "Open"
   (Do NOT double-click — macOS will block it the first time)

3. If you see a warning popup, click "Open" again

4. The installer will run in Terminal — wait for all green checkmarks

5. Done! The tracker will now open automatically every time
   you unlock your screen or open your laptop.


IMPORTANT - ONE TIME SETUP:

If Chrome does NOT stay on top after unlocking, you need to
grant Accessibility access:

  System Settings → Privacy & Security → Accessibility
  → Find and enable "team-tracker-monitor"


HOW IT WORKS:

• Every time you unlock your screen → Chrome opens in full-screen
• You MUST click "Start Production" before using other apps
• Chrome stays on top until you click Start Production
• After 15 minutes of no mouse/keyboard activity → auto-break starts
• Break time tracked (1 hour limit with exceeded warning)
• All activity logged to Google Sheets


TO UNINSTALL:

Open Terminal and paste:
launchctl unload ~/Library/LaunchAgents/com.opendoor.teamtracker.plist

Then delete TeamTimeTracker.html from your Desktop.

═══════════════════════════════════════════════════════════
