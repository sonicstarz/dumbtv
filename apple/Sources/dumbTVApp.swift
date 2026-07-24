import SwiftUI
import dumbTVCore

@main
struct dumbTVApp: App {
    /// The on-device config backend (persistent Store + embedded web server).
    /// Held for the app's lifetime so the server keeps listening.
    private let server: EmbeddedServer?

    init() {
        server = Self.makeServer()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }

    /// Open (creating if needed) the persistent DB in Application Support and
    /// start the config server. Failure is non-fatal — the TV still plays.
    private static func makeServer() -> EmbeddedServer? {
        do {
            let fm = FileManager.default
            let base = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                  appropriateFor: nil, create: true)
            let dir = base.appendingPathComponent("dumbTV", isDirectory: true)
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let store = try Store(path: dir.appendingPathComponent("dumbtv.db").path)
            let server = EmbeddedServer(store: store)
            server.start()
            return server
        } catch {
            print("dumbTV backend init failed: \(error)")
            return nil
        }
    }
}
