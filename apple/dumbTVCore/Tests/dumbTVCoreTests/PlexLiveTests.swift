import XCTest
@testable import dumbTVCore

/// Live checks against the user's real Plex, run only when the token env vars
/// are present (so the suite still passes offline / in CI). Verifies the Swift
/// PlexClient end-to-end on the host without the simulator.
final class PlexLiveTests: XCTestCase {

    func testSectionsAndEpisodes() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let token = env["DUMBTV_PLEX_TOKEN"], !token.isEmpty,
              let uri = env["DUMBTV_PLEX_URI"], !uri.isEmpty,
              let access = env["DUMBTV_PLEX_ACCESS"], !access.isEmpty else {
            throw XCTSkip("No Plex env vars set; skipping live test")
        }

        let client = PlexClient()
        await client.configure(token: token, serverURI: uri, accessToken: access)

        let sections = try await client.sections()
        XCTAssertFalse(sections.isEmpty, "should list library sections")
        print("SECTIONS:", sections.map { "\($0.key):\($0.title)[\($0.type)]" }.joined(separator: ", "))

        // Batman: The Animated Series = ratingKey 601 in this library.
        let eps = try await client.episodes(showKey: "601")
        XCTAssertGreaterThan(eps.count, 50, "Batman: TAS should return its episodes")
        let playable = eps.filter { $0.partKey != nil && $0.durationMs > 0 }
        XCTAssertEqual(playable.count, eps.count, "every episode has a part + duration")
        print("EPISODES:", eps.count, "first:", eps.first?.title ?? "—",
              "dur:", (eps.first?.durationMs ?? 0) / 1000, "s")

        if let first = eps.first, let pk = first.partKey {
            let url = await client.streamURL(partKey: pk)
            XCTAssertNotNil(url)
            print("STREAM URL host:", url?.host ?? "—")
        }
    }
}
