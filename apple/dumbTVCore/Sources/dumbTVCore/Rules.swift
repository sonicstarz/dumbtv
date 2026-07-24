import Foundation

/// Backend-v2 data model, ported from `src/db.js`. Content claims time via rules
/// with a priority; generation resolves them highest-priority-first
/// (reservations), then fills the gaps with rotation.

public enum RuleKind: String, Codable, Sendable, CaseIterable {
    case blackout, pinned, recurring, airdate, rotation
}

public enum AirdateMode: String, Codable, Sendable, CaseIterable {
    case original_weekday, anniversary, original_cadence
}

public enum TimingMode: String, Codable, Sendable, CaseIterable {
    case continuous, grid, auto
}

public enum OverrunPolicy: String, Codable, Sendable, CaseIterable {
    case protect, cutin
}

/// One row of `schedule_rules`.
public struct ScheduleRule: Identifiable, Hashable, Sendable {
    public var id: Int
    public var channelId: Int
    public var name: String?
    public var kind: RuleKind
    public var priority: Int
    public var enabled: Bool
    // recurring / blackout
    public var daysOfWeek: String?     // CSV, 0=Sun .. 6=Sat
    public var startTime: String?      // 'HH:MM' local
    public var durationMin: Int?
    // pinned
    public var startsAtUtc: Millis?
    // content
    public var sourceType: String?     // show|movie|season|episode|collection|channel
    public var ratingKey: String?
    public var orderingMode: OrderingMode?
    public var cursor: Int
    // windowing
    public var effectiveFrom: String?  // 'YYYY-MM-DD'
    public var effectiveTo: String?
    // airdate
    public var airdateMode: AirdateMode?
    public var cadenceCompress: Double

    public init(id: Int, channelId: Int, name: String? = nil, kind: RuleKind,
                priority: Int, enabled: Bool = true, daysOfWeek: String? = nil,
                startTime: String? = nil, durationMin: Int? = nil, startsAtUtc: Millis? = nil,
                sourceType: String? = nil, ratingKey: String? = nil,
                orderingMode: OrderingMode? = nil, cursor: Int = 0,
                effectiveFrom: String? = nil, effectiveTo: String? = nil,
                airdateMode: AirdateMode? = nil, cadenceCompress: Double = 1) {
        self.id = id; self.channelId = channelId; self.name = name; self.kind = kind
        self.priority = priority; self.enabled = enabled; self.daysOfWeek = daysOfWeek
        self.startTime = startTime; self.durationMin = durationMin; self.startsAtUtc = startsAtUtc
        self.sourceType = sourceType; self.ratingKey = ratingKey; self.orderingMode = orderingMode
        self.cursor = cursor; self.effectiveFrom = effectiveFrom; self.effectiveTo = effectiveTo
        self.airdateMode = airdateMode; self.cadenceCompress = cadenceCompress
    }
}

/// A commercial or bumper — one row of `assets`.
public struct Asset: Identifiable, Hashable, Sendable {
    public var id: Int
    public var title: String
    public var kind: String            // 'ad' | 'bumper'
    public var durationMs: Millis
    public var tags: String
    public var path: String
    public var partKey: String?

    public init(id: Int, title: String, kind: String, durationMs: Millis,
                tags: String = "", path: String = "", partKey: String? = nil) {
        self.id = id; self.title = title; self.kind = kind; self.durationMs = durationMs
        self.tags = tags; self.path = path; self.partKey = partKey
    }
}

/// One row of `channel_sources` — a show/movie/collection feeding the rotation.
public struct ChannelSource: Identifiable, Hashable, Sendable {
    public var id: Int
    public var ratingKey: String
    public var sourceType: String
    public var title: String?

    public init(id: Int, ratingKey: String, sourceType: String, title: String? = nil) {
        self.id = id; self.ratingKey = ratingKey; self.sourceType = sourceType; self.title = title
    }
}

/// Premiere/rerun + repeat-cooldown state, per (channel, item) — one row of `airings`.
public struct AiringState: Hashable, Sendable {
    public var count: Int
    public var lastAired: Millis?
    public init(count: Int = 0, lastAired: Millis? = nil) {
        self.count = count; self.lastAired = lastAired
    }
}

/// The full `channels` row. Superset of `ChannelSpec`; conforms to
/// `PlaylistChannel` so it drives `buildPlaylist` directly.
public struct ChannelConfig: Identifiable, Hashable, Sendable, PlaylistChannel {
    public var id: Int
    public var number: Int
    public var name: String
    public var slotMinutes: Int
    public var orderingMode: OrderingMode
    public var marathonSize: Int
    public var cursor: Int
    public var shuffleSeed: UInt32
    public var darkStart: String?
    public var darkEnd: String?
    public var adsEnabled: Bool
    public var maxAdsPerBreak: Int
    public var adTags: String
    public var timingMode: TimingMode
    public var adsBetween: Int
    public var cooldownDays: Int
    public var overrunPolicy: OverrunPolicy
    public var enabled: Bool
    public var generatedThru: Millis

    public init(id: Int, number: Int, name: String, slotMinutes: Int = 30,
                orderingMode: OrderingMode = .sequential, marathonSize: Int = 3,
                cursor: Int = 0, shuffleSeed: UInt32 = 1, darkStart: String? = nil,
                darkEnd: String? = nil, adsEnabled: Bool = true, maxAdsPerBreak: Int = 10,
                adTags: String = "", timingMode: TimingMode = .continuous, adsBetween: Int = 4,
                cooldownDays: Int = 0, overrunPolicy: OverrunPolicy = .protect,
                enabled: Bool = true, generatedThru: Millis = 0) {
        self.id = id; self.number = number; self.name = name; self.slotMinutes = slotMinutes
        self.orderingMode = orderingMode; self.marathonSize = marathonSize; self.cursor = cursor
        self.shuffleSeed = shuffleSeed; self.darkStart = darkStart; self.darkEnd = darkEnd
        self.adsEnabled = adsEnabled; self.maxAdsPerBreak = maxAdsPerBreak; self.adTags = adTags
        self.timingMode = timingMode; self.adsBetween = adsBetween; self.cooldownDays = cooldownDays
        self.overrunPolicy = overrunPolicy; self.enabled = enabled; self.generatedThru = generatedThru
    }

    public var spec: ChannelSpec {
        ChannelSpec(id: id, number: number, name: name, orderingMode: orderingMode,
                    marathonSize: marathonSize, shuffleSeed: shuffleSeed)
    }
}

/// A reservation that lost its slot to a higher-priority one — surfaced, never
/// silently dropped, so the UI can warn.
public struct Conflict: Hashable, Sendable {
    public let rule: String
    public let at: Millis
    public let lostTo: String
}

/// The static library a build reads. Everything the DB-backed generator queries,
/// passed in explicitly so the scheduler stays pure and headless-testable.
public struct Library: Sendable {
    public var mediaByKey: [String: Media]
    public var sources: [ChannelSource]
    public var excludes: Set<String>
    public var assets: [Asset]

    public init(mediaByKey: [String: Media] = [:], sources: [ChannelSource] = [],
                excludes: Set<String> = [], assets: [Asset] = []) {
        self.mediaByKey = mediaByKey; self.sources = sources
        self.excludes = excludes; self.assets = assets
    }

    public init(media: [Media], sources: [ChannelSource] = [],
                excludes: Set<String> = [], assets: [Asset] = []) {
        var byKey: [String: Media] = [:]
        for m in media { byKey[m.ratingKey] = m }
        self.init(mediaByKey: byKey, sources: sources, excludes: excludes, assets: assets)
    }

    /// Ordered source buckets for the rotation playlist, with excludes removed —
    /// the port of `ordering.js` `loadSourceBuckets`.
    public func sourceBuckets() -> [[Media]] {
        sources
            .map { s -> [Media] in
                mediaByKey.values
                    .filter { ($0.parentKey == s.ratingKey || $0.ratingKey == s.ratingKey)
                              && !excludes.contains($0.ratingKey) }
            }
            .filter { !$0.isEmpty }
    }

    /// A show's episodes in original-airdate order (undated fall to the back) —
    /// the port of `generator.js` `showEpisodes`.
    func showEpisodes(_ ratingKey: String) -> [Media] {
        mediaByKey.values
            .filter { ($0.parentKey == ratingKey || $0.ratingKey == ratingKey) && $0.durationMs > 0 }
            .sorted { a, b in
                let aa = a.aired ?? "9999-99-99", ba = b.aired ?? "9999-99-99"
                if aa != ba { return aa < ba }
                let sa = a.seasonNo ?? 0, sb = b.seasonNo ?? 0
                if sa != sb { return sa < sb }
                return (a.episodeNo ?? 0) < (b.episodeNo ?? 0)
            }
    }
}
