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
    /// F7 — the leading suspect for "every new build resets the app". `dataRoot()`
    /// fell back to `temporaryDirectory` if the Application Support lookup ever
    /// failed, **silently**. A database living in tmp is purged between launches
    /// and presents EXACTLY as reported: channels gone, first run again. Nothing
    /// in the code provably wipes, so this build does not "fix" anything — it
    /// makes the one invisible failure visible. If this is non-nil, the fallback
    /// happened, and the channel-00 diagnostics block says so in red.
    ///
    /// Read it after `dataRoot()`; it is set at most once per launch.
    public private(set) nonisolated(unsafe) static var fallbackReason: String?

    public static func dataRoot() -> URL {
        #if os(tvOS)
        let searchDir: FileManager.SearchPathDirectory = .cachesDirectory
        let dirName = "Caches"
        #else
        let searchDir: FileManager.SearchPathDirectory = .applicationSupportDirectory
        let dirName = "Application Support"
        #endif
        let fm = FileManager.default
        let base: URL
        do {
            base = try fm.url(for: searchDir, in: .userDomainMask, appropriateFor: nil, create: true)
        } catch {
            // Last resort so the TV still comes up with SOMETHING (invariant #7
            // — never show an error dialog), but loudly, not silently.
            base = fm.temporaryDirectory
            fallbackReason = "\(dirName) unavailable (\(error.localizedDescription)) — "
                + "using a TEMPORARY directory, which is purged between launches"
        }
        let root = base.appendingPathComponent("dumbTV", isDirectory: true)
        do {
            try fm.createDirectory(at: root, withIntermediateDirectories: true)
        } catch {
            if fallbackReason == nil {
                fallbackReason = "couldn't create \(root.path): \(error.localizedDescription)"
            }
        }
        return root
    }

    /// Provenance for the database, for the channel-00 diagnostics block. A single
    /// TestFlight photo of this answers where the data went after an update:
    /// a file that exists with an old creation date means nothing was recreated.
    public static func databaseProvenance() -> (exists: Bool, createdAt: Date?, bytes: Int64?) {
        let path = databasePath()
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path) else {
            return (false, nil, nil)
        }
        return (true,
                attrs[.creationDate] as? Date,
                (attrs[.size] as? NSNumber)?.int64Value)
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
