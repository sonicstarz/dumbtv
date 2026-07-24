import XCTest
@testable import dumbTVCore

final class ConfigAPITests: XCTestCase {
    private func api() throws -> ConfigAPI {
        let path = NSTemporaryDirectory() + "dumbtv-api-\(UUID().uuidString).db"
        return ConfigAPI(store: try Store(path: path))
    }

    private func obj(_ r: ConfigAPI.Response) -> [String: Any] { r.json as? [String: Any] ?? [:] }

    func testUnknownRoute404() async throws {
        let a = try api()
        do { let s = await a.handle(.init(method: "GET", path: "/api/nope")).status; XCTAssertEqual(s, 404) }
        do { let s = await a.handle(.init(method: "GET", path: "/nope")).status; XCTAssertEqual(s, 404) }
    }

    func testChannelLifecycleOverTheAPI() async throws {
        let a = try api()

        // Create
        let created = await a.handle(.init(method: "POST", path: "/api/channels",
                                     body: ["name": "Retro Toons", "orderingMode": "shuffle", "adsEnabled": false]))
        XCTAssertEqual(created.status, 200)
        let id = obj(created).int("id")!
        XCTAssertGreaterThan(id, 0)

        // List
        let list = await a.handle(.init(method: "GET", path: "/api/channels"))
        let channels = obj(list)["channels"] as! [[String: Any]]
        XCTAssertEqual(channels.count, 1)
        XCTAssertEqual(channels[0].string("name"), "Retro Toons")
        XCTAssertEqual(channels[0].string("orderingMode"), "shuffle")
        XCTAssertEqual(channels[0].bool("adsEnabled"), false)

        // Patch
        let patched = await a.handle(.init(method: "PATCH", path: "/api/channels/\(id)",
                                     body: ["name": "Saturday AM", "enabled": false]))
        XCTAssertEqual(patched.status, 200)
        let after = obj(await a.handle(.init(method: "GET", path: "/api/channels")))["channels"] as! [[String: Any]]
        XCTAssertEqual(after[0].string("name"), "Saturday AM")
        XCTAssertEqual(after[0].bool("enabled"), false)

        // Delete
        do { let s = await a.handle(.init(method: "DELETE", path: "/api/channels/\(id)")).status; XCTAssertEqual(s, 200) }
        let empty = obj(await a.handle(.init(method: "GET", path: "/api/channels")))["channels"] as! [[String: Any]]
        XCTAssertTrue(empty.isEmpty)
    }

    func testPatchUnknownChannel404() async throws {
        let a = try api()
        do { let s = await a.handle(.init(method: "PATCH", path: "/api/channels/999", body: ["name": "x"])).status; XCTAssertEqual(s, 404) }
    }

    func testSourcesAndExcludes() async throws {
        let a = try api()
        let id = obj(await a.handle(.init(method: "POST", path: "/api/channels", body: ["name": "M"]))).int("id")!

        _ = await a.handle(.init(method: "POST", path: "/api/channels/\(id)/sources",
                           body: ["items": [["ratingKey": "s1", "sourceType": "show", "title": "X-Men"],
                                            ["ratingKey": "s2", "sourceType": "show", "title": "Spidey"]]]))
        let chs = obj(await a.handle(.init(method: "GET", path: "/api/channels")))["channels"] as! [[String: Any]]
        XCTAssertEqual((chs[0]["sources"] as! [[String: Any]]).count, 2)

        _ = await a.handle(.init(method: "PUT", path: "/api/channels/\(id)/excludes", body: ["ratingKeys": ["e1", "e2"]]))
        let ex = obj(await a.handle(.init(method: "GET", path: "/api/channels/\(id)/excludes")))["excludes"] as! [Any]
        XCTAssertEqual(ex.count, 2)
    }

    func testRulesOverTheAPI() async throws {
        let a = try api()
        let id = obj(await a.handle(.init(method: "POST", path: "/api/channels", body: ["name": "R"]))).int("id")!

        // kind is required
        do { let s = await a.handle(.init(method: "POST", path: "/api/channels/\(id)/rules", body: [:])).status; XCTAssertEqual(s, 400) }

        let made = await a.handle(.init(method: "POST", path: "/api/channels/\(id)/rules",
                                  body: ["kind": "pinned", "name": "Xmas", "startsAtUtc": 1_700_000_000_000]))
        let rid = obj(made).int("id")!
        let rules = obj(await a.handle(.init(method: "GET", path: "/api/channels/\(id)/rules")))["rules"] as! [[String: Any]]
        XCTAssertEqual(rules.count, 1)
        XCTAssertEqual(rules[0].string("kind"), "pinned")
        XCTAssertEqual(rules[0].int("priority"), 800)   // default for pinned

        _ = await a.handle(.init(method: "PATCH", path: "/api/rules/\(rid)", body: ["enabled": false, "priority": 999]))
        let after = obj(await a.handle(.init(method: "GET", path: "/api/channels/\(id)/rules")))["rules"] as! [[String: Any]]
        XCTAssertEqual(after[0].int("priority"), 999)
        XCTAssertEqual(after[0].bool("enabled"), false)

        do { let s = await a.handle(.init(method: "DELETE", path: "/api/rules/\(rid)")).status; XCTAssertEqual(s, 200) }
        let gone = obj(await a.handle(.init(method: "GET", path: "/api/channels/\(id)/rules")))["rules"] as! [[String: Any]]
        XCTAssertTrue(gone.isEmpty)
    }

    func testSettingsRoundTrip() async throws {
        let a = try api()
        _ = await a.handle(.init(method: "POST", path: "/api/settings",
                           body: ["dvrSlots": 8, "displayFill": "fill", "timezone": "America/New_York"]))
        let s = obj(await a.handle(.init(method: "GET", path: "/api/settings")))
        XCTAssertEqual(s.int("dvrSlots"), 8)
        XCTAssertEqual(s.string("displayFill"), "fill")
        XCTAssertEqual(s.string("timezone"), "America/New_York")
    }

    func testResponseSerialisesToJSON() async throws {
        let a = try api()
        _ = await a.handle(.init(method: "POST", path: "/api/channels", body: ["name": "JSON test"]))
        let resp = await a.handle(.init(method: "GET", path: "/api/channels"))
        // The whole response must be JSONSerialization-encodable (NSNull for nulls, etc.).
        XCTAssertTrue(JSONSerialization.isValidJSONObject(resp.json))
        let data = try JSONSerialization.data(withJSONObject: resp.json)
        XCTAssertGreaterThan(data.count, 0)
    }
}
