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
    @Published var status = "Starting…"

    private var currentStart: Millis = -1
    private var tick: Timer?
    private var serverURI = ""
    private var accessToken = ""

    var channelName: String { channels.indices.contains(currentIndex) ? channels[currentIndex].spec.name : "" }
    var channelNumber: Int { channels.indices.contains(currentIndex) ? channels[currentIndex].spec.number : 0 }

    private func nowMs() -> Millis { Millis(Date().timeIntervalSince1970 * 1000) }
    private func streamURL(_ partKey: String) -> URL? {
        URL(string: "\(serverURI)\(partKey)?X-Plex-Token=\(accessToken)")
    }

    /// Dev/simulator: seed straight from env so we can play without the PIN link.
    func bootstrapFromEnvIfPresent() async {
        let env = ProcessInfo.processInfo.environment
        guard let token = env["DUMBTV_PLEX_TOKEN"], !token.isEmpty,
              let uri = env["DUMBTV_PLEX_URI"], !uri.isEmpty,
              let access = env["DUMBTV_PLEX_ACCESS"], !access.isEmpty else {
            status = "Link Plex to begin"
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

    func tune(to index: Int) {
        guard channels.indices.contains(index) else { return }
        currentIndex = index
        currentStart = -1
        guideOpen = false
        sync()
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
