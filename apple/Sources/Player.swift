import SwiftUI
import VLCKitSPM

/// Owns a VLCMediaPlayer. VLCKit direct-plays anything (.avi/.mkv) with instant
/// seek and no transcoding, and join-in-progress is the `:start-time` option —
/// the same trick as the mpv build.
@MainActor
final class Player: ObservableObject {
    let vlc = VLCMediaPlayer(options: ["--network-caching=3000"])
    @Published var state: String = "—"
    private var poll: Timer?

    init() {
        poll = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in self.state = VLCMediaPlayerStateToString(self.vlc.state) ?? "?" }
        }
    }

    /// Join a program already in progress: open the URL and seek `startSeconds` in.
    func play(url: URL, startSeconds: Int) {
        let media = VLCMedia(url: url)
        if startSeconds > 0 { media.addOption(":start-time=\(startSeconds)") }
        vlc.media = media
        vlc.play()
    }

    func stop() { vlc.stop() }
}

/// A SwiftUI surface for a Player's video output.
struct VideoSurface: UIViewRepresentable {
    let player: Player
    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.backgroundColor = .black
        player.vlc.drawable = v
        return v
    }
    func updateUIView(_ uiView: UIView, context: Context) {}
}
