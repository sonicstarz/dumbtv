import SwiftUI
import dumbTVCore

struct TVView: View {
    @ObservedObject var engine: Engine
    /// Where to configure this device (shown as a QR + URL until it's set up).
    var configURL: String? = nil

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if engine.guideOpen {
                guideLayout
            } else {
                watchLayout
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
        .onKeyPress { press in
            engine.showBanner()
            if press.characters == "1" { engine.toggleGuide(); return .handled }        // 1 = guide
            if press.key == .return { if engine.guideOpen { engine.guideSelect() }; return .handled }
            if press.characters == " " { engine.blocked(); return .handled }            // no pause
            if let c = press.characters.first, c.isNumber { engine.pressDigit(String(c)); return .handled }
            return .ignored
        }
        #if os(tvOS)
        .onPlayPauseCommand { engine.blocked() }
        #endif
        #if os(iOS)
        // Touch: swipe up/down to change channel; a horizontal swipe would be a
        // seek, so it no-ops with ⊘ (invariant #1).
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
    }

    // Full-screen video with the channel banner and a GUIDE button.
    private var watchLayout: some View {
        ZStack {
            VideoLayer(player: engine.player).ignoresSafeArea()

            // Direct channel entry (top-right, like a real box), and the ⊘ /
            // channel-change flash (centre).
            if !engine.dialing.isEmpty {
                Text(engine.dialing)
                    .font(.system(size: 64, weight: .heavy, design: .monospaced))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 28).padding(.vertical, 14)
                    .background(.black.opacity(0.6)).clipShape(RoundedRectangle(cornerRadius: 12))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .padding(40)
            }
            if let f = engine.flash {
                Text(f)
                    .font(.system(size: 68, weight: .heavy, design: .monospaced))
                    .foregroundStyle(Palette.amber)
                    .padding(30)
                    .background(.black.opacity(0.55)).clipShape(RoundedRectangle(cornerRadius: 14))
            }
            VStack {
                HStack {
                    if engine.demo {
                        Text("DEMO")
                            .font(.system(.caption2, design: .monospaced)).bold()
                            .foregroundStyle(.black)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(Palette.amber)
                            .clipShape(Capsule())
                    }
                    Spacer()
                    Button { engine.guideOpen = true } label: {
                        Text("GUIDE")
                            .font(.system(.caption, design: .monospaced)).bold()
                            .foregroundStyle(Palette.amber)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(.black.opacity(0.6))
                            .clipShape(Capsule())
                    }
                }
                if engine.demo, let url = configURL {
                    HStack { SetupCard(url: url); Spacer() }
                        .padding(.top, 10)
                }
                Spacer()
                // The banner reveals on a channel/program change or a key press,
                // then fades so the picture is unobstructed while you watch.
                if engine.bannerVisible {
                    if let airing = engine.now {
                        BannerView(engine: engine, airing: airing).transition(.opacity)
                    } else if !engine.status.isEmpty {
                        Text(engine.status)
                            .font(.system(.headline, design: .monospaced))
                            .foregroundStyle(Palette.dim)
                    }
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 12)
            .padding(.bottom, 44)
            .animation(.easeInOut(duration: 0.3), value: engine.bannerVisible)
        }
    }

    // Top: the live picture beside a NOW PLAYING panel. Bottom: the grid guide.
    private var guideLayout: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                VideoLayer(player: engine.player)
                    .aspectRatio(16.0 / 9.0, contentMode: .fit)
                    .frame(maxWidth: 460)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.amber, lineWidth: 3))
                NowPlayingPanel(engine: engine)
            }
            .frame(height: 210)
            .padding(.horizontal, 12)
            .padding(.top, 12)

            GuideView(engine: engine)
        }
        .background(
            LinearGradient(colors: [Palette.prevue1, Palette.prevue2],
                           startPoint: .top, endPoint: .bottom)
        )
    }
}

struct BannerView: View {
    @ObservedObject var engine: Engine
    let airing: Airing

    private var episodeTag: String {
        guard let s = airing.program.seasonNo, let e = airing.program.episodeNo else { return "" }
        return String(format: "S%02dE%02d  ", s, e)
    }

    var body: some View {
        HStack(spacing: 0) {
            Rectangle().fill(Palette.amber).frame(width: 5)
            VStack(alignment: .leading, spacing: 8) {
                // Row 1: channel · clock
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(String(format: "%02d", engine.channelNumber))
                        .font(.system(size: 34, weight: .heavy)).foregroundStyle(Palette.amber)
                    Text(engine.channelName.uppercased())
                        .font(.system(.caption, design: .monospaced)).foregroundStyle(Palette.dim)
                    Spacer()
                    Text(hhmm(engine.wallClock))
                        .font(.system(.caption, design: .monospaced)).foregroundStyle(Palette.dim)
                }
                // Row 2: title · time range
                HStack(alignment: .firstTextBaseline) {
                    Text(airing.program.title)
                        .font(.system(size: 24, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                    Spacer(minLength: 16)
                    Text("\(hhmm(airing.program.startUtc)) – \(hhmm(airing.program.endUtc))")
                        .font(.system(.subheadline, design: .monospaced)).foregroundStyle(Palette.amber)
                        .fixedSize()
                }
                // Row 3: episode · NEXT
                HStack(alignment: .firstTextBaseline) {
                    if let sub = airing.program.subtitle {
                        Text(episodeTag + sub).font(.subheadline).foregroundStyle(Palette.dim).lineLimit(1)
                    }
                    Spacer(minLength: 16)
                    if let n = engine.nextUp {
                        Text("NEXT  \(n.title)").font(.subheadline).foregroundStyle(Palette.dim).lineLimit(1)
                    }
                }
            }
            .padding(16)
        }
        .background(.black.opacity(0.72))
        .clipShape(RoundedRectangle(cornerRadius: 4))
    }
}
