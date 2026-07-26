import XCTest
@testable import dumbTVCore

/// The Swift filename parser must agree with the Node one on the SAME shared
/// vectors (scripts/filename-vectors.json) — one naming spec, two impls.
final class FilenameTests: XCTestCase {
    struct Vector: Decodable {
        var file: String; var folder: String
        var kind: String; var title: String
        var showTitle: String?; var seasonNo: Int?; var episodeNo: Int?; var year: Int?
    }

    func testAgainstSharedVectors() throws {
        // Locate scripts/filename-vectors.json relative to this test file.
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = repo.appendingPathComponent("scripts/filename-vectors.json")
        let vectors = try JSONDecoder().decode([Vector].self, from: Data(contentsOf: url))
        XCTAssertFalse(vectors.isEmpty)

        for v in vectors {
            let r = Filenames.parse(v.file, folder: v.folder)
            XCTAssertEqual(r.kind.rawValue, v.kind, "kind for \(v.file)")
            XCTAssertEqual(r.title, v.title, "title for \(v.file)")
            if v.showTitle != nil { XCTAssertEqual(r.showTitle, v.showTitle, "show for \(v.file)") }
            if v.seasonNo != nil { XCTAssertEqual(r.seasonNo, v.seasonNo, "season for \(v.file)") }
            if v.episodeNo != nil { XCTAssertEqual(r.episodeNo, v.episodeNo, "episode for \(v.file)") }
            if v.year != nil { XCTAssertEqual(r.year, v.year, "year for \(v.file)") }
        }
    }
}
