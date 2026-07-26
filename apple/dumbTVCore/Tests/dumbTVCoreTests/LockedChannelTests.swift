import XCTest
@testable import dumbTVCore

/// S3 — system channels. SPACE at channel 1 is a pack plus a `locked` flag, not a
/// new channel type, so the scheduler needs no changes at all. What the flag has
/// to guarantee: **hideable, not editable.** Nobody can rearrange or remove a
/// channel dumbTV ships and stands behind, but anyone can turn it off — a channel
/// you can neither remove nor hide would be a hostage.
final class LockedChannelTests: XCTestCase {
    private func makeStore() throws -> Store {
        try Store(path: NSTemporaryDirectory() + "dumbtv-lock-\(UUID().uuidString).db")
    }
    private func obj(_ r: ConfigAPI.Response) -> [String: Any] { r.json as? [String: Any] ?? [:] }

    /// A pack manifest declaring `channel.system` — the SPACE shape.
    private func writeSystemPack(_ id: String, system: Bool) throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("pack-\(id)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let json = """
        {"id":"\(id)","name":"SPACE","version":1,"kind":"shows",
         "channel":{"number":1,"name":"SPACE","ordering":"sequential","seed":19690720,
                    "system":\(system)},
         "items":[
           {"id":"a","file":"01-a.mp4","title":"Saturn V","show":"SPACE","season":1,"episode":1,"durationMs":1469568},
           {"id":"b","file":"02-b.mp4","title":"Moonwalk","show":"SPACE","season":1,"episode":2,"durationMs":3492000}]}
        """
        try json.data(using: .utf8)!.write(to: dir.appendingPathComponent("pack.json"))
        return dir
    }

    func testSystemPackCreatesALockedChannelAtItsNumber() throws {
        let store = try makeStore()
        _ = try store.installPack(fromDir: try writeSystemPack("space", system: true), origin: "bundled")
        let id = try XCTUnwrap(store.createChannelFromPack("space", adsEnabled: false))
        let ch = try XCTUnwrap(store.channel(id))
        XCTAssertTrue(ch.locked, "a system pack must create a locked channel")
        XCTAssertEqual(ch.number, 1, "SPACE belongs at channel 1")
        XCTAssertFalse(ch.adsEnabled, "no commercials on a system channel")
    }

    /// An ordinary pack is NOT locked — the flag has to be opt-in, or every
    /// preload channel would become uneditable.
    func testOrdinaryPackIsNotLocked() throws {
        let store = try makeStore()
        _ = try store.installPack(fromDir: try writeSystemPack("normal", system: false), origin: "bundled")
        let id = try XCTUnwrap(store.createChannelFromPack("normal"))
        XCTAssertFalse(try XCTUnwrap(store.channel(id)).locked)
    }

    func testLockedSurvivesAReopen() throws {
        let path = NSTemporaryDirectory() + "dumbtv-lock-p-\(UUID().uuidString).db"
        let store = try Store(path: path)
        _ = try store.installPack(fromDir: try writeSystemPack("space", system: true), origin: "bundled")
        let id = try XCTUnwrap(store.createChannelFromPack("space", adsEnabled: false))
        XCTAssertTrue(try XCTUnwrap(Store(path: path).channel(id)).locked)
    }

    /// Reinstalling the pack (which happens on EVERY launch for bundled packs,
    /// because the bundle path moves per update) must not duplicate the channel
    /// or unlock it.
    func testReinstallDoesNotDuplicateOrUnlock() throws {
        let store = try makeStore()
        let dir = try writeSystemPack("space", system: true)
        _ = try store.installPack(fromDir: dir, origin: "bundled")
        let id = try XCTUnwrap(store.createChannelFromPack("space", adsEnabled: false))
        _ = try store.installPack(fromDir: dir, origin: "bundled")
        XCTAssertEqual(store.allChannels().count, 1)
        XCTAssertTrue(try XCTUnwrap(store.channel(id)).locked)
    }

    // MARK: - the API contract

    private func lockedChannel(_ store: Store) throws -> Int {
        _ = try store.installPack(fromDir: try writeSystemPack("space", system: true), origin: "bundled")
        return try XCTUnwrap(store.createChannelFromPack("space", adsEnabled: false))
    }

    func testCannotPatchALockedChannel() async throws {
        let store = try makeStore()
        let api = ConfigAPI(store: store)
        let id = try lockedChannel(store)

        for body in [["name": "Mine"], ["number": 42], ["orderingMode": "shuffle"],
                     ["adsEnabled": true], ["enabled": false, "name": "sneaky"]] as [[String: Any]] {
            let r = await api.handle(.init(method: "PATCH", path: "/api/channels/\(id)", body: body))
            XCTAssertEqual(r.status, 403, "PATCH \(body) should be refused")
            XCTAssertNotNil(obj(r)["error"], "a refusal must say why")
        }
        // Nothing actually changed.
        let ch = try XCTUnwrap(store.channel(id))
        XCTAssertEqual(ch.name, "SPACE")
        XCTAssertEqual(ch.number, 1)
        XCTAssertEqual(ch.orderingMode, .sequential)
        XCTAssertFalse(ch.adsEnabled)
    }

    func testCannotDeleteALockedChannel() async throws {
        let store = try makeStore()
        let api = ConfigAPI(store: store)
        let id = try lockedChannel(store)
        let r = await api.handle(.init(method: "DELETE", path: "/api/channels/\(id)"))
        XCTAssertEqual(r.status, 403)
        XCTAssertNotNil(store.channel(id), "the channel was deleted anyway")
    }

    /// The escape hatch: turning it off is allowed, and round-trips.
    func testDisableRoundTripsOnALockedChannel() async throws {
        let store = try makeStore()
        let api = ConfigAPI(store: store)
        let id = try lockedChannel(store)

        let off = await api.handle(.init(method: "PATCH", path: "/api/channels/\(id)",
                                        body: ["enabled": false]))
        XCTAssertEqual(off.status, 200)
        XCTAssertEqual(try XCTUnwrap(store.channel(id)).enabled, false)

        let on = await api.handle(.init(method: "PATCH", path: "/api/channels/\(id)",
                                       body: ["enabled": true]))
        XCTAssertEqual(on.status, 200)
        XCTAssertEqual(try XCTUnwrap(store.channel(id)).enabled, true)
        XCTAssertTrue(try XCTUnwrap(store.channel(id)).locked, "disabling must not unlock it")
    }

    /// Stripping its source would leave a channel that can't be deleted showing
    /// nothing at all.
    func testCannotRemoveALockedChannelsSource() async throws {
        let store = try makeStore()
        let api = ConfigAPI(store: store)
        let id = try lockedChannel(store)
        let src = try XCTUnwrap(store.sources(id).first)
        let r = await api.handle(.init(method: "DELETE", path: "/api/channels/\(id)/sources/\(src.id)"))
        XCTAssertEqual(r.status, 403)
        XCTAssertEqual(store.sources(id).count, 1)
    }

    /// Turning it off then on must not disturb what already aired (invariant #4).
    func testAiredProgramsSurviveDisableAndReEnable() async throws {
        let store = try makeStore()
        let api = ConfigAPI(store: store)
        let id = try lockedChannel(store)
        let now: Millis = 1_785_000_000_000
        Scheduler.topUp(store: store, now: now, windowDays: 1)

        // Anything that ended before `now` counts as history.
        let airedBefore = store.programs(id, from: now - 2 * DAY, to: now).count
        XCTAssertGreaterThan(airedBefore, 0, "nothing was scheduled to protect")

        _ = await api.handle(.init(method: "PATCH", path: "/api/channels/\(id)", body: ["enabled": false]))
        _ = await api.handle(.init(method: "PATCH", path: "/api/channels/\(id)", body: ["enabled": true]))

        XCTAssertEqual(store.programs(id, from: now - 2 * DAY, to: now).count, airedBefore,
                       "already-aired programs were rewritten")
    }

    /// The web UI decides between a lock chip and the Settings/Delete buttons off
    /// this field, so it has to be in the payload.
    func testChannelJSONReportsLocked() async throws {
        let store = try makeStore()
        let api = ConfigAPI(store: store)
        _ = try lockedChannel(store)
        let list = obj(await api.handle(.init(method: "GET", path: "/api/channels")))
        let channels = try XCTUnwrap(list["channels"] as? [[String: Any]])
        XCTAssertEqual(channels.first?.bool("locked"), true)
    }
}
