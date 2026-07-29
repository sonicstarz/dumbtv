import Foundation
import SwiftUI
import dumbTVCore

/// State behind the native Setup surface.
///
/// The important architectural point: this does NOT reimplement any config
/// logic. It calls the same `ConfigAPI` the web UI calls, in-process, with the
/// same paths and the same bodies — `POST /api/plex/pin`, `GET /api/library/sections`,
/// `POST /api/channels`. Validation, PIN auth, channel numbering, source
/// resolution and the change broadcast all stay in exactly one place.
///
/// So "native Setup" forks the VIEW, not the RULES. There is one API contract
/// (docs/api-contract.md) and both front-ends speak it. That is what keeps the
/// Pi/Node web path and the Apple native path from drifting apart, and it is why
/// this cost a view layer rather than a rewrite.
@MainActor
final class SetupModel: ObservableObject {

    // MARK: - Where we are

    enum Backend: String { case plex, jellyfin, none }

    @Published var backend: Backend = .none
    @Published var plexLinked = false
    @Published var plexServerName: String?
    @Published var jellyfinURL: String?
    @Published var jellyfinUser: String?

    /// Plex device-link, in flight. The code is what the user types on another
    /// device; we poll until it turns into a token.
    @Published var pinCode: String?
    @Published var pinPolling = false
    @Published var plexServers: [PickServer] = []

    @Published var libraries: [PickLibrary] = []
    @Published var selectedLibraryKeys: Set<String> = []

    @Published var channels: [PickChannel] = []

    /// Read from `/api/status`, never hardcoded — the web UI renders its ORDER
    /// dropdown from the same list, so the two surfaces cannot offer different
    /// modes or describe them differently.
    @Published var orderingModes: [OrderingChoice] = []

    struct OrderingChoice: Identifiable, Hashable {
        let id: String
        let label: String
        let blurb: String
    }

    @Published var busy: String?          // non-nil = a request is in flight
    @Published var error: String?
    @Published var notice: String?

    /// Carries the WHOLE server JSON, not just a name and a uri.
    /// `POST /api/plex/server` needs `accessToken` and the full `connections`
    /// array — it probes them for the first that actually responds, which is the
    /// fix for "linked but can't connect" (the local address is frequently
    /// unreachable even when the plex.direct one works). Reducing this to a
    /// single uri here would throw away the addresses that probe depends on.
    struct PickServer: Identifiable, Hashable {
        let id: String       // clientIdentifier
        let name: String
        let raw: [String: Any]

        static func == (a: Self, b: Self) -> Bool { a.id == b.id }
        func hash(into h: inout Hasher) { h.combine(id) }
    }
    struct PickLibrary: Identifiable, Hashable {
        let id: String       // section key
        let title: String
        let type: String     // show | movie
    }
    struct PickChannel: Identifiable, Hashable {
        let id: String
        let number: Int
        let name: String
    }

    private let api: ConfigAPI?
    private var pinID: Int?
    private var pollTask: Task<Void, Never>?

    init(api: ConfigAPI?) { self.api = api }

    deinit { pollTask?.cancel() }

    // MARK: - The one call everything goes through

    /// Speak to ConfigAPI the way the web UI does. Returns the decoded JSON
    /// object, or nil after publishing the error the API reported — the UI never
    /// shows a raw status code.
    @discardableResult
    private func call(_ method: String, _ path: String,
                      _ body: [String: Any]? = nil,
                      query: [String: String] = [:]) async -> [String: Any]? {
        guard let api else { error = "The on-device backend did not start. See DIAGNOSTICS below."; return nil }
        let res = await api.handle(.init(method: method, path: path, query: query, body: body))
        guard let obj = res.json as? [String: Any] else {
            // A route that answers with an array (e.g. a bare list) is wrapped so
            // callers have one shape to read.
            if let arr = res.json as? [Any], (200..<300).contains(res.status) { return ["items": arr] }
            error = "Unexpected response from \(path)"
            return nil
        }
        guard (200..<300).contains(res.status) else {
            error = (obj["error"] as? String) ?? "Request failed (\(res.status))"
            return nil
        }
        return obj
    }

    // MARK: - Load

    func refresh() async {
        busy = "Loading…"
        defer { busy = nil }

        // `/api/status` reports the ACTIVE backend: `backend`, `linked`, and
        // `server` as {name, uri, local} or null. It does not carry a separate
        // plex/jellyfin split — that comes from /api/jellyfin/status.
        if let s = await call("GET", "/api/status") {
            backend = Backend(rawValue: (s["backend"] as? String) ?? "") ?? .none
            let linked = (s["linked"] as? Bool) ?? false
            let srv = s["server"] as? [String: Any]
            if backend == .jellyfin {
                plexLinked = false
                jellyfinURL = srv?["uri"] as? String
            } else {
                plexLinked = linked
                plexServerName = srv?["name"] as? String
            }
            orderingModes = ((s["orderingModes"] as? [[String: Any]]) ?? []).compactMap { m in
                guard let id = m["id"] as? String else { return nil }
                return OrderingChoice(id: id, label: (m["label"] as? String) ?? id,
                                      blurb: (m["blurb"] as? String) ?? "")
            }
        }
        // Jellyfin can be configured while Plex is the active backend, so read it
        // regardless — Setup shows both so "what am I linked to?" is answerable.
        if let j = await call("GET", "/api/jellyfin/status"),
           (j["configured"] as? Bool) == true,
           let srv = j["server"] as? [String: Any] {
            jellyfinURL = srv["url"] as? String
            jellyfinUser = srv["name"] as? String
        }
        await loadChannels()
        if isLinked { await loadLibraries() }
    }

    var isLinked: Bool {
        switch backend {
        case .plex:     return plexLinked
        case .jellyfin: return jellyfinURL != nil
        case .none:     return plexLinked || jellyfinURL != nil
        }
    }

    /// What the user is actually linked to, for display. Named rather than
    /// inferred, because "am I linked?" being unanswerable on-device is the whole
    /// of the F7 confusion.
    var linkSummary: String {
        if plexLinked { return "Plex" + (plexServerName.map { " · \($0)" } ?? "") }
        if let u = jellyfinURL { return "Jellyfin · \(u)" }
        return "Nothing linked yet"
    }

    func loadChannels() async {
        guard let r = await call("GET", "/api/channels") else { return }
        let raw = (r["channels"] as? [[String: Any]]) ?? []
        channels = raw.compactMap { c in
            guard let id = c["id"] as? Int, let n = c["number"] as? Int else { return nil }
            return PickChannel(id: String(id), number: n, name: (c["name"] as? String) ?? "—")
        }.sorted { $0.number < $1.number }
    }

    func loadLibraries() async {
        guard let r = await call("GET", "/api/library/sections") else { return }
        let raw = (r["sections"] as? [[String: Any]]) ?? []
        libraries = raw.compactMap { s in
            guard let key = s["key"] as? String else { return nil }
            return PickLibrary(id: key, title: (s["title"] as? String) ?? key,
                               type: (s["type"] as? String) ?? "show")
        }
    }

    // MARK: - O2 · Plex device link

    /// Start the PIN flow and poll until it resolves.
    ///
    /// This is the flow that makes native setup viable on a remote at all: the
    /// user never types a password, they type a 4-character code on a device that
    /// already has a keyboard. Plex built it for exactly this situation.
    func startPlexLink() async {
        error = nil; notice = nil
        busy = "Asking Plex for a code…"
        defer { busy = nil }
        guard let r = await call("POST", "/api/plex/pin") else { return }
        guard let code = r["code"] as? String,
              let id = (r["id"] as? Int) ?? (r["id"] as? String).flatMap(Int.init) else {
            error = "Plex did not return a link code."; return
        }
        pinCode = code
        pinID = id
        pinPolling = true
        pollTask?.cancel()
        pollTask = Task { [weak self] in await self?.pollPin(id: id) }
    }

    private func pollPin(id: Int) async {
        // Plex expires a PIN after ~15 minutes; stop well before that rather
        // than polling a dead code forever.
        let deadline = Date().addingTimeInterval(15 * 60)
        while !Task.isCancelled, Date() < deadline {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if Task.isCancelled { return }
            guard let r = await call("GET", "/api/plex/pin/\(id)") else { break }
            let token = (r["token"] as? String) ?? (r["authToken"] as? String)
            if let token, !token.isEmpty {
                pinPolling = false
                pinCode = nil
                await afterPlexToken()
                return
            }
        }
        pinPolling = false
        if pinCode != nil { error = "That code expired. Start the link again." }
        pinCode = nil
    }

    func cancelPlexLink() {
        pollTask?.cancel()
        pinPolling = false
        pinCode = nil
    }

    /// Token in hand — list the servers so the user can pick one.
    private func afterPlexToken() async {
        busy = "Finding your servers…"
        defer { busy = nil }
        guard let r = await call("GET", "/api/plex/servers") else { return }
        let raw = (r["servers"] as? [[String: Any]]) ?? []
        plexServers = raw.compactMap { s in
            guard let id = s["clientIdentifier"] as? String else { return nil }
            return PickServer(id: id, name: (s["name"] as? String) ?? "Plex Server", raw: s)
        }
        if plexServers.count == 1 {
            // One server is the overwhelmingly common case — don't make someone
            // confirm a list of one with a D-pad.
            await chooseServer(plexServers[0])
        } else if plexServers.isEmpty {
            error = "Linked, but no Plex servers were reachable from this device."
        } else {
            notice = "Linked. Choose which server to use."
        }
    }

    func chooseServer(_ s: PickServer) async {
        busy = "Connecting to \(s.name)…"
        defer { busy = nil }
        // Pass the server JSON straight through. The API wants accessToken +
        // connections so it can probe for one that responds.
        guard await call("POST", "/api/plex/server", s.raw) != nil else { return }
        await call("POST", "/api/media/backend", ["backend": "plex"])
        plexServers = []
        notice = "Connected to \(s.name)."
        await refresh()
    }

    func unlinkPlex() async {
        busy = "Unlinking…"
        defer { busy = nil }
        guard await call("POST", "/api/plex/logout") != nil else { return }
        plexLinked = false; plexServerName = nil; libraries = []
        notice = "Plex unlinked."
        await refresh()
    }

    // MARK: - O2 · Jellyfin

    func connectJellyfin(url: String, user: String, pass: String) async {
        error = nil; notice = nil
        let u = url.trimmingCharacters(in: .whitespaces)
        guard !u.isEmpty else { error = "Enter your Jellyfin address."; return }
        busy = "Connecting to Jellyfin…"
        defer { busy = nil }
        guard await call("POST", "/api/jellyfin/connect",
                         ["url": u, "username": user, "password": pass]) != nil else { return }
        await call("POST", "/api/media/backend", ["backend": "jellyfin"])
        notice = "Connected to Jellyfin."
        await refresh()
    }

    func unlinkJellyfin() async {
        busy = "Unlinking…"
        defer { busy = nil }
        guard await call("POST", "/api/jellyfin/logout") != nil else { return }
        jellyfinURL = nil; jellyfinUser = nil; libraries = []
        notice = "Jellyfin unlinked."
        await refresh()
    }

    // MARK: - O4 · Minimal channel creation

    /// Deliberately minimal: a name, a number, one library, an ordering mode.
    /// Bulk curation, per-item overrides, excludes and rules stay on the web UI —
    /// the bar here is "device in hand, you get to a watchable channel", not
    /// "replace the config app".
    func createChannel(name: String, number: Int, library: PickLibrary,
                       ordering: String) async -> Bool {
        error = nil; notice = nil
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { error = "Give the channel a name."; return false }
        busy = "Reading \(library.title)…"
        defer { busy = nil }

        // A LIBRARY IS NOT A SOURCE. `/api/channels/:id/sources` takes individual
        // shows/movies by ratingKey — so "use this library" means enumerate it
        // first and add every item. Handing it a section key would create a
        // channel with zero sources: an empty listing, which on a television is
        // indistinguishable from a bug.
        guard let listed = await call("GET", "/api/library/sections/\(library.id)/items",
                                      query: ["type": library.type]) else { return false }
        let raw = (listed["items"] as? [[String: Any]]) ?? []
        guard !raw.isEmpty else {
            error = "\(library.title) came back empty. Pick another library."
            return false
        }
        let items: [[String: Any]] = raw.compactMap { i in
            guard let rk = i["ratingKey"] as? String else { return nil }
            var o: [String: Any] = ["ratingKey": rk, "sourceType": library.type]
            if let t = i["title"] as? String { o["title"] = t }
            if let th = i["thumb"] as? String { o["thumb"] = th }
            return o
        }

        busy = "Creating \(trimmed)…"
        // `number` is a PREFERENCE, not a reservation: the API runs it through
        // freeChannelNumber() and hands back whatever it actually assigned. Read
        // that back rather than echoing what we asked for, or the success message
        // names a channel the user cannot tune to.
        guard let made = await call("POST", "/api/channels",
                                    ["name": trimmed, "number": number,
                                     "orderingMode": ordering]) else { return false }
        guard let chanID = (made["id"] as? Int) else {
            error = "The channel was created but returned no id."; return false
        }
        let assigned = (made["number"] as? Int) ?? number

        busy = "Adding \(items.count) title(s)…"
        guard await call("POST", "/api/channels/\(chanID)/sources", ["items": items]) != nil else {
            error = "Created \(trimmed) on channel \(assigned), but adding titles failed. Finish it in the web UI."
            await loadChannels()
            return false
        }
        await call("POST", "/api/channels/\(chanID)/refresh")
        notice = "Channel \(assigned) — \(trimmed) is ready. Close Setup and tune to it."
        await loadChannels()
        return true
    }

    /// A suggestion for the number field. Only a suggestion — the API assigns the
    /// real one and will not collide.
    var suggestedChannelNumber: Int {
        var n = 2                                  // 1 is SPACE, a locked built-in
        let taken = Set(channels.map(\.number))
        while taken.contains(n) { n += 1 }
        return n
    }
}
