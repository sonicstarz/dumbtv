import Foundation
import Combine
import CathodeCore

/// The app-side model behind the Schedule and Calendar screens. Owns a
/// `ChannelScheduler` per channel — the ported v2 reservation engine — and
/// exposes rule editing, preview, and apply. Seeds a small demo lineup so the
/// UI is meaningful on the simulator (and a stranger's machine) without Plex;
/// the same store would be fed real `Media` once a library is linked.
@MainActor
final class ScheduleStore: ObservableObject {
    @Published private(set) var schedulers: [ChannelScheduler] = []
    @Published var selectedChannelId: Int?
    /// Bumped after any in-place mutation of a scheduler so views refresh.
    @Published private(set) var revision = 0

    let clock = Clock.device

    init(seedDemo: Bool = true) {
        if seedDemo { seed() }
    }

    func nowMs() -> Millis { Millis(Date().timeIntervalSince1970 * 1000) }

    var channels: [ChannelConfig] { schedulers.map(\.channel) }

    func scheduler(_ id: Int?) -> ChannelScheduler? {
        guard let id else { return nil }
        return schedulers.first { $0.channel.id == id }
    }

    var selected: ChannelScheduler? { scheduler(selectedChannelId) }

    private func bump() { revision += 1 }

    // MARK: rules

    func rules(_ id: Int?) -> [ScheduleRule] {
        (scheduler(id)?.rules ?? []).sorted { $0.priority != $1.priority ? $0.priority > $1.priority : $0.id < $1.id }
    }

    func sources(_ id: Int?) -> [ChannelSource] { scheduler(id)?.library.sources ?? [] }

    /// Episodes of a show source, for the pinned-episode picker.
    func episodes(_ id: Int?, showKey: String) -> [Media] {
        guard let lib = scheduler(id)?.library else { return [] }
        return lib.mediaByKey.values
            .filter { $0.parentKey == showKey }
            .sorted { ($0.seasonNo ?? 0, $0.episodeNo ?? 0) < ($1.seasonNo ?? 0, $1.episodeNo ?? 0) }
    }

    @discardableResult
    func addRule(_ id: Int, _ rule: ScheduleRule) -> Int? {
        guard let s = scheduler(id) else { return nil }
        let rid = s.addRule(rule)
        bump()
        return rid
    }

    func removeRule(_ id: Int, ruleId: Int) {
        scheduler(id)?.removeRule(id: ruleId)
        bump()
    }

    // MARK: preview / apply

    func preview(_ id: Int?, days: Int = 7) -> (from: Millis, until: Millis, result: BuildResult)? {
        scheduler(id)?.preview(now: nowMs(), days: days)
    }

    @discardableResult
    func apply(_ id: Int) -> ChannelScheduler.GenResult? {
        let r = scheduler(id)?.regenerateChannel(now: nowMs())
        bump()
        return r
    }

    /// Programs overlapping a range on one channel — for the calendar grid.
    func programs(_ id: Int?, in range: Range<Millis>) -> [Program] {
        scheduler(id)?.programs(in: range) ?? []
    }

    // MARK: demo seed

    private func seed() {
        let lib = Self.demoLibrary()
        let now = nowMs()
        let window = 14 * DAY

        let channels: [(ChannelConfig, [String])] = [
            (ChannelConfig(id: 2, number: 2, name: "Retro Toons", orderingMode: .shuffle,
                           shuffleSeed: 12002, adsEnabled: true, adsBetween: 3),
             ["show-xmen", "show-spidey", "show-gargoyles"]),
            (ChannelConfig(id: 3, number: 3, name: "The Late Show", orderingMode: .marathon,
                           marathonSize: 3, shuffleSeed: 12003, darkStart: "00:00", darkEnd: "06:00"),
             ["show-spidey", "show-gargoyles"]),
            (ChannelConfig(id: 4, number: 4, name: "Movie Matinee", orderingMode: .release_order,
                           shuffleSeed: 12004, adsEnabled: true, adsBetween: 2),
             ["movie-1", "movie-2", "movie-3", "movie-4", "movie-5", "movie-6"]),
        ]

        var built: [ChannelScheduler] = []
        for (cfg, sourceKeys) in channels {
            var channelLib = lib
            channelLib.sources = sourceKeys.enumerated().map { i, k in
                ChannelSource(id: i + 1, ratingKey: k, sourceType: k.hasPrefix("movie") ? "movie" : "show", title: Self.displayName(k))
            }
            let s = ChannelScheduler(channel: cfg, library: channelLib, clock: clock)
            s.generateChannel(now: now, until: now + window)
            built.append(s)
        }
        schedulers = built
        selectedChannelId = built.first?.channel.id
    }

    private static func displayName(_ key: String) -> String {
        switch key {
        case "show-xmen": return "X-Men Evolution"
        case "show-spidey": return "Spider-Man"
        case "show-gargoyles": return "Gargoyles"
        default: return key.replacingOccurrences(of: "movie-", with: "Kids Movie ")
        }
    }

    private static func demoLibrary() -> Library {
        func show(_ key: String, _ title: String, eps: Int, mins: Int, weekday: Int) -> [Media] {
            // Give each show a real weekday of original airdates so the "original
            // weekday" airdate rule has something to key off in the demo.
            var out: [Media] = []
            var d = DateComponents(); d.year = 1994; d.month = 9; d.day = 3 + weekday
            let cal = Calendar(identifier: .gregorian)
            var base = cal.date(from: d) ?? Date(timeIntervalSince1970: 0)
            for i in 1...eps {
                let season = (i - 1) / 13 + 1
                let ep = (i - 1) % 13 + 1
                let c = cal.dateComponents([.year, .month, .day], from: base)
                let aired = String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
                out.append(Media(ratingKey: "\(key)-e\(i)", parentKey: key, kind: .episode,
                                 title: "Episode \(i)", showTitle: title, seasonNo: season, episodeNo: ep,
                                 aired: aired, durationMs: Millis(mins) * 60_000 + Millis(i % 5) * 1000,
                                 partKey: "local:/demo/\(key)-\(i).mp4"))
                base = cal.date(byAdding: .day, value: 7, to: base) ?? base
            }
            return out
        }
        var media = show("show-xmen", "X-Men Evolution", eps: 26, mins: 22, weekday: 3)
        media += show("show-spidey", "Spider-Man", eps: 20, mins: 21, weekday: 6)
        media += show("show-gargoyles", "Gargoyles", eps: 18, mins: 23, weekday: 5)
        for i in 1...6 {
            media.append(Media(ratingKey: "movie-\(i)", parentKey: nil, kind: .movie, title: "Kids Movie \(i)",
                               showTitle: nil, seasonNo: nil, episodeNo: nil, aired: "199\(i)-01-01",
                               durationMs: Millis(78 + i * 4) * 60_000, partKey: "local:/demo/movie-\(i).mp4"))
        }
        let assets: [Asset] = [
            Asset(id: 1, title: "Cereal Spot", kind: "ad", durationMs: 30_000, tags: "90s"),
            Asset(id: 2, title: "Action Figures", kind: "ad", durationMs: 30_000, tags: "90s,toys"),
            Asset(id: 3, title: "Fruit Snacks", kind: "ad", durationMs: 15_000, tags: "90s"),
            Asset(id: 4, title: "Video Game", kind: "ad", durationMs: 45_000, tags: "90s,games"),
            Asset(id: 100, title: "Station ID", kind: "bumper", durationMs: 8_000),
        ]
        return Library(media: media, sources: [], assets: assets)
    }
}

// MARK: - formatting helpers shared by the schedule UI

enum Fmt {
    static func time(_ ms: Millis) -> String {
        let f = DateFormatter(); f.dateFormat = "h:mm a"
        return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }
    static func day(_ ms: Millis) -> String {
        let f = DateFormatter(); f.dateFormat = "EEE, MMM d"
        return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }
    static func dateTime(_ ms: Millis) -> String {
        let f = DateFormatter(); f.dateStyle = .medium; f.timeStyle = .short
        return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }
    /// Parse "YYYY-MM-DD HH:MM" (local) → epoch ms, or nil.
    static func parseLocalDateTime(_ s: String, clock: Clock) -> Millis? {
        let parts = s.replacingOccurrences(of: "T", with: " ").split(separator: " ")
        guard parts.count == 2 else { return nil }
        let ymd = parts[0].split(separator: "-"), hm = parts[1].split(separator: ":")
        guard ymd.count == 3, hm.count == 2,
              let y = Int(ymd[0]), let mo = Int(ymd[1]), let d = Int(ymd[2]),
              let h = Int(hm[0]), let mi = Int(hm[1]) else { return nil }
        return clock.makeLocal(year: y, month: mo, day: d, hour: h, minute: mi)
    }
}
