import Foundation

/// The single source of truth for where dumbTV writes on Apple platforms.
///
/// **The tvOS trap (build 10 device failure):** real Apple TV hardware forbids
/// writing to Application Support — but the tvOS *simulator* does not enforce
/// it. So the DB opened fine in the sim and threw on two real Apple TVs, taking
/// the whole app down (no store → no server → no QR → no preloaded content).
///
/// On tvOS the only guaranteed-writable location is **Caches**. Caches can be
/// evicted under storage pressure, but dumbTV survives that: the schedule is
/// deterministic and regenerates from the channel config, and the few settings
/// that MUST persist (Plex link, first-run flags) are mirrored to UserDefaults
/// by `Store`. On iOS/macOS, Application Support is correct and durable.
public enum AppPaths {
    public static func dataRoot() -> URL {
        #if os(tvOS)
        let searchDir: FileManager.SearchPathDirectory = .cachesDirectory
        #else
        let searchDir: FileManager.SearchPathDirectory = .applicationSupportDirectory
        #endif
        let fm = FileManager.default
        let base = (try? fm.url(for: searchDir, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? fm.temporaryDirectory
        let root = base.appendingPathComponent("dumbTV", isDirectory: true)
        try? fm.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    /// The persistent SQLite DB path.
    public static func databasePath() -> String {
        dataRoot().appendingPathComponent("dumbtv.db").path
    }

    /// Where downloaded content packs live (beside the DB, same writable root).
    public static func packsDir() -> URL {
        dataRoot().appendingPathComponent("packs", isDirectory: true)
    }
}
