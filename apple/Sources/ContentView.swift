import SwiftUI
import dumbTVCore

/// The whole app: a television. Open it and you get the guide + channels +
/// what's on.
///
/// Setup is native and on-device (press S, or the button on the setup card) —
/// link a server, pick a library, make a channel. The web UI served by the local
/// backend (see docs/api-contract.md) is still there and still complete, but on
/// Apple it is a companion for bulk work rather than the front door.
struct ContentView: View {
    @ObservedObject var engine: Engine
    let store: Store?
    var configURL: String? = nil
    @ObservedObject var diag: SystemDiagnostics
    /// Native Setup's state. Nil when the backend failed to open — channel 00
    /// and the diagnostics section explain that case.
    var setup: SetupModel? = nil

    var body: some View {
        TVView(engine: engine, configURL: configURL, diag: diag, setup: setup)
            .task { await engine.bootstrap(store: store) }
    }
}

#Preview {
    ContentView(engine: Engine(), store: nil, configURL: "http://10.0.1.21:8080",
                diag: SystemDiagnostics(), setup: SetupModel(api: nil))
}
