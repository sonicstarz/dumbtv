import SwiftUI

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
