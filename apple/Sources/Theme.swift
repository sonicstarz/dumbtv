import SwiftUI
import CoreText

/// The dumbTV retro palette + type — the same design language as the web TV
/// (`public/tv.html`): Archivo Black for channel numbers and idents, Archivo for
/// all meta text, prevue blues, amber, square corners everywhere.
///
/// Both faces are one superfamily on purpose. The meta face used to be the
/// system monospace, which made every screen read like a terminal rather than a
/// television.
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

    /// The meta face — Archivo (bundled, OFL), the regular-width sibling of the
    /// display face.
    ///
    /// This used to be `.system(design: .monospaced)`. Every label, title and
    /// caption in the app was therefore set in SF Mono, which made a television
    /// read like a code editor — the single biggest reason the UI looked
    /// generic (build 24 owner review). Archivo shares its skeleton with Archivo
    /// Black, so the guide is now ONE family rather than two unrelated faces.
    ///
    /// Weights map to real static cuts, not a variable axis: SwiftUI's
    /// `.weight()` does not reliably drive variation axes on a custom face, and
    /// the failure is silent — you get the regular cut and no error.
    static func meta(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        registerFontsOnce
        return .custom(cut(weight), size: size)
    }

    /// The meta face at a Dynamic Type text style, for the views that size
    /// semantically rather than in points (`SetupCard`).
    static func meta(_ style: Font.TextStyle, _ weight: Font.Weight = .regular) -> Font {
        registerFontsOnce
        return .custom(cut(weight), size: basePoints(style), relativeTo: style)
    }

    /// Meta face with tabular figures — the clock, and any digits that sit in a
    /// column. A tuner's numbers should not jitter as they tick; that is
    /// different from setting the whole interface in a monospace.
    static func digits(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        meta(size, weight).monospacedDigit()
    }

    /// PostScript names, verified against CoreText rather than assumed — a
    /// wrong name here falls back to the system face silently.
    private static func cut(_ w: Font.Weight) -> String {
        switch w {
        case .bold, .heavy, .black:      return "Archivo-Bold"
        case .semibold, .medium:         return "Archivo-SemiBold"
        default:                         return "Archivo-Regular"
        }
    }

    /// Apple's default point size per text style, so `relativeTo:` scales from
    /// the size the system would have used.
    private static func basePoints(_ s: Font.TextStyle) -> CGFloat {
        switch s {
        case .largeTitle: return 34
        case .title:      return 28
        case .title2:     return 22
        case .title3:     return 20
        case .headline, .body: return 17
        case .callout:    return 16
        case .subheadline: return 15
        case .footnote:   return 13
        case .caption:    return 12
        default:          return 11
        }
    }

    /// Register the bundled TTFs with CoreText, once, lazily on first use.
    private static let registerFontsOnce: Void = {
        for name in ["ArchivoBlack-Regular", "Archivo-Regular", "Archivo-SemiBold", "Archivo-Bold"] {
            guard let url = Bundle.main.url(forResource: name, withExtension: "ttf") else {
                print("dumbTV: \(name).ttf not bundled — falling back to system font")
                continue
            }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
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
