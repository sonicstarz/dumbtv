import SwiftUI

/// The whole app: a television. Open it and you get the guide + channels +
/// what's on — nothing else. All configuration lives in the web UI served by
/// the local backend (see docs/api-contract.md), reached from a phone/laptop
/// browser on the same network.
struct ContentView: View {
    @StateObject private var engine = Engine()

    var body: some View {
        TVView(engine: engine)
            .task { await engine.bootstrapFromEnvIfPresent() }
    }
}

#Preview {
    ContentView()
}
