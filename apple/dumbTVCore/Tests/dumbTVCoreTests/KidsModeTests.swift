import XCTest
@testable import dumbTVCore

/// Kids Mode: parental control, driven entirely from the PIN-gated web API.
final class KidsModeTests: XCTestCase {
    private func makeAPI() throws -> (ConfigAPI, Store) {
        let store = try Store(path: NSTemporaryDirectory() + "dumbtv-kids-\(UUID().uuidString).db")
        let a = store.insertChannel(ChannelConfig(id: 0, number: 2, name: "Cartoons"))
        let b = store.insertChannel(ChannelConfig(id: 0, number: 3, name: "Late Night"))
        _ = (a, b)
        return (ConfigAPI(store: store), store)
    }

    func testKidsModeLifecycle() async throws {
        let (api, _) = try makeAPI()
        let kid = 1, adult = 2   // insert order → ids

        // Can't turn on with nothing marked.
        var r = await api.handle(.init(method: "POST", path: "/api/kids-mode", body: ["on": true]))
        XCTAssertEqual(r.status, 400)

        // Mark the cartoons channel kid-safe; status reflects the count.
        r = await api.handle(.init(method: "POST", path: "/api/channels/\(kid)/kid-safe", body: ["on": true]))
        XCTAssertEqual(r.status, 200)
        r = await api.handle(.init(method: "GET", path: "/api/status"))
        XCTAssertEqual((r.json as? [String: Any])?["kidSafeCount"] as? Int, 1)

        // Now Kids Mode turns on.
        r = await api.handle(.init(method: "POST", path: "/api/kids-mode", body: ["on": true]))
        XCTAssertEqual(r.status, 200)
        r = await api.handle(.init(method: "GET", path: "/api/status"))
        XCTAssertEqual((r.json as? [String: Any])?["kidsMode"] as? Bool, true)

        // The channels list marks which are kid-safe.
        r = await api.handle(.init(method: "GET", path: "/api/channels"))
        let chans = (r.json as? [String: Any])?["channels"] as? [[String: Any]] ?? []
        XCTAssertEqual(chans.first { $0["id"] as? Int == kid }?["kidSafe"] as? Bool, true)
        XCTAssertEqual(chans.first { $0["id"] as? Int == adult }?["kidSafe"] as? Bool, false)

        // Un-marking the last kid channel drops out of Kids Mode (never strands
        // the TV with nothing to show).
        r = await api.handle(.init(method: "POST", path: "/api/channels/\(kid)/kid-safe", body: ["on": false]))
        XCTAssertEqual(r.status, 200)
        r = await api.handle(.init(method: "GET", path: "/api/status"))
        XCTAssertEqual((r.json as? [String: Any])?["kidsMode"] as? Bool, false)
        XCTAssertEqual((r.json as? [String: Any])?["kidSafeCount"] as? Int, 0)
    }

    func testKidsModeIsPinGated() async throws {
        let (api, store) = try makeAPI()
        Auth.setPin(store, pin: "4321")
        // Locked (no cookie): can't toggle Kids Mode.
        let r = await api.handle(.init(method: "POST", path: "/api/kids-mode", body: ["on": true]))
        XCTAssertEqual(r.status, 401)
    }
}
