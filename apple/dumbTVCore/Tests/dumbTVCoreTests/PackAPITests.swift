import XCTest
@testable import dumbTVCore

/// The pack-picker API (Track I, P3) over the wire — list, create-channel,
/// remove — the endpoints the shared web UI drives on the embedded server.
final class PackAPITests: XCTestCase {
    private func obj(_ r: ConfigAPI.Response) -> [String: Any] { r.json as? [String: Any] ?? [:] }

    private func installTestPack(_ store: Store, id: String) throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("papi-\(id)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let json = """
        {"id":"\(id)","name":"TEST","kind":"shows",
         "channel":{"number":91,"name":"TEST","ordering":"release_order","seed":7},
         "items":[
           {"id":"a","file":"a.mp4","title":"A","show":"T","season":1,"episode":1,"aired":"1994-01-01","durationMs":660000},
           {"id":"b","file":"b.mp4","title":"B","show":"T","season":1,"episode":2,"aired":"1994-01-02","durationMs":600000}]}
        """
        try json.data(using: .utf8)!.write(to: dir.appendingPathComponent("pack.json"))
        store.installPack(json_dir: dir)
    }

    func testPackPickerLifecycle() async throws {
        let store = try Store(path: NSTemporaryDirectory() + "papi-\(UUID().uuidString).db")
        let a = ConfigAPI(store: store)
        try installTestPack(store, id: "tp")

        // GET /api/packs — the installed pack shows, no channel yet.
        var list = await a.handle(.init(method: "GET", path: "/api/packs"))
        XCTAssertEqual(list.status, 200)
        var packs = obj(list)["packs"] as! [[String: Any]]
        let tp = try XCTUnwrap(packs.first { $0["id"] as? String == "tp" })
        XCTAssertEqual(tp["installed"] as? Bool, true)
        XCTAssertEqual(tp["hasChannel"] as? Bool, false)

        // POST create channel.
        let made = await a.handle(.init(method: "POST", path: "/api/packs/tp/channel", body: [:]))
        XCTAssertEqual(made.status, 200)
        XCTAssertFalse(store.allChannels().isEmpty)

        // GET again — now hasChannel is true.
        list = await a.handle(.init(method: "GET", path: "/api/packs"))
        packs = obj(list)["packs"] as! [[String: Any]]
        XCTAssertEqual((packs.first { $0["id"] as? String == "tp" })?["hasChannel"] as? Bool, true)

        // DELETE removes the pack's media.
        let del = await a.handle(.init(method: "DELETE", path: "/api/packs/tp"))
        XCTAssertEqual(del.status, 200)
        XCTAssertTrue(store.media(forSource: packRatingKey("tp")).isEmpty)

        // Install an unknown pack → 404.
        let bad = await a.handle(.init(method: "POST", path: "/api/packs/nope/install"))
        XCTAssertEqual(bad.status, 404)
    }
}

// Small shim so the test reads cleanly (installPack(fromDir:) throws).
private extension Store {
    func installPack(json_dir dir: URL) { _ = try? installPack(fromDir: dir, origin: "bundled") }
}
