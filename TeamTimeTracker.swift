import Foundation
import Cocoa
import CoreGraphics
import IOKit

// ═══════════════════════════════════════════════════════════
//  Team Time Tracker v4 — Simplified & Reliable
//  - 9hr shift + 1hr break
//  - "Break marked" / "Break not marked" in sheet
//  - Meeting/Training lock = no break flag
//  - Auto-break detection on UNLOCK via saved timestamp
// ═══════════════════════════════════════════════════════════

// ── COLORS ──
struct C {
    static let bg        = NSColor(red: 0.06, green: 0.09, blue: 0.16, alpha: 1.0)
    static let card      = NSColor(red: 0.12, green: 0.16, blue: 0.24, alpha: 1.0)
    static let border    = NSColor(red: 0.20, green: 0.25, blue: 0.33, alpha: 1.0)
    static let textMain  = NSColor(red: 0.89, green: 0.91, blue: 0.94, alpha: 1.0)
    static let textDim   = NSColor(red: 0.58, green: 0.64, blue: 0.72, alpha: 1.0)
    static let green     = NSColor(red: 0.13, green: 0.77, blue: 0.37, alpha: 1.0)
    static let orange    = NSColor(red: 0.96, green: 0.62, blue: 0.04, alpha: 1.0)
    static let deepOrange = NSColor(red: 0.98, green: 0.45, blue: 0.09, alpha: 1.0)
    static let blue      = NSColor(red: 0.23, green: 0.51, blue: 0.97, alpha: 1.0)
    static let purple    = NSColor(red: 0.66, green: 0.33, blue: 0.97, alpha: 1.0)
    static let red       = NSColor(red: 0.94, green: 0.27, blue: 0.27, alpha: 1.0)
}

func colorFor(_ a: String) -> NSColor {
    switch a {
    case "Production": return C.green
    case "Break": return C.orange
    case "Lunch/Dinner": return C.deepOrange
    case "Meeting": return C.blue
    case "Training": return C.purple
    default: return C.textDim
    }
}

func iconFor(_ a: String) -> String {
    switch a {
    case "Production": return "⚙"
    case "Break": return "☕"
    case "Lunch/Dinner": return "🍽"
    case "Meeting": return "👥"
    case "Training": return "📚"
    default: return "⏱"
    }
}

func fmt(_ s: TimeInterval) -> String {
    let t = Int(max(0, s))
    return String(format: "%02d:%02d:%02d", t/3600, (t%3600)/60, t%60)
}

func fmtShort(_ s: TimeInterval) -> String {
    let t = Int(max(0, s))
    return String(format: "%02d:%02d", t/60, t%60)
}

func fmtDur(_ s: TimeInterval) -> String {
    let t = Int(max(0, s))
    return "\(t/60)m \(t%60)s"
}

func timeStr(_ d: Date) -> String {
    let f = DateFormatter(); f.dateFormat = "h:mm:ss a"; f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "Asia/Kolkata")
    return f.string(from: d)
}

func dateStr(_ d: Date) -> String {
    let f = DateFormatter(); f.dateFormat = "dd/MM/yyyy"; f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "Asia/Kolkata")
    return f.string(from: d)
}

func dateTimeStr(_ d: Date) -> String {
    let f = DateFormatter(); f.dateFormat = "dd/MM/yyyy h:mm:ss a"; f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "Asia/Kolkata")
    return f.string(from: d)
}

struct LogEntry {
    let activity: String
    let start: Date
    let end: Date
    let duration: TimeInterval
    let status: String // "Break marked", "Break not marked", or activity name
}

// ── SHIFT TIME CHECK ──
func isAfter8PMist() -> Bool {
    let tz = TimeZone(identifier: "Asia/Kolkata")!
    var cal = Calendar.current
    cal.timeZone = tz
    let hour = cal.component(.hour, from: Date())
    return hour >= 20 // 8:00 PM IST = hour 20
}

func getSystemUserName() -> String {
    let full = NSFullUserName()
    if !full.isEmpty { return full }
    var raw = NSUserName()
    raw = raw.replacingOccurrences(of: #"\.[a-z]+\.[a-z]+$"#, with: "", options: .regularExpression)
    return raw.split(separator: ".").map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }.joined(separator: " ")
}

// ═══════════════════════════════════════════════════════════
//  STATE PERSISTENCE — survives app restart during lock
// ═══════════════════════════════════════════════════════════

class TrackerState {
    static let dir = NSHomeDirectory() + "/Library/TeamTracker"
    static let file = dir + "/state.json"

    static func save(_ d: AppDelegate) {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        var dict: [String: Any] = [
            "shiftActive": d.productionStarted,
            "shiftEnded": d.shiftEnded,
            "autoBreak": d.autoBreakTriggered
        ]
        if let a = d.currentActivity { dict["activity"] = a }
        if let t = d.currentActivityStart { dict["activityStart"] = t.timeIntervalSince1970 }
        if let t = d.shiftStartTime { dict["shiftStart"] = t.timeIntervalSince1970 }
        if let t = d.shiftEndTime { dict["shiftEndTime"] = t.timeIntervalSince1970 }
        // CRITICAL: save last activity timestamp so we detect lock gap on restart
        dict["lastActivity"] = d.lastActivityTimestamp.timeIntervalSince1970
        dict["t_prod"] = d.totals["Production", default: 0]
        dict["t_break"] = d.totals["Break", default: 0]
        dict["t_lunch"] = d.totals["Lunch/Dinner", default: 0]
        dict["t_meet"] = d.totals["Meeting", default: 0]
        dict["t_train"] = d.totals["Training", default: 0]
        if let data = try? JSONSerialization.data(withJSONObject: dict) {
            try? data.write(to: URL(fileURLWithPath: file))
        }
    }

    static func load() -> [String: Any]? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: file)),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return dict
    }

    static func clear() { try? FileManager.default.removeItem(atPath: file) }
}

// ═══════════════════════════════════════════════════════════
//  REQUEST QUEUE — Batch sync to Google Sheets (110+ users safe)
//  Queues all events locally, sends ONE batch POST every 3 min
// ═══════════════════════════════════════════════════════════

class RequestQueue {
    static let shared = RequestQueue()

    let queueFile = NSHomeDirectory() + "/Library/TeamTracker/queue.json"
    var sheetUrl = ""

    // ── Buckets ──
    var liveStatus: [String: Any]?          // Latest snapshot (overwrite)
    var activityLogs: [[String: Any]] = []  // Appended per activity switch
    var idleAlerts: [[String: Any]] = []    // Appended per idle event
    var shiftSummary: [String: Any]?        // Set once at end of shift

    // ── Sync config ──
    let syncInterval: TimeInterval = 180    // 3 minutes base
    let jitterOffset: TimeInterval          // Random 0-120s, set once
    var backoffDelay: TimeInterval = 0
    var consecutiveFailures = 0
    var isSyncing = false
    var syncTimer: Timer?

    var hasPendingData: Bool {
        return liveStatus != nil || !activityLogs.isEmpty || !idleAlerts.isEmpty || shiftSummary != nil
    }

    init() {
        jitterOffset = Double.random(in: 0...120)
        loadFromDisk()
    }

    // ── Enqueue methods ──
    func enqueueLiveStatus(_ data: [String: Any]) {
        liveStatus = data
        saveToDisk()
    }

    func enqueueActivityLog(_ data: [String: Any]) {
        activityLogs.append(data)
        saveToDisk()
    }

    func enqueueIdleAlert(_ data: [String: Any]) {
        idleAlerts.append(data)
        saveToDisk()
    }

    func enqueueShiftSummary(_ data: [String: Any]) {
        shiftSummary = data
        saveToDisk()
        // Priority: flush immediately on shift end
        flushNow()
    }

    // ── Start sync timer ──
    func startSyncTimer() {
        syncTimer?.invalidate()
        let interval = syncInterval + jitterOffset
        syncTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            self?.flushNow()
        }
    }

    func stopSyncTimer() {
        syncTimer?.invalidate()
        syncTimer = nil
    }

    // ── Flush: send ONE batch POST ──
    func flushNow(completion: (() -> Void)? = nil) {
        guard !isSyncing && hasPendingData else { completion?(); return }
        guard let url = URL(string: sheetUrl), !sheetUrl.isEmpty else { completion?(); return }

        isSyncing = true

        // Build batch payload
        var batch: [String: Any] = ["type": "batch"]
        if let ls = liveStatus { batch["live_status"] = ls }
        if !activityLogs.isEmpty { batch["activity_logs"] = activityLogs }
        if !idleAlerts.isEmpty { batch["idle_alerts"] = idleAlerts }
        if let ss = shiftSummary { batch["shift_summary"] = ss }

        // Snapshot what we're sending (so we only clear THESE on success)
        let sentLive = liveStatus != nil
        let sentLogCount = activityLogs.count
        let sentIdleCount = idleAlerts.count
        let sentSummary = shiftSummary != nil

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: batch)

        URLSession.shared.dataTask(with: req) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                let httpOK = (response as? HTTPURLResponse)?.statusCode == 200
                let bodyOK = data.flatMap { String(data: $0, encoding: .utf8) }?.contains("OK") ?? false

                if error == nil && (httpOK || bodyOK) {
                    // ── Success: clear only what we sent ──
                    if sentLive { self.liveStatus = nil }
                    if sentLogCount > 0 { self.activityLogs.removeFirst(min(sentLogCount, self.activityLogs.count)) }
                    if sentIdleCount > 0 { self.idleAlerts.removeFirst(min(sentIdleCount, self.idleAlerts.count)) }
                    if sentSummary { self.shiftSummary = nil }
                    self.backoffDelay = 0
                    self.consecutiveFailures = 0
                    self.saveToDisk()
                } else {
                    // ── Failure: keep data, retry with backoff ──
                    self.consecutiveFailures += 1
                    self.backoffDelay = min(Double(self.consecutiveFailures) * 30.0, 600.0)
                    // Schedule retry
                    DispatchQueue.main.asyncAfter(deadline: .now() + self.backoffDelay) { [weak self] in
                        self?.isSyncing = false
                        self?.flushNow()
                    }
                    self.isSyncing = false
                    completion?()
                    return
                }
                self.isSyncing = false
                completion?()
            }
        }.resume()
    }

    // ── Persistence ──
    func saveToDisk() {
        let dir = NSHomeDirectory() + "/Library/TeamTracker"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        var dict: [String: Any] = ["version": 1]
        if let ls = liveStatus { dict["live_status"] = ls }
        if !activityLogs.isEmpty { dict["activity_logs"] = activityLogs }
        if !idleAlerts.isEmpty { dict["idle_alerts"] = idleAlerts }
        if let ss = shiftSummary { dict["shift_summary"] = ss }
        if let data = try? JSONSerialization.data(withJSONObject: dict) {
            try? data.write(to: URL(fileURLWithPath: queueFile), options: .atomic)
        }
    }

    func loadFromDisk() {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: queueFile)),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        liveStatus = dict["live_status"] as? [String: Any]
        activityLogs = dict["activity_logs"] as? [[String: Any]] ?? []
        idleAlerts = dict["idle_alerts"] as? [[String: Any]] ?? []
        shiftSummary = dict["shift_summary"] as? [String: Any]
    }

    func clearQueue() {
        liveStatus = nil; activityLogs = []; idleAlerts = []; shiftSummary = nil
        try? FileManager.default.removeItem(atPath: queueFile)
    }
}

// ═══════════════════════════════════════════════════════════
//  APP DELEGATE
// ═══════════════════════════════════════════════════════════

class AppDelegate: NSObject, NSApplicationDelegate {
    var userName = ""
    let sheetUrl = "https://script.google.com/macros/s/AKfycbzzpzMrmp9oYfmT8_5OzvvVEFMNdItd6fhGGQlOsggSy16Ke0zEBa7d35iohRGb5XmRJw/exec"
    let APP_VERSION = "2.4.7"

    var shiftStartTime: Date?
    var currentActivity: String?
    var currentActivityStart: Date?
    var productionStarted = false
    var shiftEnded = false
    var shiftEndTime: Date?  // When shift was ended — used for 12hr reset
    var autoBreakTriggered = false
    var totals: [String: TimeInterval] = ["Production":0, "Break":0, "Lunch/Dinner":0, "Meeting":0, "Training":0]
    var breakNotMarkedTotal: TimeInterval = 0 // Track "Break not marked" minutes separately
    var activityLog: [LogEntry] = []
    var lastActivityTimestamp = Date()
    var idleLogged = false // Prevent duplicate "idle" sheet entries per idle period
    var totalIdleTime: TimeInterval = 0 // Accumulated idle time (separate from Break)
    var idleAccumulating = false // Track if we're currently in an idle period
    var idleStartTime: Date? // When the current idle period began
    var idleSummaryLabel: NSTextField? // UI label for idle time in summary
    let IDLE_ALERT: TimeInterval = 5 * 60    // 5 min cursor idle → log to sheet (NOT auto-break)
    let SHIFT_HOURS: TimeInterval = 9 * 3600 // 9 hour shift
    let BREAK_ALLOWED: TimeInterval = 3600    // 1 hour break
    let activities = ["Production", "Break", "Lunch/Dinner", "Meeting", "Training"]

    var overlayWindows: [NSWindow] = []
    var isOverlayShowing = false
    var trackerWindow: NSWindow?
    var ticker: Timer?
    var globalMouseMonitor: Any?
    var globalKeyMonitor: Any?
    var tickCount = 0

    // UI elements
    var welcomeLabel: NSTextField?
    var shiftElapsedLabel: NSTextField?
    var shiftRemainingLabel: NSTextField?
    var idleLabel: NSTextField?
    var currentActivityLabel: NSTextField?
    var currentTimerLabel: NSTextField?
    var activityButtons: [String: NSButton] = [:]
    var activityTimerLabels: [String: NSTextField] = [:]
    var summaryLabels: [String: NSTextField] = [:]
    var breakTimeLabel: NSTextField?
    var breakBar: NSView?
    var breakBarFill: NSView?
    var breakExceededLabel: NSTextField?
    var inactivityBanner: NSView?
    var inactivityBannerLabel: NSTextField?
    var logScrollView: NSScrollView?
    var productionTotalLabel: NSTextField?
    var wasScreenLocked = false
    var lockCheckTimer: Timer?
    var overlayDismissed = false  // Prevents overlay from re-showing after click

    // ═══ APP LAUNCH ═══
    func applicationWillTerminate(_ notification: Notification) {
        try? FileManager.default.removeItem(atPath: "/tmp/TeamTimeTracker.lock")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // ── SINGLE INSTANCE GUARD ──
        let lockFile = "/tmp/TeamTimeTracker.lock"
        let myPID = ProcessInfo.processInfo.processIdentifier
        if let pidStr = try? String(contentsOfFile: lockFile, encoding: .utf8),
           let existingPID = Int32(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)),
           existingPID != myPID && kill(existingPID, 0) == 0 {
            exit(0) // Another instance already running — exit immediately
        }
        try? "\(myPID)".write(toFile: lockFile, atomically: true, encoding: .utf8)

        NSApp.setActivationPolicy(.accessory)

        // ── CRITICAL: Disable App Nap so timers run during screen lock ──
        ProcessInfo.processInfo.disableAutomaticTermination("Tracking shift")
        if #available(macOS 10.9, *) {
            ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleSystemSleepDisabled], reason: "Team Time Tracker must detect screen lock/unlock")
        }

        userName = getSystemUserName()

        // ── Initialize request queue ──
        RequestQueue.shared.sheetUrl = sheetUrl
        RequestQueue.shared.startSyncTimer()
        // Flush any persisted queue from previous crash
        if RequestQueue.shared.hasPendingData {
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                RequestQueue.shared.flushNow()
            }
        }

        if let state = TrackerState.load() {
            let isActive = state["shiftActive"] as? Bool ?? false
            let isEnded = state["shiftEnded"] as? Bool ?? false
            if isActive {
                productionStarted = true
                shiftEnded = false
                autoBreakTriggered = state["autoBreak"] as? Bool ?? false
                currentActivity = state["activity"] as? String
                if let t = state["activityStart"] as? TimeInterval { currentActivityStart = Date(timeIntervalSince1970: t) }
                if let t = state["shiftStart"] as? TimeInterval { shiftStartTime = Date(timeIntervalSince1970: t) }
                // CRITICAL: Restore saved lastActivity timestamp, NOT current time
                if let t = state["lastActivity"] as? TimeInterval { lastActivityTimestamp = Date(timeIntervalSince1970: t) }
                totals["Production"] = state["t_prod"] as? TimeInterval ?? 0
                totals["Break"] = state["t_break"] as? TimeInterval ?? 0
                totals["Lunch/Dinner"] = state["t_lunch"] as? TimeInterval ?? 0
                totals["Meeting"] = state["t_meet"] as? TimeInterval ?? 0
                totals["Training"] = state["t_train"] as? TimeInterval ?? 0
                showTracker()
                startTicker()
                startIdleTracking()
            } else if isEnded {
                // Shift ended — check cooldown
                shiftEnded = true
                if let endEpoch = state["shiftEndTime"] as? TimeInterval {
                    shiftEndTime = Date(timeIntervalSince1970: endEpoch)
                    let hoursSinceEnd = Date().timeIntervalSince(Date(timeIntervalSince1970: endEpoch))
                    if hoursSinceEnd >= 1800 && isAfter8PMist() {
                        // Cooldown passed + after 8 PM — show overlay for new shift
                        TrackerState.clear()
                        shiftEnded = false
                        shiftEndTime = nil
                        showOverlay()
                    }
                    // else: within cooldown — stay quiet
                }
            } else {
                // No shift started — show overlay only after 8 PM IST
                if isAfter8PMist() {
                    showOverlay()
                }
                // else: before 8 PM, stay quiet
            }
        } else {
            // No state file — FIRST TIME LAUNCH: show overlay immediately
            showOverlay()
        }

        // ── LOCK DETECTION: Use a timer that checks every 3 seconds ──
        startLockDetection()

        // ── AUTO-UPDATE: Check on startup (30s delay) + every 2 hours ──
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in self?.checkForUpdate() }
        Timer.scheduledTimer(withTimeInterval: 7200, repeats: true) { [weak self] _ in self?.checkForUpdate() }
    }

    // ═══ AUTO-UPDATE ═══
    func checkForUpdate() {
        guard let url = URL(string: sheetUrl + "?action=version") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, error in
            guard let self = self, error == nil, let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let remoteVersion = json["version"] as? String,
                  let sourceUrl = json["sourceUrl"] as? String,
                  self.isNewer(remote: remoteVersion, local: self.APP_VERSION) else { return }

            // Download new source
            guard let srcUrl = URL(string: sourceUrl) else { return }
            URLSession.shared.dataTask(with: srcUrl) { srcData, _, srcError in
                guard srcError == nil, let srcData = srcData, srcData.count > 1000 else { return }
                self.performUpdate(sourceData: srcData, newVersion: remoteVersion)
            }.resume()
        }.resume()
    }

    func isNewer(remote: String, local: String) -> Bool {
        let r = remote.split(separator: ".").compactMap { Int($0) }
        let l = local.split(separator: ".").compactMap { Int($0) }
        for i in 0..<max(r.count, l.count) {
            let rv = i < r.count ? r[i] : 0
            let lv = i < l.count ? l[i] : 0
            if rv > lv { return true }
            if rv < lv { return false }
        }
        return false
    }

    func performUpdate(sourceData: Data, newVersion: String) {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let installDir = "\(home)/Library/TeamTracker"
        let appBinary = "\(home)/Applications/TeamTimeTracker.app/Contents/MacOS/TeamTimeTracker"
        let tempSwift = "\(installDir)/TeamTimeTracker_update.swift"
        let tempBinary = "\(installDir)/TeamTimeTracker_update"

        // 1. Write new source
        guard FileManager.default.createFile(atPath: tempSwift, contents: sourceData) else { return }

        // 2. Compile
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/swiftc")
        proc.arguments = ["-O", "-o", tempBinary, tempSwift, "-framework", "Cocoa", "-framework", "CoreGraphics", "-framework", "IOKit"]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do { try proc.run(); proc.waitUntilExit() } catch { return }
        guard proc.terminationStatus == 0 else {
            try? FileManager.default.removeItem(atPath: tempSwift)
            try? FileManager.default.removeItem(atPath: tempBinary)
            return
        }

        // 3. Replace binaries
        try? FileManager.default.removeItem(atPath: appBinary)
        try? FileManager.default.copyItem(atPath: tempBinary, toPath: appBinary)
        try? FileManager.default.removeItem(atPath: "\(installDir)/TeamTimeTracker")
        try? FileManager.default.copyItem(atPath: tempBinary, toPath: "\(installDir)/TeamTimeTracker")
        chmod(appBinary, 0o755)
        chmod("\(installDir)/TeamTimeTracker", 0o755)

        // 4. Also save the new source for future installs
        try? FileManager.default.removeItem(atPath: "\(installDir)/TeamTimeTracker.swift")
        try? FileManager.default.moveItem(atPath: tempSwift, toPath: "\(installDir)/TeamTimeTracker.swift")

        // 5. Cleanup temp binary
        try? FileManager.default.removeItem(atPath: tempBinary)

        // 6. Exit — KeepAlive in LaunchAgent will restart with new binary
        DispatchQueue.main.async {
            TrackerState.save(self)
            exit(0)
        }
    }

    // ═══ LOCK / IDLE DETECTION ═══
    // Idle (cursor still, screen ON): tracked after 5 min via checkIdle()
    // Break not marked (screen LOCKED): tracked after 10 min via checkScreenLock()
    // CGSession tried first for real lock detection; falls back to IOKit 10-min threshold
    var lockStartTime: Date?
    let LOCK_IDLE_THRESHOLD: Double = 600 // 10 minutes of idle = "locked" (break not marked)

    func getSystemIdleTime() -> Double {
        var iter: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"), &iter) == KERN_SUCCESS else { return 0 }
        let entry = IOIteratorNext(iter)
        IOObjectRelease(iter)
        guard entry != 0 else { return 0 }
        var props: Unmanaged<CFMutableDictionary>?
        guard IORegistryEntryCreateCFProperties(entry, &props, kCFAllocatorDefault, 0) == KERN_SUCCESS else { IOObjectRelease(entry); return 0 }
        IOObjectRelease(entry)
        if let dict = props?.takeRetainedValue() as? [String: Any],
           let idle = dict["HIDIdleTime"] as? Int64 {
            return Double(idle) / 1_000_000_000
        }
        return 0
    }

    // Try CGSession for real lock detection; fall back to IOKit idle threshold
    func isScreenActuallyLocked(idleTime: Double) -> Bool {
        // CGSession: works on most Macs (returns actual lock state)
        if let dict = CGSessionCopyCurrentDictionary() as NSDictionary?,
           let locked = dict["CGSSessionScreenIsLocked"] as? Bool {
            return locked
        }
        // Fallback for Jamf/MDM machines: treat 10+ min idle as "locked"
        return idleTime >= LOCK_IDLE_THRESHOLD
    }

    func startLockDetection() {
        // ── PRIMARY: macOS distributed notifications (instant, works even when app is frozen) ──
        DistributedNotificationCenter.default().addObserver(
            self, selector: #selector(screenDidLock),
            name: NSNotification.Name("com.apple.screenIsLocked"), object: nil)
        DistributedNotificationCenter.default().addObserver(
            self, selector: #selector(screenDidUnlock),
            name: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil)

        // ── BACKUP: Workspace notifications for sleep/wake ──
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(screenDidLock),
            name: NSWorkspace.screensDidSleepNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(screenDidUnlock),
            name: NSWorkspace.screensDidWakeNotification, object: nil)

        // ── FALLBACK TIMER: For MDM/Jamf machines where notifications may be blocked ──
        lockCheckTimer?.invalidate()
        lockCheckTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.checkScreenLockFallback()
        }
    }

    @objc func screenDidLock(_ notification: Notification) {
        guard !wasScreenLocked else { return } // Already handling a lock
        wasScreenLocked = true
        lockStartTime = Date()
        if productionStarted {
            TrackerState.save(self)
        }
    }

    @objc func screenDidUnlock(_ notification: Notification) {
        guard wasScreenLocked else { return } // Not currently locked
        wasScreenLocked = false
        overlayDismissed = false
        handleUnlock()
    }

    // Fallback for machines where distributed notifications don't fire
    func checkScreenLockFallback() {
        let idleTime = getSystemIdleTime()
        let locked = isScreenActuallyLocked(idleTime: idleTime)

        if locked && !wasScreenLocked {
            // Notification didn't fire — use fallback
            wasScreenLocked = true
            lockStartTime = Date().addingTimeInterval(-idleTime)
            if productionStarted {
                TrackerState.save(self)
            }
        }

        if !locked && wasScreenLocked {
            // Notification didn't fire on unlock — use fallback
            wasScreenLocked = false
            overlayDismissed = false
            handleUnlock()
        }

        // After 8 PM IST with no active shift — show overlay
        // 30-min cooldown after ending shift to prevent popup loop
        let cooldownPassed = shiftEndTime == nil || Date().timeIntervalSince(shiftEndTime!) >= 1800
        if !productionStarted && cooldownPassed && isAfter8PMist() && !isOverlayShowing {
            showOverlay()
        }
    }

    func handleUnlock() {
        if productionStarted {
            let lockTime = lockStartTime ?? Date().addingTimeInterval(-60)
            let now = Date()
            let lockDuration = now.timeIntervalSince(lockTime)

            // Ignore very short idle periods (< 60 seconds) — not a real lock
            if lockDuration < 60 {
                lockStartTime = nil
                return
            }

            if lockDuration >= LOCK_IDLE_THRESHOLD { // 10 minutes = real lock/break
                if let cur = currentActivity {
                    if cur == "Break" || cur == "Lunch/Dinner" {
                        // ✅ Break/Lunch was marked — timer keeps running
                        // Show "Welcome back" popup
                        showWelcomeBack(from: cur, duration: lockDuration)
                    } else if cur == "Meeting" || cur == "Training" {
                        // ✅ In Meeting/Training — don't flag, timer keeps running
                        showWelcomeBack(from: cur, duration: lockDuration)
                    } else {
                        // ❌ Production locked without marking break!

                        // 1. End Production at lock time
                        if let start = currentActivityStart {
                            let elapsed = lockTime.timeIntervalSince(start)
                            guard elapsed > 0 else {
                                // lockTime is before currentActivityStart — stale/invalid state, skip
                                lockStartTime = nil
                                return
                            }
                            totals[cur, default: 0] += elapsed
                            let entry = LogEntry(activity: cur, start: start, end: lockTime, duration: elapsed, status: cur)
                            activityLog.append(entry)
                            addLogEntry(entry)
                            sendToSheet(entry)
                            if let btn = activityButtons[cur] {
                                btn.layer?.borderColor = colorFor(cur).withAlphaComponent(0.2).cgColor
                                btn.layer?.backgroundColor = colorFor(cur).withAlphaComponent(0.1).cgColor
                            }
                        }

                        // 2. Log break as "Break not marked"
                        totals["Break", default: 0] += lockDuration
                        breakNotMarkedTotal += lockDuration
                        let breakEntry = LogEntry(activity: "Break", start: lockTime, end: now, duration: lockDuration, status: "Break not marked")
                        activityLog.append(breakEntry)
                        addLogEntry(breakEntry)
                        sendToSheet(breakEntry)

                        // 3. Switch to Break (already logged above, so autoBreakTriggered = false
                        //    to prevent switchActivity() from logging it AGAIN as "Break not marked")
                        currentActivity = "Break"
                        currentActivityStart = now
                        autoBreakTriggered = false
                        if let btn = activityButtons["Break"] {
                            btn.layer?.borderColor = colorFor("Break").cgColor
                            btn.layer?.backgroundColor = colorFor("Break").withAlphaComponent(0.25).cgColor
                        }
                        currentActivityLabel?.stringValue = "Break"
                        currentActivityLabel?.textColor = colorFor("Break")
                        currentTimerLabel?.textColor = colorFor("Break")

                        inactivityBanner?.isHidden = false
                        inactivityBannerLabel?.stringValue = "⚠️ Break not marked — Screen was locked without selecting Break"
                        playAlert()
                        sendLiveUpdate("⚠️ Break not marked")
                    }
                }
            }

            // Bring tracker to front
            if let w = trackerWindow {
                w.makeKeyAndOrderFront(nil)
                w.orderFrontRegardless()
                NSApp.setActivationPolicy(.regular)
                NSApp.activate(ignoringOtherApps: true)
            } else {
                showTracker()
                startTicker()
                startIdleTracking()
            }
            lockStartTime = nil
            TrackerState.save(self)

        } else if shiftEnded {
            // Shift ended — show overlay again after 30-min cooldown + 8 PM
            let cooldownPassed = shiftEndTime == nil || Date().timeIntervalSince(shiftEndTime!) >= 1800
            if cooldownPassed && isAfter8PMist() && !isOverlayShowing {
                shiftEnded = false
                shiftEndTime = nil
                TrackerState.clear()
                showOverlay()
            }
        } else {
            // No shift started — show overlay after 8 PM IST
            if isAfter8PMist() && !overlayDismissed && !isOverlayShowing {
                showOverlay()
            }
        }
    }

    // ═══════════════════════════════════════════════
    //  WELCOME BACK POPUP
    // ═══════════════════════════════════════════════

    var welcomeBackWindow: NSWindow?

    func showWelcomeBack(from activity: String, duration: TimeInterval) {
        let firstName = userName.split(separator: " ").first.map(String.init) ?? userName
        let mins = Int(duration / 60)
        let secs = Int(duration) % 60

        let screen = NSScreen.main ?? NSScreen.screens[0]
        let ww: CGFloat = 500, wh: CGFloat = 280
        let wx = screen.frame.midX - ww/2
        let wy = screen.frame.midY - wh/2

        let w = NSWindow(contentRect: NSRect(x: wx, y: wy, width: ww, height: wh), styleMask: .borderless, backing: .buffered, defer: false)
        w.level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()) + 1)
        w.isOpaque = true; w.backgroundColor = .clear; w.isMovable = false

        let v = NSView(frame: NSRect(x: 0, y: 0, width: ww, height: wh))
        v.wantsLayer = true
        v.layer?.backgroundColor = C.card.cgColor
        v.layer?.cornerRadius = 20
        v.layer?.borderWidth = 2
        v.layer?.borderColor = colorFor(activity).withAlphaComponent(0.5).cgColor

        addLabel(to: v, text: "👋", size: 48, x: ww/2-30, y: 200, w: 60, h: 60)
        addLabel(to: v, text: "Welcome back, \(firstName)!", size: 24, x: 0, y: 165, w: ww, h: 35, bold: true)

        let statusMsg: String
        if activity == "Break" {
            statusMsg = "You were on Break for \(mins)m \(secs)s"
        } else if activity == "Lunch/Dinner" {
            statusMsg = "You were on Lunch/Dinner for \(mins)m \(secs)s"
        } else {
            statusMsg = "You were in \(activity) for \(mins)m \(secs)s"
        }
        addLabel(to: v, text: statusMsg, size: 14, x: 0, y: 140, w: ww, h: 22, color: C.textDim)
        addLabel(to: v, text: "\(iconFor(activity)) \(activity) timer is still running", size: 13, x: 0, y: 115, w: ww, h: 20, color: colorFor(activity))

        let resumeBtn = NSButton(frame: NSRect(x: ww/2-100, y: 30, width: 200, height: 45))
        resumeBtn.title = "⚙  Resume Production"
        resumeBtn.font = NSFont.boldSystemFont(ofSize: 15)
        resumeBtn.wantsLayer = true; resumeBtn.layer?.backgroundColor = C.green.cgColor; resumeBtn.layer?.cornerRadius = 10
        resumeBtn.isBordered = false; resumeBtn.contentTintColor = .white
        resumeBtn.target = self; resumeBtn.action = #selector(dismissWelcomeBack)
        v.addSubview(resumeBtn)

        let continueBtn = NSButton(frame: NSRect(x: ww/2-80, y: 5, width: 160, height: 25))
        continueBtn.title = "Continue \(activity)"
        continueBtn.font = NSFont.systemFont(ofSize: 12)
        continueBtn.isBordered = false; continueBtn.contentTintColor = C.textDim
        continueBtn.target = self; continueBtn.action = #selector(dismissWelcomeBackContinue)
        v.addSubview(continueBtn)

        w.contentView = v
        w.makeKeyAndOrderFront(nil)
        w.orderFrontRegardless()
        welcomeBackWindow = w

        // Auto-dismiss after 30 seconds
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            self?.welcomeBackWindow?.orderOut(nil)
            self?.welcomeBackWindow = nil
        }
    }

    @objc func dismissWelcomeBack() {
        welcomeBackWindow?.orderOut(nil)
        welcomeBackWindow = nil
        // Switch to Production
        switchActivity("Production")
    }

    @objc func dismissWelcomeBackContinue() {
        welcomeBackWindow?.orderOut(nil)
        welcomeBackWindow = nil
        // Keep current activity running
    }

    // ═══════════════════════════════════════════════
    //  OVERLAY (SCREEN BLOCKER)
    // ═══════════════════════════════════════════════

    func showOverlay() {
        guard !isOverlayShowing && !overlayDismissed && !productionStarted else {
            if isOverlayShowing { overlayWindows.forEach { $0.orderFrontRegardless() } }
            return
        }
        isOverlayShowing = true
        for screen in NSScreen.screens {
            let w = createOverlayWindow(for: screen)
            overlayWindows.append(w)
            w.makeKeyAndOrderFront(nil)
            w.orderFrontRegardless()
        }
        NSApp.activate(ignoringOtherApps: true)
        enforceFront()
    }

    func enforceFront() {
        guard isOverlayShowing else { return }
        overlayWindows.forEach { $0.orderFrontRegardless() }
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.enforceFront() }
    }

    func createOverlayWindow(for screen: NSScreen) -> NSWindow {
        let w = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false, screen: screen)
        w.level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()) + 1)
        w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        w.isOpaque = true; w.backgroundColor = C.bg; w.isMovable = false; w.ignoresMouseEvents = false

        let v = NSView(frame: screen.frame)
        v.wantsLayer = true; v.layer?.backgroundColor = C.bg.cgColor
        let cx = v.bounds.midX, cy = v.bounds.midY

        // Time-based greeting
        let hour = Calendar.current.component(.hour, from: Date())
        let greeting: String
        let emoji: String
        if hour >= 5 && hour < 12 {
            greeting = "Good Morning"; emoji = "☀️"
        } else if hour >= 12 && hour < 17 {
            greeting = "Good Afternoon"; emoji = "🌤"
        } else if hour >= 17 && hour < 21 {
            greeting = "Good Evening"; emoji = "🌅"
        } else {
            greeting = "Good Evening"; emoji = "🌙"
        }

        // First name only
        let firstName = userName.split(separator: " ").first.map(String.init) ?? userName

        addLabel(to: v, text: emoji, size: 64, x: cx-40, y: cy+100, w: 80, h: 80)
        addLabel(to: v, text: "\(greeting), \(firstName)!", size: 36, x: cx-250, y: cy+45, w: 500, h: 50, bold: true)
        addLabel(to: v, text: "Ready to start your day?", size: 17, x: cx-200, y: cy+15, w: 400, h: 30, color: C.textDim)
        addLabel(to: v, text: "Click below to begin your 9-hour shift.", size: 15, x: cx-250, y: cy-15, w: 500, h: 25, color: C.textDim)
        addLabel(to: v, text: "No other tools or activities are available until you start.", size: 12, x: cx-250, y: cy-45, w: 500, h: 20, color: NSColor(white: 0.4, alpha: 1))

        let btn = NSButton(frame: NSRect(x: cx-130, y: cy-105, width: 260, height: 50))
        btn.title = "🚀  Start Your Day"
        btn.font = NSFont.boldSystemFont(ofSize: 18)
        btn.wantsLayer = true; btn.layer?.backgroundColor = C.green.cgColor; btn.layer?.cornerRadius = 12
        btn.isBordered = false; btn.contentTintColor = .white
        btn.target = self; btn.action = #selector(startProductionClicked)
        v.addSubview(btn)

        addLabel(to: v, text: "9-Hour Shift • 1-Hour Break Allowed", size: 12, x: cx-150, y: cy-160, w: 300, h: 20, color: NSColor(white: 0.4, alpha: 1))

        w.contentView = v
        return w
    }

    @objc func startProductionClicked() {
        isOverlayShowing = false
        overlayDismissed = true  // Prevent overlay from re-showing
        overlayWindows.forEach { $0.orderOut(nil) }
        overlayWindows.removeAll()
        productionStarted = true
        shiftEnded = false
        shiftStartTime = Date()
        currentActivity = nil; currentActivityStart = nil
        autoBreakTriggered = false
        totals = ["Production":0, "Break":0, "Lunch/Dinner":0, "Meeting":0, "Training":0]
        activityLog = []
        lastActivityTimestamp = Date()
        totalIdleTime = 0; idleAccumulating = false; idleLogged = false; idleStartTime = nil
        RequestQueue.shared.clearQueue()
        RequestQueue.shared.startSyncTimer()
        TrackerState.save(self)
        showTracker()
        switchActivity("Production")
        startTicker()
        startIdleTracking()
    }

    // ═══════════════════════════════════════════════
    //  TRACKER WINDOW
    // ═══════════════════════════════════════════════

    func showTracker() {
        if let existing = trackerWindow {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let screen = NSScreen.main ?? NSScreen.screens[0]
        let w = NSWindow(contentRect: screen.visibleFrame, styleMask: [.titled, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false)
        w.title = "Team Time Tracker"
        w.titlebarAppearsTransparent = true; w.titleVisibility = .hidden
        w.isMovable = true; w.backgroundColor = C.bg
        w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        w.level = .normal // Allow minimize & switching to other apps

        let content = NSView(frame: w.contentView!.bounds)
        content.wantsLayer = true; content.layer?.backgroundColor = C.bg.cgColor
        content.autoresizingMask = [.width, .height]
        let cw = content.bounds.width
        let topY = content.bounds.height - 50

        // ── HEADER ──
        welcomeLabel = addLabel(to: content, text: "Welcome, \(userName)", size: 20, x: 24, y: topY, w: 300, h: 30, bold: true, align: .left)
        addLabel(to: content, text: "9-Hour Shift • 1-Hour Break", size: 12, x: 24, y: topY-20, w: 250, h: 18, color: C.textDim, align: .left)

        shiftElapsedLabel = addLabel(to: content, text: "Elapsed: 00:00:00", size: 13, x: cw-650, y: topY, w: 160, h: 25, color: C.textDim, align: .right)
        shiftElapsedLabel?.autoresizingMask = [.minXMargin]

        shiftRemainingLabel = addLabel(to: content, text: "Remaining: 09:00:00", size: 13, x: cw-480, y: topY, w: 160, h: 25, color: C.green, align: .right)
        shiftRemainingLabel?.autoresizingMask = [.minXMargin]

        idleLabel = addLabel(to: content, text: "Idle: 00:00", size: 13, x: cw-310, y: topY, w: 130, h: 25, color: C.textDim, align: .right)
        idleLabel?.autoresizingMask = [.minXMargin]

        let endBtn = NSButton(frame: NSRect(x: cw-170, y: topY-8, width: 140, height: 30))
        endBtn.title = "End Shift"
        endBtn.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        endBtn.wantsLayer = true; endBtn.layer?.borderColor = C.red.cgColor; endBtn.layer?.borderWidth = 1; endBtn.layer?.cornerRadius = 8
        endBtn.isBordered = false; endBtn.contentTintColor = C.red
        endBtn.target = self; endBtn.action = #selector(endShiftClicked)
        endBtn.autoresizingMask = [.minXMargin]
        content.addSubview(endBtn)

        // ── INACTIVITY BANNER ──
        let bannerY = topY - 50
        inactivityBanner = NSView(frame: NSRect(x: 0, y: bannerY, width: cw, height: 40))
        inactivityBanner?.wantsLayer = true; inactivityBanner?.layer?.backgroundColor = C.red.cgColor
        inactivityBanner?.isHidden = true; inactivityBanner?.autoresizingMask = [.width]
        inactivityBannerLabel = addLabel(to: inactivityBanner!, text: "", size: 13, x: 20, y: 5, w: 500, h: 30, bold: true)
        let resumeBtn = NSButton(frame: NSRect(x: cw-180, y: 5, width: 150, height: 30))
        resumeBtn.title = "Resume Production"
        resumeBtn.font = NSFont.boldSystemFont(ofSize: 12)
        resumeBtn.wantsLayer = true; resumeBtn.layer?.borderColor = NSColor.white.cgColor; resumeBtn.layer?.borderWidth = 1; resumeBtn.layer?.cornerRadius = 6
        resumeBtn.isBordered = false; resumeBtn.contentTintColor = .white
        resumeBtn.target = self; resumeBtn.action = #selector(resumeProduction)
        resumeBtn.autoresizingMask = [.minXMargin]
        inactivityBanner?.addSubview(resumeBtn)
        content.addSubview(inactivityBanner!)

        // ── CURRENT ACTIVITY ──
        let actY = topY - 140
        let actCard = makeCard(in: content, x: 24, y: actY, w: cw-48, h: 100)
        addLabel(to: actCard, text: "CURRENT ACTIVITY", size: 11, x: 0, y: 72, w: cw-48, h: 16, color: C.textDim, align: .center)
        currentActivityLabel = addLabel(to: actCard, text: currentActivity ?? "Production", size: 26, x: 0, y: 40, w: cw-48, h: 35, bold: true, color: colorFor(currentActivity ?? "Production"), align: .center)
        currentTimerLabel = addLabel(to: actCard, text: "00:00:00", size: 42, x: 0, y: -5, w: cw-48, h: 48, color: colorFor(currentActivity ?? "Production"), align: .center)
        currentTimerLabel?.font = NSFont.monospacedDigitSystemFont(ofSize: 42, weight: .light)

        // ── ACTIVITY BUTTONS ──
        let btnY = actY - 80
        let btnW = (cw - 48 - 40) / 5
        for (i, act) in activities.enumerated() {
            let x = 24 + CGFloat(i) * (btnW + 10)
            let btn = NSButton(frame: NSRect(x: x, y: btnY, width: btnW, height: 70))
            btn.title = "\(iconFor(act))\n\(act)"
            btn.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
            btn.wantsLayer = true
            let isActive = (act == currentActivity)
            btn.layer?.backgroundColor = colorFor(act).withAlphaComponent(isActive ? 0.25 : 0.1).cgColor
            btn.layer?.cornerRadius = 12; btn.layer?.borderWidth = 2
            btn.layer?.borderColor = colorFor(act).withAlphaComponent(isActive ? 1.0 : 0.2).cgColor
            btn.isBordered = false; btn.contentTintColor = colorFor(act)
            btn.tag = i; btn.target = self; btn.action = #selector(activityButtonClicked(_:))
            content.addSubview(btn)
            activityButtons[act] = btn

            let timerLbl = addLabel(to: content, text: "00:00:00", size: 10, x: x, y: btnY-18, w: btnW, h: 16, color: C.textDim, align: .center)
            timerLbl.font = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular)
            activityTimerLabels[act] = timerLbl
        }

        // ── BREAK TRACKER ──
        let breakY = btnY - 70
        let breakCard = makeCard(in: content, x: 24, y: breakY, w: cw-48, h: 55)
        addLabel(to: breakCard, text: "Break + Lunch (1 hr allowed)", size: 12, x: 16, y: 30, w: 220, h: 18, color: C.textDim, align: .left)
        breakTimeLabel = addLabel(to: breakCard, text: "00:00 / 60:00", size: 13, x: cw-250, y: 30, w: 180, h: 18, bold: true, color: C.orange, align: .right)
        let barBg = NSView(frame: NSRect(x: 16, y: 10, width: cw-96, height: 6))
        barBg.wantsLayer = true; barBg.layer?.backgroundColor = C.border.cgColor; barBg.layer?.cornerRadius = 3; barBg.autoresizingMask = [.width]
        breakCard.addSubview(barBg); breakBar = barBg
        breakBarFill = NSView(frame: NSRect(x: 0, y: 0, width: 0, height: 6))
        breakBarFill?.wantsLayer = true; breakBarFill?.layer?.backgroundColor = C.orange.cgColor; breakBarFill?.layer?.cornerRadius = 3
        barBg.addSubview(breakBarFill!)
        breakExceededLabel = addLabel(to: breakCard, text: "", size: 11, x: 16, y: -8, w: 300, h: 16, bold: true, color: C.red, align: .left)

        // ── DAILY SUMMARY ──
        let sumY = breakY - 90
        addLabel(to: content, text: "TODAY'S SUMMARY", size: 11, x: 24, y: sumY+60, w: 200, h: 18, color: C.textDim, align: .left)

        // Total Production label
        productionTotalLabel = addLabel(to: content, text: "Total Production: 00:00:00", size: 13, x: cw-300, y: sumY+60, w: 260, h: 18, bold: true, color: C.green, align: .right)
        productionTotalLabel?.autoresizingMask = [.minXMargin]

        let sumW = (cw - 48 - 40) / 5
        for (i, act) in activities.enumerated() {
            let x = 24 + CGFloat(i) * (sumW + 10)
            let card = makeCard(in: content, x: x, y: sumY, w: sumW, h: 55)
            addLabel(to: card, text: act.uppercased(), size: 9, x: 0, y: 35, w: sumW, h: 14, color: C.textDim, align: .center)
            let lbl = addLabel(to: card, text: "00:00:00", size: 18, x: 0, y: 5, w: sumW, h: 28, bold: true, color: colorFor(act), align: .center)
            lbl.font = NSFont.monospacedDigitSystemFont(ofSize: 18, weight: .bold)
            summaryLabels[act] = lbl
        }

        // ── ACTIVITY LOG ──
        let logY: CGFloat = 10
        let logH = sumY - logY - 10
        addLabel(to: content, text: "ACTIVITY LOG", size: 11, x: 24, y: sumY - 20, w: 200, h: 18, color: C.textDim, align: .left)
        let scroll = NSScrollView(frame: NSRect(x: 24, y: logY, width: cw-48, height: logH - 30))
        scroll.hasVerticalScroller = true; scroll.autoresizingMask = [.width, .height]; scroll.drawsBackground = false
        let tv = NSTextView(frame: scroll.bounds)
        tv.isEditable = false; tv.drawsBackground = false; tv.textColor = C.textDim
        tv.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        scroll.documentView = tv
        content.addSubview(scroll)
        logScrollView = scroll

        w.contentView = content
        w.makeKeyAndOrderFront(nil)
        w.toggleFullScreen(nil)
        NSApp.activate(ignoringOtherApps: true)
        NSApp.setActivationPolicy(.regular)
        trackerWindow = w
    }

    // ═══════════════════════════════════════════════
    //  ACTIVITY SWITCHING
    // ═══════════════════════════════════════════════

    @objc func activityButtonClicked(_ sender: NSButton) {
        let act = activities[sender.tag]
        inactivityBanner?.isHidden = true
        switchActivity(act) // autoBreakTriggered is checked INSIDE here first
        resetIdleTimer()
    }

    func switchActivity(_ newActivity: String, isAutoBreak: Bool = false) {
        let now = Date()
        if let cur = currentActivity, let start = currentActivityStart {
            let elapsed = now.timeIntervalSince(start)
            totals[cur, default: 0] += elapsed

            // Determine status for sheet
            let status: String
            if cur == "Break" && autoBreakTriggered {
                status = "Break not marked"
                breakNotMarkedTotal += elapsed
            } else if cur == "Break" {
                status = "Break marked"
            } else {
                status = cur // Production, Meeting, Training, Lunch/Dinner
            }

            let entry = LogEntry(activity: cur, start: start, end: now, duration: elapsed, status: status)
            activityLog.append(entry)
            addLogEntry(entry)
            sendToSheet(entry)
            if let btn = activityButtons[cur] {
                btn.layer?.borderColor = colorFor(cur).withAlphaComponent(0.2).cgColor
                btn.layer?.backgroundColor = colorFor(cur).withAlphaComponent(0.1).cgColor
            }
        }
        currentActivity = newActivity
        currentActivityStart = now
        autoBreakTriggered = isAutoBreak

        if let btn = activityButtons[newActivity] {
            btn.layer?.borderColor = colorFor(newActivity).cgColor
            btn.layer?.backgroundColor = colorFor(newActivity).withAlphaComponent(0.25).cgColor
        }
        currentActivityLabel?.stringValue = newActivity
        currentActivityLabel?.textColor = colorFor(newActivity)
        currentTimerLabel?.textColor = colorFor(newActivity)

        sendLiveUpdate(newActivity)
        TrackerState.save(self)
    }

    // ═══════════════════════════════════════════════
    //  TICKER
    // ═══════════════════════════════════════════════

    func startTicker() {
        ticker?.invalidate()
        ticker = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in self?.tick() }
    }

    func tick() {
        guard let shiftStart = shiftStartTime else { return }
        let now = Date()
        tickCount += 1

        if tickCount % 60 == 0 {
            sendLiveUpdate() // Just queues locally — actual POST on 3-min sync timer
            TrackerState.save(self)
        }

        // Shift elapsed & remaining
        let elapsed = now.timeIntervalSince(shiftStart)
        let remaining = max(0, SHIFT_HOURS - elapsed)
        shiftElapsedLabel?.stringValue = "Elapsed: \(fmt(elapsed))"
        shiftRemainingLabel?.stringValue = "Remaining: \(fmt(remaining))"
        if remaining <= 1800 { shiftRemainingLabel?.textColor = C.orange }
        if remaining <= 600 { shiftRemainingLabel?.textColor = C.red }

        // Current timer
        if let start = currentActivityStart {
            currentTimerLabel?.stringValue = fmt(now.timeIntervalSince(start))
        }

        // Activity totals
        for act in activities {
            var total = totals[act, default: 0]
            if currentActivity == act, let start = currentActivityStart { total += now.timeIntervalSince(start) }
            activityTimerLabels[act]?.stringValue = fmt(total)
            summaryLabels[act]?.stringValue = fmt(total)
        }

        // Total Production = Shift elapsed - Break - Lunch - Meeting - Training
        var nonProdTime: TimeInterval = 0
        for act in ["Break", "Lunch/Dinner", "Meeting", "Training"] {
            var t = totals[act, default: 0]
            if currentActivity == act, let s = currentActivityStart { t += now.timeIntervalSince(s) }
            nonProdTime += t
        }
        let totalProd = max(0, elapsed - nonProdTime)
        productionTotalLabel?.stringValue = "Total Production: \(fmt(totalProd))"

        // Break tracker (Break + Lunch/Dinner combined)
        var breakTotal = totals["Break", default: 0] + totals["Lunch/Dinner", default: 0]
        if currentActivity == "Break", let start = currentActivityStart { breakTotal += now.timeIntervalSince(start) }
        if currentActivity == "Lunch/Dinner", let start = currentActivityStart { breakTotal += now.timeIntervalSince(start) }
        let pct = min(breakTotal / BREAK_ALLOWED, 1.0)
        if let barBg = breakBar, let fill = breakBarFill {
            fill.frame = NSRect(x: 0, y: 0, width: barBg.bounds.width * CGFloat(pct), height: 6)
            fill.layer?.backgroundColor = (breakTotal >= BREAK_ALLOWED ? C.red : C.orange).cgColor
        }
        breakTimeLabel?.stringValue = "\(fmtShort(breakTotal)) / 60:00"
        if breakTotal >= BREAK_ALLOWED {
            breakTimeLabel?.textColor = C.red
            let exceeded = breakTotal - BREAK_ALLOWED
            breakExceededLabel?.stringValue = "BREAK EXCEEDED by \(Int(exceeded/60))m \(Int(exceeded)%60)s!"
        } else {
            breakTimeLabel?.textColor = C.orange
            breakExceededLabel?.stringValue = ""
        }

        checkIdle()
    }

    // ═══════════════════════════════════════════════
    //  INACTIVITY DETECTION
    // ═══════════════════════════════════════════════

    func resetIdleTimer() { lastActivityTimestamp = Date() }

    func startIdleTracking() {
        globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDown, .rightMouseDown, .scrollWheel]) { [weak self] _ in self?.resetIdleTimer() }
        globalKeyMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown]) { [weak self] _ in self?.resetIdleTimer() }
        NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDown, .keyDown, .scrollWheel]) { [weak self] e in self?.resetIdleTimer(); return e }
    }

    func checkIdle() {
        guard productionStarted else { return }
        let sysIdle = getSystemIdleTime()
        idleLabel?.stringValue = "Idle: \(fmtShort(sysIdle))"

        if sysIdle >= LOCK_IDLE_THRESHOLD * 0.8 { idleLabel?.textColor = C.red }
        else if sysIdle >= IDLE_ALERT * 0.8 { idleLabel?.textColor = C.orange }
        else { idleLabel?.textColor = C.textDim }

        // 5-min idle → log "Idle Started" to sheet (once per idle period, NO auto-break)
        // Only track idle when screen is NOT locked — once locked, break-not-marked takes over
        if sysIdle >= IDLE_ALERT && currentActivity == "Production" && !wasScreenLocked {
            // Accumulate idle time (1 second per tick while idle)
            if idleAccumulating {
                totalIdleTime += 1 // tick() calls checkIdle() every 1 second
            } else {
                idleAccumulating = true
                idleStartTime = Date().addingTimeInterval(-sysIdle) // When idle actually began
            }
            // Log "Idle Started" to sheet once per idle period
            if !idleLogged {
                idleLogged = true
                sendIdleStarted()
            }
            // Update idle display in summary
            idleSummaryLabel?.stringValue = fmt(totalIdleTime)
        }

        // Reset idle flags when user comes back (mouse moved)
        if sysIdle < 10 {
            if idleAccumulating && idleLogged {
                // User is back — log "Idle Ended" with full duration
                let idleEnd = Date()
                let idleStart = idleStartTime ?? idleEnd.addingTimeInterval(-totalIdleTime)
                let duration = idleEnd.timeIntervalSince(idleStart)
                sendIdleEnded(start: idleStart, end: idleEnd, duration: duration)
            }
            idleAccumulating = false
            idleLogged = false
            idleStartTime = nil
        }

        // NOTE: Auto-break is ONLY triggered by lock detection (10 min) in checkScreenLock()
    }

    @objc func resumeProduction() {
        inactivityBanner?.isHidden = true
        // NOTE: do NOT reset autoBreakTriggered before switchActivity
        // switchActivity reads it first to log "Break not marked", then resets it
        switchActivity("Production")
        resetIdleTimer()
    }

    func playAlert() { NSSound.beep(); DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSSound.beep() } }

    // ═══════════════════════════════════════════════
    //  END SHIFT
    // ═══════════════════════════════════════════════

    @objc func endShiftClicked() {
        let now = Date()
        if let cur = currentActivity, let start = currentActivityStart {
            let elapsed = now.timeIntervalSince(start)
            totals[cur, default: 0] += elapsed
            let status = (cur == "Break" && autoBreakTriggered) ? "Break not marked" : (cur == "Break" ? "Break marked" : cur)
            let entry = LogEntry(activity: cur, start: start, end: now, duration: elapsed, status: status)
            activityLog.append(entry); addLogEntry(entry); sendToSheet(entry)
        }
        // sendShiftSummary triggers immediate flush (priority sync)
        sendShiftSummary()

        ticker?.invalidate(); ticker = nil
        if let m = globalMouseMonitor { NSEvent.removeMonitor(m) }
        if let m = globalKeyMonitor { NSEvent.removeMonitor(m) }
        globalMouseMonitor = nil; globalKeyMonitor = nil
        productionStarted = false; shiftEnded = true; shiftEndTime = Date()
        shiftStartTime = nil; currentActivity = nil; currentActivityStart = nil
        totalIdleTime = 0; idleAccumulating = false; idleLogged = false; idleStartTime = nil
        trackerWindow?.close(); trackerWindow = nil
        NSApp.setActivationPolicy(.accessory)
        isOverlayShowing = false
        RequestQueue.shared.stopSyncTimer()
        TrackerState.save(self)
    }

    // ═══════════════════════════════════════════════
    //  GOOGLE SHEETS SYNC
    // ═══════════════════════════════════════════════

    func sendToSheet(_ entry: LogEntry) {
        let data: [String: Any] = [
            "name": userName,
            "activity": entry.activity,
            "startTime": timeStr(entry.start),
            "endTime": timeStr(entry.end),
            "durationSeconds": Int(entry.duration),
            "durationFormatted": fmtDur(entry.duration),
            "breakExceeded": (totals["Break", default: 0] + totals["Lunch/Dinner", default: 0]) > BREAK_ALLOWED,
            "triggerType": entry.status,
            "date": dateStr(Date())
        ]
        RequestQueue.shared.enqueueActivityLog(data)
    }

    func sendShiftSummary() {
        let elapsed = shiftStartTime != nil ? Date().timeIntervalSince(shiftStartTime!) : 0
        var nonProd: TimeInterval = 0
        for a in ["Break", "Lunch/Dinner", "Meeting", "Training"] { nonProd += totals[a, default: 0] }
        let data: [String: Any] = [
            "type": "shift_summary",
            "name": userName,
            "date": dateStr(Date()),
            "shiftStart": shiftStartTime != nil ? timeStr(shiftStartTime!) : "",
            "shiftEnd": timeStr(Date()),
            "productionMinutes": Int(max(0, elapsed - nonProd) / 60),
            "breakMinutes": Int(totals["Break", default: 0] / 60),
            "lunchDinnerMinutes": Int(totals["Lunch/Dinner", default: 0] / 60),
            "meetingMinutes": Int(totals["Meeting", default: 0] / 60),
            "trainingMinutes": Int(totals["Training", default: 0] / 60),
            "idleMinutes": Int(totalIdleTime / 60),
            "breakExceeded": (totals["Break", default: 0] + totals["Lunch/Dinner", default: 0]) > BREAK_ALLOWED,
            "breakExceededBy": max(0, Int(((totals["Break", default: 0] + totals["Lunch/Dinner", default: 0]) - BREAK_ALLOWED) / 60)),
            "breakNotMarkedMinutes": Int(breakNotMarkedTotal / 60)
        ]
        // Priority: enqueueShiftSummary triggers immediate flush
        RequestQueue.shared.enqueueShiftSummary(data)
    }

    func sendLiveUpdate(_ event: String? = nil) {
        guard productionStarted else { return }
        let now = Date()
        var ct = totals
        if let cur = currentActivity, let s = currentActivityStart { ct[cur, default: 0] += now.timeIntervalSince(s) }
        let elapsed = shiftStartTime != nil ? now.timeIntervalSince(shiftStartTime!) : 0
        var nonProd: TimeInterval = 0
        for a in ["Break", "Lunch/Dinner", "Meeting", "Training"] { nonProd += ct[a, default: 0] }
        // If no explicit event, show current activity (e.g. "Production", "Break")
        let eventLabel = event ?? (currentActivity ?? "🟢 Online")
        let data: [String: Any] = [
            "type": "live_status",
            "name": userName,
            "date": dateStr(now),
            "timestamp": timeStr(now),
            "event": eventLabel,
            "currentActivity": currentActivity ?? "None",
            "productionMinutes": Int(max(0, elapsed - nonProd) / 60),
            "breakMinutes": Int(ct["Break", default: 0] / 60),
            "lunchDinnerMinutes": Int(ct["Lunch/Dinner", default: 0] / 60),
            "meetingMinutes": Int(ct["Meeting", default: 0] / 60),
            "trainingMinutes": Int(ct["Training", default: 0] / 60),
            "idleMinutes": Int(totalIdleTime / 60),
            "breakExceeded": (ct["Break", default: 0] + ct["Lunch/Dinner", default: 0]) > BREAK_ALLOWED,
            "shiftElapsed": fmt(elapsed),
            "shiftStart": shiftStartTime != nil ? timeStr(shiftStartTime!) : ""
        ]
        // Just enqueue — actual POST happens on 3-min sync timer
        RequestQueue.shared.enqueueLiveStatus(data)
    }

    func sendIdleStarted() {
        guard productionStarted else { return }
        let now = Date()
        let start = idleStartTime ?? now.addingTimeInterval(-IDLE_ALERT)
        let data: [String: Any] = [
            "type": "idle_alert",
            "name": userName,
            "date": dateStr(now),
            "timestamp": dateTimeStr(now),
            "idleStart": dateTimeStr(start),
            "currentActivity": currentActivity ?? "None",
            "idleMinutes": 5,
            "event": "⏸ \(userName) is idle (started at \(timeStr(start)))"
        ]
        RequestQueue.shared.enqueueIdleAlert(data)
    }

    func sendIdleEnded(start: Date, end: Date, duration: TimeInterval) {
        guard productionStarted else { return }
        let mins = Int(duration / 60)
        let data: [String: Any] = [
            "type": "idle_alert",
            "name": userName,
            "date": dateStr(end),
            "timestamp": dateTimeStr(end),
            "idleStart": dateTimeStr(start),
            "idleEnd": dateTimeStr(end),
            "currentActivity": currentActivity ?? "None",
            "idleMinutes": mins,
            "event": "▶ \(userName) was idle for \(mins) mins (\(timeStr(start)) → \(timeStr(end)))"
        ]
        RequestQueue.shared.enqueueIdleAlert(data)
    }

    // ═══════════════════════════════════════════════
    //  LOG TABLE
    // ═══════════════════════════════════════════════

    func addLogEntry(_ entry: LogEntry) {
        guard let scroll = logScrollView, let tv = scroll.documentView as? NSTextView else { return }
        let statusTag = entry.status == "Break not marked" ? " [NOT MARKED]" : ""
        let line = "\(iconFor(entry.activity)) \(entry.activity.padding(toLength: 14, withPad: " ", startingAt: 0)) \(timeStr(entry.start)) → \(timeStr(entry.end))   \(fmtDur(entry.duration))  \(entry.status)\(statusTag)\n"
        let attr = NSAttributedString(string: line, attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular),
            .foregroundColor: entry.status == "Break not marked" ? C.red : C.textMain
        ])
        tv.textStorage?.insert(attr, at: 0)
    }

    // ═══════════════════════════════════════════════
    //  UI HELPERS
    // ═══════════════════════════════════════════════

    @discardableResult
    func addLabel(to parent: NSView, text: String, size: CGFloat, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat, bold: Bool = false, color: NSColor = C.textMain, align: NSTextAlignment = .center) -> NSTextField {
        let lbl = NSTextField(frame: NSRect(x: x, y: y, width: w, height: h))
        lbl.stringValue = text
        lbl.font = bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size)
        lbl.alignment = align; lbl.isBezeled = false; lbl.isEditable = false; lbl.drawsBackground = false
        lbl.textColor = color; lbl.lineBreakMode = .byTruncatingTail
        parent.addSubview(lbl)
        return lbl
    }

    func makeCard(in parent: NSView, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat) -> NSView {
        let card = NSView(frame: NSRect(x: x, y: y, width: w, height: h))
        card.wantsLayer = true; card.layer?.backgroundColor = C.card.cgColor
        card.layer?.cornerRadius = 12; card.layer?.borderWidth = 1; card.layer?.borderColor = C.border.cgColor
        card.autoresizingMask = [.width]; parent.addSubview(card)
        return card
    }
}

// ── LAUNCH ──
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
