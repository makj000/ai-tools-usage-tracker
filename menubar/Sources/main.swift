import AppKit
import Darwin

struct MenubarData: Codable {
    let updatedAt: String?
    let title: String?
    let reportPath: String?
    let primaryLabel: String?
    let secondaryLabel: String?
    let primary: MetricData?
    let secondary: MetricData?
    let window: MetricData?
    let weekly: MetricData?
    let weeklyCycle: WeeklyCycleData?

    struct MetricData: Codable {
        let usage: Double
        let ceiling: Double?
        let pct: Double?
        let usageDisplay: String?
        let ceilingDisplay: String?
        let detail: String?
        let endEpoch: Double?
    }

    struct WeeklyCycleData: Codable {
        let totalDots: Int
        let activeDots: Int
        let resetEpoch: Double?
    }

    var resolvedPrimaryLabel: String { primaryLabel ?? "Window" }
    var resolvedSecondaryLabel: String { secondaryLabel ?? "Week" }
    var resolvedPrimary: MetricData? { primary ?? window }
    var resolvedSecondary: MetricData? { secondary ?? weekly }
}

struct ProviderTheme {
    let tint: NSColor
    let primaryColor: NSColor
    let primaryDangerColor: NSColor
    let secondaryColor: NSColor
    let cycleColor: NSColor
}

final class CombinedBarView: NSView {
    struct ProviderBars {
        let topPct: CGFloat
        let bottomPct: CGFloat
        let cycleActiveDots: Int
        let cycleTotalDots: Int
        let theme: ProviderTheme
    }

    var providers: [ProviderBars] = []

    override func draw(_ dirtyRect: NSRect) {
        let sectionGap: CGFloat = 2
        let providerWidth = max((bounds.width - sectionGap) / 2, 0)
        for (idx, provider) in providers.enumerated() {
            let originX = CGFloat(idx) * (providerWidth + sectionGap)
            drawProvider(x: originX, width: providerWidth, provider: provider)
        }
    }

    private func drawProvider(x: CGFloat, width: CGFloat, provider: ProviderBars) {
        let bgRect = NSRect(x: x, y: 1, width: width, height: bounds.height - 2)
        provider.theme.tint.setFill()
        NSBezierPath(roundedRect: bgRect, xRadius: 4, yRadius: 4).fill()

        let inset: CGFloat = 2
        let barH: CGFloat = 3
        let barGap: CGFloat = 2
        let cycleGap: CGFloat = 1.5
        let dotSize: CGFloat = 2.4
        let hasCycle = provider.cycleTotalDots > 0
        let totalH = hasCycle ? (barH * 2 + barGap + cycleGap + dotSize) : (barH * 2 + barGap)
        let baseY = (bounds.height - totalH) / 2
        let barWidth = max(width - inset * 2, 0)
        let bottomBarY = hasCycle ? (baseY + dotSize + cycleGap) : baseY
        let topBarY = bottomBarY + barH + barGap

        NSColor.tertiaryLabelColor.withAlphaComponent(0.22).setFill()
        fill(x: x + inset, y: topBarY, w: barWidth, h: barH)
        fill(x: x + inset, y: bottomBarY, w: barWidth, h: barH)

        let topColor = provider.topPct >= 0.9 ? provider.theme.primaryDangerColor : provider.theme.primaryColor
        topColor.setFill()
        fill(x: x + inset, y: topBarY, w: barWidth * min(provider.topPct, 1), h: barH)

        provider.theme.secondaryColor.setFill()
        fill(x: x + inset, y: bottomBarY, w: barWidth * min(provider.bottomPct, 1), h: barH)

        if hasCycle {
            NSColor.white.withAlphaComponent(0.96).setFill()
            fill(x: x + inset, y: baseY, w: barWidth, h: dotSize)
            drawCycleDots(
                x: x + inset,
                y: baseY,
                width: barWidth,
                provider: provider,
                dotSize: dotSize
            )
        }
    }

    private func fill(x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat) {
        guard w > 0 else { return }
        NSBezierPath(roundedRect: NSRect(x: x, y: y, width: w, height: h), xRadius: 1.5, yRadius: 1.5).fill()
    }

    private func drawCycleDots(x: CGFloat, y: CGFloat, width: CGFloat, provider: ProviderBars, dotSize: CGFloat) {
        let totalDots = max(provider.cycleTotalDots, 0)
        guard totalDots > 0 else { return }

        let activeDots = min(max(provider.cycleActiveDots, 0), totalDots)
        let spacing = totalDots > 1 ? (width - dotSize) / CGFloat(totalDots - 1) : 0

        for idx in 0..<totalDots {
            let dotRect = NSRect(x: x + CGFloat(idx) * spacing, y: y, width: dotSize, height: dotSize)
            let color = idx < activeDots
                ? NSColor.black.withAlphaComponent(0.92)
                : NSColor.black.withAlphaComponent(0.22)
            color.setFill()
            NSBezierPath(ovalIn: dotRect).fill()
        }
    }
}

final class ProviderStatusController {
    let dataURL: URL
    let fallbackBuildCommand: String
    let theme: ProviderTheme

    private let openTitle: String
    private var primaryMenuItem: NSMenuItem!
    private var secondaryMenuItem: NSMenuItem!
    private var resetMenuItem: NSMenuItem!
    private var openMenuItem: NSMenuItem!
    private var lastReportPath: String?
    private var currentData: MenubarData?

    init(dataURL: URL, openTitle: String, fallbackBuildCommand: String, theme: ProviderTheme) {
        self.dataURL = dataURL
        self.openTitle = openTitle
        self.fallbackBuildCommand = fallbackBuildCommand
        self.theme = theme
    }

    func install(into menu: NSMenu, target: AppDelegate) {
        let titleItem = NSMenuItem(title: openTitle.replacingOccurrences(of: "Open ", with: "").replacingOccurrences(of: " Dashboard", with: ""), action: nil, keyEquivalent: "")
        titleItem.isEnabled = false
        menu.addItem(titleItem)

        primaryMenuItem = NSMenuItem(title: "—", action: nil, keyEquivalent: "")
        primaryMenuItem.isEnabled = false
        menu.addItem(primaryMenuItem)

        secondaryMenuItem = NSMenuItem(title: "—", action: nil, keyEquivalent: "")
        secondaryMenuItem.isEnabled = false
        menu.addItem(secondaryMenuItem)

        resetMenuItem = NSMenuItem(title: "—", action: nil, keyEquivalent: "")
        resetMenuItem.isEnabled = false
        menu.addItem(resetMenuItem)

        openMenuItem = NSMenuItem(title: openTitle, action: #selector(AppDelegate.openDashboardFromMenuItem(_:)), keyEquivalent: "")
        openMenuItem.target = target
        openMenuItem.representedObject = self
        menu.addItem(openMenuItem)

        menu.addItem(.separator())
    }

    func openDashboard() {
        guard let reportPath = lastReportPath else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: reportPath))
    }

    func refresh() {
        guard let jsonData = try? Data(contentsOf: dataURL),
              let data = try? JSONDecoder().decode(MenubarData.self, from: jsonData) else {
            currentData = nil
            primaryMenuItem.title = "No data (run \(fallbackBuildCommand))"
            secondaryMenuItem.title = "Waiting for metrics"
            resetMenuItem.title = "Week reset: unavailable"
            openMenuItem.isEnabled = false
            return
        }
        currentData = data
        lastReportPath = data.reportPath
        openMenuItem.isEnabled = lastReportPath != nil
        updateDisplay(data: data)
    }

    func barState() -> CombinedBarView.ProviderBars {
        let primaryPct = CGFloat(currentData?.resolvedPrimary?.pct ?? 0)
        let secondaryPct = CGFloat(currentData?.resolvedSecondary?.pct ?? 0)
        let cycleTotalDots = currentData?.weeklyCycle?.totalDots ?? 0
        let cycleActiveDots = currentData?.weeklyCycle?.activeDots ?? 0
        return CombinedBarView.ProviderBars(
            topPct: primaryPct,
            bottomPct: secondaryPct,
            cycleActiveDots: cycleActiveDots,
            cycleTotalDots: cycleTotalDots,
            theme: theme
        )
    }

    private func updateDisplay(data: MenubarData) {
        let primaryLabel = data.resolvedPrimaryLabel
        let secondaryLabel = data.resolvedSecondaryLabel

        if let metric = data.resolvedPrimary, let pct = metric.pct {
            primaryMenuItem.title = formatMetric(label: primaryLabel, metric: metric, pct: pct)
        } else {
            primaryMenuItem.title = "\(primaryLabel): no data yet"
        }

        if let metric = data.resolvedSecondary, let pct = metric.pct {
            secondaryMenuItem.title = formatMetric(label: secondaryLabel, metric: metric, pct: pct)
        } else {
            secondaryMenuItem.title = "\(secondaryLabel): no data yet"
        }

        resetMenuItem.title = formatReset(cycle: data.weeklyCycle)
    }

    private func formatMetric(label: String, metric: MenubarData.MetricData, pct: Double) -> String {
        let pctInt = Int((pct * 100).rounded())
        let usage = metric.usageDisplay ?? String(format: "%.2f", metric.usage)
        if let detail = metric.detail, !detail.isEmpty {
            if let ceiling = metric.ceilingDisplay {
                return "\(label): \(pctInt)%  (\(usage) / \(ceiling), \(detail))"
            }
            return "\(label): \(pctInt)%  (\(usage), \(detail))"
        }
        if let ceiling = metric.ceilingDisplay {
            return "\(label): \(pctInt)%  (\(usage) / \(ceiling))"
        }
        return "\(label): \(pctInt)%  (\(usage))"
    }

    private func formatReset(cycle: MenubarData.WeeklyCycleData?) -> String {
        guard let resetEpoch = cycle?.resetEpoch else {
            return "Week reset: unavailable"
        }
        let date = Date(timeIntervalSince1970: resetEpoch)
        let formatter = DateFormatter()
        formatter.timeZone = TimeZone(identifier: "America/Los_Angeles")
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "EEE MMM d, h:mm a z"
        return "Week resets: \(formatter.string(from: date))"
    }
}

final class SingleInstanceGuard {
    private let fd: Int32

    init?(lockPath: String) {
        fd = open(lockPath, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        if fd == -1 { return nil }
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            close(fd)
            return nil
        }
    }

    deinit {
        flock(fd, LOCK_UN)
        close(fd)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var barView: CombinedBarView!
    private var controllers: [ProviderStatusController] = []
    private var refreshTimer: Timer?

    private static let claudeDataURL = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent(".claude/claude-tracker-menubar.json")
    private static let codexDataURL = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent(".codex/codex-tracker-menubar.json")

    func applicationDidFinishLaunching(_ notification: Notification) {
        controllers = [
            ProviderStatusController(
                dataURL: Self.claudeDataURL,
                openTitle: "Open Claude Dashboard",
                fallbackBuildCommand: "npm run build:claude",
                theme: ProviderTheme(
                    tint: NSColor.systemOrange.withAlphaComponent(0.16),
                    primaryColor: .systemOrange,
                    primaryDangerColor: .systemRed,
                    secondaryColor: .systemGreen,
                    cycleColor: .black
                )
            ),
            ProviderStatusController(
                dataURL: Self.codexDataURL,
                openTitle: "Open Codex Dashboard",
                fallbackBuildCommand: "npm run build:codex",
                theme: ProviderTheme(
                    tint: NSColor.systemBlue.withAlphaComponent(0.16),
                    primaryColor: .systemBlue,
                    primaryDangerColor: .systemRed,
                    secondaryColor: .systemTeal,
                    cycleColor: .black
                )
            )
        ]

        buildMenu()
        refreshAll()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.refreshAll()
        }
    }

    private func buildMenu() {
        let barW: CGFloat = 40
        statusItem = NSStatusBar.system.statusItem(withLength: barW + 4)

        if let btn = statusItem.button {
            btn.title = ""
            barView = CombinedBarView(frame: NSRect(x: 2, y: 0, width: barW, height: NSStatusBar.system.thickness))
            barView.autoresizingMask = .height
            btn.addSubview(barView)
        }

        let menu = NSMenu()
        for controller in controllers {
            controller.install(into: menu, target: self)
        }

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

    private func refreshAll() {
        controllers.forEach { $0.refresh() }
        barView.providers = controllers.map { $0.barState() }
        barView.needsDisplay = true
    }

    @objc private func refreshNow() {
        refreshAll()
    }

    @objc private func restartApp() {
        let exe = URL(fileURLWithPath: CommandLine.arguments[0])
        let task = Process()
        task.executableURL = exe
        task.arguments = []
        try? task.run()
        NSApp.terminate(nil)
    }

    @objc func openDashboardFromMenuItem(_ sender: NSMenuItem) {
        guard let controller = sender.representedObject as? ProviderStatusController else { return }
        controller.openDashboard()
    }
}

let lockPath = (NSHomeDirectory() as NSString).appendingPathComponent(".agentic-tool-usage-tracker-menubar.lock")
guard let _ = SingleInstanceGuard(lockPath: lockPath) else {
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
