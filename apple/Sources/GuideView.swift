import SwiftUI
import dumbTVCore

/// The program guide — a Prevue-style timeline grid. Channels run down the page;
/// each channel's programs are laid out left-to-right, sized to how long they
/// air, across a 90-minute time axis. A red now-line marks the present, the
/// highlighted row follows the arrow keys, and ←→ scroll the axis by 30 minutes.
struct GuideView: View {
    @ObservedObject var engine: Engine

    var body: some View {
        VStack(spacing: 8) {
            GuideGrid(engine: engine, windowStart: engine.guideWindowStart)
            footer
        }
        .padding(12)
        .background(
            LinearGradient(colors: [Palette.prevue1, Palette.prevue2],
                           startPoint: .top, endPoint: .bottom)
        )
    }

    private var footer: some View {
        HStack(spacing: 26) {
            Text("↑↓ CHANNEL")
            Text("←→ HOURS")
            Text("ENTER WATCH")
            Text("1 CLOSE")
        }
        .font(.system(size: 13, design: .monospaced)).bold()
        .foregroundStyle(Palette.amber)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
    }
}

/// The grid itself: a fixed left gutter of channel numbers/names, then a lane
/// where programs are positioned by time. One GeometryReader gives the lane
/// width so blocks, tick labels, gridlines, and the now-line share one mapping.
private struct GuideGrid: View {
    @ObservedObject var engine: Engine
    let windowStart: Millis

    private let gutter: CGFloat = 108
    private let rowH: CGFloat = 62
    private let headerH: CGFloat = 20
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
                    Rectangle().fill(Color.white.opacity(0.14)).frame(width: 1)
                        .frame(maxHeight: .infinity, alignment: .top)
                        .padding(.top, headerH + 4)
                        .offset(x: colX(i, lane: lane))
                        .allowsHitTesting(false)
                }

                VStack(spacing: 6) {
                    // Header: "GUIDE" over the gutter, then the time-axis labels.
                    ZStack(alignment: .topLeading) {
                        Text("GUIDE")
                            .font(.system(size: 13, design: .monospaced)).bold()
                            .foregroundStyle(Palette.amber).tracking(2)
                        ForEach(0...cols, id: \.self) { i in
                            Text(hhmm(windowStart + Millis(i) * 30 * 60 * 1000))
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(Color(white: 0.85))
                                .fixedSize()
                                .offset(x: colX(i, lane: lane) + 4)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: headerH, alignment: .topLeading)

                    ForEach(engine.guideProgramRows()) { row in
                        GuideGridRow(row: row, gutter: gutter, lane: lane, windowStart: windowStart,
                                     now: now,
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
                        .padding(.top, headerH + 4)
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
    let isSelected: Bool
    let isCurrent: Bool

    private func clampX(_ t: Millis) -> CGFloat {
        let raw = CGFloat(Double(t - windowStart) / Double(guideSpanMs)) * lane
        return min(max(raw, 0), lane)
    }

    private func sub(_ p: Program) -> String {
        if let s = p.seasonNo, let e = p.episodeNo, let t = p.subtitle {
            return String(format: "S%02dE%02d  %@", s, e, t)
        }
        return p.subtitle ?? ""
    }

    var body: some View {
        HStack(spacing: 0) {
            ZStack {
                VStack(spacing: 2) {
                    Text(String(format: "%02d", row.number))
                        .font(.system(size: 22, weight: .heavy)).foregroundStyle(Palette.amber)
                    Text(row.name.uppercased())
                        .font(.system(size: 8, design: .monospaced))
                        .foregroundStyle(Color(white: 0.82))
                        .multilineTextAlignment(.center).lineLimit(2)
                }
                // ▶ marks the channel you're tuned to, like the screenshot.
                if isCurrent {
                    Image(systemName: "play.fill")
                        .font(.system(size: 12)).foregroundStyle(Palette.amber)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 4)
                }
            }
            .frame(width: gutter)

            ZStack(alignment: .leading) {
                ForEach(row.programs) { p in
                    let sx = clampX(p.startUtc), ex = clampX(p.endUtc)
                    ProgramBlock(title: p.title, subtitle: sub(p),
                                 airingNow: now >= p.startUtc && now < p.endUtc)
                        .frame(width: max(ex - sx, 1), alignment: .leading)
                        .offset(x: sx)
                }
            }
            .frame(width: lane, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(isCurrent ? Palette.amber.opacity(0.12) : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(isSelected ? Palette.amber : .clear, lineWidth: 3)
        )
    }
}

/// A single program cell in the grid. The one currently airing underlines its
/// subtitle, matching the printed-guide look.
private struct ProgramBlock: View {
    let title: String
    let subtitle: String
    let airingNow: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white).lineLimit(1)
            if !subtitle.isEmpty {
                Text(subtitle).font(.system(size: 11))
                    .foregroundStyle(Palette.amber)
                    .underline(airingNow, color: Palette.amber)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.white.opacity(airingNow ? 0.10 : 0.05))
        .overlay(Rectangle().stroke(Color.white.opacity(0.18), lineWidth: 1))
    }
}

/// The "NOW PLAYING" panel shown beside the video when the guide is open.
struct NowPlayingPanel: View {
    @ObservedObject var engine: Engine

    private func epTag(_ p: Program) -> String {
        guard let s = p.seasonNo, let e = p.episodeNo else { return "" }
        return String(format: "S%02dE%02d  ", s, e)
    }

    var body: some View {
        Group {
            if let a = engine.now {
                VStack(alignment: .leading, spacing: 10) {
                    Text("NOW PLAYING")
                        .font(.system(.subheadline, design: .monospaced)).bold()
                        .foregroundStyle(Palette.amber).tracking(2)
                    HStack(spacing: 10) {
                        Text(String(format: "%02d", engine.channelNumber))
                            .font(.system(size: 24, weight: .heavy)).foregroundStyle(Palette.amber)
                        Text(engine.channelName.uppercased())
                            .font(.system(size: 20, weight: .heavy)).foregroundStyle(.white)
                    }
                    Text(a.program.title)
                        .font(.system(size: 30, weight: .bold)).foregroundStyle(.white).lineLimit(1)
                    if let sub = a.program.subtitle {
                        Text(epTag(a.program) + sub).font(.title3).foregroundStyle(Color(white: 0.82))
                    }
                    Spacer(minLength: 4)
                    ProgressView(value: a.progress).tint(Palette.amber)
                    HStack {
                        Text("\(hhmm(a.program.startUtc)) – \(hhmm(a.program.endUtc))")
                            .foregroundStyle(Palette.amber)
                        Spacer()
                        Text(hhmm(engine.wallClock)).foregroundStyle(.white)
                    }
                    .font(.system(.subheadline, design: .monospaced))
                }
                .padding(20)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(
                    LinearGradient(colors: [Palette.prevue1, Palette.prevue2],
                                   startPoint: .top, endPoint: .bottom)
                )
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}
