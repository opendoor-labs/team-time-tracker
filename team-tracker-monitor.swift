#!/usr/bin/env swift
import Foundation
import Cocoa

// ═══════════════════════════════════════════════════════
//  Team Time Tracker — Native Screen Blocker + Monitor
//  Shows a full-screen overlay ABOVE all apps on unlock.
//  User MUST click "Start Production" to dismiss it.
// ═══════════════════════════════════════════════════════

let home = NSHomeDirectory()
let trackerFile = home + "/Desktop/TeamTimeTracker.html"
let trackerURL = "file://" + trackerFile

class AppDelegate: NSObject, NSApplicationDelegate {
    var overlayWindows: [NSWindow] = []
    var isOverlayShowing = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Hide dock icon (runs as background agent)
        NSApp.setActivationPolicy(.accessory)

        // Show overlay on launch
        showOverlay()

        // Listen for screen UNLOCK
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(screenUnlocked),
            name: NSNotification.Name("com.apple.screenIsUnlocked"),
            object: nil
        )

        // Listen for wake from sleep
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(screenUnlocked),
            name: NSWorkspace.screensDidWakeNotification,
            object: nil
        )

        // Listen for session active
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(screenUnlocked),
            name: NSWorkspace.sessionDidBecomeActiveNotification,
            object: nil
        )
    }

    @objc func screenUnlocked() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            self.showOverlay()
        }
    }

    func showOverlay() {
        guard !isOverlayShowing else {
            // Bring existing overlay to front
            overlayWindows.forEach { $0.orderFrontRegardless() }
            return
        }
        isOverlayShowing = true

        // Create overlay on each screen (supports multiple monitors)
        for screen in NSScreen.screens {
            let window = createOverlayWindow(for: screen)
            overlayWindows.append(window)
            window.makeKeyAndOrderFront(nil)
            window.orderFrontRegardless()
        }

        NSApp.activate(ignoringOtherApps: true)

        // Keep overlay on top with periodic enforcement
        enforceFrontLoop()
    }

    func enforceFrontLoop() {
        guard isOverlayShowing else { return }
        overlayWindows.forEach { $0.orderFrontRegardless() }
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.enforceFrontLoop()
        }
    }

    func createOverlayWindow(for screen: NSScreen) -> NSWindow {
        let window = NSWindow(
            contentRect: screen.frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false,
            screen: screen
        )

        // Make it stay above EVERYTHING
        window.level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()) + 1)
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.isOpaque = false
        window.backgroundColor = .clear
        window.isMovable = false
        window.isMovableByWindowBackground = false
        window.canBecomeVisibleWithoutLogin = false
        window.ignoresMouseEvents = false

        // Build the UI
        let contentView = NSView(frame: screen.frame)
        contentView.wantsLayer = true

        // Dark overlay background
        let bgLayer = CALayer()
        bgLayer.frame = contentView.bounds
        bgLayer.backgroundColor = NSColor(red: 0.06, green: 0.09, blue: 0.16, alpha: 0.95).cgColor
        contentView.layer = bgLayer

        // Center container
        let centerX = contentView.bounds.midX
        let centerY = contentView.bounds.midY

        // Rocket icon
        let iconLabel = NSTextField(frame: NSRect(x: centerX - 40, y: centerY + 80, width: 80, height: 80))
        iconLabel.stringValue = "🚀"
        iconLabel.font = NSFont.systemFont(ofSize: 64)
        iconLabel.alignment = .center
        iconLabel.isBezeled = false
        iconLabel.isEditable = false
        iconLabel.drawsBackground = false
        iconLabel.textColor = .white
        contentView.addSubview(iconLabel)

        // Title
        let titleLabel = NSTextField(frame: NSRect(x: centerX - 200, y: centerY + 30, width: 400, height: 45))
        titleLabel.stringValue = "Start Your Shift"
        titleLabel.font = NSFont.boldSystemFont(ofSize: 36)
        titleLabel.alignment = .center
        titleLabel.isBezeled = false
        titleLabel.isEditable = false
        titleLabel.drawsBackground = false
        titleLabel.textColor = .white
        contentView.addSubview(titleLabel)

        // Subtitle
        let subtitleLabel = NSTextField(frame: NSRect(x: centerX - 220, y: centerY - 10, width: 440, height: 35))
        subtitleLabel.stringValue = "You must click Start Production to begin working."
        subtitleLabel.font = NSFont.systemFont(ofSize: 17)
        subtitleLabel.alignment = .center
        subtitleLabel.isBezeled = false
        subtitleLabel.isEditable = false
        subtitleLabel.drawsBackground = false
        subtitleLabel.textColor = NSColor(white: 0.65, alpha: 1.0)
        contentView.addSubview(subtitleLabel)

        // Sub-subtitle
        let subSubLabel = NSTextField(frame: NSRect(x: centerX - 220, y: centerY - 40, width: 440, height: 25))
        subSubLabel.stringValue = "No tools or activities are available until you start Production."
        subSubLabel.font = NSFont.systemFont(ofSize: 13)
        subSubLabel.alignment = .center
        subSubLabel.isBezeled = false
        subSubLabel.isEditable = false
        subSubLabel.drawsBackground = false
        subSubLabel.textColor = NSColor(white: 0.45, alpha: 1.0)
        contentView.addSubview(subSubLabel)

        // Start Production button
        let button = NSButton(frame: NSRect(x: centerX - 120, y: centerY - 100, width: 240, height: 50))
        button.title = "⚙ Start Production"
        button.bezelStyle = .rounded
        button.font = NSFont.boldSystemFont(ofSize: 18)
        button.contentTintColor = .white
        button.wantsLayer = true
        button.layer?.backgroundColor = NSColor(red: 0.13, green: 0.77, blue: 0.37, alpha: 1.0).cgColor
        button.layer?.cornerRadius = 12
        button.isBordered = false
        button.target = self
        button.action = #selector(startProductionClicked)
        contentView.addSubview(button)

        // Shift time info
        let shiftLabel = NSTextField(frame: NSRect(x: centerX - 150, y: centerY - 150, width: 300, height: 20))
        shiftLabel.stringValue = "Shift: 8:00 PM – 5:00 AM IST"
        shiftLabel.font = NSFont.systemFont(ofSize: 12)
        shiftLabel.alignment = .center
        shiftLabel.isBezeled = false
        shiftLabel.isEditable = false
        shiftLabel.drawsBackground = false
        shiftLabel.textColor = NSColor(white: 0.4, alpha: 1.0)
        contentView.addSubview(shiftLabel)

        window.contentView = contentView
        return window
    }

    @objc func startProductionClicked() {
        // Dismiss all overlay windows
        isOverlayShowing = false
        for window in overlayWindows {
            window.orderOut(nil)
        }
        overlayWindows.removeAll()

        // Open TeamTimeTracker in Chrome
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            self.openTracker()
        }
    }

    func openTracker() {
        // Check if already open
        if isTrackerAlreadyOpen() {
            bringChromeToFront()
            return
        }

        // Open in Chrome
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        task.arguments = ["-a", "Google Chrome", trackerFile]
        try? task.run()

        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
            self.bringChromeToFront()
        }
    }

    func isTrackerAlreadyOpen() -> Bool {
        let script = """
        tell application "Google Chrome"
            if it is running then
                repeat with w in windows
                    repeat with t in tabs of w
                        if URL of t contains "TeamTimeTracker" then
                            set active tab index of w to (index of t)
                            set index of w to 1
                            activate
                            return "found"
                        end if
                    end repeat
                end repeat
            end if
        end tell
        return "not_found"
        """
        let appleScript = NSAppleScript(source: script)
        var error: NSDictionary?
        let result = appleScript?.executeAndReturnError(&error)
        return result?.stringValue == "found"
    }

    func bringChromeToFront() {
        let script = """
        tell application "Google Chrome"
            activate
        end tell
        """
        let appleScript = NSAppleScript(source: script)
        appleScript?.executeAndReturnError(nil)
    }
}

// ── Launch the app ──
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
