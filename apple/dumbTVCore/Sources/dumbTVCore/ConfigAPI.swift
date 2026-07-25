import Foundation

/// A pure request → response router for the config API, implementing the
/// Store-backed slice of `docs/api-contract.md`. No networking here: the app's
/// embedded HTTP server parses the wire and calls `handle`, so this stays
/// headless-testable. Plex-link / library / guide endpoints (async, or engine-
/// backed) are layered on separately.
public final class ConfigAPI {
    let store: Store
    let plex: PlexClient
    public init(store: Store, plex: PlexClient = PlexClient()) {
        self.store = store
        self.plex = plex
    }

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
    public func handle(_ req: Request) async -> Response {
        let parts = req.path.split(separator: "/").map(String.init)  // ["api","channels","3"]
        guard parts.first == "api" else { return .notFound() }
        let s = Array(parts.dropFirst())
        let m = req.method.uppercased()

        switch (m, s.count) {
        // --- config CRUD (Store-backed, synchronous) ---
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

        case ("POST", 3) where s[0] == "channels" && s[2] == "sources":  return await addSources(s[1], req)
        case ("GET", 3) where s[0] == "channels" && s[2] == "excludes":  return getExcludes(s[1])
        case ("PUT", 3) where s[0] == "channels" && s[2] == "excludes":  return putExcludes(s[1], req)
        case ("GET", 3) where s[0] == "channels" && s[2] == "rules":     return listRules(s[1])
        case ("POST", 3) where s[0] == "channels" && s[2] == "rules":    return createRule(s[1], req)

        case ("DELETE", 4) where s[0] == "channels" && s[2] == "sources": return deleteSource(s[1], s[3])

        // --- Plex link (async network) ---
        case ("POST", 2) where s[0] == "plex" && s[1] == "pin":     return await plexCreatePin()
        case ("GET", 3) where s[0] == "plex" && s[1] == "pin":      return await plexCheckPin(s[2])
        case ("GET", 2) where s[0] == "plex" && s[1] == "servers":  return await plexServers()
        case ("POST", 2) where s[0] == "plex" && s[1] == "server":  return await plexSaveServer(req)
        case ("POST", 2) where s[0] == "plex" && s[1] == "logout":  return plexLogout()

        // --- schedule (deterministic; regen/ensure are no-ops on Apple) ---
        case ("POST", 2) where s[0] == "schedule" && s[1] == "regenerate": return .ok()
        case ("POST", 2) where s[0] == "schedule" && s[1] == "ensure":     return .ok()
        case ("GET", 2) where s[0] == "schedule" && s[1] == "calendar":    return scheduleCalendar(req)

        // --- library browse (async network) ---
        case ("GET", 2) where s[0] == "library" && s[1] == "sections": return await librarySections()
        case ("GET", 4) where s[0] == "library" && s[1] == "sections" && s[3] == "items":
            return await librarySectionItems(s[2], req)
        case ("GET", 4) where s[0] == "library" && s[1] == "show" && s[3] == "episodes":
            return await libraryEpisodes(s[2], req)

        // --- stubs so the shared web UI degrades gracefully (features not yet
        //     ported on Apple: auth PIN, Jellyfin, LLM, assets, guide/on-air) ---
        case ("GET", 2) where s[0] == "auth" && s[1] == "status":     return .ok(["configured": false, "authed": true])
        case ("GET", 2) where s[0] == "jellyfin" && s[1] == "status": return .ok(["configured": false, "active": false, "server": NSNull()])
        case ("GET", 2) where s[0] == "llm" && s[1] == "status":      return .ok(["configured": false, "model": NSNull()])
        case ("GET", 1) where s[0] == "assets":                       return .ok(["assets": []])
        case ("GET", 1) where s[0] == "onair":                        return onair()
        case ("GET", 1) where s[0] == "guide":                        return guide(req)

        default: return .notFound("No route for \(m) \(req.path)")
        }
    }

    private func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    // MARK: - status

    private func status() -> Response {
        // The web UI reads `server` to advance past server-pick to library browse
        // (and to show the unlink button). Mirror the Node shape.
        var server: Any = NSNull()
        if let uri = store.getSetting("plex_server_uri") {
            server = ["name": store.getSetting("plex_server_name") ?? "Plex", "uri": uri, "local": false]
        }
        return .ok([
            "backend": "plex",
            "linked": store.getSetting("plex_token") != nil,
            "server": server,
            "reachable": NSNull(),
            "counts": ["channels": store.allChannels().count, "assets": store.assets().count],
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

    private func addSources(_ idStr: String, _ req: Request) async -> Response {
        guard let id = Int(idStr) else { return .bad("bad id") }
        await ensurePlexConfigured()
        let items = (req.body?["items"] as? [[String: Any]]) ?? []
        for it in items {
            guard let rk = it.string("ratingKey") else { continue }
            let type = it.string("sourceType") ?? "show"
            store.addSource(id, ratingKey: rk, sourceType: type, title: it.string("title"))
            // Cache the show's episodes now so the channel has content to schedule.
            if type == "show", let eps = try? await plex.episodes(showKey: rk) {
                store.upsertMedia(eps)
            }
        }
        return .ok(["ok": true, "added": items.count])
    }

    /// What's on every enabled channel right now — generated deterministically
    /// from the Store (the generator is seeded, so this matches the player).
    /// Shape matches the web UI's ON AIR strip: { channel:{id,number,name}, now }.
    private func onair() -> Response {
        let now = nowMs()
        let channels: [[String: Any]] = store.allChannels().filter { $0.enabled }.map { c in
            var nowObj: Any = NSNull()
            let buckets = store.library(forChannel: c.id).sourceBuckets()
            if !buckets.isEmpty {
                let programs = Generator.generate(channel: c.spec, buckets: buckets, now: now, windowMs: 24 * 3_600_000)
                if let a = Resolver.nowOn(programs, at: now) {
                    nowObj = ["title": a.program.title, "subtitle": a.program.subtitle ?? NSNull(),
                              "progress": a.progress]
                }
            }
            return ["channel": ["id": c.id, "number": c.number, "name": c.name], "now": nowObj]
        }
        return .ok(["at": now, "channels": channels])
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

    /// The listings grid: every channel's programs over the next `hours`,
    /// generated deterministically from the Store. Matches the web guide shape:
    /// { channels: [{ number, name, programs: [{startUtc,endUtc,title,…}] }] }.
    private func guide(_ req: Request) -> Response {
        let from = req.query["from"].flatMap { Int64($0) } ?? nowMs()
        let hours = min(12, max(1, req.query["hours"].flatMap { Int($0) } ?? 3))
        let window = Int64(hours) * 3_600_000
        let genWindow = window + 6 * 3_600_000     // extra so edge-spanning blocks appear
        let channels: [[String: Any]] = store.allChannels().filter { $0.enabled }.map { c in
            let buckets = store.library(forChannel: c.id).sourceBuckets()
            let programs = buckets.isEmpty ? []
                : Generator.generate(channel: c.spec, buckets: buckets, now: from, windowMs: genWindow)
            let inRange = programs.filter {
                $0.endUtc > from && $0.startUtc < from + window &&
                ($0.kind == .episode || $0.kind == .movie || $0.kind == .offair)
            }
            return ["number": c.number, "name": c.name,
                    "programs": inRange.map { p -> [String: Any] in
                        ["startUtc": p.startUtc, "endUtc": p.endUtc, "title": p.title, "kind": p.kind.rawValue,
                         "subtitle": p.subtitle ?? NSNull(), "seasonNo": p.seasonNo ?? NSNull(),
                         "episodeNo": p.episodeNo ?? NSNull()]
                    }]
        }
        return .ok(["from": from, "hours": hours, "channels": channels])
    }

    /// A channel's real program blocks over a day range — for the calendar view.
    /// Generated from the Store (deterministic), matching the Node shape.
    private func scheduleCalendar(_ req: Request) -> Response {
        guard let cid = req.query["channel"].flatMap({ Int($0) }), let c = store.channel(cid) else {
            return .ok(["programs": []])
        }
        let from = req.query["from"].flatMap { Int64($0) } ?? nowMs()
        let days = min(14, max(1, req.query["days"].flatMap { Int($0) } ?? 7))
        let window = Int64(days) * 24 * 3_600_000
        let to = from + window
        let buckets = store.library(forChannel: cid).sourceBuckets()
        let programs = buckets.isEmpty ? []
            : Generator.generate(channel: c.spec, buckets: buckets, now: from, windowMs: window)
        let inRange = programs.filter {
            $0.endUtc > from && $0.startUtc < to && ($0.kind == .episode || $0.kind == .movie)
        }
        return .ok([
            "from": from, "to": to,
            "programs": inRange.map { p -> [String: Any] in
                ["startUtc": p.startUtc, "endUtc": p.endUtc, "kind": p.kind.rawValue, "title": p.title,
                 "subtitle": p.subtitle ?? NSNull(), "seasonNo": p.seasonNo ?? NSNull(),
                 "episodeNo": p.episodeNo ?? NSNull(), "ratingKey": p.ratingKey ?? NSNull(),
                 "isPremiere": p.airingNo == 1]
            },
        ])
    }

    // MARK: - Plex link (async)

    /// Push the persisted token/server into the actor before a library call.
    private func ensurePlexConfigured() async {
        await plex.configure(token: store.getSetting("plex_token"),
                             serverURI: store.getSetting("plex_server_uri"),
                             accessToken: store.getSetting("plex_access_token"))
    }

    private func plexCreatePin() async -> Response {
        do {
            let pin = try await plex.createPin()
            return .ok(["id": pin.id, "code": pin.code])
        } catch { return Response(502, ["error": "plex.tv: \(error.localizedDescription)"]) }
    }

    private func plexCheckPin(_ idStr: String) async -> Response {
        guard let id = Int(idStr) else { return .bad("bad pin id") }
        do {
            guard let token = try await plex.checkPin(id: id) else { return .ok(["linked": false]) }
            store.setSetting("plex_token", token)
            let servers = try await plex.listServers(token: token)
            return .ok(["linked": true, "servers": servers.map(serverJSON)])
        } catch { return Response(502, ["error": "Couldn't reach your Plex server: \(error.localizedDescription)"]) }
    }

    private func plexServers() async -> Response {
        guard let token = store.getSetting("plex_token") else { return .bad("Not linked to Plex yet") }
        do { return .ok(["servers": try await plex.listServers(token: token).map(serverJSON)]) }
        catch { return Response(502, ["error": error.localizedDescription]) }
    }

    private func plexSaveServer(_ req: Request) async -> Response {
        let b = req.body ?? [:]
        guard let access = b.string("accessToken") else { return .bad("Need a server accessToken") }
        let conns = b["connections"] as? [[String: Any]] ?? []
        // Pick a connection that actually responds (local → WAN → relay). This is
        // the fix for "can't connect": the local address is often unreachable from
        // this machine even though the WAN/plex.direct one works.
        let uri = await firstReachable(conns, token: access) ?? b.string("uri") ?? bestURI(from: conns)
        guard let uri else { return .bad("No usable server address for that server") }
        store.setSetting("plex_server_uri", uri)
        store.setSetting("plex_access_token", access)
        store.setSetting("plex_server_name", b.string("name"))
        await plex.configure(token: store.getSetting("plex_token"), serverURI: uri, accessToken: access)
        return .ok()
    }

    private func plexLogout() -> Response {
        for k in ["plex_token", "plex_server_uri", "plex_access_token", "plex_server_name"] { store.setSetting(k, nil) }
        return .ok()
    }

    /// local → non-relay WAN → relay, mirroring PlexServer.preferredURI.
    private func bestURI(from conns: [[String: Any]]?) -> String? {
        guard let conns else { return nil }
        return ordered(conns).first?["uri"] as? String
    }
    private func ordered(_ conns: [[String: Any]]) -> [[String: Any]] {
        func score(_ c: [String: Any]) -> Int {
            if (c["relay"] as? Bool) == true { return 2 }
            return (c["local"] as? Bool) == true ? 0 : 1
        }
        return conns.filter { ($0["uri"] as? String)?.isEmpty == false }.sorted { score($0) < score($1) }
    }

    /// The first connection that answers, in preference order. Probes /identity.
    private func firstReachable(_ conns: [[String: Any]], token: String) async -> String? {
        for c in ordered(conns) {
            guard let uri = c["uri"] as? String, let url = URL(string: "\(uri)/identity?X-Plex-Token=\(token)")
            else { continue }
            var r = URLRequest(url: url); r.timeoutInterval = 4
            if let (_, resp) = try? await URLSession.shared.data(for: r),
               let code = (resp as? HTTPURLResponse)?.statusCode, (200..<400).contains(code) {
                return uri
            }
        }
        return nil
    }

    // MARK: - library browse (async)

    private func librarySections() async -> Response {
        await ensurePlexConfigured()
        do {
            let secs = try await plex.sections()
            return .ok(["sections": secs.map { ["key": $0.key, "title": $0.title, "type": $0.type] }])
        } catch { return Response(502, ["error": "Couldn't reach your Plex server: \(error.localizedDescription)"]) }
    }

    private func librarySectionItems(_ key: String, _ req: Request) async -> Response {
        await ensurePlexConfigured()
        let type = req.query["type"] ?? "show"
        do {
            let items = try await plex.sectionItems(key: key, type: type)
            return .ok(["items": items.map { i -> [String: Any] in
                ["ratingKey": i.ratingKey, "title": i.title, "type": i.type, "thumb": i.thumb ?? NSNull()]
            }])
        } catch { return Response(502, ["error": "Couldn't reach your Plex server: \(error.localizedDescription)"]) }
    }

    private func libraryEpisodes(_ showKey: String, _ req: Request) async -> Response {
        await ensurePlexConfigured()
        do {
            var rows = store.media(forSource: showKey).filter { $0.durationMs > 0 }
            if rows.isEmpty {   // first look — pull from Plex once and cache
                let eps = try await plex.episodes(showKey: showKey)
                store.upsertMedia(eps)
                rows = eps
            }
            let excluded = req.query["channel"].flatMap { Int($0) }.map { store.excludes($0) } ?? []
            let sorted = rows.sorted { ($0.seasonNo ?? 0, $0.episodeNo ?? 0) < ($1.seasonNo ?? 0, $1.episodeNo ?? 0) }
            return .ok(["episodes": sorted.map { m -> [String: Any] in
                ["ratingKey": m.ratingKey, "title": m.title, "showTitle": m.showTitle ?? NSNull(),
                 "seasonNo": m.seasonNo ?? NSNull(), "episodeNo": m.episodeNo ?? NSNull(),
                 "aired": m.aired ?? NSNull(), "durationMs": m.durationMs,
                 "excluded": excluded.contains(m.ratingKey)]
            }])
        } catch { return Response(502, ["error": "Couldn't reach your Plex server: \(error.localizedDescription)"]) }
    }

    private func serverJSON(_ s: PlexServer) -> [String: Any] {
        let conns: [[String: Any]] = s.connections.map { ["uri": $0.uri, "local": $0.local, "relay": $0.relay] }
        return ["name": s.name, "clientIdentifier": s.clientIdentifier, "accessToken": s.accessToken,
                "uri": s.preferredURI.map { $0 as Any } ?? NSNull(), "connections": conns]
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
