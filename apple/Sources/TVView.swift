import SwiftUI
import dumbTVCore

/// A bar that empties over the dial-commit window, so a partial channel number
/// visibly counts down instead of silently jumping. Restarted per digit via
/// `.id(dialing)` on the caller.
struct DialCountdown: View {
    let scale: CGFloat
    @State private var empty = false
    var body: some View {
        GeometryReader { geo in
            Rectangle().fill(Palette.amber)
                .frame(width: geo.size.width)
                .scaleEffect(x: empty ? 0 : 1, anchor: .leading)
        }
        .frame(height: 4 * scale)
        .onAppear { withAnimation(.linear(duration: 1.5)) { empty = true } }
    }
}

/// Where the guide wants the picture: the thumbnail slot's rect, measured in
/// the root coordinate space. The single video surface animates its frame into
/// this rect instead of being re-mounted inside the guide's layout (F3).
private struct VideoSlotKey: PreferenceKey {
    static var defaultValue: CGRect { .zero }
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        let next = nextValue()
        if next != .zero { value = next }
    }
}

/// The name of the root coordinate space. The video surface positions itself in
/// it, and the guide's slot placeholder reports its frame in it — so the two
/// agree without either one having to know the other's layout.
private let tvSpace = "dumbtv.root"

struct TVView: View {
    @ObservedObject var engine: Engine
    /// Where to configure this device (shown as a QR + URL until it's set up).
    var configURL: String? = nil
    /// App/server self-report, shown on channel 00 when the server is down.
    @ObservedObject var diag: SystemDiagnostics
    /// Native Setup. Nil only if the backend failed to open, in which case
    /// channel 00 is still the place that explains why.
    var setup: SetupModel? = nil

    /// Native Setup, shown as an overlay so the video surface underneath (F3)
    /// is never unmounted — opening Setup does not interrupt what is on.
    @State private var setupOpen =
        ProcessInfo.processInfo.environment["DUMBTV_START_NATIVE_SETUP"] == "1"

    /// The guide's thumbnail rect, published by the slot placeholder.
    @State private var guideSlot: CGRect = .zero
    /// Which first-run page is showing. Lives here, not in the popup, so the
    /// remote and keyboard handlers below can page through it — on tvOS a SELECT
    /// press lands on the root view, never on the popup's button.
    ///
    /// Seeded from `DUMBTV_FIRSTRUN_PAGE` so a specific page can be captured in
    /// the simulator, which can't be tapped from the command line. Dev-only, same
    /// pattern as DUMBTV_START_GUIDE / DUMBTV_START_SETUP.
    @State private var firstRunPage =
        Int(ProcessInfo.processInfo.environment["DUMBTV_FIRSTRUN_PAGE"] ?? "") ?? 0

    /// Is the Setup overlay up? Every root input handler checks this and stands
    /// down. Without it the overlay drew on screen while the remote carried on
    /// driving the channels behind it — the root view is focusable and consumes
    /// arrows and SELECT before SwiftUI can move focus between Setup's buttons.
    private var setupShowing: Bool { (setupOpen || engine.setupRequested) && setup != nil }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            // F3 — THE video surface. Mounted once here, for the life of the
            // view, and never re-parented. Watch mode and guide mode differ only
            // in the FRAME it animates to. The old design instantiated a
            // VideoLayer inside each layout, so toggling the guide tore one
            // representable down and built the other; VLCKit's video output does
            // not survive that re-parent (audio kept playing, picture went
            // black). No layout event detaches these views any more, so
            // reattachDrawables() is gone with it.
            GeometryReader { full in
                let r = videoRect(full)
                VideoLayer(player: engine.player)
                    .frame(width: r.width, height: r.height)
                    .position(x: r.midX, y: r.midY)
                    .opacity(engine.onSetupChannel ? 0 : 1)
                    .allowsHitTesting(false)
                    .animation(.easeInOut(duration: 0.25), value: engine.guideOpen)
                    .animation(.easeInOut(duration: 0.25), value: guideSlot)
            }

            GeometryReader { geo in
                // One UI scale for the whole screen so the text reads like a TV at
                // any window size (the reference design is ~800pt tall).
                let s = max(0.7, min(2.2, geo.size.height / 800))
                ZStack {
                    // A2: the guide renders ABOVE the setup channel. Opening the
                    // guide from channel 00 used to flip guideOpen but keep drawing
                    // the setup screen (the guide opened invisibly), which is why
                    // "double-tap/select for the guide" appeared to do nothing.
                    if engine.guideOpen {
                        guideLayout(s: s)
                    } else if engine.onSetupChannel {
                        setupChannelLayout(s: s)
                    } else {
                        watchLayout(s: s)
                    }
                    // F6: ONE first-run click-through, over the top of everything.
                    // It replaces the three overlays a first launch used to stack
                    // (LAN explainer + setup card + guide coach mark).
                    if engine.showFirstRun {
                        firstRun(s: s).transition(.opacity)
                    }
                }
                .animation(.easeInOut(duration: 0.25), value: engine.showFirstRun)
            }
        }
        .coordinateSpace(name: tvSpace)
        // Keep the last measured slot when the guide closes and the placeholder
        // goes away — otherwise the next open would start from a zero rect.
        .onPreferenceChange(VideoSlotKey.self) { if $0 != .zero { guideSlot = $0 } }
        // Native Setup, over the top. An .overlay rather than a .fullScreenCover
        // or a TabView branch: those unmount what's underneath, and what's
        // underneath is THE video surface (F3). The player keeps running behind
        // this, so closing Setup returns to a programme already in progress
        // rather than to a black frame and a reload.
        .onAppear { engine.setupAvailable = setup != nil }
        .overlay {
            // Two ways in, ORed rather than mirrored: local state for the S key
            // and the setup-card button, and engine.setupRequested for the
            // guide's ⚙ row. Deriving it avoids .onChange entirely — the
            // two-parameter form is iOS 17+ and this app targets iOS 16.
            if setupOpen || engine.setupRequested, let setup {
                SetupView(model: setup, diag: diag, configURL: configURL) {
                    setupOpen = false
                    engine.setupRequested = false
                    // Nothing to reload by hand: native Setup mutates through the
                    // same ConfigAPI the web UI does, which posts
                    // .dumbTVConfigChanged — and Engine already observes it. A
                    // channel created here is in the lineup before Setup closes.
                }
                .transition(.opacity)
            }
        }
        // Focus + keyboard/remote input is macOS/tvOS only (iOS uses the swipe
        // gesture below). Keeping these off iOS lets the iOS deployment target
        // drop below 17 — .focusable()/.onKeyPress are iOS 17+.
        #if os(tvOS) || os(macOS)
        // NOT focusable while Setup is open. This root view is what stops the
        // overlay's buttons from ever getting focus: on tvOS the focus engine
        // hands focus to a focusable ancestor, and `.onMoveCommand` here then
        // swallows every arrow before SwiftUI can move between the buttons —
        // so the Setup screen appeared but the remote kept driving the channels
        // behind it. Standing down here is what lets the overlay take focus.
        .focusable(!setupShowing)
        .onMoveCommand { direction in
            // Setup owns the remote while it is up.
            if setupShowing { return }
            // The first-run card owns the screen until it's paged through — don't
            // surf channels or scroll a guide the user can't see.
            if engine.showFirstRun { return }
            if engine.guideOpen {
                switch direction {
                case .up:    engine.guideMove(-1)
                case .down:  engine.guideMove(+1)
                case .left:  engine.guideShiftHalfHours(-1)   // scroll the axis back
                case .right: engine.guideShiftHalfHours(+1)   // …and forward, by 30 min
                @unknown default: break
                }
            } else {
                switch direction {
                case .up:    engine.channelUp()
                case .down:  engine.channelDown()
                case .left, .right: engine.blocked()   // no seeking on live TV
                @unknown default: break
                }
            }
        }
        // Esc / Menu closes the guide. While Setup is open, SetupView's own
        // .onExitCommand closes Setup instead — don't also act on it here.
        .onExitCommand { if !setupShowing, engine.guideOpen { engine.guideOpen = false } }
        #endif
        #if os(tvOS)
        // B3 — the owner's remote spec (simpler than the old two-step):
        //   up/down = change channel (onMoveCommand; the banner auto-appears on tune)
        //   SELECT  = open the guide directly; in the guide, tune the highlighted row
        //   back/menu = dismiss the guide (onExitCommand above)
        .onTapGesture {
            // Setup owns SELECT while it is up — its buttons handle their own.
            if setupShowing { return }
            // SELECT pages the first-run card before it does anything else.
            if firstRunAdvance() { return }
            if engine.guideOpen { engine.guideSelect() } else { engine.toggleGuide() }
        }
        #endif
        #if os(tvOS) || os(macOS)
        .onKeyPress { press in
            // Setup owns the keyboard while it is up: let every key through to
            // it (text fields, focus movement) instead of dialing channels.
            if setupShowing { return .ignored }
            // Return/space/enter pages the first-run card; everything else is
            // swallowed so no key leaks through to the TV behind it.
            if engine.showFirstRun {
                let ch = press.characters
                if press.key == .return || ch == " " { _ = firstRunAdvance() }
                return .handled
            }
            engine.showBanner()
            let ch = press.characters
            // S opens native Setup from anywhere — the "reachable at any time,
            // not only on first run" requirement.
            if ch == "s" || ch == "S" { setupOpen = true; return .handled }
            // Guide: G always (web muscle-memory).
            //
            // `1` USED TO OPEN THE GUIDE TOO, on the reasoning that "there's no
            // ch 1". There is: channel 1 is SPACE, a locked built-in this app
            // ships with — so a leading 1 made SPACE, 10-19 and everything over
            // 100 undialable. Same bug, same reasoning, as the mpv keymap on the
            // Pi side (fixed in build 18). G is the guide; every digit dials.
            if ch == "g" || ch == "G" { engine.toggleGuide(); return .handled }
            // F2: symmetric with the tap gesture. This used to swallow the press
            // and do nothing outside the guide — and because the key handler ate
            // it, the .onTapGesture fallback never ran either, so a single centre
            // click could never OPEN the guide (selecting inside it worked).
            if press.key == .return {
                engine.guideOpen ? engine.guideSelect() : engine.toggleGuide()
                return .handled
            }
            if press.key == .escape { if engine.guideOpen { engine.guideOpen = false }; return .handled }
            // Space bar = bring up channel info (banner + Guide/Mute/CC), the
            // Mac equivalent of a tap. The banner is already revealed at the top
            // of this handler; just swallow the key so it doesn't also ⊘.
            if ch == " " { return .handled }
            if !engine.guideOpen, let c = ch.first, c.isNumber { engine.pressDigit(String(c)); return .handled }
            return .ignored
        }
        #endif
        #if os(tvOS)
        .onPlayPauseCommand { engine.blocked() }
        #endif
        // iOS touch input lives on the transparent catcher inside watchLayout
        // (above the video, below the controls) — a root-level gesture here was
        // swallowed by VLCKit's video view, which is why tapping did nothing.
        // The guide has its own row taps. macOS uses the space bar (below).
    }

    private func firstRun(s: CGFloat) -> some View {
        FirstRunPopup(configURL: configURL, s: s, page: $firstRunPage) {
            engine.finishFirstRun()
        }
    }

    /// Page the first-run card forward from the remote/keyboard, finishing on the
    /// last page. Returns true if it consumed the press, so the caller knows not
    /// to also change channel or open the guide behind the card.
    private func firstRunAdvance() -> Bool {
        guard engine.showFirstRun else { return false }
        if firstRunPage >= FirstRunPopup.pageCount - 1 {
            engine.finishFirstRun()
        } else {
            withAnimation(.easeInOut(duration: 0.2)) { firstRunPage += 1 }
        }
        return true
    }

    /// Where the picture goes. Guide open → the guide's thumbnail slot; otherwise
    /// the whole screen, outset by the safe-area insets so the video is
    /// full-bleed under the notch. One rect, one surface — no re-parenting (F3).
    private func videoRect(_ geo: GeometryProxy) -> CGRect {
        if engine.guideOpen, guideSlot != .zero { return guideSlot }
        let i = geo.safeAreaInsets
        return CGRect(x: -i.leading, y: -i.top,
                      width: geo.size.width + i.leading + i.trailing,
                      height: geo.size.height + i.top + i.bottom)
    }

    // Full-screen video with the channel banner and a GUIDE button.
    private func watchLayout(s: CGFloat) -> some View {
        ZStack {
            // No VideoLayer here any more — the picture is mounted once at the
            // root (F3) and fills the screen whenever the guide is closed. This
            // layout is pure chrome, drawn over it.
            #if os(iOS)
            // Touch input on a dedicated transparent layer ABOVE the video but
            // BELOW the banner/controls (so the control-row buttons still get
            // their own taps). Double-tap = channel info; vertical swipe =
            // channel change; a horizontal swipe would be a seek, so it no-ops
            // with ⊘ (invariant #1).
            Color.clear.contentShape(Rectangle()).ignoresSafeArea()
                .onTapGesture(count: 2) { engine.showBanner() }
                .gesture(
                    DragGesture(minimumDistance: 40).onEnded { v in
                        if abs(v.translation.height) > abs(v.translation.width) {
                            v.translation.height < 0 ? engine.channelUp() : engine.channelDown()
                        } else {
                            engine.blocked()
                        }
                    }
                )
            #endif

            // Direct channel entry (top-right, like a real box), and the ⊘ /
            // channel-change flash (centre).
            // Channel digits — Archivo Black on the dark band, square, like the
            // web TV's #digits.
            if !engine.dialing.isEmpty {
                VStack(spacing: 8 * s) {
                    Text(engine.dialing)
                        .font(Palette.display(56 * s))
                        .foregroundStyle(Palette.amber).tracking(4)
                    // A depleting bar so you can SEE the ~1.5s commit window —
                    // kids stop mashing and end up on the channel, not ⊘.
                    // .id(dialing) remounts it on each digit, restarting the run.
                    DialCountdown(scale: s).id(engine.dialing)
                        .frame(width: 118 * s)
                }
                .padding(.horizontal, 26 * s).padding(.vertical, 14 * s)
                .fixedSize()
                .background(Palette.band)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                .padding(48 * s)
            }
            // ⊘ / CH flash — plain giant glyph with a glow, no chip (web #nope).
            if let f = engine.flash {
                Text(f)
                    .font(Palette.display(88 * s))
                    .foregroundStyle(.white.opacity(0.85))
                    .shadow(color: .black.opacity(0.9), radius: 15)
            }
            VStack {
                HStack {
                    if engine.demo {
                        Text("DEMO")
                            .font(Palette.mono(11, .bold))
                            .foregroundStyle(.black)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(Palette.amber)
                    }
                    if engine.kidsMode {
                        Text("KIDS")
                            .font(Palette.mono(11, .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(Palette.prevue1)
                    }
                    Spacer()
                    // No GUIDE button here any more — on phone/tablet/Mac a tap
                    // reveals the control row (Guide/Mute/CC) over the banner; on
                    // tvOS the whole picture is the guide button (press select).
                }
                // Not while the first-run card is up — it already carries the QR
                // on its last page, and two setup prompts at once was the mess
                // F6 set out to remove.
                if engine.setupCardVisible, !engine.setupCardDismissed,
                   !engine.showFirstRun, let url = configURL {
                    HStack {
                        SetupCard(url: url,
                                  onOpenSetup: setup == nil ? nil : { setupOpen = true },
                                  showChannelHint: true,
                                  onDismiss: { engine.setupCardDismissed = true })
                        Spacer()
                    }
                    .padding(.top, 10)
                }
                Spacer()
                // One-time coach mark — the guide is invisible until you know
                // the key, so say it once, then never again.
                if engine.showGuideHint {
                    HStack {
                        #if os(tvOS)
                        Text("PRESS SELECT FOR THE GUIDE")
                        #elseif os(macOS)
                        Text("PRESS  G  FOR THE GUIDE · SPACE FOR INFO")
                        #else
                        Text("DOUBLE-TAP FOR INFO & THE GUIDE")
                        #endif
                        Spacer()
                    }
                    .font(Palette.mono(13 * s, .bold))
                    .foregroundStyle(Palette.amber).tracking(2)
                    .padding(.bottom, 8 * s)
                    .transition(.opacity)
                }
            }
            .padding(.horizontal, 24 * s)
            .padding(.top, 12 * s)
            .padding(.bottom, 120 * s)   // keep the hint clear of the banner
            .animation(.easeInOut(duration: 0.4), value: engine.showGuideHint)

            // The banner reveals on a channel/program change or a key press, then
            // fades so the picture is unobstructed. A wide lower-third band. On
            // phone/tablet/Mac a tap-revealed control row (Guide/Mute/CC) rides
            // just above it — the only way in to the guide now that the button's gone.
            VStack(spacing: 12 * s) {
                Spacer()
                #if !os(tvOS)
                if engine.bannerVisible {
                    HStack {
                        Spacer()
                        ControlBar(engine: engine, player: engine.player, s: s)
                    }
                    .transition(.opacity)
                }
                #endif
                if engine.bannerVisible {
                    if let airing = engine.now {
                        BannerView(engine: engine, airing: airing, s: s)
                            .transition(.opacity)
                    } else if !engine.status.isEmpty {
                        Text(engine.status)
                            .font(.system(.headline, design: .monospaced))
                            .foregroundStyle(Palette.dim)
                            .padding(.bottom, 40 * s)
                    }
                }
            }
            .padding(.horizontal, 28 * s)
            .padding(.bottom, 36 * s)
            .animation(.easeInOut(duration: 0.3), value: engine.bannerVisible)
        }
    }

    // Channel 00 — the setup screen. Always reachable (dial 0, or the top row of
    // the guide) so the QR + setup URL can be brought back after Plex is linked
    // and the demo card is gone. Works whether or not anything is configured.
    private func setupChannelLayout(s: CGFloat) -> some View {
        ZStack {
            Color.black.ignoresSafeArea()

            #if os(iOS)
            // Touch: double-tap opens the guide (to pick a channel), a vertical
            // swipe changes channel — the ways off the setup screen on a phone.
            Color.clear.contentShape(Rectangle()).ignoresSafeArea()
                .onTapGesture(count: 2) { engine.toggleGuide() }
                .gesture(
                    DragGesture(minimumDistance: 40).onEnded { v in
                        if abs(v.translation.height) > abs(v.translation.width) {
                            v.translation.height < 0 ? engine.channelUp() : engine.channelDown()
                        }
                    }
                )
            #endif

            VStack(spacing: 22 * s) {
                Text("00  SETUP")
                    .font(Palette.display(40 * s)).foregroundStyle(Palette.amber).tracking(3)
                // Server healthy → the scannable QR + URL. Server down → an
                // on-screen diagnostics block instead of a useless sentence, so a
                // single TestFlight photo says exactly what failed (build 11).
                if let url = configURL, diag.storeOpened {
                    // Channel 00 is the documented permanent way back, so the
                    // native path has to be offered here too — otherwise the only
                    // route in on iOS disappears once the first-run card is gone.
                    SetupCard(url: url,
                              onOpenSetup: setup == nil ? nil : { setupOpen = true })
                    // F7: the storage provenance shows even when everything is
                    // WORKING. A tmp-directory reset leaves the store open and the
                    // server up, so the diagnostics block below would never
                    // appear — and that is exactly the case we need evidence for.
                    storageProvenance(s: s)
                } else {
                    diagnosticsBlock(s: s)
                }
                Group {
                    #if os(iOS)
                    Text("Double-tap for the guide · swipe to change channel")
                    #elseif os(tvOS)
                    Text("Press select for the guide · arrows change the channel")
                    #else
                    Text("Press G for the guide · ↑ ↓ change the channel")
                    #endif
                }
                .font(Palette.mono(13 * s)).foregroundStyle(Palette.dim)
                .multilineTextAlignment(.center)
            }
            .padding(30 * s)
        }
    }

    /// Where the database lives and how old it is (F7). Deliberately quiet when
    /// everything is normal — one small line — and loud when the temporary-
    /// directory fallback fired, because that is the one condition that would
    /// silently lose the user's channels on every launch.
    private func storageProvenance(s: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 5 * s) {
            if let fallback = diag.storageFallback {
                Text("⚠ TEMPORARY STORAGE")
                    .font(Palette.mono(12 * s, .bold)).foregroundStyle(Palette.tally).tracking(2)
                Text(fallback)
                    .font(Palette.mono(11 * s)).foregroundStyle(Palette.tally)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("storage  \(diag.dbAgeDescription)")
                .font(Palette.mono(11 * s))
                .foregroundStyle(diag.dbExists ? Palette.dim : Palette.tally)
            Text("data     \(diag.dbRowSummary)")
                .font(Palette.mono(11 * s)).foregroundStyle(Palette.dim)
        }
        .frame(maxWidth: 520 * s, alignment: .leading)
    }

    // On-screen evidence when the config server isn't reachable — replaces the
    // old unhelpful fallback sentence. Distinguishes the tvOS failure modes:
    // store-write failure vs bind failure vs a boot hang (N6).
    private func diagnosticsBlock(s: CGFloat) -> some View {
        func row(_ k: String, _ v: String, bad: Bool = false) -> some View {
            HStack(alignment: .top, spacing: 10 * s) {
                Text(k).foregroundStyle(Palette.dim).frame(width: 92 * s, alignment: .leading)
                Text(v).foregroundStyle(bad ? Palette.tally : .white)
                    .lineLimit(2).minimumScaleFactor(0.6)
            }
        }
        return VStack(alignment: .leading, spacing: 7 * s) {
            Text("SETUP SERVER UNAVAILABLE")
                .font(Palette.mono(14 * s, .bold)).foregroundStyle(Palette.tally).tracking(2)
            row("platform", diag.platform)
            if diag.storeOpened {
                row("store", "open")
            } else {
                row("store", "FAILED — \(diag.storeError ?? "unknown")", bad: true)
            }
            // F7 evidence for the "every new build resets the app" report. The
            // storage warning is the leading hypothesis and used to be invisible;
            // the file age says whether the DB was actually recreated, and the row
            // counts separate "recreated empty" from "no database at all".
            if let fallback = diag.storageFallback {
                row("storage", "TEMPORARY — \(fallback)", bad: true)
            }
            row("db path", diag.storePath)
            row("db file", diag.dbAgeDescription, bad: !diag.dbExists)
            row("db rows", diag.dbRowSummary)
            row("server", diag.serverState + (diag.serverPort > 0 ? " :\(diag.serverPort)" : ""),
                bad: !diag.serverState.hasPrefix("listening"))
            row("config url", diag.configURL ?? "—", bad: diag.configURL == nil)
            row("lan ip", diag.lanIP)
            row("boot", engine.bootStage)
            row("channels", "\(engine.channels.count)  ·  playing: \(engine.now?.program.title ?? "—")")
            row("player", engine.player.state)
        }
        .font(Palette.mono(13 * s))
        .padding(18 * s)
        .background(Color.black.opacity(0.6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.tally.opacity(0.5), lineWidth: 2))
        .frame(maxWidth: 640 * s)
    }

    // Top: the live picture beside a NOW PLAYING panel, on black. Bottom: the
    // blue grid guide, full-bleed to the edges — the reference layout.
    private func guideLayout(s: CGFloat) -> some View {
        GeometryReader { geo in
            VStack(spacing: 14 * s) {
                HStack(spacing: 16 * s) {
                    // The slot, not the picture: this reports its rect and the
                    // root video surface animates into it. Keeping the video
                    // itself out of this layout is the whole F3 fix — the guide
                    // used to build a second VideoLayer here, and the re-parent
                    // that caused is what blacked out the screen.
                    Color.clear
                        .aspectRatio(16.0 / 9.0, contentMode: .fit)
                        .overlay(
                            GeometryReader { g in
                                Color.clear.preference(key: VideoSlotKey.self,
                                                       value: g.frame(in: .named(tvSpace)))
                            }
                        )
                        .border(Palette.amber, width: 3)
                    NowPlayingPanel(engine: engine, s: s)
                }
                .frame(height: geo.size.height * 0.34)
                .padding(.horizontal, 16 * s)
                .padding(.top, 14 * s)

                GuideView(engine: engine, s: s)
            }
        }
    }
}

/// The channel banner — a wide lower-third band: big amber channel number and
/// name, the programme title, and a right column of clock / air-time / NEXT.
struct BannerView: View {
    @ObservedObject var engine: Engine
    let airing: Airing
    var s: CGFloat = 1

    private var episodeTag: String {
        guard let se = airing.program.seasonNo, let ep = airing.program.episodeNo else { return "" }
        return String(format: "S%02dE%02d  ", se, ep)
    }

    var body: some View {
        HStack(spacing: 0) {
            Rectangle().fill(Palette.amber).frame(width: 6 * s)
            HStack(alignment: .center, spacing: 0) {
                VStack(alignment: .leading, spacing: 10 * s) {
                    HStack(alignment: .firstTextBaseline, spacing: 16 * s) {
                        Text(String(format: "%02d", engine.channelNumber))
                            .font(Palette.display(46 * s)).foregroundStyle(Palette.amber)
                        Text(engine.channelName.uppercased())
                            .font(Palette.mono(19 * s, .semibold)).foregroundStyle(Palette.dim)
                            .tracking(4 * s)
                    }
                    Text(airing.program.title)
                        .font(.system(size: 36 * s, weight: .semibold)).foregroundStyle(Palette.tape)
                        .lineLimit(1).minimumScaleFactor(0.6)
                    if let sub = airing.program.subtitle {
                        Text(episodeTag + sub)
                            .font(.system(size: 20 * s)).foregroundStyle(Palette.dim)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 24 * s)
                VStack(alignment: .trailing, spacing: 12 * s) {
                    Text(hhmm(engine.wallClock))
                        .font(Palette.mono(26 * s, .semibold)).foregroundStyle(.white)
                    Text("\(hhmm(airing.program.startUtc)) – \(hhmm(airing.program.endUtc))")
                        .font(Palette.mono(19 * s, .semibold)).foregroundStyle(Palette.amber)
                    if let n = engine.nextUp {
                        HStack(spacing: 10 * s) {
                            Text("NEXT").foregroundStyle(Palette.dim)
                            Text(n.title).foregroundStyle(Palette.tape)
                        }
                        .font(Palette.mono(17 * s, .semibold))
                        .lineLimit(1)
                    }
                }
            }
            .padding(.horizontal, 30 * s).padding(.vertical, 22 * s)
        }
        .frame(maxWidth: .infinity)
        // Hug the content height — without this the amber bar (a greedy
        // Rectangle) stretches the band to fill the whole screen.
        .fixedSize(horizontal: false, vertical: true)
        // rgba(6,6,10,.82), square — the web TV's banner band, no rounding.
        .background(Palette.band)
    }
}


#if !os(tvOS)
/// The tap-revealed control row on phone/tablet/Mac: Guide, Mute, and Captions.
/// Replaces the old always-on GUIDE button — it rides above the channel banner
/// and fades with it. Observes `Player` so Mute/CC reflect their live state.
struct ControlBar: View {
    @ObservedObject var engine: Engine
    @ObservedObject var player: Player
    var s: CGFloat = 1

    var body: some View {
        HStack(spacing: 10 * s) {
            button("GUIDE", "tv.inset.filled", active: false) { engine.toggleGuide() }
            button(player.muted ? "MUTED" : "MUTE",
                   player.muted ? "speaker.slash.fill" : "speaker.wave.2.fill",
                   active: player.muted) { engine.toggleMute() }
            button("CC", "captions.bubble.fill", active: player.captionsOn) { engine.toggleCaptions() }
        }
    }

    private func button(_ title: String, _ icon: String, active: Bool,
                        _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 7 * s) {
                Image(systemName: icon).font(.system(size: 13 * s, weight: .bold))
                Text(title).font(Palette.mono(12 * s, .bold)).tracking(2)
            }
            .foregroundStyle(active ? Color.black : Palette.amber)
            .padding(.horizontal, 14 * s).padding(.vertical, 9 * s)
            .background(active ? Palette.amber : Palette.band)
            .clipShape(RoundedRectangle(cornerRadius: 4))
        }
        .buttonStyle(.plain)
    }
}
#endif
