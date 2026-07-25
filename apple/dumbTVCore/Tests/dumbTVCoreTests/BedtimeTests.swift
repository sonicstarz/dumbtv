import XCTest
@testable import dumbTVCore

/// "Bedtime": a channel with dark hours must actually go off-air during them and
/// play the rest of the day. This is the family feature the web UI exposes, so
/// it needs to genuinely work end to end (dark hours → synthesized blackout →
/// off-air spans).
final class BedtimeTests: XCTestCase {
    private func makeStore() throws -> Store {
        try Store(path: NSTemporaryDirectory() + "dumbtv-bed-\(UUID().uuidString).db")
    }

    func testDarkHoursGoOffAir() throws {
        let store = try makeStore()
        // Off 20:00 → 07:00. Reason about it in a fixed zone so the wall clock is
        // unambiguous regardless of where the test runs.
        let utc = Clock(timeZone: TimeZone(identifier: "UTC")!)
        let id = store.insertChannel(ChannelConfig(id: 0, number: 5, name: "Kids",
                                                   darkStart: "20:00", darkEnd: "07:00", adsEnabled: false))
        store.addSource(id, ratingKey: "show", sourceType: "show", title: "Cartoons")
        store.upsertMedia((1...12).map { i in
            Media(ratingKey: "c\(i)", parentKey: "show", kind: .episode, title: "Ep \(i)",
                  showTitle: "Cartoons", seasonNo: 1, episodeNo: i, durationMs: 22 * MINUTE, partKey: "/c\(i)")
        })

        // 2024-01-15 00:00 UTC.
        let midnight: Millis = 1_705_276_800_000
        Scheduler.topUp(store: store, now: midnight + 12 * HOUR, windowDays: 2, clock: utc)

        func airing(atHour h: Int) -> Program? {
            let t = midnight + Millis(h) * HOUR
            return Resolver.nowOn(store.programs(id, from: t - HOUR, to: t + HOUR), at: t)?.program
        }

        // Noon: a cartoon is on.
        XCTAssertEqual(airing(atHour: 12)?.kind, .episode, "should be broadcasting at midday")
        // 22:00 and 23:00: off air (bedtime).
        XCTAssertEqual(airing(atHour: 22)?.kind, .offair, "should be off air at 10pm")
        XCTAssertEqual(airing(atHour: 23)?.kind, .offair, "should be off air at 11pm")
        // Back on by 08:00 next morning.
        XCTAssertEqual(airing(atHour: 32)?.kind, .episode, "should be back on by 8am")
    }

    func testNoDarkHoursNeverOffAir() throws {
        let store = try makeStore()
        let utc = Clock(timeZone: TimeZone(identifier: "UTC")!)
        let id = store.insertChannel(ChannelConfig(id: 0, number: 6, name: "AllDay", adsEnabled: false))
        store.addSource(id, ratingKey: "s", sourceType: "show", title: "S")
        store.upsertMedia((1...12).map { i in
            Media(ratingKey: "e\(i)", parentKey: "s", kind: .episode, title: "E\(i)",
                  showTitle: "S", seasonNo: 1, episodeNo: i, durationMs: 30 * MINUTE, partKey: "/e\(i)")
        })
        let midnight: Millis = 1_705_276_800_000
        Scheduler.topUp(store: store, now: midnight, windowDays: 2, clock: utc)
        for h in [3, 22] {   // no dark hours → content at 3am and 10pm alike
            let t = midnight + Millis(h) * HOUR
            XCTAssertEqual(Resolver.nowOn(store.programs(id, from: t - HOUR, to: t + HOUR), at: t)?.program.kind,
                           .episode, "a 24h channel should never be off air (hour \(h))")
        }
    }
}
