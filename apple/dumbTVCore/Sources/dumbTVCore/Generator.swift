import Foundation

/// The precompute step, ported from `src/schedule/generator.js` (the current
/// slotless, staggered model): programs run back-to-back at their natural
/// length, and each channel gets a deterministic head start so channels aren't
/// in lock-step. Ads/dark-hours are not in this first slice — they come with
/// Backend v2. In-memory for now (returns the array).
public enum Generator {

    /// A per-channel head start (up to 20 min) so switching channels lands you
    /// mid-show on each, not all at the same boundary.
    static func staggerOffset(_ channel: ChannelSpec) -> Millis {
        var rng = Mulberry32(seed: hashString("stagger:\(channel.id):\(channel.shuffleSeed)"))
        return Millis(rng.next() * 20 * 60 * 1000)
    }

    /// Build a channel's schedule from `now` forward across `windowMs`.
    public static func generate(channel: ChannelSpec, buckets: [[Media]],
                                now: Millis, windowMs: Millis) -> [Program] {
        let base = buildPlaylist(channel: channel, buckets: buckets, cycle: 0)
        guard !base.isEmpty else { return [] }

        var t = now - staggerOffset(channel)
        let until = now + windowMs
        var programs: [Program] = []

        var cursor = 0
        var cachedCycle = -1
        var cachedList = base

        func nextItem() -> Media {
            let cycle = cursor / cachedList.count
            if cycle != cachedCycle {
                cachedCycle = cycle
                cachedList = channel.orderingMode == .shuffle
                    ? buildPlaylist(channel: channel, buckets: buckets, cycle: cycle)
                    : base
            }
            let item = cachedList[cursor % cachedList.count]
            cursor += 1
            return item
        }

        var guardCount = 0
        while t < until && guardCount < 20000 {
            guardCount += 1
            let item = nextItem()
            guard item.durationMs > 0 else { continue }
            let end = t + item.durationMs
            programs.append(Program(
                channelId: channel.id,
                startUtc: t,
                endUtc: end,
                kind: item.kind == .movie ? .movie : .episode,
                ratingKey: item.ratingKey,
                title: item.showTitle ?? item.title,
                subtitle: item.showTitle != nil ? item.title : nil,
                seasonNo: item.seasonNo,
                episodeNo: item.episodeNo
            ))
            t = end
        }
        return programs
    }
}
