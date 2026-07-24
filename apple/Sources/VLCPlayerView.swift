import SwiftUI
import VLCKitSPM

/// Drives a VLCMediaPlayer and publishes its state + playback time, so we can
/// verify decoding/seeking even where the simulator won't render video frames.
/// VLCKit direct-plays anything (.avi/.mkv) with instant seek, no transcoding —
/// the reason Cathode can be an Apple TV app. Join-in-progress = `:start-time`.
final class PlayerModel: NSObject, ObservableObject {
    let player = VLCMediaPlayer(options: ["--network-caching=3000"])
    @Published var state: String = "—"
    @Published var seconds: Int = 0
    private var timer: Timer?

    func start(url: URL, startSeconds: Int) {
        let media = VLCMedia(url: url)
        if startSeconds > 0 { media.addOption(":start-time=\(startSeconds)") }
        player.media = media
        player.play()
        // Poll authoritative state on the main thread (VLCKit delegate callbacks
        // arrive off-thread and confuse SwiftUI).
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.state = VLCMediaPlayerStateToString(self.player.state) ?? "?"
            self.seconds = Int(self.player.time.intValue) / 1000
        }
    }

    func stop() { timer?.invalidate(); player.stop() }
}

struct VLCPlayerView: UIViewRepresentable {
    @ObservedObject var model: PlayerModel
    let url: URL
    let startSeconds: Int

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .black
        model.player.drawable = container
        model.start(url: url, startSeconds: startSeconds)
        return container
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    static func dismantleUIView(_ uiView: UIView, coordinator: ()) {}
}
