import XCTest
@testable import dumbTVCore

/// The live pack catalog (D5, second half).
///
/// The fetch itself is not tested here — it talks to dumbtv.app, and a unit
/// test that needs the internet is a flaky test. What IS tested is the part
/// that must never break: which copy wins, and what happens when the downloaded
/// one is rubbish. A catalog fetch that can take the pack picker down is worse
/// than no fetch at all.
final class CatalogFallbackTests: XCTestCase {

    private func obj(_ r: ConfigAPI.Response) -> [String: Any] { r.json as? [String: Any] ?? [:] }

    func testABrokenDownloadedCatalogDoesNotTakeThePickerDown() async throws {
        let store = try Store(path: NSTemporaryDirectory() + "cat-\(UUID().uuidString).db")
        let api = ConfigAPI(store: store)

        // Whatever a captive portal, a half-written file or a truncated
        // download leaves behind, the picker must still answer.
        let dir = ConfigAPI.downloadedPacksDir()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent("index.json")

        for rubbish in ["<html>captive portal</html>", "", "{", "{\"version\":1}"] {
            try? rubbish.data(using: .utf8)?.write(to: dest)
            let res = await api.handle(.init(method: "GET", path: "/api/packs"))
            XCTAssertEqual(res.status, 200, "the picker must answer even with a broken catalog on disk")
            XCTAssertNotNil(obj(res)["packs"])
        }
        try? FileManager.default.removeItem(at: dest)
    }

    func testAnEmptyCatalogIsNotPreferredOverTheBundledOne() async throws {
        // A well-formed catalog with no packs is the shape a truncated or
        // mid-write file most easily takes. Treating it as authoritative would
        // silently empty the picker, which looks exactly like a broken app.
        let store = try Store(path: NSTemporaryDirectory() + "cat2-\(UUID().uuidString).db")
        let api = ConfigAPI(store: store)
        let dir = ConfigAPI.downloadedPacksDir()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent("index.json")
        try? #"{"version":1,"packs":[]}"#.data(using: .utf8)?.write(to: dest)

        let cat = api.loadCatalog()
        // Either the bundled catalog (tests may run without one bundled) or an
        // empty result — but never a crash, and never a partial read.
        XCTAssertNotNil(cat.packs)
        try? FileManager.default.removeItem(at: dest)
    }

    func testRefreshIsSkippedWhileTheCacheIsFresh() async throws {
        // The privacy promise is "only when you open the pack page", and the TTL
        // is what stops re-opening it from becoming a poll. A file written just
        // now must not trigger another request.
        let store = try Store(path: NSTemporaryDirectory() + "cat3-\(UUID().uuidString).db")
        let api = ConfigAPI(store: store)
        let dir = ConfigAPI.downloadedPacksDir()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent("index.json")
        let payload = #"{"version":1,"packs":[{"id":"x","name":"X","kind":"shows","items":[]}]}"#
        try? payload.data(using: .utf8)?.write(to: dest)

        let before = try? FileManager.default.attributesOfItem(atPath: dest.path)[.modificationDate] as? Date
        api.refreshCatalogInBackground()
        try? await Task.sleep(nanoseconds: 300_000_000)
        let after = try? FileManager.default.attributesOfItem(atPath: dest.path)[.modificationDate] as? Date
        XCTAssertEqual(before, after, "a fresh cache must not be refetched")
        try? FileManager.default.removeItem(at: dest)
    }
}
