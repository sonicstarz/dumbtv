import Foundation

/// Deterministic RNG, ported from `src/util/rng.js`. Every shuffle in Cathode
/// must be reproducible — if the printed guide says Spider-Man is on at 4:00,
/// regenerating the schedule cannot move it.

/// FNV-1a over UTF-16 code units (matches JS `charCodeAt`).
public func hashString(_ str: String) -> UInt32 {
    var h: UInt32 = 2166136261
    for u in str.utf16 {
        h ^= UInt32(u)
        h = h &* 16777619
    }
    return h
}

/// mulberry32 — small, fast, good enough for scheduling television.
public struct Mulberry32 {
    private var a: UInt32
    public init(seed: UInt32) { a = seed }

    public mutating func next() -> Double {
        a = a &+ 0x6d2b79f5
        var t = a
        t = (t ^ (t >> 15)) &* (t | 1)
        t = t ^ (t &+ ((t ^ (t >> 7)) &* (t | 61)))
        return Double(t ^ (t >> 14)) / 4294967296.0
    }
}

/// Fisher–Yates against a seeded RNG. Returns a new array.
public func seededShuffle<T>(_ items: [T], seed: UInt32) -> [T] {
    var out = items
    var rng = Mulberry32(seed: seed)
    var i = out.count - 1
    while i > 0 {
        let j = Int(rng.next() * Double(i + 1))
        out.swapAt(i, j)
        i -= 1
    }
    return out
}
