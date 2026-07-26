import SwiftUI
import dumbTVCore

/// One channel's precomputed schedule plus the media lookup for playback.
struct ChannelRuntime {
    let spec: ChannelSpec
    let programs: [Program]
    let mediaByKey: [String: Media]
    /// Commercials/bumpers by asset id (ad programs carry assetId, not ratingKey).
    var assetsById: [Int: Asset] = [:]
    /// Poster art for the channel (its first source's Plex thumb path).
    var artThumb: String? = nil
}

/// A single row of the guide at a moment in time.
struct GuideEntry: Identifiable {
    let id: Int          // channel index
    let number: Int
    let name: String
    let now: Airing?
    let next: Program?
    let upcoming: [Program]   // the next few programs, with start times
}

/// One channel's row in the timeline grid — every program that overlaps the
/// visible time window, laid out left-to-right by start/end like a cable guide.
struct GuideProgramRow: Identifiable {
    let id: Int          // channel index
    let number: Int
    let name: String
    let programs: [Program]
    var art: URL? = nil  // channel poster (first source's Plex thumb)
}

/// Format a UTC millisecond instant as a wall clock, e.g. "10:35 PM". The
/// formatter is cached — this is called dozens of times per render, every
/// second, and a fresh DateFormatter each time is a real allocation cost.
/// DateFormatter is documented thread-safe for formatting, so one shared
/// instance is fine.
private let hhmmFormatter: DateFormatter = {
    let f = DateFormatter(); f.dateFormat = "h:mm a"; return f
}()
func hhmm(_ ms: Millis) -> String {
    hhmmFormatter.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
}

/// The visible span of the grid guide (90 min → 3 half-hour columns).
let guideSpanMs: Millis = 90 * 60 * 1000

/// The once-a-second loop that makes reality match the schedule — the Swift
/// counterpart of `src/player/engine.js`. Re-derives from the clock, never a timer.
@MainActor
final class Engine: ObservableObject {
    let plex = PlexClient()
    let player = Player()

    @Published var channels: [ChannelRuntime] = []
    @Published var currentIndex = 0
    @Published var now: Airing?
    @Published var guideOpen = false {
        // Opening the guide snaps the highlight to the channel you're watching
        // and the time axis to now — so it always opens on "what's on."
        didSet { if guideOpen && !oldValue { guideSelection = onSetupChannel ? -1 : currentIndex; resetGuideWindow() } }
    }
    /// Which row the arrow keys/remote have highlighted in the guide.
    @Published var guideSelection = 0
    /// Left edge of the visible time axis (floored to :30). ←→ shift it by 30 min.
    @Published var guideWindowStart: Millis = 0
    @Published var linked = false
    @Published var demo = false
    @Published var status = "Starting…"
    /// A transient on-screen glyph: "⊘" when a blocked key is pressed (invariant
    /// #1 — no pause/seek on live), or "CH n" on a channel change.
    @Published var flash: String?
    /// Digits being dialed for direct channel entry, shown until they commit.
    @Published var dialing = ""
    /// The channel banner auto-hides a few seconds after a change/interaction, so
    /// the picture is unobstructed while you watch.
    @Published var bannerVisible = true
    /// First-run coach mark: nothing on screen says the guide exists until you
    /// know the key. Shown once, then remembered in the Store.
    @Published var showGuideHint = false
    /// True while the TV is locked to kid-safe channels (set from the web UI).
    @Published var kidsMode = false
    /// The setup "channel" (channel 00): a persistent way back to the QR code +
    /// setup URL from the TV itself — reachable even after Plex is linked, when
    /// the demo setup card is long gone. Reachable by dialing 0 or picking the
    /// top row of the guide. True while the setup screen is showing.
    @Published var onSetupChannel = false
    /// iOS only: the first time the app touches the local network (embedded
    /// server + Plex), iOS throws its own "find & connect to devices on your
    /// network" prompt. This drives a one-time on-screen card that points the
    /// user at that system prompt and says to tap Allow — otherwise the prompt
    /// looks scary and unexplained, and denying it breaks setup entirely.
    @Published var showLanExplainer = false
    /// The on-TV setup card (QR + URL) shows until the web config UI is opened
    /// once — even over preloaded channels (D3). The embedded server flips the
    /// `setup_seen` flag on first browser hit; channel 0 remains the way back.
    @Published var setupCardVisible = false
    /// The last-reached boot phase — shown on the channel-00 diagnostics screen
    /// so a hang on real tvOS is localizable (build 11, N6).
    @Published var bootStage = "starting"
    /// While tuning to a NEW channel from the guide, this is that channel's index:
    /// the guide stays open (showing the press was acknowledged) until the new
    /// channel's picture is actually up, then it dismisses. Nil the rest of the time.
    @Published var guideTuning: Int?

    private var currentStart: Millis = -1
    private var tick: Timer?
    private var flashTask: Task<Void, Never>?
    private var dialTask: Task<Void, Never>?
    private var bannerTask: Task<Void, Never>?
    private var guideTuneTask: Task<Void, Never>?
    private var reloadTask: Task<Void, Never>?
    private var serverURI = ""
    private var accessToken = ""
    /// The shared Store, kept so config changes made in the web UI can rebuild
    /// the lineup live (see the .dumbTVConfigChanged observer below).
    private var store: Store?
    /// Last-seen SQLite change counter — polled in sync() as a fallback signal.
    private var lastChangeCounter = -1
    /// When the schedule was last extended forward (hourly top-up in sync()).
    private var lastTopUp: Millis = 0

    init() {
        // The embedded web server mutates the same Store this engine reads.
        // ConfigAPI broadcasts after each mutation; debounce (mutations come in
        // bursts — create channel, add sources…) and rebuild the lineup.
        NotificationCenter.default.addObserver(
            forName: .dumbTVConfigChanged, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.scheduleReload() }
        }
        // The web UI's Watch button / ON AIR strip → change the actual TV.
        NotificationCenter.default.addObserver(
            forName: .dumbTVTuneRequested, object: nil, queue: .main
        ) { [weak self] note in
            let id = note.userInfo?["channelId"] as? Int
            Task { @MainActor in
                guard let self, let id,
                      let idx = self.channels.firstIndex(where: { $0.spec.id == id }) else { return }
                self.tune(to: idx)
                self.showFlash("CH \(String(format: "%02d", self.channelNumber))")
            }
        }
    }

    private func scheduleReload() {
        reloadTask?.cancel()
        reloadTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 800_000_000)
            guard !Task.isCancelled else { return }
            self?.reloadFromStore()
        }
    }

    /// Rebuild the lineup from the Store after a web-UI change, keeping the
    /// channel you're watching tuned (the generator is deterministic, so an
    /// unchanged channel re-derives the identical schedule and playback never
    /// restarts — sync() sees the same airing).
    func reloadFromStore() {
        guard let store else { return }
        let tunedId = channels.indices.contains(currentIndex) ? channels[currentIndex].spec.id : nil
        guard loadFromStore(store) else { return }   // nothing configured yet — keep what's playing
        if let tunedId, let idx = channels.firstIndex(where: { $0.spec.id == tunedId }) {
            currentIndex = idx
        } else {
            currentIndex = min(max(0, currentIndex), channels.count - 1)
            currentStart = -1          // tuned channel is gone — retune to what's here
        }
        guideSelection = min(guideSelection, channels.count - 1)
    }

    var channelName: String { channels.indices.contains(currentIndex) ? channels[currentIndex].spec.name : "" }
    var channelNumber: Int { channels.indices.contains(currentIndex) ? channels[currentIndex].spec.number : 0 }
    var wallClock: Millis { nowMs() }

    /// The program that follows what's currently airing on this channel — the
    /// banner's "NEXT" line.
    var nextUp: Program? {
        guard channels.indices.contains(currentIndex) else { return nil }
        return Resolver.upNext(channels[currentIndex].programs, at: nowMs(), count: 1).first
    }

    private func nowMs() -> Millis { Millis(Date().timeIntervalSince1970 * 1000) }
    private func streamURL(_ partKey: String) -> URL? {
        // Demo lineup plays a bundled test clip.
        if partKey.hasPrefix("demo:") {
            return Bundle.main.url(forResource: "demo-loop", withExtension: "mp4")
        }
        // Content packs (Track I) resolve to a local file under the pack root.
        if partKey.hasPrefix("pack:") {
            guard let path = store?.resolvePackPath(partKey) else { return nil }
            return URL(fileURLWithPath: path)
        }
        // Everything else is a Plex part.
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
        self.store = store          // kept even if empty — a later web-UI change upgrades us live
        bootStage = store == nil ? "no store (DB failed to open)" : "store open"
        showGuideHintOnce()
        showLanExplainerOnce()
        if let store {
            setupCardVisible = store.getSetting("setup_seen") == nil   // D3: nudge until first web-UI open
            bootStage = "seeding preload packs"
            seedPreloadPacks(store)                                    // register bundled packs; seed channels once
            bootStage = "loading channels from store"
        }
        if let store, loadFromStore(store) {
            bootStage = "on air — \(channels.count) channel(s)"
            if ProcessInfo.processInfo.environment["DUMBTV_START_GUIDE"] == "1" { guideOpen = true }
            return
        }
        bootStage = "no configured channels — falling back"
        await bootstrapFromEnvIfPresent()
        bootStage = demo ? "demo lineup (\(channels.count))" : "env/plex (\(channels.count))"
    }

    /// Register the content packs bundled in the app (Track I). Bundled pack
    /// paths live inside the app bundle, which moves on every install/update, so
    /// this re-registers them each launch (installPack upserts root_path). The
    /// preload channels are created ONCE (guarded by `preload_seeded`), then
    /// they're real, editable Store channels like any other. This is what makes
    /// a fresh install a working television with no Plex and no setup.
    private func seedPreloadPacks(_ store: Store) {
        guard let packsRoot = Bundle.main.resourceURL?.appendingPathComponent("packs"),
              let dirs = try? FileManager.default.contentsOfDirectory(
                at: packsRoot, includingPropertiesForKeys: [.isDirectoryKey]) else { return }
        var showsPacks: [String] = []
        for dir in dirs {
            guard (try? dir.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true else { continue }
            if let installed = try? store.installPack(fromDir: dir, origin: "bundled"),
               installed.kind != "ads" {
                showsPacks.append(installed.id)
            }
        }
        guard store.getSetting("preload_seeded") == nil else { return }
        for pid in showsPacks.sorted() { store.createChannelFromPack(pid, adsEnabled: true) }  // D2: ads ON
        store.setSetting("preload_seeded", "1")
        lastChangeCounter = store.sql.totalChanges()   // our own writes — no reload storm
    }

    /// iOS: surface the local-network explainer card on the very first launch,
    /// once ever, so the system permission prompt that fires right after has
    /// context. No-op on macOS/tvOS (no such prompt) and after it's been shown.
    private func showLanExplainerOnce() {
        #if os(iOS)
        // Screenshot hook: keep captures clean of the first-run overlay.
        if ProcessInfo.processInfo.environment["DUMBTV_SCREENSHOT"] == "1" { return }
        guard let store, store.getSetting("lan_explainer_shown") == nil else { return }
        showLanExplainer = true
        #endif
    }

    /// Dismiss the local-network explainer and remember it, so it never returns.
    func dismissLanExplainer() {
        showLanExplainer = false
        store?.setSetting("lan_explainer_shown", "1")
        if let store { lastChangeCounter = store.sql.totalChanges() }   // our write — no reload
    }

    /// Surface "press G for the guide" for a few seconds, exactly once ever.
    private func showGuideHintOnce() {
        guard let store, store.getSetting("guide_hint_shown") == nil else { return }
        store.setSetting("guide_hint_shown", "1")
        lastChangeCounter = store.sql.totalChanges()   // our own write — no reload
        showGuideHint = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 12_000_000_000)
            self?.showGuideHint = false
        }
    }

    /// Build runtimes from the persisted, append-only schedule. Programs come
    /// from the `programs` table (via Scheduler.topUp), NOT regenerated from
    /// `now` — so the schedule survives restarts and matches the guide exactly.
    /// Returns false if nothing is configured yet (caller falls back).
    private func loadFromStore(_ store: Store) -> Bool {
        var cfgs = store.allChannels().filter { $0.enabled }
        guard !cfgs.isEmpty else { return false }
        // Kids Mode (set from the PIN-gated web UI) restricts the TV to the
        // channels a parent marked kid-safe — surfing, dialing, and the guide
        // all read `channels`, so filtering here locks the whole set down.
        let kids = store.getSetting("kids_mode") == "1"
        let kidIds = Set((store.getSetting("kids_safe_channels") ?? "").split(separator: ",").compactMap { Int($0) })
        if kids && !kidIds.isEmpty {
            cfgs = cfgs.filter { kidIds.contains($0.id) }
        }
        kidsMode = kids && !kidIds.isEmpty
        guard !cfgs.isEmpty else { return false }
        serverURI = store.getSetting("plex_server_uri") ?? ""
        accessToken = store.getSetting("plex_access_token") ?? ""
        let now = nowMs()
        // Extend every channel's schedule to the horizon (idempotent; cheap when
        // already covered). This persists new rows and never rewrites aired ones.
        Scheduler.topUp(store: store, now: now)
        lastTopUp = now

        let assetsById = Dictionary(uniqueKeysWithValues: store.assets().map { ($0.id, $0) })
        var built: [ChannelRuntime] = []
        for c in cfgs {
            // Read the persisted timeline: a little behind now (to catch the
            // program already airing) out to two days ahead for the guide.
            let programs = store.programs(c.id, from: now - HOUR, to: now + 2 * DAY)
            let lookup = store.library(forChannel: c.id).mediaByKey
            built.append(ChannelRuntime(spec: c.spec, programs: programs, mediaByKey: lookup,
                                        assetsById: assetsById,
                                        artThumb: store.sources(c.id).first?.thumb))
        }
        guard !built.isEmpty else { return false }
        channels = built
        linked = true
        demo = false          // real lineup now — drop the DEMO badge if we started in demo
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
        // Screenshot hook: open straight into the guide for a deterministic
        // grid capture in demo mode. Dev-only, env-gated.
        if ProcessInfo.processInfo.environment["DUMBTV_START_GUIDE"] == "1" { guideOpen = true }
        if ProcessInfo.processInfo.environment["DUMBTV_START_SETUP"] == "1" { onSetupChannel = true }
    }

    /// Tune to the setup "channel" (00): stop playback and show the QR + setup
    /// URL, available whether or not Plex is configured. Dial 0, or pick the top
    /// row of the guide. This is the always-there way back to setup.
    func tuneToSetup() {
        onSetupChannel = true
        guideTuning = nil
        guideTuneTask?.cancel()
        guideOpen = false
        currentStart = -1
        now = nil
        status = ""
        player.stop()
        showFlash("CH 00")
        showBanner()
    }

    func tune(to index: Int, closeGuide: Bool = true) {
        guard channels.indices.contains(index) else { return }
        onSetupChannel = false     // leaving the setup channel for a real one
        currentIndex = index
        currentStart = -1
        if closeGuide { guideOpen = false }
        // Record what the TV is on so the web UI can highlight it (status.player).
        // Advance our own change-counter watermark so this write doesn't trigger
        // a pointless lineup reload.
        if let store {
            store.setSetting("player_channel_id", String(channels[index].spec.id))
            lastChangeCounter = store.sql.totalChanges()
        }
        sync()
        showBanner()
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

    // Guide navigation with the arrow keys / remote.
    func toggleGuide() {
        guideOpen.toggle()                       // didSet snaps selection + time axis
        showGuideHint = false                    // they found it — hint's job is done
    }
    func guideMove(_ delta: Int) {
        guard !channels.isEmpty else { return }
        // -1 is the SETUP row (channel 00), always sitting above channel index 0.
        guideSelection = min(max(guideSelection + delta, -1), channels.count - 1)
    }
    func guideSelect() {
        // The SETUP row (channel 00) — go to the setup screen, close the guide.
        if guideSelection == -1 {
            guideTuning = nil
            guideTuneTask?.cancel()
            tuneToSetup()
            return
        }
        guard channels.indices.contains(guideSelection) else { return }
        // Selecting the channel you're already watching is just "get me out of
        // here" — dismiss the guide, no retune, no reload, no playback restart.
        if guideSelection == currentIndex {
            guideTuning = nil
            guideTuneTask?.cancel()
            guideOpen = false
            return
        }
        // A different channel: acknowledge the press (highlight stays, a spinner-
        // free "tuning" state) but DON'T leave the guide until the new channel's
        // picture is actually up — so you never drop onto black or colour bars.
        let target = guideSelection
        guideTuning = target
        tune(to: target, closeGuide: false)
        guideTuneTask?.cancel()
        guideTuneTask = Task { @MainActor [weak self] in
            // Poll the player: leave the guide once the new stream has a frame
            // (videoActive, swap done) or resolves to a standby card (off-air).
            // A generous deadline is the backstop so the guide can't wedge open.
            let deadline = Date().addingTimeInterval(16)
            while let self, self.guideTuning == target {
                let ready = !self.player.switching &&
                    (self.player.videoActive || !self.status.isEmpty)
                if ready || Date() >= deadline {
                    self.guideTuning = nil
                    self.guideOpen = false
                    break
                }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
    }

    /// Player controls surfaced on the tap-to-reveal control row (iOS/iPad/Mac).
    /// Both keep the banner up so the row doesn't vanish while you're using it.
    /// Debounced (B1) so a rapid double-tap can't thrash the banner/animation.
    private var lastAVToggle = Date.distantPast
    private func avDebounced() -> Bool {
        guard Date().timeIntervalSince(lastAVToggle) > 0.2 else { return false }
        lastAVToggle = Date(); return true
    }
    func toggleMute()     { guard avDebounced() else { return }; player.toggleMute();     showBanner() }
    func toggleCaptions() { guard avDebounced() else { return }; player.toggleCaptions(); showBanner() }

    /// Snap the time axis to the current half-hour so the guide opens on "now."
    func resetGuideWindow() {
        let half: Millis = 30 * 60 * 1000
        guideWindowStart = (nowMs() / half) * half
    }
    /// ←→ scroll the guide forward/back in 30-minute steps; never earlier than now.
    func guideShiftHalfHours(_ delta: Int) {
        let half: Millis = 30 * 60 * 1000
        let floor = (nowMs() / half) * half
        guideWindowStart = max(floor, guideWindowStart + Millis(delta) * half)
    }

    /// Every channel's programs that overlap the visible time window, for the
    /// grid. Ad breaks/filler are folded into the show's block like a printed
    /// listing — only episodes, movies, and off-air spans are rows in the guide.
    func guideProgramRows() -> [GuideProgramRow] {
        let end = guideWindowStart + guideSpanMs
        return channels.enumerated().map { i, ch in
            let visible = ch.programs.filter {
                $0.endUtc > guideWindowStart && $0.startUtc < end &&
                ($0.kind == .episode || $0.kind == .movie || $0.kind == .offair)
            }
            return GuideProgramRow(id: i, number: ch.spec.number, name: ch.spec.name,
                                   programs: visible, art: channelArtURL(i))
        }
    }

    /// Full URL for a channel's poster art (its first source's Plex thumb).
    func channelArtURL(_ index: Int) -> URL? {
        guard channels.indices.contains(index), let thumb = channels[index].artThumb,
              !serverURI.isEmpty, !accessToken.isEmpty else { return nil }
        return URL(string: "\(serverURI)\(thumb)?X-Plex-Token=\(accessToken)")
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
        if n == 0 { tuneToSetup(); return }   // channel 00 is always the setup screen
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

    /// Reveal the channel banner, then fade it out after a few seconds. Called on
    /// channel/program changes and on any remote interaction.
    func showBanner() {
        bannerVisible = true
        bannerTask?.cancel()
        // Screenshot hook: keep the banner up so captures are deterministic
        // (the sim can't be tapped from the CLI). Dev-only, env-gated.
        if ProcessInfo.processInfo.environment["DUMBTV_SCREENSHOT"] == "1" { return }
        bannerTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 4_500_000_000)
            self?.bannerVisible = false
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
        // Belt and braces for web-UI sync: any DB write bumps SQLite's change
        // counter on the shared connection. Poll it once a second so the lineup
        // converges even if a change notification is ever missed.
        if let store {
            let counter = store.sql.totalChanges()
            if counter != lastChangeCounter {
                lastChangeCounter = counter
                scheduleReload()
            }
            // D3: the setup card retires the moment the web UI is first opened.
            let showCard = store.getSetting("setup_seen") == nil
            if setupCardVisible != showCard { setupCardVisible = showCard }
        }
        // Slide the loaded window forward and extend the DB roughly hourly, so a
        // long-running TV never reaches the edge of what was generated at boot.
        if let store, nowMs() - lastTopUp > HOUR {
            lastTopUp = nowMs()
            Scheduler.topUp(store: store, now: nowMs())
            scheduleReload()
        }

        // On the setup channel there's nothing to play — the setup screen owns
        // the display until you dial/pick a real channel.
        if onSetupChannel { return }

        guard channels.indices.contains(currentIndex) else { return }
        let ch = channels[currentIndex]
        guard let airing = Resolver.nowOn(ch.programs, at: nowMs()) else {
            // The loaded window ran out (should be rare — the top-up above
            // refills it). Reload from the Store to slide forward.
            if currentStart != -2 { currentStart = -2; now = nil; player.stop(); scheduleReload() }
            return
        }
        now = airing
        let p = airing.program
        guard p.startUtc != currentStart else { return }
        currentStart = p.startUtc
        showBanner()   // a new program started — reveal the banner briefly

        // Playable program → stream it. Ads/bumpers resolve via assetId. Anything
        // else is off-air / dead air: stand by, no stream.
        if let key = p.ratingKey, let media = ch.mediaByKey[key], let pk = media.partKey,
           let url = streamURL(pk) {
            status = ""
            player.play(url: url, startSeconds: Int(airing.offsetMs / 1000))
        } else if let aid = p.assetId, let asset = ch.assetsById[aid], let pk = asset.partKey,
                  let url = streamURL(pk) {
            status = ""
            player.play(url: url, startSeconds: Int(airing.offsetMs / 1000))
        } else {
            player.stop()
            status = p.kind == .offair ? (p.subtitle ?? p.title) : "One moment please"
        }
    }

    /// Guide rows for every channel at the current instant.
    func guideRows() -> [GuideEntry] {
        let at = nowMs()
        return channels.enumerated().map { i, ch in
            let upcoming = Resolver.upNext(ch.programs, at: at, count: 3)
            return GuideEntry(id: i, number: ch.spec.number, name: ch.spec.name,
                              now: Resolver.nowOn(ch.programs, at: at),
                              next: upcoming.first, upcoming: upcoming)
        }
    }
}
