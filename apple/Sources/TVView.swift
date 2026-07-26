import SwiftUI
import dumbTVCore

/// A bar that empties over the dial-commit window, so a partial channel number
/// visibly counts down instead of silently jumping. Restarted per digit via
/// `.id(dialing)` on the caller.
struct DialCountdown: View {
    let scale: CGFloat
    @State private var empty = false
    var body: some View {
        GeometryReader { geo in
            Rectangle().fill(Palette.amber)
                .frame(width: geo.size.width)
                .scaleEffect(x: empty ? 0 : 1, anchor: .leading)
        }
        .frame(height: 4 * scale)
        .onAppear { withAnimation(.linear(duration: 1.5)) { empty = true } }
    }
}

struct TVView: View {
    @ObservedObject var engine: Engine
    /// Where to configure this device (shown as a QR + URL until it's set up).
    var configURL: String? = nil
    /// App/server self-report, shown on channel 00 when the server is down.
    @ObservedObject var diag: SystemDiagnostics

    var body: some View {
        GeometryReader { geo in
            // One UI scale for the whole screen so the text reads like a TV at
            // any window size (the reference design is ~800pt tall).
            let s = max(0.7, min(2.2, geo.size.height / 800))
            ZStack {
                Color.black.ignoresSafeArea()
                // A2: the guide renders ABOVE the setup channel. Opening the
                // guide from channel 00 used to flip guideOpen but keep drawing
                // the setup screen (the guide opened invisibly), which is why
                // "double-tap/select for the guide" appeared to do nothing.
                if engine.guideOpen {
                    guideLayout(s: s)
                } else if engine.onSetupChannel {
                    setupChannelLayout(s: s)
                } else {
                    watchLayout(s: s)
                }
                #if os(iOS)
                // First-launch: explain the iOS "connect to devices on your
                // network" prompt that's about to appear, and say to allow it.
                if engine.showLanExplainer {
                    LanExplainer(s: s) { engine.dismissLanExplainer() }
                        .transition(.opacity)
                }
                #endif
            }
            .animation(.easeInOut(duration: 0.25), value: engine.showLanExplainer)
        }
        // Focus + keyboard/remote input is macOS/tvOS only (iOS uses the swipe
        // gesture below). Keeping these off iOS lets the iOS deployment target
        // drop below 17 — .focusable()/.onKeyPress are iOS 17+.
        #if os(tvOS) || os(macOS)
        .focusable()
        .onMoveCommand { direction in
            if engine.guideOpen {
                switch direction {
                case .up:    engine.guideMove(-1)
                case .down:  engine.guideMove(+1)
                case .left:  engine.guideShiftHalfHours(-1)   // scroll the axis back
                case .right: engine.guideShiftHalfHours(+1)   // …and forward, by 30 min
                @unknown default: break
                }
            } else {
                switch direction {
                case .up:    engine.channelUp()
                case .down:  engine.channelDown()
                case .left, .right: engine.blocked()   // no seeking on live TV
                @unknown default: break
                }
            }
        }
        .onExitCommand { if engine.guideOpen { engine.guideOpen = false } }   // Esc / Menu closes the guide
        #endif
        #if os(tvOS)
        // B3 — the owner's remote spec (simpler than the old two-step):
        //   up/down = change channel (onMoveCommand; the banner auto-appears on tune)
        //   SELECT  = open the guide directly; in the guide, tune the highlighted row
        //   back/menu = dismiss the guide (onExitCommand above)
        .onTapGesture {
            if engine.guideOpen { engine.guideSelect() } else { engine.toggleGuide() }
        }
        #endif
        #if os(tvOS) || os(macOS)
        .onKeyPress { press in
            engine.showBanner()
            let ch = press.characters
            // Guide: G always (web muscle-memory), and 1 when you're not part-way
            // through dialing — so a leading 1 opens the guide (there's no ch 1),
            // but a trailing 1 (e.g. "21") still dials. Every other channel is
            // reachable in the guide with the arrows.
            if ch == "g" || ch == "G" { engine.toggleGuide(); return .handled }
            if ch == "1" && engine.dialing.isEmpty { engine.toggleGuide(); return .handled }
            if press.key == .return { if engine.guideOpen { engine.guideSelect() }; return .handled }
            if press.key == .escape { if engine.guideOpen { engine.guideOpen = false }; return .handled }
            // Space bar = bring up channel info (banner + Guide/Mute/CC), the
            // Mac equivalent of a tap. The banner is already revealed at the top
            // of this handler; just swallow the key so it doesn't also ⊘.
            if ch == " " { return .handled }
            if !engine.guideOpen, let c = ch.first, c.isNumber { engine.pressDigit(String(c)); return .handled }
            return .ignored
        }
        #endif
        #if os(tvOS)
        .onPlayPauseCommand { engine.blocked() }
        #endif
        // iOS touch input lives on the transparent catcher inside watchLayout
        // (above the video, below the controls) — a root-level gesture here was
        // swallowed by VLCKit's video view, which is why tapping did nothing.
        // The guide has its own row taps. macOS uses the space bar (below).
        //
        // B2: a layout swap re-parents the persistent video views; re-attach the
        // drawables just after so a same-channel guide dismiss doesn't go black.
        .onChange(of: engine.guideOpen) { _ in reattachVideoSoon() }
        .onChange(of: engine.onSetupChannel) { _ in reattachVideoSoon() }
    }

    private func reattachVideoSoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
            engine.player.reattachDrawables()
        }
    }

    // Full-screen video with the channel banner and a GUIDE button.
    private func watchLayout(s: CGFloat) -> some View {
        ZStack {
            // The video never takes touches — VLCKit's UIView would otherwise
            // swallow every tap, which is exactly why "tap for channel info"
            // did nothing. All touch input rides the transparent catcher below.
            VideoLayer(player: engine.player).ignoresSafeArea()
                .allowsHitTesting(false)

            #if os(iOS)
            // Touch input on a dedicated transparent layer ABOVE the video but
            // BELOW the banner/controls (so the control-row buttons still get
            // their own taps). Double-tap = channel info; vertical swipe =
            // channel change; a horizontal swipe would be a seek, so it no-ops
            // with ⊘ (invariant #1).
            Color.clear.contentShape(Rectangle()).ignoresSafeArea()
                .onTapGesture(count: 2) { engine.showBanner() }
                .gesture(
                    DragGesture(minimumDistance: 40).onEnded { v in
                        if abs(v.translation.height) > abs(v.translation.width) {
                            v.translation.height < 0 ? engine.channelUp() : engine.channelDown()
                        } else {
                            engine.blocked()
                        }
                    }
                )
            #endif

            // Direct channel entry (top-right, like a real box), and the ⊘ /
            // channel-change flash (centre).
            // Channel digits — Archivo Black on the dark band, square, like the
            // web TV's #digits.
            if !engine.dialing.isEmpty {
                VStack(spacing: 8 * s) {
                    Text(engine.dialing)
                        .font(Palette.display(56 * s))
                        .foregroundStyle(Palette.amber).tracking(4)
                    // A depleting bar so you can SEE the ~1.5s commit window —
                    // kids stop mashing and end up on the channel, not ⊘.
                    // .id(dialing) remounts it on each digit, restarting the run.
                    DialCountdown(scale: s).id(engine.dialing)
                        .frame(width: 118 * s)
                }
                .padding(.horizontal, 26 * s).padding(.vertical, 14 * s)
                .fixedSize()
                .background(Palette.band)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                .padding(48 * s)
            }
            // ⊘ / CH flash — plain giant glyph with a glow, no chip (web #nope).
            if let f = engine.flash {
                Text(f)
                    .font(Palette.display(88 * s))
                    .foregroundStyle(.white.opacity(0.85))
                    .shadow(color: .black.opacity(0.9), radius: 15)
            }
            VStack {
                HStack {
                    if engine.demo {
                        Text("DEMO")
                            .font(Palette.mono(11, .bold))
                            .foregroundStyle(.black)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(Palette.amber)
                    }
                    if engine.kidsMode {
                        Text("KIDS")
                            .font(Palette.mono(11, .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(Palette.prevue1)
                    }
                    Spacer()
                    // No GUIDE button here any more — on phone/tablet/Mac a tap
                    // reveals the control row (Guide/Mute/CC) over the banner; on
                    // tvOS the whole picture is the guide button (press select).
                }
                if engine.setupCardVisible, let url = configURL {
                    HStack { SetupCard(url: url, showChannelHint: true); Spacer() }
                        .padding(.top, 10)
                }
                Spacer()
                // One-time coach mark — the guide is invisible until you know
                // the key, so say it once, then never again.
                if engine.showGuideHint {
                    HStack {
                        #if os(tvOS)
                        Text("PRESS SELECT FOR THE GUIDE")
                        #elseif os(macOS)
                        Text("PRESS  G  FOR THE GUIDE · SPACE FOR INFO")
                        #else
                        Text("DOUBLE-TAP FOR INFO & THE GUIDE")
                        #endif
                        Spacer()
                    }
                    .font(Palette.mono(13 * s, .bold))
                    .foregroundStyle(Palette.amber).tracking(2)
                    .padding(.bottom, 8 * s)
                    .transition(.opacity)
                }
            }
            .padding(.horizontal, 24 * s)
            .padding(.top, 12 * s)
            .padding(.bottom, 120 * s)   // keep the hint clear of the banner
            .animation(.easeInOut(duration: 0.4), value: engine.showGuideHint)

            // The banner reveals on a channel/program change or a key press, then
            // fades so the picture is unobstructed. A wide lower-third band. On
            // phone/tablet/Mac a tap-revealed control row (Guide/Mute/CC) rides
            // just above it — the only way in to the guide now that the button's gone.
            VStack(spacing: 12 * s) {
                Spacer()
                #if !os(tvOS)
                if engine.bannerVisible {
                    HStack {
                        Spacer()
                        ControlBar(engine: engine, player: engine.player, s: s)
                    }
                    .transition(.opacity)
                }
                #endif
                if engine.bannerVisible {
                    if let airing = engine.now {
                        BannerView(engine: engine, airing: airing, s: s)
                            .transition(.opacity)
                    } else if !engine.status.isEmpty {
                        Text(engine.status)
                            .font(.system(.headline, design: .monospaced))
                            .foregroundStyle(Palette.dim)
                            .padding(.bottom, 40 * s)
                    }
                }
            }
            .padding(.horizontal, 28 * s)
            .padding(.bottom, 36 * s)
            .animation(.easeInOut(duration: 0.3), value: engine.bannerVisible)
        }
    }

    // Channel 00 — the setup screen. Always reachable (dial 0, or the top row of
    // the guide) so the QR + setup URL can be brought back after Plex is linked
    // and the demo card is gone. Works whether or not anything is configured.
    private func setupChannelLayout(s: CGFloat) -> some View {
        ZStack {
            Color.black.ignoresSafeArea()

            #if os(iOS)
            // Touch: double-tap opens the guide (to pick a channel), a vertical
            // swipe changes channel — the ways off the setup screen on a phone.
            Color.clear.contentShape(Rectangle()).ignoresSafeArea()
                .onTapGesture(count: 2) { engine.toggleGuide() }
                .gesture(
                    DragGesture(minimumDistance: 40).onEnded { v in
                        if abs(v.translation.height) > abs(v.translation.width) {
                            v.translation.height < 0 ? engine.channelUp() : engine.channelDown()
                        }
                    }
                )
            #endif

            VStack(spacing: 22 * s) {
                Text("00  SETUP")
                    .font(Palette.display(40 * s)).foregroundStyle(Palette.amber).tracking(3)
                // Server healthy → the scannable QR + URL. Server down → an
                // on-screen diagnostics block instead of a useless sentence, so a
                // single TestFlight photo says exactly what failed (build 11).
                if let url = configURL, diag.storeOpened {
                    SetupCard(url: url)
                } else {
                    diagnosticsBlock(s: s)
                }
                Group {
                    #if os(iOS)
                    Text("Double-tap for the guide · swipe to change channel")
                    #elseif os(tvOS)
                    Text("Press select for the guide · arrows change the channel")
                    #else
                    Text("Press G for the guide · ↑ ↓ change the channel")
                    #endif
                }
                .font(Palette.mono(13 * s)).foregroundStyle(Palette.dim)
                .multilineTextAlignment(.center)
            }
            .padding(30 * s)
        }
    }

    // On-screen evidence when the config server isn't reachable — replaces the
    // old unhelpful fallback sentence. Distinguishes the tvOS failure modes:
    // store-write failure vs bind failure vs a boot hang (N6).
    private func diagnosticsBlock(s: CGFloat) -> some View {
        func row(_ k: String, _ v: String, bad: Bool = false) -> some View {
            HStack(alignment: .top, spacing: 10 * s) {
                Text(k).foregroundStyle(Palette.dim).frame(width: 92 * s, alignment: .leading)
                Text(v).foregroundStyle(bad ? Palette.tally : .white)
                    .lineLimit(2).minimumScaleFactor(0.6)
            }
        }
        return VStack(alignment: .leading, spacing: 7 * s) {
            Text("SETUP SERVER UNAVAILABLE")
                .font(Palette.mono(14 * s, .bold)).foregroundStyle(Palette.tally).tracking(2)
            row("platform", diag.platform)
            if diag.storeOpened {
                row("store", "open")
            } else {
                row("store", "FAILED — \(diag.storeError ?? "unknown")", bad: true)
            }
            row("db path", diag.storePath)
            row("server", diag.serverState + (diag.serverPort > 0 ? " :\(diag.serverPort)" : ""),
                bad: !diag.serverState.hasPrefix("listening"))
            row("config url", diag.configURL ?? "—", bad: diag.configURL == nil)
            row("lan ip", diag.lanIP)
            row("boot", engine.bootStage)
            row("channels", "\(engine.channels.count)  ·  playing: \(engine.now?.program.title ?? "—")")
            row("player", engine.player.state)
        }
        .font(Palette.mono(13 * s))
        .padding(18 * s)
        .background(Color.black.opacity(0.6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.tally.opacity(0.5), lineWidth: 2))
        .frame(maxWidth: 640 * s)
    }

    // Top: the live picture beside a NOW PLAYING panel, on black. Bottom: the
    // blue grid guide, full-bleed to the edges — the reference layout.
    private func guideLayout(s: CGFloat) -> some View {
        GeometryReader { geo in
            VStack(spacing: 14 * s) {
                HStack(spacing: 16 * s) {
                    VideoLayer(player: engine.player)
                        .aspectRatio(16.0 / 9.0, contentMode: .fit)
                        .border(Palette.amber, width: 3)
                    NowPlayingPanel(engine: engine, s: s)
                }
                .frame(height: geo.size.height * 0.34)
                .padding(.horizontal, 16 * s)
                .padding(.top, 14 * s)

                GuideView(engine: engine, s: s)
            }
        }
    }
}

/// The channel banner — a wide lower-third band: big amber channel number and
/// name, the programme title, and a right column of clock / air-time / NEXT.
struct BannerView: View {
    @ObservedObject var engine: Engine
    let airing: Airing
    var s: CGFloat = 1

    private var episodeTag: String {
        guard let se = airing.program.seasonNo, let ep = airing.program.episodeNo else { return "" }
        return String(format: "S%02dE%02d  ", se, ep)
    }

    var body: some View {
        HStack(spacing: 0) {
            Rectangle().fill(Palette.amber).frame(width: 6 * s)
            HStack(alignment: .center, spacing: 0) {
                VStack(alignment: .leading, spacing: 10 * s) {
                    HStack(alignment: .firstTextBaseline, spacing: 16 * s) {
                        Text(String(format: "%02d", engine.channelNumber))
                            .font(Palette.display(46 * s)).foregroundStyle(Palette.amber)
                        Text(engine.channelName.uppercased())
                            .font(Palette.mono(19 * s, .semibold)).foregroundStyle(Palette.dim)
                            .tracking(4 * s)
                    }
                    Text(airing.program.title)
                        .font(.system(size: 36 * s, weight: .semibold)).foregroundStyle(Palette.tape)
                        .lineLimit(1).minimumScaleFactor(0.6)
                    if let sub = airing.program.subtitle {
                        Text(episodeTag + sub)
                            .font(.system(size: 20 * s)).foregroundStyle(Palette.dim)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 24 * s)
                VStack(alignment: .trailing, spacing: 12 * s) {
                    Text(hhmm(engine.wallClock))
                        .font(Palette.mono(26 * s, .semibold)).foregroundStyle(.white)
                    Text("\(hhmm(airing.program.startUtc)) – \(hhmm(airing.program.endUtc))")
                        .font(Palette.mono(19 * s, .semibold)).foregroundStyle(Palette.amber)
                    if let n = engine.nextUp {
                        HStack(spacing: 10 * s) {
                            Text("NEXT").foregroundStyle(Palette.dim)
                            Text(n.title).foregroundStyle(Palette.tape)
                        }
                        .font(Palette.mono(17 * s, .semibold))
                        .lineLimit(1)
                    }
                }
            }
            .padding(.horizontal, 30 * s).padding(.vertical, 22 * s)
        }
        .frame(maxWidth: .infinity)
        // Hug the content height — without this the amber bar (a greedy
        // Rectangle) stretches the band to fill the whole screen.
        .fixedSize(horizontal: false, vertical: true)
        // rgba(6,6,10,.82), square — the web TV's banner band, no rounding.
        .background(Palette.band)
    }
}

#if os(iOS)
/// A one-time card that pre-empts iOS's own "dumbTV would like to find and
/// connect to devices on your local network" permission prompt: it tells the
/// user that prompt is coming and that tapping Allow is what lets the TV reach
/// Plex and serve its setup page. Denying the system prompt breaks setup, so
/// this exists to make sure they say yes.
struct LanExplainer: View {
    var s: CGFloat = 1
    let onDismiss: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.72).ignoresSafeArea()
                .onTapGesture { onDismiss() }
            VStack(spacing: 18 * s) {
                Image(systemName: "wifi")
                    .font(.system(size: 40 * s, weight: .bold))
                    .foregroundStyle(Palette.amber)
                Text("ALLOW LOCAL NETWORK")
                    .font(Palette.display(24 * s)).foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                Text("iOS is about to ask if dumbTV can find and connect to devices on your network. Tap **Allow**.")
                    .font(Palette.mono(15 * s))
                    .foregroundStyle(Palette.tape)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                Text("That's how the TV reaches your Plex server and shows its setup page on your phone or laptop. Without it, setup can't connect.")
                    .font(Palette.mono(13 * s))
                    .foregroundStyle(Palette.dim)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                Button(action: onDismiss) {
                    Text("GOT IT")
                        .font(Palette.mono(15 * s, .bold)).tracking(3)
                        .foregroundStyle(.black)
                        .padding(.horizontal, 34 * s).padding(.vertical, 12 * s)
                        .background(Palette.amber)
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                }
                .buttonStyle(.plain)
                .padding(.top, 4 * s)
            }
            .padding(30 * s)
            .frame(maxWidth: 420 * s)
            .background(Palette.band)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.amber.opacity(0.4), lineWidth: 2))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .padding(28 * s)
        }
    }
}
#endif

#if !os(tvOS)
/// The tap-revealed control row on phone/tablet/Mac: Guide, Mute, and Captions.
/// Replaces the old always-on GUIDE button — it rides above the channel banner
/// and fades with it. Observes `Player` so Mute/CC reflect their live state.
struct ControlBar: View {
    @ObservedObject var engine: Engine
    @ObservedObject var player: Player
    var s: CGFloat = 1

    var body: some View {
        HStack(spacing: 10 * s) {
            button("GUIDE", "tv.inset.filled", active: false) { engine.toggleGuide() }
            button(player.muted ? "MUTED" : "MUTE",
                   player.muted ? "speaker.slash.fill" : "speaker.wave.2.fill",
                   active: player.muted) { engine.toggleMute() }
            button("CC", "captions.bubble.fill", active: player.captionsOn) { engine.toggleCaptions() }
        }
    }

    private func button(_ title: String, _ icon: String, active: Bool,
                        _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 7 * s) {
                Image(systemName: icon).font(.system(size: 13 * s, weight: .bold))
                Text(title).font(Palette.mono(12 * s, .bold)).tracking(2)
            }
            .foregroundStyle(active ? Color.black : Palette.amber)
            .padding(.horizontal, 14 * s).padding(.vertical, 9 * s)
            .background(active ? Palette.amber : Palette.band)
            .clipShape(RoundedRectangle(cornerRadius: 4))
        }
        .buttonStyle(.plain)
    }
}
#endif
