import SwiftUI
import dumbTVCore

/// The program guide — a Prevue-style timeline grid. Channels run down the page;
/// each channel's programs are laid out left-to-right, sized to how long they
/// air, across a 90-minute time axis. A red now-line marks the present, the
/// highlighted row follows the arrow keys, and ←→ scroll the axis by 30 minutes.
///
/// `s` is the UI scale (window height / 800) so the guide reads like a TV screen
/// at any window size — big chunky text, exactly like the reference design.
struct GuideView: View {
    @ObservedObject var engine: Engine
    var s: CGFloat = 1

    var body: some View {
        VStack(spacing: 6 * s) {
            GuideGrid(engine: engine, windowStart: engine.guideWindowStart, s: s)
            footer
        }
        .padding(16 * s)
        .background(
            LinearGradient(colors: [Palette.prevue1, Palette.prevue2],
                           startPoint: .top, endPoint: .bottom)
        )
    }

    // Bottom-right key legend, like the reference.
    private var footer: some View {
        HStack(spacing: 30 * s) {
            Spacer()
            Text("↑↓ CHANNEL")
            Text("←→ HOURS")
            Text("ENTER WATCH")
            Text("1 CLOSE")
        }
        .font(.system(size: 15 * s, weight: .bold, design: .monospaced))
        .foregroundStyle(Palette.amber)
        .padding(.trailing, 10 * s)
        .padding(.bottom, 2 * s)
    }
}

/// The grid itself: a fixed left gutter of channel numbers/names, then a lane
/// where programs are positioned by time. One GeometryReader gives the lane
/// width so blocks, tick labels, gridlines, and the now-line share one mapping.
private struct GuideGrid: View {
    @ObservedObject var engine: Engine
    let windowStart: Millis
    let s: CGFloat

    private var gutter: CGFloat { 118 * s }
    private var rowH: CGFloat { 78 * s }
    private var headerH: CGFloat { 28 * s }
    private let cols = 3   // 30-min columns across the 90-min span

    /// Map a time to an x within [gutter, gutter + lane].
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

            ZStack(alignment: .topLeading) {
                // Vertical column gridlines behind everything, below the header.
                ForEach(0...cols, id: \.self) { i in
                    Rectangle().fill(Color.white.opacity(0.10)).frame(width: 1)
                        .frame(maxHeight: .infinity, alignment: .top)
                        .padding(.top, headerH + 4 * s)
                        .offset(x: colX(i, lane: lane))
                        .allowsHitTesting(false)
                }

                VStack(spacing: 6 * s) {
                    // Header: "GUIDE" over the gutter, then the time-axis labels.
                    ZStack(alignment: .topLeading) {
                        Text("GUIDE")
                            .font(.system(size: 19 * s, weight: .bold, design: .monospaced))
                            .foregroundStyle(Palette.amber).tracking(3)
                        ForEach(0..<cols, id: \.self) { i in
                            Text(hhmm(windowStart + Millis(i) * 30 * 60 * 1000))
                                .font(.system(size: 18 * s, weight: .semibold))
                                .foregroundStyle(Color(white: 0.9))
                                .fixedSize()
                                .offset(x: colX(i, lane: lane) + 6 * s)
                        }
                        // The last tick hugs the right edge so it never clips.
                        Text(hhmm(windowStart + Millis(cols) * 30 * 60 * 1000))
                            .font(.system(size: 18 * s, weight: .semibold))
                            .foregroundStyle(Color(white: 0.9))
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                    .frame(maxWidth: .infinity, minHeight: headerH, alignment: .topLeading)

                    ForEach(engine.guideProgramRows()) { row in
                        GuideGridRow(row: row, gutter: gutter, lane: lane, windowStart: windowStart,
                                     now: now, s: s,
                                     isSelected: row.id == engine.guideSelection,
                                     isCurrent: row.id == engine.currentIndex)
                            .frame(height: rowH)
                            .contentShape(Rectangle())
                            .onTapGesture { engine.tune(to: row.id) }
                    }
                    Spacer(minLength: 0)
                }

                // The red now-line spans the rows (not the header).
                if now >= windowStart && now <= windowStart + guideSpanMs {
                    Rectangle().fill(Color.red).frame(width: 2)
                        .frame(maxHeight: .infinity, alignment: .top)
                        .padding(.top, headerH + 4 * s)
                        .offset(x: x(now, lane: lane))
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
                VStack(spacing: 2 * s) {
                    Text(String(format: "%02d", row.number))
                        .font(.system(size: 26 * s, weight: .heavy)).foregroundStyle(Palette.amber)
                    Text(row.name.uppercased())
                        .font(.system(size: 9 * s, design: .monospaced))
                        .foregroundStyle(Color(white: 0.85))
                        .multilineTextAlignment(.center).lineLimit(2)
                }
                // ▶ marks the channel you're tuned to, like the reference.
                if isCurrent {
                    Image(systemName: "play.fill")
                        .font(.system(size: 13 * s)).foregroundStyle(Palette.amber)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 6 * s)
                }
            }
            .frame(width: gutter)

            ZStack(alignment: .leading) {
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
        // The highlighted row lightens, like the reference — no border boxes.
        .background(isSelected ? Color.white.opacity(0.18)
                    : isCurrent ? Palette.amber.opacity(0.10) : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 4 * s))
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
                .font(.system(size: 16 * s, weight: .bold))
                .foregroundStyle(.white).lineLimit(1)
            if !subtitle.isEmpty {
                Text(subtitle)
                    .font(.system(size: 13 * s))
                    .foregroundStyle(Color(white: 0.92)).lineLimit(1)
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
                VStack(alignment: .leading, spacing: 10 * s) {
                    Text("NOW PLAYING")
                        .font(.system(size: 15 * s, weight: .bold, design: .monospaced))
                        .foregroundStyle(Palette.amber).tracking(3)
                    HStack(spacing: 12 * s) {
                        Text(String(format: "%02d", engine.channelNumber))
                            .font(.system(size: 24 * s, weight: .heavy)).foregroundStyle(.white)
                        Text(engine.channelName.uppercased())
                            .font(.system(size: 24 * s, weight: .heavy)).foregroundStyle(.white)
                    }
                    Text(a.program.title)
                        .font(.system(size: 38 * s, weight: .bold)).foregroundStyle(.white)
                        .lineLimit(1).minimumScaleFactor(0.6)
                    if let sub = a.program.subtitle {
                        Text(epTag(a.program) + sub)
                            .font(.system(size: 22 * s)).foregroundStyle(Color(white: 0.9))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 4 * s)
                    ProgressView(value: a.progress).tint(Palette.amber)
                        .scaleEffect(x: 1, y: 1.6, anchor: .center)
                    HStack {
                        Text("\(hhmm(a.program.startUtc)) – \(hhmm(a.program.endUtc))")
                            .foregroundStyle(Palette.amber)
                        Spacer()
                        Text(hhmm(engine.wallClock)).foregroundStyle(.white)
                    }
                    .font(.system(size: 17 * s, weight: .semibold, design: .monospaced))
                }
                .padding(24 * s)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(
                    LinearGradient(colors: [Palette.prevue1, Palette.prevue2],
                                   startPoint: .top, endPoint: .bottom)
                )
                .clipShape(RoundedRectangle(cornerRadius: 6 * s))
            }
        }
    }
}
