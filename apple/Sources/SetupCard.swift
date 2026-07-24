import SwiftUI
import CoreImage.CIFilterBuiltins

/// The "how do I configure this?" affordance shown on the TV when nothing is
/// set up yet: a scannable QR + the URL to open on a phone or laptop. Config
/// lives in the web UI, so this is the whole on-device setup story.
struct SetupCard: View {
    let url: String

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            if let qr = Self.qr(url) {
                qr.interpolation(.none).resizable()
                    .frame(width: 104, height: 104)
                    .padding(8).background(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("SET UP dumbTV")
                    .font(.system(.subheadline, design: .monospaced)).bold()
                    .foregroundStyle(Palette.amber)
                Text("Open this on your phone or laptop:")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Palette.dim)
                Text(url)
                    .font(.system(.callout, design: .monospaced)).bold()
                    .foregroundStyle(.white)
                    .lineLimit(1).minimumScaleFactor(0.5)
            }
        }
        .padding(18)
        .background(.black.opacity(0.74))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    /// A crisp QR for `string`, or nil if generation fails.
    private static func qr(_ string: String) -> Image? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let out = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
              let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return Image(decorative: cg, scale: 1)
    }
}
