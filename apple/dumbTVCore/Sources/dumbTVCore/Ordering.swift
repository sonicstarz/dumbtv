import Foundation

/// Ordering modes, ported from `src/schedule/ordering.js`. Buckets are the
/// already-sorted item lists, one per source (a show or a movie).

private func bySeasonEpisode(_ a: Media, _ b: Media) -> Bool {
    let sa = a.seasonNo ?? 0, sb = b.seasonNo ?? 0
    if sa != sb { return sa < sb }
    let ea = a.episodeNo ?? 0, eb = b.episodeNo ?? 0
    if ea != eb { return ea < eb }
    return a.title < b.title
}

private func byAirDate(_ a: Media, _ b: Media) -> Bool {
    let av = a.aired ?? "9999-99-99", bv = b.aired ?? "9999-99-99"
    if av != bv { return av < bv }
    return bySeasonEpisode(a, b)
}

/// The full ordered playlist for a channel. The generator walks this with a
/// monotonic cursor and wraps at the end, so a channel never runs dry.
public func buildPlaylist(channel: PlaylistChannel, buckets rawBuckets: [[Media]], cycle: Int = 0) -> [Media] {
    let buckets = rawBuckets
        .map { $0.sorted(by: bySeasonEpisode) }
        .filter { !$0.isEmpty }
    if buckets.isEmpty { return [] }

    switch channel.orderingMode {
    case .release_order:
        return buckets.flatMap { $0 }.sorted(by: byAirDate)

    case .shuffle:
        let all = buckets.flatMap { $0 }
        let seed = channel.shuffleSeed ^ hashString("\(channel.id):\(cycle)")
        return seededShuffle(all, seed: seed)

    case .marathon:
        let size = max(1, channel.marathonSize)
        var out: [Media] = []
        var idx = Array(repeating: 0, count: buckets.count)
        var exhausted = 0
        var b = 0
        while exhausted < buckets.count {
            let bucket = buckets[b]
            if idx[b] < bucket.count {
                var n = 0
                while n < size && idx[b] < bucket.count {
                    out.append(bucket[idx[b]]); idx[b] += 1; n += 1
                }
                if idx[b] >= bucket.count { exhausted += 1 }
            }
            b = (b + 1) % buckets.count
            if out.count > 20000 { break }
        }
        return out

    case .sequential:
        var out: [Media] = []
        var idx = Array(repeating: 0, count: buckets.count)
        var remaining = buckets.reduce(0) { $0 + $1.count }
        var b = 0
        while remaining > 0 {
            let bucket = buckets[b]
            if idx[b] < bucket.count {
                out.append(bucket[idx[b]]); idx[b] += 1; remaining -= 1
            }
            b = (b + 1) % buckets.count
        }
        return out
    }
}
