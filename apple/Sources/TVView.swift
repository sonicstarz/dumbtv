import SwiftUI
import dumbTVCore

struct TVView: View {
    @ObservedObject var engine: Engine
    /// Where to configure this device (shown as a QR + URL until it's set up).
    var configURL: String? = nil

    var body: some View {
        GeometryReader { geo in
            // One UI scale for the whole screen so the text reads like a TV at
            // any window size (the reference design is ~800pt tall).
            let s = max(0.7, min(2.2, geo.size.height / 800))
            ZStack {
                Color.black.ignoresSafeArea()
                if engine.guideOpen {
                    guideLayout(s: s)
                } else {
                    watchLayout(s: s)
                }
            }
        }
        .focusable()
        #if os(tvOS) || os(macOS)
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
        // The Siri remote has no keyboard, so the centre button IS the guide:
        // press it while watching to open the guide, press it on a channel to
        // tune. Arrows navigate; Menu closes. (Needs an on-device/sim pass.)
        .onTapGesture { engine.guideOpen ? engine.guideSelect() : engine.toggleGuide() }
        #endif
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
            if ch == " " { engine.blocked(); return .handled }                          // no pause
            if !engine.guideOpen, let c = ch.first, c.isNumber { engine.pressDigit(String(c)); return .handled }
            return .ignored
        }
        #if os(tvOS)
        .onPlayPauseCommand { engine.blocked() }
        #endif
        #if os(iOS)
        // Touch: swipe up/down to change channel; a horizontal swipe would be a
        // seek, so it no-ops with ⊘ (invariant #1). Disabled while the guide is
        // open so a swipe there navigates the guide, not the channel underneath.
        .gesture(
            DragGesture(minimumDistance: 40).onEnded { v in
                guard !engine.guideOpen else { return }
                if abs(v.translation.height) > abs(v.translation.width) {
                    v.translation.height < 0 ? engine.channelUp() : engine.channelDown()
                } else {
                    engine.blocked()
                }
            }
        )
        #endif
    }

    // Full-screen video with the channel banner and a GUIDE button.
    private func watchLayout(s: CGFloat) -> some View {
        ZStack {
            VideoLayer(player: engine.player).ignoresSafeArea()

            // Direct channel entry (top-right, like a real box), and the ⊘ /
            // channel-change flash (centre).
            // Channel digits — Archivo Black on the dark band, square, like the
            // web TV's #digits.
            if !engine.dialing.isEmpty {
                Text(engine.dialing)
                    .font(Palette.display(56 * s))
                    .foregroundStyle(Palette.amber).tracking(4)
                    .padding(.horizontal, 26 * s).padding(.vertical, 12 * s)
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
                    Spacer()
                    Button { engine.guideOpen = true } label: {
                        Text("GUIDE")
                            .font(Palette.mono(12, .bold))
                            .foregroundStyle(Palette.amber).tracking(2)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(Palette.band)
                    }
                }
                if engine.demo, let url = configURL {
                    HStack { SetupCard(url: url); Spacer() }
                        .padding(.top, 10)
                }
                Spacer()
            }
            .padding(.horizontal, 24 * s)
            .padding(.top, 12 * s)

            // The banner reveals on a channel/program change or a key press, then
            // fades so the picture is unobstructed. A wide lower-third band.
            VStack {
                Spacer()
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
