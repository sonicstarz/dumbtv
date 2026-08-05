import SwiftUI

/// The first-run click-through (F6 + POPUP).
///
/// Before this, a first launch stacked THREE competing overlays: the local-network
/// explainer, the setup card, and a 12-second "press select for the guide" coach
/// mark — all fighting for the same screen while a channel played underneath.
/// This replaces all three with one thing the user pages through once and
/// dismisses for good.
///
/// The pages are deliberately about *expectations*, not configuration. The one
/// thing a new owner needs to understand is that nothing is broken: it's already
/// playing, and there is no pause button on purpose.
struct FirstRunPopup: View {
    /// Where to configure this device — the QR/URL on the last page.
    let configURL: String?
    var s: CGFloat = 1
    /// Which page is showing. Owned by the parent so the remote/keyboard handlers
    /// can page through it too — on tvOS the SELECT press arrives at the root
    /// view, not at this button.
    @Binding var page: Int
    /// Native setup, so the card can link a server and build channels itself
    /// rather than pointing at a phone. Nil when the backend didn't open, in
    /// which case those pages say so instead of pretending.
    var model: SetupModel? = nil
    /// Which tile the remote has highlighted on a chooser page. Owned by the
    /// parent because on tvOS the ROOT view reads the remote — a Button here
    /// would be a second focusable and bring back the double-press bug.
    @Binding var choice: Int
    /// Progress while the starter lineup is being built.
    @Binding var building: SetupModel.StarterProgress?
    /// Channels the build actually made, so the last page can report.
    @Binding var built: [String]
    /// Called when the user finishes the last page. Persists `first_run_done`.
    let onDone: () -> Void

    /// Which pages exist on this platform. Only iOS throws a local-network
    /// permission prompt, so only iOS gets the page that explains it.
    private enum Page: CaseIterable {
        case welcome, localNetwork, link, lineup, setup

        static var forThisPlatform: [Page] {
            #if os(iOS)
            return [.welcome, .localNetwork, .link, .lineup, .setup]
            #else
            return [.welcome, .link, .lineup, .setup]
            #endif
        }
    }

    /// TYPE SCALE, PER PLATFORM — and the reason the last build's fix missed.
    ///
    /// Build 25 made the card physically bigger and left the type where it was,
    /// so it read as a large box of small print. The numbers below were written
    /// for a phone held at arm's length; a television is read from a sofa.
    ///
    /// `s` is already ~1.35 on a 1080-point tvOS screen, so 13pt body was
    /// landing at ~17pt. Apple's own guidance puts readable tvOS body text near
    /// 29pt. 1.9× takes body to ~33pt and the title to ~87pt, which is the
    /// difference between squinting and reading.
    ///
    /// Layout still uses `s`. Only TYPE takes this multiplier — growing the
    /// padding by the same factor would push the card past the safe area.
    #if os(tvOS)
    private var f: CGFloat { s * 1.9 }
    #else
    private var f: CGFloat { s }
    #endif

    private var pages: [Page] { Page.forThisPlatform }
    private var isLast: Bool { page >= pages.count - 1 }

    /// How many pages this platform shows — the parent needs it to know when
    /// "next" means "done".
    static var pageCount: Int { Page.forThisPlatform.count }

    /// Which page index is which, so TVView can route SELECT without knowing
    /// the enum. The page list differs by platform, so this cannot be a constant.
    static func isLinkPage(_ i: Int) -> Bool {
        Page.forThisPlatform[safe: i] == .link
    }
    static func isLineupPage(_ i: Int) -> Bool {
        Page.forThisPlatform[safe: i] == .lineup
    }

    private func advance() {
        if isLast { onDone() } else { withAnimation(.easeInOut(duration: 0.2)) { page += 1 } }
    }

    /// The NEXT/DONE affordance. Wrapped in a Button everywhere EXCEPT tvOS,
    /// where the root view owns SELECT — see the note at the call site.
    private var nextLabel: some View {
        Text(isLast ? "DONE" : "NEXT")
            .font(Palette.meta(17 * f, .bold)).tracking(3)
            .foregroundStyle(.black)
            .padding(.horizontal, 38 * s).padding(.vertical, 12 * s)
            .background(Palette.amber)
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    var body: some View {
        ZStack {
            // Opaque enough to read against a moving picture, not so opaque that
            // you forget the TV is already playing behind it.
            Color.black.opacity(0.82).ignoresSafeArea()

            VStack(spacing: 20 * s) {
                switch pages[min(page, pages.count - 1)] {
                case .welcome:      welcomePage
                case .localNetwork: localNetworkPage
                case .link:         linkPage
                case .lineup:       lineupPage
                case .setup:        setupPage
                }

                // Page dots, so it's obvious this is a short sequence.
                HStack(spacing: 11 * s) {
                    ForEach(pages.indices, id: \.self) { i in
                        Circle()
                            .fill(i == page ? Palette.amber : Palette.dim.opacity(0.4))
                            .frame(width: 11 * s, height: 11 * s)
                    }
                }

                // NOT A BUTTON ON tvOS, AND THIS IS LOAD-BEARING. Third time.
                //
                // tvOS focuses exactly ONE thing. TVView owns `.focusable()` and
                // reads SELECT through `.onTapGesture`, so a Button here is a
                // SECOND focusable: the first SELECT press is spent moving focus
                // onto it and only the second one fires it. That is exactly the
                // "single click does nothing on the carousel, a double click
                // works" report — the same failure SetupCard carries a warning
                // about (build 23) and the same one Engine.swift documents.
                //
                // The remote is already wired without a control here:
                // TVView.selectPressed → firstRunAdvance(), and left/right page
                // the card. tvOS needs the LABEL, not the button.
                #if os(tvOS)
                nextLabel
                #else
                Button(action: advance) { nextLabel }
                    .buttonStyle(.plain)
                #endif
            }
            .padding(34 * s)
            .frame(maxWidth: 1000 * s)
            .background(Palette.band)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.amber.opacity(0.4), lineWidth: 2))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .padding(24 * s)
        }
        // No ✕ and no tap-to-dismiss on first run — paging through IS the point.
        // The setup card that shows afterwards has both.
    }

    // MARK: - pages

    private var welcomePage: some View {
        VStack(spacing: 18 * s) {
            Text("dumbTV")
                .font(Palette.display(38 * f)).foregroundStyle(Palette.amber).tracking(2)
            Text("IT'S ALREADY ON")
                .font(Palette.meta(15 * f, .bold)).foregroundStyle(.black).tracking(5)
                .padding(.horizontal, 16 * s).padding(.vertical, 6 * s)
                .background(Palette.amber)
                .clipShape(RoundedRectangle(cornerRadius: 3))
            para("Channels are already playing behind this card. dumbTV is a television, not an app you have to set up before it does anything.")
            para("What's on is what's on. You join a show part-way through, the way you used to.")
            Text("No pause. That's the point.")
                .font(Palette.meta(16 * f, .bold)).foregroundStyle(Palette.amber)
                .multilineTextAlignment(.center)
                .padding(.top, 2 * s)
        }
    }

    /// iOS only. The system permission prompt fires moments after launch, and
    /// denying it breaks setup entirely — so say what's coming and why.
    private var localNetworkPage: some View {
        VStack(spacing: 18 * s) {
            Image(systemName: "wifi")
                .font(.system(size: 40 * f, weight: .bold)).foregroundStyle(Palette.amber)
            Text("ALLOW LOCAL NETWORK")
                .font(Palette.display(26 * f)).foregroundStyle(.white)
                .multilineTextAlignment(.center)
            para("iOS is about to ask whether dumbTV can find and connect to devices on your network. Tap **Allow**.")
            dim("That's how the TV reaches your Plex or Jellyfin server and shows its setup page on your phone or laptop. Without it, setup can't connect.")
        }
    }

    /// LINK A SERVER, on the card. The PIN flow is the same one native Setup
    /// runs — SetupModel.startPlexLink — against the same /api/plex/pin
    /// endpoints the web UI uses. Nothing is duplicated; the card just calls it.
    private var linkPage: some View {
        VStack(spacing: 18 * s) {
            Text("CONNECT YOUR LIBRARY")
                .font(Palette.meta(15 * f, .bold)).foregroundStyle(Palette.amber).tracking(3)
            if let m = model, m.plexLinked {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 44 * f, weight: .bold)).foregroundStyle(Palette.amber)
                Text((m.plexServerName?.isEmpty == false) ? "Connected to \(m.plexServerName!)" : "Connected")
                    .font(Palette.display(24 * f)).foregroundStyle(.white)
                para("Your own shows and films are available. Next, pick a lineup and dumbTV will build the channels.")
            } else if let m = model, let code = m.pinCode, !code.isEmpty {
                Text(code)
                    .font(Palette.display(56 * f)).foregroundStyle(Palette.amber).tracking(8)
                para("Go to **plex.tv/link** on your phone or laptop and enter that code.")
                dim("Waiting… this page moves on by itself once it connects.")
            } else {
                Image(systemName: "tv.and.mediabox")
                    .font(.system(size: 40 * f, weight: .bold)).foregroundStyle(Palette.amber)
                para("dumbTV plays what you already own. Connect Plex and it builds channels out of your library.")
                dim(model == nil
                    ? "Setup isn't available on this device — use the address on the last page."
                    : "Press SELECT to get a code. Or press → to skip and do it later.")
            }
        }
    }

    /// PICK A LINEUP. Tiles, not typing — this is a television and the remote
    /// has no keyboard. Each preset is a fixed set of channel templates
    /// (StarterLineup), filled from whatever the library actually has.
    private var lineupPage: some View {
        VStack(spacing: 16 * s) {
            if let b = building {
                Text("BUILDING YOUR LINEUP")
                    .font(Palette.meta(15 * f, .bold)).foregroundStyle(Palette.amber).tracking(3)
                Text(b.label.isEmpty ? "Finishing…" : b.label)
                    .font(Palette.display(30 * f)).foregroundStyle(.white)
                    .lineLimit(1).minimumScaleFactor(0.6)
                ProgressView(value: Double(b.done), total: Double(max(1, b.total)))
                    .tint(Palette.amber)
                    .frame(maxWidth: 460 * s)
                dim("Reading each show and scheduling two weeks ahead. This takes a moment.")
            } else if !built.isEmpty {
                Text("\(built.count) CHANNELS ON THE AIR")
                    .font(Palette.meta(15 * f, .bold)).foregroundStyle(Palette.amber).tracking(3)
                Text(built.prefix(8).joined(separator: " · "))
                    .font(Palette.meta(15 * f)).foregroundStyle(Palette.tape)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                dim("Press → to finish. You can add, rename or delete any of them later.")
            } else {
                Text("PICK A LINEUP")
                    .font(Palette.meta(15 * f, .bold)).foregroundStyle(Palette.amber).tracking(3)
                dim("← → to choose · SELECT to build it")
                HStack(spacing: 12 * s) {
                    ForEach(Array(StarterLineup.presets.enumerated()), id: \.element.id) { i, p in
                        VStack(spacing: 7 * s) {
                            Text(p.title)
                                .font(Palette.meta(14 * f, .bold))
                                .foregroundStyle(i == choice ? .black : Palette.amber)
                                .tracking(1.5)
                            Text(p.blurb)
                                .font(Palette.meta(11.5 * f))
                                .foregroundStyle(i == choice ? .black.opacity(0.75) : Palette.dim)
                                .multilineTextAlignment(.center)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.horizontal, 12 * s).padding(.vertical, 14 * s)
                        .frame(maxWidth: .infinity, minHeight: 128 * s)
                        .background(i == choice ? Palette.amber : Color.white.opacity(0.06))
                        .overlay(RoundedRectangle(cornerRadius: 5)
                            .stroke(Palette.amber.opacity(i == choice ? 0 : 0.35), lineWidth: 2))
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                    }
                }
                if model?.plexLinked != true {
                    dim("No server connected — these will be built from installed packs only.")
                }
            }
        }
    }

    private var setupPage: some View {
        VStack(spacing: 18 * s) {
            Text("ADD YOUR OWN CHANNELS")
                .font(Palette.meta(15 * f, .bold)).foregroundStyle(Palette.amber).tracking(3)
            if let configURL {
                SetupCard(url: configURL, z: f / 1.35)
                dim("Scan that, or open the address on a phone or laptop, to build channels from Plex, Jellyfin, or your own files.")
            } else {
                para("Open the setup page from another device on your network to build channels from Plex, Jellyfin, or your own files.")
            }

            VStack(alignment: .leading, spacing: 6 * s) {
                ForEach(Self.controls, id: \.0) { key, what in
                    HStack(alignment: .top, spacing: 10 * s) {
                        Text(key)
                            .font(Palette.meta(13 * f, .bold)).foregroundStyle(Palette.amber)
                            .frame(width: 210 * s, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(what)
                            .font(Palette.meta(13 * f)).foregroundStyle(Palette.tape)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 2 * s)

            dim("Full guide & FAQ at dumbtv.app")
        }
    }

    /// The control cheatsheet, per platform — the same set the remote/keyboard
    /// actually implements.
    /// Every line here has to name something the platform can ACTUALLY do.
    ///
    /// This list used to promise "0 — this setup screen, anytime" on tvOS and
    /// "DIAL 0" on iOS. Neither is possible: digits reach `pressDigit` only from
    /// the macOS keyboard, so channel 00 was unreachable on the two platforms
    /// being told to dial it. The way in on every platform is the ⚙ row at the
    /// top of the guide, so that is what it says now.
    private static var controls: [(String, String)] {
        #if os(tvOS)
        return [("UP / DOWN", "change channel"),
                ("SELECT", "channel info & the guide"),
                ("⚙ IN THE GUIDE", "packs & setup, anytime")]
        #elseif os(macOS)
        return [("↑ / ↓", "change channel"),
                ("G  ·  SPACE", "the guide  ·  channel info"),
                ("S  ·  ⚙", "packs & setup, anytime")]
        #else
        return [("SWIPE ↑ / ↓", "change channel"),
                ("DOUBLE-TAP", "channel info & the guide"),
                ("⚙ IN THE GUIDE", "packs & setup, anytime")]
        #endif
    }

    // MARK: - text helpers

    private func para(_ t: String) -> some View {
        Text(.init(t))
            .font(Palette.meta(14 * f)).foregroundStyle(Palette.tape)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
    }
    private func dim(_ t: String) -> some View {
        Text(.init(t))
            .font(Palette.meta(12.5 * f)).foregroundStyle(Palette.dim)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
    }
}


private extension Array {
    /// Bounds-safe index. The card's page binding is clamped everywhere it is
    /// read, but these helpers are called from the root's input path where an
    /// out-of-range value would be a crash rather than a wrong screen.
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
