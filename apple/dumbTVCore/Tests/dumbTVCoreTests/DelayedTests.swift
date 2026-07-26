import XCTest
@testable import dumbTVCore

/// Regression tests for build-12 bug F1. These model the channel banner exactly
/// as `Engine.showBanner()` drives it: reveal, arm a hide timer, and on the next
/// reveal cancel the old timer. Under the old hand-rolled
/// `try? await Task.sleep` the cancellation FIRED the hide, so the banner
/// disappeared within a frame of every channel change.
@MainActor
final class DelayedTests: XCTestCase {

    /// A reference box so the closures below mutate shared state without
    /// capturing a local `var`.
    private final class Flag {
        var value: Bool
        init(_ value: Bool) { self.value = value }
    }

    /// THE regression: show the banner twice in a row → it must still be
    /// visible. The second show cancels the first hide-timer, and a cancelled
    /// timer must not run its body.
    func testRestartingATimerDoesNotFireTheCancelledOne() async {
        let banner = Flag(false)
        var hide: Task<Void, Never>?

        func showBanner() {
            banner.value = true
            hide?.cancel()
            hide = Delayed.onMain(5.0) { banner.value = false }
        }

        showBanner()
        showBanner()   // ← tune() does exactly this (sync() shows it, then tune() shows it)

        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertTrue(banner.value, "a cancelled delayed effect fired its body")
        hide?.cancel()
    }

    /// Repeated interaction keeps pushing the hide out rather than killing it —
    /// the mute/CC → double-tap sequence from the device report.
    func testRepeatedRestartsKeepTheEffectPending() async {
        let banner = Flag(false)
        var hide: Task<Void, Never>?
        for _ in 0..<5 {
            banner.value = true
            hide?.cancel()
            hide = Delayed.onMain(5.0) { banner.value = false }
            try? await Task.sleep(nanoseconds: 30_000_000)
        }
        XCTAssertTrue(banner.value, "rapid restarts hid the banner")
        hide?.cancel()
    }

    /// …but a timer left alone still fires. A guard that swallowed every firing
    /// would pass the tests above and break the product.
    func testAnUncancelledTimerStillFires() async {
        let banner = Flag(true)
        Delayed.onMain(0.1) { banner.value = false }
        try? await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertFalse(banner.value, "the delayed effect never ran")
    }

    /// Multi-digit dialling: each digit restarts the commit window instead of
    /// committing it, so three-digit channel numbers are reachable (symptom C).
    func testEachKeystrokeRestartsTheCommitWindowInsteadOfCommitting() async {
        let committed = Flag(false)
        var dialing = ""
        var dial: Task<Void, Never>?

        func pressDigit(_ d: String) {
            dialing += d
            dial?.cancel()
            dial = Delayed.onMain(1.5) { committed.value = true }
        }

        pressDigit("1"); pressDigit("0"); pressDigit("2")
        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertFalse(committed.value, "the dial committed before the window closed")
        XCTAssertEqual(dialing, "102", "a third digit was unreachable")
        dial?.cancel()
    }
}
