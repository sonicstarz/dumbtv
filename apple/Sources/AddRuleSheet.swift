import SwiftUI
import CathodeCore

/// The "add a rule" form — the native counterpart of the web app's rule builder
/// (`#addRuleWrap`). Times and dates are typed as plain text (HH:MM,
/// YYYY-MM-DD [HH:MM]) exactly like the web form, which keeps it identical on
/// iOS and tvOS without wrestling platform date pickers.
struct AddRuleSheet: View {
    @ObservedObject var store: ScheduleStore
    let channelId: Int
    @Environment(\.dismiss) private var dismiss

    @State private var kind: RuleKind = .recurring
    @State private var name = ""
    // recurring / blackout
    @State private var days: Set<Int> = [6]
    @State private var startTime = "08:00"
    @State private var durationMin = "180"
    // airdate
    @State private var airSourceKey = ""
    @State private var airdateMode: AirdateMode = .original_weekday
    @State private var airTime = "08:00"
    @State private var cadence = "7"
    // pinned
    @State private var pinAt = ""
    @State private var pinSourceKey = ""
    @State private var pinEpisodeKey = ""
    // windowing
    @State private var effFrom = ""
    @State private var effTo = ""
    @State private var error: String?

    private let dayLetters = ["S", "M", "T", "W", "T", "F", "S"]

    private var showSources: [ChannelSource] { store.sources(channelId).filter { $0.sourceType == "show" } }
    private var pinIsShow: Bool { store.sources(channelId).first { $0.ratingKey == pinSourceKey }?.sourceType == "show" }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Kind", selection: $kind) {
                        Text("Recurring block").tag(RuleKind.recurring)
                        Text("Original airdate").tag(RuleKind.airdate)
                        Text("Blackout (off air)").tag(RuleKind.blackout)
                        Text("Pinned event").tag(RuleKind.pinned)
                    }
                    TextField("Name (e.g. Saturday Morning Cartoons)", text: $name)
                }

                switch kind {
                case .recurring, .blackout: recurringFields
                case .airdate: airdateFields
                case .pinned: pinnedFields
                case .rotation: EmptyView()
                }

                Section("Active window (optional)") {
                    TextField("From (YYYY-MM-DD)", text: $effFrom)
                    TextField("To (YYYY-MM-DD)", text: $effTo)
                }

                if let error {
                    Text(error).foregroundStyle(Color(Palette.tally)).font(.footnote)
                }
            }
            .navigationTitle("Add a rule")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Add") { add() } }
            }
            .onAppear {
                airSourceKey = showSources.first?.ratingKey ?? ""
                pinSourceKey = store.sources(channelId).first?.ratingKey ?? ""
            }
        }
    }

    // MARK: field groups

    private var recurringFields: some View {
        Section(kind == .blackout ? "Off-air window" : "When") {
            HStack(spacing: 6) {
                ForEach(0..<7, id: \.self) { d in
                    let on = days.contains(d)
                    Text(dayLetters[d])
                        .font(.system(.footnote, design: .monospaced)).bold()
                        .frame(width: 30, height: 30)
                        .background(on ? Color(Palette.amber) : Color.gray.opacity(0.2))
                        .foregroundStyle(on ? .black : .primary)
                        .clipShape(Circle())
                        .onTapGesture { if on { days.remove(d) } else { days.insert(d) } }
                }
            }
            TextField("Start (HH:MM)", text: $startTime)
            TextField("Duration (minutes)", text: $durationMin)
        }
    }

    private var airdateFields: some View {
        Section("Original airdate") {
            Picker("Show", selection: $airSourceKey) {
                ForEach(showSources) { s in Text(s.title ?? s.ratingKey).tag(s.ratingKey) }
            }
            Picker("Mode", selection: $airdateMode) {
                Text("Its original weekday (weekly)").tag(AirdateMode.original_weekday)
                Text("On its original date").tag(AirdateMode.anniversary)
                Text("Original cadence (replay)").tag(AirdateMode.original_cadence)
            }
            TextField("Time (HH:MM)", text: $airTime)
            if airdateMode == .original_cadence {
                TextField("Speed-up ×", text: $cadence)
            }
        }
    }

    private var pinnedFields: some View {
        Section("Pinned event") {
            TextField("Starts at (YYYY-MM-DD HH:MM)", text: $pinAt)
            Picker("Show or movie", selection: $pinSourceKey) {
                ForEach(store.sources(channelId)) { s in Text(s.title ?? s.ratingKey).tag(s.ratingKey) }
            }
            if pinIsShow {
                Picker("Episode", selection: $pinEpisodeKey) {
                    Text("—").tag("")
                    ForEach(store.episodes(channelId, showKey: pinSourceKey)) { e in
                        Text("S\(e.seasonNo ?? 0)·E\(e.episodeNo ?? 0) — \(e.title)").tag(e.ratingKey)
                    }
                }
            }
        }
    }

    // MARK: build

    private func add() {
        error = nil
        var rule = ScheduleRule(id: 0, channelId: channelId,
                                name: name.isEmpty ? nil : name, kind: kind, priority: priority(for: kind))
        rule.effectiveFrom = effFrom.isEmpty ? nil : effFrom
        rule.effectiveTo = effTo.isEmpty ? nil : effTo

        switch kind {
        case .recurring, .blackout:
            rule.daysOfWeek = days.sorted().map(String.init).joined(separator: ",")
            rule.startTime = startTime
            rule.durationMin = Int(durationMin) ?? 0
        case .airdate:
            guard !airSourceKey.isEmpty else { error = "Pick a show for the airdate rule."; return }
            rule.ratingKey = airSourceKey
            rule.sourceType = "show"
            rule.airdateMode = airdateMode
            rule.startTime = airTime.isEmpty ? "08:00" : airTime
            if airdateMode == .original_cadence { rule.cadenceCompress = Double(cadence) ?? 1 }
        case .pinned:
            guard let at = Fmt.parseLocalDateTime(pinAt, clock: store.clock) else {
                error = "Bad date — use YYYY-MM-DD HH:MM"; return
            }
            rule.startsAtUtc = at
            if pinIsShow {
                guard !pinEpisodeKey.isEmpty else { error = "Pick which episode to pin."; return }
                rule.ratingKey = pinEpisodeKey; rule.sourceType = "episode"
            } else {
                guard !pinSourceKey.isEmpty else { error = "Pick a movie to pin."; return }
                rule.ratingKey = pinSourceKey; rule.sourceType = "movie"
            }
        case .rotation:
            return
        }
        store.addRule(channelId, rule)
        dismiss()
    }

    private func priority(for kind: RuleKind) -> Int {
        switch kind {
        case .blackout: return 1000
        case .pinned: return 800
        case .airdate: return 500
        case .recurring: return 300
        case .rotation: return 0
        }
    }
}
