import XCTest
@testable import dumbTVCore

/// Live verification of the Swift `JellyfinClient` against a REAL Jellyfin server.
/// Skipped unless the env vars are set, exactly like `PlexLiveTests` — CI has no
/// server, and a test that needs one must not fail the suite when it's absent.
///
///   DUMBTV_JF_URL=http://127.0.0.1:8096 DUMBTV_JF_USER=dumbtv \
///   DUMBTV_JF_PASS=… swift test --filter JellyfinLiveTests
///
/// Ran green against Jellyfin **10.11.11** for build 13 (J1). The Node
/// counterpart is `scripts/verify-jellyfin.mjs`; that script's header explains
/// how to stand a throwaway server up in a couple of minutes.
final class JellyfinLiveTests: XCTestCase {

    private func credentials() throws -> (String, String, String) {
        let e = ProcessInfo.processInfo.environment
        guard let url = e["DUMBTV_JF_URL"], !url.isEmpty,
              let user = e["DUMBTV_JF_USER"], !user.isEmpty else {
            throw XCTSkip("Set DUMBTV_JF_URL / DUMBTV_JF_USER / DUMBTV_JF_PASS to run the live Jellyfin test.")
        }
        return (url, user, e["DUMBTV_JF_PASS"] ?? "")
    }

    func testLiveBrowseAndDirectPlay() async throws {
        let (url, user, pass) = try credentials()
        let client = JellyfinClient()

        // 1 · AuthenticateByName, with the exact X-Emby-Authorization shape.
        let server = try await client.authenticate(url: url, username: user, password: pass)
        XCTAssertFalse(server.token.isEmpty)
        XCTAssertFalse(server.userId.isEmpty)
        let reachable = await client.ping()
        XCTAssertTrue(reachable, "ping() could not reach the server")

        // 2 · Views → sections, mapped to dumbTV's show/movie types.
        let sections = try await client.sections()
        XCTAssertFalse(sections.isEmpty, "no libraries came back")
        let tv = try XCTUnwrap(sections.first { $0.type == "show" },
                              "the test library needs a tvshows library")

        // 3 · Series in a library.
        let shows = try await client.sectionItems(key: tv.key, type: "show")
        XCTAssertFalse(shows.isEmpty, "no series in the tv library")

        // 4 · Every episode under a series, with the fields the scheduler needs:
        //     a duration (or it can't be scheduled) and a jf: part key.
        let eps = try await client.episodes(showKey: shows[0].ratingKey)
        XCTAssertFalse(eps.isEmpty, "no episodes under \(shows[0].title)")
        for e in eps {
            XCTAssertGreaterThan(e.durationMs, 0, "\(e.title) has no duration")
            XCTAssertTrue((e.partKey ?? "").hasPrefix(jellyfinPrefix))
            XCTAssertNotNil(e.showTitle)
        }

        // 5 · Direct play. ?static=true must serve real bytes AND honour Range,
        //     because join-in-progress is a seek into the file (invariant #2).
        let partKey = try XCTUnwrap(eps[0].partKey)
        let built = await client.streamURL(partKey: partKey)
        let streamURL = try XCTUnwrap(built)
        XCTAssertTrue(streamURL.absoluteString.contains("static=true"))
        var req = URLRequest(url: streamURL)
        req.setValue("bytes=0-1023", forHTTPHeaderField: "Range")
        let (data, resp) = try await URLSession.shared.data(for: req)
        let http = try XCTUnwrap(resp as? HTTPURLResponse)
        XCTAssertTrue(http.statusCode == 200 || http.statusCode == 206,
                      "the stream URL returned HTTP \(http.statusCode)")
        XCTAssertGreaterThan(data.count, 0, "the stream URL served no bytes")
        XCTAssertTrue(http.statusCode == 206
                      || (http.value(forHTTPHeaderField: "Accept-Ranges") == "bytes"),
                      "no range support — join-in-progress would not seek")

        // 6 · Artwork. An item with no poster 404s, so thumb must be nil for it;
        //     an item WITH one must serve an image.
        if let art = shows.first(where: { $0.thumb != nil })?.thumb {
            let bytes = try await client.imageData(itemId: art)
            XCTAssertGreaterThan(bytes?.count ?? 0, 0, "poster fetch came back empty")
        }
    }

    /// The whole chain the owner will exercise on the device, driven through the
    /// same HTTP API the web config UI calls: connect Jellyfin → browse the
    /// library → build a channel from a Jellyfin show → the schedule resolves to
    /// a stream URL that really serves video.
    func testEndToEndChannelFromJellyfinPlays() async throws {
        let (url, user, pass) = try credentials()
        let store = try Store(path: NSTemporaryDirectory() + "dumbtv-jf-e2e-\(UUID().uuidString).db")
        let api = ConfigAPI(store: store)
        func obj(_ r: ConfigAPI.Response) -> [String: Any] { r.json as? [String: Any] ?? [:] }

        // Connect, exactly as the web UI's Jellyfin panel does.
        let connect = await api.handle(.init(method: "POST", path: "/api/jellyfin/connect",
                                             body: ["url": url, "username": user, "password": pass]))
        XCTAssertEqual(connect.status, 200, "\(obj(connect))")
        XCTAssertEqual(store.mediaBackend, "jellyfin")

        // Browse: /api/library/* is backend-agnostic, so the picker needs no changes.
        let secs = obj(await api.handle(.init(method: "GET", path: "/api/library/sections")))
        let sections = try XCTUnwrap(secs["sections"] as? [[String: Any]])
        let tv = try XCTUnwrap(sections.first { $0.string("type") == "show" })
        let itemsResp = obj(await api.handle(.init(
            method: "GET", path: "/api/library/sections/\(tv.string("key")!)/items",
            query: ["type": "show"])))
        let items = try XCTUnwrap(itemsResp["items"] as? [[String: Any]])
        let show = try XCTUnwrap(items.first)

        // Build a channel and point it at that show.
        let ch = obj(await api.handle(.init(method: "POST", path: "/api/channels",
                                            body: ["name": "JELLYFIN TEST", "orderingMode": "sequential",
                                                   "adsEnabled": false])))
        let chId = try XCTUnwrap(ch.int("id"))
        let added = await api.handle(.init(method: "POST", path: "/api/channels/\(chId)/sources",
                                          body: ["items": [["ratingKey": show.string("ratingKey")!,
                                                            "sourceType": "show",
                                                            "title": show.string("title")!]]]))
        XCTAssertEqual(added.status, 200)
        let results = try XCTUnwrap(obj(added)["results"] as? [[String: Any]])
        XCTAssertGreaterThan(results.first?.int("cached") ?? 0, 0,
                             "no episodes were cached: \(results)")

        // Schedule it and ask what's on — the same query the TV runs.
        let now = Millis(Date().timeIntervalSince1970 * 1000)
        Scheduler.topUp(store: store, now: now, windowDays: 1)
        let programs = store.programs(chId, from: now - HOUR, to: now + DAY)
        XCTAssertFalse(programs.isEmpty, "the Jellyfin channel scheduled nothing")
        let airing = try XCTUnwrap(Resolver.nowOn(programs, at: now), "nothing on air")
        let key = try XCTUnwrap(airing.program.ratingKey)
        let media = try XCTUnwrap(store.library(forChannel: chId).mediaByKey[key])
        let partKey = try XCTUnwrap(media.partKey)
        XCTAssertTrue(partKey.hasPrefix(jellyfinPrefix))

        // …and the URL the player would hand VLCKit really serves video, seeked
        // to the join-in-progress offset.
        let server = try XCTUnwrap(store.jellyfinServer())
        let streamURL = try XCTUnwrap(URL(string: JellyfinClient.streamURLString(
            partKey: partKey, server: server)))
        var req = URLRequest(url: streamURL)
        req.setValue("bytes=0-2047", forHTTPHeaderField: "Range")
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        XCTAssertTrue(code == 200 || code == 206, "stream URL returned HTTP \(code)")
        XCTAssertGreaterThan(data.count, 0)
        let type = (resp as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? ""
        XCTAssertTrue(type.hasPrefix("video/"), "expected video bytes, got \(type)")
        print("""
              live Jellyfin channel: ch \(chId) "\(airing.program.title)" \
              joined \(airing.offsetMs / 1000)s in, \(programs.count) programs scheduled, \
              \(type) confirmed
              """)
    }
}
