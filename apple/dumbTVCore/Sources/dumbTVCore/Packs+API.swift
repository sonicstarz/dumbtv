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
    struct Entry: Decodable {
        var id: String; var name: String; var kind: String?; var description: String?
        var channel: PackManifest.Channel?
        var itemCount: Int?; var runtimeMs: Millis?; var downloadBytes: Int?
        var items: [Item]
    }
    var version: Int?; var packs: [Entry]
}

/// In-flight install state for the progress the web UI polls.
struct PackProgress: Sendable { var state: String; var done: Int; var total: Int; var error: String? }

/// Thread-safe progress store — a background download Task writes while the
/// request thread reads (ConfigAPI is a plain class, not an actor).
final class PackProgressBox: @unchecked Sendable {
    private let lock = NSLock()
    private var map: [String: PackProgress] = [:]
    func get(_ id: String) -> PackProgress? { lock.lock(); defer { lock.unlock() }; return map[id] }
    func set(_ id: String, _ p: PackProgress) { lock.lock(); defer { lock.unlock() }; map[id] = p }
}

extension ConfigAPI {
    // Where downloaded packs live (beside the DB, in Application Support).
    static func downloadedPacksDir() -> URL {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                 appropriateFor: nil, create: true))
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("dumbTV/packs", isDirectory: true)
    }

    func loadCatalog() -> PackCatalog {
        // Prefer a downloaded catalog override, else the bundled fallback.
        let candidates = [
            Self.downloadedPacksDir().appendingPathComponent("index.json"),
            Bundle.main.resourceURL?.appendingPathComponent("packs/index.json"),
        ].compactMap { $0 }
        for url in candidates {
            if let data = try? Data(contentsOf: url),
               let cat = try? JSONDecoder().decode(PackCatalog.self, from: data) { return cat }
        }
        return PackCatalog(version: 1, packs: [])
    }

    // MARK: routes

    func packsList() -> Response {
        let installed = Dictionary(uniqueKeysWithValues: store.packs().map { ($0.id, $0) })
        let packChannels = Set(((try? store.sql.query(
            "SELECT rating_key FROM channel_sources WHERE source_type='pack'")) ?? [])
            .compactMap { $0.text("rating_key") })

        func row(id: String, name: String, kind: String, desc: String,
                 itemCount: Int, runtimeMs: Millis, downloadBytes: Int) -> [String: Any] {
            let prog = packProgress.get(id)
            var o: [String: Any] = [
                "id": id, "name": name, "kind": kind, "description": desc,
                "itemCount": itemCount, "runtimeMs": runtimeMs, "downloadBytes": downloadBytes,
                "installed": installed[id] != nil || prog?.state == "installed",
                "hasChannel": packChannels.contains(packRatingKey(id)),
                "origin": installed[id]?.origin ?? NSNull(),
            ]
            o["progress"] = prog.map { ["state": $0.state, "done": $0.done, "total": $0.total,
                                        "error": $0.error.map { $0 as Any } ?? NSNull()] } ?? NSNull()
            return o
        }

        var out: [[String: Any]] = []
        var seen = Set<String>()
        for p in loadCatalog().packs {
            seen.insert(p.id)
            out.append(row(id: p.id, name: p.name, kind: p.kind ?? "shows", desc: p.description ?? "",
                           itemCount: p.itemCount ?? p.items.count,
                           runtimeMs: p.runtimeMs ?? 0, downloadBytes: p.downloadBytes ?? 0))
        }
        // Installed packs missing from the catalog (e.g. a bundled preload with
        // no catalog, or the catalog fetch failed) still show up + are manageable.
        for ip in store.packs() where !seen.contains(ip.id) {
            let media = store.media(forSource: packRatingKey(ip.id))
            out.append(row(id: ip.id, name: ip.name, kind: ip.kind, desc: "",
                           itemCount: media.count,
                           runtimeMs: media.reduce(Millis(0)) { $0 + $1.durationMs }, downloadBytes: 0))
        }
        return .ok(["packs": out])
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
        packProgress.set(id, PackProgress(state: "downloading", done: 0, total: entry.items.count, error: nil))
        let store = self.store
        let progress = self.packProgress
        Task.detached {
            let dir = ConfigAPI.downloadedPacksDir().appendingPathComponent(id, isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            do {
                for (i, it) in entry.items.enumerated() {
                    let dest = dir.appendingPathComponent(it.file)
                    if !FileManager.default.fileExists(atPath: dest.path) {
                        guard let src = URL(string: it.url) else { throw PackError.badURL }
                        let (tmp, resp) = try await URLSession.shared.download(from: src)
                        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 { throw PackError.http(http.statusCode) }
                        try? FileManager.default.removeItem(at: dest)
                        try FileManager.default.moveItem(at: tmp, to: dest)
                    }
                    progress.set(id, PackProgress(state: "downloading", done: i + 1, total: entry.items.count, error: nil))
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
                progress.set(id, PackProgress(state: "installed", done: entry.items.count, total: entry.items.count, error: nil))
            } catch {
                progress.set(id, PackProgress(state: "error", done: 0, total: entry.items.count, error: "\(error)"))
            }
        }
        return .ok(["ok": true, "progress": ["state": "downloading", "done": 0, "total": entry.items.count]])
    }
}

enum PackError: Error { case badURL, http(Int) }

// PackManifest needs to encode (install writes pack.json) — its members are all
// Codable already; conformance is declared on the struct in Packs.swift.
