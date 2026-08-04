import XCTest
@testable import dumbTVCore

/// The Swift half of the vibe model has to agree with `src/vibe.js` exactly —
/// the web UI names a preset and BOTH engines have to render the same look, and
/// a database written by one has to be readable by the other.
final class VibeTests: XCTestCase {

    func testOffIsInert() {
        XCTAssertFalse(Vibe.off.isActive)
    }

    /// New knobs must be in the presets on BOTH sides or a preset means two
    /// different looks depending on which engine drew it.
    func testPresetsCarryTheNewKnobs() {
        XCTAssertEqual(Vibe.presets["vhs"]!.grainSize, 2.5)
        XCTAssertEqual(Vibe.presets["vhs"]!.bars, 0.25, accuracy: 0.0001)
        XCTAssertEqual(Vibe.presets["vhs"]!.chromaShift, 0.35, accuracy: 0.0001)
        XCTAssertEqual(Vibe.presets["rough"]!.grainSize, 3.5)
        XCTAssertEqual(Vibe.presets["crt"]!.bars, 0)
        XCTAssertEqual(Vibe.presets["off"]!.grainSize, 1)
    }

    /// Preset values are copied from src/vibe.js. If someone edits one side,
    /// this is what says so.
    func testPresetsMatchTheNodeValues() {
        let crt = Vibe.presets["crt"]!
        XCTAssertTrue(crt.crop43)
        XCTAssertEqual(crt.scanlines, 0.22, accuracy: 0.0001)
        XCTAssertEqual(crt.vignette, 0.35, accuracy: 0.0001)
        XCTAssertEqual(crt.grain, 0.05, accuracy: 0.0001)
        XCTAssertEqual(crt.deadPixels, 0)
        XCTAssertEqual(crt.bleed, 0.15, accuracy: 0.0001)

        let vhs = Vibe.presets["vhs"]!
        XCTAssertEqual(vhs.deadPixels, 2)
        XCTAssertEqual(vhs.bleed, 0.35, accuracy: 0.0001)

        let rough = Vibe.presets["rough"]!
        XCTAssertEqual(rough.deadPixels, 6)
        XCTAssertEqual(rough.scanlines, 0.30, accuracy: 0.0001)

        XCTAssertFalse(Vibe.presets["off"]!.isActive)
    }

    /// The two knobs Apple cannot render must round-trip and be reported
    /// honestly, not dropped — the web UI still stores them, the browser TV
    /// still draws them, and the panel labels them per platform.
    func testPixelKnobsSurviveEvenThoughAppleIgnoresThem() {
        let v = Vibe.parse(#"{"bleed":0.4,"chromaShift":0.6}"#)
        XCTAssertEqual(v?.bleed, 0.4)
        XCTAssertEqual(v?.chromaShift, 0.6)
        XCTAssertFalse(v!.isActive)   // neither draws here, so the stack stays off
    }

    /// grainSize is a MULTIPLIER (1–4), not a 0–1 intensity, and it must default
    /// to 1. A document written before the knob existed has to come back as fine
    /// grain — zero would be an invisible bug rather than a look.
    func testGrainSizeDefaultsToOneNotZero() {
        XCTAssertEqual(Vibe.parse(#"{"grain":0.3}"#)?.grainSize, 1)
        XCTAssertEqual(Vibe.fromAny(["grain": 0.3])?.grainSize, 1)
        XCTAssertEqual(Vibe(grainSize: 0).grainSize, 1)
        XCTAssertEqual(Vibe(grainSize: 99).grainSize, 4)
        XCTAssertEqual(Vibe(grainSize: 2.5).grainSize, 2.5)
    }

    func testHumBarActivatesTheOverlay() {
        // bars IS renderable here, unlike bleed/chromaShift.
        XCTAssertTrue(Vibe(bars: 0.3).isActive)
    }

    func testClamping() {
        let v = Vibe(scanlines: 5, vignette: -2, grain: .nan, deadPixels: 99, bleed: 0.5)
        XCTAssertEqual(v.scanlines, 1)
        XCTAssertEqual(v.vignette, 0)
        XCTAssertEqual(v.grain, 0)          // NaN is not a value, it is a bug arriving
        XCTAssertEqual(v.deadPixels, 12)    // the spot table has exactly 12 entries
        XCTAssertEqual(v.bleed, 0.5, accuracy: 0.0001)
    }

    func testDeadPixelSpotsCoverTheMaximum() {
        // deadPixels clamps to 12, so the table must have at least 12 or the
        // renderer would silently draw fewer than asked.
        XCTAssertGreaterThanOrEqual(Vibe.deadPixelSpots.count, 12)
    }

    // MARK: - resolution

    func testChannelBeatsGlobal() {
        let channel = Vibe.presets["vhs"]!
        let global = Vibe.presets["crt"]!
        XCTAssertEqual(Vibe.resolve(channel, global), channel)
    }

    func testGlobalUsedWhenChannelHasNone() {
        let global = Vibe.presets["crt"]!
        XCTAssertEqual(Vibe.resolve(nil, global), global)
    }

    func testNothingSetResolvesToOff() {
        XCTAssertEqual(Vibe.resolve(nil, nil), .off)
        XCTAssertFalse(Vibe.resolve(nil, nil).isActive)
    }

    /// The scope list is variadic precisely so a per-ITEM look can be added
    /// ahead of the channel without touching the model (owner allowed per-item
    /// 2026-08-03). This proves the ordering holds for three scopes.
    func testPerItemWouldWinIfSupplied() {
        let item = Vibe.presets["rough"]!
        let channel = Vibe.presets["vhs"]!
        let global = Vibe.presets["crt"]!
        XCTAssertEqual(Vibe.resolve(item, channel, global), item)
    }

    // MARK: - storage round-trip

    func testRoundTripThroughJSON() {
        let v = Vibe.presets["vhs"]!
        XCTAssertEqual(Vibe.parse(v.encoded()), v)
    }

    func testGarbageParsesToNilRatherThanThrowing() {
        XCTAssertNil(Vibe.parse(nil))
        XCTAssertNil(Vibe.parse(""))
        XCTAssertNil(Vibe.parse("not json"))
    }

    /// A document missing keys must keep the ones it HAS rather than being
    /// discarded wholesale — otherwise one knob added on the Node side would
    /// silently switch a channel's look off on an older Apple build.
    func testPartialDocumentKeepsWhatItKnows() {
        let v = Vibe.parse(#"{"scanlines":0.5,"crop43":true}"#)
        XCTAssertNotNil(v)
        XCTAssertEqual(v?.scanlines, 0.5)
        XCTAssertEqual(v?.crop43, true)
        XCTAssertEqual(v?.vignette, 0)
    }

    /// Unknown keys are ignored for the same reason, in the other direction:
    /// the web UI is expected to grow knobs (grain size, hum bars, chroma
    /// shift) and an older build must keep rendering the ones it understands.
    func testUnknownKeysAreIgnored() {
        let v = Vibe.parse(#"{"scanlines":0.4,"humBars":0.9,"chromaShift":0.3}"#)
        XCTAssertEqual(v?.scanlines, 0.4)
    }

    /// `bleed` renders nothing on Apple (VLCKit owns the pixels — it is V2/Metal
    /// work), so a vibe carrying ONLY bleed must not switch the overlay stack on
    /// to draw an empty layer.
    func testBleedAloneDoesNotActivateTheOverlay() {
        XCTAssertFalse(Vibe(bleed: 0.8).isActive)
        XCTAssertTrue(Vibe(scanlines: 0.1).isActive)
        XCTAssertTrue(Vibe(crop43: true).isActive)
    }
}
