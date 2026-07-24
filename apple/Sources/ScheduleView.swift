import SwiftUI
import CathodeCore

/// The native Schedule / rule-editor screen — the counterpart of the web app's
/// `loadSchedule` view. Content claims time with rules; Cathode places them
/// highest-priority-first, then fills the gaps. Add/remove rules, preview a dry
/// run (with conflicts surfaced, never dropped), then Apply to make it air.
struct ScheduleView: View {
    @ObservedObject var store: ScheduleStore
    @State private var showAddRule = false
    @State private var applyNote: String?

    private var channelId: Int? { store.selectedChannelId }

    var body: some View {
        NavigationStack {
            List {
                channelPicker
                rulesSection
                previewSection
            }
            .navigationTitle("Schedule")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showAddRule = true } label: { Label("Add rule", systemImage: "plus") }
                        .disabled(channelId == nil)
                }
            }
            .sheet(isPresented: $showAddRule) {
                if let cid = channelId { AddRuleSheet(store: store, channelId: cid) }
            }
        }
    }

    // MARK: channel picker

    private var channelPicker: some View {
        Section {
            Picker("Channel", selection: Binding(
                get: { store.selectedChannelId ?? store.channels.first?.id ?? 0 },
                set: { store.selectedChannelId = $0 })) {
                ForEach(store.channels) { c in
                    Text("\(String(format: "%02d", c.number))  \(c.name)").tag(c.id)
                }
            }
            if let note = applyNote {
                Text(note).font(.footnote).foregroundStyle(.secondary)
            }
            Button {
                if let cid = channelId, let r = store.apply(cid) {
                    applyNote = "Applied — \(r.added) blocks scheduled."
                        + (r.conflicts.isEmpty ? "" : " \(r.conflicts.count) conflict(s).")
                }
            } label: {
                Label("Apply changes", systemImage: "checkmark.circle.fill")
            }
            .disabled(channelId == nil)
        } footer: {
            Text("Preview is a dry run — nothing airs until you Apply.")
        }
    }

    // MARK: rules

    private var rulesSection: some View {
        Section("Rules") {
            let rules = store.rules(channelId)
            if rules.isEmpty {
                Text("Just the default rotation.").foregroundStyle(.secondary)
            }
            ForEach(rules) { rule in
                RuleRow(rule: rule)
                    .swipeActions(edge: .trailing) {
                        if rule.kind != .rotation {
                            Button(role: .destructive) {
                                if let cid = channelId { store.removeRule(cid, ruleId: rule.id) }
                            } label: { Label("Remove", systemImage: "trash") }
                        }
                    }
            }
        }
    }

    // MARK: preview timeline

    private var previewSection: some View {
        Section("Timeline preview") {
            if let p = store.preview(channelId, days: 7) {
                let rulesById = Dictionary(uniqueKeysWithValues: store.rules(channelId).map { ($0.id, $0) })
                if !p.result.conflicts.isEmpty {
                    ForEach(Array(p.result.conflicts.enumerated()), id: \.offset) { _, c in
                        Label("\(c.rule) lost \(Fmt.day(c.at)) \(Fmt.time(c.at)) to \(c.lostTo)",
                              systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote).foregroundStyle(Color(Palette.tally))
                    }
                }
                let blocks = p.result.rows.filter { [ProgramKind.episode, .movie, .offair].contains($0.kind) }.prefix(120)
                TimelinePreview(blocks: Array(blocks), rulesById: rulesById)
            } else {
                Text("Nothing scheduled.").foregroundStyle(.secondary)
            }
        }
    }
}

private struct RuleRow: View {
    let rule: ScheduleRule
    private let dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    private var when: String {
        switch rule.kind {
        case .pinned:
            return rule.startsAtUtc.map { Fmt.dateTime($0) } ?? ""
        case .airdate:
            let m = rule.airdateMode ?? .original_weekday
            let base = m == .anniversary ? "on its original date"
                     : m == .original_cadence ? "original cadence" : "weekly, original weekday"
            return base + (rule.startTime.map { " · \($0)" } ?? "")
        case .recurring, .blackout:
            guard let st = rule.startTime else { return "" }
            let days = (rule.daysOfWeek ?? "").split(separator: ",")
                .compactMap { Int($0) }.map { dayNames[safe: $0] ?? "" }.joined(separator: " ")
            return "\(days) \(st) · \(rule.durationMin ?? 0)m"
        case .rotation:
            return "fills every gap"
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            Text(rule.kind.rawValue.uppercased())
                .font(.system(size: 9, weight: .heavy, design: .monospaced))
                .padding(.horizontal, 6).padding(.vertical, 3)
                .background(kindColor.opacity(0.25))
                .foregroundStyle(kindColor)
                .clipShape(RoundedRectangle(cornerRadius: 4))
            VStack(alignment: .leading, spacing: 2) {
                Text(rule.name ?? rule.kind.rawValue).font(.subheadline).bold()
                if !when.isEmpty { Text(when).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
        }
    }

    private var kindColor: Color {
        switch rule.kind {
        case .blackout: return Color(Palette.dim)
        case .pinned: return Color(Palette.tally)
        case .airdate: return Color(Palette.amber)
        case .recurring: return .blue
        case .rotation: return .green
        }
    }
}

private struct TimelinePreview: View {
    let blocks: [Program]
    let rulesById: [Int: ScheduleRule]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(grouped().enumerated()), id: \.offset) { _, group in
                Text(group.day)
                    .font(.system(.caption, design: .monospaced)).bold()
                    .foregroundStyle(Color(Palette.amber))
                    .padding(.top, 8).padding(.bottom, 2)
                ForEach(group.items) { b in
                    let rule = b.ruleId.flatMap { rulesById[$0] }
                    let reserved = rule != nil && rule?.kind != .rotation
                    HStack(spacing: 8) {
                        Rectangle()
                            .fill(b.kind == .offair ? Color(Palette.dim)
                                  : reserved ? Color(Palette.amber) : Color(Palette.dim).opacity(0.4))
                            .frame(width: 3, height: 26)
                        Text(Fmt.time(b.startUtc))
                            .font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                            .frame(width: 62, alignment: .leading)
                        Text(b.title + (b.subtitle.map { " — \($0)" } ?? ""))
                            .font(.caption).lineLimit(1)
                        Spacer()
                        if reserved, let name = rule?.name ?? rule?.kind.rawValue {
                            Text(name).font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(Color(Palette.amber))
                        }
                    }
                    .padding(.vertical, 1)
                }
            }
        }
    }

    private struct DayGroup { let day: String; var items: [Program] }
    private func grouped() -> [DayGroup] {
        var out: [DayGroup] = []
        for b in blocks {
            let d = Fmt.day(b.startUtc)
            if out.last?.day == d { out[out.count - 1].items.append(b) }
            else { out.append(DayGroup(day: d, items: [b])) }
        }
        return out
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
