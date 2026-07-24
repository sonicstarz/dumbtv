import SwiftUI
import dumbTVCore

@main
struct dumbTVApp: App {
    /// The on-device config backend: one persistent Store shared by the embedded
    /// web server (config) and the player (playback). Held for the app's lifetime.
    private let store: Store?
    private let server: EmbeddedServer?
    private let configURL: String?

    init() {
        let s = Self.openStore()
        store = s
        if let s {
            let srv = EmbeddedServer(store: s)
            srv.start()
            server = srv
            configURL = NetworkInfo.configURL(port: srv.port)
        } else {
            server = nil
            configURL = nil
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView(store: store, configURL: configURL)
        }
    }

    /// Open (creating if needed) the persistent DB in Application Support.
    /// Failure is non-fatal — the TV still plays the built-in demo.
    private static func openStore() -> Store? {
        do {
            let fm = FileManager.default
            let base = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                  appropriateFor: nil, create: true)
            let dir = base.appendingPathComponent("dumbTV", isDirectory: true)
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            return try Store(path: dir.appendingPathComponent("dumbtv.db").path)
        } catch {
            print("dumbTV backend init failed: \(error)")
            return nil
        }
    }
}
