import SwiftUI
import dumbTVCore

/// The CRT/VHS look, drawn over the picture (L-V1 — the no-shader tier).
///
/// Every layer here is COMPOSITING. The video pipeline is untouched, which is
/// the whole point of V1: it works with VLCKit exactly as the CSS version works
/// with a `<video>` element, and it needs no Metal rework of the surface that
/// F3 just stabilised. Shaders are V2, gated, and parked in P5.
///
/// Mounted directly above the video surface and BELOW the chrome, matching the
/// browser TV's z-order (`#vibe` sits at z-index 3, over the picture, under the
/// guide and the channel bug). Scanlines over guide text would wreck legibility
/// at 480 lines, and the CRT safe-area rules exist precisely to stop that.
struct VibeOverlay: View {
    let vibe: Vibe
    /// The rect the picture occupies. The overlay tracks it exactly so effects
    /// never spill onto the pillarbox bars when `crop43` is on — the same reason
    /// the web scopes `body.crop43` to `#video`, `#vibe` and `#snow` together.
    let rect: CGRect

    var body: some View {
        if vibe.isActive {
            ZStack {
                if vibe.scanlines > 0 { Scanlines().opacity(vibe.scanlines) }
                if vibe.vignette > 0 { vignetteLayer.opacity(vibe.vignette) }
                if vibe.grain > 0 { Grain(intensity: vibe.grain, coarseness: vibe.grainSize) }
                if vibe.bars > 0 { HumBar().opacity(vibe.bars) }
                if vibe.deadPixels > 0 { deadPixelLayer }
            }
            .frame(width: rect.width, height: rect.height)
            .position(x: rect.midX, y: rect.midY)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    /// The corners of a tube were never as bright as the middle.
    private var vignetteLayer: some View {
        RadialGradient(
            stops: [.init(color: .clear, location: 0.45),
                    .init(color: .black.opacity(0.55), location: 0.88),
                    .init(color: .black.opacity(0.90), location: 1.0)],
            center: .center,
            startRadius: 0,
            // Reaches the corners rather than the edges, so the darkening lands
            // where a tube's actually did.
            endRadius: max(rect.width, rect.height) * 0.75)
    }

    private var deadPixelLayer: some View {
        // Fixed positions from the shared table — a stuck pixel is a property of
        // the set, so it must not move between launches OR between the browser
        // TV and here.
        ForEach(Array(Vibe.deadPixelSpots.prefix(vibe.deadPixels).enumerated()), id: \.offset) { _, p in
            Rectangle()
                .fill(.black)
                .frame(width: 2, height: 2)
                .position(x: rect.width * p.x / 100, y: rect.height * p.y / 100)
        }
    }
}

/// A repeating 3pt line pattern. Drawn with Canvas rather than a stack of views
/// because at 2160 lines that would be a thousand views to lay out every frame.
private struct Scanlines: View {
    var body: some View {
        Canvas { ctx, size in
            // 1pt dark line every 3pt — matches the web's repeating-linear-gradient.
            // NOT 1px: the CRT overlay rules forbid 1px horizontal lines because
            // they shimmer on an interlaced 480-line output. A point is at least
            // one full pixel on every screen we ship to.
            var y: CGFloat = 0
            let line = Color.black.opacity(0.9)
            while y < size.height {
                ctx.fill(Path(CGRect(x: 0, y: y, width: size.width, height: 1)), with: .color(line))
                y += 3
            }
        }
        .drawingGroup()   // rasterise once; the pattern never changes
    }
}

/// The bright band that drifts up a badly-earthed set. One gradient on a slow
/// loop — the compositor owns the motion, so it costs nothing per frame.
private struct HumBar: View {
    var body: some View {
        GeometryReader { geo in
            let h = geo.size.height * 0.22
            TimelineView(.animation) { timeline in
                // Position derived from the clock rather than an animation on
                // state: the overlay is rebuilt whenever the vibe changes, and a
                // state-driven animation would restart the roll on every drag of
                // a slider.
                let t = timeline.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: 7) / 7
                LinearGradient(
                    colors: [.clear, .white.opacity(0.10), .white.opacity(0.16),
                             .white.opacity(0.10), .clear],
                    startPoint: .top, endPoint: .bottom)
                    .frame(height: h)
                    // Bottom to top: mains hum rolls upward on a 50/60 Hz set.
                    .offset(y: geo.size.height - CGFloat(t) * (geo.size.height + h))
            }
        }
        .blendMode(.plusLighter)
    }
}

/// Film/tape grain: a small noise tile, re-offset a few times a second.
///
/// Deliberately NOT redrawn per frame at 60 Hz. Real grain reads as motion at
/// around 12–15 fps, and an Apple TV compositing a full-screen noise field every
/// frame is a genuine thermal and jetsam cost for something that looks no better.
/// One tile is generated once and simply moved.
private struct Grain: View {
    let intensity: Double
    /// 1 = fine film grain, 4 = chunky tape noise. Scales the TILE, so coarser
    /// grain is not more work — the same 96×96 texture drawn larger.
    var coarseness: Double = 1

    /// Generated once per process. 96×96 of static, tiled — big enough that the
    /// repeat is invisible under motion, small enough to be free.
    private static let tile: Image = {
        let side = 96
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        // A fixed sequence, not Math.random()'s cousin: grain that reshuffles on
        // every launch is the kind of detail that reads as a bug in a screenshot
        // diff. Same reasoning as invariant #5, applied to pixels.
        var seed: UInt64 = 0x9E3779B97F4A7C15
        for i in 0..<(side * side) {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            let v = UInt8((seed >> 33) & 0xFF)
            pixels[i * 4 + 0] = v
            pixels[i * 4 + 1] = v
            pixels[i * 4 + 2] = v
            pixels[i * 4 + 3] = 255
        }
        let cs = CGColorSpaceCreateDeviceRGB()
        let ctx = CGContext(data: &pixels, width: side, height: side, bitsPerComponent: 8,
                            bytesPerRow: side * 4, space: cs,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        if let cg = ctx?.makeImage() { return Image(decorative: cg, scale: 1) }
        return Image(systemName: "circle")   // unreachable in practice
    }()

    private static let side: CGFloat = 96

    var body: some View {
        GeometryReader { geo in
            TimelineView(.periodic(from: .now, by: 1.0 / 12.0)) { timeline in
                // Two coprime steps so the tile never settles into a visible
                // rhythm. Derived from the timeline instant rather than a stored
                // counter, so nothing accumulates while the view is off screen.
                let t = Int(timeline.date.timeIntervalSinceReferenceDate * 12)
                let step = Self.side * CGFloat(max(1, min(4, coarseness)))
                let dx = CGFloat((t &* 37) % Int(step)) - step
                let dy = CGFloat((t &* 53) % Int(step)) - step
                Self.tile
                    .resizable(resizingMode: .tile)
                    // Oversized by exactly one tile so the offset can never drag
                    // an edge into view.
                    .frame(width: (geo.size.width + step) / CGFloat(coarseness),
                           height: (geo.size.height + step) / CGFloat(coarseness))
                    // Scale AFTER tiling: the texture is magnified, which is what
                    // makes the speckle coarser rather than merely denser.
                    .scaleEffect(CGFloat(coarseness), anchor: .topLeading)
                    .offset(x: dx, y: dy)
            }
        }
        // 1.0 grain is a bad picture, not a blizzard — the same 0.5 ceiling the
        // browser TV applies when it hands grain to the shared static field.
        .opacity(intensity * 0.5)
        .blendMode(.overlay)
        .clipped()
    }
}
