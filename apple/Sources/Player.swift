import SwiftUI
import VLCKitSPM
#if canImport(UIKit)
import UIKit
#endif

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
    /// True while a channel change is buffering behind the frozen frame — the
    /// guide waits on this so it doesn't dismiss before the new channel is up.
    @Published var switching = false
    @Published var muted = false
    @Published var captionsOn = false

    private var pendingSwap = false
    private var pendingSince: Date?
    private var poll: Timer?
    #if os(macOS)
    /// Held for the app's life so the display never sleeps mid-broadcast — a TV
    /// stays on. Released on deinit.
    private var awakeToken: NSObjectProtocol?
    #endif
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
            // the buffering gap). normvol levels loudness between shows; a LONG
            // averaging window (~4s vs the old ~200ms) corrects slow program-to-
            // program level differences without pumping on dialogue transients —
            // the earlier short window is what made it "feel off."
            let p = VLCMediaPlayer(options: [
                "--network-caching=4000",
                "--audio-filter=normvol",
                "--norm-buff-size=200",
                "--norm-max-level=2.0",
            ])
            p.drawable = v
            return p
        }
        poll = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in self.tick() }
        }

        // Keep the display awake — a television doesn't dim itself while it's on.
        #if os(macOS)
        awakeToken = ProcessInfo.processInfo.beginActivity(
            options: [.idleDisplaySleepDisabled, .userInitiated], reason: "dumbTV is a television")
        #elseif canImport(UIKit)
        UIApplication.shared.isIdleTimerDisabled = true
        #endif
    }

    deinit {
        #if os(macOS)
        if let awakeToken { ProcessInfo.processInfo.endActivity(awakeToken) }
        #endif
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
                applyAudioSubtitle(vlcs[front])   // carry mute/captions to the new stream
            }
        }
        switching = pendingSwap
    }

    private func applyAudioSubtitle(_ p: VLCMediaPlayer) {
        p.audio?.isMuted = muted
        if captionsOn {
            let idxs = (p.videoSubTitlesIndexes as? [NSNumber])?.map { $0.intValue } ?? []
            if let first = idxs.first(where: { $0 >= 0 }) { p.currentVideoSubTitleIndex = Int32(first) }
        } else {
            p.currentVideoSubTitleIndex = -1
        }
    }

    func toggleMute() {
        muted.toggle()
        vlcs.forEach { $0.audio?.isMuted = muted }
    }

    /// Best-effort captions: enable the first subtitle track if the file has one.
    func toggleCaptions() {
        captionsOn.toggle()
        vlcs.forEach { applyAudioSubtitle($0) }
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
            switching = true       // set now, not on the next tick — the guide-tune
            pendingSince = Date()  // waiter polls faster than the 0.25s poll fires
        } else {
            // Nothing on screen yet (cold start / bars) — tune directly.
            pendingSwap = false
            pendingSince = nil
            vlcs[1 - front].stop()
            vlcs[front].stop()
            vlcs[front].media = media
            vlcs[front].play()
            applyAudioSubtitle(vlcs[front])
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
        // Size the ident footer to a fraction of the height (like the web bars'
        // 26% foot) so it looks right both full-screen and in the guide's small
        // video thumbnail, instead of a fixed 130pt that dominated the thumbnail.
        GeometryReader { geo in
            let footerH = min(geo.size.height * 0.5, max(46, geo.size.height * 0.24))
            let titleSize = max(13, min(28, footerH * 0.34))
            VStack(spacing: 0) {
                HStack(spacing: 0) { ForEach(bars.indices, id: \.self) { bars[$0] } }
                VStack(spacing: footerH * 0.1) {
                    Text(title)
                        .font(Palette.display(titleSize)).foregroundStyle(Palette.amber)
                    Text(message)
                        .font(Palette.mono(max(9, titleSize * 0.5))).foregroundStyle(Palette.dim)
                }
                .frame(maxWidth: .infinity)
                .frame(height: footerH)
                .background(Color.black)
            }
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
