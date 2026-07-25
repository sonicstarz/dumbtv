import XCTest
@testable import dumbTVCore

/// Guards the invariant the app was violating: a persisted, append-only schedule
/// that does NOT rewind when you regenerate at a later time. This is the test
/// that would have caught "every restart plays episode 1 on every channel."
final class SchedulerPersistenceTests: XCTestCase {
    private func makeStore() throws -> Store {
        try Store(path: NSTemporaryDirectory() + "dumbtv-sched-\(UUID().uuidString).db")
    }

    /// A channel with one show of N fixed-length episodes.
    @discardableResult
    private func seedChannel(_ store: Store, number: Int = 2, episodes: Int = 30,
                             durMin: Int = 22, ordering: OrderingMode = .sequential) -> Int {
        let id = store.insertChannel(ChannelConfig(id: 0, number: number, name: "Ch\(number)",
                                                   orderingMode: ordering, shuffleSeed: 99, adsEnabled: false))
        store.addSource(id, ratingKey: "show1", sourceType: "show", title: "Show One")
        let eps = (1...episodes).map { i in
            Media(ratingKey: "s1e\(i)", parentKey: "show1", kind: .episode,
                  title: "Episode \(i)", showTitle: "Show One", seasonNo: 1, episodeNo: i,
                  aired: String(format: "2001-01-%02d", min(i, 28)),
                  durationMs: Millis(durMin) * MINUTE, partKey: "/part/\(i)")
        }
        store.upsertMedia(eps)
        return id
    }

    // MARK: persistence round-trip

    func testTopUpPersistsAndReadsBack() throws {
        let store = try makeStore()
        seedChannel(store)
        let now: Millis = 1_700_000_000_000
        Scheduler.topUp(store: store, now: now, windowDays: 2)

        let progs = store.programs(1, from: now, to: now + 2 * DAY)
        XCTAssertFalse(progs.isEmpty, "top-up should persist programs")

        // No gaps, no overlaps across the airing programs.
        for i in 1..<progs.count {
            XCTAssertEqual(progs[i].startUtc, progs[i - 1].endUtc,
                           "programs must run back-to-back with no gap/overlap")
        }
        // Something is airing right now.
        XCTAssertNotNil(Resolver.nowOn(progs, at: now))
    }

    // MARK: THE invariant — no rewind across a later regeneration

    func testScheduleDoesNotRewindAcrossTopUps() throws {
        let store = try makeStore()
        seedChannel(store, episodes: 50, durMin: 22)
        let t0: Millis = 1_700_000_000_000

        Scheduler.topUp(store: store, now: t0, windowDays: 14)
        let airingAtT0 = try XCTUnwrap(Resolver.nowOn(store.programs(1, from: t0, to: t0 + DAY), at: t0))

        // Simulate a later app launch / hourly top-up, one hour on.
        let t1 = t0 + HOUR
        Scheduler.topUp(store: store, now: t1, windowDays: 14)

        // 1. The program that was airing at t0 is unchanged (append-only past).
        let stillAtT0 = try XCTUnwrap(Resolver.nowOn(store.programs(1, from: t0, to: t0 + DAY), at: t0))
        XCTAssertEqual(stillAtT0.program.startUtc, airingAtT0.program.startUtc)
        XCTAssertEqual(stillAtT0.program.ratingKey, airingAtT0.program.ratingKey)

        // 2. An hour later we are LATER in the show, not rewound to episode 1.
        let airingAtT1 = try XCTUnwrap(Resolver.nowOn(store.programs(1, from: t1, to: t1 + DAY), at: t1))
        XCTAssertGreaterThan(airingAtT1.program.startUtc, airingAtT0.program.startUtc,
                             "an hour later the timeline must have advanced, not reset")
    }

    /// A fresh Store loaded twice (like quitting and reopening the app) keeps the
    /// same program on air — the restart-survival guarantee.
    func testRestartKeepsSameProgramOnAir() throws {
        let path = NSTemporaryDirectory() + "dumbtv-restart-\(UUID().uuidString).db"
        let now: Millis = 1_700_000_000_000

        var firstKey: String?
        do {
            let store = try Store(path: path)
            seedChannel(store, episodes: 40)
            Scheduler.topUp(store: store, now: now, windowDays: 14)
            firstKey = Resolver.nowOn(store.programs(1, from: now, to: now + DAY), at: now)?.program.ratingKey
        }
        // Reopen the same DB file — no regeneration, just read.
        let reopened = try Store(path: path)
        let afterKey = Resolver.nowOn(reopened.programs(1, from: now, to: now + DAY), at: now)?.program.ratingKey
        XCTAssertNotNil(firstKey)
        XCTAssertEqual(firstKey, afterKey, "reopening must show the same program, not restart")
    }

    // MARK: regenerate preserves what's airing

    func testRegenerateKeepsAiringNow() throws {
        let store = try makeStore()
        let id = seedChannel(store, episodes: 30)
        let now: Millis = 1_700_000_000_000
        Scheduler.topUp(store: store, now: now, windowDays: 14)
        let before = try XCTUnwrap(Resolver.nowOn(store.programs(id, from: now, to: now + DAY), at: now))

        // Add another show and regenerate — the current program must not jump.
        store.addSource(id, ratingKey: "show2", sourceType: "show", title: "Show Two")
        store.upsertMedia([Media(ratingKey: "s2e1", parentKey: "show2", kind: .episode,
                                 title: "Two Pilot", showTitle: "Show Two", seasonNo: 1, episodeNo: 1,
                                 durationMs: 20 * MINUTE, partKey: "/p2")])
        Scheduler.regenerate(store: store, channelId: id, now: now, windowDays: 14)

        let after = try XCTUnwrap(Resolver.nowOn(store.programs(id, from: now, to: now + DAY), at: now))
        XCTAssertEqual(after.program.startUtc, before.program.startUtc)
        XCTAssertEqual(after.program.ratingKey, before.program.ratingKey,
                       "regeneration must leave the currently-airing program alone")
    }

    /// A channel generated while empty shows a "No content selected" span. Once
    /// content is added and it regenerates, that placeholder must be replaced by
    /// real programming NOW — not left to run out its 14-day span.
    func testEmptyChannelStartsPlayingAfterContentAdded() throws {
        let store = try makeStore()
        let id = store.insertChannel(ChannelConfig(id: 0, number: 5, name: "Empty", adsEnabled: false))
        let now: Millis = 1_700_000_000_000
        Scheduler.topUp(store: store, now: now, windowDays: 14)
        // Empty channel: airing an off-air placeholder.
        XCTAssertEqual(Resolver.nowOn(store.programs(id, from: now - HOUR, to: now + DAY), at: now)?.program.kind,
                       .offair)

        // Add a show and regenerate (what a web-UI "add content" does).
        store.addSource(id, ratingKey: "showX", sourceType: "show", title: "Show X")
        store.upsertMedia((1...10).map { i in
            Media(ratingKey: "x\(i)", parentKey: "showX", kind: .episode, title: "Ep \(i)",
                  showTitle: "Show X", seasonNo: 1, episodeNo: i, durationMs: 22 * MINUTE, partKey: "/x\(i)")
        })
        Scheduler.regenerate(store: store, channelId: id, now: now, windowDays: 14)

        let airing = try XCTUnwrap(Resolver.nowOn(store.programs(id, from: now - HOUR, to: now + DAY), at: now))
        XCTAssertEqual(airing.program.kind, .episode, "content must be on air immediately after being added")
        XCTAssertGreaterThan(store.programs(id, from: now, to: now + 14 * DAY).count, 100,
                             "the whole window should now be real programming")
    }

    // MARK: new channel gets covered on demand

    func testEnsureCoverageGeneratesForNewChannel() throws {
        let store = try makeStore()
        let id = seedChannel(store)
        let now: Millis = 1_700_000_000_000
        XCTAssertFalse(store.hasProgramAt(id, now))
        Scheduler.ensureCoverage(store: store, channelId: id, now: now, windowDays: 2)
        XCTAssertTrue(store.hasProgramAt(id, now), "a new channel should be scheduled on demand")
    }
}
