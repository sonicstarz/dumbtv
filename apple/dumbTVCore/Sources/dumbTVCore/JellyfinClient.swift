import Foundation

/// Jellyfin protocol, ported from `src/jellyfin/auth.js` + `src/jellyfin/client.js`
/// and verified against a real Jellyfin **10.11.11** server (build 13, J1/P7).
/// Pure Foundation/URLSession, so it runs on the Mac host, the simulator, and the
/// device unchanged — same shape as `PlexClient`.
///
/// Direct play only, always: every stream URL carries `?static=true`, which is
/// how you tell Jellyfin never to transcode (invariant #2). Transcoding would
/// kill instant seeking, and instant seeking is the whole illusion.

public struct JellyfinServer: Sendable, Equatable {
    public let url: String        // no trailing slash
    public let token: String
    public let userId: String
    public let name: String

    public init(url: String, token: String, userId: String, name: String) {
        self.url = url
        self.token = token
        self.userId = userId
        self.name = name
    }
}

public enum JellyfinError: LocalizedError {
    case noServer
    case http(Int)
    case badResponse
    case rejectedLogin(Int)
    case missingAddress

    public var errorDescription: String? {
        switch self {
        case .noServer:            return "No Jellyfin server connected yet."
        case .http(let c):         return "Jellyfin returned \(c)."
        case .badResponse:         return "Jellyfin did not return what dumbTV expected."
        case .rejectedLogin(let c): return "Jellyfin rejected the login (\(c))."
        case .missingAddress:      return "Enter your Jellyfin server address."
        }
    }
}

public actor JellyfinClient {
    /// Jellyfin identifies clients with this header on every request. DeviceId is
    /// stable so Jellyfin shows one "dumbTV" device rather than a new one each
    /// boot. Verified live: authenticating again with the same DeviceId REPLACES
    /// the session and invalidates the previous token — which is correct, and why
    /// the app must persist the token it gets rather than re-authenticating.
    public static let authHeader =
        #"MediaBrowser Client="dumbTV", Device="dumbTV", DeviceId="dumbtv-apple", Version="1.0""#

    private let session: URLSession
    private var server: JellyfinServer?

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func configure(_ server: JellyfinServer?) { self.server = server }
    public func current() -> JellyfinServer? { server }

    /// Load the persisted server out of the Store (mirrors `getJfServer()`).
    public func configure(from store: Store) {
        guard let url = store.getSetting("jellyfin_url"),
              let token = store.getSetting("jellyfin_token"),
              let user = store.getSetting("jellyfin_user"), !url.isEmpty, !token.isEmpty
        else { server = nil; return }
        server = JellyfinServer(url: url, token: token, userId: user,
                                name: store.getSetting("jellyfin_name") ?? "Jellyfin")
    }

    private func require() throws -> JellyfinServer {
        guard let server, !server.url.isEmpty, !server.token.isEmpty else { throw JellyfinError.noServer }
        return server
    }

    static func trimURL(_ u: String) -> String {
        var s = u.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    // MARK: - requests

    private func get(_ path: String) async throws -> [String: Any] {
        let data = try await getData(path)
        guard let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw JellyfinError.badResponse
        }
        return j
    }

    private func getData(_ path: String) async throws -> Data {
        let s = try require()
        guard let url = URL(string: "\(s.url)\(path)") else { throw JellyfinError.badResponse }
        var req = URLRequest(url: url)
        req.setValue(s.token, forHTTPHeaderField: "X-Emby-Token")
        req.setValue(Self.authHeader, forHTTPHeaderField: "X-Emby-Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw JellyfinError.badResponse }
        guard (200..<300).contains(http.statusCode) else { throw JellyfinError.http(http.statusCode) }
        return data
    }

    // MARK: - auth

    /// Log in with a username and password. Jellyfin returns an access token and
    /// the user id; both are needed for every later call.
    public func authenticate(url: String, username: String, password: String) async throws -> JellyfinServer {
        let base = Self.trimURL(url)
        guard !base.isEmpty, let u = URL(string: "\(base)/Users/AuthenticateByName") else {
            throw JellyfinError.missingAddress
        }
        var req = URLRequest(url: u)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(Self.authHeader, forHTTPHeaderField: "X-Emby-Authorization")
        req.httpBody = try JSONSerialization.data(
            withJSONObject: ["Username": username, "Pw": password])
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw JellyfinError.rejectedLogin(code) }
        guard let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = j["AccessToken"] as? String, !token.isEmpty,
              let user = j["User"] as? [String: Any], let uid = user["Id"] as? String
        else { throw JellyfinError.badResponse }
        let s = JellyfinServer(url: base, token: token, userId: uid,
                               name: (user["Name"] as? String) ?? "Jellyfin")
        server = s
        return s
    }

    /// Or connect with a server URL, user id, and a dashboard API key.
    public func useApiKey(url: String, userId: String, apiKey: String) -> JellyfinServer {
        let s = JellyfinServer(url: Self.trimURL(url), token: apiKey, userId: userId, name: "API key")
        server = s
        return s
    }

    public func ping() async -> Bool {
        guard let s = server, let u = URL(string: "\(s.url)/System/Info/Public") else { return false }
        var req = URLRequest(url: u)
        req.timeoutInterval = 5
        guard let (_, resp) = try? await session.data(for: req) else { return false }
        return (200..<300).contains((resp as? HTTPURLResponse)?.statusCode ?? -1)
    }

    // MARK: - library

    private static func ticksToMs(_ t: Any?) -> Millis {
        guard let n = t as? NSNumber else { return 0 }
        return Millis((n.doubleValue / 10_000).rounded())
    }
    private static func airedOf(_ iso: Any?) -> String? {
        guard let s = iso as? String, s.count >= 10 else { return nil }
        return String(s.prefix(10))
    }
    /// Verified live: an item with no artwork 404s on `/Items/:id/Images/Primary`,
    /// and `ImageTags.Primary` is how you know in advance. Claiming a poster that
    /// doesn't exist just makes the picker ask for an image it can't have.
    private static func thumbOf(_ m: [String: Any]) -> String? {
        guard let tags = m["ImageTags"] as? [String: Any], tags["Primary"] != nil else { return nil }
        return m["Id"] as? String
    }

    /// Libraries, mapped to dumbTV's show/movie section types.
    public func sections() async throws -> [PlexSection] {
        let s = try require()
        let j = try await get("/Users/\(s.userId)/Views")
        return ((j["Items"] as? [[String: Any]]) ?? []).compactMap { v in
            let collection = v["CollectionType"] as? String
            let type = collection == "movies" ? "movie" : (collection == "tvshows" ? "show" : (collection ?? ""))
            guard type == "show" || type == "movie", let id = v["Id"] as? String else { return nil }
            return PlexSection(key: id, title: v["Name"] as? String ?? "", type: type)
        }
    }

    /// Top-level items in a library: series or movies.
    public func sectionItems(key: String, type: String) async throws -> [PlexItem] {
        let s = try require()
        let kind = (type == "movie") ? "Movie" : "Series"
        let j = try await get("/Users/\(s.userId)/Items?ParentId=\(key)&IncludeItemTypes=\(kind)"
                              + "&Recursive=true&SortBy=SortName&Fields=ChildCount,RecursiveItemCount")
        return ((j["Items"] as? [[String: Any]]) ?? []).compactMap { m in
            guard let id = m["Id"] as? String else { return nil }
            return PlexItem(ratingKey: id, title: m["Name"] as? String ?? "",
                            type: type == "movie" ? "movie" : "show", thumb: Self.thumbOf(m))
        }
    }

    /// Every episode under a series, in one request.
    public func episodes(showKey: String) async throws -> [Media] {
        let s = try require()
        let j = try await get("/Shows/\(showKey)/Episodes?userId=\(s.userId)&Fields=PremiereDate,MediaSources")
        return ((j["Items"] as? [[String: Any]]) ?? []).compactMap { m in
            guard let id = m["Id"] as? String else { return nil }
            let dur = Self.ticksToMs(m["RunTimeTicks"])
            guard dur > 0 else { return nil }
            return Media(ratingKey: id, parentKey: showKey, kind: .episode,
                         title: m["Name"] as? String ?? "Episode",
                         showTitle: m["SeriesName"] as? String,
                         seasonNo: m["ParentIndexNumber"] as? Int,
                         episodeNo: m["IndexNumber"] as? Int,
                         aired: Self.airedOf(m["PremiereDate"]),
                         durationMs: dur, partKey: "\(jellyfinPrefix)\(id)")
        }
    }

    public func movie(ratingKey: String) async throws -> Media? {
        let s = try require()
        let m = try await get("/Users/\(s.userId)/Items/\(ratingKey)")
        guard let id = m["Id"] as? String else { return nil }
        let dur = Self.ticksToMs(m["RunTimeTicks"])
        guard dur > 0 else { return nil }
        return Media(ratingKey: id, parentKey: nil, kind: .movie,
                     title: m["Name"] as? String ?? "Movie", showTitle: nil,
                     seasonNo: nil, episodeNo: nil, aired: Self.airedOf(m["PremiereDate"]),
                     durationMs: dur, partKey: "\(jellyfinPrefix)\(id)")
    }

    /// The poster id for any item (show or movie) — used as channel art. Nil when
    /// the item genuinely has no artwork.
    public func thumbPath(ratingKey: String) async throws -> String? {
        let s = try require()
        return Self.thumbOf(try await get("/Users/\(s.userId)/Items/\(ratingKey)"))
    }

    /// Raw bytes for an item's poster, for the app's image proxy.
    public func imageData(itemId: String, width: Int = 300, height: Int = 450) async throws -> Data? {
        try await getData("/Items/\(itemId)/Images/Primary?fillWidth=\(width)&fillHeight=\(height)")
    }

    /// A URL VLCKit can direct-play. `static=true` = never transcode (invariant #2).
    /// Verified live: this serves real bytes and honours Range requests, which is
    /// what makes join-in-progress work.
    public func streamURL(partKey: String) -> URL? {
        guard let s = server else { return nil }
        return URL(string: Self.streamURLString(partKey: partKey, server: s))
    }

    /// The URL shape, without needing the actor — so a synchronous caller (the
    /// player's `streamURL`) can build it straight from Store settings.
    public static func streamURLString(partKey: String, server s: JellyfinServer) -> String {
        let id = partKey.hasPrefix(jellyfinPrefix) ? String(partKey.dropFirst(jellyfinPrefix.count)) : partKey
        return "\(s.url)/Videos/\(id)/stream?static=true&mediaSourceId=\(id)&api_key=\(s.token)"
    }
}

/// Part keys from Jellyfin carry this prefix, so playback can dispatch on the key
/// shape rather than on which backend happens to be active — a schedule cached
/// under one backend still plays after switching (mirrors `media/backend.js`).
public let jellyfinPrefix = "jf:"

extension Store {
    /// The persisted Jellyfin server, if one is connected. These keys are already
    /// in `durableKeys`, so the link survives a tvOS Caches purge.
    public func jellyfinServer() -> JellyfinServer? {
        guard let url = getSetting("jellyfin_url"), let token = getSetting("jellyfin_token"),
              let user = getSetting("jellyfin_user"), !url.isEmpty, !token.isEmpty
        else { return nil }
        return JellyfinServer(url: url, token: token, userId: user,
                              name: getSetting("jellyfin_name") ?? "Jellyfin")
    }

    public func saveJellyfinServer(_ s: JellyfinServer) {
        setSetting("jellyfin_url", s.url)
        setSetting("jellyfin_token", s.token)
        setSetting("jellyfin_user", s.userId)
        setSetting("jellyfin_name", s.name)
    }

    public func clearJellyfinServer() {
        for k in ["jellyfin_url", "jellyfin_token", "jellyfin_user", "jellyfin_name"] {
            setSetting(k, nil)
        }
    }

    /// Which media backend is active. Plex unless explicitly switched.
    public var mediaBackend: String {
        getSetting("media_backend") == "jellyfin" ? "jellyfin" : "plex"
    }
}
