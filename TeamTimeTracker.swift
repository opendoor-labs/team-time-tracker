// ═══════════════════════════════════════════════════════════════════════
//  Team Time Tracker v2.7.5 — WKWebView shell (fully manual, HTML-OTA)
//  Opendoor · Photo Review QC Team
//
//  Design:
//    • Swift binary is a stable shell. All UI/logic lives in index.html.
//    • On launch, Swift loads cached index.html for fast paint, then
//      fetches the latest from Render in the background. Next launch
//      (or a Reload UI click / silent forceReset) picks up the new HTML.
//    • No update popups. No Start Your Day popup. Fully manual:
//      user clicks the menu-bar ⏱ icon → Open Tracker.
//    • Window close (✕) minimizes to menu bar — app keeps running.
//    • Mac unlock / wake always auto-shows the tracker window.
//    • Idle detection: JS receives 5-second ticks and decides break logic.
//    • Config!B3 (forceReset) supports two modes:
//        "name"        → silent UI reload (pull fresh HTML)
//        "RESET:name"  → clear state + fresh Start Your Day in the HTML
// ═══════════════════════════════════════════════════════════════════════

import Cocoa
import WebKit
import IOKit
import CoreGraphics

// ── Constants ──────────────────────────────────────────────────────────
let APP_VERSION = "2.7.5"
let SHEET_URL = "https://script.google.com/macros/s/AKfycbxkBAtowwxWuKkaga-aR93ssyxuygFZC-zYXsdm22aVKhXWB45E4YKMKVmc0Ty_ByFk/exec"
let HTML_URL = "https://team-time-tracker-osoe.onrender.com/index.html"
let MY_DASH_URL = "https://team-time-tracker-osoe.onrender.com/dashboard/my/index.html"
let INSTALL_DIR = NSHomeDirectory() + "/Library/TeamTracker"
let HTML_PATH = INSTALL_DIR + "/index.html"

let HTML_REFRESH_TIMEOUT: TimeInterval = 5.0
let CONFIG_POLL_INTERVAL: TimeInterval = 300   // 5 min
let IDLE_TICK_INTERVAL: TimeInterval = 5

// ── App Delegate ───────────────────────────────────────────────────────
class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler,
                   WKNavigationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var statusItem: NSStatusItem!
    var idleTimer: Timer?
    var configTimer: Timer?
    var lockStart: Date?
    var isLocked = false

    // ── Launch ─────────────────────────────────────────────────────────
    func applicationDidFinishLaunching(_ notification: Notification) {
        // ── Singleton guard ─────────────────────────────────────────────
        // Defense in depth: even if LaunchServices + LaunchAgent race and
        // spawn two processes, only one stays alive. Count every process
        // with our bundle identifier; if we're not the first, exit quietly.
        let myPID = ProcessInfo.processInfo.processIdentifier
        let myID = Bundle.main.bundleIdentifier ?? "com.opendoor.teamtimetracker"
        let twins = NSRunningApplication.runningApplications(withBundleIdentifier: myID)
            .filter { $0.processIdentifier != myPID && $0.processIdentifier > 0 }
        if !twins.isEmpty {
            NSLog("Team Tracker: another instance (PID \(twins.map{$0.processIdentifier})) already running; exiting.")
            exit(0)
        }

        NSApp.setActivationPolicy(.regular)
        setDockIcon()
        ensureInstallDir()
        buildMainMenu()
        buildStatusItem()
        buildWindow()
        loadHTML()                     // paint the cached UI fast
        refreshHTMLFromRender()        // fetch fresh HTML for next open
        registerSystemHooks()
        startTimers()
        pollConfig()
    }

    // ── Main menu — enables Cmd+C/V/X/A inside the WKWebView ──────────
    func buildMainMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "Quit Team Tracker",
                                   action: #selector(NSApplication.terminate(_:)),
                                   keyEquivalent: "q"))
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redo)
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(NSMenuItem(title: "Cut",        action: #selector(NSText.cut(_:)),       keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy",       action: #selector(NSText.copy(_:)),      keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste",      action: #selector(NSText.paste(_:)),     keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        NSApp.mainMenu = mainMenu
    }

    // ── Dock icon ──────────────────────────────────────────────────────
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
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 280)]
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
        menu.addItem(NSMenuItem(title: "Open Tracker",
                                action: #selector(showWindow), keyEquivalent: "o"))
        menu.addItem(NSMenuItem(title: "My Dashboard",
                                action: #selector(openMyDashboard), keyEquivalent: "d"))
        menu.addItem(NSMenuItem(title: "Reload UI (pull latest)",
                                action: #selector(reloadFromRender), keyEquivalent: "r"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit",
                                action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
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
        window.delegate = self      // intercept ✕ → hide (not close)
        window.center()

        let cfg = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        ucc.add(self, name: "native")
        cfg.userContentController = ucc
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: window.contentView!.bounds, configuration: cfg)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        window.contentView?.addSubview(webView)
    }

    // ── NSWindowDelegate: close button → hide, don't quit ──────────────
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    // ── HTML loading (local cache + Render fetch) ──────────────────────
    func loadHTML() {
        let fileURL = URL(fileURLWithPath: HTML_PATH)
        if FileManager.default.fileExists(atPath: HTML_PATH) {
            webView.loadFileURL(fileURL, allowingReadAccessTo: URL(fileURLWithPath: INSTALL_DIR))
            return
        }
        // No cache — fetch blocking so the app has something to show
        fetchHTMLBlocking()
        if FileManager.default.fileExists(atPath: HTML_PATH) {
            webView.loadFileURL(fileURL, allowingReadAccessTo: URL(fileURLWithPath: INSTALL_DIR))
        } else {
            let html = """
            <html><body style='background:#0a0e1b;color:#e8ecff;font-family:-apple-system;padding:40px'>
            <h2>⚠️ Tracker couldn't load</h2>
            <p>Offline or Render unreachable. Reconnect and click menu bar ⏱ → Reload UI.</p>
            </body></html>
            """
            webView.loadHTMLString(html, baseURL: nil)
        }
    }

    // Background refresh — writes new HTML to disk for next launch.
    // Does NOT reload the running webview (avoids mid-session disruption).
    func refreshHTMLFromRender() {
        guard let url = URL(string: HTML_URL) else { return }
        var req = URLRequest(url: url, timeoutInterval: HTML_REFRESH_TIMEOUT)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            if let err = err {
                self?.logSwiftError(kind: "html_fetch_error",
                                    message: err.localizedDescription,
                                    context: HTML_URL)
                return
            }
            guard let d = data, d.count > 10_000 else {
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                let bytes = data?.count ?? 0
                self?.logSwiftError(kind: "html_fetch_bad",
                                    message: "status=\(code) bytes=\(bytes)",
                                    context: HTML_URL)
                return
            }
            try? d.write(to: URL(fileURLWithPath: HTML_PATH))
        }.resume()
    }

    // Synchronous fetch used only when there's no cached HTML yet.
    func fetchHTMLBlocking() {
        guard let url = URL(string: HTML_URL) else { return }
        let sema = DispatchSemaphore(value: 0)
        var req = URLRequest(url: url, timeoutInterval: HTML_REFRESH_TIMEOUT)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { data, _, _ in
            if let d = data, d.count > 10_000 {
                try? d.write(to: URL(fileURLWithPath: HTML_PATH))
            }
            sema.signal()
        }.resume()
        _ = sema.wait(timeout: .now() + HTML_REFRESH_TIMEOUT + 1)
    }

    // Manual reload: pulls fresh HTML, then reloads the webview.
    // State survives because index.html owns it in localStorage and
    // rehydrates on load via restoreSnapshot().
    @objc func reloadFromRender() {
        guard let url = URL(string: HTML_URL) else { return }
        var req = URLRequest(url: url, timeoutInterval: HTML_REFRESH_TIMEOUT)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let self = self else { return }
            if let d = data, d.count > 10_000 {
                try? d.write(to: URL(fileURLWithPath: HTML_PATH))
            }
            DispatchQueue.main.async { self.loadHTML() }
        }.resume()
    }

    @objc func showWindow() {
        NSApp.activate(ignoringOtherApps: true)
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
    }

    // ── My Dashboard (personal per-user dashboard) ─────────────────────
    // Asks backend for a short-lived signed token tied to this user's full
    // name, then opens the Render-hosted /my/ dashboard in the default
    // browser with token+user in the URL hash. No login screen — the Mac
    // app's identity IS the auth.
    @objc func openMyDashboard() {
        let fullName = NSFullUserName()
        postToApi(action: "myDashboardToken", payload: ["user": fullName]) { [weak self] resp in
            guard let self = self else { return }
            if let ok = resp["ok"] as? Bool, ok, let token = resp["token"] as? String {
                let encToken = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token
                let encUser  = fullName.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? fullName
                let full = MY_DASH_URL + "#token=" + encToken + "&user=" + encUser
                DispatchQueue.main.async {
                    if let u = URL(string: full) { NSWorkspace.shared.open(u) }
                }
            } else {
                DispatchQueue.main.async {
                    let alert = NSAlert()
                    alert.messageText = "Couldn't open My Dashboard"
                    alert.informativeText = (resp["error"] as? String)
                        ?? "Unknown error. Please check your internet connection and try again."
                    alert.alertStyle = .warning
                    alert.addButton(withTitle: "OK")
                    alert.runModal()
                }
            }
        }
    }

    // ── System hooks (lock/unlock/sleep/wake) ──────────────────────────
    func registerSystemHooks() {
        let nc = NSWorkspace.shared.notificationCenter
        nc.addObserver(self, selector: #selector(screenLocked),
                       name: NSWorkspace.screensDidSleepNotification, object: nil)
        nc.addObserver(self, selector: #selector(screenUnlocked),
                       name: NSWorkspace.screensDidWakeNotification, object: nil)
        nc.addObserver(self, selector: #selector(screenUnlocked),
                       name: NSWorkspace.didWakeNotification, object: nil)
        nc.addObserver(self, selector: #selector(screenUnlocked),
                       name: NSWorkspace.sessionDidBecomeActiveNotification, object: nil)
        // Distributed notification fallback (CGSession lock/unlock)
        let dnc = DistributedNotificationCenter.default()
        dnc.addObserver(self, selector: #selector(screenLocked),
                        name: NSNotification.Name("com.apple.screenIsLocked"), object: nil)
        dnc.addObserver(self, selector: #selector(screenUnlocked),
                        name: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil)
    }

    @objc func screenLocked() {
        guard !isLocked else { return }
        isLocked = true
        lockStart = Date()
        sendToJS("onLock", payload: [:])
    }

    @objc func screenUnlocked() {
        let wasLocked = isLocked
        let dur = lockStart.map { Date().timeIntervalSince($0) } ?? 0
        isLocked = false
        lockStart = nil
        if wasLocked {
            sendToJS("onUnlock", payload: ["duration": dur])
        }
        // Always auto-show the tracker on wake/unlock, even if it was minimized.
        DispatchQueue.main.async { self.showWindow() }
    }

    // ── Timers ──────────────────────────────────────────────────────────
    func startTimers() {
        idleTimer = Timer.scheduledTimer(withTimeInterval: IDLE_TICK_INTERVAL, repeats: true) { [weak self] _ in
            self?.tickIdle()
        }
        configTimer = Timer.scheduledTimer(withTimeInterval: CONFIG_POLL_INTERVAL, repeats: true) { [weak self] _ in
            self?.pollConfig()
        }
    }

    func tickIdle() {
        let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState,
                                                           eventType: CGEventType(rawValue: ~0)!)
        sendToJS("onIdleTick", payload: ["seconds": idle])
    }

    // ── JS bridge ──────────────────────────────────────────────────────
    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let op = body["op"] as? String else { return }
        let payload = body["payload"] as? [String: Any] ?? [:]
        let requestId = body["requestId"] as? String

        switch op {
        case "getUser":
            reply(requestId, data: ["fullName": NSFullUserName(), "version": APP_VERSION])
        case "logTask":
            postToApi(action: "logTask", payload: payload) { self.reply(requestId, data: $0) }
        case "markAttendance":
            postToApi(action: "markAttendance", payload: payload) { self.reply(requestId, data: $0) }
        case "closeSession":
            postToApi(action: "closeSession", payload: payload) { self.reply(requestId, data: $0) }
        case "heartbeat":
            postToApi(action: "heartbeat", payload: payload) { _ in }
        case "shiftStart":
            postToApi(action: "shiftStart", payload: payload) { _ in }
        case "idleAlert":
            postToApi(action: "idleAlert", payload: payload) { _ in }
        case "clearForceReset":
            postToApi(action: "clearForceReset", payload: payload) { _ in }
        case "logError":
            // Forward JS runtime errors to the Errors tab so Arun sees them
            // before users report "app is broken". Source=js so native-side
            // (Swift) errors from logSwiftError() come through as source=swift.
            var p = payload
            p["source"] = "js"
            postToApi(action: "logError", payload: p) { _ in }
        case "getConfig":
            fetchConfig { cfg in self.reply(requestId, data: cfg) }
        case "openUrl":
            if let s = payload["url"] as? String, let url = URL(string: s) {
                NSWorkspace.shared.open(url)
            }
        case "minimize":
            DispatchQueue.main.async { self.window.orderOut(nil) }
        case "reloadUI":
            DispatchQueue.main.async { self.reloadFromRender() }
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

    // Swift-side error reporter. Fire-and-forget — posts to Errors tab so
    // Arun sees Swift failures (HTML fetch errors, config timeouts, etc.)
    // without depending on users noticing and reporting.
    func logSwiftError(kind: String, message: String, context: String = "") {
        let payload: [String: Any] = [
            "source": "swift",
            "kind": kind,
            "message": message,
            "context": context
        ]
        postToApi(action: "logError", payload: payload) { _ in }
    }

    // ── Apps Script API ────────────────────────────────────────────────
    func postToApi(action: String, payload: [String: Any],
                   done: @escaping ([String: Any]) -> Void) {
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
            if let d = data,
               let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                done(obj)
            } else {
                done(["ok": true])
            }
        }.resume()
    }

    func fetchConfig(done: @escaping ([String: Any]) -> Void) {
        guard let url = URL(string: SHEET_URL + "?action=getConfig") else { done([:]); return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            if let d = data,
               let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                done(obj)
            } else { done([:]) }
        }.resume()
    }

    // ── Config poll (forceReset + maintenance banner) ──────────────────
    //
    // Config!B3 = forceReset. Comma-separated entries. Two modes:
    //   "Arun Mohan"        → silent UI reload (pull fresh HTML)
    //   "RESET:Arun Mohan"  → clear localStorage + start fresh
    // Both clear the user's entry on success.
    func pollConfig() {
        fetchConfig { [weak self] cfg in
            guard let self = self else { return }
            if let fr = cfg["forceReset"] as? String, !fr.isEmpty {
                let myName = NSFullUserName().lowercased()
                let entries = fr.split(separator: ",").map {
                    $0.trimmingCharacters(in: .whitespaces)
                }
                for entry in entries {
                    var raw = entry
                    var resetMode = false
                    if raw.lowercased().hasPrefix("reset:") {
                        raw = String(raw.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                        resetMode = true
                    }
                    if raw.lowercased() == myName {
                        if resetMode {
                            self.sendToJS("onForceReset", payload: ["mode": "reset"])
                        } else {
                            DispatchQueue.main.async { self.reloadFromRender() }
                        }
                        self.postToApi(action: "clearForceReset",
                                       payload: ["user": NSFullUserName()]) { _ in }
                        break
                    }
                }
            }
            self.sendToJS("onConfig", payload: cfg)
        }
    }
}

// ── Main ───────────────────────────────────────────────────────────────
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
