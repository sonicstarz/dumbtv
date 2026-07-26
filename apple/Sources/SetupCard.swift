import SwiftUI
import CoreImage.CIFilterBuiltins

/// The "how do I configure this?" affordance shown on the TV when nothing is
/// set up yet: a scannable QR + the URL to open on a phone or laptop. Config
/// lives in the web UI, so this is the whole on-device setup story.
struct SetupCard: View {
    let url: String
    /// When shown over live channels (not on channel 0 itself), advertise the
    /// permanent way back to this screen. (D3)
    var showChannelHint: Bool = false
    /// If set, shows a dismiss ✕ (C1). Hides the card until next launch WITHOUT
    /// marking setup as seen — channel 0 remains the way back.
    var onDismiss: (() -> Void)? = nil

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
                // On phone/tablet/Mac the config lives on THIS device, so make the
                // URL a tappable link that opens the web UI right here. (On tvOS
                // there's no browser, so it stays plain text to scan with a phone.)
                #if os(tvOS)
                Text(url)
                    .font(.system(.callout, design: .monospaced)).bold()
                    .foregroundStyle(.white)
                    .lineLimit(1).minimumScaleFactor(0.5)
                #else
                if let link = URL(string: url) {
                    Link(destination: link) {
                        HStack(spacing: 6) {
                            Text(url)
                                .font(.system(.callout, design: .monospaced)).bold()
                                .lineLimit(1).minimumScaleFactor(0.5)
                            Image(systemName: "arrow.up.right.square")
                        }
                        .foregroundStyle(Palette.amber)
                    }
                    Text("Tap to open the setup page")
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(Palette.dim)
                }
                #endif
                if showChannelHint {
                    Text("Tune to channel 0 anytime to bring this back.")
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(Palette.dim)
                        .padding(.top, 2)
                }
            }
        }
        .padding(18)
        .background(.black.opacity(0.74))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        #if !os(tvOS)
        // Tap-to-dismiss ✕ (C1) — the user asked for a way to hide the banner.
        // Hides until next launch; does NOT set setup_seen (channel 0 brings it
        // back). Not on tvOS, where it would fight the focus engine.
        .overlay(alignment: .topTrailing) {
            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 20)).foregroundStyle(Palette.dim)
                        .padding(6)
                }
                .buttonStyle(.plain)
            }
        }
        #endif
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Set up dumbTV. Open \(url) in a browser on your phone or laptop.")
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
