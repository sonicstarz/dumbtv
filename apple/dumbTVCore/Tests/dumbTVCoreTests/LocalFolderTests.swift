import XCTest
@testable import dumbTVCore

/// Local folders on Apple (Track I, P6): register scanned files → media with
/// stable keys → schedule a channel that resolves to local files. The folder
/// scan itself (AVFoundation) is exercised in the app; this covers the model.
final class LocalFolderTests: XCTestCase {
    private func item(_ root: String, _ name: String, _ ms: Millis) -> ScannedItem {
        ScannedItem(path: "\(root)/\(name)", relPath: name,
                    parsed: Filenames.parse(name, folder: "The Bat Channel"), durationMs: ms)
    }

    func testRegisterRescanScheduleVanish() throws {
        let store = try Store(path: NSTemporaryDirectory() + "lf-\(UUID().uuidString).db")
        let root = "/tmp/mybat"
        let items = [item(root, "The Bat Channel S01E01 Pilot.mp4", 660_000),
                     item(root, "The Bat Channel S01E02 Fear.mp4", 600_000)]

        let fid = store.registerLocalFolder(rootPath: root, items: items)
        XCTAssertEqual(store.media(forSource: fid).count, 2)
        XCTAssertTrue(store.media(forSource: fid).allSatisfy { ($0.partKey ?? "").hasPrefix("local:") })
        XCTAssertTrue(store.media(forSource: fid).allSatisfy { $0.kind == .episode })

        // Re-register (rescan) is stable — same keys, no duplicates.
        _ = store.registerLocalFolder(rootPath: root, items: items)
        XCTAssertEqual(store.media(forSource: fid).count, 2)

        // A vanished file drops out.
        _ = store.registerLocalFolder(rootPath: root, items: [items[0]])
        XCTAssertEqual(store.media(forSource: fid).count, 1)

        // A channel from the folder schedules and resolves to a local file.
        let ch = try XCTUnwrap(store.createChannelFromLocalFolder(fid, name: "My Shows"))
        let now: Millis = 1_785_000_000_000
        Scheduler.topUp(store: store, now: now, windowDays: 2)
        let progs = store.programs(ch, from: now, to: now + 2 * DAY)
        XCTAssertFalse(progs.isEmpty)
        for i in 1..<progs.count { XCTAssertEqual(progs[i].startUtc, progs[i - 1].endUtc) }
        let airing = try XCTUnwrap(Resolver.nowOn(progs, at: now))
        let m = try XCTUnwrap(store.library(forChannel: ch).mediaByKey[airing.program.ratingKey!])
        XCTAssertTrue((m.partKey ?? "").hasPrefix("local:"))
    }
}
