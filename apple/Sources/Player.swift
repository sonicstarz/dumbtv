import SwiftUI
import VLCKitSPM

/// Owns a VLCMediaPlayer. VLCKit direct-plays anything (.avi/.mkv) with instant
/// seek and no transcoding, and join-in-progress is the `:start-time` option —
/// the same trick as the mpv build.
@MainActor
final class Player: ObservableObject {
    // A little more caching smooths WAN streaming; the colour-bars overlay hides
    // the buffering gap so bigger caching never shows as raw black.
    let vlc = VLCMediaPlayer(options: ["--network-caching=4000"])
    @Published var state: String = "—"
    /// True once a video frame is actually on screen — used to cover the
    /// opening/buffering/seek gap with colour bars instead of black (invariant #7).
    @Published var videoActive = false
    private var poll: Timer?

    // One persistent view is VLC's `drawable`, set once and never reassigned.
    // The watch and guide layouts move THIS view between them, so the video
    // output follows instead of going black on re-attach (a single vout).
    #if os(macOS)
    let videoView: NSView = {
        let v = NSView(); v.wantsLayer = true
        v.layer?.backgroundColor = NSColor.black.cgColor
        return v
    }()
    #else
    let videoView: UIView = {
        let v = UIView(); v.backgroundColor = .black
        return v
    }()
    #endif

    init() {
        vlc.drawable = videoView
        poll = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                self.state = VLCMediaPlayerStateToString(self.vlc.state) ?? "?"
                self.videoActive = self.vlc.hasVideoOut
            }
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

/// The video plus broadcaster colour bars, shown until an actual frame is on
/// screen. Tuning, buffering, and join-in-progress seeks (slow on WAN AVI) show
/// bars instead of raw black — invariant #7.
struct VideoLayer: View {
    @ObservedObject var player: Player
    var body: some View {
        ZStack {
            VideoSurface(player: player)
            if !player.videoActive { ColorBars().transition(.opacity) }
        }
        .animation(.easeInOut(duration: 0.2), value: player.videoActive)
    }
}

/// SMPTE-style colour bars with a "please stand by" ident.
struct ColorBars: View {
    private let bars: [Color] = [
        Color(white: 0.75), Color(red: 0.75, green: 0.75, blue: 0),
        Color(red: 0, green: 0.75, blue: 0.75), Color(red: 0, green: 0.75, blue: 0),
        Color(red: 0.75, green: 0, blue: 0.75), Color(red: 0.75, green: 0, blue: 0),
        Color(red: 0, green: 0, blue: 0.75),
    ]
    var body: some View {
        ZStack {
            HStack(spacing: 0) { ForEach(bars.indices, id: \.self) { bars[$0] } }
            Text("● PLEASE STAND BY")
                .font(.system(.subheadline, design: .monospaced)).bold()
                .foregroundStyle(.white)
                .padding(.horizontal, 16).padding(.vertical, 9)
                .background(.black.opacity(0.6)).clipShape(Capsule())
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .padding(.bottom, 64)
        }
        .ignoresSafeArea()
    }
}

/// A SwiftUI surface for a Player's video output. VLCKit takes any platform
/// view as its `drawable`, so the only per-platform code in the whole app is
/// the representable wrapper below.
// The representable hosts a fresh container each time, then moves the Player's
// single persistent `videoView` (VLC's drawable) into it. Because the drawable
// object never changes, the video output survives the watch↔guide re-parent.
#if os(macOS)
struct VideoSurface: NSViewRepresentable {
    let player: Player
    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.black.cgColor
        attach(to: container)
        return container
    }
    func updateNSView(_ nsView: NSView, context: Context) { attach(to: nsView) }
    private func attach(to container: NSView) {
        let v = player.videoView
        guard v.superview != container else { return }
        v.removeFromSuperview()
        v.frame = container.bounds
        v.autoresizingMask = [.width, .height]
        container.addSubview(v)
    }
}
#else
struct VideoSurface: UIViewRepresentable {
    let player: Player
    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .black
        attach(to: container)
        return container
    }
    func updateUIView(_ uiView: UIView, context: Context) { attach(to: uiView) }
    private func attach(to container: UIView) {
        let v = player.videoView
        guard v.superview != container else { return }
        v.removeFromSuperview()
        v.frame = container.bounds
        v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(v)
    }
}
#endif
