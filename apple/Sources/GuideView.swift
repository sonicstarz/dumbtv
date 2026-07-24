import SwiftUI
import CathodeCore

/// The program guide — the polished version of the ASS overlay. Channels down
/// the page; each shows what's on now (with a live progress bar) and what's next.
/// Tap a channel to tune. Prevue-blue field, amber accents.
struct GuideView: View {
    @ObservedObject var engine: Engine

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(engine.guideRows()) { row in
                        GuideRowCard(row: row, isCurrent: row.id == engine.currentIndex)
                            .contentShape(Rectangle())
                            .onTapGesture { engine.tune(to: row.id) }
                    }
                }
                .padding(16)
            }
        }
        .background(
            LinearGradient(colors: [Palette.prevue1, Palette.prevue2],
                           startPoint: .top, endPoint: .bottom)
        )
    }

    private var header: some View {
        HStack {
            Text("GUIDE")
                .font(.system(.headline, design: .monospaced)).bold()
                .foregroundStyle(Palette.amber).tracking(4)
            Spacer()
            Text(clockNow())
                .font(.system(.subheadline, design: .monospaced))
                .foregroundStyle(.white)
            Button { engine.guideOpen = false } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title3).foregroundStyle(Palette.dim)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(.black.opacity(0.35))
    }

    private func clockNow() -> String {
        let f = DateFormatter(); f.dateFormat = "h:mm a"; return f.string(from: Date())
    }
}

private struct GuideRowCard: View {
    let row: GuideEntry
    let isCurrent: Bool

    private var episodeTag: String {
        guard let p = row.now?.program, let s = p.seasonNo, let e = p.episodeNo else { return "" }
        return String(format: "S%02dE%02d  ", s, e)
    }

    var body: some View {
        HStack(spacing: 14) {
            VStack(spacing: 2) {
                Text(String(format: "%02d", row.number))
                    .font(.system(size: 26, weight: .heavy)).foregroundStyle(Palette.amber)
                Text(row.name.uppercased())
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(Color(white: 0.85))
                    .multilineTextAlignment(.center)
            }
            .frame(width: 92)

            VStack(alignment: .leading, spacing: 4) {
                Text("NOW").font(.system(size: 10, design: .monospaced)).foregroundStyle(Palette.amber)
                Text(row.now?.program.title ?? "—")
                    .font(.headline).foregroundStyle(.white).lineLimit(1)
                Text(episodeTag + (row.now?.program.subtitle ?? ""))
                    .font(.caption).foregroundStyle(Color(white: 0.8)).lineLimit(1)
                ProgressView(value: row.now?.progress ?? 0).tint(Palette.amber)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("NEXT").font(.system(size: 10, design: .monospaced)).foregroundStyle(Color(white: 0.75))
                Text(row.next?.title ?? "—")
                    .font(.subheadline).foregroundStyle(Color(white: 0.85)).lineLimit(2)
            }
            .frame(width: 120, alignment: .leading)
        }
        .padding(12)
        .background(isCurrent ? Palette.amber.opacity(0.22) : Color.white.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(isCurrent ? Palette.amber : Color.clear, lineWidth: 2)
        )
    }
}
