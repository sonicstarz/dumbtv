import XCTest
@testable import dumbTVCore

final class ConfigAPITests: XCTestCase {
    private func api() throws -> ConfigAPI {
        let path = NSTemporaryDirectory() + "dumbtv-api-\(UUID().uuidString).db"
        return ConfigAPI(store: try Store(path: path))
    }

    private func obj(_ r: ConfigAPI.Response) -> [String: Any] { r.json as? [String: Any] ?? [:] }

    func testUnknownRoute404() throws {
        let a = try api()
        XCTAssertEqual(a.handle(.init(method: "GET", path: "/api/nope")).status, 404)
        XCTAssertEqual(a.handle(.init(method: "GET", path: "/nope")).status, 404)
    }

    func testChannelLifecycleOverTheAPI() throws {
        let a = try api()

        // Create
        let created = a.handle(.init(method: "POST", path: "/api/channels",
                                     body: ["name": "Retro Toons", "orderingMode": "shuffle", "adsEnabled": false]))
        XCTAssertEqual(created.status, 200)
        let id = obj(created).int("id")!
        XCTAssertGreaterThan(id, 0)

        // List
        let list = a.handle(.init(method: "GET", path: "/api/channels"))
        let channels = obj(list)["channels"] as! [[String: Any]]
        XCTAssertEqual(channels.count, 1)
        XCTAssertEqual(channels[0].string("name"), "Retro Toons")
        XCTAssertEqual(channels[0].string("orderingMode"), "shuffle")
        XCTAssertEqual(channels[0].bool("adsEnabled"), false)

        // Patch
        let patched = a.handle(.init(method: "PATCH", path: "/api/channels/\(id)",
                                     body: ["name": "Saturday AM", "enabled": false]))
        XCTAssertEqual(patched.status, 200)
        let after = obj(a.handle(.init(method: "GET", path: "/api/channels")))["channels"] as! [[String: Any]]
        XCTAssertEqual(after[0].string("name"), "Saturday AM")
        XCTAssertEqual(after[0].bool("enabled"), false)

        // Delete
        XCTAssertEqual(a.handle(.init(method: "DELETE", path: "/api/channels/\(id)")).status, 200)
        let empty = obj(a.handle(.init(method: "GET", path: "/api/channels")))["channels"] as! [[String: Any]]
        XCTAssertTrue(empty.isEmpty)
    }

    func testPatchUnknownChannel404() throws {
        let a = try api()
        XCTAssertEqual(a.handle(.init(method: "PATCH", path: "/api/channels/999", body: ["name": "x"])).status, 404)
    }

    func testSourcesAndExcludes() throws {
        let a = try api()
        let id = obj(a.handle(.init(method: "POST", path: "/api/channels", body: ["name": "M"]))).int("id")!

        _ = a.handle(.init(method: "POST", path: "/api/channels/\(id)/sources",
                           body: ["items": [["ratingKey": "s1", "sourceType": "show", "title": "X-Men"],
                                            ["ratingKey": "s2", "sourceType": "show", "title": "Spidey"]]]))
        let chs = obj(a.handle(.init(method: "GET", path: "/api/channels")))["channels"] as! [[String: Any]]
        XCTAssertEqual((chs[0]["sources"] as! [[String: Any]]).count, 2)

        _ = a.handle(.init(method: "PUT", path: "/api/channels/\(id)/excludes", body: ["ratingKeys": ["e1", "e2"]]))
        let ex = obj(a.handle(.init(method: "GET", path: "/api/channels/\(id)/excludes")))["excludes"] as! [Any]
        XCTAssertEqual(ex.count, 2)
    }

    func testRulesOverTheAPI() throws {
        let a = try api()
        let id = obj(a.handle(.init(method: "POST", path: "/api/channels", body: ["name": "R"]))).int("id")!

        // kind is required
        XCTAssertEqual(a.handle(.init(method: "POST", path: "/api/channels/\(id)/rules", body: [:])).status, 400)

        let made = a.handle(.init(method: "POST", path: "/api/channels/\(id)/rules",
                                  body: ["kind": "pinned", "name": "Xmas", "startsAtUtc": 1_700_000_000_000]))
        let rid = obj(made).int("id")!
        let rules = obj(a.handle(.init(method: "GET", path: "/api/channels/\(id)/rules")))["rules"] as! [[String: Any]]
        XCTAssertEqual(rules.count, 1)
        XCTAssertEqual(rules[0].string("kind"), "pinned")
        XCTAssertEqual(rules[0].int("priority"), 800)   // default for pinned

        _ = a.handle(.init(method: "PATCH", path: "/api/rules/\(rid)", body: ["enabled": false, "priority": 999]))
        let after = obj(a.handle(.init(method: "GET", path: "/api/channels/\(id)/rules")))["rules"] as! [[String: Any]]
        XCTAssertEqual(after[0].int("priority"), 999)
        XCTAssertEqual(after[0].bool("enabled"), false)

        XCTAssertEqual(a.handle(.init(method: "DELETE", path: "/api/rules/\(rid)")).status, 200)
        let gone = obj(a.handle(.init(method: "GET", path: "/api/channels/\(id)/rules")))["rules"] as! [[String: Any]]
        XCTAssertTrue(gone.isEmpty)
    }

    func testSettingsRoundTrip() throws {
        let a = try api()
        _ = a.handle(.init(method: "POST", path: "/api/settings",
                           body: ["dvrSlots": 8, "displayFill": "fill", "timezone": "America/New_York"]))
        let s = obj(a.handle(.init(method: "GET", path: "/api/settings")))
        XCTAssertEqual(s.int("dvrSlots"), 8)
        XCTAssertEqual(s.string("displayFill"), "fill")
        XCTAssertEqual(s.string("timezone"), "America/New_York")
    }

    func testResponseSerialisesToJSON() throws {
        let a = try api()
        _ = a.handle(.init(method: "POST", path: "/api/channels", body: ["name": "JSON test"]))
        let resp = a.handle(.init(method: "GET", path: "/api/channels"))
        // The whole response must be JSONSerialization-encodable (NSNull for nulls, etc.).
        XCTAssertTrue(JSONSerialization.isValidJSONObject(resp.json))
        let data = try JSONSerialization.data(withJSONObject: resp.json)
        XCTAssertGreaterThan(data.count, 0)
    }
}
