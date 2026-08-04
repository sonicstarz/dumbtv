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
    #else
    /// didBecomeActive observer that re-asserts the idle-timer flag (tvOS/iOS).
    private var idleObserver: NSObjectProtocol?
    #endif
    /// How many times the idle-timer flag has had to be set because it was
    /// found cleared. 1 is the expected value (the initial set at launch).
    /// Surfaced on channel 00 — see `keepAwake()`.
    @Published private(set) var idleReasserts = 0
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
            // the buffering gap).
            //
            // AUDIO: WE DO NOTHING TO IT. Both things that used to be here were
            // wrong, and the symptom was audio that sounded hollow and thin, "like
            // one channel got phase flipped."
            //
            // 1. force-dolby-surround defaults to AUTO, and that is almost
            //    certainly what caused it. When VLC decides a stream is Dolby
            //    Surround encoded — which it guesses, and guesses wrong on plain
            //    stereo — it applies Pro Logic matrix decoding, and that inverts
            //    phase on the surround-derived channel by design. Pinned OFF (2).
            //    Nothing we play is matrix-encoded; there is no upside to letting
            //    it guess.
            //
            // 2. `--audio-filter=normvol` is gone. It levelled loudness across
            //    programmes, but: norm-buff-size is a COUNT OF AUDIO BUFFERS
            //    (VLC default 20), not milliseconds — the old comment here
            //    claimed 200 meant "~4s" and that is simply not what the knob is.
            //    And norm-max-level=2.0 let it AMPLIFY up to 2x with no limiter
            //    behind it, so anything already near full scale clipped. It was
            //    also applied to everything, when the only case that ever wanted
            //    it was commercials (see "loudness normalisation on commercials"
            //    in the roadmap — still a later item, and it belongs at pack-build
            //    time, not in the player).
            //
            // Direct play, untouched audio. Same rule as invariant #2 for video.
            let p = VLCMediaPlayer(options: [
                "--network-caching=4000",
                "--force-dolby-surround=2",
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
        keepAwake()
        // Re-assert when the app becomes active. Setting the flag once from an
        // initializer is not enough: `Player()` is built as a stored property of
        // Engine, which runs before the app is necessarily active, and the flag
        // does not reliably take hold that early. Nothing else in the app
        // observed the lifecycle at all, so once it was lost it stayed lost.
        idleObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil, queue: .main
        ) { _ in MainActor.assumeIsolated { UIApplication.shared.isIdleTimerDisabled = true } }
        #endif
    }

    #if canImport(UIKit) && !os(macOS)
    /// Stop tvOS/iOS putting up the screen saver over a channel that is playing.
    ///
    /// THE SCREEN SAVER APPEARED OVER LIVE VIDEO on a real Apple TV: with no
    /// remote input for a few minutes, tvOS drew its screen saver while the
    /// programme carried on playing and the audio kept going, which is about the
    /// least television-like thing the app could do.
    ///
    /// tvOS suppresses the screen saver automatically for AVPlayer-backed
    /// playback, and it cannot tell that a third-party renderer (VLCKit, drawing
    /// into a plain view) is showing a picture — so `isIdleTimerDisabled` is the
    /// only lever, and it has to actually STAY set. It is re-asserted here, on
    /// didBecomeActive, and defensively from the 0.25s tick, because the system
    /// can clear it and a one-shot assignment silently stops being true.
    private func keepAwake() {
        if !UIApplication.shared.isIdleTimerDisabled {
            UIApplication.shared.isIdleTimerDisabled = true
            // Counted, and shown on channel 00, because the fix and the
            // diagnosis are different questions. If the screen saver still
            // appears on a real Apple TV AND this reads 1, the system is not
            // clearing the flag and tvOS is simply ignoring it for a
            // non-AVPlayer renderer — which is a different problem with a
            // different answer. A number above 1 means it IS being cleared and
            // this self-heal is what is holding it.
            idleReasserts += 1
        }
    }
    #endif

    deinit {
        #if os(macOS)
        if let awakeToken { ProcessInfo.processInfo.endActivity(awakeToken) }
        #endif
    }

    private func tick() {
        state = VLCMediaPlayerStateToString(vlcs[front].state) ?? "?"
        videoActive = vlcs[front].hasVideoOut
        #if canImport(UIKit) && !os(macOS)
        // Self-heal: whatever cleared the flag (an early set that never took, a
        // system reset, an app-state transition), this puts it back within a
        // quarter second. Guarded on the current value so it is a comparison,
        // not a write, on all but the first tick after a reset.
        keepAwake()
        #endif
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

    /// Apply mute + captions to a player OFF the main thread. VLCKit's audio /
    /// subtitle setters can stall while a stream is buffering — doing them on the
    /// main actor starved SwiftUI's gesture recognizers ("double-tap stopped
    /// working, came back later") and thrashed the banner animation (B1).
    private func applyAudioSubtitle(_ p: VLCMediaPlayer) {
        let m = muted, cc = captionsOn
        DispatchQueue.global(qos: .userInitiated).async {
            p.audio?.isMuted = m
            if cc {
                let idxs = (p.videoSubTitlesIndexes as? [NSNumber])?.map { $0.intValue } ?? []
                p.currentVideoSubTitleIndex = Int32(idxs.first(where: { $0 >= 0 }) ?? -1)
            } else {
                p.currentVideoSubTitleIndex = -1
            }
        }
    }

    // Front player only — the back player is silent/hidden mid-swap, so touching
    // it is wasted work (and doubled the stall).
    func toggleMute() {
        muted.toggle()
        applyAudioSubtitle(vlcs[front])
    }

    /// Best-effort captions: enable the first subtitle track if the file has one.
    func toggleCaptions() {
        captionsOn.toggle()
        applyAudioSubtitle(vlcs[front])
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

    // There is deliberately no reattachDrawables() here. Build 12 re-asserted
    // `drawable` 0.12s after a layout swap to revive a video output that the
    // watch ⇄ guide re-parent had killed; it was treating the symptom, and it
    // raced SwiftUI's actual re-parent. Build 13 removed the re-parent instead
    // (F3): one VideoSurface is mounted at TVView's root for the app's life and
    // only its frame changes, so the output is never torn down.
}

/// Both players' persistent views live in ONE container; the visible one is
/// chosen by z-order (front on top, fully covering the other). Both keep
/// decoding, so the freeze-and-swap is a clean cut. Passing `front` in makes
/// SwiftUI re-run the representable's update on every swap.
///
/// Mount this ONCE (TVView's root ZStack). Instantiating it in two different
/// layouts gives it two SwiftUI identities, and switching between them destroys
/// one surface and re-parents the player views into the other — which VLCKit's
/// video output does not survive.
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
                        .font(Palette.meta(max(9, titleSize * 0.5))).foregroundStyle(Palette.dim)
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
/// the `front` player's view is on top. The drawable objects never change and —
/// since build 13 — neither does the container: the re-parent loop below runs
/// once, on the first arrange, and is a no-op forever after.
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
