import XCTest
@testable import dumbTVCore

/// Content packs (Track I, P1): install a built pack, schedule a channel from
/// it, and prove pack: keys resolve to local files — the Swift half of the
/// pack model, mirroring the Node selftest coverage.
final class PackTests: XCTestCase {
    private func makeStore() throws -> Store {
        try Store(path: NSTemporaryDirectory() + "dumbtv-pack-\(UUID().uuidString).db")
    }

    /// Write a built pack.json to a temp dir (scheduling needs only durations,
    /// so no real media files are required).
    private func writePack(_ id: String) throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("pack-\(id)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let json = """
        {"id":"\(id)","name":"TEST","version":1,"kind":"shows",
         "channel":{"number":90,"name":"TEST","ordering":"release_order","seed":424242},
         "items":[
           {"id":"a","file":"01-a.mp4","title":"A","show":"T","season":1,"episode":1,"aired":"1994-01-01","durationMs":660000},
           {"id":"b","file":"02-b.mp4","title":"B","show":"T","season":1,"episode":2,"aired":"1994-01-02","durationMs":540000},
           {"id":"c","file":"03-c.mp4","title":"C","show":"T","season":1,"episode":3,"aired":"1994-01-03","durationMs":780000}]}
        """
        try json.data(using: .utf8)!.write(to: dir.appendingPathComponent("pack.json"))
        return dir
    }

    /// A pack that shipped bundled in one release and is dropped from the next
    /// (POPEYE: preload → download-only) must become RE-DOWNLOADABLE, not a
    /// permanently "installed" row pointing at files that no longer exist.
    func testMissingPackFilesAreReconciledSoItCanBeDownloadedAgain() throws {
        let store = try makeStore()
        let dir = try writePack("gone")
        _ = try store.installPack(fromDir: dir, origin: "bundled")
        let ch = try XCTUnwrap(store.createChannelFromPack("gone"))
        XCTAssertEqual(store.media(forSource: packRatingKey("gone")).count, 3)

        // While the files are present, reconciliation must do nothing.
        XCTAssertEqual(store.reconcileMissingPacks(), [])
        XCTAssertEqual(store.packs().count, 1)

        // The app updates and no longer bundles it — the directory is gone.
        try FileManager.default.removeItem(at: dir)
        XCTAssertEqual(store.reconcileMissingPacks(), ["gone"])
        XCTAssertTrue(store.packs().isEmpty, "the stale registration should be dropped")
        XCTAssertEqual(store.media(forSource: packRatingKey("gone")).count, 0)

        // The CHANNEL survives, still pointing at the pack, so re-installing
        // restores it rather than the user having to rebuild it.
        let channel = try XCTUnwrap(store.channel(ch))
        XCTAssertEqual(channel.name, "TEST")
        XCTAssertEqual(store.sources(ch).first?.ratingKey, packRatingKey("gone"))
    }

    /// …and re-installing genuinely restores it: same ids, same rating keys, so
    /// the deterministic schedule resumes instead of reshuffling (invariant #5).
    func testReinstallAfterReconcileRestoresTheSameKeys() throws {
        let store = try makeStore()
        let dir = try writePack("gone")
        _ = try store.installPack(fromDir: dir, origin: "bundled")
        _ = store.createChannelFromPack("gone")
        let before = store.media(forSource: packRatingKey("gone")).map(\.ratingKey).sorted()

        try FileManager.default.removeItem(at: dir)
        _ = store.reconcileMissingPacks()

        // The user taps Download; it lands in a different directory this time.
        let redownloaded = try writePack("gone")
        _ = try store.installPack(fromDir: redownloaded, origin: "downloaded")
        let after = store.media(forSource: packRatingKey("gone")).map(\.ratingKey).sorted()
        XCTAssertEqual(before, after, "re-install must restore identical rating keys")
        XCTAssertEqual(store.packs().first?.origin, "downloaded")
    }

    func testInstallResolveScheduleUninstall() throws {
        let store = try makeStore()
        let dir = try writePack("testpack")

        // Install registers all items as media with pack: keys.
        let installed = try store.installPack(fromDir: dir, origin: "bundled")
        XCTAssertEqual(installed.id, "testpack")
        let media = store.media(forSource: packRatingKey("testpack"))
        XCTAssertEqual(media.count, 3)
        XCTAssertTrue(media.allSatisfy { ($0.partKey ?? "").hasPrefix("pack:testpack/") })

        // pack: key resolves to a file under the pack root.
        let resolved = store.resolvePackPath("pack:testpack/01-a.mp4")
        XCTAssertEqual(resolved, dir.appendingPathComponent("01-a.mp4").path)
        XCTAssertNil(store.resolvePackPath("pack:testpack"))       // bare source key, not a file

        // A channel built from the pack schedules gap-free, joinable content.
        let ch = try XCTUnwrap(store.createChannelFromPack("testpack"))
        let now: Millis = 1_785_000_000_000
        Scheduler.topUp(store: store, now: now, windowDays: 2)
        let progs = store.programs(ch, from: now, to: now + 2 * DAY)
        XCTAssertFalse(progs.isEmpty)
        for i in 1..<progs.count {
            XCTAssertEqual(progs[i].startUtc, progs[i - 1].endUtc, "pack schedule must be gap-free")
        }
        let airing = try XCTUnwrap(Resolver.nowOn(progs, at: now))
        let key = try XCTUnwrap(airing.program.ratingKey)
        let m = try XCTUnwrap(store.library(forChannel: ch).mediaByKey[key])
        XCTAssertTrue((store.resolvePackPath(m.partKey ?? "") ?? "").hasSuffix(".mp4"),
                      "what's airing resolves to a pack file")

        // Reinstall is idempotent (no duplicate rows).
        _ = try store.installPack(fromDir: dir, origin: "bundled")
        XCTAssertEqual(store.media(forSource: packRatingKey("testpack")).count, 3)

        // Uninstall removes the media rows.
        store.uninstallPack("testpack")
        XCTAssertEqual(store.media(forSource: packRatingKey("testpack")).count, 0)
        XCTAssertTrue(store.packs().isEmpty)

        try? FileManager.default.removeItem(at: dir)
    }

    func testPartialToFullUpgrade() throws {
        let store = try Store(path: NSTemporaryDirectory() + "up-\(UUID().uuidString).db")
        // Bundled partial: 1 episode (like Superman's one-ep preload).
        let partial = PackManifest(
            id: "up", name: "UP", version: 1, kind: "shows",
            channel: .init(number: 30, name: "UP", ordering: "release_order", seed: 1),
            items: [.init(id: "e1", file: "e1.mp4", title: "E1", show: "S", season: 1, episode: 1,
                          aired: nil, durationMs: 600000)])
        store.installPack(partial, rootPath: "/tmp/up-bundle", origin: "bundled")
        XCTAssertEqual(store.media(forSource: packRatingKey("up")).count, 1)
        let ch = try XCTUnwrap(store.createChannelFromPack("up"))

        // Download the full pack (same id, e1 shared) — re-registers, repoints root.
        let full = PackManifest(
            id: "up", name: "UP", version: 1, kind: "shows", channel: partial.channel,
            items: (1...3).map { .init(id: "e\($0)", file: "e\($0).mp4", title: "E\($0)", show: "S",
                                       season: 1, episode: $0, aired: nil, durationMs: 600000) })
        store.installPack(full, rootPath: "/tmp/up-download", origin: "downloaded")
        XCTAssertEqual(store.media(forSource: packRatingKey("up")).count, 3, "grows to 3, no dupes")
        XCTAssertEqual(store.resolvePackPath("pack:up/e1.mp4"), "/tmp/up-download/e1.mp4", "root repointed")
        XCTAssertEqual(store.library(forChannel: ch).mediaByKey.count, 3, "channel now sees all 3")
    }

    func testAdsPackRegistersAsAssets() throws {
        let store = try makeStore()
        let m = PackManifest(
            id: "ads1", name: "ADS", version: 1, kind: "ads", channel: nil,
            items: [.init(id: "spot", file: "01-spot.mp4", title: "Spot", show: nil,
                          season: nil, episode: nil, aired: nil, durationMs: 30000)])
        let installed = store.installPack(m, rootPath: "/tmp/ads1", origin: "downloaded")
        XCTAssertEqual(installed.kind, "ads")
        // An ads pack has no schedulable media, and can't become a channel.
        XCTAssertTrue(store.media(forSource: packRatingKey("ads1")).isEmpty)
        XCTAssertNil(store.createChannelFromPack("ads1"))

        // A1: the ad asset MUST carry a partKey that resolves to a local file —
        // it was nil, so the Engine's ad branch played dead air for every break.
        let expectedKey = packPartKey("ads1", "01-spot.mp4")
        let partKey = ((try? store.sql.query("SELECT part_key FROM assets WHERE path=?", [.text(expectedKey)])) ?? [])
            .first?.text("part_key")
        XCTAssertEqual(partKey, expectedKey, "ad asset must have a pack: partKey")
        XCTAssertEqual(store.resolvePackPath(partKey ?? ""), "/tmp/ads1/01-spot.mp4",
                       "ad partKey must resolve to the pack file")
    }
}
