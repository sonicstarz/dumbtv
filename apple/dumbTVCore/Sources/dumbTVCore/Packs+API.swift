import Foundation

// The pack-picker API (Track I, P3) — the Swift half of the Node routes in
// src/routes/api.js. Lists the catalog merged with what's installed, downloads
// a pack from the Internet Archive (D4: derivatives direct, no re-encode),
// spins up a channel, or removes one. Same wire contract, so the shared web UI
// runs unchanged against the embedded server.

/// The download catalog (dumbtv.app/packs/index.json is live; a copy is bundled).
struct PackCatalog: Decodable {
    struct License: Decodable { var url: String?; var verified: String?; var note: String? }
    struct Item: Decodable {
        var id: String; var file: String; var title: String?
        var show: String?; var season: Int?; var episode: Int?; var aired: String?
        var durationMs: Millis; var url: String; var bytes: Int?; var license: License?
    }
    /// Detail-screen copy, authored per pack (scripts/add-pack-editorial.js).
    /// Optional throughout: an older catalog, or a pack installed before this
    /// existed, simply has none and the UI falls back to the description.
    struct Editorial: Decodable {
        var rating: String?; var kidSafe: Bool?; var era: String?; var tint: String?
        var history: String?; var synopsis: String?; var advisory: String?
    }
    struct Entry: Decodable {
        var id: String; var name: String; var kind: String?; var description: String?
        var channel: PackManifest.Channel?
        var itemCount: Int?; var runtimeMs: Millis?; var downloadBytes: Int?
        var editorial: Editorial?
        var items: [Item]
    }
    var version: Int?; var packs: [Entry]
}

/// In-flight install state for the progress the web UI polls.
struct PackProgress: Sendable {
    var state: String; var done: Int; var total: Int; var error: String?
    var bytesDone: Int = 0; var bytesTotal: Int = 0; var startedAt: Double = 0   // C4
}

/// Thread-safe progress store — a background download Task writes while the
/// request thread reads (ConfigAPI is a plain class, not an actor).
final class PackProgressBox: @unchecked Sendable {
    private let lock = NSLock()
    private var map: [String: PackProgress] = [:]
    func get(_ id: String) -> PackProgress? { lock.lock(); defer { lock.unlock() }; return map[id] }
    func set(_ id: String, _ p: PackProgress) { lock.lock(); defer { lock.unlock() }; map[id] = p }
}

extension ConfigAPI {
    // Where downloaded packs live — the same writable root as the DB (Caches on
    // tvOS; Application Support elsewhere). See AppPaths for why.
    static func downloadedPacksDir() -> URL { AppPaths.packsDir() }

    func loadCatalog() -> PackCatalog {
        // Prefer the downloaded catalog, else the one bundled with the build.
        // That override slot existed from the start; nothing ever wrote it
        // until refreshCatalogInBackground() below.
        let candidates = [
            Self.downloadedPacksDir().appendingPathComponent("index.json"),
            Bundle.main.resourceURL?.appendingPathComponent("packs/index.json"),
        ].compactMap { $0 }
        for url in candidates {
            if let data = try? Data(contentsOf: url),
               let cat = try? JSONDecoder().decode(PackCatalog.self, from: data),
               !cat.packs.isEmpty { return cat }
        }
        return PackCatalog(version: 1, packs: [])
    }

    // ── the live catalog (D5, second half) ──────────────────────────────────
    //
    // Publishing dumbtv.app/packs/index.json was half the job; without a fetch,
    // curation still could not change without an app release.
    //
    // WHEN is a privacy decision, not a technical one, and the privacy policy
    // states it in these words: only when you open the Channel Packs page.
    // Never on launch, never on a timer, never in the background. Open the page
    // and dumbTV asks what exists; don't, and it never contacts us at all.

    static let catalogURL = URL(string: "https://dumbtv.app/packs/index.json")!
    static let catalogTTL: TimeInterval = 6 * 60 * 60      // at most 4 asks a day
    static let catalogMaxBytes = 2 * 1024 * 1024           // a list, not a payload

    /// Refresh the cached catalog if it is stale. Fire-and-forget: the picker
    /// renders from what it already has and takes the new list on the next open,
    /// so a slow or unreachable dumbtv.app is never something the user waits on
    /// to see their own installed packs.
    func refreshCatalogInBackground() {
        let dest = Self.downloadedPacksDir().appendingPathComponent("index.json")
        if let attrs = try? FileManager.default.attributesOfItem(atPath: dest.path),
           let modified = attrs[.modificationDate] as? Date,
           Date().timeIntervalSince(modified) < Self.catalogTTL {
            return                                          // fresh enough; ask nobody
        }
        Task.detached(priority: .utility) {
            var req = URLRequest(url: Self.catalogURL, timeoutInterval: 10)
            req.setValue("dumbTV", forHTTPHeaderField: "User-Agent")   // no identifier
            guard let (data, resp) = try? await URLSession.shared.data(for: req),
                  let http = resp as? HTTPURLResponse, http.statusCode == 200,
                  data.count <= Self.catalogMaxBytes,
                  // A 200 that isn't a catalog (a captive portal, a login page)
                  // must never be allowed to replace a working one.
                  let cat = try? JSONDecoder().decode(PackCatalog.self, from: data),
                  !cat.packs.isEmpty
            else { return }
            try? FileManager.default.createDirectory(
                at: Self.downloadedPacksDir(), withIntermediateDirectories: true)
            try? data.write(to: dest, options: .atomic)
        }
    }

    // MARK: routes

    func packsList() -> Response {
        // D5: opening the pack page is the ONE moment dumbTV asks dumbtv.app
        // what exists. Fire-and-forget — this list is whatever is already
        // cached, and a refresh lands for the next open.
        refreshCatalogInBackground()
        let installed = Dictionary(uniqueKeysWithValues: store.packs().map { ($0.id, $0) })
        let packChannels = Set(((try? store.sql.query(
            "SELECT rating_key FROM channel_sources WHERE source_type='pack'")) ?? [])
            .compactMap { $0.text("rating_key") })

        func row(id: String, name: String, kind: String, desc: String,
                 itemCount: Int, runtimeMs: Millis, downloadBytes: Int,
                 editorial: PackCatalog.Editorial? = nil) -> [String: Any] {
            let prog = packProgress.get(id)
            var o: [String: Any] = [
                "id": id, "name": name, "kind": kind, "description": desc,
                "itemCount": itemCount, "runtimeMs": runtimeMs, "downloadBytes": downloadBytes,
                "installed": installed[id] != nil || prog?.state == "installed",
                "installedItemCount": installedItemCount(id, kind: kind),
                "hasChannel": packChannels.contains(packRatingKey(id)),
                "origin": installed[id]?.origin ?? NSNull(),
            ]
            if let e = editorial {
                // Built key by key, not as one literal: a dictionary literal of
                // seven `?? NSNull()` ternaries is enough to make the Swift type
                // checker give up ("unable to type-check in reasonable time").
                var ed: [String: Any] = [:]
                if let v = e.rating   { ed["rating"] = v }
                if let v = e.kidSafe  { ed["kidSafe"] = v }
                if let v = e.era      { ed["era"] = v }
                if let v = e.tint     { ed["tint"] = v }
                if let v = e.history  { ed["history"] = v }
                if let v = e.synopsis { ed["synopsis"] = v }
                if let v = e.advisory { ed["advisory"] = v }
                o["editorial"] = ed
            }
            o["progress"] = prog.map { ["state": $0.state, "done": $0.done, "total": $0.total,
                                        "error": $0.error.map { $0 as Any } ?? NSNull(),
                                        "bytesDone": $0.bytesDone, "bytesTotal": $0.bytesTotal,
                                        "startedAt": $0.startedAt] } ?? NSNull()
            return o
        }

        // How many items are actually on disk — a bundled preload may ship a
        // subset (1 Superman episode of 17), so the picker can offer the rest (C-1).
        func installedItemCount(_ id: String, kind: String) -> Int {
            if kind == "ads" {
                return Int((((try? store.sql.query("SELECT COUNT(*) n FROM assets WHERE path LIKE ?",
                    [.text("\(packPartKey(id, ""))%")])) ?? []).first?.int("n")) ?? 0)
            }
            return store.media(forSource: packRatingKey(id)).count
        }

        var out: [[String: Any]] = []
        var seen = Set<String>()
        for p in loadCatalog().packs {
            seen.insert(p.id)
            out.append(row(id: p.id, name: p.name, kind: p.kind ?? "shows", desc: p.description ?? "",
                           itemCount: p.itemCount ?? p.items.count,
                           runtimeMs: p.runtimeMs ?? 0, downloadBytes: p.downloadBytes ?? 0,
                           editorial: p.editorial))
        }
        // Installed packs missing from the catalog (e.g. a bundled preload with
        // no catalog, or the catalog fetch failed) still show up + are manageable.
        for ip in store.packs() where !seen.contains(ip.id) {
            let media = store.media(forSource: packRatingKey(ip.id))
            out.append(row(id: ip.id, name: ip.name, kind: ip.kind, desc: "",
                           itemCount: media.count,
                           runtimeMs: media.reduce(Millis(0)) { $0 + $1.durationMs }, downloadBytes: 0))
        }
        // Free space, alongside the packs, so a screen offering a 2.9 GB
        // download can say whether it will fit BEFORE anyone presses it. The
        // owner's Apple TV reported "http(500)" after thirty seconds on Popeye
        // with no way to tell a transient archive.org blip from a full disk.
        return .ok(["packs": out,
                    "storage": ["freeBytes": PackSpace.availableBytes(),
                                "free": PackSpace.human(PackSpace.availableBytes())]])
    }

    func packCreateChannel(_ id: String, _ req: Request) -> Response {
        guard store.createChannelFromPack(id, adsEnabled: (req.body?["adsEnabled"] as? Bool) ?? true) != nil
        else { return .bad("pack not installed or is ads-only: \(id)") }
        return .ok(["ok": true])
    }

    func packDelete(_ id: String) -> Response {
        store.uninstallPack(id)
        return .ok(["ok": true])
    }

    /// Download + register a catalogued pack. Runs in the background; the web UI
    /// polls GET /api/packs for progress. Idempotent while in flight.
    func packInstall(_ id: String) async -> Response {
        guard let entry = loadCatalog().packs.first(where: { $0.id == id }) else {
            return .notFound("unknown pack: \(id)")
        }
        if packProgress.get(id)?.state == "downloading" {
            return .ok(["ok": true, "progress": ["state": "downloading"]])
        }
        let total = entry.items.count
        let bytesTotal = entry.downloadBytes ?? 0
        let startedAt = Date().timeIntervalSince1970 * 1000   // ms epoch (matches Node)
        packProgress.set(id, PackProgress(state: "downloading", done: 0, total: total, error: nil,
                                          bytesDone: 0, bytesTotal: bytesTotal, startedAt: startedAt))
        let store = self.store
        let progress = self.packProgress
        Task.detached {
            let dir = ConfigAPI.downloadedPacksDir().appendingPathComponent(id, isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            do {
                // CHECK THE SPACE FIRST. Bosko is 1.9 GB and Popeye is 2.9 GB;
                // finding out they don't fit after thirty seconds of downloading
                // — and being told "http(500)" — is the worst version of this.
                if bytesTotal > 0 {
                    let free = PackSpace.availableBytes()
                    if Int64(bytesTotal) + PackSpace.headroomBytes > free {
                        throw PackError.noSpace(needs: Int64(bytesTotal), free: free)
                    }
                }
                var bytesDone = 0
                for (i, it) in entry.items.enumerated() {
                    let dest = dir.appendingPathComponent(it.file)
                    // N1: accept an existing file only if it looks complete (size
                    // matches); URLSession.download already lands atomically.
                    let existing = (try? FileManager.default.attributesOfItem(atPath: dest.path)[.size] as? Int) ?? nil
                    let complete = existing != nil && (it.bytes == nil || abs((existing ?? 0) - (it.bytes ?? 0)) < 65536)
                    if !complete {
                        guard let src = URL(string: it.url) else { throw PackError.badURL }
                        // RETRY TRANSIENT FAILURES. archive.org answers 500/503
                        // under load often enough that a single attempt is not a
                        // download strategy — one blip killed a 22-file pack at
                        // file 1 and reported "http(500)". Both packs that failed
                        // on the owner's Apple TV serve fine on a retry.
                        //
                        // Bounded and backed off: three tries, 2s then 6s. Not a
                        // loop that hammers a public archive we don't pay for.
                        var lastError: Error?
                        for attempt in 0..<3 {
                            if attempt > 0 {
                                try await Task.sleep(nanoseconds: UInt64(attempt * 4 - 2) * 1_000_000_000)
                                progress.set(id, PackProgress(state: "downloading", done: i, total: total,
                                                              error: "retrying \(it.title)…",
                                                              bytesDone: bytesDone, bytesTotal: bytesTotal,
                                                              startedAt: startedAt))
                            }
                            do {
                                let (tmp, resp) = try await URLSession.shared.download(from: src)
                                if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
                                    let e = PackError.http(http.statusCode)
                                    // 4xx is about the file, not the weather —
                                    // retrying a 404 just wastes the person's time.
                                    if http.statusCode < 500 { throw e }
                                    lastError = e
                                    continue
                                }
                                try? FileManager.default.removeItem(at: dest)
                                try FileManager.default.moveItem(at: tmp, to: dest)
                                lastError = nil
                                break
                            } catch let e as PackError {
                                throw e
                            } catch {
                                lastError = error   // network dropped — worth another go
                            }
                        }
                        if let lastError { throw lastError }
                    }
                    bytesDone += it.bytes ?? ((try? FileManager.default.attributesOfItem(atPath: dest.path)[.size] as? Int) ?? 0) ?? 0
                    progress.set(id, PackProgress(state: "downloading", done: i + 1, total: total, error: nil,
                                                  bytesDone: bytesDone, bytesTotal: bytesTotal, startedAt: startedAt))
                }
                // Write the runtime manifest, then register.
                let manifest = PackManifest(
                    id: entry.id, name: entry.name, version: 1, kind: entry.kind ?? "shows",
                    channel: entry.channel,
                    items: entry.items.map { .init(id: $0.id, file: $0.file, title: $0.title, show: $0.show,
                                                   season: $0.season, episode: $0.episode, aired: $0.aired,
                                                   durationMs: $0.durationMs) })
                let data = try JSONEncoder().encode(manifest)
                try data.write(to: dir.appendingPathComponent("pack.json"))
                store.installPack(manifest, rootPath: dir.path, origin: "downloaded")
                progress.set(id, PackProgress(state: "installed", done: total, total: total, error: nil,
                                              bytesDone: bytesTotal, bytesTotal: bytesTotal, startedAt: startedAt))
            } catch {
                let message = (error as? LocalizedError)?.errorDescription ?? "\(error)"
                progress.set(id, PackProgress(state: "error", done: 0, total: total, error: message,
                                              bytesTotal: bytesTotal, startedAt: startedAt))
            }
        }
        return .ok(["ok": true, "progress": ["state": "downloading", "done": 0, "total": entry.items.count]])
    }
}

enum PackError: LocalizedError {
    case badURL
    case http(Int)
    case noSpace(needs: Int64, free: Int64)

    /// What the television actually shows. The raw enum description leaked to
    /// the screen as "http(500)", which tells someone holding a remote nothing
    /// about what to do next.
    var errorDescription: String? {
        switch self {
        case .badURL:
            return "That download link is malformed."
        case .http(let code) where code >= 500:
            return "archive.org is having trouble right now (\(code)). Nothing wrong on your end — try again in a few minutes."
        case .http(404):
            return "That file is no longer on archive.org."
        case .http(let code):
            return "The download failed (\(code))."
        case .noSpace(let needs, let free):
            return "Not enough space. This pack needs \(PackSpace.human(needs)) and there is \(PackSpace.human(free)) free."
        }
    }
}

/// Free space, and how to say it out loud.
enum PackSpace {
    /// Space the system will actually let us use.
    ///
    /// `volumeAvailableCapacityForImportantUsage` is the honest number — it
    /// counts space reclaimable from purgeable caches — but it is UNAVAILABLE ON
    /// tvOS, which is precisely the platform with 32 GB and an aggressive cache
    /// policy. There, `systemFreeSize` is what there is.
    static func availableBytes() -> Int64 {
        let url = ConfigAPI.downloadedPacksDir()
        #if !os(tvOS)
        if let v = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let n = v.volumeAvailableCapacityForImportantUsage { return n }
        #endif
        if let a = try? FileManager.default.attributesOfFileSystem(forPath: url.path),
           let n = a[.systemFreeSize] as? NSNumber { return n.int64Value }
        return 0
    }

    static func human(_ bytes: Int64) -> String {
        let f = ByteCountFormatter()
        f.countStyle = .file
        f.allowedUnits = [.useGB, .useMB]
        return f.string(fromByteCount: max(0, bytes))
    }

    /// Keep a floor free. A device with literally zero bytes left misbehaves in
    /// ways that have nothing to do with us, and a pack that exactly fills the
    /// disk is not a success.
    static let headroomBytes: Int64 = 500 * 1024 * 1024
}

// PackManifest needs to encode (install writes pack.json) — its members are all
// Codable already; conformance is declared on the struct in Packs.swift.
