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
    let tertiaryLabel: String?
    let primary: MetricData?
    let secondary: MetricData?
    let tertiary: MetricData?
    let window: MetricData?
    let weekly: MetricData?
    let fableWeekly: MetricData?
    let weeklyCycle: WeeklyCycleData?
    let weeklySpark: WeeklySparkData?
    let extraSpent: Double?
    let extraPurchased: Double?
    let usageCreditsBalance: Double?
    let usageCreditsUrl: String?
    let reconciliationUrl: String?
    let modelAlert: ModelAlertData?

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
        let resetDetected: Bool?
    }

    struct WeeklyCycleData: Codable {
        let totalDots: Int
        let activeDots: Int
        let resetEpoch: Double?
    }

    struct WeeklySparkData: Codable {
        let windowStartEpoch: Double?
        let windowEndEpoch: Double?
        let hourly: [HourlyBucket]?
        let maxedHours: [Double]?

        struct HourlyBucket: Codable {
            let epoch: Double
            let cost: Double
        }
    }

    struct ModelAlertData: Codable {
        let active: Bool?
        let model: String?
        let project: String?
        let updatedAt: String?
        let detail: String?
    }

    var resolvedPrimaryLabel: String { primaryLabel ?? "Window" }
    var resolvedSecondaryLabel: String { secondaryLabel ?? "Week" }
    var resolvedTertiaryLabel: String { tertiaryLabel ?? "Fable 5 week" }
    var resolvedPrimary: MetricData? { primary ?? window }
    var resolvedSecondary: MetricData? { secondary ?? weekly }
    var resolvedTertiary: MetricData? { tertiary ?? fableWeekly }
}

struct AccuracyStatus: Codable {
    let checkedAt: String?
    let status: String?            // ok | off | fixing | needs-login | error | unknown
    let maxDeltaPp: Double?
    let action: String?
    let testsPassed: Bool?
    let notes: String?
    let nextCheckInHours: Double?

    // Compact one-line label for the menu, e.g. "Accuracy: ✓ in sync (Δ2pp, 3h ago)".
    func menuTitle() -> String {
        let icon: String
        let word: String
        switch status {
        case "ok":          icon = "✓"; word = "in sync"
        case "off":         icon = "⚠"; word = "off"
        case "fixing":      icon = "⚠"; word = "off — auto-fixing"
        case "needs-login": icon = "🔑"; word = "needs sign-in"
        case "error":       icon = "⚠"; word = "check failed"
        default:            icon = "…"; word = "unknown"
        }
        var bits: [String] = []
        if let d = maxDeltaPp { bits.append(String(format: "Δ%.0fpp", d)) }
        if let age = ageString() { bits.append(age) }
        let suffix = bits.isEmpty ? "" : " (\(bits.joined(separator: ", ")))"
        return "Accuracy: \(icon) \(word)\(suffix)"
    }

    private func ageString() -> String? {
        guard let checkedAt,
              let date = ISO8601DateFormatter().date(from: checkedAt) else { return nil }
        let secs = Date().timeIntervalSince(date)
        if secs < 90 { return "just now" }
        if secs < 3600 { return "\(Int(secs / 60))m ago" }
        if secs < 86400 { return "\(Int(secs / 3600))h ago" }
        return "\(Int(secs / 86400))d ago"
    }
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

    enum AlertLevel { case none, warning, critical }

    struct ProviderBars {
        let hasTopBar: Bool
        let topPct: CGFloat
        let bottomPct: CGFloat
        let topIsRemaining: Bool
        let windowTimePct: CGFloat?
        let cycleActiveDots: Int
        let cycleTotalDots: Int
        let theme: ProviderTheme
        let topAlertLevel: AlertLevel
        let bottomAlertLevel: AlertLevel
        let modelAlertActive: Bool
    }

    var providers: [ProviderBars] = []
    var alertFlashOn: Bool = true
    var onMouseEntered: (() -> Void)?
    var onMouseExited: (() -> Void)?
    private var trackingAreaRef: NSTrackingArea?

    override func updateTrackingAreas() {
        if let trackingAreaRef {
            removeTrackingArea(trackingAreaRef)
        }
        let options: NSTrackingArea.Options = [.mouseEnteredAndExited, .activeAlways, .inVisibleRect]
        let trackingArea = NSTrackingArea(rect: bounds, options: options, owner: self, userInfo: nil)
        addTrackingArea(trackingArea)
        trackingAreaRef = trackingArea
        super.updateTrackingAreas()
    }

    override func mouseEntered(with event: NSEvent) {
        onMouseEntered?()
    }

    override func mouseExited(with event: NSEvent) {
        onMouseExited?()
    }

    override func draw(_ dirtyRect: NSRect) {
        guard !providers.isEmpty else { return }
        let sectionGap: CGFloat = 2
        let totalGap = sectionGap * CGFloat(max(providers.count - 1, 0))
        let providerWidth = max((bounds.width - totalGap) / CGFloat(providers.count), 0)
        for (idx, provider) in providers.enumerated() {
            let originX = CGFloat(idx) * (providerWidth + sectionGap)
            drawProvider(x: originX, width: providerWidth, provider: provider)
        }
    }

    private func drawProvider(x: CGFloat, width: CGFloat, provider: ProviderBars) {
        let bgRect = NSRect(x: x, y: 1, width: width, height: bounds.height - 2)
        provider.theme.tint.setFill()
        NSBezierPath(roundedRect: bgRect, xRadius: 4, yRadius: 4).fill()
        if provider.modelAlertActive && alertFlashOn {
            NSColor.systemRed.withAlphaComponent(0.88).setFill()
            NSBezierPath(roundedRect: bgRect, xRadius: 4, yRadius: 4).fill()
        }

        let inset: CGFloat = 2
        let barH: CGFloat = 3
        let barGap: CGFloat = 2
        let cycleGap: CGFloat = 1.5
        let dotSize: CGFloat = 2.4
        let timeRowH: CGFloat = 3.0
        let timeRowGap: CGFloat = 1.0
        let hasCycle = provider.cycleTotalDots > 0
        let hasTimeRow = provider.hasTopBar && provider.windowTimePct != nil
        let reservesTimeRow = hasTimeRow || !provider.hasTopBar
        var totalH = barH * 2 + barGap
        if hasCycle { totalH += cycleGap + dotSize }
        if reservesTimeRow { totalH += timeRowGap + timeRowH }
        let baseY = (bounds.height - totalH) / 2
        let barWidth = max(width - inset * 2, 0)
        let bottomBarY = hasCycle ? (baseY + dotSize + cycleGap) : baseY
        let timeRowY = reservesTimeRow ? (bottomBarY + barH + barGap) : bottomBarY
        let topBarY = reservesTimeRow ? (timeRowY + timeRowH + timeRowGap) : (bottomBarY + barH + barGap)

        NSColor.white.withAlphaComponent(0.96).setFill()
        if provider.hasTopBar {
            fill(x: x + inset, y: topBarY, w: barWidth, h: barH)
        }
        fill(x: x + inset, y: bottomBarY, w: barWidth, h: barH)

        if provider.hasTopBar {
            barFillColor(for: provider.topAlertLevel).setFill()
            fill(x: x + inset, y: topBarY, w: barWidth * min(provider.topPct, 1), h: barH)
        }

        barFillColor(for: provider.bottomAlertLevel).setFill()
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

        if provider.modelAlertActive && alertFlashOn {
            NSColor.white.withAlphaComponent(0.96).setStroke()
            let border = NSBezierPath(roundedRect: bgRect.insetBy(dx: 0.75, dy: 0.75), xRadius: 4, yRadius: 4)
            border.lineWidth = 1.5
            border.stroke()
        }
    }

    private func barFillColor(for level: AlertLevel) -> NSColor {
        switch level {
        case .critical: return NSColor.systemRed.withAlphaComponent(0.88)
        case .warning:  return NSColor.systemOrange.withAlphaComponent(0.95)
        case .none:     return NSColor.black.withAlphaComponent(0.92)
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
        // Each dot gets an equal segment; grow to ~75% of the segment so dots
        // become short bars at wider widths and circles at narrow widths.
        let segW = width / CGFloat(totalDots)
        let dotW = max(dotSize, segW * 0.75)
        // Corner radius: full half-height (pill) when wide, full half-width (circle) when small.
        let cornerR = min(dotW, dotSize) / 2

        for idx in 0..<totalDots {
            let dotX = x + CGFloat(idx) * segW + (segW - dotW) / 2
            let dotRect = NSRect(x: dotX, y: y, width: dotW, height: dotSize)
            let color = idx < activeDots
                ? NSColor.black.withAlphaComponent(0.92)
                : NSColor.black.withAlphaComponent(0.22)
            color.setFill()
            NSBezierPath(roundedRect: dotRect, xRadius: cornerR, yRadius: cornerR).fill()
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
    let accuracyURL: URL?

    private let openTitle: String
    private let sectionTitle: String
    private let primaryDisplayLabel: String?
    private let secondaryDisplayLabel: String
    private var primaryMenuItem: NSMenuItem!
    private var secondaryMenuItem: NSMenuItem!
    private var tertiaryMenuItem: NSMenuItem!
    private var openUsageMenuItem: NSMenuItem!
    private var accuracyMenuItem: NSMenuItem?
    private var accuracyCheckMenuItem: NSMenuItem?
    private var extraCreditMenuItem: NSMenuItem?
    private var usageCreditsMenuItem: NSMenuItem?
    private var modelAlertMenuItem: NSMenuItem?
    private var apiCreditMenuItem: NSMenuItem?
    private var openMenuItem: NSMenuItem!
    private var lastReportPath: String?
    private var lastUsageCreditsURL: URL?
    private var currentData: MenubarData?

    init(dataURL: URL, weeklyResetCacheURL: URL? = nil, openTitle: String, sectionTitle: String, fallbackBuildCommand: String, theme: ProviderTheme, usagePageURL: URL? = nil, apiCreditURL: URL? = nil, accuracyURL: URL? = nil, primaryDisplayLabel: String? = "5 hour", secondaryDisplayLabel: String = "weekly") {
        self.dataURL = dataURL
        self.weeklyResetCacheURL = weeklyResetCacheURL
        self.openTitle = openTitle
        self.sectionTitle = sectionTitle
        self.primaryDisplayLabel = primaryDisplayLabel
        self.secondaryDisplayLabel = secondaryDisplayLabel
        self.fallbackBuildCommand = fallbackBuildCommand
        self.theme = theme
        self.usagePageURL = usagePageURL
        self.apiCreditURL = apiCreditURL
        self.accuracyURL = accuracyURL
    }

    func install(into menu: NSMenu, target: AppDelegate) {
        menu.addItem(makeSectionHeaderItem(title: sectionTitle))

        // Metric lines are clickable — clicking a stat opens the provider's
        // report.html dashboard (same target as "Open … Dashboard").
        primaryMenuItem = NSMenuItem(title: "—", action: #selector(AppDelegate.openDashboardFromMenuItem(_:)), keyEquivalent: "")
        primaryMenuItem.target = target
        primaryMenuItem.representedObject = self
        primaryMenuItem.toolTip = "Open the usage dashboard (report.html)"
        primaryMenuItem.isHidden = primaryDisplayLabel == nil
        menu.addItem(primaryMenuItem)

        secondaryMenuItem = NSMenuItem(title: "—", action: #selector(AppDelegate.openDashboardFromMenuItem(_:)), keyEquivalent: "")
        secondaryMenuItem.target = target
        secondaryMenuItem.representedObject = self
        secondaryMenuItem.toolTip = "Open the usage dashboard (report.html)"
        menu.addItem(secondaryMenuItem)

        // Tertiary metric (e.g. the separate Fable 5 weekly limit) — hidden
        // until the data file actually carries one.
        tertiaryMenuItem = NSMenuItem(title: "—", action: #selector(AppDelegate.openDashboardFromMenuItem(_:)), keyEquivalent: "")
        tertiaryMenuItem.target = target
        tertiaryMenuItem.representedObject = self
        tertiaryMenuItem.toolTip = "Open the usage dashboard (report.html)"
        tertiaryMenuItem.isHidden = true
        menu.addItem(tertiaryMenuItem)

        openMenuItem = NSMenuItem(title: openTitle, action: #selector(AppDelegate.openDashboardFromMenuItem(_:)), keyEquivalent: "")
        openMenuItem.target = target
        openMenuItem.representedObject = self
        menu.addItem(openMenuItem)

        openUsageMenuItem = NSMenuItem(title: "Open Official Usage Page", action: #selector(AppDelegate.openUsagePageFromMenuItem(_:)), keyEquivalent: "")
        openUsageMenuItem.target = target
        openUsageMenuItem.representedObject = self
        openUsageMenuItem.isEnabled = usagePageURL != nil
        menu.addItem(openUsageMenuItem)

        if accuracyURL != nil {
            let statusItem = NSMenuItem(title: "Accuracy: …", action: nil, keyEquivalent: "")
            statusItem.isEnabled = false
            accuracyMenuItem = statusItem
            menu.addItem(statusItem)

            let checkNow = NSMenuItem(title: "Run accuracy check now", action: #selector(AppDelegate.runAccuracyCheckFromMenuItem(_:)), keyEquivalent: "")
            checkNow.target = target
            checkNow.representedObject = self
            accuracyCheckMenuItem = checkNow
            menu.addItem(checkNow)
        }

        let ecItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        ecItem.isEnabled = false
        ecItem.isHidden = true
        extraCreditMenuItem = ecItem
        menu.addItem(ecItem)

        let ucItem = NSMenuItem(title: "", action: #selector(AppDelegate.openUsageCreditsFromMenuItem(_:)), keyEquivalent: "")
        ucItem.target = target
        ucItem.representedObject = self
        ucItem.isHidden = true
        usageCreditsMenuItem = ucItem
        menu.addItem(ucItem)

        let maItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        maItem.isEnabled = false
        maItem.isHidden = true
        modelAlertMenuItem = maItem
        menu.addItem(maItem)

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

    func openUsageCredits() {
        guard let lastUsageCreditsURL else { return }
        NSWorkspace.shared.open(lastUsageCreditsURL)
    }

    func refreshAccuracy() {
        guard let item = accuracyMenuItem else { return }
        guard let accuracyURL,
              let data = try? Data(contentsOf: accuracyURL),
              let status = try? JSONDecoder().decode(AccuracyStatus.self, from: data) else {
            item.title = "Accuracy: not checked yet"
            return
        }
        item.title = status.menuTitle()
        if let notes = status.notes, !notes.isEmpty {
            item.toolTip = notes
        }
    }

    func refresh() {
        refreshAccuracy()
        guard let jsonData = try? Data(contentsOf: dataURL),
              let data = try? JSONDecoder().decode(MenubarData.self, from: jsonData) else {
            currentData = nil
            if primaryDisplayLabel != nil {
                primaryMenuItem.title = "No data (run \(fallbackBuildCommand))"
            }
            secondaryMenuItem.title = "\(secondaryDisplayLabel) - no data yet"
            tertiaryMenuItem.isHidden = true
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
        let primaryBarPct = displayBarPct(for: primary)
        let primaryPct = CGFloat(primaryBarPct ?? 0)
        let secondaryPct = CGFloat(displayBarPct(for: currentData?.resolvedSecondary) ?? 0)
        let cycle = resolvedWeeklyCycle()
        let cycleTotalDots = cycle?.totalDots ?? 0
        let cycleActiveDots = cycle?.activeDots ?? 0
        let wTimePct = windowTimePct(for: primary)
        let weekProgress: Double? = cycleTotalDots > 0
            ? Double(cycleActiveDots) / Double(cycleTotalDots)
            : nil
        let topAlert = alertLevel(usedPct: Double(primaryPct), timePct: wTimePct.map(Double.init))
        let bottomAlert = alertLevel(usedPct: Double(secondaryPct), timePct: weekProgress)
        return CombinedBarView.ProviderBars(
            hasTopBar: primaryBarPct != nil,
            topPct: primaryPct,
            bottomPct: secondaryPct,
            topIsRemaining: primary?.isRemaining ?? false,
            windowTimePct: wTimePct,
            cycleActiveDots: cycleActiveDots,
            cycleTotalDots: cycleTotalDots,
            theme: theme,
            topAlertLevel: topAlert,
            bottomAlertLevel: bottomAlert,
            modelAlertActive: currentData?.modelAlert?.active == true
        )
    }

    private func alertLevel(usedPct: Double, timePct: Double?) -> CombinedBarView.AlertLevel {
        if usedPct >= 0.95 { return .critical }
        if let t = timePct, usedPct > t { return .warning }
        return .none
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
        if let primaryDisplayLabel {
            if let metric = data.resolvedPrimary, let pct = metric.pct {
                primaryMenuItem.title = formatMetric(label: primaryDisplayLabel, metric: metric, pct: pct)
            } else if let metric = data.resolvedPrimary {
                primaryMenuItem.title = formatRawMetric(label: data.resolvedPrimaryLabel, metric: metric)
            } else {
                primaryMenuItem.title = "\(primaryDisplayLabel) - no data yet"
            }
        }

        if let metric = data.resolvedSecondary, let pct = metric.pct {
            secondaryMenuItem.title = formatMetric(
                label: secondaryDisplayLabel,
                metric: metric,
                pct: pct,
                fallbackResetEpoch: resolvedWeeklyCycle()?.resetEpoch,
                includeResetDate: true
            )
        } else {
            secondaryMenuItem.title = "\(secondaryDisplayLabel) - no data yet"
        }

        if let metric = data.resolvedTertiary {
            if let pct = metric.pct {
                tertiaryMenuItem.title = formatMetric(label: data.resolvedTertiaryLabel, metric: metric, pct: pct, includeResetDate: true)
            } else if let usageDisplay = metric.usageDisplay {
                tertiaryMenuItem.title = "\(data.resolvedTertiaryLabel) - \(usageDisplay)"
            } else {
                tertiaryMenuItem.title = "\(data.resolvedTertiaryLabel) - no data yet"
            }
            tertiaryMenuItem.isHidden = false
        } else {
            tertiaryMenuItem.isHidden = true
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

        lastUsageCreditsURL = (data.usageCreditsUrl ?? data.reconciliationUrl).flatMap { URL(string: $0) }
        if lastUsageCreditsURL != nil {
            usageCreditsMenuItem?.title = "    Usage Credits"
            usageCreditsMenuItem?.isHidden = false
            usageCreditsMenuItem?.isEnabled = true
        } else if let balance = data.usageCreditsBalance {
            usageCreditsMenuItem?.title = "    Usage Credits (manual): $\(String(format: "%.2f", balance))"
            usageCreditsMenuItem?.isHidden = false
            usageCreditsMenuItem?.isEnabled = false
        } else {
            usageCreditsMenuItem?.isHidden = true
        }

        if data.modelAlert?.active == true {
            modelAlertMenuItem?.title = "    Expensive model: \(data.modelAlert?.model ?? "unknown")"
            if let detail = data.modelAlert?.detail {
                modelAlertMenuItem?.toolTip = detail
            }
            modelAlertMenuItem?.isHidden = false
        } else {
            modelAlertMenuItem?.isHidden = true
        }
    }

    func hoverSummaryLines() -> [HoverMetricRow] {
        var lines: [HoverMetricRow] = []
        if let primaryDisplayLabel {
            if let metric = currentData?.resolvedPrimary, let pct = metric.pct {
                lines.append(formatHoverMetricLine(label: hoverProviderMetricLabel(primaryDisplayLabel), metric: metric, pct: pct))
            } else if let data = currentData, let metric = data.resolvedPrimary {
                lines.append(formatHoverRawLine(label: hoverProviderMetricLabel(data.resolvedPrimaryLabel), metric: metric))
            } else {
                lines.append(formatHoverStatusLine(label: hoverProviderMetricLabel(primaryDisplayLabel), status: "no data"))
            }
        }
        if let metric = currentData?.resolvedSecondary, let pct = metric.pct {
            lines.append(formatHoverMetricLine(label: hoverProviderMetricLabel(secondaryDisplayLabel), metric: metric, pct: pct))
        } else {
            lines.append(formatHoverStatusLine(label: hoverProviderMetricLabel(secondaryDisplayLabel), status: "no data"))
        }
        if let data = currentData, let metric = data.resolvedTertiary {
            let tertiaryLabel = hoverTertiaryLabel(data.resolvedTertiaryLabel)
            if let pct = metric.pct {
                lines.append(formatHoverMetricLine(label: tertiaryLabel, metric: metric, pct: pct))
            } else if let usageDisplay = metric.usageDisplay {
                // No ceiling known yet — show the raw usage figure instead of nothing.
                lines.append(formatHoverStatusLine(label: tertiaryLabel, status: usageDisplay))
            }
        }
        return lines
    }

    // Only meaningful when the live weekly reset epoch is known (same gate
    // build.js uses for weeklySpark itself) and the window hasn't already
    // rolled over since the last build — a stale snapshot falls back to the
    // plain secondary text row instead of showing a dead chart.
    private func weeklySparkModel() -> WeeklySparkModel? {
        guard let spark = currentData?.weeklySpark,
              let start = spark.windowStartEpoch,
              let end = spark.windowEndEpoch,
              end > start,
              let hourlyRaw = spark.hourly, !hourlyRaw.isEmpty,
              let pct = currentData?.resolvedSecondary?.pct
        else { return nil }
        let now = Date().timeIntervalSince1970
        guard now < end else { return nil }
        let buckets = hourlyRaw.map { WeeklySparkModel.HourBucket(epoch: $0.epoch, cost: max(0, $0.cost)) }
        return WeeklySparkModel(
            windowStartEpoch: start,
            windowEndEpoch: end,
            hourly: buckets,
            maxedEpochs: Set(spark.maxedHours ?? []),
            currentPct: max(0, min(1, pct)),
            nowEpoch: now,
            tint: theme.tint
        )
    }

    func hoverMenuRows(target: AppDelegate) -> [HoverRow] {
        var rows: [HoverRow] = [.header(sectionTitle, theme.tint)]
        appendMenuItem(primaryMenuItem, to: &rows, tint: theme.tint) { [weak self] in self?.openDashboard() }

        // Everything that would otherwise stack below the chart — collected
        // separately so it can run down the chart's left side instead,
        // filling the space the chart itself doesn't need there.
        var sideRows: [HoverRow] = []
        appendMenuItem(tertiaryMenuItem, to: &sideRows, tint: theme.tint) { [weak self] in self?.openDashboard() }
        appendMenuItem(openMenuItem, to: &sideRows, tint: theme.tint) { [weak self] in self?.openDashboard() }
        appendMenuItem(openUsageMenuItem, to: &sideRows, tint: theme.tint) { [weak self] in self?.openUsagePage() }
        appendMenuItem(accuracyMenuItem, to: &sideRows, tint: theme.tint)
        appendMenuItem(accuracyCheckMenuItem, to: &sideRows, tint: theme.tint) { [weak target, weak self] in target?.runAccuracyCheck(for: self) }
        appendMenuItem(extraCreditMenuItem, to: &sideRows, tint: theme.tint)
        appendMenuItem(usageCreditsMenuItem, to: &sideRows, tint: theme.tint) { [weak self] in self?.openUsageCredits() }
        appendMenuItem(modelAlertMenuItem, to: &sideRows, tint: NSColor.systemRed)
        appendMenuItem(apiCreditMenuItem, to: &sideRows, tint: theme.tint) { [weak self] in self?.openApiCredit() }

        if let sparkModel = weeklySparkModel() {
            rows.append(.weeklySparkWithSide(sparkModel, sideRows))
        } else {
            appendMenuItem(secondaryMenuItem, to: &rows, tint: theme.tint) { [weak self] in self?.openDashboard() }
            rows.append(contentsOf: sideRows)
        }
        return rows
    }

    func activeModelAlertNotification() -> (key: String, title: String, body: String)? {
        guard currentData?.modelAlert?.active == true else { return nil }
        let model = currentData?.modelAlert?.model ?? "unknown"
        let project = currentData?.modelAlert?.project ?? "unknown"
        let key = "\(sectionTitle)|\(model)|\(project)"
        return (
            key,
            "\(sectionTitle) expensive model active",
            "\(model) in \(project). Switch back when this work is done."
        )
    }

    private func appendMenuItem(_ item: NSMenuItem?, to rows: inout [HoverRow], tint: NSColor?, action: (() -> Void)? = nil) {
        guard let item, !item.isHidden, !item.title.isEmpty else { return }
        if item.isEnabled, let action {
            rows.append(.button(title: item.title, tint: tint, action: action))
        } else {
            rows.append(.text(item.title, tint))
        }
    }

    private func hoverProviderMetricLabel(_ metricLabel: String) -> String {
        let providerWidth = 8
        if sectionTitle.count >= providerWidth {
            return "\(sectionTitle) \(metricLabel)"
        }
        return sectionTitle + String(repeating: " ", count: providerWidth - sectionTitle.count) + metricLabel
    }

    private func hoverTertiaryLabel(_ label: String) -> String {
        if label.localizedCaseInsensitiveContains("fable") {
            return "Fable 5"
        }
        return label
    }

    private func formatHoverMetricLine(label: String, metric: MenubarData.MetricData, pct: Double) -> HoverMetricRow {
        if let estimate = metric.usageDisplay, estimate.localizedCaseInsensitiveContains("est") {
            let suffix = timeLeftString(epoch: metric.endEpoch).map {
                metric.resetDetected == true ? " (\($0) left, reset detected)" : " (\($0) left)"
            } ?? (metric.resetDetected == true ? " (reset detected)" : "")
            return HoverMetricRow(label: label, value: estimate, suffix: suffix)
        }
        let usedFraction = metric.isRemaining == true ? 1 - pct : pct
        let usedPct = Int((max(0, min(1, usedFraction)) * 100).rounded())
        let percent = "\(usedPct)%"
        let suffix = timeLeftString(epoch: metric.endEpoch).map {
            metric.resetDetected == true ? " used (\($0) left, reset detected)" : " used (\($0) left)"
        } ?? (metric.resetDetected == true ? " used (reset detected)" : " used")
        return HoverMetricRow(label: label, value: percent, suffix: suffix)
    }

    private func formatHoverRawLine(label: String, metric: MenubarData.MetricData) -> HoverMetricRow {
        let usage = metric.usageDisplay ?? String(format: "%.0f", metric.usage)
        if let detail = metric.detail, !detail.isEmpty {
            return HoverMetricRow(label: label, value: usage, suffix: "(\(detail))")
        }
        return HoverMetricRow(label: label, value: usage, suffix: "")
    }

    private func formatHoverStatusLine(label: String, status: String) -> HoverMetricRow {
        HoverMetricRow(label: label, value: status, suffix: "")
    }

    private func formatMetricPercent(metric: MenubarData.MetricData, pct: Double) -> String {
        if let estimate = metric.usageDisplay, estimate.localizedCaseInsensitiveContains("est") {
            if let timeLeft = timeLeftString(epoch: metric.endEpoch) {
                return "\(estimate) (\(timeLeft) left)"
            }
            return estimate
        }
        let usedFraction = metric.isRemaining == true ? 1 - pct : pct
        let usedPct = Int((max(0, min(1, usedFraction)) * 100).rounded())
        if let timeLeft = timeLeftString(epoch: metric.endEpoch) {
            return "\(usedPct)% used (\(timeLeft) left)"
        }
        return "\(usedPct)% used"
    }

    private func timeLeftString(epoch: Double?) -> String? {
        guard let epoch else { return nil }
        let secs = epoch - Date().timeIntervalSince1970
        guard secs > 0 else { return nil }
        let total = Int(secs)
        let days  = total / 86400
        let hours = (total % 86400) / 3600
        let mins  = (total % 3600) / 60
        if days > 0 { return "\(days)d \(hours)h" }
        if hours > 0 { return "\(hours)h \(mins)m" }
        return "\(mins)m"
    }

    private func formatResetTime(_ epoch: Double, includeDate: Bool) -> String {
        let date = Date(timeIntervalSince1970: epoch)
        let formatter = DateFormatter()
        formatter.timeZone = TimeZone(identifier: "America/Los_Angeles") ?? .current
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = includeDate ? "MMM d, h:mm a" : "h:mm a"
        return formatter.string(from: date)
    }

    private func formatMetric(
        label: String,
        metric: MenubarData.MetricData,
        pct: Double,
        fallbackResetEpoch: Double? = nil,
        includeResetDate: Bool = false
    ) -> String {
        let usedFraction = metric.isRemaining == true ? 1 - pct : pct
        let usedPct = Int((max(0, min(1, usedFraction)) * 100).rounded())
        let leftPct = 100 - usedPct
        let now = Date().timeIntervalSince1970
        let resetEpoch = [metric.endEpoch, fallbackResetEpoch]
            .compactMap { $0 }
            .first { $0 > now }
        if let resetEpoch {
            let resetParts = [
                timeLeftString(epoch: resetEpoch).map { "in \($0)" },
                "at \(formatResetTime(resetEpoch, includeDate: includeResetDate))",
            ].compactMap { $0 }
            let resetNote = metric.resetDetected == true ? ", usage reset detected" : ""
            if let estimate = metric.usageDisplay, estimate.localizedCaseInsensitiveContains("est") {
                return "\(label) - \(estimate) (resets \(resetParts.joined(separator: " "))\(resetNote))"
            }
            return "\(label) - \(usedPct)% used (\(leftPct)% left, resets \(resetParts.joined(separator: " "))\(resetNote))"
        }
        if let detail = metric.detail, !detail.isEmpty {
            if let estimate = metric.usageDisplay, estimate.localizedCaseInsensitiveContains("est") {
                return "\(label) - \(estimate) (\(detail))"
            }
            return "\(label) - \(usedPct)% used (\(leftPct)% left, \(detail))"
        }
        if let estimate = metric.usageDisplay, estimate.localizedCaseInsensitiveContains("est") {
            return "\(label) - \(estimate)"
        }
        return "\(label) - \(usedPct)% used (\(leftPct)% left)"
    }

    private func formatRawMetric(label: String, metric: MenubarData.MetricData) -> String {
        let usage = metric.usageDisplay ?? String(format: "%.0f", metric.usage)
        if let detail = metric.detail, !detail.isEmpty {
            return "\(label) - \(usage) (\(detail))"
        }
        return "\(label) - \(usage)"
    }

    private func resolvedWeeklyCycle() -> MenubarData.WeeklyCycleData? {
        if let cycle = currentData?.weeklyCycle {
            return normalizedWeeklyCycle(cycle)
        }
        if let resetEpoch = currentData?.resolvedSecondary?.endEpoch {
            return buildWeeklyCycle(resetEpoch: resetEpoch)
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

struct HoverMetricRow {
    let label: String
    let value: String
    let suffix: String
    let tint: NSColor?

    init(label: String, value: String, suffix: String, tint: NSColor? = nil) {
        self.label = label
        self.value = value
        self.suffix = suffix
        self.tint = tint
    }
}

enum HoverRow {
    case header(String, NSColor)
    case text(String, NSColor?)
    case button(title: String, tint: NSColor?, action: () -> Void)
    case metric(HoverMetricRow)
    case slider(label: String, value: Double, minValue: Double, maxValue: Double, onChange: (CGFloat) -> Void)
    // The chart paired with the rows that would otherwise stack below it —
    // rendered side by side so those rows fill the space the chart doesn't
    // use on its left, instead of leaving it blank.
    case weeklySparkWithSide(WeeklySparkModel, [HoverRow])
    case separator
}

// Precomputed inputs for WeeklySparkView — all client-side math (cumulative
// sum, pace-color tiers, idle runs, exhaustion projection) lives in the view
// itself, not here, so a stale JSON snapshot never shows a wrong "now".
struct WeeklySparkModel {
    struct HourBucket { let epoch: Double; let cost: Double }

    let windowStartEpoch: Double
    let windowEndEpoch: Double
    let hourly: [HourBucket]   // elapsed hours only, oldest → newest
    let maxedEpochs: Set<Double>
    let currentPct: Double     // authoritative "now" position, 0...1
    let nowEpoch: Double
    let tint: NSColor
}

final class HoverSeparatorView: NSView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.separatorColor.cgColor
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: 420, height: 1)
    }
}

final class HoverMetricLineView: NSView {
    private static let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)

    init(row: HoverMetricRow) {
        super.init(frame: NSRect(x: 0, y: 0, width: 336, height: 20))

        let label = NSTextField(labelWithString: row.label)
        label.font = Self.font
        label.textColor = row.tint ?? .labelColor
        label.lineBreakMode = .byTruncatingTail
        label.frame = NSRect(x: 0, y: 1, width: 132, height: 18)
        addSubview(label)

        let value = NSTextField(labelWithString: row.value)
        value.font = Self.font
        value.textColor = row.tint ?? .labelColor
        value.alignment = .right
        value.lineBreakMode = .byClipping
        value.frame = NSRect(x: 138, y: 1, width: 70, height: 18)
        addSubview(value)

        let suffix = NSTextField(labelWithString: row.suffix)
        suffix.font = Self.font
        suffix.textColor = row.tint ?? .labelColor
        suffix.lineBreakMode = .byTruncatingTail
        suffix.frame = NSRect(x: 214, y: 1, width: 122, height: 18)
        addSubview(suffix)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: 336, height: 20)
    }
}

final class HoverTextLineView: NSView {
    private static let normalFont = NSFont.systemFont(ofSize: 12)
    private static let headerFont = NSFont.systemFont(ofSize: 11, weight: .semibold)

    init(text: String, isHeader: Bool = false, tint: NSColor? = nil) {
        super.init(frame: NSRect(x: 0, y: 0, width: 420, height: 20))

        if isHeader, let tint {
            let stripe = NSView(frame: NSRect(x: 0, y: 4, width: 4, height: 12))
            stripe.wantsLayer = true
            stripe.layer?.backgroundColor = tint.cgColor
            stripe.layer?.cornerRadius = 2
            addSubview(stripe)
        }

        let label = NSTextField(labelWithString: text)
        label.font = isHeader ? Self.headerFont : Self.normalFont
        label.textColor = isHeader ? (tint ?? .labelColor) : (tint ?? .secondaryLabelColor)
        label.lineBreakMode = .byTruncatingTail
        label.frame = NSRect(x: isHeader ? 10 : 0, y: 1, width: isHeader ? 410 : 420, height: 18)
        addSubview(label)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: 420, height: 20)
    }
}

final class HoverSliderLineView: NSView {
    private let valueLabel: NSTextField
    private let onChange: (CGFloat) -> Void

    init(label: String, value: Double, minValue: Double, maxValue: Double, onChange: @escaping (CGFloat) -> Void) {
        self.onChange = onChange
        self.valueLabel = NSTextField(labelWithString: "\(Int(value))px")
        super.init(frame: NSRect(x: 0, y: 0, width: 420, height: 20))

        let nameLabel = NSTextField(labelWithString: label)
        nameLabel.font = NSFont.systemFont(ofSize: 12)
        nameLabel.textColor = .secondaryLabelColor
        nameLabel.frame = NSRect(x: 0, y: 2, width: 40, height: 16)
        addSubview(nameLabel)

        let slider = NSSlider(value: value, minValue: minValue, maxValue: maxValue, target: self, action: #selector(sliderChanged(_:)))
        slider.isContinuous = true
        slider.frame = NSRect(x: 46, y: 2, width: 322, height: 16)
        addSubview(slider)

        valueLabel.font = NSFont.systemFont(ofSize: 12)
        valueLabel.frame = NSRect(x: 374, y: 2, width: 46, height: 16)
        addSubview(valueLabel)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: 420, height: 20)
    }

    @objc private func sliderChanged(_ sender: NSSlider) {
        let newValue = CGFloat(sender.doubleValue.rounded())
        valueLabel.stringValue = "\(Int(newValue))px"
        onChange(newValue)
    }
}

final class HoverButtonLineView: NSView {
    private let handler: () -> Void
    private let label: NSTextField

    // Underlined so clickable rows read as links at a glance — color alone
    // doesn't distinguish them once a provider tint is applied to both
    // buttons and plain text rows.
    init(title: String, tint: NSColor? = nil, action handler: @escaping () -> Void) {
        self.handler = handler
        let color = tint ?? .labelColor
        self.label = NSTextField(labelWithString: "")
        super.init(frame: NSRect(x: 0, y: 0, width: 420, height: 20))
        label.attributedStringValue = NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: 12),
            .foregroundColor: color,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
            .underlineColor: color.withAlphaComponent(0.55),
        ])
        label.lineBreakMode = .byTruncatingTail
        label.frame = NSRect(x: 0, y: 1, width: 420, height: 18)
        addSubview(label)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: 420, height: 20)
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }

    override func mouseUp(with event: NSEvent) {
        guard bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        handler()
    }
}

// Weekly usage sparkline for the hover panel: a monotonic cumulative line
// (pace-colored, gray when idle), a headline exhaustion/reset countdown,
// idle "rest" bands, and red rings on hours a 5h window actually maxed out.
// All numeric derivation (cumulative sum, pace tiers, idle runs, exhaustion
// projection) happens here from raw hourly costs, not in build.js, so a
// stale JSON snapshot never freezes a stale "now" position on screen.
final class WeeklySparkView: NSView {
    // Just the chart + its caption now — the menu-style rows that used to
    // stack below it live in a sibling view to the left instead (see
    // .weeklySparkWithSide in UsageHoverViewController), so there's no
    // internal left/right split here anymore.
    static let contentWidth: CGFloat = 380
    static let totalHeight: CGFloat = 156

    private let model: WeeklySparkModel

    init(model: WeeklySparkModel) {
        self.model = model
        super.init(frame: NSRect(x: 0, y: 0, width: Self.contentWidth, height: Self.totalHeight))
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var isFlipped: Bool { true }

    // Explicit, like HoverSeparatorView — a bare custom NSView with no
    // subviews has no natural size for NSStackView to infer, and relying on
    // the frame-translated-into-constraints behavior alone let the stack
    // size this row far too short, overlapping the rows that followed it.
    override var intrinsicContentSize: NSSize {
        NSSize(width: Self.contentWidth, height: Self.totalHeight)
    }

    override func draw(_ dirtyRect: NSRect) {
        // Dynamic system colors throughout (not fixed dark/light values) — the
        // popover follows the OS appearance, so a hardcoded dark-chrome
        // palette would wash out under a light appearance.
        let idleColor = NSColor.secondaryLabelColor
        let rateStops: [NSColor] = [
            NSColor(calibratedRed: 0.965, green: 0.788, blue: 0.627, alpha: 1),
            NSColor(calibratedRed: 0.941, green: 0.658, blue: 0.4, alpha: 1),
            NSColor(calibratedRed: 0.910, green: 0.525, blue: 0.227, alpha: 1),
            NSColor(calibratedRed: 0.761, green: 0.255, blue: 0.047, alpha: 1),
        ]
        let maxedColor = NSColor(calibratedRed: 0.878, green: 0.365, blue: 0.290, alpha: 1)
        let resetColor = NSColor(calibratedRed: 0.290, green: 0.616, blue: 1.0, alpha: 1)
        let restFill = NSColor(calibratedRed: 0.47, green: 0.55, blue: 0.667, alpha: 0.10)
        let restStroke = NSColor(calibratedRed: 0.47, green: 0.55, blue: 0.667, alpha: 0.4)

        let chartX0: CGFloat = 0
        let chartW = bounds.width

        let totalWeekHours = max((model.windowEndEpoch - model.windowStartEpoch) / 3600.0, 1)
        func hourOffset(_ epoch: Double) -> CGFloat { CGFloat((epoch - model.windowStartEpoch) / 3600.0) }
        func x(_ hours: CGFloat) -> CGFloat { chartX0 + max(0, min(chartW, (hours / CGFloat(totalWeekHours)) * chartW)) }

        // ---- Layout ----
        let chartPadTop: CGFloat = 3
        let chartH: CGFloat = 52
        let lineTopY = chartPadTop
        let lineBottomY = lineTopY + chartH
        func y(_ pct: CGFloat) -> CGFloat { lineTopY + (1 - max(0, min(1, pct))) * chartH }
        let stripY = lineBottomY + 4
        let stripH: CGFloat = 9
        let axisBaselineY = stripY + stripH + 4 + 8

        // ---- Headline: whichever finishes first, exhaustion or reset ----
        let flat = model.hourly.map { max(0, $0.cost) }
        let hourOffsets = model.hourly.map { hourOffset($0.epoch) }
        let nowIdx = flat.count
        let observedTotal = flat.reduce(0, +)

        var cum = [CGFloat](repeating: 0, count: nowIdx)
        if nowIdx > 0 {
            var running: Double = 0
            for i in 0..<nowIdx {
                running += flat[i]
                cum[i] = observedTotal > 0 ? CGFloat(running / observedTotal * model.currentPct) : 0
            }
        }

        let nowHourOffset = min(CGFloat(totalWeekHours), hourOffset(model.nowEpoch))
        let hoursToReset = max(0, CGFloat(totalWeekHours) - nowHourOffset)

        let lookback = min(24, nowIdx)
        var hoursToExhaustion: CGFloat = .infinity
        if nowIdx > 0, lookback > 0 {
            let startI = nowIdx - lookback
            let ratePerHour = (cum[nowIdx - 1] - (startI > 0 ? cum[startI - 1] : 0)) / CGFloat(lookback)
            let remainingCapacity = max(0, 1 - cum[nowIdx - 1])
            if ratePerHour > 0 { hoursToExhaustion = remainingCapacity / ratePerHour }
        }
        let exhaustsFirst = hoursToExhaustion < hoursToReset

        func fmtHM(_ hours: CGFloat) -> String {
            guard hours.isFinite, hours >= 0 else { return "—" }
            let totalMin = Int((hours * 60).rounded())
            return "\(totalMin / 60)h \(String(format: "%02d", totalMin % 60))m"
        }
        func fmtClock(_ epoch: Double) -> String {
            let formatter = DateFormatter()
            formatter.timeZone = TimeZone(identifier: "America/Los_Angeles") ?? .current
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "MMM d, h:mm a"
            return formatter.string(from: Date(timeIntervalSince1970: epoch))
        }

        let headlineColor = exhaustsFirst ? rateStops[3] : resetColor
        let headlineText = exhaustsFirst
            ? "⚠ exhausts in \(fmtHM(hoursToExhaustion)) — before reset"
            : "✓ resets in \(fmtHM(hoursToReset))"
        let exhaustEpoch = model.nowEpoch + Double(hoursToExhaustion) * 3600
        let subText = exhaustsFirst
            ? "at this pace, ~\(fmtClock(exhaustEpoch)) · resets \(fmtClock(model.windowEndEpoch))"
            : "\(fmtClock(model.windowEndEpoch)) · at this pace you won't hit the ceiling first"

        // Caption block sits under the graph (right column), not on the left —
        // it's about the chart, so it stays visually grouped with it instead
        // of crowding the left-hand list of menu-style rows above/below it.
        let captionY0 = axisBaselineY + 6
        let captionY1 = captionY0 + 22
        let captionY2 = captionY1 + 28
        drawText(headlineText, x: chartX0, y: captionY0, width: chartW, height: 22, font: .boldSystemFont(ofSize: 12), color: headlineColor)
        drawText(subText, x: chartX0, y: captionY1, width: chartW, height: 28, font: .systemFont(ofSize: 9.5), color: .secondaryLabelColor)

        guard nowIdx > 0 else {
            drawText("No usage recorded yet this week", x: chartX0, y: captionY0, width: chartW, height: 28, font: .systemFont(ofSize: 10.5), color: .secondaryLabelColor)
            return
        }

        // ---- Day gridlines (orientation only — never the source of the countdown) ----
        let gridColor = NSColor.separatorColor.withAlphaComponent(0.6)
        var day: CGFloat = 0
        while day < CGFloat(totalWeekHours) {
            let gx = x(day)
            let grid = NSBezierPath()
            grid.move(to: NSPoint(x: gx, y: lineTopY))
            grid.line(to: NSPoint(x: gx, y: stripY + stripH))
            grid.lineWidth = 1
            gridColor.setStroke()
            grid.stroke()
            day += 24
        }
        let ceilingLine = NSBezierPath()
        ceilingLine.move(to: NSPoint(x: chartX0, y: y(1)))
        ceilingLine.line(to: NSPoint(x: chartX0 + chartW, y: y(1)))
        ceilingLine.lineWidth = 1
        setDashed(ceilingLine, [2, 2])
        NSColor.separatorColor.setStroke()
        ceilingLine.stroke()

        // ---- Idle-run rest bands (>=4 consecutive zero-cost hours) ----
        var runStart: Int? = nil
        var restRuns: [(Int, Int)] = []
        for i in 0..<nowIdx {
            if flat[i] <= 0 {
                if runStart == nil { runStart = i }
            } else if let s = runStart {
                if i - s >= 4 { restRuns.append((s, i)) }
                runStart = nil
            }
        }
        if let s = runStart, nowIdx - s >= 4 { restRuns.append((s, nowIdx)) }
        for (s, e) in restRuns {
            let bx = x(hourOffsets[s])
            let bw = x(e < nowIdx ? hourOffsets[e] : CGFloat(totalWeekHours)) - bx
            let band = NSBezierPath(roundedRect: NSRect(x: bx, y: stripY - 0.5, width: bw, height: stripH + 1), xRadius: 2.5, yRadius: 2.5)
            restFill.setFill()
            NSBezierPath(rect: NSRect(x: bx, y: lineTopY, width: bw, height: stripY + stripH - lineTopY)).fill()
            restStroke.setStroke()
            band.lineWidth = 0.8
            band.stroke()
        }

        // ---- Cumulative line: colored runs by pace, gray when idle ----
        var points: [NSPoint] = [NSPoint(x: chartX0, y: y(0))]
        for i in 0..<nowIdx { points.append(NSPoint(x: x(hourOffsets[i]), y: y(cum[i]))) }
        let maxRate = max(flat.max() ?? 0, 0.0001)
        func rateColor(_ v: Double) -> NSColor {
            if v <= 0 { return idleColor }
            let r = v / maxRate
            let idx = min(rateStops.count - 1, Int(r * Double(rateStops.count)))
            return rateStops[idx]
        }

        // Area fill under the full cumulative shape.
        let area = NSBezierPath()
        area.move(to: NSPoint(x: chartX0, y: y(0)))
        for p in points.dropFirst() { area.line(to: p) }
        area.line(to: NSPoint(x: points.last!.x, y: y(0)))
        area.close()
        model.tint.withAlphaComponent(0.14).setFill()
        area.fill()

        var runD = NSBezierPath()
        runD.move(to: points[0])
        var runColor = rateColor(flat[0])
        func flushRun() {
            runD.lineWidth = 1.7
            runD.lineCapStyle = .round
            runD.lineJoinStyle = .round
            runColor.setStroke()
            runD.stroke()
        }
        for k in 1..<points.count {
            let color = rateColor(flat[k - 1])
            if !color.isEqual(runColor) {
                runD.line(to: points[k - 1])
                flushRun()
                runD = NSBezierPath()
                runD.move(to: points[k - 1])
                runColor = color
            }
            runD.line(to: points[k])
        }
        flushRun()

        // ---- Maxed-window markers: red ring on the line + red tick on the strip ----
        for (i, offset) in hourOffsets.enumerated() where model.maxedEpochs.contains(model.hourly[i].epoch) {
            let mx = x(offset), my = y(cum[i])
            let ring = NSBezierPath(ovalIn: NSRect(x: mx - 4, y: my - 4, width: 8, height: 8))
            ring.lineWidth = 1.3
            maxedColor.setStroke()
            ring.stroke()
            maxedColor.setFill()
            NSBezierPath(ovalIn: NSRect(x: mx - 1.6, y: my - 1.6, width: 3.2, height: 3.2)).fill()
            NSBezierPath(rect: NSRect(x: mx - 0.6, y: stripY - 1, width: 1.2, height: stripH + 2)).fill()
        }

        // ---- Activity strip: one cell per elapsed hour, lit when active ----
        NSColor.separatorColor.withAlphaComponent(0.3).setFill()
        NSBezierPath(roundedRect: NSRect(x: chartX0, y: stripY, width: x(hourOffsets.last ?? 0) - chartX0, height: stripH), xRadius: 2, yRadius: 2).fill()
        let cellW = max(chartW / CGFloat(totalWeekHours) - 0.4, 0.6)
        for i in 0..<nowIdx where flat[i] > 0 {
            let cx = x(hourOffsets[i])
            model.tint.withAlphaComponent(min(0.4 + CGFloat(flat[i]) / 20, 1)).setFill()
            NSBezierPath(rect: NSRect(x: cx, y: stripY + 1.5, width: cellW, height: stripH - 3)).fill()
        }

        // ---- Projection: last 24h pace extrapolated to the ceiling ----
        let nowX = x(nowHourOffset)
        let nowY = y(cum[nowIdx - 1])
        if hoursToExhaustion.isFinite {
            let exhaustX = min(nowX + (hoursToExhaustion / CGFloat(totalWeekHours)) * chartW, chartX0 + chartW - 1)
            let proj = NSBezierPath()
            proj.move(to: NSPoint(x: nowX, y: nowY))
            proj.line(to: NSPoint(x: exhaustX, y: y(1)))
            proj.lineWidth = 1.3
            proj.lineCapStyle = .round
            setDashed(proj, [2.5, 2.5])
            rateStops[2].withAlphaComponent(0.6).setStroke()
            proj.stroke()
        }

        model.tint.setFill()
        NSBezierPath(ovalIn: NSRect(x: nowX - 2.6, y: nowY - 2.6, width: 5.2, height: 5.2)).fill()

        // ---- Reset marker: real epoch, independent of the day gridlines ----
        let resetLine = NSBezierPath()
        resetLine.move(to: NSPoint(x: chartX0 + chartW - 0.5, y: lineTopY))
        resetLine.line(to: NSPoint(x: chartX0 + chartW - 0.5, y: stripY + stripH))
        resetLine.lineWidth = 1.5
        resetColor.setStroke()
        resetLine.stroke()

        // ---- Day-of-week labels along the axis ----
        let calendar = Calendar(identifier: .gregorian)
        var laCalendar = calendar
        laCalendar.timeZone = TimeZone(identifier: "America/Los_Angeles") ?? .current
        let weekdayFmt = DateFormatter()
        weekdayFmt.locale = Locale(identifier: "en_US_POSIX")
        weekdayFmt.timeZone = laCalendar.timeZone
        weekdayFmt.dateFormat = "EEE"
        day = 0
        while day < CGFloat(totalWeekHours) {
            let epoch = model.windowStartEpoch + Double(day) * 3600
            let label = weekdayFmt.string(from: Date(timeIntervalSince1970: epoch))
            let isToday = Calendar.current.isDateInToday(Date(timeIntervalSince1970: epoch))
            drawText(label, x: x(day) + 2, y: axisBaselineY - 8, width: 40, font: .systemFont(ofSize: 8.5), color: isToday ? model.tint : .tertiaryLabelColor)
            day += 24
        }

        // ---- Mini legend: last line of the caption block under the graph ----
        drawText(
            "● pace    ● no usage    ○ 5h maxed    ▮ reset",
            x: chartX0, y: captionY2, width: chartW,
            font: .systemFont(ofSize: 8.5), color: .tertiaryLabelColor
        )
    }

    private func setDashed(_ path: NSBezierPath, _ pattern: [CGFloat]) {
        path.setLineDash(pattern, count: pattern.count, phase: 0)
    }

    private func drawText(_ text: String, x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat? = nil, font: NSFont, color: NSColor) {
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
        NSAttributedString(string: text, attributes: attrs).draw(in: NSRect(x: x, y: y, width: width, height: height ?? (font.pointSize + 4)))
    }
}

final class HoverTrackingView: NSView {
    var onMouseEntered: (() -> Void)?
    var onMouseExited: (() -> Void)?
    private var trackingAreaRef: NSTrackingArea?

    override func updateTrackingAreas() {
        if let trackingAreaRef {
            removeTrackingArea(trackingAreaRef)
        }
        let options: NSTrackingArea.Options = [.mouseEnteredAndExited, .activeAlways, .inVisibleRect]
        let trackingArea = NSTrackingArea(rect: bounds, options: options, owner: self, userInfo: nil)
        addTrackingArea(trackingArea)
        trackingAreaRef = trackingArea
        super.updateTrackingAreas()
    }

    override func mouseEntered(with event: NSEvent) {
        onMouseEntered?()
    }

    override func mouseExited(with event: NSEvent) {
        onMouseExited?()
    }
}

final class UsageHoverViewController: NSViewController {
    init(rows: [HoverRow], onMouseEntered: @escaping () -> Void, onMouseExited: @escaping () -> Void) {
        super.init(nibName: nil, bundle: nil)
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.edgeInsets = NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)

        for row in rows {
            switch row {
            case .header(let text, let tint):
                stack.addArrangedSubview(HoverTextLineView(text: text, isHeader: true, tint: tint))
            case .text(let text, let tint):
                stack.addArrangedSubview(HoverTextLineView(text: text, tint: tint))
            case .button(let title, let tint, let action):
                stack.addArrangedSubview(HoverButtonLineView(title: title, tint: tint, action: action))
            case .metric(let row):
                stack.addArrangedSubview(HoverMetricLineView(row: row))
            case .slider(let label, let value, let minValue, let maxValue, let onChange):
                stack.addArrangedSubview(HoverSliderLineView(label: label, value: value, minValue: minValue, maxValue: maxValue, onChange: onChange))
            case .weeklySparkWithSide(let model, let sideRows):
                let sideStack = NSStackView()
                sideStack.orientation = .vertical
                sideStack.alignment = .leading
                sideStack.spacing = 6
                for sideRow in sideRows {
                    switch sideRow {
                    case .text(let text, let tint):
                        sideStack.addArrangedSubview(HoverTextLineView(text: text, tint: tint))
                    case .button(let title, let tint, let action):
                        sideStack.addArrangedSubview(HoverButtonLineView(title: title, tint: tint, action: action))
                    default:
                        break // sideRows only ever contains .text/.button (built from appendMenuItem)
                    }
                }
                let rowStack = NSStackView(views: [sideStack, WeeklySparkView(model: model)])
                rowStack.orientation = .horizontal
                rowStack.alignment = .top
                rowStack.spacing = 24
                stack.addArrangedSubview(rowStack)
            case .separator:
                stack.addArrangedSubview(HoverSeparatorView(frame: NSRect(x: 0, y: 0, width: 420, height: 1)))
            }
        }

        // A flat per-row height estimate was fine while every row was a
        // plain ~24pt text/metric line, but it silently mis-sizes the moment
        // one row (like weeklySpark) has a real, very different height —
        // NSStackView then redistributes the gap unevenly across rows
        // (empty space in one, clipped overlap in another). Ask the stack
        // for its own true fitting size instead of estimating.
        stack.layoutSubtreeIfNeeded()
        let fittingHeight = stack.fittingSize.height
        let height = max(38, Int(fittingHeight.rounded(.up)))
        // Wider than the plain-row content column (420pt) specifically to give
        // the weeklySpark row's left-text/right-chart split enough room —
        // other rows just stay left-aligned in the extra space.
        // 420 (side list, matching the plain rows' own width) + 24 (gap) +
        // 380 (chart) + 24 (edge insets) — wide enough for weeklySparkWithSide
        // to lay its side list and chart next to each other without either
        // being squeezed.
        let popoverWidth: CGFloat = 860
        let container = HoverTrackingView(frame: NSRect(x: 0, y: 0, width: popoverWidth, height: CGFloat(height)))
        container.onMouseEntered = onMouseEntered
        container.onMouseExited = onMouseExited
        stack.frame = NSRect(x: 0, y: 0, width: popoverWidth, height: CGFloat(height))
        container.addSubview(stack)
        view = container
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var barView: CombinedBarView!
    private var controllers: [ProviderStatusController] = []
    private var menuModel: NSMenu?
    private var refreshTimer: Timer?
    private var barRedrawTimer: Timer?
    private var alertFlashTimer: Timer?
    private var hoverPopover: NSPopover?
    private var hoverHideWorkItem: DispatchWorkItem?
    private let buildQueue = DispatchQueue(label: "agentic-tool-usage-tracker.menubar-build")
    private var claudeBuildInFlight = false
    private var codexBuildInFlight = false
    private var activeModelNotificationKeys = Set<String>()

    private var barItemWidth: CGFloat {
        get {
            let stored = UserDefaults.standard.double(forKey: "barItemWidth")
            return stored > 0 ? CGFloat(stored) : 60
        }
        set { UserDefaults.standard.set(Double(newValue), forKey: "barItemWidth") }
    }

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
    private static let claudeBuildScriptURL = repoRootURL.appendingPathComponent("claude/scripts/build.js")
    private static let codexBuildScriptURL = repoRootURL.appendingPathComponent("codex/scripts/build.js")
    private static let claudeAccuracyURL = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent(".claude/claude-accuracy.json")
    private static let codexAccuracyURL = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent(".codex/codex-accuracy.json")
    private static let accuracyScriptURL = repoRootURL.appendingPathComponent("accuracy/run_inspect.sh")
    private var accuracyInFlight = false
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
                    tint: NSColor(calibratedRed: 0.78, green: 0.32, blue: 0.08, alpha: 0.82)
                ),
                usagePageURL: URL(string: "https://claude.ai/settings/usage"),
                apiCreditURL: URL(string: "https://platform.claude.com/dashboard"),
                accuracyURL: Self.claudeAccuracyURL
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
                apiCreditURL: URL(string: "https://platform.openai.com/home"),
                accuracyURL: Self.codexAccuracyURL
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
        alertFlashTimer?.invalidate()
        alertFlashTimer = Timer.scheduledTimer(withTimeInterval: 0.65, repeats: true) { [weak self] _ in
            self?.tickAlertFlash()
        }
    }

    private func buildMenu() {
        if let existingStatusItem = statusItem {
            NSStatusBar.system.removeStatusItem(existingStatusItem)
            statusItem = nil
        }

        let barW: CGFloat = barItemWidth
        statusItem = NSStatusBar.system.statusItem(withLength: barW + 4)

        if let btn = statusItem.button {
            btn.title = ""
            barView = CombinedBarView(frame: NSRect(x: 2, y: 0, width: barW, height: NSStatusBar.system.thickness))
            barView.autoresizingMask = .height
            barView.onMouseEntered = { [weak self] in self?.showUsageHover() }
            barView.onMouseExited = { [weak self] in self?.scheduleHideUsageHover() }
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

        let refreshItem = NSMenuItem(title: "Refresh", action: #selector(refreshNow), keyEquivalent: "r")
        refreshItem.target = self
        menu.addItem(refreshItem)

        let restartItem = NSMenuItem(title: "Restart", action: #selector(restartApp), keyEquivalent: "")
        restartItem.target = self
        menu.addItem(restartItem)

        menu.addItem(makeWidthSliderItem())

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quitItem)

        // Keep the NSMenu only as a state model for the hover panel; the click dropdown is replaced by mouseover.
        menuModel = menu
    }

    private func makeWidthSliderItem() -> NSMenuItem {
        let item = NSMenuItem()
        item.isEnabled = true
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 240, height: 30))
        let label = NSTextField(labelWithString: "Width")
        label.frame = NSRect(x: 14, y: 7, width: 40, height: 16)
        label.font = NSFont.systemFont(ofSize: 12)
        container.addSubview(label)
        let slider = NSSlider(value: Double(barItemWidth), minValue: 10, maxValue: 120, target: self, action: #selector(widthSliderChanged(_:)))
        slider.frame = NSRect(x: 58, y: 7, width: 126, height: 16)
        slider.isContinuous = true
        container.addSubview(slider)
        let valueLabel = NSTextField(labelWithString: "\(Int(barItemWidth))px")
        valueLabel.frame = NSRect(x: 188, y: 7, width: 38, height: 16)
        valueLabel.font = NSFont.systemFont(ofSize: 12)
        valueLabel.tag = 1001
        container.addSubview(valueLabel)
        item.view = container
        return item
    }

    @objc private func widthSliderChanged(_ sender: NSSlider) {
        let newWidth = CGFloat(sender.doubleValue.rounded())
        if let valueLabel = sender.superview?.viewWithTag(1001) as? NSTextField {
            valueLabel.stringValue = "\(Int(newWidth))px"
        }
        applyBarWidth(newWidth)
    }

    private func applyBarWidth(_ newWidth: CGFloat) {
        barItemWidth = newWidth
        statusItem.length = newWidth + 4
        barView.frame = NSRect(x: 2, y: 0, width: newWidth, height: barView.frame.height)
        barView.needsDisplay = true
    }

    private func refreshAll() {
        refreshFromDataFiles()
        refreshClaudeMenubarData()
        refreshCodexMenubarData()
    }

    private func refreshFromDataFiles() {
        controllers.forEach { $0.refresh() }
        barView.providers = controllers.map { $0.barState() }
        if !hasActiveModelAlert() {
            barView.alertFlashOn = true
        }
        notifyActiveModelAlerts()
        barView.needsDisplay = true
        if hoverPopover?.isShown == true {
            showUsageHover()
        }
    }

    private func hasActiveModelAlert() -> Bool {
        controllers.contains { $0.barState().modelAlertActive }
    }

    private func tickAlertFlash() {
        guard hasActiveModelAlert() else { return }
        barView.alertFlashOn.toggle()
        barView.needsDisplay = true
    }

    private func notifyActiveModelAlerts() {
        let alerts = controllers.compactMap { $0.activeModelAlertNotification() }
        let currentKeys = Set(alerts.map { $0.key })
        activeModelNotificationKeys = activeModelNotificationKeys.intersection(currentKeys)
        for alert in alerts where !activeModelNotificationKeys.contains(alert.key) {
            deliverNotification(title: alert.title, body: alert.body)
            activeModelNotificationKeys.insert(alert.key)
        }
    }

    private func deliverNotification(title: String, body: String) {
        let notification = NSUserNotification()
        notification.title = title
        notification.informativeText = body
        notification.soundName = NSUserNotificationDefaultSoundName
        NSUserNotificationCenter.default.deliver(notification)
    }

    private func showUsageHover() {
        hoverHideWorkItem?.cancel()
        guard let button = statusItem.button else { return }
        var rows: [HoverRow] = []
        for controller in controllers {
            let group = controller.hoverMenuRows(target: self)
            if group.isEmpty { continue }
            if !rows.isEmpty { rows.append(.separator) }
            rows.append(contentsOf: group)
        }
        if !rows.isEmpty { rows.append(.separator) }
        rows.append(.text("Version: \(AppVersion.current)", nil))
        rows.append(.separator)
        rows.append(.button(title: "Refresh", tint: nil) { [weak self] in self?.runHoverRefreshNow() })
        rows.append(.button(title: "Restart", tint: nil) { [weak self] in self?.runHoverRestartApp() })
        rows.append(.slider(label: "Width", value: Double(barItemWidth), minValue: 10, maxValue: 120) { [weak self] newWidth in
            self?.applyBarWidth(newWidth)
        })
        rows.append(.separator)
        rows.append(.button(title: "Quit", tint: nil) { NSApp.terminate(nil) })
        guard !rows.isEmpty else { return }

        let popover = hoverPopover ?? NSPopover()
        popover.behavior = .applicationDefined
        popover.animates = false
        popover.contentViewController = UsageHoverViewController(
            rows: rows,
            onMouseEntered: { [weak self] in self?.cancelHideUsageHover() },
            onMouseExited: { [weak self] in self?.scheduleHideUsageHover() }
        )
        hoverPopover = popover

        if !popover.isShown {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
    }

    private func cancelHideUsageHover() {
        hoverHideWorkItem?.cancel()
        hoverHideWorkItem = nil
    }

    private func scheduleHideUsageHover() {
        hoverHideWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.hoverPopover?.performClose(nil)
        }
        hoverHideWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: workItem)
    }

    private func refreshClaudeMenubarData() {
        guard !claudeBuildInFlight else { return }
        guard FileManager.default.fileExists(atPath: Self.claudeBuildScriptURL.path) else { return }
        claudeBuildInFlight = true
        buildQueue.async { [weak self] in
            self?.runMenubarBuild(scriptURL: Self.claudeBuildScriptURL)
            DispatchQueue.main.async { [weak self] in
                self?.claudeBuildInFlight = false
                self?.refreshFromDataFiles()
            }
        }
    }

    private func refreshCodexMenubarData() {
        guard !codexBuildInFlight else { return }
        guard FileManager.default.fileExists(atPath: Self.codexBuildScriptURL.path) else { return }
        codexBuildInFlight = true
        buildQueue.async { [weak self] in
            self?.runMenubarBuild(scriptURL: Self.codexBuildScriptURL)
            DispatchQueue.main.async { [weak self] in
                self?.codexBuildInFlight = false
                self?.refreshFromDataFiles()
            }
        }
    }

    private func runMenubarBuild(scriptURL: URL) {
        let invocation = nodeInvocation(scriptURL: scriptURL)
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

    private func nodeInvocation(scriptURL: URL) -> (executableURL: URL, arguments: [String]) {
        for path in Self.nodePathCandidates where FileManager.default.isExecutableFile(atPath: path) {
            return (URL(fileURLWithPath: path), [scriptURL.path, "--menubar-only"])
        }
        return (URL(fileURLWithPath: "/usr/bin/env"), ["node", scriptURL.path, "--menubar-only"])
    }

    @objc private func refreshNow() {
        refreshAll()
    }

    private func runHoverRefreshNow() {
        refreshAll()
    }

    @objc private func restartApp() {
        // launchd (KeepAlive: true) restarts the process automatically after termination
        NSApp.terminate(nil)
    }

    private func runHoverRestartApp() {
        restartApp()
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

    @objc func openUsageCreditsFromMenuItem(_ sender: NSMenuItem) {
        guard let controller = sender.representedObject as? ProviderStatusController else { return }
        controller.openUsageCredits()
    }

    @objc func runAccuracyCheckFromMenuItem(_ sender: NSMenuItem) {
        guard let controller = sender.representedObject as? ProviderStatusController else { return }
        runAccuracyCheck(for: controller)
    }

    func runAccuracyCheck(for controller: ProviderStatusController?) {
        guard !accuracyInFlight else { return }
        guard controller?.accuracyURL != nil else { return }
        guard FileManager.default.fileExists(atPath: Self.accuracyScriptURL.path) else { return }
        accuracyInFlight = true
        buildQueue.async { [weak self] in
            guard let self else { return }
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/zsh")
            task.arguments = [Self.accuracyScriptURL.path, "--force"]
            task.currentDirectoryURL = Self.repoRootURL
            if let devnull = FileHandle(forWritingAtPath: "/dev/null") {
                task.standardOutput = devnull
                task.standardError = devnull
            }
            do { try task.run(); task.waitUntilExit() } catch {}
            DispatchQueue.main.async { [weak self] in
                self?.accuracyInFlight = false
                self?.refreshFromDataFiles()
            }
        }
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
