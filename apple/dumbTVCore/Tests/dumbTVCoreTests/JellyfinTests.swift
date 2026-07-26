import XCTest
@testable import dumbTVCore

/// J1 — Jellyfin on the Apple embedded server. These cover the wire contract and
/// the backend dispatch (what the web UI and the player depend on); the API-shape
/// itself is verified against a live server by `scripts/verify-jellyfin.mjs`,
/// which was run against Jellyfin 10.11.11 for this build.
final class JellyfinTests: XCTestCase {
    /// Durable settings are mirrored to UserDefaults.standard, which is
    /// process-global — exactly what we want on a device (it's what survives a
    /// tvOS Caches purge) and exactly what leaks between tests. Wipe it so each
    /// test starts from a genuinely unconfigured box.
    override func setUp() {
        super.setUp()
        let d = UserDefaults.standard
        for k in d.dictionaryRepresentation().keys where k.hasPrefix("dumbtv.durable.") {
            d.removeObject(forKey: k)
        }
    }

    private func makeStore() throws -> Store {
        try Store(path: NSTemporaryDirectory() + "dumbtv-jf-\(UUID().uuidString).db")
    }
    private func api(_ store: Store) -> ConfigAPI { ConfigAPI(store: store) }
    private func obj(_ r: ConfigAPI.Response) -> [String: Any] { r.json as? [String: Any] ?? [:] }

    /// Plex until told otherwise, and the switch round-trips through /api/status.
    func testBackendSwitchRoundTrips() async throws {
        let store = try makeStore()
        let a = api(store)

        let before = obj(await a.handle(.init(method: "GET", path: "/api/status")))
        XCTAssertEqual(before.string("backend"), "plex")

        let sw = await a.handle(.init(method: "POST", path: "/api/media/backend",
                                     body: ["backend": "jellyfin"]))
        XCTAssertEqual(sw.status, 200)
        XCTAssertEqual(obj(sw).string("backend"), "jellyfin")
        XCTAssertEqual(store.mediaBackend, "jellyfin")
        let afterSwitch = obj(await a.handle(.init(method: "GET", path: "/api/status")))
        XCTAssertEqual(afterSwitch.string("backend"), "jellyfin")

        // Anything that isn't "jellyfin" means Plex — no third state.
        let back = await a.handle(.init(method: "POST", path: "/api/media/backend",
                                       body: ["backend": "nonsense"]))
        XCTAssertEqual(obj(back).string("backend"), "plex")
        XCTAssertEqual(store.mediaBackend, "plex")
    }

    /// /api/jellyfin/status was a hardcoded `configured:false` stub through build
    /// 12. It now reports the real thing.
    func testJellyfinStatusReflectsTheStore() async throws {
        let store = try makeStore()
        let a = api(store)

        var st = obj(await a.handle(.init(method: "GET", path: "/api/jellyfin/status")))
        XCTAssertEqual(st.bool("configured"), false)
        XCTAssertEqual(st.bool("active"), false)

        store.saveJellyfinServer(JellyfinServer(url: "http://jf.local:8096", token: "tok",
                                                userId: "user-1", name: "Basement"))
        store.setSetting("media_backend", "jellyfin")

        st = obj(await a.handle(.init(method: "GET", path: "/api/jellyfin/status")))
        XCTAssertEqual(st.bool("configured"), true)
        XCTAssertEqual(st.bool("active"), true)
        XCTAssertEqual((st["server"] as? [String: Any])?.string("url"), "http://jf.local:8096")
        XCTAssertEqual((st["server"] as? [String: Any])?.string("name"), "Basement")

        // …and the web UI's "linked"/"server" reflect Jellyfin, not Plex.
        let s = obj(await a.handle(.init(method: "GET", path: "/api/status")))
        XCTAssertEqual(s.bool("linked"), true)
        XCTAssertEqual((s["server"] as? [String: Any])?.string("name"), "Basement")
    }

    /// Logging out clears the credentials AND falls back to Plex, so the app is
    /// never left pointing at a backend it can't reach.
    func testLogoutClearsAndFallsBackToPlex() async throws {
        let store = try makeStore()
        let a = api(store)
        store.saveJellyfinServer(JellyfinServer(url: "http://jf.local:8096", token: "tok",
                                                userId: "u", name: "JF"))
        store.setSetting("media_backend", "jellyfin")

        let out = await a.handle(.init(method: "POST", path: "/api/jellyfin/logout"))
        XCTAssertEqual(out.status, 200)
        XCTAssertNil(store.jellyfinServer())
        XCTAssertEqual(store.mediaBackend, "plex")
    }

    func testConnectRejectsAMissingAddress() async throws {
        let a = api(try makeStore())
        let r = await a.handle(.init(method: "POST", path: "/api/jellyfin/connect",
                                     body: ["username": "me", "password": "x"]))
        XCTAssertEqual(r.status, 400)
    }

    func testApiKeyConnectNeedsAllThreeFields() async throws {
        let store = try makeStore()
        let a = api(store)
        let bad = await a.handle(.init(method: "POST", path: "/api/jellyfin/apikey",
                                       body: ["url": "http://jf.local:8096"]))
        XCTAssertEqual(bad.status, 400)
        XCTAssertNil(store.jellyfinServer())

        let good = await a.handle(.init(method: "POST", path: "/api/jellyfin/apikey",
                                        body: ["url": "http://jf.local:8096/", "userId": "u1", "apiKey": "k1"]))
        XCTAssertEqual(good.status, 200)
        let saved = try XCTUnwrap(store.jellyfinServer())
        XCTAssertEqual(saved.url, "http://jf.local:8096", "the trailing slash should be trimmed")
        XCTAssertEqual(saved.token, "k1")
        XCTAssertEqual(store.mediaBackend, "jellyfin")
    }

    /// Credentials survive a tvOS Caches purge (they're in `durableKeys`), which
    /// is what stops the box asking you to re-link after an eviction.
    func testCredentialsAreDurable() throws {
        let store = try makeStore()
        store.saveJellyfinServer(JellyfinServer(url: "http://jf.local:8096", token: "tok",
                                                userId: "u", name: "JF"))
        store.setSetting("media_backend", "jellyfin")

        // A Caches purge leaves the app with a brand-new empty database. The
        // credentials must come back from the UserDefaults mirror, or the box
        // silently forgets its server and asks you to link it again.
        let afterPurge = try makeStore()
        let restored = try XCTUnwrap(afterPurge.jellyfinServer())
        XCTAssertEqual(restored.url, "http://jf.local:8096")
        XCTAssertEqual(restored.token, "tok")
        XCTAssertEqual(restored.userId, "u")
        XCTAssertEqual(restored.name, "JF")
        XCTAssertEqual(afterPurge.mediaBackend, "jellyfin", "the active backend should survive too")
    }

    /// The stream URL shape, verified live against 10.11.11. `?static=true` is
    /// what tells Jellyfin never to transcode (invariant #2) — without it the
    /// server is free to re-encode, which kills instant seeking.
    func testStreamURLIsDirectPlay() {
        let s = JellyfinServer(url: "http://jf.local:8096", token: "TOK", userId: "u", name: "JF")
        let url = JellyfinClient.streamURLString(partKey: "jf:abc123", server: s)
        XCTAssertEqual(url,
            "http://jf.local:8096/Videos/abc123/stream?static=true&mediaSourceId=abc123&api_key=TOK")
        XCTAssertTrue(url.contains("static=true"))
        // A bare id (no prefix) is accepted too, same as the Node client.
        XCTAssertEqual(JellyfinClient.streamURLString(partKey: "abc123", server: s), url)
    }

    /// Playback dispatches on the part-KEY, not the active backend — so a schedule
    /// cached under Jellyfin still plays after switching to Plex, and one channel
    /// can mix Plex shows with a Jellyfin ad library.
    func testPartKeyPrefixIsTheDispatchSignal() throws {
        let store = try makeStore()
        store.saveJellyfinServer(JellyfinServer(url: "http://jf.local:8096", token: "T",
                                                userId: "u", name: "JF"))
        store.setSetting("media_backend", "plex")   // Plex is ACTIVE…
        let s = try XCTUnwrap(store.jellyfinServer())
        // …and a jf: key still resolves to Jellyfin.
        XCTAssertTrue(JellyfinClient.streamURLString(partKey: "jf:x", server: s)
            .hasPrefix("http://jf.local:8096/Videos/x/stream"))
        XCTAssertTrue("jf:x".hasPrefix(jellyfinPrefix))
        XCTAssertFalse("/library/parts/9/file.mkv".hasPrefix(jellyfinPrefix))
    }

    func testTrimURLDropsTrailingSlashes() {
        XCTAssertEqual(JellyfinClient.trimURL("http://a:8096///"), "http://a:8096")
        XCTAssertEqual(JellyfinClient.trimURL("  http://a:8096  "), "http://a:8096")
        XCTAssertEqual(JellyfinClient.trimURL("http://a:8096"), "http://a:8096")
    }
}
