import SwiftUI
import dumbTVCore

#if os(macOS)
/// Closing the TV window quits the app. Deliberate: the embedded config server
/// dies with it, and the web UI greys out — no "window gone but the backend is
/// secretly still running" state to reason about.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
#endif

@main
struct dumbTVApp: App {
    #if os(macOS)
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif
    /// The player, owned at app scope so the macOS menu bar can drive it.
    @StateObject private var engine = Engine()
    /// The on-device config backend: one persistent Store shared by the embedded
    /// web server (config) and the player (playback). Held for the app's lifetime.
    private let store: Store?
    private let server: EmbeddedServer?
    private let configURL: String?
    /// Self-reported init/server state, surfaced on channel 00 when the server
    /// isn't reachable (build 11 tvOS-failure evidence).
    private let diag = SystemDiagnostics()

    init() {
        // App.init runs on the main thread; populate diag synchronously so a
        // failure or hang leaves a trail on the channel-00 diagnostics screen.
        let dbPath = AppPaths.databasePath()
        diag.storePath = dbPath
        do {
            let s = try Store(path: dbPath)
            store = s
            diag.storeOpened = true
            let srv = EmbeddedServer(store: s)
            let d = diag
            srv.onStateChange = { state in d.setServerState(state) }
            srv.start()
            server = srv
            let url = NetworkInfo.configURL(port: srv.port)
            configURL = url
            diag.serverPort = srv.port
            diag.configURL = url
        } catch {
            print("dumbTV backend init failed: \(error)")
            store = nil
            server = nil
            configURL = nil
            diag.storeError = "\(error)"
        }
        // F7: record WHERE the database ended up and how old it is. The
        // "every new build resets the app" report needs evidence, not a guess —
        // in particular whether the silent temporary-directory fallback fired.
        diag.captureStorage(store: store)
    }

    var body: some Scene {
        WindowGroup {
            ContentView(engine: engine, store: store, configURL: configURL, diag: diag)
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
}
