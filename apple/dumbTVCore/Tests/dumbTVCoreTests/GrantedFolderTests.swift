import XCTest
@testable import dumbTVCore

/// Granted folders (Track I, P6).
///
/// The NSOpenPanel itself cannot be tested — it needs a human to click a real
/// panel in a real desktop session, and that stays on the "needs a device pass"
/// list honestly rather than pretending otherwise. Everything AROUND it is
/// testable and is tested here: the record survives, the web UI can see it, a
/// moved folder is reported rather than hidden, and forgetting one leaves the
/// channel standing.
final class GrantedFolderTests: XCTestCase {

    private func obj(_ r: ConfigAPI.Response) -> [String: Any] { r.json as? [String: Any] ?? [:] }

    private func makeStore() throws -> Store {
        try Store(path: NSTemporaryDirectory() + "grant-\(UUID().uuidString).db")
    }

    func testAGrantSurvivesAndIsVisibleToTheWebUI() async throws {
        let store = try makeStore()
        let api = ConfigAPI(store: store)
        let path = "/Volumes/Media/Cartoons"
        let id = store.localFolderId(path)
        store.saveGrantedFolder(folderId: id, path: path, bookmark: Data([1, 2, 3, 4]))

        let listed = store.grantedFolders()
        XCTAssertEqual(listed.count, 1)
        XCTAssertEqual(listed.first?.folderId, id)
        // The bookmark is the permission — it must round-trip byte-for-byte
        // through base64 in a TEXT column, or the grant is lost on relaunch.
        XCTAssertEqual(store.grantedFolderBookmark(id), Data([1, 2, 3, 4]))

        let res = await api.handle(.init(method: "GET", path: "/api/local-folders"))
        XCTAssertEqual(res.status, 200)
        let folders = try XCTUnwrap(obj(res)["folders"] as? [[String: Any]])
        XCTAssertEqual(folders.first?["name"] as? String, "Cartoons")
        XCTAssertEqual(folders.first?["hasChannel"] as? Bool, false)
    }

    func testAFolderThatIsNoLongerThereSaysSo() throws {
        // An unmounted drive or a renamed folder must be REPORTED. Silently
        // showing an empty channel looks like a bug in dumbTV rather than a
        // missing disk, which is the wrong thing to make someone debug.
        let store = try makeStore()
        let path = "/Volumes/DefinitelyNotMounted/Nope"
        let id = store.localFolderId(path)
        store.saveGrantedFolder(folderId: id, path: path, bookmark: Data([9]))
        XCTAssertEqual(store.grantedFolders().first?.missing, true)
    }

    func testForgettingAFolderDropsItsMediaButKeepsTheChannel() async throws {
        let store = try makeStore()
        let path = "/tmp/dumbtv-grant-test"
        let id = store.localFolderId(path)
        store.saveGrantedFolder(folderId: id, path: path, bookmark: Data([1]))
        store.registerLocalFolder(rootPath: path, items: [
            ScannedItem(path: "\(path)/a.mp4", relPath: "a.mp4",
                        parsed: Filenames.parse("a.mp4", folder: "grant-test"), durationMs: 600_000),
        ])
        let channelId = try XCTUnwrap(store.createChannelFromLocalFolder(id, name: "Local"))
        XCTAssertEqual(store.media(forSource: id).count, 1)

        store.removeGrantedFolder(id)

        // Same rule as uninstalling a pack: the media goes, the channel stays
        // and stands by. Re-granting restores it exactly, because the folder key
        // and the rating keys are both hashes of paths — invariant #5 across a
        // re-grant, so a printed guide would still be true.
        XCTAssertEqual(store.media(forSource: id).count, 0)
        XCTAssertTrue(store.allChannels().contains { $0.id == channelId })
        XCTAssertTrue(store.grantedFolders().isEmpty)
    }

    func testTheSamePathAlwaysProducesTheSameFolderKey() throws {
        // The key is what makes a re-grant restore the same schedule rather
        // than a different one. Trailing slashes and /./ must not change it.
        let store = try makeStore()
        let a = store.localFolderId("/tmp/Shows")
        let b = store.localFolderId("/tmp/Shows/")
        let c = store.localFolderId("/tmp/./Shows")
        XCTAssertEqual(a, b)
        XCTAssertEqual(a, c)
    }

    func testRescanOfAnUnknownFolderFailsCleanly() async throws {
        let store = try makeStore()
        let api = ConfigAPI(store: store)
        let res = await api.handle(.init(method: "POST", path: "/api/local-folders/folder:deadbeef/rescan"))
        XCTAssertEqual(res.status, 400)
    }
}
