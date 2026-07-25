import XCTest
@testable import dumbTVCore

/// The household PIN: gates mutations over the API, never the TV.
final class AuthTests: XCTestCase {
    private func makeAPI() throws -> ConfigAPI {
        let store = try Store(path: NSTemporaryDirectory() + "dumbtv-auth-\(UUID().uuidString).db")
        return ConfigAPI(store: store)
    }

    func testPinLifecycleOverTheAPI() async throws {
        let api = try makeAPI()

        // Unconfigured: open — mutations work without a cookie.
        var r = await api.handle(.init(method: "GET", path: "/api/auth/status"))
        XCTAssertEqual((r.json as? [String: Any])?["configured"] as? Bool, false)
        XCTAssertEqual((r.json as? [String: Any])?["authed"] as? Bool, true)
        r = await api.handle(.init(method: "POST", path: "/api/channels", body: ["name": "Test", "number": 9]))
        XCTAssertEqual(r.status, 200)

        // Set a PIN → response carries the session cookie.
        r = await api.handle(.init(method: "POST", path: "/api/auth/setup", body: ["pin": "1234"]))
        XCTAssertEqual(r.status, 200)
        let cookie = try XCTUnwrap(r.setCookie)
        XCTAssertTrue(cookie.contains("dumbtv_auth="))

        // A mutation WITHOUT the cookie is now locked out; reads stay open.
        r = await api.handle(.init(method: "POST", path: "/api/channels", body: ["name": "Nope", "number": 10]))
        XCTAssertEqual(r.status, 401)
        r = await api.handle(.init(method: "GET", path: "/api/channels"))
        XCTAssertEqual(r.status, 200)

        // With the cookie, mutations work.
        r = await api.handle(.init(method: "POST", path: "/api/channels",
                                   body: ["name": "Yes", "number": 11], cookie: cookie))
        XCTAssertEqual(r.status, 200)

        // Wrong PIN rejected; right PIN returns a fresh session cookie.
        r = await api.handle(.init(method: "POST", path: "/api/auth/login", body: ["pin": "9999"]))
        XCTAssertEqual(r.status, 403)
        r = await api.handle(.init(method: "POST", path: "/api/auth/login", body: ["pin": "1234"]))
        XCTAssertEqual(r.status, 200)
        XCTAssertNotNil(r.setCookie)

        // Logout rotates the secret → the old cookie is dead.
        r = await api.handle(.init(method: "POST", path: "/api/auth/logout", cookie: cookie))
        XCTAssertEqual(r.status, 200)
        r = await api.handle(.init(method: "POST", path: "/api/channels",
                                   body: ["name": "Stale", "number": 12], cookie: cookie))
        XCTAssertEqual(r.status, 401)
    }

    func testPinValidation() async throws {
        let api = try makeAPI()
        let bad = await api.handle(.init(method: "POST", path: "/api/auth/setup", body: ["pin": "12"]))
        XCTAssertEqual(bad.status, 400)
        let alpha = await api.handle(.init(method: "POST", path: "/api/auth/setup", body: ["pin": "abcd"]))
        XCTAssertEqual(alpha.status, 400)
    }
}
