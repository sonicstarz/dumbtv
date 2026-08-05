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
            // Was 16pt of horizontal padding INSIDE a safe area that already
            // insets ~5% — dead margin on both sides of a grid that wanted the
            // width. 4pt keeps the blocks off the very edge without donating a
            // column to nothing.
            GuideGrid(engine: engine, windowStart: engine.guideWindowStart, s: s)
                .padding(.horizontal, 4 * s)
                .padding(.top, 8 * s)
                .padding(.bottom, 4 * s)
        }
        .background(
            LinearGradient(colors: [Palette.prevue1, Palette.prevue2],
                           startPoint: .top, endPoint: .bottom)
        )
    }

    /// The channel being tuned to, if the guide is deliberately holding open
    /// while it buffers.
    private var tuningRow: GuideProgramRow? {
        guard let t = engine.guideTuning else { return nil }
        return engine.guideProgramRows().first { $0.id == t }
    }

    // The web TV's `gh` strip: GUIDE · clock · nothing rounded, on black.
    private var header: some View {
        HStack {
            // TUNING TAKES OVER THE HEADER (B25-4).
            //
            // Picking a channel that has to buffer used to be acknowledged only
            // by a small chip down in that row's gutter, which is easy to miss on
            // the far side of a living room — so a slow join read as a press that
            // did nothing. The strip that normally says GUIDE now names the
            // channel being tuned, which is where the eye already is.
            if let t = tuningRow {
                HStack(spacing: 10 * s) {
                    Text("TUNING")
                        .foregroundStyle(.black)
                        .padding(.horizontal, 9 * s).padding(.vertical, 3 * s)
                        .background(Palette.amber)
                    Text(String(format: "CH %02d", t.number))
                        .foregroundStyle(Palette.amber)
                    Text(t.name.uppercased())
                        .foregroundStyle(Palette.ice).lineLimit(1)
                }
                .tracking(3)
            } else {
                Text("GUIDE")
                    .foregroundStyle(Palette.amber).tracking(4)
            }
            Spacer()
            // Tabular figures on the clock only — it reflows every minute, and
            // proportional digits make it twitch. "GUIDE" beside it does not care.
            Text(hhmm(engine.wallClock))
                .font(Palette.digits(14 * s, .semibold))
                .foregroundStyle(Palette.amber)
            // SETUP, top right. Selection index -1, unchanged — UP from channel
            // 0 lands here and SELECT opens it, the same as when this was a row
            // in the grid. Moving it up here gives the grid a whole row back and
            // puts the wheel where a settings control is looked for.
            HStack(spacing: 7 * s) {
                Image(systemName: "gearshape.fill")
                    .font(.system(size: 17 * s))
                Text("SETUP").font(Palette.meta(13 * s, .semibold)).tracking(2)
            }
            .foregroundStyle(engine.guideSelection == -1 ? .black : Palette.amber)
            .padding(.horizontal, 12 * s).padding(.vertical, 5 * s)
            .background(engine.guideSelection == -1 ? Palette.amber : Color.white.opacity(0.06))
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .padding(.leading, 22 * s)
            .contentShape(Rectangle())
            .onTapGesture { engine.guideSelection = -1; engine.guideSelect() }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Setup and channel packs. Select to open.")
        }
        .font(Palette.meta(14 * s, .semibold))
        .padding(.horizontal, 20 * s).padding(.vertical, 9 * s)
        .background(Color.black.opacity(0.3))
    }

    // THE KEY LEGEND IS GONE (build 24 owner review: "clutter").
    //
    // It listed ↑↓ CHANNEL / ←→ HOURS / SELECT WATCH / MENU CLOSE across the
    // bottom of every guide. Those are the four things a remote does anyway, it
    // had been factually wrong twice before (it said "1 CLOSE" after `1` was
    // freed to dial SPACE, then showed keyboard instructions on a touchscreen),
    // and it was eating a full row's worth of height on the one screen the owner
    // wanted MORE room in. The first-run card still teaches the controls once,
    // which is where teaching belongs.
    //
    // The ⚙ row keeps its own label inside the grid, so the one genuinely
    // non-obvious affordance still explains itself.
}

/// The grid: a fixed left gutter of channel numbers/names, then a lane where
/// programs are positioned by time. One GeometryReader gives the lane width so
/// blocks, tick labels, gridlines, and the now-line share one mapping.
private struct GuideGrid: View {
    @ObservedObject var engine: Engine
    let windowStart: Millis
    let s: CGFloat

    // Grown for build 25. The old 78pt row existed to fit a legend and a taller
    // top block that are both gone now; at living-room distance it left the
    // channel art at 34×50, which is a thumbnail, not an identity.
    // Reclaiming the dead space the owner flagged on all four sides. The gutter
    // grows so the channel identity (artwork + number + name) is the focal point
    // it was asked to be, and the row grows with it.
    private var gutter: CGFloat { 210 * s }
    private var rowH: CGFloat { 124 * s }
    private var headerH: CGFloat { 30 * s }
    private let cols = 5   // 30-min columns across the 2.5-hour span

    private func x(_ t: Millis, lane: CGFloat) -> CGFloat {
        gutter + CGFloat(Double(t - windowStart) / Double(guideSpanMs)) * lane
    }
    private func colX(_ i: Int, lane: CGFloat) -> CGFloat {
        gutter + CGFloat(i) / CGFloat(cols) * lane
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
                            .font(Palette.digits(15 * s, .semibold))
                            .foregroundStyle(Palette.ice)
                            .fixedSize()
                            .offset(x: colX(i, lane: lane) + 6 * s)
                    }
                    Text(hhmm(windowStart + Millis(cols) * 30 * 60 * 1000))
                        .font(Palette.digits(15 * s, .semibold))
                        .foregroundStyle(Palette.ice)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                .frame(maxWidth: .infinity, minHeight: headerH, alignment: .topLeading)

                // Channels scroll; the arrow-selected row is kept in view.
                ScrollViewReader { proxy in
                    ScrollView(.vertical, showsIndicators: false) {
                        VStack(spacing: 0) {
                            // The SETUP row used to live here, costing a full
                            // row of the one screen the owner wanted more room
                            // in. It is a gear in the header now (top right,
                            // where a settings control belongs) and still holds
                            // selection index -1, so UP from channel 0 reaches
                            // it exactly as before — it simply highlights up
                            // there instead of taking grid space down here.
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
                        // -2 is the NOW PLAYING panel, which lives ABOVE this
                        // ScrollView and has no row to scroll to. Keep the list
                        // where it is and let the panel's own highlight carry it.
                        guard sel >= -1 else { return }
                        withAnimation { proxy.scrollTo(sel, anchor: .center) }
                    }
                    // OPEN THE GUIDE ON THE CHANNEL YOU ARE WATCHING.
                    //
                    // `guideOpen`'s didSet already points guideSelection at the
                    // current channel — but it does that BEFORE this ScrollView
                    // exists, so the .onChange above never fires for it and the
                    // guide opened parked at the top of the list. On a long
                    // lineup that means arriving somewhere you weren't, and
                    // scrolling back to find yourself.
                    //
                    // No animation: this is the guide's starting position, not a
                    // movement, and animating it would read as a lurch on open.
                    .onAppear {
                        let sel = engine.guideSelection
                        guard sel >= -1 else { return }
                        proxy.scrollTo(sel, anchor: .center)
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

    /// The art tile fills the gutter, inset just enough to breathe.
    // The artwork is the focal point (B25-5) and the gutter got wider, so it
    // grows with it — 134×108 rather than 134×88 at the old 150pt gutter.
    private var artW: CGFloat { gutter - 16 * s }
    private var artH: CGFloat { 108 * s }

    /// Stands in for missing or still-loading artwork.
    ///
    /// THE TILE STILL HAS TO BE AN IDENTITY. Plenty of channels have no artwork
    /// at all — a local folder, anything hand-built in the web UI, and every
    /// pack that ships without a poster — and promoting the art to the focal
    /// point makes a blank tile the loudest thing in the row. A faint glyph was
    /// not enough: on the simulator it read as an empty blue rectangle, i.e. as
    /// a bug. So with no art the tile carries the channel NUMBER, big, which is
    /// the identity it always had.
    private var artFallback: some View {
        ZStack {
            LinearGradient(colors: [Palette.prevue1, Palette.prevue2],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            Text(String(format: "%02d", row.number))
                .font(Palette.display(48 * s))
                .foregroundStyle(Palette.amber.opacity(0.92))
                .minimumScaleFactor(0.5).lineLimit(1)
                .padding(.bottom, 14 * s)   // clear of the ident line below
        }
    }

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
                // THE ARTWORK IS THE CHANNEL (build 25 owner direction).
                //
                // It used to be a 34×50 thumbnail sitting beside a large amber
                // channel number, so the NUMBER read as the identity and the art
                // as decoration. That is backwards for the way people actually
                // find a channel — a kid finds "the Batman channel" by the
                // poster, not the call letters. The art now fills the gutter and
                // the number and name ride a scrim across its foot, the way a
                // station ident sits over a picture.
                ZStack(alignment: .bottomLeading) {
                    if let art = row.art {
                        AsyncImage(url: art) { img in
                            img.resizable().aspectRatio(contentMode: .fill)
                        } placeholder: { artFallback }
                        .frame(width: artW, height: artH)
                        .clipped()
                    } else {
                        // No artwork is ordinary — a local folder or a hand-built
                        // channel may never have any. Give it a real tile rather
                        // than a hole, and let the number carry the identity there.
                        artFallback.frame(width: artW, height: artH)
                    }
                    // Legibility scrim. Artwork is arbitrary and often bright, so
                    // the ident cannot rely on the image being dark underneath.
                    LinearGradient(colors: [.clear, .black.opacity(0.86)],
                                   startPoint: .center, endPoint: .bottom)
                        .frame(width: artW, height: artH)
                        .allowsHitTesting(false)
                    HStack(alignment: .firstTextBaseline, spacing: 5 * s) {
                        // The number rides the ident line only when there IS art
                        // to sit on. Without art the tile itself is already a big
                        // number, and printing it twice looks like a mistake.
                        if row.art != nil {
                            Text(String(format: "%02d", row.number))
                                .font(Palette.display(15 * s)).foregroundStyle(Palette.amber)
                        }
                        Text(row.name.uppercased())
                            .font(Palette.meta(10 * s, .semibold))
                            .foregroundStyle(Palette.ice)
                            .lineLimit(1).minimumScaleFactor(0.6)
                    }
                    .padding(.horizontal, 6 * s).padding(.bottom, 5 * s)
                    .frame(width: artW, alignment: .leading)
                }
                .frame(width: artW, height: artH)
                .overlay(Rectangle().stroke(Color.white.opacity(0.18), lineWidth: 1))
                if isTuning {
                    // Buffering the newly-picked channel: a clear "got it, tuning"
                    // so the press never feels ignored while the guide holds open.
                    // Covers the tile rather than tucking into a corner — this is
                    // the row you just pressed, and it should say so (B25-4). The
                    // guide header names it too, for anyone looking up there.
                    ZStack {
                        Color.black.opacity(0.55)
                        Text("TUNING")
                            .font(Palette.meta(13 * s, .bold)).tracking(2)
                            .foregroundStyle(.black)
                            .padding(.horizontal, 8 * s).padding(.vertical, 3 * s)
                            .background(Palette.amber)
                    }
                    .frame(width: artW, height: artH)
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
                        .font(Palette.meta(12 * s))
                        .foregroundStyle(Palette.peri)
                        .padding(.leading, 12 * s)
                }
                ForEach(row.programs) { p in
                    let sx = clampX(p.startUtc), ex = clampX(p.endUtc)
                    let w = max(ex - sx - 2, 1)
                    ProgramBlock(title: p.title, subtitle: sub(p), width: w, s: s,
                                 airingNow: now >= p.startUtc && now < p.endUtc)
                        .frame(width: w, alignment: .leading)
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
    /// How wide this block actually is on the axis. A block is sized by how long
    /// the programme runs, so a 7-minute cartoon gets a sliver and a feature gets
    /// half the screen — the type has to answer to that.
    let width: CGFloat
    let s: CGFloat
    let airingNow: Bool

    /// Below this there is no room for a title AND a subtitle, so the subtitle
    /// goes. Short-form packs (a channel of 7-minute cartoons puts ~13 blocks on
    /// a 90-minute axis) otherwise degrade to a row of "Earl…" / "S01E0…", which
    /// is what the bigger build-25 type made visible.
    private var narrow: Bool { width < 165 * s }

    /// Below THIS there is no room for a title at all, and trying anyway
    /// produced the picket fence of "Ear ly…" / "Ea r…" the tighter axis made
    /// obvious. A block this short is a tick mark on the timeline: it still
    /// shows its extent and its now-highlight, it just doesn't pretend to
    /// carry a label. The channel gutter says what the channel is.
    private var tiny: Bool { width < 62 * s }

    var body: some View {
        VStack(alignment: .leading, spacing: 4 * s) {
            if !tiny {
            Text(title)
                .font(Palette.meta(narrow ? 14 * s : 18 * s, .semibold))
                .foregroundStyle(.white)
                // Two lines when narrow: a cartoon title wraps rather than
                // truncating, and the taller build-25 row has the space for it.
                .lineLimit(narrow ? 2 : 1)
                .minimumScaleFactor(0.8)
            }
            if !subtitle.isEmpty && !narrow && !tiny {
                Text(subtitle)
                    .font(Palette.meta(14 * s))
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
    /// Highlighted because the guide's selection has moved up onto it (row -2).
    /// Selecting here simply closes the guide — you are already on this channel.
    var isSelected: Bool = false

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
                            .font(Palette.meta(14 * s, .semibold))
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
                        .font(Palette.digits(16 * s, .semibold))
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
                        .font(Palette.meta(14 * s, .semibold))
                        .foregroundStyle(Palette.amber).tracking(3)
                    Text("NO PROGRAMMING")
                        .font(Palette.display(24 * s)).foregroundStyle(.white)
                    Text("Add shows to this channel in the web config.")
                        .font(Palette.meta(13 * s)).foregroundStyle(Palette.peri)
                }
                .padding(22 * s)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(
                    LinearGradient(colors: [Palette.prevue1, Palette.prevue2],
                                   startPoint: .top, endPoint: .bottom)
                )
            }
        }
        // Selected state for guide row -2. Arrowing up off the top of the channel
        // list lands here, and SELECT closes the guide onto the channel that is
        // already playing — previously the only direction that dead-ended.
        .overlay(alignment: .bottomTrailing) {
            if isSelected {
                Text("SELECT — BACK TO THIS CHANNEL")
                    .font(Palette.meta(11 * s, .bold)).tracking(1.5)
                    .foregroundStyle(.black)
                    .padding(.horizontal, 8 * s).padding(.vertical, 4 * s)
                    .background(Palette.amber)
                    .padding(10 * s)
            }
        }
        .overlay(
            Rectangle().stroke(Palette.amber, lineWidth: isSelected ? 3 * s : 0)
        )
    }
}
