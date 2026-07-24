import SwiftUI
import dumbTVCore

@main
struct dumbTVApp: App {
    /// The player, owned at app scope so the macOS menu bar can drive it.
    @StateObject private var engine = Engine()
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
            ContentView(engine: engine, store: store, configURL: configURL)
                #if os(macOS)
                .frame(minWidth: 640, minHeight: 360)
                .background(Color.black)
                #endif
        }
        #if os(macOS)
        .defaultSize(width: 1024, height: 576)          // 16:9
        .windowStyle(.hiddenTitleBar)                    // immersive — it's a TV
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .newItem) {}          // no "New Window"
            CommandMenu("Channel") {
                Button("Channel Up")   { engine.channelUp() }.keyboardShortcut(.upArrow, modifiers: .command)
                Button("Channel Down") { engine.channelDown() }.keyboardShortcut(.downArrow, modifiers: .command)
                Divider()
                Button(engine.guideOpen ? "Hide Guide" : "Show Guide") { engine.guideOpen.toggle() }
                    .keyboardShortcut("g", modifiers: .command)
            }
        }
        #endif
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
