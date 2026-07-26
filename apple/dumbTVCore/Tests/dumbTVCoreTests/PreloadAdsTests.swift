import XCTest
@testable import dumbTVCore

/// Build 13 reverses Notion decision D2: preloaded pack channels ship with
/// commercials OFF, so nobody evaluating the product lands in an ad break on a
/// channel they didn't build. Covers the new default, the one-time repair for
/// devices seeded by builds 11/12, and the "NEXT names a show, not a spot" rule.
final class PreloadAdsTests: XCTestCase {
    private func makeStore() throws -> Store {
        try Store(path: NSTemporaryDirectory() + "dumbtv-ads-\(UUID().uuidString).db")
    }

    private func writePack(_ id: String, number: Int) throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("pack-\(id)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let json = """
        {"id":"\(id)","name":"\(id.uppercased())","version":1,"kind":"shows",
         "channel":{"number":\(number),"name":"\(id.uppercased())","ordering":"sequential","seed":99},
         "items":[
           {"id":"a","file":"01.mp4","title":"A","show":"S","season":1,"episode":1,"durationMs":600000},
           {"id":"b","file":"02.mp4","title":"B","show":"S","season":1,"episode":2,"durationMs":600000}]}
        """
        try json.data(using: .utf8)!.write(to: dir.appendingPathComponent("pack.json"))
        return dir
    }

    /// A pack channel created for the preload lineup has ads off.
    func testPreloadChannelsSeedWithoutAds() throws {
        let store = try makeStore()
        _ = try store.installPack(fromDir: try writePack("sm", number: 7), origin: "bundled")
        let id = try XCTUnwrap(store.createChannelFromPack("sm", adsEnabled: false))
        XCTAssertFalse(try XCTUnwrap(store.channel(id)).adsEnabled)
    }

    /// The repair for already-seeded devices: a pack-only channel loses its ads,
    /// and the setting makes it run exactly once.
    func testMigrationTurnsAdsOffOnPackOnlyChannels() throws {
        let store = try makeStore()
        _ = try store.installPack(fromDir: try writePack("sm", number: 7), origin: "bundled")
        let id = try XCTUnwrap(store.createChannelFromPack("sm", adsEnabled: true))  // the build-12 state
        XCTAssertTrue(try XCTUnwrap(store.channel(id)).adsEnabled)

        let now: Millis = 1_785_000_000_000
        XCTAssertEqual(store.migratePreloadAdsOff(now: now), [id])
        XCTAssertFalse(try XCTUnwrap(store.channel(id)).adsEnabled)

        // Once only — a later run must not stomp a choice the user has since made.
        var c = try XCTUnwrap(store.channel(id))
        c.adsEnabled = true
        store.saveChannel(c)
        XCTAssertEqual(store.migratePreloadAdsOff(now: now), [])
        XCTAssertTrue(try XCTUnwrap(store.channel(id)).adsEnabled, "the migration re-ran")
    }

    /// A channel the user built (or added their own sources to) is not touched —
    /// their ad setting is their decision.
    func testMigrationLeavesUserChannelsAlone() throws {
        let store = try makeStore()
        _ = try store.installPack(fromDir: try writePack("sm", number: 7), origin: "bundled")
        let packCh = try XCTUnwrap(store.createChannelFromPack("sm", adsEnabled: true))
        // …the user adds a Plex show to that same channel.
        store.addSource(packCh, ratingKey: "12345", sourceType: "show", title: "Their Show")

        let userCh = store.insertChannel(ChannelConfig(
            id: 0, number: 42, name: "Mine", slotMinutes: 30, orderingMode: .sequential,
            marathonSize: 3, cursor: 0, shuffleSeed: 7, darkStart: nil, darkEnd: nil,
            adsEnabled: true, maxAdsPerBreak: 10, adTags: "", timingMode: .continuous,
            adsBetween: 4, cooldownDays: 0, overrunPolicy: .protect, enabled: true, generatedThru: 0))
        store.addSource(userCh, ratingKey: "999", sourceType: "show", title: "Show")

        XCTAssertEqual(store.migratePreloadAdsOff(now: 1_785_000_000_000), [])
        XCTAssertTrue(try XCTUnwrap(store.channel(packCh)).adsEnabled, "mixed-source channel was touched")
        XCTAssertTrue(try XCTUnwrap(store.channel(userCh)).adsEnabled, "user channel was touched")
    }

    /// POLISH-1: the banner's NEXT line names the next SHOW. Announcing
    /// "NEXT: Wonderful New World of Fords" read as a bug on the device.
    func testUpNextSkipsAdsAndNamesTheNextShow() {
        let base: Millis = 1_785_000_000_000
        func p(_ kind: ProgramKind, _ title: String, _ start: Millis, _ len: Millis) -> Program {
            Program(channelId: 1, startUtc: start, endUtc: start + len, kind: kind, title: title)
        }
        let programs = [
            p(.episode, "The Mad Scientist", base, 600_000),
            p(.ad,      "Wonderful New World of Fords", base + 600_000, 60_000),
            p(.ad,      "Duck and Cover", base + 660_000, 60_000),
            p(.episode, "The Mechanical Monsters", base + 720_000, 600_000),
        ]
        let at = base + 100_000   // mid-episode
        XCTAssertEqual(Resolver.upNext(programs, at: at, count: 1).first?.title,
                       "Wonderful New World of Fords", "raw upNext still returns the very next row")
        XCTAssertEqual(Resolver.upNextShow(programs, at: at, count: 1).first?.title,
                       "The Mechanical Monsters", "NEXT should name the next show, not the commercial")
    }
}
