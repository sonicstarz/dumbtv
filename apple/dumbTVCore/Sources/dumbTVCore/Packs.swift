import Foundation

// Content packs (Track I) — the Swift half of the pack model, mirroring
// src/packs/install.js. A built pack is a folder holding a `pack.json` runtime
// manifest plus media files. Installing registers its media (part_key =
// pack:<id>/<file>) so the existing channel_sources → library assembly and the
// deterministic generator schedule it with zero changes. Playback resolves a
// pack: key to a local file URL under the pack's root_path.

public let packPrefix = "pack:"
public func packRatingKey(_ id: String) -> String { "\(packPrefix)\(id)" }
public func packPartKey(_ id: String, _ file: String) -> String { "\(packPrefix)\(id)/\(file)" }

/// The runtime manifest emitted by scripts/build-pack.js (dist/pack.json).
/// Extra JSON keys (bytes, sha256, license…) are ignored by Codable.
public struct PackManifest: Codable, Sendable {
    public struct Channel: Codable, Sendable {
        public var number: Int?
        public var name: String?
        public var ordering: String?
        public var seed: UInt32?
    }
    public struct Item: Codable, Sendable {
        public var id: String
        public var file: String
        public var title: String?
        public var show: String?
        public var season: Int?
        public var episode: Int?
        public var aired: String?
        public var durationMs: Millis
    }
    public var id: String
    public var name: String
    public var version: Int?
    public var kind: String?
    public var channel: Channel?
    public var items: [Item]
}

public struct InstalledPack: Sendable {
    public let id: String
    public let name: String
    public let kind: String
    public let origin: String
    public let rootPath: String
}

extension Store {
    /// `pack:<id>/<file>` → absolute file path under the pack's root, or nil.
    public func resolvePackPath(_ key: String) -> String? {
        guard key.hasPrefix(packPrefix) else { return nil }
        let rest = key.dropFirst(packPrefix.count)
        guard let slash = rest.firstIndex(of: "/") else { return nil } // bare pack:<id> is a source key
        let packId = String(rest[..<slash])
        let file = String(rest[rest.index(after: slash)...])
        guard let root = ((try? sql.query("SELECT root_path FROM packs WHERE id=?", [.text(packId)])) ?? [])
            .first?.text("root_path") else { return nil }
        return (root as NSString).appendingPathComponent(file)
    }

    /// Read + decode a built pack's dist/pack.json.
    public static func readPackManifest(dir: URL) throws -> PackManifest {
        let data = try Data(contentsOf: dir.appendingPathComponent("pack.json"))
        return try JSONDecoder().decode(PackManifest.self, from: data)
    }

    /// Install (register) a built pack from its dist dir. Idempotent.
    /// `origin` is "bundled" (ships in the app) or "downloaded".
    @discardableResult
    public func installPack(fromDir dir: URL, origin: String = "downloaded") throws -> InstalledPack {
        let m = try Self.readPackManifest(dir: dir)
        return installPack(m, rootPath: dir.path, origin: origin)
    }

    @discardableResult
    public func installPack(_ m: PackManifest, rootPath: String, origin: String = "downloaded") -> InstalledPack {
        let kind = m.kind ?? "shows"
        let now = Millis(Date().timeIntervalSince1970 * 1000)
        _ = try? sql.run("""
            INSERT INTO packs(id,name,version,kind,origin,root_path,installed_at)
            VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,version=excluded.version,
              kind=excluded.kind,origin=excluded.origin,root_path=excluded.root_path,
              installed_at=excluded.installed_at
            """, [.text(m.id), .text(m.name), .int(Int64(m.version ?? 1)), .text(kind),
                  .text(origin), .text(rootPath), .int(now)])

        if kind == "ads" {
            for it in m.items {
                // partKey MUST be set — the Engine's ad branch resolves ads via
                // asset.partKey (Engine.streamURL maps pack: → a local file). It
                // was nil, so every preloaded ad break played as dead air/bars.
                _ = upsertAsset(path: packPartKey(m.id, it.file), title: it.title ?? it.id,
                                kind: "ad", durationMs: it.durationMs, tags: "pack,\(m.id)",
                                partKey: packPartKey(m.id, it.file))
            }
            // Reconcile: drop this pack's assets no longer in the manifest.
            let keep = Set(m.items.map { packPartKey(m.id, $0.file) })
            for row in ((try? sql.query("SELECT path FROM assets WHERE path LIKE ?",
                                        [.text("\(packPartKey(m.id, ""))%")])) ?? []) {
                if let path = row.text("path"), !keep.contains(path) {
                    _ = try? sql.run("DELETE FROM assets WHERE path=?", [.text(path)])
                }
            }
        } else {
            let media = m.items.map { it in
                Media(ratingKey: "\(packRatingKey(m.id)):\(it.id)", parentKey: packRatingKey(m.id),
                      kind: (it.season != nil && it.episode != nil) ? .episode : .movie,
                      title: it.title ?? it.id, showTitle: it.show, seasonNo: it.season,
                      episodeNo: it.episode, aired: it.aired, durationMs: it.durationMs,
                      partKey: packPartKey(m.id, it.file))
            }
            upsertMedia(media)
            // Reconcile: drop pack media no longer in the manifest, so a
            // partial→full upgrade (or a re-curated pack) has an EXACT item
            // count and no stale rows linger (matches the vanished-file rule).
            let keep = Set(media.map { $0.ratingKey })
            for existing in self.media(forSource: packRatingKey(m.id)) where !keep.contains(existing.ratingKey) {
                _ = try? sql.run("DELETE FROM media WHERE rating_key=?", [.text(existing.ratingKey)])
            }
        }
        return InstalledPack(id: m.id, name: m.name, kind: kind, origin: origin, rootPath: rootPath)
    }

    /// Create a channel that plays an installed shows-pack.
    @discardableResult
    public func createChannelFromPack(_ packId: String, adsEnabled: Bool = true) -> Int? {
        guard let row = ((try? sql.query("SELECT * FROM packs WHERE id=?", [.text(packId)])) ?? []).first,
              (row.text("kind") ?? "shows") != "ads" else { return nil }
        let ch = channelHints(rootPath: row.text("root_path") ?? "")
        let number = Int64(freeChannelNumber(preferred: ch?.number))   // N3: hint is a preference, not a demand
        let name = ch?.name ?? (row.text("name") ?? packId)
        let ordering = ch?.ordering ?? "sequential"
        let seed = Int64(ch?.seed ?? stableSeed(packId))
        let now = Millis(Date().timeIntervalSince1970 * 1000)
        let id = (try? sql.run("""
            INSERT INTO channels
              (number,name,slot_minutes,ordering_mode,marathon_size,cursor,shuffle_seed,
               dark_start,dark_end,ads_enabled,max_ads_per_break,ad_tags,timing_mode,
               ads_between,cooldown_days,overrun_policy,enabled,generated_thru,created_at)
            VALUES(?,?,30,?,3,0,?,NULL,NULL,?,10,'','continuous',4,0,'protect',1,0,?)
            """, [.int(number), .text(name), .text(ordering), .int(seed),
                  .int(adsEnabled ? 1 : 0), .int(now)])) ?? 0
        guard id > 0 else { return nil }
        addSource(Int(id), ratingKey: packRatingKey(packId), sourceType: "pack", title: name)
        return Int(id)
    }

    /// One-time repair for devices seeded by builds 11/12, where the preloaded
    /// pack channels were created with commercials ON: turn ads off on every
    /// channel whose ONLY source is a pack, then rebuild its future. A channel
    /// the user built — or a preload channel they added their own sources to —
    /// is left alone, because those are theirs to decide about.
    ///
    /// Safe against invariant #4: `Scheduler.regenerate` deletes only
    /// `start_utc >= now`, so whatever is airing right now finishes as scheduled.
    /// Returns the channel ids it changed.
    @discardableResult
    public func migratePreloadAdsOff(now: Millis) -> [Int] {
        guard getSetting("preload_ads_off") == nil else { return [] }
        setSetting("preload_ads_off", "1")
        var changed: [Int] = []
        for c in allChannels() where c.adsEnabled {
            let srcs = sources(c.id)
            guard !srcs.isEmpty, srcs.allSatisfy({ $0.sourceType == "pack" }) else { continue }
            var updated = c
            updated.adsEnabled = false
            saveChannel(updated)
            Scheduler.regenerate(store: self, channelId: c.id, now: now)
            changed.append(c.id)
        }
        return changed
    }

    /// Remove a pack's media/assets and its row. Aired programs are left alone.
    public func uninstallPack(_ packId: String) {
        _ = try? sql.run("DELETE FROM media WHERE parent_key=?", [.text(packRatingKey(packId))])
        _ = try? sql.run("DELETE FROM assets WHERE path LIKE ?", [.text("\(packPartKey(packId, ""))%")])
        _ = try? sql.run("DELETE FROM packs WHERE id=?", [.text(packId)])
    }

    public func packs() -> [InstalledPack] {
        ((try? sql.query("SELECT * FROM packs ORDER BY installed_at")) ?? []).map {
            InstalledPack(id: $0.text("id") ?? "", name: $0.text("name") ?? "",
                          kind: $0.text("kind") ?? "shows", origin: $0.text("origin") ?? "",
                          rootPath: $0.text("root_path") ?? "")
        }
    }

    private func channelHints(rootPath: String) -> PackManifest.Channel? {
        let url = URL(fileURLWithPath: rootPath).appendingPathComponent("pack.json")
        return (try? Self.readPackManifest(dir: URL(fileURLWithPath: rootPath)))?.channel
            ?? ((try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(PackManifest.self, from: $0) })?.channel
    }
}

/// Stable FNV-1a seed from a pack id — deterministic across launches (unlike
/// Swift's randomized hashValue), so an unspecified seed still gives a stable
/// shuffle order and a truthful printed guide.
private func stableSeed(_ s: String) -> UInt32 {
    var h: UInt32 = 2166136261
    for b in s.utf8 { h = (h ^ UInt32(b)) &* 16777619 }
    return h
}
