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
    }

    var providers: [ProviderBars] = []
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
    private var apiCreditMenuItem: NSMenuItem?
    private var openMenuItem: NSMenuItem!
    private var lastReportPath: String?
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
            bottomAlertLevel: bottomAlert
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

    func hoverMenuRows(target: AppDelegate) -> [HoverRow] {
        var rows: [HoverRow] = [.header(sectionTitle, theme.tint)]
        appendMenuItem(primaryMenuItem, to: &rows, tint: theme.tint) { [weak self] in self?.openDashboard() }
        appendMenuItem(secondaryMenuItem, to: &rows, tint: theme.tint) { [weak self] in self?.openDashboard() }
        appendMenuItem(tertiaryMenuItem, to: &rows, tint: theme.tint) { [weak self] in self?.openDashboard() }
        appendMenuItem(openMenuItem, to: &rows, tint: theme.tint) { [weak self] in self?.openDashboard() }
        appendMenuItem(openUsageMenuItem, to: &rows, tint: theme.tint) { [weak self] in self?.openUsagePage() }
        appendMenuItem(accuracyMenuItem, to: &rows, tint: theme.tint)
        appendMenuItem(accuracyCheckMenuItem, to: &rows, tint: theme.tint) { [weak target, weak self] in target?.runAccuracyCheck(for: self) }
        appendMenuItem(extraCreditMenuItem, to: &rows, tint: theme.tint)
        appendMenuItem(apiCreditMenuItem, to: &rows, tint: theme.tint) { [weak self] in self?.openApiCredit() }
        return rows
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
            let suffix = timeLeftString(epoch: metric.endEpoch).map { " (\($0) left)" } ?? ""
            return HoverMetricRow(label: label, value: estimate, suffix: suffix)
        }
        let usedFraction = metric.isRemaining == true ? 1 - pct : pct
        let usedPct = Int((max(0, min(1, usedFraction)) * 100).rounded())
        let percent = "\(usedPct)%"
        let suffix = timeLeftString(epoch: metric.endEpoch).map { " used (\($0) left)" } ?? " used"
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
            if let estimate = metric.usageDisplay, estimate.localizedCaseInsensitiveContains("est") {
                return "\(label) - \(estimate) (window resets \(resetParts.joined(separator: " ")))"
            }
            return "\(label) - \(usedPct)% used (\(leftPct)% left, window resets \(resetParts.joined(separator: " ")))"
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
    case separator
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

final class HoverButtonLineView: NSView {
    private let handler: () -> Void
    private let label: NSTextField

    init(title: String, tint: NSColor? = nil, action handler: @escaping () -> Void) {
        self.handler = handler
        self.label = NSTextField(labelWithString: title)
        super.init(frame: NSRect(x: 0, y: 0, width: 420, height: 20))
        label.font = NSFont.systemFont(ofSize: 12)
        label.textColor = tint ?? .controlAccentColor
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
            case .separator:
                stack.addArrangedSubview(HoverSeparatorView(frame: NSRect(x: 0, y: 0, width: 420, height: 1)))
            }
        }

        let height = max(38, rows.count * 24 + 20)
        let container = HoverTrackingView(frame: NSRect(x: 0, y: 0, width: 444, height: height))
        container.onMouseEntered = onMouseEntered
        container.onMouseExited = onMouseExited
        stack.frame = container.bounds
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
    private var hoverPopover: NSPopover?
    private var hoverHideWorkItem: DispatchWorkItem?
    private let buildQueue = DispatchQueue(label: "agentic-tool-usage-tracker.menubar-build")
    private var claudeBuildInFlight = false
    private var codexBuildInFlight = false
    private var antigravityBuildInFlight = false

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
    private static let antigravityDataURL = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent(".gemini/antigravity-cli/antigravity-tracker-menubar.json")
    private static let claudeBuildScriptURL = repoRootURL.appendingPathComponent("claude/scripts/build.js")
    private static let codexBuildScriptURL = repoRootURL.appendingPathComponent("codex/scripts/build.js")
    private static let antigravityBuildScriptURL = repoRootURL.appendingPathComponent("antigravity/scripts/build.js")
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
            ),
            ProviderStatusController(
                dataURL: Self.antigravityDataURL,
                openTitle: "Open Antigravity Dashboard",
                sectionTitle: "Antigravity",
                fallbackBuildCommand: "npm run build:antigravity",
                theme: ProviderTheme(
                    tint: NSColor.systemTeal.withAlphaComponent(0.76)
                ),
                usagePageURL: URL(string: "https://antigravity.google/"),
                primaryDisplayLabel: nil,
                secondaryDisplayLabel: "weekly"
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

        let refreshItem = NSMenuItem(title: "Refresh Now", action: #selector(refreshNow), keyEquivalent: "r")
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
        barItemWidth = newWidth
        if let valueLabel = sender.superview?.viewWithTag(1001) as? NSTextField {
            valueLabel.stringValue = "\(Int(newWidth))px"
        }
        statusItem.length = newWidth + 4
        barView.frame = NSRect(x: 2, y: 0, width: newWidth, height: barView.frame.height)
        barView.needsDisplay = true
    }

    private func refreshAll() {
        refreshFromDataFiles()
        refreshClaudeMenubarData()
        refreshCodexMenubarData()
        refreshAntigravityMenubarData()
    }

    private func refreshFromDataFiles() {
        controllers.forEach { $0.refresh() }
        barView.providers = controllers.map { $0.barState() }
        barView.needsDisplay = true
        if hoverPopover?.isShown == true {
            showUsageHover()
        }
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
        rows.append(.button(title: "Refresh Now", tint: nil) { [weak self] in self?.runHoverRefreshNow() })
        rows.append(.button(title: "Restart", tint: nil) { [weak self] in self?.runHoverRestartApp() })
        rows.append(.text("Width", nil))
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

    private func refreshAntigravityMenubarData() {
        guard !antigravityBuildInFlight else { return }
        guard FileManager.default.fileExists(atPath: Self.antigravityBuildScriptURL.path) else { return }
        antigravityBuildInFlight = true
        buildQueue.async { [weak self] in
            self?.runMenubarBuild(scriptURL: Self.antigravityBuildScriptURL)
            DispatchQueue.main.async { [weak self] in
                self?.antigravityBuildInFlight = false
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
