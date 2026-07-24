import SwiftUI
import dumbTVCore

/// One channel's precomputed schedule plus the media lookup for playback.
struct ChannelRuntime {
    let spec: ChannelSpec
    let programs: [Program]
    let mediaByKey: [String: Media]
}

/// A single row of the guide at a moment in time.
struct GuideEntry: Identifiable {
    let id: Int          // channel index
    let number: Int
    let name: String
    let now: Airing?
    let next: Program?
}

/// The once-a-second loop that makes reality match the schedule — the Swift
/// counterpart of `src/player/engine.js`. Re-derives from the clock, never a timer.
@MainActor
final class Engine: ObservableObject {
    let plex = PlexClient()
    let player = Player()

    @Published var channels: [ChannelRuntime] = []
    @Published var currentIndex = 0
    @Published var now: Airing?
    @Published var guideOpen = false
    @Published var linked = false
    @Published var demo = false
    @Published var status = "Starting…"
    /// A transient on-screen glyph: "⊘" when a blocked key is pressed (invariant
    /// #1 — no pause/seek on live), or "CH n" on a channel change.
    @Published var flash: String?
    /// Digits being dialed for direct channel entry, shown until they commit.
    @Published var dialing = ""

    private var currentStart: Millis = -1
    private var tick: Timer?
    private var flashTask: Task<Void, Never>?
    private var dialTask: Task<Void, Never>?
    private var serverURI = ""
    private var accessToken = ""

    var channelName: String { channels.indices.contains(currentIndex) ? channels[currentIndex].spec.name : "" }
    var channelNumber: Int { channels.indices.contains(currentIndex) ? channels[currentIndex].spec.number : 0 }

    private func nowMs() -> Millis { Millis(Date().timeIntervalSince1970 * 1000) }
    private func streamURL(_ partKey: String) -> URL? {
        // Demo lineup plays a bundled test clip; everything else is a Plex part.
        if partKey.hasPrefix("demo:") {
            return Bundle.main.url(forResource: "demo-loop", withExtension: "mp4")
        }
        return URL(string: "\(serverURI)\(partKey)?X-Plex-Token=\(accessToken)")
    }

    /// Dev/simulator: seed straight from env so we can play without the PIN link.
    func bootstrapFromEnvIfPresent() async {
        let env = ProcessInfo.processInfo.environment
        guard let token = env["DUMBTV_PLEX_TOKEN"], !token.isEmpty,
              let uri = env["DUMBTV_PLEX_URI"], !uri.isEmpty,
              let access = env["DUMBTV_PLEX_ACCESS"], !access.isEmpty else {
            // No Plex? Be a working television anyway, off a bundled clip — so a
            // stranger (and App Review) sees the product before linking a library.
            startDemoLineup()
            return
        }
        await plex.configure(token: token, serverURI: uri, accessToken: access)
        serverURI = uri
        accessToken = access
        linked = true

        // A starter lineup from the library.
        let lineup: [(Int, Int, String, OrderingMode, String, UInt32)] = [
            (2, 2, "Retro Toons", .shuffle, "11605", 12002),      // The Transformers
            (3, 3, "The Bat Channel", .sequential, "601", 12003), // Batman: TAS
            (4, 4, "Marvel Cartoons", .sequential, "1917", 12004),// Avengers: EMH
            (5, 5, "Star Wars", .release_order, "1589", 12005),   // Clone Wars
        ]
        for (id, number, name, mode, showKey, seed) in lineup {
            await addChannel(id: id, number: number, name: name, mode: mode, showKey: showKey, seed: seed)
        }
        startTicking()
        if env["DUMBTV_START_GUIDE"] == "1" { guideOpen = true }
    }

    /// Prefer configured channels from the Store; fall back to env Plex, then
    /// the built-in demo. This is how the player and the web config share one
    /// source of truth on a self-contained device.
    func bootstrap(store: Store?) async {
        if let store, loadFromStore(store) { return }
        await bootstrapFromEnvIfPresent()
    }

    /// Build runtimes from the persisted channels + cached library. The
    /// generator is deterministic, so this matches what the config UI's guide
    /// shows. Returns false if nothing is configured/cached yet (caller falls back).
    private func loadFromStore(_ store: Store) -> Bool {
        let cfgs = store.allChannels().filter { $0.enabled }
        guard !cfgs.isEmpty else { return false }
        serverURI = store.getSetting("plex_server_uri") ?? ""
        accessToken = store.getSetting("plex_access_token") ?? ""
        let now = nowMs()
        var built: [ChannelRuntime] = []
        for c in cfgs {
            let buckets = store.library(forChannel: c.id).sourceBuckets()
            guard !buckets.isEmpty else { continue }   // no media cached yet
            let programs = Generator.generate(channel: c.spec, buckets: buckets,
                                              now: now, windowMs: 24 * 3_600_000)
            var lookup: [String: Media] = [:]
            for m in buckets.flatMap({ $0 }) { lookup[m.ratingKey] = m }
            built.append(ChannelRuntime(spec: c.spec, programs: programs, mediaByKey: lookup))
        }
        guard !built.isEmpty else { return false }
        channels = built
        linked = true
        status = ""
        startTicking()
        return true
    }

    private func addChannel(id: Int, number: Int, name: String, mode: OrderingMode, showKey: String, seed: UInt32) async {
        status = "Loading \(name)…"
        do {
            let eps = try await plex.episodes(showKey: showKey)
            var lookup: [String: Media] = [:]
            for e in eps { lookup[e.ratingKey] = e }
            let spec = ChannelSpec(id: id, number: number, name: name, orderingMode: mode, shuffleSeed: seed)
            let programs = Generator.generate(channel: spec, buckets: [eps], now: nowMs(), windowMs: 24 * 3600 * 1000)
            channels.append(ChannelRuntime(spec: spec, programs: programs, mediaByKey: lookup))
        } catch {
            status = "Couldn't load \(name)"
        }
    }

    /// A self-contained lineup with no Plex, playing a bundled test clip. Episode
    /// durations stay under the clip length so join-in-progress seeks land inside
    /// the file. Deterministic, like the real thing.
    func startDemoLineup() {
        demo = true
        let now = nowMs()
        let window: Millis = 24 * 3600 * 1000

        func show(_ key: String, _ title: String, _ eps: Int, _ secs: [Int]) -> [Media] {
            (1...eps).map { i in
                Media(ratingKey: "\(key)-e\(i)", parentKey: key, kind: .episode,
                      title: "Episode \(i)", showTitle: title, seasonNo: 1, episodeNo: i,
                      aired: String(format: "1994-09-%02d", min(i, 28)),
                      durationMs: Millis(secs[(i - 1) % secs.count]) * 1000, partKey: "demo:loop")
            }
        }
        let toons  = show("demo-toons",  "Rerun Theatre",   8, [95, 80, 110, 70])
        let action = show("demo-action", "The Bat Channel", 6, [105, 88, 96])
        let space  = show("demo-space",  "Star Patrol",     6, [92, 78, 114, 84])

        let lineup: [(ChannelSpec, [[Media]])] = [
            (ChannelSpec(id: 2, number: 2, name: "Retro Toons",     orderingMode: .shuffle,       shuffleSeed: 12002), [toons]),
            (ChannelSpec(id: 3, number: 3, name: "The Bat Channel", orderingMode: .sequential,    shuffleSeed: 12003), [action]),
            (ChannelSpec(id: 4, number: 4, name: "Star Patrol",     orderingMode: .release_order, shuffleSeed: 12004), [space]),
        ]
        var built: [ChannelRuntime] = []
        for (spec, buckets) in lineup {
            var lookup: [String: Media] = [:]
            for m in buckets.flatMap({ $0 }) { lookup[m.ratingKey] = m }
            let programs = Generator.generate(channel: spec, buckets: buckets, now: now, windowMs: window)
            built.append(ChannelRuntime(spec: spec, programs: programs, mediaByKey: lookup))
        }
        channels = built
        startTicking()
    }

    func tune(to index: Int) {
        guard channels.indices.contains(index) else { return }
        currentIndex = index
        currentStart = -1
        guideOpen = false
        sync()
    }

    // MARK: - remote / keyboard control (a cable box you turn the dial on)

    func channelUp()   { surf(+1) }
    func channelDown() { surf(-1) }

    private func surf(_ delta: Int) {
        guard !channels.isEmpty else { return }
        let next = ((currentIndex + delta) % channels.count + channels.count) % channels.count
        tune(to: next)
        showFlash("CH \(String(format: "%02d", channelNumber))")
    }

    /// Invariant #1: pause/seek/resume do nothing on a live channel — flash ⊘.
    func blocked() { showFlash("⊘") }

    /// Direct channel entry: accumulate digits, commit after a short window.
    func pressDigit(_ d: String) {
        dialing = String((dialing + d).suffix(3))
        dialTask?.cancel()
        dialTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            self?.commitDial()
        }
    }

    private func commitDial() {
        defer { dialing = "" }
        guard let n = Int(dialing) else { return }
        if let idx = channels.firstIndex(where: { $0.spec.number == n }) {
            tune(to: idx)
            showFlash("CH \(String(format: "%02d", n))")
        } else {
            showFlash("⊘")
        }
    }

    private func showFlash(_ s: String) {
        flash = s
        flashTask?.cancel()
        flashTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_100_000_000)
            if self?.flash == s { self?.flash = nil }
        }
    }

    private func startTicking() {
        status = ""
        sync()
        tick?.invalidate()
        tick = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sync() }
        }
    }

    private func sync() {
        guard channels.indices.contains(currentIndex) else { return }
        let ch = channels[currentIndex]
        guard let airing = Resolver.nowOn(ch.programs, at: nowMs()) else { return }
        now = airing
        let p = airing.program
        guard p.startUtc != currentStart else { return }
        currentStart = p.startUtc
        guard let key = p.ratingKey, let media = ch.mediaByKey[key], let pk = media.partKey,
              let url = streamURL(pk) else { return }
        player.play(url: url, startSeconds: Int(airing.offsetMs / 1000))
    }

    /// Guide rows for every channel at the current instant.
    func guideRows() -> [GuideEntry] {
        let at = nowMs()
        return channels.enumerated().map { i, ch in
            GuideEntry(id: i, number: ch.spec.number, name: ch.spec.name,
                       now: Resolver.nowOn(ch.programs, at: at),
                       next: Resolver.upNext(ch.programs, at: at, count: 1).first)
        }
    }
}
