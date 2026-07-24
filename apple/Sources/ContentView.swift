import SwiftUI
import dumbTVCore

/// The whole app: a television. Open it and you get the guide + channels +
/// what's on — nothing else. All configuration lives in the web UI served by
/// the local backend (see docs/api-contract.md), reached from a phone/laptop
/// browser on the same network.
struct ContentView: View {
    @ObservedObject var engine: Engine
    let store: Store?
    var configURL: String? = nil

    var body: some View {
        TVView(engine: engine, configURL: configURL)
            .task { await engine.bootstrap(store: store) }
    }
}

#Preview {
    ContentView(engine: Engine(), store: nil, configURL: "http://10.0.1.21:8080")
}
