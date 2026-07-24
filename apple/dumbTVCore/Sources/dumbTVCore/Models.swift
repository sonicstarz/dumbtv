import Foundation

/// Time is epoch milliseconds throughout, matching the Node engine's `Date.now()`.
public typealias Millis = Int64

public enum MediaKind: String, Codable, Sendable { case episode, movie }

/// A playable item pulled from Plex (or a local file). Mirrors the `media` table.
public struct Media: Identifiable, Hashable, Codable, Sendable {
    public var id: String { ratingKey }
    public let ratingKey: String
    public let parentKey: String?
    public let kind: MediaKind
    public let title: String
    public let showTitle: String?
    public let seasonNo: Int?
    public let episodeNo: Int?
    public let aired: String?          // "YYYY-MM-DD"
    public let durationMs: Millis
    public let partKey: String?

    public init(ratingKey: String, parentKey: String? = nil, kind: MediaKind,
                title: String, showTitle: String? = nil, seasonNo: Int? = nil,
                episodeNo: Int? = nil, aired: String? = nil, durationMs: Millis,
                partKey: String? = nil) {
        self.ratingKey = ratingKey
        self.parentKey = parentKey
        self.kind = kind
        self.title = title
        self.showTitle = showTitle
        self.seasonNo = seasonNo
        self.episodeNo = episodeNo
        self.aired = aired
        self.durationMs = durationMs
        self.partKey = partKey
    }
}

public enum OrderingMode: String, Codable, CaseIterable, Sendable {
    case sequential, release_order, shuffle, marathon
}

/// Anything the playlist builder needs from a channel. Both the minimal
/// `ChannelSpec` (Phase 0 / app engine) and the full `ChannelConfig` (v2
/// scheduler) conform, so `buildPlaylist` works with either.
public protocol PlaylistChannel {
    var id: Int { get }
    var orderingMode: OrderingMode { get }
    var marathonSize: Int { get }
    var shuffleSeed: UInt32 { get }
}

/// The scheduling knobs for one channel. Mirrors the `channels` row.
public struct ChannelSpec: Identifiable, Hashable, Sendable, PlaylistChannel {
    public let id: Int
    public let number: Int
    public let name: String
    public let orderingMode: OrderingMode
    public let marathonSize: Int
    public let shuffleSeed: UInt32

    public init(id: Int, number: Int, name: String, orderingMode: OrderingMode,
                marathonSize: Int = 3, shuffleSeed: UInt32 = 1) {
        self.id = id
        self.number = number
        self.name = name
        self.orderingMode = orderingMode
        self.marathonSize = marathonSize
        self.shuffleSeed = shuffleSeed
    }
}

public enum ProgramKind: String, Codable, Sendable {
    case episode, movie, filler, offair, ad, bumper
}

/// One entry in the precomputed schedule. Mirrors the `programs` table,
/// including the Backend-v2 columns (`slot_start`, `rule_id`, `airing_no`).
public struct Program: Identifiable, Hashable, Codable, Sendable {
    public var id: Millis { startUtc }   // start is unique per channel timeline
    public let channelId: Int
    public let startUtc: Millis
    public let endUtc: Millis
    public let kind: ProgramKind
    public let ratingKey: String?
    public let assetId: Int?
    public let title: String
    public let subtitle: String?
    public let seasonNo: Int?
    public let episodeNo: Int?
    /// The block a program belongs to — ad breaks share the slot_start of the
    /// program they follow, so the guide can collapse them into one listing.
    public let slotStart: Millis
    /// Which rule placed this program (nil for the default rotation).
    public let ruleId: Int?
    /// 1 = premiere on this channel, 2+ = a repeat.
    public let airingNo: Int

    public var durationMs: Millis { endUtc - startUtc }

    public init(channelId: Int, startUtc: Millis, endUtc: Millis, kind: ProgramKind,
                ratingKey: String? = nil, assetId: Int? = nil, title: String,
                subtitle: String? = nil, seasonNo: Int? = nil, episodeNo: Int? = nil,
                slotStart: Millis? = nil, ruleId: Int? = nil, airingNo: Int = 1) {
        self.channelId = channelId
        self.startUtc = startUtc
        self.endUtc = endUtc
        self.kind = kind
        self.ratingKey = ratingKey
        self.assetId = assetId
        self.title = title
        self.subtitle = subtitle
        self.seasonNo = seasonNo
        self.episodeNo = episodeNo
        self.slotStart = slotStart ?? startUtc
        self.ruleId = ruleId
        self.airingNo = airingNo
    }
}
