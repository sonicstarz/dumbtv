import XCTest
@testable import dumbTVCore

final class StoreTests: XCTestCase {
    /// A fresh Store backed by a unique temp file (WAL needs a real path).
    private func makeStore() throws -> (Store, String) {
        let path = NSTemporaryDirectory() + "dumbtv-test-\(UUID().uuidString).db"
        return (try Store(path: path), path)
    }

    func testChannelRoundTrip() throws {
        let (store, _) = try makeStore()
        let id = store.insertChannel(ChannelConfig(id: 0, number: 3, name: "Retro Toons",
                                                   orderingMode: .shuffle, shuffleSeed: 12002,
                                                   adsEnabled: false, adsBetween: 7, cooldownDays: 2))
        XCTAssertGreaterThan(id, 0)

        let loaded = try XCTUnwrap(store.channel(id))
        XCTAssertEqual(loaded.number, 3)
        XCTAssertEqual(loaded.name, "Retro Toons")
        XCTAssertEqual(loaded.orderingMode, .shuffle)
        XCTAssertEqual(loaded.shuffleSeed, 12002)
        XCTAssertFalse(loaded.adsEnabled)
        XCTAssertEqual(loaded.adsBetween, 7)
        XCTAssertEqual(loaded.cooldownDays, 2)

        var edited = loaded
        edited.name = "Saturday Morning"
        edited.orderingMode = .marathon
        edited.enabled = false
        store.saveChannel(edited)

        let again = try XCTUnwrap(store.channel(id))
        XCTAssertEqual(again.name, "Saturday Morning")
        XCTAssertEqual(again.orderingMode, .marathon)
        XCTAssertFalse(again.enabled)

        store.deleteChannel(id)
        XCTAssertNil(store.channel(id))
    }

    func testNumberIsUniqueAndAutoIncrements() throws {
        let (store, _) = try makeStore()
        _ = store.insertChannel(ChannelConfig(id: 0, number: 2, name: "A"))
        XCTAssertEqual(store.nextChannelNumber(), 3)
        XCTAssertEqual(store.allChannels().count, 1)
    }

    func testSourcesAndCascade() throws {
        let (store, _) = try makeStore()
        let ch = store.insertChannel(ChannelConfig(id: 0, number: 4, name: "Movies"))
        store.addSource(ch, ratingKey: "show-1", sourceType: "show", title: "X-Men")
        store.addSource(ch, ratingKey: "show-2", sourceType: "show", title: "Spider-Man")
        store.addSource(ch, ratingKey: "show-1", sourceType: "show", title: "dupe") // ignored by UNIQUE

        XCTAssertEqual(store.sources(ch).count, 2)

        // Deleting the channel cascades to its sources.
        store.deleteChannel(ch)
        XCTAssertEqual(store.sources(ch).count, 0)
    }

    func testRuleRoundTrip() throws {
        let (store, _) = try makeStore()
        let ch = store.insertChannel(ChannelConfig(id: 0, number: 5, name: "Rules"))
        let rid = store.insertRule(ScheduleRule(id: 0, channelId: ch, name: "Christmas",
                                                kind: .pinned, priority: 800, startsAtUtc: 1_700_000_000_000,
                                                ratingKey: "movie-9", airdateMode: nil))
        let rules = store.rules(ch)
        XCTAssertEqual(rules.count, 1)
        XCTAssertEqual(rules[0].kind, .pinned)
        XCTAssertEqual(rules[0].startsAtUtc, 1_700_000_000_000)

        var edited = rules[0]
        edited.enabled = false
        edited.priority = 999
        store.saveRule(edited)
        XCTAssertEqual(store.rules(ch).first?.priority, 999)
        XCTAssertFalse(store.rules(ch).first?.enabled ?? true)

        store.deleteRule(rid)
        XCTAssertTrue(store.rules(ch).isEmpty)
    }

    func testExcludesReplaceSet() throws {
        let (store, _) = try makeStore()
        let ch = store.insertChannel(ChannelConfig(id: 0, number: 6, name: "Filtered"))
        store.setExcludes(ch, ["e1", "e2", "e3"])
        XCTAssertEqual(store.excludes(ch), ["e1", "e2", "e3"])
        store.setExcludes(ch, ["e2"])          // full replace
        XCTAssertEqual(store.excludes(ch), ["e2"])
    }

    func testMediaUpsertAndLibrary() throws {
        let (store, _) = try makeStore()
        let ch = store.insertChannel(ChannelConfig(id: 0, number: 7, name: "Lib"))
        store.addSource(ch, ratingKey: "show-x", sourceType: "show", title: "Show X")
        store.upsertMedia([
            Media(ratingKey: "show-x-e1", parentKey: "show-x", kind: .episode, title: "Ep 1", durationMs: 1_320_000),
            Media(ratingKey: "show-x-e2", parentKey: "show-x", kind: .episode, title: "Ep 2", durationMs: 1_320_000),
        ])
        // Upsert again with a changed title — should update, not duplicate.
        store.upsertMedia([Media(ratingKey: "show-x-e1", parentKey: "show-x", kind: .episode,
                                 title: "Ep 1 (remastered)", durationMs: 1_320_000)])

        let lib = store.library(forChannel: ch)
        XCTAssertEqual(lib.sources.count, 1)
        XCTAssertEqual(lib.mediaByKey.count, 2)
        XCTAssertEqual(lib.mediaByKey["show-x-e1"]?.title, "Ep 1 (remastered)")
        // The library feeds the scheduler: buckets should be non-empty.
        XCTAssertEqual(lib.sourceBuckets().flatMap { $0 }.count, 2)
    }

    func testSettingsAndAirings() throws {
        let (store, _) = try makeStore()
        store.setSetting("timezone", "America/New_York")
        XCTAssertEqual(store.getSetting("timezone"), "America/New_York")
        store.setSetting("dvr_slots", "8")
        XCTAssertEqual(store.getInt("dvr_slots", 6), 8)
        store.setSetting("timezone", nil)
        XCTAssertNil(store.getSetting("timezone"))

        let ch = store.insertChannel(ChannelConfig(id: 0, number: 8, name: "Air"))
        store.setAiring(ch, "m1", AiringState(count: 2, lastAired: 111))
        XCTAssertEqual(store.airing(ch, "m1").count, 2)
        store.setAiring(ch, "m1", AiringState(count: 3, lastAired: 222))  // upsert
        XCTAssertEqual(store.airing(ch, "m1").count, 3)
        XCTAssertEqual(store.airing(ch, "m1").lastAired, 222)
    }

    /// The "player reads the Store" path end-to-end (no Plex): configured
    /// channel + cached episodes → generate a schedule → resolve what's on now.
    func testScheduleGeneratesAndResolvesFromStore() throws {
        let (store, _) = try makeStore()
        let ch = store.insertChannel(ChannelConfig(id: 0, number: 2, name: "Toons", orderingMode: .sequential))
        store.addSource(ch, ratingKey: "show-x", sourceType: "show", title: "Show X")
        store.upsertMedia((1...5).map { i in
            Media(ratingKey: "show-x-e\(i)", parentKey: "show-x", kind: .episode, title: "Ep \(i)",
                  seasonNo: 1, episodeNo: i, durationMs: 1_320_000, partKey: "local:/x/\(i).mp4")
        })

        let cfg = try XCTUnwrap(store.channel(ch))
        let buckets = store.library(forChannel: ch).sourceBuckets()
        XCTAssertFalse(buckets.isEmpty)

        let now = Millis(Date().timeIntervalSince1970 * 1000)
        let programs = Generator.generate(channel: cfg.spec, buckets: buckets, now: now, windowMs: 24 * 3_600_000)
        XCTAssertFalse(programs.isEmpty)

        let airing = try XCTUnwrap(Resolver.nowOn(programs, at: now))
        XCTAssertTrue(airing.program.ratingKey?.hasPrefix("show-x-e") ?? false)
        XCTAssertGreaterThanOrEqual(airing.offsetMs, 0)
    }

    /// Regression: the embedded server handles requests concurrently, so the
    /// shared Store gets hit from many threads at once. Before SQLite was
    /// serialised this corrupted the heap and crashed (double-free in the parser).
    func testConcurrentAccessIsSafe() throws {
        let (store, _) = try makeStore()
        for i in 1...5 { store.insertChannel(ChannelConfig(id: 0, number: i + 1, name: "C\(i)")) }

        let group = DispatchGroup()
        for n in 0..<64 {
            group.enter()
            DispatchQueue.global().async {
                _ = store.allChannels()                 // /api/status + /api/onair path
                _ = store.library(forChannel: 2)
                store.setSetting("hits", String(n))     // concurrent writes too
                group.leave()
            }
        }
        XCTAssertEqual(group.wait(timeout: .now() + 15), .success)
        XCTAssertGreaterThanOrEqual(store.allChannels().count, 5)
    }

    func testPersistsAcrossReopen() throws {
        let (store, path) = try makeStore()
        _ = store.insertChannel(ChannelConfig(id: 0, number: 9, name: "Persisted"))
        // Reopen the same file in a new Store — the row should still be there.
        let reopened = try Store(path: path)
        XCTAssertEqual(reopened.allChannels().first?.name, "Persisted")
    }
}
