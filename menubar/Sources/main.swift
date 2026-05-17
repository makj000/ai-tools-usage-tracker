import AppKit
import Darwin

struct AppVersion {
    static let current = load()

    private static func load() -> String {
        let executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        let repoRootURL = executableURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let packageURL = repoRootURL.appendingPathComponent("package.json")
        guard let data = try? Data(contentsOf: packageURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = json["version"] as? String,
              !version.isEmpty
        else {
            return "unknown"
        }
        return version
    }
}

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
    let extraSpent: Double?
    let extraPurchased: Double?

    struct MetricData: Codable {
        let usage: Double
        let ceiling: Double?
        let pct: Double?
        let usageDisplay: String?
        let ceilingDisplay: String?
        let detail: String?
        let startEpoch: Double?
        let endEpoch: Double?
        let isRemaining: Bool?
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

struct StatuslineRateLimitCache: Codable {
    let rateLimits: RateLimitsData?

    struct RateLimitsData: Codable {
        let sevenDay: LimitData?

        enum CodingKeys: String, CodingKey {
            case sevenDay = "seven_day"
        }
    }

    struct LimitData: Codable {
        let resetsAt: Double?

        enum CodingKeys: String, CodingKey {
            case resetsAt = "resets_at"
        }
    }
}

struct ProviderTheme {
    let tint: NSColor
}

private let weeklyCycleSeconds: Double = 7 * 24 * 60 * 60

final class CombinedBarView: NSView {
    static let windowTimeSegments: Int = 15

    struct ProviderBars {
        let topPct: CGFloat
        let bottomPct: CGFloat
        let topIsRemaining: Bool
        let windowTimePct: CGFloat?
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
        let timeRowH: CGFloat = 3.0
        let timeRowGap: CGFloat = 1.0
        let hasCycle = provider.cycleTotalDots > 0
        let hasTimeRow = provider.windowTimePct != nil
        var totalH = barH * 2 + barGap
        if hasCycle { totalH += cycleGap + dotSize }
        if hasTimeRow { totalH += timeRowGap + timeRowH }
        let baseY = (bounds.height - totalH) / 2
        let barWidth = max(width - inset * 2, 0)
        let bottomBarY = hasCycle ? (baseY + dotSize + cycleGap) : baseY
        let timeRowY = hasTimeRow ? (bottomBarY + barH + barGap) : bottomBarY
        let topBarY = hasTimeRow ? (timeRowY + timeRowH + timeRowGap) : (bottomBarY + barH + barGap)

        NSColor.white.withAlphaComponent(0.96).setFill()
        fill(x: x + inset, y: topBarY, w: barWidth, h: barH)
        fill(x: x + inset, y: bottomBarY, w: barWidth, h: barH)

        NSColor.black.withAlphaComponent(0.92).setFill()
        fill(x: x + inset, y: topBarY, w: barWidth * min(provider.topPct, 1), h: barH)

        NSColor.black.withAlphaComponent(0.92).setFill()
        fill(x: x + inset, y: bottomBarY, w: barWidth * min(provider.bottomPct, 1), h: barH)

        if hasTimeRow, let pct = provider.windowTimePct {
            NSColor.white.withAlphaComponent(0.96).setFill()
            fill(x: x + inset, y: timeRowY, w: barWidth, h: timeRowH)
            drawTimeSquares(
                x: x + inset,
                y: timeRowY,
                width: barWidth,
                height: timeRowH,
                pct: pct
            )
        }

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

    private func drawTimeSquares(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, pct: CGFloat) {
        let total = Self.windowTimeSegments
        guard total > 0, width > 0 else { return }
        let segWidth = max(width / CGFloat(total) - 0.3, 0.8)
        let spacing = total > 1 ? (width - segWidth) / CGFloat(total - 1) : 0
        let filledCount = max(0, min(total, Int((pct * CGFloat(total)).rounded(.toNearestOrEven))))
        for idx in 0..<total {
            let rect = NSRect(x: x + CGFloat(idx) * spacing, y: y, width: segWidth, height: height)
            let color = idx < filledCount
                ? NSColor.black.withAlphaComponent(0.92)
                : NSColor.black.withAlphaComponent(0.4)
            color.setFill()
            NSBezierPath(rect: rect).fill()
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
    let weeklyResetCacheURL: URL?
    let fallbackBuildCommand: String
    let theme: ProviderTheme
    let usagePageURL: URL?
    let apiCreditURL: URL?

    private let openTitle: String
    private let sectionTitle: String
    private var primaryMenuItem: NSMenuItem!
    private var secondaryMenuItem: NSMenuItem!
    private var openUsageMenuItem: NSMenuItem!
    private var extraCreditMenuItem: NSMenuItem?
    private var apiCreditMenuItem: NSMenuItem?
    private var openMenuItem: NSMenuItem!
    private var lastReportPath: String?
    private var currentData: MenubarData?

    init(dataURL: URL, weeklyResetCacheURL: URL? = nil, openTitle: String, sectionTitle: String, fallbackBuildCommand: String, theme: ProviderTheme, usagePageURL: URL? = nil, apiCreditURL: URL? = nil) {
        self.dataURL = dataURL
        self.weeklyResetCacheURL = weeklyResetCacheURL
        self.openTitle = openTitle
        self.sectionTitle = sectionTitle
        self.fallbackBuildCommand = fallbackBuildCommand
        self.theme = theme
        self.usagePageURL = usagePageURL
        self.apiCreditURL = apiCreditURL
    }

    func install(into menu: NSMenu, target: AppDelegate) {
        menu.addItem(makeSectionHeaderItem(title: sectionTitle))

        primaryMenuItem = NSMenuItem(title: "—", action: nil, keyEquivalent: "")
        primaryMenuItem.isEnabled = false
        menu.addItem(primaryMenuItem)

        secondaryMenuItem = NSMenuItem(title: "—", action: nil, keyEquivalent: "")
        secondaryMenuItem.isEnabled = false
        menu.addItem(secondaryMenuItem)

        openMenuItem = NSMenuItem(title: openTitle, action: #selector(AppDelegate.openDashboardFromMenuItem(_:)), keyEquivalent: "")
        openMenuItem.target = target
        openMenuItem.representedObject = self
        menu.addItem(openMenuItem)

        openUsageMenuItem = NSMenuItem(title: "Open Official Usage Page", action: #selector(AppDelegate.openUsagePageFromMenuItem(_:)), keyEquivalent: "")
        openUsageMenuItem.target = target
        openUsageMenuItem.representedObject = self
        openUsageMenuItem.isEnabled = usagePageURL != nil
        menu.addItem(openUsageMenuItem)

        let ecItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        ecItem.isEnabled = false
        ecItem.isHidden = true
        extraCreditMenuItem = ecItem
        menu.addItem(ecItem)

        if apiCreditURL != nil {
            let item = NSMenuItem(title: "API Credit", action: #selector(AppDelegate.openApiCreditFromMenuItem(_:)), keyEquivalent: "")
            item.target = target
            item.representedObject = self
            apiCreditMenuItem = item
            menu.addItem(item)
        }

        menu.addItem(.separator())
    }

    private func makeSectionHeaderItem(title: String) -> NSMenuItem {
        let item = NSMenuItem()
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 260, height: 20))
        let label = NSTextField(labelWithString: title)
        label.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        label.textColor = NSColor.labelColor
        label.frame = NSRect(x: 14, y: 4, width: 230, height: 14)
        container.addSubview(label)
        item.view = container
        return item
    }

    func openDashboard() {
        guard let reportPath = lastReportPath else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: reportPath))
    }

    func openUsagePage() {
        guard let usagePageURL else { return }
        NSWorkspace.shared.open(usagePageURL)
    }

    func openApiCredit() {
        guard let apiCreditURL else { return }
        NSWorkspace.shared.open(apiCreditURL)
    }

    func refresh() {
        guard let jsonData = try? Data(contentsOf: dataURL),
              let data = try? JSONDecoder().decode(MenubarData.self, from: jsonData) else {
            currentData = nil
            primaryMenuItem.title = "No data (run \(fallbackBuildCommand))"
            secondaryMenuItem.title = "Waiting for metrics"
            openMenuItem.isEnabled = false
            return
        }
        currentData = data
        lastReportPath = data.reportPath
        openMenuItem.isEnabled = lastReportPath != nil
        updateDisplay(data: data)
    }

    func barState() -> CombinedBarView.ProviderBars {
        let primary = currentData?.resolvedPrimary
        let primaryPct = CGFloat(displayBarPct(for: primary) ?? 0)
        let secondaryPct = CGFloat(displayBarPct(for: currentData?.resolvedSecondary) ?? 0)
        let cycle = resolvedWeeklyCycle()
        let cycleTotalDots = cycle?.totalDots ?? 0
        let cycleActiveDots = cycle?.activeDots ?? 0
        return CombinedBarView.ProviderBars(
            topPct: primaryPct,
            bottomPct: secondaryPct,
            topIsRemaining: primary?.isRemaining ?? false,
            windowTimePct: windowTimePct(for: primary),
            cycleActiveDots: cycleActiveDots,
            cycleTotalDots: cycleTotalDots,
            theme: theme
        )
    }

    private func windowTimePct(for metric: MenubarData.MetricData?) -> CGFloat? {
        guard let metric, let start = metric.startEpoch, let end = metric.endEpoch, end > start else {
            return nil
        }
        let now = Date().timeIntervalSince1970
        let pct = (now - start) / (end - start)
        return CGFloat(max(0, min(1, pct)))
    }

    private func displayBarPct(for metric: MenubarData.MetricData?) -> Double? {
        guard let metric, let pct = metric.pct else { return nil }
        if metric.isRemaining == true {
            return max(0, min(1, 1 - pct))
        }
        return pct
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

        if let spent = data.extraSpent {
            if let purchased = data.extraPurchased {
                let balance = max(0, purchased - spent)
                extraCreditMenuItem?.title = "    Extra credit: $\(String(format: "%.2f", balance)) left of $\(String(format: "%.2f", purchased))"
            } else {
                extraCreditMenuItem?.title = "    Extra credit: $\(String(format: "%.2f", spent)) spent"
            }
            extraCreditMenuItem?.isHidden = false
        } else {
            extraCreditMenuItem?.isHidden = true
        }
    }

    private func formatEpochAsResets(_ epoch: Double) -> String {
        let date = Date(timeIntervalSince1970: epoch)
        let formatter = DateFormatter()
        formatter.timeZone = TimeZone(identifier: "America/Los_Angeles") ?? .current
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MMM d, h:mm a zzz"
        return "resets \(formatter.string(from: date))"
    }

    private func formatMetric(label: String, metric: MenubarData.MetricData, pct: Double) -> String {
        let pctInt = Int((pct * 100).rounded())
        let usage = metric.usageDisplay ?? String(format: "%.2f", metric.usage)
        let now = Date().timeIntervalSince1970
        let resolvedDetail: String?
        if let d = metric.detail, !d.isEmpty,
           metric.endEpoch == nil || (metric.endEpoch ?? 0) > now {
            resolvedDetail = d
        } else if let end = metric.endEpoch, end > now {
            resolvedDetail = formatEpochAsResets(end)
        } else {
            resolvedDetail = nil
        }
        if let detail = resolvedDetail {
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

    private func resolvedWeeklyCycle() -> MenubarData.WeeklyCycleData? {
        if let cycle = currentData?.weeklyCycle {
            return normalizedWeeklyCycle(cycle)
        }
        guard let resetEpoch = readFallbackResetEpoch() else { return nil }
        return buildWeeklyCycle(resetEpoch: resetEpoch)
    }

    private func normalizedWeeklyCycle(_ cycle: MenubarData.WeeklyCycleData) -> MenubarData.WeeklyCycleData? {
        guard let resetEpoch = cycle.resetEpoch else { return cycle }
        let now = Date().timeIntervalSince1970
        if resetEpoch > now {
            return cycle
        }

        let windowsElapsed = floor((now - resetEpoch) / weeklyCycleSeconds) + 1
        let normalizedResetEpoch = resetEpoch + windowsElapsed * weeklyCycleSeconds
        return buildWeeklyCycle(resetEpoch: normalizedResetEpoch)
    }

    private func readFallbackResetEpoch() -> Double? {
        guard let url = weeklyResetCacheURL,
              let jsonData = try? Data(contentsOf: url),
              let cache = try? JSONDecoder().decode(StatuslineRateLimitCache.self, from: jsonData)
        else {
            return nil
        }
        return cache.rateLimits?.sevenDay?.resetsAt
    }

    private func buildWeeklyCycle(resetEpoch: Double) -> MenubarData.WeeklyCycleData? {
        let resetDate = Date(timeIntervalSince1970: resetEpoch)
        guard let timeZone = TimeZone(identifier: "America/Los_Angeles") else { return nil }
        let resetDateStr = laDateString(for: resetDate, timeZone: timeZone)
        let includesResetDate = !isMidnight(date: resetDate, timeZone: timeZone)
        let cycleEndDateStr = includesResetDate ? resetDateStr : shiftDateString(resetDateStr, by: -1)
        let cycleStartDateStr = shiftDateString(cycleEndDateStr, by: -6)
        let todayDateStr = laDateString(for: Date(), timeZone: timeZone)
        let activeDots = min(7, max(1, dayDiff(from: cycleStartDateStr, to: todayDateStr) + 1))
        return MenubarData.WeeklyCycleData(totalDots: 7, activeDots: activeDots, resetEpoch: resetEpoch)
    }

    private func laDateString(for date: Date, timeZone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.timeZone = timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private func isMidnight(date: Date, timeZone: TimeZone) -> Bool {
        let calendar = Calendar(identifier: .gregorian)
        var localCalendar = calendar
        localCalendar.timeZone = timeZone
        let components = localCalendar.dateComponents([.hour, .minute, .second], from: date)
        return components.hour == 0 && components.minute == 0 && components.second == 0
    }

    private func shiftDateString(_ dateStr: String, by days: Int) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        guard let date = formatter.date(from: dateStr),
              let shifted = Calendar(identifier: .gregorian).date(byAdding: .day, value: days, to: date)
        else {
            return dateStr
        }
        return formatter.string(from: shifted)
    }

    private func dayDiff(from start: String, to end: String) -> Int {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        guard let startDate = formatter.date(from: start),
              let endDate = formatter.date(from: end)
        else {
            return 0
        }
        return Calendar(identifier: .gregorian).dateComponents([.day], from: startDate, to: endDate).day ?? 0
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
    private var barRedrawTimer: Timer?
    private let buildQueue = DispatchQueue(label: "agentic-tool-usage-tracker.codex-build")
    private var codexBuildInFlight = false

    private static let repoRootURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    private static let claudeDataURL = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent(".claude/claude-tracker-menubar.json")
    private static let claudeRateLimitCacheURL = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent(".claude/statusline-rate-limits.json")
    private static let codexDataURL = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent(".codex/codex-tracker-menubar.json")
    private static let codexBuildScriptURL = repoRootURL.appendingPathComponent("codex/scripts/build.js")
    private static let nodePathCandidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
    ]

    func applicationWillTerminate(_ notification: Notification) {
        if let item = statusItem {
            NSStatusBar.system.removeStatusItem(item)
            statusItem = nil
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        controllers = [
            ProviderStatusController(
                dataURL: Self.claudeDataURL,
                weeklyResetCacheURL: Self.claudeRateLimitCacheURL,
                openTitle: "Open Claude Dashboard",
                sectionTitle: "Claude",
                fallbackBuildCommand: "npm run build:claude",
                theme: ProviderTheme(
                    tint: NSColor.systemOrange.withAlphaComponent(0.74)
                ),
                usagePageURL: URL(string: "https://claude.ai/settings/usage"),
                apiCreditURL: URL(string: "https://platform.claude.com/dashboard")
            ),
            ProviderStatusController(
                dataURL: Self.codexDataURL,
                openTitle: "Open Codex Dashboard",
                sectionTitle: "Codex",
                fallbackBuildCommand: "npm run build:codex",
                theme: ProviderTheme(
                    tint: NSColor.systemBlue.withAlphaComponent(0.72)
                ),
                usagePageURL: URL(string: "https://chatgpt.com/codex/settings/usage"),
                apiCreditURL: URL(string: "https://platform.openai.com/home")
            )
        ]

        buildMenu()
        refreshAll()
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.refreshAll()
        }
        barRedrawTimer?.invalidate()
        barRedrawTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            self?.barView.needsDisplay = true
        }
    }

    private func buildMenu() {
        if let existingStatusItem = statusItem {
            NSStatusBar.system.removeStatusItem(existingStatusItem)
            statusItem = nil
        }

        let barW: CGFloat = 60
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

        let versionItem = NSMenuItem(title: "Version: \(AppVersion.current)", action: nil, keyEquivalent: "")
        versionItem.isEnabled = false
        menu.addItem(versionItem)

        menu.addItem(.separator())

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
        refreshFromDataFiles()
        refreshCodexMenubarData()
    }

    private func refreshFromDataFiles() {
        controllers.forEach { $0.refresh() }
        barView.providers = controllers.map { $0.barState() }
        barView.needsDisplay = true
    }

    private func refreshCodexMenubarData() {
        guard !codexBuildInFlight else { return }
        guard FileManager.default.fileExists(atPath: Self.codexBuildScriptURL.path) else { return }
        codexBuildInFlight = true
        buildQueue.async { [weak self] in
            self?.runCodexMenubarBuild()
            DispatchQueue.main.async { [weak self] in
                self?.codexBuildInFlight = false
                self?.refreshFromDataFiles()
            }
        }
    }

    private func runCodexMenubarBuild() {
        let invocation = codexNodeInvocation()
        let task = Process()
        task.executableURL = invocation.executableURL
        task.arguments = invocation.arguments
        task.currentDirectoryURL = Self.repoRootURL
        if let output = FileHandle(forWritingAtPath: "/dev/null") {
            task.standardOutput = output
        }
        if let error = FileHandle(forWritingAtPath: "/dev/null") {
            task.standardError = error
        }
        do {
            try task.run()
            task.waitUntilExit()
        } catch {}
    }

    private func codexNodeInvocation() -> (executableURL: URL, arguments: [String]) {
        for path in Self.nodePathCandidates where FileManager.default.isExecutableFile(atPath: path) {
            return (URL(fileURLWithPath: path), [Self.codexBuildScriptURL.path, "--menubar-only"])
        }
        return (URL(fileURLWithPath: "/usr/bin/env"), ["node", Self.codexBuildScriptURL.path, "--menubar-only"])
    }

    @objc private func refreshNow() {
        refreshAll()
    }

    @objc private func restartApp() {
        // launchd (KeepAlive: true) restarts the process automatically after termination
        NSApp.terminate(nil)
    }

    @objc func openDashboardFromMenuItem(_ sender: NSMenuItem) {
        guard let controller = sender.representedObject as? ProviderStatusController else { return }
        controller.openDashboard()
    }

    @objc func openUsagePageFromMenuItem(_ sender: NSMenuItem) {
        guard let controller = sender.representedObject as? ProviderStatusController else { return }
        controller.openUsagePage()
    }

    @objc func openApiCreditFromMenuItem(_ sender: NSMenuItem) {
        guard let controller = sender.representedObject as? ProviderStatusController else { return }
        controller.openApiCredit()
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
