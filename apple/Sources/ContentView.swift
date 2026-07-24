import SwiftUI

struct ContentView: View {
    @StateObject private var model = PlayerModel()
    // A launch env var lets us point at a real Plex .avi without a token in source;
    // falls back to the bundled clip.
    private var testURL: URL {
        if let s = ProcessInfo.processInfo.environment["CATHODE_TEST_URL"], let u = URL(string: s) { return u }
        return Bundle.main.url(forResource: "test", withExtension: "mp4")!
    }
    private var startAt: Int {
        Int(ProcessInfo.processInfo.environment["CATHODE_TEST_START"] ?? "") ?? 5
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VLCPlayerView(model: model, url: testURL, startSeconds: startAt)
                .ignoresSafeArea()
            VStack {
                Spacer()
                Text("VLCKit · \(model.state) · \(model.seconds)s")
                    .font(.system(.title3, design: .monospaced))
                    .foregroundStyle(Palette.amber)
                    .padding(10)
                    .background(.black.opacity(0.7))
                    .padding(.bottom, 60)
            }
        }
    }
}

#Preview {
    ContentView()
}
