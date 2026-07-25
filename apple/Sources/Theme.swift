import SwiftUI
import CoreText

/// The dumbTV retro palette + type — the same design language as the web TV
/// (`public/tv.html`): Archivo Black for channel numbers and idents, a mono
/// face for all meta text, prevue blues, amber, square corners everywhere.
enum Palette {
    static let amber = Color(red: 0.949, green: 0.694, blue: 0.204)   // #F2B134
    static let tape = Color(red: 0.910, green: 0.894, blue: 0.851)    // #E8E4D9
    static let dim = Color(red: 0.663, green: 0.643, blue: 0.722)     // #A9A4B8
    static let tally = Color(red: 0.878, green: 0.282, blue: 0.247)   // #E0483F
    static let prevue1 = Color(red: 0.169, green: 0.227, blue: 0.561) // #2B3A8F
    static let prevue2 = Color(red: 0.086, green: 0.125, blue: 0.353) // #16205A
    static let ice = Color(red: 0.875, green: 0.894, blue: 1.0)       // #DFE4FF — guide channel names
    static let peri = Color(red: 0.725, green: 0.761, blue: 0.941)    // #B9C2F0 — guide subtitles
    /// The banner/digits band — rgba(6,6,10,.82) in the web TV.
    static let band = Color(red: 6/255, green: 6/255, blue: 10/255).opacity(0.82)

    /// The display face: Archivo Black (bundled, OFL) — the chunky Prevue look.
    /// Falls back to heavy system if the font failed to register.
    static func display(_ size: CGFloat) -> Font {
        registerFontsOnce
        return .custom("Archivo Black", size: size)
    }

    /// The meta face — mono, like IBM Plex Mono on the web.
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }

    /// Register the bundled TTF with CoreText, once, lazily on first use.
    private static let registerFontsOnce: Void = {
        guard let url = Bundle.main.url(forResource: "ArchivoBlack-Regular", withExtension: "ttf") else {
            print("dumbTV: ArchivoBlack-Regular.ttf not bundled — falling back to system font")
            return
        }
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }()
}

/// A flat 5px progress bar — the web TV's `.bar` (no rounded track, no gloss).
struct RetroBar: View {
    let progress: Double
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Rectangle().fill(Color.white.opacity(0.16))
                Rectangle().fill(Palette.amber)
                    .frame(width: geo.size.width * min(max(progress, 0), 1))
            }
        }
        .frame(height: 5)
    }
}
