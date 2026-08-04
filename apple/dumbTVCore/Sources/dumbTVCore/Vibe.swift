import Foundation

/// The per-channel CRT/VHS look (L-V1) — the Swift half of `src/vibe.js`.
///
/// ── why this file exists ────────────────────────────────────────────────────
/// Vibe shipped on the browser TV only. The model, the presets, the storage and
/// the live application were all there; the Apple apps had no vibe code at all.
/// So an owner who set a look in the web UI and then watched an Apple TV saw
/// nothing happen and reasonably concluded the feature was broken. It wasn't —
/// it was simply absent on the platform they were looking at.
///
/// ── the structural decision, inherited deliberately ─────────────────────────
/// A vibe is a SELF-CONTAINED DOCUMENT, not a spread of columns, and resolution
/// is a LIST of scopes rather than a fixed pair. That is what makes per-ITEM
/// overrides (a Track M tape carrying its own worn look) one more argument to
/// `resolve` instead of a schema change. Owner confirmed 2026-08-03 that
/// per-item is allowed in the model, so this shape is now load-bearing.
///
///     resolution: item (not yet exposed) → channel → global default → off
///
/// ── what Apple can and cannot do ────────────────────────────────────────────
/// Everything here is COMPOSITING — layers drawn over the picture — so it works
/// with VLCKit's video output untouched, exactly like the CSS overlays do in the
/// browser. `bleed` and `chromaShift` are the exceptions: nudging chroma or
/// splitting colour channels means touching the DECODED PIXELS, and VLCKit owns
/// those. Both stay no-ops on Apple until the V2 Metal tier (P5), and the web UI
/// labels those two knobs "not on Apple TV yet" rather than offering sliders
/// that silently do nothing on the device you are watching.
/// (`VIBE_PIXEL_KNOBS` in src/vibe.js is the same list, for the UI.)
public struct Vibe: Codable, Hashable, Sendable {
    /// Pillarbox to 4:3 — the phase notes call this the single biggest
    /// "it looks right" win, and it is one rule.
    public var crop43: Bool
    /// 0–1, opacity of the line pattern.
    public var scanlines: Double
    /// 0–1, corner darkening.
    public var vignette: Double
    /// 0–1, persistent static over the picture.
    public var grain: Double
    /// Count of fixed stuck pixels, 0–12.
    public var deadPixels: Int
    /// 1–4, how COARSE the static is (1 = fine film grain, 4 = chunky tape).
    /// Separate from `grain`, which is how much of it there is.
    public var grainSize: Double
    /// 0–1, chroma bleed. **Not rendered on Apple** — see the note above.
    public var bleed: Double
    /// 0–1, the rolling hum bar that drifts up a badly-earthed set.
    public var bars: Double
    /// 0–1, colour fringing. **Not rendered on Apple** — same reason as `bleed`.
    public var chromaShift: Double

    public init(crop43: Bool = false, scanlines: Double = 0, vignette: Double = 0,
                grain: Double = 0, grainSize: Double = 1, deadPixels: Int = 0,
                bleed: Double = 0, bars: Double = 0, chromaShift: Double = 0) {
        self.crop43 = crop43
        self.scanlines = Self.clamp01(scanlines)
        self.vignette = Self.clamp01(vignette)
        self.grain = Self.clamp01(grain)
        // A multiplier, not an intensity, so it clamps to its own range and
        // defaults to 1 — a grain size of zero is an invisible bug, not a look,
        // and a document predating this knob must come back as fine grain.
        self.grainSize = grainSize.isFinite ? max(1, min(4, grainSize)) : 1
        self.deadPixels = max(0, min(12, deadPixels))
        self.bleed = Self.clamp01(bleed)
        self.bars = Self.clamp01(bars)
        self.chromaShift = Self.clamp01(chromaShift)
    }

    /// Every knob at the value that means "do nothing".
    public static let off = Vibe()

    /// Presets, so nobody has to dial six numbers to get somewhere good.
    /// Values are copied from `src/vibe.js` and must stay in lockstep — the web
    /// UI names a preset and both engines have to agree what that name means.
    public static let presets: [String: Vibe] = [
        "off": .off,
        // A tidy set in good condition — the look most people mean by "CRT".
        "crt": Vibe(crop43: true, scanlines: 0.22, vignette: 0.35, grain: 0.05, grainSize: 1,
                    deadPixels: 0, bleed: 0.15, bars: 0, chromaShift: 0.1),
        // A tape that has been through the machine a few hundred times.
        "vhs": Vibe(crop43: true, scanlines: 0.14, vignette: 0.30, grain: 0.16, grainSize: 2.5,
                    deadPixels: 2, bleed: 0.35, bars: 0.25, chromaShift: 0.35),
        // A set in the corner of a bar with a bent aerial.
        "rough": Vibe(crop43: true, scanlines: 0.30, vignette: 0.50, grain: 0.30, grainSize: 3.5,
                      deadPixels: 6, bleed: 0.45, bars: 0.5, chromaShift: 0.5),
    ]

    /// Does this vibe do anything at all? Used to skip the whole overlay stack,
    /// so an unstyled channel costs nothing per frame.
    public var isActive: Bool {
        crop43 || scanlines > 0 || vignette > 0 || grain > 0 || deadPixels > 0 || bars > 0
        // `bleed` and `chromaShift` deliberately excluded: they render nothing
        // here (they need the decoded pixels, which VLCKit owns — V2/Metal
        // work), so a vibe setting only those must not switch the overlay stack
        // on to draw an empty layer.
    }

    /// First non-nil scope wins, most-specific first — the same shape as
    /// `resolveVibe(...scopes)` in tv.js.
    ///
    /// That function merges each scope onto `off` in reverse order, which is
    /// EQUIVALENT to first-wins here because both sides only ever store complete
    /// documents (`normalizeVibe` fills every key; the decoder below defaults
    /// every key). Worth knowing they are equivalent by that invariant and not
    /// by construction — if partial documents ever became a thing, this would
    /// need to merge rather than pick.
    public static func resolve(_ scopes: Vibe?...) -> Vibe {
        for s in scopes { if let s { return s } }
        return .off
    }

    /// Decode a stored document. Anything unparseable resolves to "no vibe set"
    /// rather than throwing — a corrupt setting must never stop the television.
    public static func parse(_ json: String?) -> Vibe? {
        guard let json, !json.isEmpty, let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(Vibe.self, from: data)
    }

    /// Encode for storage. Matches the shape `normalizeVibe()` writes in Node.
    public func encoded() -> String? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Serialise for a JSON response — the web UI reads these to fill its
    /// controls, and its preset dropdown compares against `vibePresets`.
    public var asDictionary: [String: Any] {
        ["crop43": crop43, "scanlines": scanlines, "vignette": vignette,
         "grain": grain, "grainSize": grainSize, "deadPixels": deadPixels,
         "bleed": bleed, "bars": bars, "chromaShift": chromaShift]
    }

    /// Coerce a decoded-JSON value from a request body, the way `normalizeVibe`
    /// does on the Node side: a dictionary becomes a clamped vibe, and anything
    /// else — including an explicit `null` — becomes nil, which callers store as
    /// "no vibe set" so the next scope up applies.
    public static func fromAny(_ any: Any?) -> Vibe? {
        guard let d = any as? [String: Any] else { return nil }
        func num(_ k: String) -> Double {
            if let v = d[k] as? Double { return v }
            if let v = d[k] as? Int { return Double(v) }
            if let v = d[k] as? NSNumber { return v.doubleValue }
            return 0
        }
        // grainSize defaults to 1, not 0 — see the initialiser.
        let size = d["grainSize"] == nil ? 1 : num("grainSize")
        return Vibe(crop43: (d["crop43"] as? Bool) ?? ((d["crop43"] as? NSNumber)?.boolValue ?? false),
                    scanlines: num("scanlines"), vignette: num("vignette"), grain: num("grain"),
                    grainSize: size, deadPixels: Int(num("deadPixels").rounded()),
                    bleed: num("bleed"), bars: num("bars"), chromaShift: num("chromaShift"))
    }

    /// Fixed positions for stuck pixels, as percentages of the picture.
    ///
    /// The SAME sequence as tv.js, because a stuck pixel is a property of the
    /// set: switching from the browser TV to the Apple TV should not move it.
    /// And they never move between launches either — a stuck pixel that wanders
    /// is not a stuck pixel.
    public static let deadPixelSpots: [(x: Double, y: Double)] = [
        (17, 23), (62, 11), (38, 77), (84, 44), (9, 58), (71, 89),
        (46, 31), (93, 67), (28, 6), (55, 95), (77, 19), (12, 41),
    ]

    private static func clamp01(_ v: Double) -> Double {
        v.isFinite ? max(0, min(1, v)) : 0
    }

    // MARK: - tolerant decoding
    //
    // Every key is optional on the way IN, defaulting to off, and the values run
    // back through `init` so they are clamped. Synthesised Codable would reject a
    // document missing a key and `parse` would then discard the whole vibe — so
    // one knob added on the Node side, or one hand-edited setting, would silently
    // turn a channel's look off entirely instead of ignoring the part it doesn't
    // understand. Unknown keys are ignored for the same reason: the web UI is
    // expected to grow knobs (grain size, hum bars, chroma shift) and an older
    // build must keep rendering the ones it does know.
    private enum CodingKeys: String, CodingKey {
        case crop43, scanlines, vignette, grain, grainSize, deadPixels, bleed, bars, chromaShift
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            crop43: (try? c.decodeIfPresent(Bool.self, forKey: .crop43)) .flatMap { $0 } ?? false,
            scanlines: (try? c.decodeIfPresent(Double.self, forKey: .scanlines)).flatMap { $0 } ?? 0,
            vignette: (try? c.decodeIfPresent(Double.self, forKey: .vignette)).flatMap { $0 } ?? 0,
            grain: (try? c.decodeIfPresent(Double.self, forKey: .grain)).flatMap { $0 } ?? 0,
            grainSize: (try? c.decodeIfPresent(Double.self, forKey: .grainSize)).flatMap { $0 } ?? 1,
            deadPixels: (try? c.decodeIfPresent(Int.self, forKey: .deadPixels)).flatMap { $0 } ?? 0,
            bleed: (try? c.decodeIfPresent(Double.self, forKey: .bleed)).flatMap { $0 } ?? 0,
            bars: (try? c.decodeIfPresent(Double.self, forKey: .bars)).flatMap { $0 } ?? 0,
            chromaShift: (try? c.decodeIfPresent(Double.self, forKey: .chromaShift)).flatMap { $0 } ?? 0)
    }
}
