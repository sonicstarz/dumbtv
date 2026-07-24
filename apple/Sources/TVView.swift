import SwiftUI
import CathodeCore

struct TVView: View {
    @ObservedObject var engine: Engine

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if engine.guideOpen {
                guideLayout
            } else {
                watchLayout
            }
        }
    }

    // Full-screen video with the channel banner and a GUIDE button.
    private var watchLayout: some View {
        ZStack {
            VideoSurface(player: engine.player).ignoresSafeArea()
            VStack {
                HStack {
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
                Spacer()
                if let airing = engine.now {
                    BannerView(engine: engine, airing: airing)
                } else if !engine.status.isEmpty {
                    Text(engine.status)
                        .font(.system(.headline, design: .monospaced))
                        .foregroundStyle(Palette.dim)
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 12)
            .padding(.bottom, 44)
        }
    }

    // Video minimized to the top, guide filling the rest.
    private var guideLayout: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .bottomLeading) {
                VideoSurface(player: engine.player)
                if let airing = engine.now {
                    Text("\(String(format: "%02d", engine.channelNumber))  \(engine.channelName.uppercased())  ·  \(airing.program.title)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Palette.amber)
                        .lineLimit(1)
                        .padding(6)
                        .background(.black.opacity(0.6))
                        .padding(8)
                }
            }
            .frame(height: 210)
            .clipped()
            GuideView(engine: engine)
        }
        .ignoresSafeArea(edges: .bottom)
    }
}

struct BannerView: View {
    @ObservedObject var engine: Engine
    let airing: Airing

    private var episodeTag: String {
        guard let s = airing.program.seasonNo, let e = airing.program.episodeNo else { return "" }
        return String(format: "S%02dE%02d  ", s, e)
    }

    private var clock: String {
        let f = DateFormatter(); f.dateFormat = "h:mm a"; return f.string(from: Date())
    }

    var body: some View {
        HStack(spacing: 0) {
            Rectangle().fill(Palette.amber).frame(width: 5)
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(String(format: "%02d", engine.channelNumber))
                        .font(.system(size: 34, weight: .heavy)).foregroundStyle(Palette.amber)
                    Text(engine.channelName.uppercased())
                        .font(.system(.caption, design: .monospaced)).foregroundStyle(Palette.dim)
                    Spacer()
                    Text(clock)
                        .font(.system(.caption, design: .monospaced)).foregroundStyle(Palette.dim)
                }
                Text(airing.program.title)
                    .font(.system(size: 24, weight: .semibold)).foregroundStyle(.white)
                if let sub = airing.program.subtitle {
                    Text(episodeTag + sub).font(.subheadline).foregroundStyle(Palette.dim)
                }
                ProgressView(value: airing.progress).tint(Palette.amber)
            }
            .padding(16)
        }
        .background(.black.opacity(0.72))
        .clipShape(RoundedRectangle(cornerRadius: 4))
    }
}
