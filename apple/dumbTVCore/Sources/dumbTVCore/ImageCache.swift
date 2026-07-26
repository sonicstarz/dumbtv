import Foundation

/// A tiny thread-safe, size-capped image cache for the poster proxy (A4).
///
/// The picker was glacial because every poster was fetched through the
/// PlexClient *actor* — serialized, one WAN round-trip at a time, behind the
/// library browse. This caches fetched posters so a re-render is free, and the
/// proxy fetches OFF the actor (URLSession is already concurrent), so N posters
/// load in parallel instead of single file.
final class ImageCache: @unchecked Sendable {
    private let lock = NSLock()
    private var store: [String: Data] = [:]
    private var order: [String] = []          // simple LRU by insertion/most-recent
    private var bytes = 0
    private let maxBytes: Int

    init(maxBytes: Int = 48 * 1024 * 1024) { self.maxBytes = maxBytes }

    func get(_ key: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard let d = store[key] else { return nil }
        if let i = order.firstIndex(of: key) { order.remove(at: i); order.append(key) }
        return d
    }

    func set(_ key: String, _ data: Data) {
        lock.lock(); defer { lock.unlock() }
        if store[key] != nil { return }
        store[key] = data; order.append(key); bytes += data.count
        while bytes > maxBytes, let oldest = order.first {
            order.removeFirst()
            if let d = store.removeValue(forKey: oldest) { bytes -= d.count }
        }
    }
}
