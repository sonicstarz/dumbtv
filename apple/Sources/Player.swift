import SwiftUI
import VLCKitSPM

#if os(macOS)
typealias PlatformView = NSView
#else
typealias PlatformView = UIView
#endif

/// Owns TWO VLCMediaPlayers in a front/back pair. The front one is on screen;
/// a channel change freezes it on its last frame, opens the new stream on the
/// back player, and hard-cuts the moment the new stream has a decoded frame —
/// like a real cable box, no colour bars and no black between channels.
/// VLCKit direct-plays anything (.avi/.mkv) with instant seek and no
/// transcoding; join-in-progress is the `:start-time` option.
@MainActor
final class Player: ObservableObject {
    let vlcs: [VLCMediaPlayer]
    /// One persistent drawable per player, set once and never reassigned —
    /// re-parenting the same view keeps the video output alive (a fresh
    /// drawable would drop it, which is what caused black-after-switch).
    let views: [PlatformView]
    /// Which player is on screen (its view is visible, the other hidden).
    @Published var front = 0
    @Published var state: String = "—"
    /// True once the on-screen player has a frame up — colour bars cover the
    /// cold-start/buffering gap so raw black never shows (invariant #7).
    @Published var videoActive = false

    private var pendingSwap = false
    private var pendingSince: Date?
    private var poll: Timer?
    /// If the incoming channel can't produce a frame in this long, cut over
    /// anyway — the bars + "please stand by" are more honest than a stale freeze.
    private let swapTimeout: TimeInterval = 15

    init() {
        func makeView() -> PlatformView {
            #if os(macOS)
            let v = NSView(); v.wantsLayer = true
            v.layer?.backgroundColor = NSColor.black.cgColor
            return v
            #else
            let v = UIView(); v.backgroundColor = .black
            return v
            #endif
        }
        views = [makeView(), makeView()]
        vlcs = views.map { v in
            // network-caching smooths WAN streaming (the freeze-and-swap hides
            // the buffering gap). normvol levels loudness so one show isn't a
            // whisper and the next a shout — 1990s cable had a compressor too.
            let p = VLCMediaPlayer(options: [
                "--network-caching=4000",
                "--audio-filter=normvol",
                "--norm-buff-size=10",
                "--norm-max-level=1.6",
            ])
            p.drawable = v
            return p
        }
        poll = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in self.tick() }
        }
    }

    private func tick() {
        state = VLCMediaPlayerStateToString(vlcs[front].state) ?? "?"
        videoActive = vlcs[front].hasVideoOut
        if pendingSwap {
            let back = 1 - front
            let timedOut = pendingSince.map { Date().timeIntervalSince($0) > swapTimeout } ?? false
            if vlcs[back].hasVideoOut || timedOut {
                vlcs[front].stop()
                front = back
                pendingSwap = false
                pendingSince = nil
            }
        }
    }

    /// Tune: open the URL and seek `startSeconds` in (join-in-progress).
    /// If a picture is already up, it freezes until the new stream is ready.
    func play(url: URL, startSeconds: Int) {
        let media = VLCMedia(url: url)
        if startSeconds > 0 { media.addOption(":start-time=\(startSeconds)") }

        if vlcs[front].hasVideoOut {
            // Freeze what's on (pause = silent, last frame stays), bring the
            // new channel up behind it, and cut over once it has a frame.
            if vlcs[front].isPlaying { vlcs[front].pause() }
            let back = 1 - front
            vlcs[back].stop()          // clear any earlier half-loaded tune
            vlcs[back].media = media
            vlcs[back].play()
            pendingSwap = true
            pendingSince = Date()
        } else {
            // Nothing on screen yet (cold start / bars) — tune directly.
            pendingSwap = false
            pendingSince = nil
            vlcs[1 - front].stop()
            vlcs[front].stop()
            vlcs[front].media = media
            vlcs[front].play()
        }
    }

    func stop() { vlcs.forEach { $0.stop() }; pendingSwap = false }
}

/// Both players' persistent views live in ONE container; the visible one is
/// chosen by z-order (front on top, fully covering the other). Both keep
/// decoding, so the freeze-and-swap is a clean cut. Passing `front` in makes
/// SwiftUI re-run the representable's update on every swap — that re-parent is
/// exactly what the guide toggle did, which is why the guide "fixed" the black.
struct VideoLayer: View {
    @ObservedObject var player: Player
    var body: some View {
        ZStack {
            VideoSurface(player: player, front: player.front)
            if !player.videoActive { ColorBars().transition(.opacity) }
        }
        .animation(.easeInOut(duration: 0.2), value: player.videoActive)
    }
}

/// Colour bars exactly like the web TV's: a strip of bars over a black footer
/// with a station ident. Shown only when there is no picture at all.
struct ColorBars: View {
    var title: String = "PLEASE STAND BY"
    var message: String = "One moment — tuning"
    private let bars: [Color] = [
        Color(red: 0.75, green: 0.75, blue: 0.75), Color(red: 0.75, green: 0.75, blue: 0),
        Color(red: 0, green: 0.75, blue: 0.75), Color(red: 0, green: 0.75, blue: 0),
        Color(red: 0.75, green: 0, blue: 0.75), Color(red: 0.75, green: 0, blue: 0),
        Color(red: 0, green: 0, blue: 0.75),
    ]
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) { ForEach(bars.indices, id: \.self) { bars[$0] } }
            VStack(spacing: 10) {
                Text(title)
                    .font(Palette.display(26)).foregroundStyle(Palette.amber)
                Text(message)
                    .font(Palette.mono(13)).foregroundStyle(Palette.dim)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 130)
            .background(Color.black)
        }
        .ignoresSafeArea()
    }
}

/// Hosts BOTH persistent video views in a single container and orders them so
/// the `front` player's view is on top. The drawable objects never change, so
/// the video output survives every re-parent (watch ↔ guide) and every swap.
/// `front` is a stored input: when it changes, SwiftUI re-runs update and the
/// new front view comes to the top — a hard cut, no black, no opacity games.
#if os(macOS)
struct VideoSurface: NSViewRepresentable {
    let player: Player
    let front: Int
    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.black.cgColor
        arrange(container)
        return container
    }
    func updateNSView(_ container: NSView, context: Context) { arrange(container) }
    private func arrange(_ container: NSView) {
        for v in player.views where v.superview !== container {
            v.removeFromSuperview()
            v.frame = container.bounds
            v.autoresizingMask = [.width, .height]
            container.addSubview(v)
        }
        // Front view to the top; the other stays behind, still decoding.
        container.addSubview(player.views[front], positioned: .above, relativeTo: nil)
    }
}
#else
struct VideoSurface: UIViewRepresentable {
    let player: Player
    let front: Int
    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .black
        arrange(container)
        return container
    }
    func updateUIView(_ container: UIView, context: Context) { arrange(container) }
    private func arrange(_ container: UIView) {
        for v in player.views where v.superview !== container {
            v.removeFromSuperview()
            v.frame = container.bounds
            v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            container.addSubview(v)
        }
        container.bringSubviewToFront(player.views[front])
    }
}
#endif
