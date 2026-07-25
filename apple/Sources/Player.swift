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

/// Both players' surfaces stacked; only the front one is visible, so the swap
/// is a single-frame hard cut. Colour bars cover cold start/buffering.
struct VideoLayer: View {
    @ObservedObject var player: Player
    var body: some View {
        ZStack {
            VideoSurface(view: player.views[0]).opacity(player.front == 0 ? 1 : 0)
            VideoSurface(view: player.views[1]).opacity(player.front == 1 ? 1 : 0)
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

/// Hosts one player's persistent video view. A fresh container is created per
/// representable, then the SAME platform view is moved into it — the drawable
/// object never changes, so VLC's video output survives every re-parent
/// (watch ↔ guide, and the front/back stack above).
#if os(macOS)
struct VideoSurface: NSViewRepresentable {
    let view: NSView
    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.black.cgColor
        attach(to: container)
        return container
    }
    func updateNSView(_ nsView: NSView, context: Context) { attach(to: nsView) }
    private func attach(to container: NSView) {
        guard view.superview != container else { return }
        view.removeFromSuperview()
        view.frame = container.bounds
        view.autoresizingMask = [.width, .height]
        container.addSubview(view)
    }
}
#else
struct VideoSurface: UIViewRepresentable {
    let view: UIView
    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .black
        attach(to: container)
        return container
    }
    func updateUIView(_ uiView: UIView, context: Context) { attach(to: uiView) }
    private func attach(to container: UIView) {
        guard view.superview != container else { return }
        view.removeFromSuperview()
        view.frame = container.bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(view)
    }
}
#endif
