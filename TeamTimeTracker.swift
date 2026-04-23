// ═══════════════════════════════════════════════════════════════════════
//  Team Time Tracker v2.7 — WKWebView shell
//  Opendoor · Photo Review QC Team
//
//  Architecture:
//    - Swift wraps the HTML UI (app-premium-demo.html → index.html)
//    - JS calls native via window.webkit.messageHandlers.native.postMessage({...})
//    - Native calls JS via webView.evaluateJavaScript("window.onNative(...)")
//
//  Keep backwards compatibility with v2.6.1 auto-update:
//    Config!B1 = version     (if > APP_VERSION → update)
//    Config!B2 = sourceUrl   (where to download new .swift)
//    Config!B3 = forceReset  (comma-sep Mac full names → clear local state)
// ═══════════════════════════════════════════════════════════════════════

import Cocoa
import WebKit
import IOKit
import CoreGraphics

// ── Constants ──────────────────────────────────────────────────────────
let APP_VERSION = "2.7.1"
let SHEET_URL = "https://script.google.com/macros/s/AKfycbxkBAtowwxWuKkaga-aR93ssyxuygFZC-zYXsdm22aVKhXWB45E4YKMKVmc0Ty_ByFk/exec"
let INSTALL_DIR = NSHomeDirectory() + "/Library/TeamTracker"
let HTML_PATH = INSTALL_DIR + "/index.html"
let STATE_PATH = INSTALL_DIR + "/state.json"

let IDLE_THRESHOLD_SEC: TimeInterval = 300   // 5 min
let LOCK_BREAK_SEC: TimeInterval = 900       // 15 min
let MANUAL_BREAK_WELCOME_SEC: TimeInterval = 300
let UPDATE_CHECK_INTERVAL: TimeInterval = 7200   // 2 hrs
let CONFIG_POLL_INTERVAL: TimeInterval = 300     // 5 min

// ── Update safety constants ────────────────────────────────────────────
let UPDATE_SNOOZE_KEY  = "ttk.updateSnoozeUntil"
let UPDATE_ATTEMPT_KEY = "ttk.updateAttempts"       // [TimeInterval]
let UPDATE_LAST_VER_KEY = "ttk.lastKnownVersion"
let UPDATE_SNOOZE_SEC: TimeInterval = 4 * 3600     // 4 hours
let UPDATE_LOOP_WINDOW: TimeInterval = 300         // 5 min
let UPDATE_LOOP_MAX = 2                            // >2 attempts in window = loop

// ── App Delegate ───────────────────────────────────────────────────────
class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var statusItem: NSStatusItem!
    var idleTimer: Timer?
    var updateTimer: Timer?
    var configTimer: Timer?
    var lockStart: Date?
    var isLocked = false
    var lastIdleSent: TimeInterval = 0

    // ── Launch ─────────────────────────────────────────────────────────
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)     // show in Dock with our custom icon
        setDockIcon()
        ensureInstallDir()
        buildStatusItem()
        buildWindow()
        loadHTML()
        registerSystemHooks()
        startTimers()
        postUpdateHousekeeping()    // detect post-update boot, heartbeat, resume state
        checkForUpdate()
        pollConfig()
    }

    // Detect if this launch came from an update install. If so, emit a
    // post-update heartbeat and tell JS to resume the in-progress session
    // (JS reads session state from the backend, so no local replay needed).
    func postUpdateHousekeeping() {
        let defaults = UserDefaults.standard
        let last = defaults.string(forKey: UPDATE_LAST_VER_KEY) ?? ""
        if !last.isEmpty && last != APP_VERSION {
            // Just updated from `last` → `APP_VERSION`
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                guard let self = self else { return }
                self.postToApi(action: "heartbeat", payload: [
                    "phase": "post_update",
                    "fromVersion": last,
                    "toVersion": APP_VERSION,
                    "user": NSFullUserName()
                ]) { _ in }
                self.sendToJS("onPostUpdate", payload: [
                    "fromVersion": last,
                    "toVersion": APP_VERSION
                ])
            }
        }
        defaults.set(APP_VERSION, forKey: UPDATE_LAST_VER_KEY)
    }

    // ── Dock icon — draw a branded icon at runtime ─────────────────────
    // Avoids shipping a separate .icns file. Renders a rounded-square
    // purple→blue gradient with a sun emoji, so the app shows up with
    // its own identity in the Dock + Cmd-Tab switcher instead of the
    // generic terminal/Swift icon.
    func setDockIcon() {
        let size = NSSize(width: 512, height: 512)
        let img = NSImage(size: size)
        img.lockFocus()
        let rect = NSRect(origin: .zero, size: size)
        let path = NSBezierPath(roundedRect: rect, xRadius: 110, yRadius: 110)
        path.addClip()
        if let g = NSGradient(colors: [
            NSColor(red: 0.36, green: 0.55, blue: 1.0, alpha: 1.0),
            NSColor(red: 0.75, green: 0.35, blue: 0.95, alpha: 1.0)
        ]) {
            g.draw(in: rect, angle: -45)
        }
        let emoji = "☀️" as NSString
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 280)
        ]
        let strSize = emoji.size(withAttributes: attrs)
        let origin = NSPoint(
            x: (size.width  - strSize.width)  / 2,
            y: (size.height - strSize.height) / 2 - 10
        )
        emoji.draw(at: origin, withAttributes: attrs)
        img.unlockFocus()
        NSApp.applicationIconImage = img
    }

    func ensureInstallDir() {
        try? FileManager.default.createDirectory(atPath: INSTALL_DIR, withIntermediateDirectories: true)
    }

    // ── Menu bar ───────────────────────────────────────────────────────
    func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = statusItem.button {
            btn.title = "⏱"
            btn.toolTip = "Team Time Tracker v\(APP_VERSION)"
        }
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Open Tracker", action: #selector(showWindow), keyEquivalent: "o"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Check for Updates", action: #selector(manualUpdateCheck), keyEquivalent: "u"))
        menu.addItem(NSMenuItem(title: "Force Refresh Config", action: #selector(manualConfigRefresh), keyEquivalent: "r"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem.menu = menu
    }

    // ── Window + WebView ───────────────────────────────────────────────
    func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 720, height: 860)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Team Time Tracker"
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.center()

        let cfg = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        ucc.add(self, name: "native")
        cfg.userContentController = ucc
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")   // enable Inspector

        webView = WKWebView(frame: window.contentView!.bounds, configuration: cfg)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")   // transparent (let HTML gradient show)
        window.contentView?.addSubview(webView)
    }

    func loadHTML() {
        let url = URL(fileURLWithPath: HTML_PATH)
        if FileManager.default.fileExists(atPath: HTML_PATH) {
            webView.loadFileURL(url, allowingReadAccessTo: URL(fileURLWithPath: INSTALL_DIR))
        } else {
            let html = "<html><body style='background:#0a0e1b;color:#e8ecff;font-family:-apple-system;padding:40px'><h2>⚠️ index.html not found</h2><p>Expected at: \(HTML_PATH)</p><p>Re-run the installer:</p><code>curl -fsSL https://team-tracker.onrender.com/install.sh | bash</code></body></html>"
            webView.loadHTMLString(html, baseURL: nil)
        }
    }

    @objc func showWindow() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    // ── System hooks (lock/unlock/sleep/wake) ──────────────────────────
    func registerSystemHooks() {
        let nc = NSWorkspace.shared.notificationCenter
        nc.addObserver(self, selector: #selector(screenLocked), name: NSWorkspace.screensDidSleepNotification, object: nil)
        nc.addObserver(self, selector: #selector(screenUnlocked), name: NSWorkspace.screensDidWakeNotification, object: nil)
        // Fallback: CGSession lock/unlock via Darwin notify
        let dnc = DistributedNotificationCenter.default()
        dnc.addObserver(self, selector: #selector(screenLocked), name: NSNotification.Name("com.apple.screenIsLocked"), object: nil)
        dnc.addObserver(self, selector: #selector(screenUnlocked), name: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil)
    }

    @objc func screenLocked() {
        guard !isLocked else { return }
        isLocked = true
        lockStart = Date()
        sendToJS("onLock", payload: [:])
    }

    @objc func screenUnlocked() {
        guard isLocked else { return }
        isLocked = false
        let dur = lockStart.map { Date().timeIntervalSince($0) } ?? 0
        lockStart = nil
        sendToJS("onUnlock", payload: ["duration": dur])
    }

    // ── Idle detection ─────────────────────────────────────────────────
    func startTimers() {
        idleTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.tickIdle()
        }
        updateTimer = Timer.scheduledTimer(withTimeInterval: UPDATE_CHECK_INTERVAL, repeats: true) { [weak self] _ in
            self?.checkForUpdate()
        }
        configTimer = Timer.scheduledTimer(withTimeInterval: CONFIG_POLL_INTERVAL, repeats: true) { [weak self] _ in
            self?.pollConfig()
        }
    }

    func tickIdle() {
        let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
        sendToJS("onIdleTick", payload: ["seconds": idle])
    }

    // ── JS bridge ──────────────────────────────────────────────────────
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let op = body["op"] as? String else { return }
        let payload = body["payload"] as? [String: Any] ?? [:]
        let requestId = body["requestId"] as? String

        switch op {
        case "getUser":
            reply(requestId, data: ["fullName": NSFullUserName(), "version": APP_VERSION])
        case "logTask":
            postToApi(action: "logTask", payload: payload) { result in
                self.reply(requestId, data: result)
            }
        case "markAttendance":
            postToApi(action: "markAttendance", payload: payload) { result in
                self.reply(requestId, data: result)
            }
        case "closeSession":
            postToApi(action: "closeSession", payload: payload) { result in
                self.reply(requestId, data: result)
            }
        case "heartbeat":
            postToApi(action: "heartbeat", payload: payload) { _ in }
        case "shiftStart":
            postToApi(action: "shiftStart", payload: payload) { _ in }
        case "idleAlert":
            postToApi(action: "idleAlert", payload: payload) { _ in }
        case "clearForceReset":
            postToApi(action: "clearForceReset", payload: payload) { _ in }
        case "getConfig":
            fetchConfig { cfg in self.reply(requestId, data: cfg) }
        case "openUrl":
            if let s = payload["url"] as? String, let url = URL(string: s) {
                NSWorkspace.shared.open(url)
            }
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }

    func sendToJS(_ event: String, payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        let js = "if(window.onNative){window.onNative('\(event)', \(json))}"
        DispatchQueue.main.async { self.webView.evaluateJavaScript(js, completionHandler: nil) }
    }

    func reply(_ requestId: String?, data: [String: Any]) {
        guard let rid = requestId,
              let d = try? JSONSerialization.data(withJSONObject: data),
              let json = String(data: d, encoding: .utf8) else { return }
        let js = "if(window.onNativeReply){window.onNativeReply('\(rid)', \(json))}"
        DispatchQueue.main.async { self.webView.evaluateJavaScript(js, completionHandler: nil) }
    }

    // ── Apps Script API ────────────────────────────────────────────────
    func postToApi(action: String, payload: [String: Any], done: @escaping ([String: Any]) -> Void) {
        var body = payload
        body["action"] = action
        body["user"] = NSFullUserName()
        body["version"] = APP_VERSION
        guard let data = try? JSONSerialization.data(withJSONObject: body),
              let url = URL(string: SHEET_URL) else {
            done(["ok": false, "error": "bad_url"]); return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = data
        URLSession.shared.dataTask(with: req) { data, _, err in
            if let err = err { done(["ok": false, "error": err.localizedDescription]); return }
            if let d = data, let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                done(obj)
            } else {
                done(["ok": true])
            }
        }.resume()
    }

    func fetchConfig(done: @escaping ([String: Any]) -> Void) {
        guard let url = URL(string: SHEET_URL + "?action=getConfig") else { done([:]); return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            if let d = data, let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                done(obj)
            } else { done([:]) }
        }.resume()
    }

    // ── Config poll (force-reset + maintenance) ────────────────────────
    func pollConfig() {
        fetchConfig { [weak self] cfg in
            guard let self = self else { return }
            // Force reset
            if let fr = cfg["forceReset"] as? String, !fr.isEmpty {
                let myName = NSFullUserName().lowercased()
                let names = fr.lowercased().split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                if names.contains(myName) {
                    self.sendToJS("onForceReset", payload: [:])
                    self.postToApi(action: "clearForceReset", payload: ["user": NSFullUserName()]) { _ in }
                }
            }
            // Maintenance banner
            self.sendToJS("onConfig", payload: cfg)
        }
    }

    @objc func manualConfigRefresh() { pollConfig() }

    // ── Auto-update (safe flow) ────────────────────────────────────────
    //
    // Flow:
    //   1. checkForUpdate() — polls Config!B1, bails if no newer version
    //   2. Loop guard — if >2 attempts in 5 min, stop (prevents flicker)
    //   3. Snooze guard — if user clicked "Later" recently, skip auto-check
    //      (manual "Check for Updates" always overrides snooze)
    //   4. Confirmation dialog — user chooses Update Now / Later
    //   5. Update Now → snapshot state → download → compile → relaunch
    //
    // Session continuity:
    //   - Backend (Apps Script) owns session truth
    //   - Pre-update heartbeat marks the pause; post-update (on relaunch)
    //     marks the resume. Current task / elapsed time resume seamlessly.
    //
    var isManualUpdateCheck = false

    func checkForUpdate() {
        fetchConfig { [weak self] cfg in
            guard let self = self else { return }
            guard let v = cfg["version"] as? String,
                  let src = cfg["sourceUrl"] as? String else { return }

            if !self.isNewer(v) {
                if self.isManualUpdateCheck {
                    self.isManualUpdateCheck = false
                    DispatchQueue.main.async { self.showUpToDateDialog() }
                }
                return
            }

            // Loop guard: abort if we've attempted too many times recently
            if self.isInUpdateLoop() {
                NSLog("Team Tracker: update loop detected (\(UPDATE_LOOP_MAX)+ attempts in \(Int(UPDATE_LOOP_WINDOW))s). Skipping.")
                if self.isManualUpdateCheck {
                    self.isManualUpdateCheck = false
                    DispatchQueue.main.async { self.showLoopGuardDialog() }
                }
                return
            }

            // Snooze guard: respect user's "Later" choice (skipped for manual)
            if !self.isManualUpdateCheck,
               let snooze = UserDefaults.standard.object(forKey: UPDATE_SNOOZE_KEY) as? Date,
               Date() < snooze {
                return
            }

            DispatchQueue.main.async {
                self.isManualUpdateCheck = false
                self.promptForUpdate(version: v, sourceUrl: src)
            }
        }
    }

    @objc func manualUpdateCheck() {
        isManualUpdateCheck = true
        checkForUpdate()
    }

    func isNewer(_ remote: String) -> Bool {
        let r = remote.split(separator: ".").compactMap { Int($0) }
        let l = APP_VERSION.split(separator: ".").compactMap { Int($0) }
        for i in 0..<max(r.count, l.count) {
            let a = i < r.count ? r[i] : 0
            let b = i < l.count ? l[i] : 0
            if a > b { return true }
            if a < b { return false }
        }
        return false
    }

    // ── Loop guard helpers ─────────────────────────────────────────────
    func recordUpdateAttempt() {
        let now = Date().timeIntervalSince1970
        var attempts = UserDefaults.standard.array(forKey: UPDATE_ATTEMPT_KEY) as? [TimeInterval] ?? []
        let cutoff = now - UPDATE_LOOP_WINDOW
        attempts = attempts.filter { $0 > cutoff }
        attempts.append(now)
        UserDefaults.standard.set(attempts, forKey: UPDATE_ATTEMPT_KEY)
    }

    func isInUpdateLoop() -> Bool {
        let now = Date().timeIntervalSince1970
        let attempts = UserDefaults.standard.array(forKey: UPDATE_ATTEMPT_KEY) as? [TimeInterval] ?? []
        let cutoff = now - UPDATE_LOOP_WINDOW
        return attempts.filter { $0 > cutoff }.count >= UPDATE_LOOP_MAX
    }

    // ── Confirmation dialogs ───────────────────────────────────────────
    func promptForUpdate(version: String, sourceUrl: String) {
        let alert = NSAlert()
        alert.messageText = "Team Tracker Update Available"
        alert.informativeText = """
        Version \(version) is ready to install.
        (You're currently on \(APP_VERSION).)

        ✓ Your current task will resume
        ✓ Your timer keeps running
        ✓ No data will be lost

        App will restart briefly (~10 seconds).
        """
        alert.addButton(withTitle: "Update Now")
        alert.addButton(withTitle: "Later")
        alert.alertStyle = .informational
        alert.icon = NSApp.applicationIconImage

        NSApp.activate(ignoringOtherApps: true)
        let resp = alert.runModal()

        if resp == .alertFirstButtonReturn {
            // User chose Update Now
            snapshotStateBeforeUpdate(targetVersion: version)
            recordUpdateAttempt()
            performUpdate(version: version, sourceUrl: sourceUrl)
        } else {
            // User chose Later — snooze 4 hours
            let snoozeUntil = Date().addingTimeInterval(UPDATE_SNOOZE_SEC)
            UserDefaults.standard.set(snoozeUntil, forKey: UPDATE_SNOOZE_KEY)
            NSLog("Team Tracker: update snoozed until \(snoozeUntil)")
        }
    }

    func showUpToDateDialog() {
        let alert = NSAlert()
        alert.messageText = "You're up to date"
        alert.informativeText = "Team Tracker is running the latest version (\(APP_VERSION))."
        alert.addButton(withTitle: "OK")
        alert.alertStyle = .informational
        alert.icon = NSApp.applicationIconImage
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    func showLoopGuardDialog() {
        let alert = NSAlert()
        alert.messageText = "Update paused"
        alert.informativeText = "Too many update attempts recently. Please try again in a few minutes, or message @arun if the issue persists."
        alert.addButton(withTitle: "OK")
        alert.alertStyle = .warning
        alert.icon = NSApp.applicationIconImage
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    // ── State snapshot before update ───────────────────────────────────
    // Send pre-update heartbeat to Apps Script so backend knows the session
    // was paused for an update (not abandoned). JS layer also gets a chance
    // to persist anything it cares about.
    func snapshotStateBeforeUpdate(targetVersion: String) {
        postToApi(action: "heartbeat", payload: [
            "phase": "pre_update",
            "fromVersion": APP_VERSION,
            "toVersion": targetVersion,
            "user": NSFullUserName()
        ]) { _ in }
        sendToJS("onPreUpdate", payload: [
            "fromVersion": APP_VERSION,
            "toVersion": targetVersion
        ])
        // Small delay so the heartbeat request has a chance to flush
        Thread.sleep(forTimeInterval: 0.5)
    }

    // ── Perform update (download + compile + relaunch) ─────────────────
    func performUpdate(version: String, sourceUrl: String) {
        guard let url = URL(string: sourceUrl) else { return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let d = data, d.count > 10_000 else { return }
            let newSwift = INSTALL_DIR + "/TeamTimeTracker.swift.new"
            try? d.write(to: URL(fileURLWithPath: newSwift))
            // Compile in place, replace, relaunch
            let script = """
            cd \(INSTALL_DIR) && \
            swiftc -O -o TeamTimeTracker.new TeamTimeTracker.swift.new \
              -framework Cocoa -framework CoreGraphics -framework IOKit -framework WebKit && \
            mv TeamTimeTracker.swift.new TeamTimeTracker.swift && \
            mv TeamTimeTracker.new TeamTimeTracker && \
            chmod +x TeamTimeTracker && \
            cp TeamTimeTracker ~/Applications/TeamTimeTracker.app/Contents/MacOS/TeamTimeTracker && \
            open ~/Applications/TeamTimeTracker.app
            """
            let task = Process()
            task.launchPath = "/bin/bash"
            task.arguments = ["-c", script]
            task.terminationHandler = { _ in
                DispatchQueue.main.async { NSApp.terminate(nil) }
            }
            try? task.run()
        }.resume()
    }
}

// ── Main ───────────────────────────────────────────────────────────────
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
