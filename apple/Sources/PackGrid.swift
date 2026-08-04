import SwiftUI
import dumbTVCore

/// The pack picker: an Apple TV home-screen-style grid of tiles.
///
/// WHY A GRID AND NOT A LIST. A list of rows works on a phone and is miserable
/// on a remote — every row is the same shape, so there is nothing to aim at, and
/// the D-pad only ever moves in one dimension. A grid gives the focus engine two
/// axes and gives each pack a distinct block you can recognise from across a
/// room, which is how every other tvOS app in this category presents a catalogue.
///
/// THERE IS NO ARTWORK. These are 1930s public-domain shorts; there are no
/// posters, and inventing them would mean shipping fake key art for real films.
/// Each tile is a typographic ident instead — a colour field and the pack name in
/// the display face, the way a station logo works. It reads at distance, it needs
/// no assets, and it cannot misrepresent what is inside.
struct PackTile: View {
    let pack: SetupModel.Pack
    let z: CGFloat
    let action: () -> Void

    /// Tile colours, keyed by the manifest's `tint`. A fixed palette rather than
    /// a free hex, so a new pack cannot introduce something that clashes with the
    /// rest of the grid or fails contrast against the title.
    private static let tints: [String: Color] = [
        "deepblue": Color(red: 0.09, green: 0.16, blue: 0.38),
        "steel":    Color(red: 0.16, green: 0.22, blue: 0.29),
        "teal":     Color(red: 0.06, green: 0.28, blue: 0.29),
        "sepia":    Color(red: 0.27, green: 0.20, blue: 0.13),
        "cream":    Color(red: 0.35, green: 0.31, blue: 0.24),
        "olive":    Color(red: 0.21, green: 0.24, blue: 0.13),
        "orange":   Color(red: 0.38, green: 0.20, blue: 0.06),
        "rose":     Color(red: 0.33, green: 0.14, blue: 0.22),
        "yellow":   Color(red: 0.36, green: 0.30, blue: 0.07),
    ]
    private var tint: Color { Self.tints[pack.tint] ?? Palette.prevue1 }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 0) {
                ZStack(alignment: .bottomLeading) {
                    LinearGradient(colors: [tint, tint.opacity(0.55)],
                                   startPoint: .topLeading, endPoint: .bottomTrailing)
                    // Status corner. One glyph, readable at distance — this is
                    // what you scan the grid for, not the text underneath.
                    VStack {
                        HStack {
                            Spacer()
                            if pack.hasChannel {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 22 * z))
                                    .foregroundStyle(Color.green)
                            } else if pack.installed {
                                Image(systemName: "arrow.down.circle.fill")
                                    .font(.system(size: 22 * z))
                                    .foregroundStyle(Palette.amber)
                            }
                        }
                        Spacer()
                    }
                    .padding(8 * z)

                    VStack(alignment: .leading, spacing: 2 * z) {
                        Text(pack.name)
                            .font(Palette.display(19 * z))
                            .foregroundStyle(.white)
                            .lineLimit(2).minimumScaleFactor(0.6)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(pack.era.isEmpty ? "\(pack.itemCount) titles" : pack.era)
                            .font(Palette.meta(10 * z))
                            .foregroundStyle(.white.opacity(0.75))
                    }
                    .padding(10 * z)
                }
                .frame(height: 116 * z)

                // The progress bar lives INSIDE the tile, not in a separate list,
                // so "is this one actually doing something?" is answered from the
                // grid without opening anything.
                if pack.downloading {
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Rectangle().fill(Color.black.opacity(0.5))
                            Rectangle().fill(Palette.amber)
                                .frame(width: max(2, g.size.width * pack.fraction))
                        }
                    }
                    .frame(height: 6 * z)
                    Text("\(Int(pack.fraction * 100))%")
                        .font(Palette.meta(9 * z, .bold))
                        .foregroundStyle(Palette.amber)
                        .padding(.top, 2 * z)
                } else {
                    Text(statusLine)
                        .font(Palette.meta(9 * z))
                        .foregroundStyle(pack.error != nil ? Palette.tally : Palette.dim)
                        .lineLimit(1)
                        .padding(.top, 4 * z)
                }
            }
        }
        .buttonStyle(.plain)
    }

    private var statusLine: String {
        if pack.error != nil { return "FAILED — SELECT TO RETRY" }
        if pack.hasChannel { return "ON A CHANNEL" }
        if pack.installed, pack.installedItemCount < pack.itemCount, pack.installedItemCount > 0 {
            return "PARTIAL — \(pack.installedItemCount)/\(pack.itemCount)"
        }
        if pack.installed { return "DOWNLOADED" }
        return "\(pack.itemCount) · \(pack.sizeLabel)"
    }
}

/// The pack detail screen: what this actually is, before you spend gigabytes on it.
struct PackDetail: View {
    let pack: SetupModel.Pack
    @ObservedObject var model: SetupModel
    let z: CGFloat
    let onBack: () -> Void

    /// Focus starts on the primary action, not on BACK — landing on BACK means
    /// the first press you make leaves the screen you just opened.
    private enum Field: Hashable { case primary, back }
    @FocusState private var focus: Field?

    var body: some View {
        ZStack {
            Palette.prevue2.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16 * z) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(pack.name)
                            .font(Palette.display(30 * z)).foregroundStyle(Palette.amber)
                        Spacer()
                        Button("‹ BACK", action: onBack)
                            .font(Palette.meta(13 * z, .bold))
                            .focused($focus, equals: .back)
                    }

                    // Badges: rating, kid-safe, era, size. The kid-safe answer is
                    // stated either way — "not stated" is the one thing a parent
                    // cannot act on.
                    HStack(spacing: 10 * z) {
                        if !pack.rating.isEmpty { badge(pack.rating, Palette.amber) }
                        if let kid = pack.kidSafe {
                            badge(kid ? "KID-SAFE" : "NOT FOR KIDS", kid ? .green : Palette.tally)
                        }
                        if !pack.era.isEmpty { badge(pack.era, Palette.dim) }
                        badge("\(pack.itemCount) TITLES", Palette.dim)
                        badge(pack.runtimeLabel.uppercased(), Palette.dim)
                        badge(pack.sizeLabel, Palette.dim)
                    }

                    primaryAction

                    if let e = pack.error {
                        para("Last attempt failed: \(e)", Palette.tally)
                    }
                    if !pack.synopsis.isEmpty {
                        heading("WHAT IT IS"); para(pack.synopsis, Palette.tape)
                    }
                    if !pack.history.isEmpty {
                        heading("HISTORY"); para(pack.history, Palette.peri)
                    }
                    if let a = pack.advisory, !a.isEmpty {
                        heading("WORTH KNOWING"); para(a, Palette.amber)
                    }
                }
                .padding(30 * z)
                .frame(maxWidth: 1200 * z, alignment: .leading)
            }
        }
        .task { focus = .primary }
        #if os(tvOS)
        .onExitCommand(perform: onBack)
        #endif
    }

    @ViewBuilder
    private var primaryAction: some View {
        HStack(spacing: 14 * z) {
            if pack.downloading {
                // No action while it runs — offering one would either be a no-op
                // or a cancel we don't implement, and a dead button is worse.
                VStack(alignment: .leading, spacing: 4 * z) {
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Rectangle().fill(Color.black.opacity(0.5))
                            Rectangle().fill(Palette.amber)
                                .frame(width: max(2, g.size.width * pack.fraction))
                        }
                    }
                    .frame(width: 320 * z, height: 8 * z)
                    Text("Downloading — \(Int(pack.fraction * 100))% · \(pack.done)/\(pack.total) files. Keep watching; this carries on in the background.")
                        .font(Palette.meta(10 * z)).foregroundStyle(Palette.amber)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else if pack.hasChannel {
                HStack(spacing: 6 * z) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    Text("ON A CHANNEL").font(Palette.meta(14 * z, .bold)).foregroundStyle(.green)
                }
                Button("REMOVE") { Task { await model.removePack(pack); onBack() } }
                    .font(Palette.meta(12 * z))
                    .focused($focus, equals: .primary)
            } else if pack.installed {
                Button("ADD TO CHANNEL") { Task { await model.makePackChannel(pack) } }
                    .font(Palette.meta(15 * z, .bold))
                    .focused($focus, equals: .primary)
                Button("REMOVE") { Task { await model.removePack(pack); onBack() } }
                    .font(Palette.meta(12 * z))
                if pack.installedItemCount > 0, pack.installedItemCount < pack.itemCount {
                    Button("GET THE OTHER \(pack.itemCount - pack.installedItemCount)") {
                        Task { await model.installPack(pack) }
                    }
                    .font(Palette.meta(12 * z))
                }
            } else {
                Button("DOWNLOAD  ·  \(pack.sizeLabel)") { Task { await model.installPack(pack) } }
                    .font(Palette.meta(15 * z, .bold))
                    .focused($focus, equals: .primary)
            }
        }
    }

    private func badge(_ t: String, _ c: Color) -> some View {
        Text(t).font(Palette.meta(10 * z, .bold)).foregroundStyle(c)
            .padding(.horizontal, 8 * z).padding(.vertical, 4 * z)
            .overlay(Rectangle().stroke(c.opacity(0.55), lineWidth: 1))
    }
    private func heading(_ t: String) -> some View {
        Text(t).font(Palette.meta(11 * z, .bold)).foregroundStyle(Palette.ice)
            .padding(.top, 4 * z)
    }
    private func para(_ t: String, _ c: Color) -> some View {
        Text(t).font(Palette.meta(12 * z)).foregroundStyle(c)
            .fixedSize(horizontal: false, vertical: true)
            .lineSpacing(3 * z)
    }
}
