import Foundation

/// Plex protocol, ported from `src/plex/auth.js` + `src/plex/client.js`.
/// Pure Foundation/URLSession, so it runs on the Mac host, the simulator, and
/// the device unchanged. Carries the lessons already learned: the short (non-
/// strong) PIN code, and preferring a reachable connection (local, then WAN,
/// then relay).

public struct PlexServer: Identifiable, Sendable {
    public var id: String { clientIdentifier }
    public let name: String
    public let clientIdentifier: String
    public let accessToken: String
    public let connections: [Connection]

    public struct Connection: Sendable {
        public let uri: String
        public let local: Bool
        public let relay: Bool
    }
    /// Best guess: local first, then non-relay WAN, then relay.
    public var preferredURI: String? {
        connections.sorted { score($0) < score($1) }.first?.uri
    }
    private func score(_ c: Connection) -> Int { c.relay ? 2 : (c.local ? 0 : 1) }
}

public struct PlexSection: Identifiable, Sendable {
    public var id: String { key }
    public let key: String
    public let title: String
    public let type: String    // show | movie | ...
}

public struct PlexPin: Sendable {
    public let id: Int
    public let code: String
    public let expiresAt: String?
}

public enum PlexError: Error { case http(Int), badResponse, noServerSelected }

public actor PlexClient {
    private let session: URLSession
    private let clientID: String
    public private(set) var token: String?
    public private(set) var serverURI: String?
    public private(set) var accessToken: String?

    public init(clientID: String = "cathode-apple", session: URLSession = .shared) {
        self.clientID = clientID
        self.session = session
    }

    public func configure(token: String?, serverURI: String?, accessToken: String?) {
        self.token = token
        self.serverURI = serverURI
        self.accessToken = accessToken
    }

    private var headers: [String: String] {
        [
            "X-Plex-Product": "Cathode",
            "X-Plex-Version": "0.1.0",
            "X-Plex-Client-Identifier": clientID,
            "X-Plex-Device": "Cathode",
            "Accept": "application/json",
        ]
    }

    private func get(_ url: URL, token: String? = nil) async throws -> Data {
        var req = URLRequest(url: url)
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        if let token { req.setValue(token, forHTTPHeaderField: "X-Plex-Token") }
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw PlexError.badResponse }
        guard (200..<300).contains(http.statusCode) else { throw PlexError.http(http.statusCode) }
        return data
    }

    // MARK: PIN link (no strong=true — that returns a code plex.tv/link rejects)

    public func createPin() async throws -> PlexPin {
        var req = URLRequest(url: URL(string: "https://plex.tv/api/v2/pins")!)
        req.httpMethod = "POST"
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw PlexError.http((resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
        let j = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        guard let id = j["id"] as? Int, let code = j["code"] as? String else { throw PlexError.badResponse }
        return PlexPin(id: id, code: code, expiresAt: j["expiresAt"] as? String)
    }

    /// Poll until the user finishes linking. Returns a token, or nil if not yet.
    public func checkPin(id: Int) async throws -> String? {
        let data = try await get(URL(string: "https://plex.tv/api/v2/pins/\(id)")!)
        let j = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        let t = j["authToken"] as? String
        return (t?.isEmpty == false) ? t : nil
    }

    // MARK: servers

    public func listServers(token: String) async throws -> [PlexServer] {
        let url = URL(string: "https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1")!
        let data = try await get(url, token: token)
        let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] ?? []
        return arr.compactMap { r -> PlexServer? in
            guard let provides = r["provides"] as? String, provides.contains("server") else { return nil }
            let conns = (r["connections"] as? [[String: Any]] ?? []).map {
                PlexServer.Connection(uri: $0["uri"] as? String ?? "",
                                      local: ($0["local"] as? Bool) ?? false,
                                      relay: ($0["relay"] as? Bool) ?? false)
            }.filter { !$0.uri.isEmpty }
            guard !conns.isEmpty else { return nil }
            return PlexServer(name: r["name"] as? String ?? "Plex",
                              clientIdentifier: r["clientIdentifier"] as? String ?? UUID().uuidString,
                              accessToken: (r["accessToken"] as? String) ?? token,
                              connections: conns)
        }
    }

    // MARK: library

    private func containerGet(_ path: String) async throws -> [String: Any] {
        guard let serverURI, let accessToken else { throw PlexError.noServerSelected }
        let sep = path.contains("?") ? "&" : "?"
        let url = URL(string: "\(serverURI)\(path)\(sep)X-Plex-Token=\(accessToken)")!
        let data = try await get(url)
        let j = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        return j["MediaContainer"] as? [String: Any] ?? [:]
    }

    public func sections() async throws -> [PlexSection] {
        let mc = try await containerGet("/library/sections")
        return (mc["Directory"] as? [[String: Any]] ?? []).map {
            PlexSection(key: "\($0["key"] ?? "")", title: $0["title"] as? String ?? "",
                        type: $0["type"] as? String ?? "")
        }
    }

    /// Every episode under a show, in one request (`/allLeaves`).
    public func episodes(showKey: String) async throws -> [Media] {
        let mc = try await containerGet("/library/metadata/\(showKey)/allLeaves")
        return (mc["Metadata"] as? [[String: Any]] ?? []).compactMap { m in
            let media = m["Media"] as? [[String: Any]]
            let part = (media?.first?["Part"] as? [[String: Any]])?.first
            let partKey = part?["key"] as? String
            let dur = (m["duration"] as? Int).map(Int64.init) ?? 0
            guard let partKey, dur > 0 else { return nil }
            return Media(
                ratingKey: "\(m["ratingKey"] ?? "")",
                parentKey: showKey,
                kind: .episode,
                title: m["title"] as? String ?? "Episode",
                showTitle: m["grandparentTitle"] as? String,
                seasonNo: m["parentIndex"] as? Int,
                episodeNo: m["index"] as? Int,
                aired: m["originallyAvailableAt"] as? String,
                durationMs: dur,
                partKey: partKey
            )
        }
    }

    /// A URL VLCKit can direct-play. No transcoding, ever.
    public func streamURL(partKey: String) -> URL? {
        guard let serverURI, let accessToken else { return nil }
        return URL(string: "\(serverURI)\(partKey)?X-Plex-Token=\(accessToken)")
    }
}
