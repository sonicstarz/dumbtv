import Foundation

/// A restartable "do this in N seconds" timer that does **not** fire when it is
/// cancelled.
///
/// This exists because the obvious spelling is wrong in a way that looks right:
///
/// ```swift
/// hideTask?.cancel()
/// hideTask = Task { @MainActor in
///     try? await Task.sleep(nanoseconds: 5_000_000_000)
///     self.bannerVisible = false        // ← runs IMMEDIATELY on cancel
/// }
/// ```
///
/// `Task.sleep` throws `CancellationError` the instant its task is cancelled,
/// and `try?` swallows it — so everything after the sleep executes right away.
/// A timer written that way self-destructs the moment anything restarts it.
///
/// That was dumbTV build 12's bug F1, and it had four faces: the channel banner
/// died on every channel change (tune() revealed it twice in a row), it died
/// again on any interaction within 5s of a mute/CC press, multi-digit dialling
/// committed on the second digit (making channels ≥ 100 unreachable), and the
/// same ⊘ glyph flashed twice cleared itself instantly.
///
/// Schedule delayed UI effects through this, not by hand.
public enum Delayed {
    /// Run `body` on the main actor after `seconds`, unless cancelled first.
    /// Cancelling the returned task means the body never runs — which is the
    /// entire point.
    @MainActor
    @discardableResult
    public static func onMain(_ seconds: Double,
                              _ body: @MainActor @escaping () -> Void) -> Task<Void, Never> {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
            guard !Task.isCancelled else { return }
            body()
        }
    }
}
