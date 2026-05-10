import AppKit

// MARK: - Data model

struct MenubarData: Codable {
    let updatedAt: String?
    let reportPath: String?
    let window: WindowData?
    let weekly: PeriodData?

    struct WindowData: Codable {
        let usage: Double
        let ceiling: Double?
        let pct: Double?
        let endEpoch: Double?
    }

    struct PeriodData: Codable {
        let usage: Double
        let ceiling: Double?
        let pct: Double?
    }
}

// MARK: - Bar view

final class BarView: NSView {
    var windowPct: CGFloat = 0
    var weekPct: CGFloat = 0

    override func draw(_ dirtyRect: NSRect) {
        let barH: CGFloat = 5
        let gap: CGFloat  = 3
        let totalH = barH * 2 + gap
        let baseY  = (bounds.height - totalH) / 2

        // Background tracks
        NSColor.tertiaryLabelColor.withAlphaComponent(0.25).setFill()
        fill(x: 0, y: baseY + barH + gap, w: bounds.width, h: barH)
        fill(x: 0, y: baseY,              w: bounds.width, h: barH)

        // Window bar — orange, red when ≥ 90 %
        let winColor: NSColor = windowPct >= 0.9 ? .systemRed : .systemOrange
        winColor.setFill()
        fill(x: 0, y: baseY + barH + gap, w: bounds.width * min(windowPct, 1), h: barH)

        // Week bar — green
        NSColor.systemGreen.setFill()
        fill(x: 0, y: baseY, w: bounds.width * min(weekPct, 1), h: barH)
    }

    private func fill(x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat) {
        guard w > 0 else { return }
        NSBezierPath(roundedRect: NSRect(x: x, y: y, width: w, height: h),
                     xRadius: 2.5, yRadius: 2.5).fill()
    }
}

// MARK: - AppDelegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var barView: BarView!
    private var windowMenuItem: NSMenuItem!
    private var weekMenuItem: NSMenuItem!
    private var lastReportPath: String?
    private var refreshTimer: Timer?

    private static let dataURL = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent(".claude/claude-tracker-menubar.json")

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        refresh()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    private func buildMenu() {
        let barW: CGFloat = 18
        statusItem = NSStatusBar.system.statusItem(withLength: barW + 4)

        if let btn = statusItem.button {
            btn.title = ""
            barView = BarView(frame: NSRect(x: 2, y: 0, width: barW,
                                            height: NSStatusBar.system.thickness))
            barView.autoresizingMask = .height
            btn.addSubview(barView)
        }

        let menu = NSMenu()

        windowMenuItem = NSMenuItem(title: "Window: —", action: nil, keyEquivalent: "")
        windowMenuItem.isEnabled = false
        menu.addItem(windowMenuItem)

        weekMenuItem = NSMenuItem(title: "Week:   —", action: nil, keyEquivalent: "")
        weekMenuItem.isEnabled = false
        menu.addItem(weekMenuItem)

        menu.addItem(.separator())

        let openItem = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "o")
        openItem.target = self
        menu.addItem(openItem)

        let refreshItem = NSMenuItem(title: "Refresh Now", action: #selector(refreshNow), keyEquivalent: "r")
        refreshItem.target = self
        menu.addItem(refreshItem)

        let restartItem = NSMenuItem(title: "Restart", action: #selector(restartApp), keyEquivalent: "")
        restartItem.target = self
        menu.addItem(restartItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    @objc private func openDashboard() {
        guard let reportPath = lastReportPath else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: reportPath))
    }

    @objc private func refreshNow() { refresh() }

    @objc private func restartApp() {
        let exe = URL(fileURLWithPath: CommandLine.arguments[0])
        let task = Process()
        task.executableURL = exe
        task.arguments = []
        try? task.run()
        NSApp.terminate(nil)
    }

    private func refresh() {
        guard let jsonData = try? Data(contentsOf: Self.dataURL),
              let data = try? JSONDecoder().decode(MenubarData.self, from: jsonData) else {
            barView.windowPct = 0
            barView.weekPct   = 0
            barView.needsDisplay = true
            windowMenuItem.title = "Window: no data (run npm run build)"
            weekMenuItem.title   = "Week:   no data"
            return
        }
        lastReportPath = data.reportPath
        updateDisplay(data: data)
    }

    private func updateDisplay(data: MenubarData) {
        if let win = data.window, let pct = win.pct {
            barView.windowPct = CGFloat(pct)
            let pctInt    = Int((pct * 100).rounded())
            let usageStr  = String(format: "$%.2f", win.usage)
            if let ceiling = win.ceiling {
                windowMenuItem.title = String(format: "Window: %d%%  (%@ / $%.2f)", pctInt, usageStr, ceiling)
            } else {
                windowMenuItem.title = "Window: \(pctInt)%  (\(usageStr))"
            }
        } else {
            barView.windowPct    = 0
            windowMenuItem.title = "Window: no rate-limit data yet"
        }

        if let wk = data.weekly, let pct = wk.pct {
            barView.weekPct = CGFloat(pct)
            let pctInt   = Int((pct * 100).rounded())
            let usageStr = String(format: "$%.2f", wk.usage)
            if let ceiling = wk.ceiling {
                weekMenuItem.title = String(format: "Week:   %d%%  (%@ / $%.2f)", pctInt, usageStr, ceiling)
            } else {
                weekMenuItem.title = "Week:   \(pctInt)%  (\(usageStr))"
            }
        } else {
            barView.weekPct    = 0
            weekMenuItem.title = "Week:   no rate-limit data yet"
        }

        barView.needsDisplay = true
    }
}

// MARK: - Entry point

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
