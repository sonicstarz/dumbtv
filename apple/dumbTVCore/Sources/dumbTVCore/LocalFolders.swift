import Foundation
#if canImport(AVFoundation)
import AVFoundation
#endif

// Local folders on Apple (Track I, P6) — "bring your own files", mirroring
// src/media/localscan.js. Files register under a stable folder key
// (folder:<hash-of-path>) and play through the same local: path. Durations come
// from AVFoundation (no ffprobe). Filenames parse via the shared Filenames spec.
//
// Registering the folder is here + testable; the native folder-GRANT UI
// (NSOpenPanel + a security-scoped bookmark, kept so playback can reopen it) is
// macOS app-level and layered on top — see docs/content-without-plex.md (P6).

public struct ScannedItem: Sendable {
    public let path: String
    public let relPath: String
    public let parsed: ParsedName
    public let durationMs: Millis
    public init(path: String, relPath: String, parsed: ParsedName, durationMs: Millis) {
        self.path = path; self.relPath = relPath; self.parsed = parsed; self.durationMs = durationMs
    }
}

// FNV-1a → 8 hex. Deterministic per launch (unlike Swift's randomized hashValue)
// so a rescan yields the same rating_keys and the guide/shuffle stay put (#5).
func fnvHex(_ s: String) -> String {
    var h: UInt32 = 2166136261
    for b in s.utf8 { h = (h ^ UInt32(b)) &* 16777619 }
    return String(format: "%08x", h)
}

extension Store {
    public func localFolderId(_ path: String) -> String { "folder:\(fnvHex((path as NSString).standardizingPath))" }

    /// Register (or re-register) a scanned folder into the library. Vanished
    /// files are dropped; already-aired programs are never touched. Returns the
    /// folder key for createChannelFromLocalFolder.
    @discardableResult
    public func registerLocalFolder(rootPath: String, items: [ScannedItem]) -> String {
        let parent = localFolderId(rootPath)
        let media = items.map { it in
            Media(ratingKey: "\(parent):\(fnvHex(it.relPath))", parentKey: parent, kind: it.parsed.kind,
                  title: it.parsed.title, showTitle: it.parsed.showTitle, seasonNo: it.parsed.seasonNo,
                  episodeNo: it.parsed.episodeNo, aired: it.parsed.year.map { "\($0)-01-01" },
                  durationMs: it.durationMs, partKey: "local:\(it.path)")
        }
        upsertMedia(media)
        let keep = Set(media.map { $0.ratingKey })
        for m in self.media(forSource: parent) where !keep.contains(m.ratingKey) {
            _ = try? sql.run("DELETE FROM media WHERE rating_key=?", [.text(m.ratingKey)])
        }
        return parent
    }

    @discardableResult
    public func createChannelFromLocalFolder(_ folderId: String, name: String,
                                             ordering: String = "sequential", adsEnabled: Bool = false) -> Int? {
        let maxNo = nextChannelNumber()
        let seed = Int64(UInt32(fnvHex(folderId).prefix(8), radix: 16) ?? 1) & 0x7fffffff
        let now = Millis(Date().timeIntervalSince1970 * 1000)
        let id = (try? sql.run("""
            INSERT INTO channels
              (number,name,slot_minutes,ordering_mode,marathon_size,cursor,shuffle_seed,
               dark_start,dark_end,ads_enabled,max_ads_per_break,ad_tags,timing_mode,
               ads_between,cooldown_days,overrun_policy,enabled,generated_thru,created_at)
            VALUES(?,?,30,?,3,0,?,NULL,NULL,?,10,'','continuous',4,0,'protect',1,0,?)
            """, [.int(Int64(maxNo)), .text(name), .text(ordering), .int(seed),
                  .int(adsEnabled ? 1 : 0), .int(now)])) ?? 0
        guard id > 0 else { return nil }
        addSource(Int(id), ratingKey: folderId, sourceType: "local", title: name)
        return Int(id)
    }

    // ── granted folders (P6) ────────────────────────────────────────────────
    //
    // The decided shape, from the Track I open question: GRANT ONCE NATIVELY,
    // MANAGE IN THE WEB UI. The config UI runs in a browser on another device
    // and cannot open a file picker on the TV — so the Mac app owns the moment
    // permission is given, and everything afterwards (see it, rescan it, remove
    // it) happens in the same web UI as the rest of the configuration.

    public struct GrantedFolder: Sendable {
        public let folderId: String
        public let path: String
        public let addedAt: Millis
        public let lastScan: Millis?
        public let itemCount: Int
        /// True when the folder is no longer where it was — moved, renamed, or
        /// on a volume that isn't mounted. Worth showing rather than hiding:
        /// an empty channel with no explanation looks like a bug.
        public var missing: Bool { !FileManager.default.fileExists(atPath: path) }
    }

    /// Persist a grant. The bookmark is what survives a relaunch; the path is
    /// only ever for display and for spotting a folder that has moved.
    public func saveGrantedFolder(folderId: String, path: String, bookmark: Data) {
        _ = try? sql.run("""
            INSERT INTO granted_folders (folder_id, path, bookmark, added_at, last_scan, item_count)
            VALUES (?,?,?,?,NULL,0)
            ON CONFLICT(folder_id) DO UPDATE SET path=excluded.path, bookmark=excluded.bookmark
            """, [.text(folderId), .text(path), .text(bookmark.base64EncodedString()),
                  .int(Millis(Date().timeIntervalSince1970 * 1000))])
    }

    public func grantedFolders() -> [GrantedFolder] {
        ((try? sql.query("SELECT * FROM granted_folders ORDER BY added_at")) ?? []).compactMap { r in
            guard let id = r.text("folder_id"), let p = r.text("path") else { return nil }
            return GrantedFolder(folderId: id, path: p,
                                 addedAt: r.int("added_at") ?? 0,
                                 lastScan: r.int("last_scan"),
                                 itemCount: Int(r.int("item_count") ?? 0))
        }
    }

    public func grantedFolderBookmark(_ folderId: String) -> Data? {
        guard let row = (try? sql.query(
                "SELECT bookmark FROM granted_folders WHERE folder_id=?", [.text(folderId)]))?.first,
              let b64 = row.text("bookmark") else { return nil }
        return Data(base64Encoded: b64)
    }

    public func noteFolderScanned(_ folderId: String, itemCount: Int) {
        _ = try? sql.run("UPDATE granted_folders SET last_scan=?, item_count=? WHERE folder_id=?",
                         [.int(Millis(Date().timeIntervalSince1970 * 1000)),
                          .int(Int64(itemCount)), .text(folderId)])
    }

    /// Forget a folder: drop the grant and its media, but leave any channel
    /// standing. Same rule as uninstalling a pack — the channel goes to the
    /// stand-by card rather than vanishing, and re-granting restores it exactly,
    /// because the folder key is a hash of the path and the rating keys are
    /// hashes of the relative paths (invariant #5 across a re-grant).
    public func removeGrantedFolder(_ folderId: String) {
        _ = try? sql.run("DELETE FROM media WHERE parent_key=?", [.text(folderId)])
        _ = try? sql.run("DELETE FROM granted_folders WHERE folder_id=?", [.text(folderId)])
    }

    #if os(macOS)
    /// Turn a stored bookmark back into a usable URL.
    ///
    /// Returns the URL and whether the caller must call
    /// `stopAccessingSecurityScopedResource()` when finished — which it must,
    /// because these are a limited resource and leaking them eventually stops
    /// new grants from resolving at all.
    ///
    /// A STALE bookmark is not a failure: macOS hands back a working URL and
    /// asks for a fresh bookmark, which is how a moved folder keeps working. We
    /// re-save it silently.
    public func resolveGrantedFolder(_ folderId: String) -> (url: URL, needsStop: Bool)? {
        guard let data = grantedFolderBookmark(folderId) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data,
                                 options: [.withSecurityScope],
                                 relativeTo: nil,
                                 bookmarkDataIsStale: &stale) else { return nil }
        let ok = url.startAccessingSecurityScopedResource()
        if stale, let fresh = try? url.bookmarkData(options: [.withSecurityScope],
                                                    includingResourceValuesForKeys: nil,
                                                    relativeTo: nil) {
            saveGrantedFolder(folderId: folderId, path: url.path, bookmark: fresh)
        }
        return (url, ok)
    }
    #endif

    #if canImport(AVFoundation)
    /// Scan a folder into ScannedItems (durations via AVFoundation). App-level:
    /// call inside a security-scoped-resource access on the granted folder URL.
    public static func scanFolder(_ root: URL) async -> [ScannedItem] {
        let exts: Set<String> = ["mp4", "mkv", "avi", "mov", "m4v", "webm", "mpg", "mpeg", "ogv"]
        guard let en = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else { return [] }
        var items: [ScannedItem] = []
        for case let url as URL in en {
            guard exts.contains(url.pathExtension.lowercased()) else { continue }
            let asset = AVURLAsset(url: url)
            let secs = (try? await asset.load(.duration)).map { CMTimeGetSeconds($0) } ?? 0
            guard secs.isFinite && secs > 0 else { continue }
            let rel = url.path.replacingOccurrences(of: root.path + "/", with: "")
            let parentDir = url.deletingLastPathComponent()
            let showFolder = parentDir.path == root.path ? root.lastPathComponent : parentDir.lastPathComponent
            items.append(ScannedItem(path: url.path, relPath: rel,
                                     parsed: Filenames.parse(url.lastPathComponent, folder: showFolder),
                                     durationMs: Millis(secs * 1000)))
        }
        return items
    }
    #endif
}
