import Foundation

/// A pure request → response router for the config API, implementing the
/// Store-backed slice of `docs/api-contract.md`. No networking here: the app's
/// embedded HTTP server parses the wire and calls `handle`, so this stays
/// headless-testable. Plex-link / library / guide endpoints (async, or engine-
/// backed) are layered on separately.
public final class ConfigAPI {
    let store: Store
    let plex: PlexClient
    let packProgress = PackProgressBox()   // Track I pack-install progress (thread-safe)
    let imageCache = ImageCache()          // A4: poster cache so the picker isn't glacial
    public init(store: Store, plex: PlexClient = PlexClient()) {
        self.store = store
        self.plex = plex
    }

    public struct Request {
        public let method: String                 // GET / POST / PATCH / DELETE
        public let path: String                   // "/api/channels/3"
        public let query: [String: String]
        public let body: [String: Any]?           // parsed JSON object, if any
        public let cookie: String?                // raw Cookie header (PIN session)
        public init(method: String, path: String, query: [String: String] = [:],
                    body: [String: Any]? = nil, cookie: String? = nil) {
            self.method = method; self.path = path; self.query = query
            self.body = body; self.cookie = cookie
        }
    }

    public struct Response {
        public let status: Int
        public let json: Any                       // JSON-serialisable (Dictionary/Array/scalar)
        public let setCookie: String?              // Set-Cookie header, when logging in
        public init(_ status: Int, _ json: Any, setCookie: String? = nil) {
            self.status = status; self.json = json; self.setCookie = setCookie
        }
        static func ok(_ j: Any = ["ok": true]) -> Response { Response(200, j) }
        static func bad(_ msg: String) -> Response { Response(400, ["error": msg]) }
        static func notFound(_ msg: String = "Not found") -> Response { Response(404, ["error": msg]) }
    }

    /// Route a request, then broadcast a change notification for successful
    /// mutations so the running player rebuilds its lineup without a restart
    /// (the web UI and the TV share one Store in one process).
    public func handle(_ req: Request) async -> Response {
        let isMutation = req.method.uppercased() != "GET"
        // The household PIN gates mutations (channel edits, rules, settings,
        // player control). Reads and the auth endpoints themselves stay open —
        // the TV never asks for a PIN.
        if isMutation, Auth.isConfigured(store), !req.path.hasPrefix("/api/auth/"),
           !Auth.tokenValid(store, token: Auth.cookieToken(req.cookie)) {
            return Response(401, ["error": "Locked — enter the PIN in Settings to make changes."])
        }
        let resp = await route(req)
        // A successful config change rebuilds the affected channel's FUTURE
        // schedule (append-only — what's airing is untouched), so added shows /
        // edits show up without a restart.
        if resp.status < 400 && isMutation { regenerateForMutation(req) }
        let linkedViaPin = !isMutation
            && req.path.hasPrefix("/api/plex/pin/")
            && (resp.json as? [String: Any])?["linked"] as? Bool == true
        if resp.status < 400 && (isMutation || linkedViaPin) {
            NotificationCenter.default.post(name: .dumbTVConfigChanged, object: nil)
        }
        return resp
    }

    /// After a mutation, rebuild the future of whatever it touched. Channel- and
    /// rule-scoped edits rebuild that one channel; broader changes (new channel,
    /// settings, Plex, import) rebuild them all. Deterministic + append-only, so
    /// this is cheap and never disturbs the currently-airing program.
    private func regenerateForMutation(_ req: Request) {
        let now = nowMs()
        let s = Array(req.path.split(separator: "/").map(String.init).dropFirst())  // drop "api"
        // Visibility-only mutations don't change any schedule — just let the
        // player reload (the notification still fires) so the filter re-applies.
        if s.first == "kids-mode" || (s.count == 3 && s[0] == "channels" && s[2] == "kid-safe") { return }
        if s.first == "auth" { return }
        if s.count >= 2, s[0] == "channels", let id = Int(s[1]) {
            Scheduler.regenerate(store: store, channelId: id, now: now)
        } else if s.count >= 2, s[0] == "rules", let rid = Int(s[1]),
                  let ch = store.allChannels().first(where: { store.rules($0.id).contains { $0.id == rid } }) {
            Scheduler.regenerate(store: store, channelId: ch.id, now: now)
        } else {
            Scheduler.regenerateAll(store: store, now: now)
        }
    }

    /// The actual router. Returns 404 for anything unmatched. Swift can't bind
    /// inside array-literal patterns, so we switch on (method, segment-count)
    /// and read the path segments explicitly.
    private func route(_ req: Request) async -> Response {
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

        // --- content packs (Track I) ---
        case ("GET", 1) where s[0] == "packs":                       return packsList()
        case ("POST", 3) where s[0] == "packs" && s[2] == "install": return await packInstall(s[1])
        case ("POST", 3) where s[0] == "packs" && s[2] == "channel": return packCreateChannel(s[1], req)
        case ("DELETE", 2) where s[0] == "packs":                    return packDelete(s[1])

        case ("POST", 3) where s[0] == "channels" && s[2] == "sources":  return await addSources(s[1], req)
        case ("POST", 3) where s[0] == "channels" && s[2] == "refresh":  return await refreshChannel(s[1])
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

        // --- household PIN (gates mutations; the TV never asks) ---
        case ("GET", 2) where s[0] == "auth" && s[1] == "status":
            return .ok(["configured": Auth.isConfigured(store),
                        "authed": !Auth.isConfigured(store)
                            || Auth.tokenValid(store, token: Auth.cookieToken(req.cookie))])
        case ("POST", 2) where s[0] == "auth" && s[1] == "setup":  return authSetup(req)
        case ("POST", 2) where s[0] == "auth" && s[1] == "login":  return authLogin(req)
        case ("POST", 2) where s[0] == "auth" && s[1] == "logout":
            Auth.logout(store); return .ok()

        // --- player (the native TV) ---
        case ("GET", 1) where s[0] == "player":                    return playerState()
        case ("POST", 2) where s[0] == "player" && s[1] == "tune": return playerTune(req)

        // --- Kids Mode (parental control; PIN-gated like any mutation) ---
        case ("POST", 1) where s[0] == "kids-mode":                          return setKidsMode(req)
        case ("POST", 3) where s[0] == "channels" && s[2] == "kid-safe":     return setKidSafe(s[1], req)

        // --- schedule dry-run for the rule editor ---
        case ("GET", 3) where s[0] == "channels" && s[2] == "preview": return preview(s[1], req)

        // --- commercials (Plex-imported; no local folder on Apple) ---
        case ("GET", 1) where s[0] == "assets":                       return listAssets()
        case ("DELETE", 2) where s[0] == "assets":                    return deleteAsset(s[1])
        case ("POST", 2) where s[0] == "assets" && s[1] == "import-plex":  return await importPlexAds(req)
        case ("POST", 2) where s[0] == "assets" && s[1] == "refresh-plex": return await refreshPlexAds()

        // --- stubs so the shared web UI degrades gracefully (features not on
        //     Apple: Jellyfin backend, LLM suggestions) ---
        case ("GET", 2) where s[0] == "jellyfin" && s[1] == "status": return .ok(["configured": false, "active": false, "server": NSNull()])
        case ("GET", 2) where s[0] == "llm" && s[1] == "status":      return .ok(["configured": false, "model": NSNull()])
        case ("GET", 1) where s[0] == "onair":                        return onair()
        case ("GET", 1) where s[0] == "guide":                        return guide(req)

        default: return .notFound("No route for \(m) \(req.path)")
        }
    }

    /// Proxy a Plex image (poster) for the web UI. Returns bytes + content type,
    /// or nil. The server serves this at `/api/image?path=…` so the browser
    /// never handles the Plex token.
    /// Poster proxy (A4). Fetched OFF the PlexClient actor — read the credentials
    /// straight from the Store and hit Plex with URLSession directly, so N
    /// posters load in PARALLEL and don't queue behind the library browse. Cached
    /// so a re-render is free.
    public func fetchImage(path: String) async -> (Data, String)? {
        if let cached = imageCache.get(path) { return (cached, "image/jpeg") }
        guard let uri = store.getSetting("plex_server_uri"),
              let token = store.getSetting("plex_access_token"),
              let url = URL(string: "\(uri)\(path)?X-Plex-Token=\(token)") else { return nil }
        guard let (data, _) = try? await URLSession.shared.data(from: url), !data.isEmpty else { return nil }
        imageCache.set(path, data)
        return (data, "image/jpeg")
    }

    private func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    static func orderingLabel(_ m: OrderingMode) -> String {
        switch m {
        case .sequential:    return "In order"
        case .release_order: return "By air date"
        case .shuffle:       return "Shuffle"
        case .marathon:      return "Marathon"
        }
    }
    static func orderingBlurb(_ m: OrderingMode) -> String {
        switch m {
        case .sequential:    return "Plays each show's episodes in order, rotating between the shows on this channel."
        case .release_order: return "Every episode interleaved by its original air date."
        case .shuffle:       return "Randomized — but deterministic, so the printed guide stays true."
        case .marathon:      return "Plays several in a row from one show before moving to the next."
        }
    }

    // MARK: - status

    /// D3: the on-TV setup card retires once the web config UI has actually been
    /// opened. This used to fire from `/api/status`, which ANY caller can hit —
    /// a port scan, a health check, or the app's own probe could silently retire
    /// the card before a human ever saw the page (N7). The signal is now the
    /// config page itself being served to a browser; the embedded server calls
    /// this from its static-asset handler.
    public func markConfigPageOpened() {
        if store.getSetting("setup_seen") == nil { store.setSetting("setup_seen", "1") }
    }

    private func status() -> Response {
        // The web UI reads `server` to advance past server-pick to library browse
        // (and to show the unlink button). Mirror the Node shape.
        var server: Any = NSNull()
        let hasServer = store.getSetting("plex_server_uri") != nil
        if let uri = store.getSetting("plex_server_uri") {
            server = ["name": store.getSetting("plex_server_name") ?? "Plex", "uri": uri, "local": false]
        }
        var player: Any = NSNull()
        if let idStr = store.getSetting("player_channel_id"), let id = Int(idStr), let c = store.channel(id) {
            player = ["driver": "native", "channel": ["id": c.id, "number": c.number, "name": c.name]]
        } else {
            player = ["driver": "native", "channel": NSNull()]
        }
        return .ok([
            "backend": "plex",
            "native": true,          // this is a native app; the TV is the app window, not /tv
            "player": player,
            "linked": store.getSetting("plex_token") != nil,
            "kidsMode": kidsModeOn,
            "kidSafeCount": kidSafeIds().count,
            "server": server,
            // We only keep a server whose connection responded at link time
            // (firstReachable), so a configured server is reachable-until-proven-
            // otherwise — the picture stands by if a stream later fails.
            "reachable": hasServer ? true : NSNull(),
            "counts": ["channels": store.allChannels().count, "assets": store.assets().count],
            // {id,label,blurb} — the web UI renders the ORDER dropdown + its
            // helper text from this (raw strings showed "undefined").
            "orderingModes": OrderingMode.allCases.map { m -> [String: Any] in
                ["id": m.rawValue, "label": Self.orderingLabel(m), "blurb": Self.orderingBlurb(m)]
            },
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
            number: store.freeChannelNumber(preferred: b.int("number")),   // N2: never collide
            name: b.string("name") ?? "New Channel",
            slotMinutes: b.int("slotMinutes") ?? 30,
            orderingMode: OrderingMode(rawValue: b.string("orderingMode") ?? "") ?? .sequential,
            marathonSize: b.int("marathonSize") ?? 3,
            shuffleSeed: UInt32.random(in: 1...UInt32.max),
            darkStart: b.string("darkStart"), darkEnd: b.string("darkEnd"),
            adsEnabled: b.bool("adsEnabled") ?? false,   // ads OFF by default
            maxAdsPerBreak: b.int("maxAdsPerBreak") ?? 10,
            adTags: b.string("adTags") ?? "")
        let id = store.insertChannel(c)
        guard id > 0 else { return .bad("couldn't create channel") }   // N2: id 0 = failure, not success
        return .ok(["id": id, "number": c.number])
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
        var results: [[String: Any]] = []
        for it in items {
            guard let rk = it.string("ratingKey") else { continue }
            let type = it.string("sourceType") ?? "show"
            let title = it.string("title")
            store.addSource(id, ratingKey: rk, sourceType: type, title: title,
                            thumb: it.string("thumb"))
            // Pack + local sources already have their media — nothing to fetch (C3).
            if type == "pack" || type == "local" {
                results.append(["title": title ?? "", "cached": store.media(forSource: rk).count])
            } else {
                results.append(await cacheSource(rk, type: type, title: title))
            }
        }
        // The web UI does r.results.reduce(...) — must be an array of {title,cached,error?}.
        return .ok(["ok": true, "results": results])
    }

    /// Re-read a channel's sources from Plex (the "refresh" button).
    private func refreshChannel(_ idStr: String) async -> Response {
        guard let id = Int(idStr) else { return .bad("bad id") }
        await ensurePlexConfigured()
        var results: [[String: Any]] = []
        for s in store.sources(id) {
            results.append(await cacheSource(s.ratingKey, type: s.sourceType, title: s.title))
        }
        return .ok(["ok": true, "results": results])
    }

    /// Pull a source's playable media into the cache; returns {title,cached,error?}.
    private func cacheSource(_ ratingKey: String, type: String, title: String?) async -> [String: Any] {
        var cached = 0
        var errorMsg: String?
        if type == "show" {
            do {
                let eps = try await plex.episodes(showKey: ratingKey)
                store.upsertMedia(eps)
                cached = eps.count
            } catch { errorMsg = error.localizedDescription }
        } else {
            // Movies: one metadata fetch for the part key + duration. Before
            // this, movie sources silently cached 0 and the channel sat at
            // "no programming" with no error — the worst kind of quiet.
            do {
                if let m = try await plex.movie(ratingKey: ratingKey) {
                    store.upsertMedia([m])
                    cached = 1
                } else {
                    errorMsg = "No playable file found for this movie"
                }
            } catch { errorMsg = error.localizedDescription }
        }
        // Backfill channel art for sources that predate the thumb column —
        // one metadata fetch, only when the source has no thumb yet.
        if let thumb = (try? await plex.thumbPath(ratingKey: ratingKey)) ?? nil {
            store.fillSourceThumb(ratingKey, thumb: thumb)
        }
        var r: [String: Any] = ["title": title ?? ratingKey, "cached": cached]
        if let errorMsg { r["error"] = errorMsg }
        return r
    }

    /// What's on every enabled channel right now — generated deterministically
    /// from the Store (the generator is seeded, so this matches the player).
    /// Shape matches the web UI's ON AIR strip: { channel:{id,number,name}, now }.
    private func onair() -> Response {
        let now = nowMs()
        let channels: [[String: Any]] = store.allChannels().filter { $0.enabled }.map { c in
            Scheduler.ensureCoverage(store: store, channelId: c.id, now: now)  // JIT for brand-new channels
            var nowObj: Any = NSNull()
            if let a = Resolver.nowOn(store.programs(c.id, from: now - HOUR, to: now + DAY), at: now) {
                let p = a.program
                nowObj = ["title": p.title, "subtitle": p.subtitle ?? NSNull(),
                          "progress": a.progress, "kind": p.kind.rawValue,
                          "startUtc": p.startUtc, "endUtc": p.endUtc,
                          "offsetMs": a.offsetMs, "durationMs": p.durationMs,
                          "seasonNo": p.seasonNo ?? NSNull(), "episodeNo": p.episodeNo ?? NSNull()]
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
            // What the schedule actually anchors to right now (the web UI shows
            // "Active: …" — previously undefined on Apple).
            "activeTimezone": store.getSetting("timezone") ?? TimeZone.current.identifier,
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
        let channels: [[String: Any]] = store.allChannels().filter { $0.enabled }.map { c in
            Scheduler.ensureCoverage(store: store, channelId: c.id, now: from)
            let inRange = store.programs(c.id, from: from, to: from + window).filter {
                $0.kind == .episode || $0.kind == .movie || $0.kind == .offair
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
        _ = c   // channel existence already validated above
        Scheduler.ensureCoverage(store: store, channelId: cid, now: from)
        let inRange = store.programs(cid, from: from, to: to).filter {
            $0.kind == .episode || $0.kind == .movie
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

    // MARK: - auth (household PIN)

    private func authSetup(_ req: Request) -> Response {
        guard let pin = req.body?.string("pin"), pin.range(of: #"^\d{4,6}$"#, options: .regularExpression) != nil else {
            return .bad("PIN must be 4–6 digits")
        }
        // Changing an existing PIN requires being unlocked (the mutation gate in
        // handle() already enforces that), so just set it.
        Auth.setPin(store, pin: pin)
        return Response(200, ["ok": true], setCookie: Auth.sessionCookieHeader(store))
    }

    private func authLogin(_ req: Request) -> Response {
        guard let pin = req.body?.string("pin") else { return .bad("PIN required") }
        guard Auth.verifyPin(store, pin: pin) else { return Response(403, ["error": "Wrong PIN"]) }
        return Response(200, ["ok": true], setCookie: Auth.sessionCookieHeader(store))
    }

    // MARK: - Kids Mode (parental control)

    /// The set of channel ids a parent has marked kid-safe (a settings CSV, so
    /// no schema churn).
    private func kidSafeIds() -> Set<Int> {
        Set((store.getSetting("kids_safe_channels") ?? "").split(separator: ",").compactMap { Int($0) })
    }
    private var kidsModeOn: Bool { store.getSetting("kids_mode") == "1" }

    private func setKidsMode(_ req: Request) -> Response {
        let on = req.body?.bool("on") ?? false
        // Turning it on with nothing marked would blank the TV — refuse and say so.
        if on && kidSafeIds().isEmpty {
            return .bad("Mark at least one channel kid-safe before turning on Kids Mode.")
        }
        store.setSetting("kids_mode", on ? "1" : nil)
        return .ok(["kidsMode": on])
    }

    private func setKidSafe(_ idStr: String, _ req: Request) -> Response {
        guard let id = Int(idStr), store.channel(id) != nil else { return .notFound("No such channel") }
        var ids = kidSafeIds()
        if req.body?.bool("on") ?? false { ids.insert(id) } else { ids.remove(id) }
        store.setSetting("kids_safe_channels", ids.isEmpty ? nil : ids.sorted().map(String.init).joined(separator: ","))
        // If the parent just un-marked the last kid channel, drop out of Kids Mode
        // rather than leave the TV with nothing to show.
        if ids.isEmpty { store.setSetting("kids_mode", nil) }
        return .ok(["kidSafe": ids.contains(id)])
    }

    // MARK: - player (native TV)

    private func playerState() -> Response {
        var channel: Any = NSNull()
        if let idStr = store.getSetting("player_channel_id"), let id = Int(idStr),
           let c = store.channel(id) {
            channel = ["id": c.id, "number": c.number, "name": c.name]
        }
        return .ok(["driver": "native", "channel": channel])
    }

    /// The web UI's Watch button / ON AIR strip tap. The engine observes the
    /// notification and changes the channel on the actual TV.
    private func playerTune(_ req: Request) -> Response {
        var id = req.body?.int("channelId")
        if id == nil, let n = req.body?.int("number") {
            id = store.allChannels().first { $0.number == n }?.id
        }
        guard let id, store.channel(id) != nil else { return .notFound("No such channel") }
        NotificationCenter.default.post(name: .dumbTVTuneRequested, object: nil,
                                        userInfo: ["channelId": id])
        return .ok(["ok": true, "channelId": id])
    }

    // MARK: - schedule preview (dry run for the rule editor)

    private func preview(_ idStr: String, _ req: Request) -> Response {
        guard let id = Int(idStr), let c = store.channel(id) else { return .notFound("No such channel") }
        let days = min(30, max(1, req.query["days"].flatMap { Int($0) } ?? 7))
        let from = nowMs()
        let until = from + Millis(days) * DAY
        let built = RuleScheduler.buildChannelPrograms(
            channel: c, rules: Scheduler.effectiveRules(c, store.rules(c.id)),
            library: store.library(forChannel: c.id), airings: store.airings(c.id),
            from: from, until: until, clock: .device)
        return .ok([
            "from": from, "until": until,
            "conflicts": built.conflicts.map { ["rule": $0.rule, "at": $0.at, "lostTo": $0.lostTo] },
            "programs": built.rows.map { p -> [String: Any] in
                ["startUtc": p.startUtc, "endUtc": p.endUtc, "kind": p.kind.rawValue,
                 "title": p.title, "subtitle": p.subtitle ?? NSNull(),
                 "ruleId": p.ruleId ?? NSNull()]
            },
        ])
    }

    // MARK: - commercials (assets)

    private func listAssets() -> Response {
        .ok(["assets": store.assets().map { a -> [String: Any] in
            ["id": a.id, "title": a.title, "kind": a.kind, "durationMs": a.durationMs,
             "tags": a.tags, "path": a.path]
        }])
    }

    private func deleteAsset(_ idStr: String) -> Response {
        guard let id = Int(idStr) else { return .bad("bad id") }
        store.deleteAsset(id)
        return .ok()
    }

    /// Pull every item of a Plex library into the ad pool — the Apple analogue
    /// of the Node build's folder scan (nothing to copy onto the device).
    private func importPlexAds(_ req: Request) async -> Response {
        guard let sectionKey = req.body?.string("sectionKey") else { return .bad("sectionKey required") }
        await ensurePlexConfigured()
        do {
            let items = try await plex.sectionItems(key: sectionKey, type: "movie")
            var imported = 0
            for item in items {
                if let m = try? await plex.movie(ratingKey: item.ratingKey), let pk = m.partKey {
                    store.upsertAsset(path: "plex:\(m.ratingKey)", title: m.title, kind: "ad",
                                      durationMs: m.durationMs, ratingKey: m.ratingKey, partKey: pk)
                    imported += 1
                }
            }
            // Remember the section so refresh-plex can re-pull it later.
            var sections = Set((store.getSetting("ad_sections") ?? "").split(separator: ",").map(String.init))
            sections.insert(sectionKey)
            store.setSetting("ad_sections", sections.joined(separator: ","))
            return .ok(["imported": imported])
        } catch {
            return Response(502, ["error": "Couldn't read that Plex library: \(error.localizedDescription)"])
        }
    }

    private func refreshPlexAds() async -> Response {
        let sections = (store.getSetting("ad_sections") ?? "").split(separator: ",").map(String.init)
        var results: [[String: Any]] = []
        for key in sections {
            let r = await importPlexAds(Request(method: "POST", path: "/api/assets/import-plex",
                                                body: ["sectionKey": key]))
            if let j = r.json as? [String: Any], let n = j["imported"] as? Int {
                results.append(["section": key, "imported": n])
            }
        }
        return .ok(["sections": sections, "results": results])
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
                var o: [String: Any] = ["ratingKey": i.ratingKey, "title": i.title,
                                        "type": i.type, "thumb": i.thumb ?? NSNull()]
                // A browser-loadable poster URL, proxied so no Plex token leaks.
                if let t = i.thumb, let enc = t.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
                    o["image"] = "/api/image?path=\(enc)"
                }
                return o
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
            "enabled": c.enabled, "kidSafe": kidSafeIds().contains(c.id),
            "sources": store.sources(c.id).map { s -> [String: Any] in
                ["id": s.id, "ratingKey": s.ratingKey, "sourceType": s.sourceType,
                 "title": s.title ?? NSNull(), "thumb": s.thumb ?? NSNull(),
                 // The web UI's chip count badge ("37" next to the show name).
                 "itemCount": store.mediaCount(forSource: s.ratingKey)]
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

public extension Notification.Name {
    /// Posted by ConfigAPI after any successful config mutation (channel edits,
    /// sources added, Plex linked/unlinked). The player observes it and reloads
    /// its lineup from the shared Store, so web-UI changes appear live.
    static let dumbTVConfigChanged = Notification.Name("dumbTVConfigChanged")
    /// Posted when the web UI asks the TV to change channel (Watch button /
    /// ON AIR strip). userInfo: ["channelId": Int].
    static let dumbTVTuneRequested = Notification.Name("dumbTVTuneRequested")
}
