import Foundation

/// A pure request → response router for the config API, implementing the
/// Store-backed slice of `docs/api-contract.md`. No networking here: the app's
/// embedded HTTP server parses the wire and calls `handle`, so this stays
/// headless-testable. Plex-link / library / guide endpoints (async, or engine-
/// backed) are layered on separately.
public final class ConfigAPI {
    let store: Store
    public init(store: Store) { self.store = store }

    public struct Request {
        public let method: String                 // GET / POST / PATCH / DELETE
        public let path: String                   // "/api/channels/3"
        public let query: [String: String]
        public let body: [String: Any]?           // parsed JSON object, if any
        public init(method: String, path: String, query: [String: String] = [:], body: [String: Any]? = nil) {
            self.method = method; self.path = path; self.query = query; self.body = body
        }
    }

    public struct Response {
        public let status: Int
        public let json: Any                       // JSON-serialisable (Dictionary/Array/scalar)
        public init(_ status: Int, _ json: Any) { self.status = status; self.json = json }
        static func ok(_ j: Any = ["ok": true]) -> Response { Response(200, j) }
        static func bad(_ msg: String) -> Response { Response(400, ["error": msg]) }
        static func notFound(_ msg: String = "Not found") -> Response { Response(404, ["error": msg]) }
    }

    /// Route a request. Returns 404 for anything unmatched. Swift can't bind
    /// inside array-literal patterns, so we switch on (method, segment-count)
    /// and read the path segments explicitly.
    public func handle(_ req: Request) -> Response {
        let parts = req.path.split(separator: "/").map(String.init)  // ["api","channels","3"]
        guard parts.first == "api" else { return .notFound() }
        let s = Array(parts.dropFirst())
        let m = req.method.uppercased()

        switch (m, s.count) {
        case ("GET", 1) where s[0] == "status":     return status()
        case ("GET", 1) where s[0] == "channels":   return listChannels()
        case ("POST", 1) where s[0] == "channels":  return createChannel(req)
        case ("GET", 1) where s[0] == "settings":   return getSettings()
        case ("POST", 1) where s[0] == "settings":  return postSettings(req)

        case ("PATCH", 2) where s[0] == "channels":  return patchChannel(s[1], req)
        case ("DELETE", 2) where s[0] == "channels": return deleteChannel(s[1])
        case ("PATCH", 2) where s[0] == "rules":     return patchRule(s[1], req)
        case ("DELETE", 2) where s[0] == "rules":    return deleteRule(s[1])
        case ("GET", 2) where s[0] == "config" && s[1] == "export": return exportConfig()

        case ("POST", 3) where s[0] == "channels" && s[2] == "sources":  return addSources(s[1], req)
        case ("GET", 3) where s[0] == "channels" && s[2] == "excludes":  return getExcludes(s[1])
        case ("PUT", 3) where s[0] == "channels" && s[2] == "excludes":  return putExcludes(s[1], req)
        case ("GET", 3) where s[0] == "channels" && s[2] == "rules":     return listRules(s[1])
        case ("POST", 3) where s[0] == "channels" && s[2] == "rules":    return createRule(s[1], req)

        case ("DELETE", 4) where s[0] == "channels" && s[2] == "sources": return deleteSource(s[1], s[3])
        default: return .notFound("No route for \(m) \(req.path)")
        }
    }

    // MARK: - status

    private func status() -> Response {
        .ok([
            "backend": "plex",
            "linked": store.getSetting("plex_token") != nil,
            "counts": ["channels": store.allChannels().count],
            "orderingModes": OrderingMode.allCases.map { $0.rawValue },
        ])
    }

    // MARK: - channels

    private func listChannels() -> Response {
        .ok(["channels": store.allChannels().map(channelJSON)])
    }

    private func createChannel(_ req: Request) -> Response {
        let b = req.body ?? [:]
        let c = ChannelConfig(
            id: 0,
            number: b.int("number") ?? store.nextChannelNumber(),
            name: b.string("name") ?? "New Channel",
            slotMinutes: b.int("slotMinutes") ?? 30,
            orderingMode: OrderingMode(rawValue: b.string("orderingMode") ?? "") ?? .sequential,
            marathonSize: b.int("marathonSize") ?? 3,
            shuffleSeed: UInt32.random(in: 1...UInt32.max),
            darkStart: b.string("darkStart"), darkEnd: b.string("darkEnd"),
            adsEnabled: b.bool("adsEnabled") ?? true,
            maxAdsPerBreak: b.int("maxAdsPerBreak") ?? 10,
            adTags: b.string("adTags") ?? "")
        let id = store.insertChannel(c)
        return .ok(["id": id])
    }

    private func patchChannel(_ idStr: String, _ req: Request) -> Response {
        guard let id = Int(idStr), var c = store.channel(id) else { return .notFound("No such channel") }
        let b = req.body ?? [:]
        if let v = b.string("name") { c.name = v }
        if let v = b.int("number") { c.number = v }
        if let v = b.int("slotMinutes") { c.slotMinutes = v }
        if let v = b.string("orderingMode"), let om = OrderingMode(rawValue: v) { c.orderingMode = om }
        if let v = b.int("marathonSize") { c.marathonSize = v }
        if b.keys.contains("darkStart") { c.darkStart = b.emptyToNilString("darkStart") }
        if b.keys.contains("darkEnd") { c.darkEnd = b.emptyToNilString("darkEnd") }
        if let v = b.bool("adsEnabled") { c.adsEnabled = v }
        if let v = b.int("maxAdsPerBreak") { c.maxAdsPerBreak = v }
        if let v = b.string("adTags") { c.adTags = v }
        if let v = b.string("timingMode"), let tm = TimingMode(rawValue: v) { c.timingMode = tm }
        if let v = b.int("adsBetween") { c.adsBetween = v }
        if let v = b.int("cooldownDays") { c.cooldownDays = v }
        if let v = b.string("overrunPolicy"), let op = OverrunPolicy(rawValue: v) { c.overrunPolicy = op }
        if let v = b.bool("enabled") { c.enabled = v }
        store.saveChannel(c)
        return .ok()
    }

    private func deleteChannel(_ idStr: String) -> Response {
        guard let id = Int(idStr) else { return .bad("bad id") }
        store.deleteChannel(id)
        return .ok()
    }

    private func addSources(_ idStr: String, _ req: Request) -> Response {
        guard let id = Int(idStr) else { return .bad("bad id") }
        let items = (req.body?["items"] as? [[String: Any]]) ?? []
        for it in items {
            guard let rk = it.string("ratingKey") else { continue }
            store.addSource(id, ratingKey: rk, sourceType: it.string("sourceType") ?? "show",
                            title: it.string("title"))
        }
        return .ok(["ok": true, "added": items.count])
    }

    private func deleteSource(_ idStr: String, _ sidStr: String) -> Response {
        guard let id = Int(idStr), let sid = Int(sidStr) else { return .bad("bad id") }
        store.deleteSource(sid, channelId: id)
        return .ok()
    }

    // MARK: - excludes

    private func getExcludes(_ idStr: String) -> Response {
        guard let id = Int(idStr) else { return .bad("bad id") }
        return .ok(["excludes": Array(store.excludes(id))])
    }
    private func putExcludes(_ idStr: String, _ req: Request) -> Response {
        guard let id = Int(idStr) else { return .bad("bad id") }
        let keys = (req.body?["ratingKeys"] as? [Any])?.compactMap { "\($0)" } ?? []
        store.setExcludes(id, Set(keys))
        return .ok(["ok": true, "excluded": keys.count])
    }

    // MARK: - rules

    private func listRules(_ idStr: String) -> Response {
        guard let id = Int(idStr) else { return .bad("bad id") }
        return .ok(["rules": store.rules(id).map(ruleJSON)])
    }

    private func createRule(_ idStr: String, _ req: Request) -> Response {
        guard let id = Int(idStr) else { return .bad("bad id") }
        let b = req.body ?? [:]
        guard let kindStr = b.string("kind"), let kind = RuleKind(rawValue: kindStr) else {
            return .bad("kind is required")
        }
        let defaults: [RuleKind: Int] = [.blackout: 1000, .pinned: 800, .recurring: 600, .airdate: 400, .rotation: 0]
        let rule = ScheduleRule(
            id: 0, channelId: id, name: b.string("name"), kind: kind,
            priority: b.int("priority") ?? defaults[kind] ?? 0,
            daysOfWeek: b.string("daysOfWeek"), startTime: b.string("startTime"),
            durationMin: b.int("durationMin"), startsAtUtc: b.int("startsAtUtc").map(Int64.init),
            sourceType: b.string("sourceType"), ratingKey: b.string("ratingKey"),
            orderingMode: b.string("orderingMode").flatMap(OrderingMode.init(rawValue:)),
            effectiveFrom: b.string("effectiveFrom"), effectiveTo: b.string("effectiveTo"),
            airdateMode: b.string("airdateMode").flatMap(AirdateMode.init(rawValue:)),
            cadenceCompress: b.double("cadenceCompress") ?? 1)
        return .ok(["id": store.insertRule(rule)])
    }

    private func patchRule(_ idStr: String, _ req: Request) -> Response {
        guard let id = Int(idStr) else { return .bad("bad id") }
        // Rules live per-channel; find the one with this id across channels.
        guard var r = allRules().first(where: { $0.id == id }) else { return .notFound("No such rule") }
        let b = req.body ?? [:]
        if let v = b.string("name") { r.name = v }
        if let v = b.string("kind"), let k = RuleKind(rawValue: v) { r.kind = k }
        if let v = b.int("priority") { r.priority = v }
        if let v = b.bool("enabled") { r.enabled = v }
        if b.keys.contains("daysOfWeek") { r.daysOfWeek = b.emptyToNilString("daysOfWeek") }
        if b.keys.contains("startTime") { r.startTime = b.emptyToNilString("startTime") }
        if b.keys.contains("durationMin") { r.durationMin = b.int("durationMin") }
        if b.keys.contains("startsAtUtc") { r.startsAtUtc = b.int("startsAtUtc").map(Int64.init) }
        if let v = b.string("orderingMode") { r.orderingMode = OrderingMode(rawValue: v) }
        store.saveRule(r)
        return .ok()
    }

    private func deleteRule(_ idStr: String) -> Response {
        guard let id = Int(idStr) else { return .bad("bad id") }
        store.deleteRule(id)
        return .ok()
    }

    private func allRules() -> [ScheduleRule] { store.allChannels().flatMap { store.rules($0.id) } }

    // MARK: - settings

    private func getSettings() -> Response {
        .ok([
            "dvrSlots": store.getInt("dvr_slots", 6),
            "timezone": store.getSetting("timezone") ?? NSNull(),
            "loudnessTarget": Int(store.getSetting("loudness_target") ?? "") ?? -23,
            "displayFill": store.getSetting("display_fill") ?? "fit",
            "captions": store.getInt("captions", 0),
        ])
    }
    private func postSettings(_ req: Request) -> Response {
        let b = req.body ?? [:]
        if let v = b.int("dvrSlots") { store.setSetting("dvr_slots", String(v)) }
        if b.keys.contains("timezone") { store.setSetting("timezone", b.emptyToNilString("timezone")) }
        if let v = b.int("loudnessTarget") { store.setSetting("loudness_target", String(v)) }
        if let v = b.string("displayFill") { store.setSetting("display_fill", v == "fill" ? "fill" : "fit") }
        if let v = b.bool("captions") { store.setSetting("captions", v ? "1" : "0") }
        return .ok()
    }

    // MARK: - config export

    private func exportConfig() -> Response {
        .ok([
            "version": 2,
            "channels": store.allChannels().map(channelJSON),
            "rules": allRules().map(ruleJSON),
        ])
    }

    // MARK: - JSON shapes

    private func channelJSON(_ c: ChannelConfig) -> [String: Any] {
        [
            "id": c.id, "number": c.number, "name": c.name, "slotMinutes": c.slotMinutes,
            "orderingMode": c.orderingMode.rawValue, "marathonSize": c.marathonSize,
            "darkStart": c.darkStart ?? NSNull(), "darkEnd": c.darkEnd ?? NSNull(),
            "adsEnabled": c.adsEnabled, "maxAdsPerBreak": c.maxAdsPerBreak, "adTags": c.adTags,
            "timingMode": c.timingMode.rawValue, "adsBetween": c.adsBetween,
            "cooldownDays": c.cooldownDays, "overrunPolicy": c.overrunPolicy.rawValue,
            "enabled": c.enabled,
            "sources": store.sources(c.id).map { s -> [String: Any] in
                ["id": s.id, "ratingKey": s.ratingKey, "sourceType": s.sourceType,
                 "title": s.title ?? NSNull()]
            },
        ]
    }

    private func ruleJSON(_ r: ScheduleRule) -> [String: Any] {
        [
            "id": r.id, "channelId": r.channelId, "name": r.name ?? NSNull(),
            "kind": r.kind.rawValue, "priority": r.priority, "enabled": r.enabled,
            "daysOfWeek": r.daysOfWeek ?? NSNull(), "startTime": r.startTime ?? NSNull(),
            "durationMin": r.durationMin ?? NSNull(), "startsAtUtc": r.startsAtUtc ?? NSNull(),
            "sourceType": r.sourceType ?? NSNull(), "ratingKey": r.ratingKey ?? NSNull(),
            "orderingMode": r.orderingMode?.rawValue ?? NSNull(),
            "airdateMode": r.airdateMode?.rawValue ?? NSNull(),
        ]
    }
}

/// Loose JSON-object accessors for request bodies parsed via JSONSerialization.
extension Dictionary where Key == String, Value == Any {
    func string(_ k: String) -> String? { self[k] as? String }
    func int(_ k: String) -> Int? {
        if let i = self[k] as? Int { return i }
        if let n = self[k] as? NSNumber { return n.intValue }
        if let s = self[k] as? String { return Int(s) }
        return nil
    }
    func double(_ k: String) -> Double? {
        if let d = self[k] as? Double { return d }
        if let n = self[k] as? NSNumber { return n.doubleValue }
        return nil
    }
    func bool(_ k: String) -> Bool? {
        if let b = self[k] as? Bool { return b }
        if let n = self[k] as? NSNumber { return n.boolValue }
        return nil
    }
    /// For nullable text fields: "" or null → nil, otherwise the string.
    func emptyToNilString(_ k: String) -> String? {
        guard let s = self[k] as? String, !s.isEmpty else { return nil }
        return s
    }
}
