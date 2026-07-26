import XCTest
@testable import dumbTVCore

/// N2/N3: creating a channel on an already-taken number must not collide.
/// Before build 11, a duplicate returned id 0 (a phantom success) and a pack
/// number-hint of 7 clashed with the preload channel.
final class ChannelNumberTests: XCTestCase {
    private func obj(_ r: ConfigAPI.Response) -> [String: Any] { r.json as? [String: Any] ?? [:] }

    func testCreateChannelNeverCollides() async throws {
        let store = try Store(path: NSTemporaryDirectory() + "chnum-\(UUID().uuidString).db")
        let api = ConfigAPI(store: store)

        // Ask for number 5 twice; the second must get a DIFFERENT number, id > 0.
        let r1 = await api.handle(.init(method: "POST", path: "/api/channels", body: ["name": "A", "number": 5]))
        XCTAssertEqual(obj(r1)["number"] as? Int, 5)
        XCTAssertGreaterThan(obj(r1)["id"] as? Int ?? 0, 0)

        let r2 = await api.handle(.init(method: "POST", path: "/api/channels", body: ["name": "B", "number": 5]))
        XCTAssertEqual(r2.status, 200)
        XCTAssertGreaterThan(obj(r2)["id"] as? Int ?? 0, 0, "duplicate number must not return id 0")
        XCTAssertNotEqual(obj(r2)["number"] as? Int, 5, "duplicate number must fall back to a free one")

        // freeChannelNumber picks the preferred one only when free.
        XCTAssertNotEqual(store.freeChannelNumber(preferred: 5), 5)   // taken
        let free = store.freeChannelNumber(preferred: 999)
        XCTAssertEqual(free, 999)                                     // free
    }

    func testPackChannelHintFallsBackWhenTaken() throws {
        let store = try Store(path: NSTemporaryDirectory() + "chnum2-\(UUID().uuidString).db")
        // Install a shows pack whose channel hint is number 6, then occupy 6.
        let m = PackManifest(
            id: "sm", name: "SM", version: 1, kind: "shows",
            channel: .init(number: 6, name: "SM", ordering: "sequential", seed: 1),
            items: [.init(id: "a", file: "a.mp4", title: "A", show: "S", season: 1, episode: 1,
                          aired: nil, durationMs: 600000)])
        _ = store.installPack(m, rootPath: "/tmp/sm", origin: "bundled")
        _ = store.insertChannel(ChannelConfig(id: 0, number: 6, name: "Occupant", orderingMode: .sequential, shuffleSeed: 1))

        let ch = try XCTUnwrap(store.createChannelFromPack("sm"))
        let created = try XCTUnwrap(store.channel(ch))
        XCTAssertNotEqual(created.number, 6, "pack hint 6 was taken — must fall back")
    }
}
