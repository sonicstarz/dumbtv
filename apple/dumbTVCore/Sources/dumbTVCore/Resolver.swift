import Foundation

/// The one query the whole illusion rests on, ported from `src/schedule/resolver.js`:
/// what is airing right now, and how far into it are we? Seek that many ms in and
/// you have joined a broadcast in progress.
public struct Airing: Sendable {
    public let program: Program
    public let offsetMs: Millis
    public var remainingMs: Millis { program.endUtc - (program.startUtc + offsetMs) }
    public var progress: Double {
        program.durationMs > 0 ? min(1, max(0, Double(offsetMs) / Double(program.durationMs))) : 0
    }
}

public enum Resolver {
    /// `programs` is assumed sorted ascending by `startUtc`.
    public static func nowOn(_ programs: [Program], at: Millis) -> Airing? {
        // Binary search for the last program that starts at or before `at`.
        var lo = 0, hi = programs.count - 1, found = -1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if programs[mid].startUtc <= at { found = mid; lo = mid + 1 } else { hi = mid - 1 }
        }
        guard found >= 0 else { return nil }
        let p = programs[found]
        guard p.endUtc > at else { return nil }
        return Airing(program: p, offsetMs: at - p.startUtc)
    }

    public static func upNext(_ programs: [Program], at: Millis, count: Int = 1) -> [Program] {
        programs.filter { $0.startUtc > at }.prefix(count).map { $0 }
    }
}
