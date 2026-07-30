import SwiftUI
import dumbTVCore

/// The program guide — a Prevue-style timeline grid styled exactly like the
/// web TV: prevue-blue field under a 3px amber rule, Archivo Black channel
/// numbers, mono meta text, square corners. Channels run down the page; each
/// channel's programs are laid out left-to-right, sized to how long they air,
/// across a 90-minute axis. A red now-line marks the present; ←→ scroll the
/// axis by 30 minutes.
struct GuideView: View {
    @ObservedObject var engine: Engine
    var s: CGFloat = 1

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Palette.amber).frame(height: 3)   // the web TV's border-top
            header
            GuideGrid(engine: engine, windowStart: engine.guideWindowStart, s: s)
                .padding(.horizontal, 16 * s)
                .padding(.top, 10 * s)
            footer
        }
        .background(
            LinearGradient(colors: [Palette.prevue1, Palette.prevue2],
                           startPoint: .top, endPoint: .bottom)
        )
    }

    // The web TV's `gh` strip: GUIDE · clock · nothing rounded, mono, on black.
    private var header: some View {
        HStack {
            Text("GUIDE")
                .foregroundStyle(Palette.amber).tracking(4)
            Spacer()
            Text(hhmm(engine.wallClock))
                .foregroundStyle(Palette.amber)
        }
        .font(Palette.mono(14 * s, .semibold))
        .padding(.horizontal, 20 * s).padding(.vertical, 9 * s)
        .background(Color.black.opacity(0.3))
    }

    // Bottom-right key legend, mono like the web.
    private var footer: some View {
        HStack(spacing: 30 * s) {
            Spacer()
            Text("⚙ TOP ROW = SETUP")
            Text("↑↓ CHANNEL")
            Text("←→ HOURS")
            Text("ENTER WATCH")
            // Said "1 CLOSE" — which stopped being true when `1` was freed up to
            // dial channel 1 (SPACE) instead of toggling the guide. A key legend
            // that lies is worse than no legend.
            #if os(tvOS)
            Text("MENU CLOSE")
            #else
            Text("G CLOSE")
            #endif
        }
        .font(Palette.mono(13 * s, .semibold))
        .foregroundStyle(Palette.amber)
        .padding(.horizontal, 20 * s).padding(.vertical, 8 * s)
    }
}

/// The grid: a fixed left gutter of channel numbers/names, then a lane where
/// programs are positioned by time. One GeometryReader gives the lane width so
/// blocks, tick labels, gridlines, and the now-line share one mapping.
private struct GuideGrid: View {
    @ObservedObject var engine: Engine
    let windowStart: Millis
    let s: CGFloat

    private var gutter: CGFloat { 118 * s }
    private var rowH: CGFloat { 78 * s }
    private var headerH: CGFloat { 26 * s }
    private let cols = 3   // 30-min columns across the 90-min span

    private func x(_ t: Millis, lane: CGFloat) -> CGFloat {
        gutter + CGFloat(Double(t - windowStart) / Double(guideSpanMs)) * lane
    }
    private func colX(_ i: Int, lane: CGFloat) -> CGFloat {
        gutter + CGFloat(i) / CGFloat(cols) * lane
    }

    /// The channel-00 SETUP row that sits above the real channels in the grid.
    private func setupRow(lane: CGFloat) -> some View {
        let selected = engine.guideSelection == -1
        return HStack(spacing: 0) {
            ZStack {
                // A gear, not a channel number. This row no longer tunes to
                // channel 00 — it opens Setup — and on a remote the wheel is the
                // thing people look for. The number stayed as "00" long after
                // the row stopped being a channel.
                VStack(spacing: 3 * s) {
                    Image(systemName: "gearshape.fill")
                        .font(.system(size: 20 * s)).foregroundStyle(Palette.amber)
                    Text("SETUP").font(Palette.mono(8 * s)).foregroundStyle(Palette.ice)
                }
                if engine.onSetupChannel {
                    Image(systemName: "play.fill")
                        .font(.system(size: 13 * s)).foregroundStyle(Palette.amber)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 4 * s)
                }
            }
            .frame(width: gutter)
            ZStack(alignment: .leading) {
                Text("CHANNEL PACKS — download public-domain channels to this device")
                    .font(Palette.mono(13 * s)).foregroundStyle(Palette.peri)
                    .padding(.leading, 12 * s).lineLimit(1)
            }
            .frame(width: lane, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(selected ? Palette.amber.opacity(0.22)
                    : engine.onSetupChannel ? Palette.amber.opacity(0.10) : Color.clear)
    }

    var body: some View {
        GeometryReader { geo in
            let lane = max(1, geo.size.width - gutter)
            let now = engine.wallClock

            VStack(spacing: 4 * s) {
                // Time-axis labels (mono, like a printed listing) — fixed header.
                ZStack(alignment: .topLeading) {
                    ForEach(0..<cols, id: \.self) { i in
                        Text(hhmm(windowStart + Millis(i) * 30 * 60 * 1000))
                            .font(Palette.mono(15 * s, .semibold))
                            .foregroundStyle(Palette.ice)
                            .fixedSize()
                            .offset(x: colX(i, lane: lane) + 6 * s)
                    }
                    Text(hhmm(windowStart + Millis(cols) * 30 * 60 * 1000))
                        .font(Palette.mono(15 * s, .semibold))
                        .foregroundStyle(Palette.ice)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                .frame(maxWidth: .infinity, minHeight: headerH, alignment: .topLeading)

                // Channels scroll; the arrow-selected row is kept in view.
                ScrollViewReader { proxy in
                    ScrollView(.vertical, showsIndicators: false) {
                        VStack(spacing: 0) {
                            // SETUP row — always first, so Setup stays reachable
                            // from the guide forever, on every platform. On tvOS
                            // this is the ONLY way in: the root view owns focus,
                            // so a Button on the setup card can never be pressed.
                            setupRow(lane: lane)
                                .frame(height: rowH)
                                .id(-1)
                                .contentShape(Rectangle())
                                .onTapGesture { engine.guideSelection = -1; engine.guideSelect() }
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel("Channel packs. Download public-domain channels to this device. Select to open.")
                            ForEach(engine.guideProgramRows()) { row in
                                let airing = row.programs.first { now >= $0.startUtc && now < $0.endUtc }
                                GuideGridRow(row: row, gutter: gutter, lane: lane, windowStart: windowStart,
                                             now: now, s: s,
                                             isSelected: row.id == engine.guideSelection,
                                             isCurrent: row.id == engine.currentIndex,
                                             isTuning: row.id == engine.guideTuning)
                                    .frame(height: rowH)
                                    .id(row.id)
                                    .contentShape(Rectangle())
                                    // Route taps through guideSelect: tapping the
                                    // channel you're on just closes the guide; a new
                                    // one holds the guide open until its picture is up.
                                    .onTapGesture { engine.guideSelection = row.id; engine.guideSelect() }
                                    .accessibilityElement(children: .ignore)
                                    .accessibilityLabel("Channel \(row.number), \(row.name). "
                                        + "Now: \(airing?.title ?? "nothing scheduled"). Select to watch.")
                                    .accessibilityAddTraits(row.id == engine.currentIndex ? .isSelected : [])
                            }
                        }
                    }
                    // Single-arg onChange (works iOS 16 / macOS 13+); the two-arg
                    // form is iOS 17+ and would block the lower iOS floor.
                    .onChange(of: engine.guideSelection) { sel in
                        withAnimation { proxy.scrollTo(sel, anchor: .center) }
                    }
                }
                // Column gridlines + the red now-line, over the scrolling rows.
                .overlay(alignment: .topLeading) {
                    ZStack(alignment: .topLeading) {
                        ForEach(0...cols, id: \.self) { i in
                            Rectangle().fill(Color.white.opacity(0.14)).frame(width: 1)
                                .frame(maxHeight: .infinity)
                                .offset(x: colX(i, lane: lane))
                        }
                        if now >= windowStart && now <= windowStart + guideSpanMs {
                            Rectangle().fill(Color.red).frame(width: 2)
                                .frame(maxHeight: .infinity)
                                .offset(x: x(now, lane: lane))
                        }
                    }
                    .allowsHitTesting(false)
                }
            }
        }
    }
}

/// One channel row: gutter (▶ + number + name), then its programs as blocks.
private struct GuideGridRow: View {
    let row: GuideProgramRow
    let gutter: CGFloat
    let lane: CGFloat
    let windowStart: Millis
    let now: Millis
    let s: CGFloat
    let isSelected: Bool
    let isCurrent: Bool
    /// This channel was just picked and its stream is buffering — the guide is
    /// deliberately staying open until the picture lands, so acknowledge the press.
    var isTuning: Bool = false

    private func clampX(_ t: Millis) -> CGFloat {
        let raw = CGFloat(Double(t - windowStart) / Double(guideSpanMs)) * lane
        return min(max(raw, 0), lane)
    }

    private func sub(_ p: Program) -> String {
        if let se = p.seasonNo, let ep = p.episodeNo, let t = p.subtitle {
            return String(format: "S%02dE%02d  %@", se, ep, t)
        }
        return p.subtitle ?? ""
    }

    var body: some View {
        HStack(spacing: 0) {
            ZStack {
                HStack(spacing: 6 * s) {
                    // Channel art — a kid finds "the Batman channel" by the
                    // poster, not the call letters.
                    if let art = row.art {
                        AsyncImage(url: art) { img in
                            img.resizable().aspectRatio(contentMode: .fill)
                        } placeholder: { Color.white.opacity(0.08) }
                        .frame(width: 34 * s, height: 50 * s)
                        .clipped()
                    }
                    VStack(spacing: 3 * s) {
                        Text(String(format: "%02d", row.number))
                            .font(Palette.display(22 * s)).foregroundStyle(Palette.amber)
                        Text(row.name.uppercased())
                            .font(Palette.mono(8 * s))
                            .foregroundStyle(Palette.ice)
                            .multilineTextAlignment(.center).lineLimit(2)
                    }
                }
                if isTuning {
                    // Buffering the newly-picked channel: a clear "got it, tuning"
                    // so the press never feels ignored while the guide holds open.
                    Text("TUNING")
                        .font(Palette.mono(9 * s, .bold)).tracking(2)
                        .foregroundStyle(.black)
                        .padding(.horizontal, 5 * s).padding(.vertical, 2 * s)
                        .background(Palette.amber)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                        .padding(.leading, 3 * s).padding(.bottom, 3 * s)
                } else if isCurrent {
                    Image(systemName: "play.fill")
                        .font(.system(size: 13 * s)).foregroundStyle(Palette.amber)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 4 * s)
                }
            }
            .frame(width: gutter)

            ZStack(alignment: .leading) {
                if row.programs.isEmpty {
                    // A configured channel with nothing cached yet — say so
                    // instead of hiding the row (channels made in the web UI
                    // always show up here).
                    Text("NO PROGRAMMING — ADD SHOWS IN THE WEB CONFIG")
                        .font(Palette.mono(12 * s))
                        .foregroundStyle(Palette.peri)
                        .padding(.leading, 12 * s)
                }
                ForEach(row.programs) { p in
                    let sx = clampX(p.startUtc), ex = clampX(p.endUtc)
                    ProgramBlock(title: p.title, subtitle: sub(p), s: s,
                                 airingNow: now >= p.startUtc && now < p.endUtc)
                        .frame(width: max(ex - sx - 2, 1), alignment: .leading)
                        .offset(x: sx + 1)
                }
            }
            .frame(width: lane, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Selection = the web TV's amber wash (`.grow.sel`); square corners.
        .background(isSelected ? Palette.amber.opacity(0.22)
                    : isCurrent ? Palette.amber.opacity(0.10) : Color.clear)
    }
}

/// A single program cell — a flat block on the blue field, no outline. The one
/// currently airing gets a thick amber underline bar beneath its subtitle.
private struct ProgramBlock: View {
    let title: String
    let subtitle: String
    let s: CGFloat
    let airingNow: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4 * s) {
            Text(title)
                .font(.system(size: 16 * s, weight: .semibold))
                .foregroundStyle(.white).lineLimit(1)
            if !subtitle.isEmpty {
                Text(subtitle)
                    .font(.system(size: 13 * s))
                    .foregroundStyle(Palette.peri).lineLimit(1)
                    .overlay(alignment: .bottomLeading) {
                        if airingNow {
                            Rectangle().fill(Palette.amber)
                                .frame(height: 2.5 * s).offset(y: 4 * s)
                        }
                    }
            }
        }
        .padding(.horizontal, 10 * s).padding(.vertical, 8 * s)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.white.opacity(airingNow ? 0.10 : 0.06))
    }
}

/// The "NOW PLAYING" panel shown beside the video when the guide is open.
/// Archivo Black idents, mono meta, flat progress bar — the web look.
struct NowPlayingPanel: View {
    @ObservedObject var engine: Engine
    var s: CGFloat = 1

    private func epTag(_ p: Program) -> String {
        guard let se = p.seasonNo, let ep = p.episodeNo else { return "" }
        return String(format: "S%02dE%02d  ", se, ep)
    }

    var body: some View {
        Group {
            if let a = engine.now {
                HStack(alignment: .top, spacing: 16 * s) {
                    // Channel poster, like the box art corner of a listings mag.
                    if let art = engine.channelArtURL(engine.currentIndex) {
                        AsyncImage(url: art) { img in
                            img.resizable().aspectRatio(contentMode: .fill)
                        } placeholder: { Color.white.opacity(0.08) }
                        .frame(width: 88 * s, height: 128 * s)
                        .clipped()
                        .border(Palette.amber.opacity(0.6), width: 2)
                    }
                    VStack(alignment: .leading, spacing: 10 * s) {
                        Text("NOW PLAYING")
                            .font(Palette.mono(14 * s, .semibold))
                            .foregroundStyle(Palette.amber).tracking(3)
                        HStack(alignment: .firstTextBaseline, spacing: 12 * s) {
                            Text(String(format: "%02d", engine.channelNumber))
                                .font(Palette.display(22 * s)).foregroundStyle(Palette.amber)
                            Text(engine.channelName.uppercased())
                                .font(Palette.display(20 * s)).foregroundStyle(.white)
                        }
                        Text(a.program.title)
                            .font(Palette.display(30 * s)).foregroundStyle(.white)
                            .lineLimit(1).minimumScaleFactor(0.5)
                        if let sub = a.program.subtitle {
                            Text(epTag(a.program) + sub)
                                .font(.system(size: 20 * s)).foregroundStyle(Palette.ice)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 4 * s)
                        RetroBar(progress: a.progress)
                        HStack {
                            Text("\(hhmm(a.program.startUtc)) – \(hhmm(a.program.endUtc))")
                                .foregroundStyle(Palette.amber)
                            Spacer()
                            Text(hhmm(engine.wallClock)).foregroundStyle(.white)
                        }
                        .font(Palette.mono(16 * s, .semibold))
                    }
                }
                .padding(22 * s)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(
                    LinearGradient(colors: [Palette.prevue1, Palette.prevue2],
                                   startPoint: .top, endPoint: .bottom)
                )
            } else {
                // Tuned to a channel with nothing scheduled — keep the panel
                // honest rather than blank.
                VStack(alignment: .leading, spacing: 10 * s) {
                    Text("NOW PLAYING")
                        .font(Palette.mono(14 * s, .semibold))
                        .foregroundStyle(Palette.amber).tracking(3)
                    Text("NO PROGRAMMING")
                        .font(Palette.display(24 * s)).foregroundStyle(.white)
                    Text("Add shows to this channel in the web config.")
                        .font(Palette.mono(13 * s)).foregroundStyle(Palette.peri)
                }
                .padding(22 * s)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(
                    LinearGradient(colors: [Palette.prevue1, Palette.prevue2],
                                   startPoint: .top, endPoint: .bottom)
                )
            }
        }
    }
}
