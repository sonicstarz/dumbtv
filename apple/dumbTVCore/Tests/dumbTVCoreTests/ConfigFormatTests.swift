import XCTest
@testable import dumbTVCore

/// Config format v3 — the portable lineup file, byte-compatible with Node's
/// src/config-format.js.
///
/// Two things these tests exist to pin down:
///   · v2 lost data. It emitted rules in a flat array and dropped excludes on the
///     floor, so an Apple export could not describe what a channel actually
///     played. v3 nests sources/excludes/rules inside their channel.
///   · An import must not destroy a locked channel. The API returns 403 on
///     deleting one, and for months the Node importer deleted them anyway.
final class ConfigFormatTests: XCTestCase {

    private func obj(_ r: ConfigAPI.Response) -> [String: Any] { r.json as? [String: Any] ?? [:] }

    private func makeStore() throws -> Store {
        try Store(path: NSTemporaryDirectory() + "cfg-\(UUID().uuidString).db")
    }

    /// A user channel with sources, excludes and a rule, plus a locked system
    /// channel that must survive everything.
    private func seed(_ store: Store) -> Int {
        var sys = ChannelConfig(id: 0, number: 1, name: "SPACE")
        sys.locked = true
        _ = store.insertChannel(sys)

        var ch = ChannelConfig(id: 0, number: 7, name: "SATURDAY MORNING")
        ch.orderingMode = .shuffle
        ch.shuffleSeed = 4242
        ch.adsEnabled = false
        let id = store.insertChannel(ch)
        store.addSource(id, ratingKey: "pack:saturday-morning", sourceType: "pack",
                        title: "SATURDAY MORNING", thumb: nil)
        store.setExcludes(id, ["pack:saturday-morning:snow-white"])
        var rule = ScheduleRule(id: 0, channelId: id, kind: .recurring, priority: 600)
        rule.daysOfWeek = "0,6"
        rule.startTime = "08:00"
        rule.durationMin = 240
        _ = store.insertRule(rule)
        return id
    }

    func testExportIsV3AndNestsEverythingInsideItsChannel() async throws {
        let store = try makeStore()
        _ = seed(store)
        let api = ConfigAPI(store: store)

        let res = await api.handle(.init(method: "GET", path: "/api/config/export"))
        XCTAssertEqual(res.status, 200)
        let body = obj(res)
        XCTAssertEqual(body["version"] as? Int, 3)

        let channels = try XCTUnwrap(body["channels"] as? [[String: Any]])
        // The locked channel is the device's own — never the user's to clone.
        XCTAssertFalse(channels.contains { $0["name"] as? String == "SPACE" })
        let ch = try XCTUnwrap(channels.first { $0["name"] as? String == "SATURDAY MORNING" })

        XCTAssertEqual((ch["sources"] as? [[String: Any]])?.first?["ratingKey"] as? String,
                       "pack:saturday-morning")
        // v2 dropped these entirely.
        XCTAssertEqual(ch["excludes"] as? [String], ["pack:saturday-morning:snow-white"])
        XCTAssertTrue((ch["rules"] as? [[String: Any]] ?? []).contains { $0["kind"] as? String == "recurring" })
        // Invariant #5 across devices: without the seed the clone plays in a
        // different order and a printed guide stops being true.
        XCTAssertEqual(ch["shuffleSeed"] as? Int, 4242)

        // No credentials, ever.
        let raw = String(describing: body)
        XCTAssertFalse(raw.contains("plex_token"))
        XCTAssertFalse(raw.contains("access_token"))
    }

    func testRoundTripPreservesTheLineupAndSpareTheLockedChannel() async throws {
        let store = try makeStore()
        _ = seed(store)
        let api = ConfigAPI(store: store)

        let exported = obj(await api.handle(.init(method: "GET", path: "/api/config/export")))
        let res = await api.handle(.init(method: "POST", path: "/api/config/import", body: exported))
        XCTAssertEqual(res.status, 200)
        XCTAssertEqual(obj(res)["channels"] as? Int, 1)

        let after = store.allChannels()
        // The thing that used to break: SPACE is still here.
        XCTAssertTrue(after.contains { $0.name == "SPACE" && $0.locked })
        let restored = try XCTUnwrap(after.first { $0.name == "SATURDAY MORNING" })
        XCTAssertEqual(restored.shuffleSeed, 4242)
        XCTAssertEqual(restored.orderingMode, .shuffle)
        XCTAssertEqual(store.sources(restored.id).count, 1)
        XCTAssertEqual(store.excludes(restored.id), ["pack:saturday-morning:snow-white"])
        XCTAssertTrue(store.rules(restored.id).contains { $0.kind == .recurring })
    }

    func testAnIncomingLockedChannelIsSkippedNotHonoured() async throws {
        let store = try makeStore()
        _ = seed(store)
        let api = ConfigAPI(store: store)

        var exported = obj(await api.handle(.init(method: "GET", path: "/api/config/export")))
        var channels = exported["channels"] as! [[String: Any]]
        channels[0]["locked"] = true          // a file trying to install a system channel
        exported["channels"] = channels

        let res = await api.handle(.init(method: "POST", path: "/api/config/import", body: exported))
        XCTAssertEqual(obj(res)["skippedLocked"] as? Int, 1)
        XCTAssertEqual(obj(res)["channels"] as? Int, 0)
        // Only the device's own locked channel remains.
        XCTAssertEqual(store.allChannels().filter { $0.locked }.count, 1)
    }

    func testAWrongVersionIsRefusedRatherThanGuessedAt() async throws {
        let store = try makeStore()
        let api = ConfigAPI(store: store)
        let res = await api.handle(.init(method: "POST", path: "/api/config/import",
                                         body: ["version": 2, "channels": []]))
        XCTAssertEqual(res.status, 400)
    }
}
