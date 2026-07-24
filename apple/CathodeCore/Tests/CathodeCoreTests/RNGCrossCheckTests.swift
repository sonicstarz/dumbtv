import XCTest
@testable import CathodeCore

/// Proves the Swift RNG is byte-for-byte identical to the JS one in
/// `src/util/rng.js`. Reference values were produced by running that exact
/// module under Node 22 (see the port notes). If a printed guide says
/// Spider-Man is on at 4:00 on the web build, it must say so on Apple too.
final class RNGCrossCheckTests: XCTestCase {

    func testHashStringMatchesJS() {
        XCTAssertEqual(hashString("abc"), 440920331)
        XCTAssertEqual(hashString("stagger:3:99"), 1019313661)
        XCTAssertEqual(hashString("3:0"), 1230963208)
    }

    func testMulberry32MatchesJS() {
        var r = Mulberry32(seed: 12345)
        let expected = ["0.979728267761", "0.306752264500", "0.484205421526",
                        "0.817934412509", "0.509428369347"]
        for e in expected {
            XCTAssertEqual(String(format: "%.12f", r.next()), e)
        }
    }

    func testSeededShuffleMatchesJS() {
        // Same seed the shuffle ordering mode derives: (99 >>> 0) ^ hash("3:0").
        let seed = (UInt32(99)) ^ hashString("3:0")
        XCTAssertEqual(seed, 1230963307)
        let out = seededShuffle(Array(0..<10), seed: seed)
        XCTAssertEqual(out, [5, 1, 6, 8, 0, 3, 7, 4, 9, 2])
    }
}
