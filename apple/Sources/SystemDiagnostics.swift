import Foundation
import dumbTVCore

/// On-screen evidence for the build-10 tvOS failure investigation. There is no
/// Apple TV to debug on locally, so build 11 makes the app self-report: this is
/// populated during app init and by the embedded server, and surfaced on
/// channel 00 whenever the config server isn't reachable. One TestFlight
/// screenshot from a real device then says which hypothesis (store write
/// failure vs a main-thread hang vs a bind failure) is true.
///
/// Plain ObservableObject (not @MainActor) so `dumbTVApp.init` can populate it
/// synchronously; the server hops to main before touching it.
final class SystemDiagnostics: ObservableObject {
    @Published var storeOpened = false
    @Published var storeError: String?
    @Published var storePath = ""
    @Published var serverState = "not started"
    @Published var serverPort: UInt16 = 0
    @Published var configURL: String?

    /// F7 — the "every new build resets the app" report. Nothing in the code
    /// provably wipes, so build 13 adds evidence rather than a blind fix. Three
    /// facts settle it from one TestFlight photo of channel 00:
    ///
    /// - `storageFallback` non-nil means the DB is in a TEMPORARY directory that
    ///   gets purged between launches — the leading hypothesis, and previously
    ///   invisible.
    /// - `dbCreatedAt` older than the update means the file was NOT recreated, so
    ///   nothing was wiped; a timestamp from minutes ago means it was.
    /// - `dbRowSummary` distinguishes "empty database" from "no database".
    @Published var storageFallback: String?
    @Published var dbExists = false
    @Published var dbCreatedAt: Date?
    @Published var dbBytes: Int64?
    @Published var dbRowSummary = "—"

    /// Capture the storage provenance. Called from app init, right after the
    /// Store is opened (or fails to open).
    func captureStorage(store: Store?) {
        storageFallback = AppPaths.fallbackReason
        let p = AppPaths.databaseProvenance()
        dbExists = p.exists
        dbCreatedAt = p.createdAt
        dbBytes = p.bytes
        if let store {
            let channels = store.allChannels().count
            let media = store.mediaRowCount()
            let programs = store.programRowCount()
            let settings = store.settingsRowCount()
            dbRowSummary = "\(channels) ch · \(media) media · \(programs) prog · \(settings) settings"
        } else {
            dbRowSummary = "unreadable"
        }
    }

    /// "3 days ago (12.4 MB)" — how old the database file is, in the terms the
    /// question actually needs answering in.
    var dbAgeDescription: String {
        guard dbExists else { return "MISSING" }
        var out: String
        if let createdAt = dbCreatedAt {
            let days = Int(Date().timeIntervalSince(createdAt) / 86_400)
            let hours = Int(Date().timeIntervalSince(createdAt) / 3_600)
            out = days >= 1 ? "created \(days)d ago" : "created \(hours)h ago"
        } else {
            out = "created ?"
        }
        if let dbBytes { out += "  ·  \(String(format: "%.1f", Double(dbBytes) / 1e6)) MB" }
        return out
    }

    var platform: String {
        #if os(tvOS)
        return "tvOS"
        #elseif os(iOS)
        return "iOS"
        #else
        return "macOS"
        #endif
    }
    var lanIP: String { NetworkInfo.primaryIPv4() ?? "—" }

    /// Set from the server's NWListener state callback (any queue → main).
    func setServerState(_ s: String) {
        if Thread.isMainThread { serverState = s }
        else { DispatchQueue.main.async { self.serverState = s } }
    }
}
