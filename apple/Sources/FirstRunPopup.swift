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
    /// Called when the user finishes the last page. Persists `first_run_done`.
    let onDone: () -> Void

    /// Which pages exist on this platform. Only iOS throws a local-network
    /// permission prompt, so only iOS gets the page that explains it.
    private enum Page: CaseIterable {
        case welcome, localNetwork, setup

        static var forThisPlatform: [Page] {
            #if os(iOS)
            return [.welcome, .localNetwork, .setup]
            #else
            return [.welcome, .setup]
            #endif
        }
    }

    private var pages: [Page] { Page.forThisPlatform }
    private var isLast: Bool { page >= pages.count - 1 }

    /// How many pages this platform shows — the parent needs it to know when
    /// "next" means "done".
    static var pageCount: Int { Page.forThisPlatform.count }

    private func advance() {
        if isLast { onDone() } else { withAnimation(.easeInOut(duration: 0.2)) { page += 1 } }
    }

    /// The NEXT/DONE affordance. Wrapped in a Button everywhere EXCEPT tvOS,
    /// where the root view owns SELECT — see the note at the call site.
    private var nextLabel: some View {
        Text(isLast ? "DONE" : "NEXT")
            .font(Palette.meta(15 * s, .bold)).tracking(3)
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
                case .setup:        setupPage
                }

                // Page dots, so it's obvious this is a short sequence.
                HStack(spacing: 7 * s) {
                    ForEach(pages.indices, id: \.self) { i in
                        Circle()
                            .fill(i == page ? Palette.amber : Palette.dim.opacity(0.4))
                            .frame(width: 7 * s, height: 7 * s)
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
            .frame(maxWidth: 720 * s)
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
        VStack(spacing: 14 * s) {
            Text("dumbTV")
                .font(Palette.display(34 * s)).foregroundStyle(Palette.amber).tracking(2)
            Text("IT'S ALREADY ON")
                .font(Palette.meta(13 * s, .bold)).foregroundStyle(Palette.dim).tracking(4)
            para("Channels are already playing behind this card. dumbTV is a television, not an app you have to set up before it does anything.")
            para("What's on is what's on. You join a show part-way through, the way you used to.")
            Text("No pause. That's the point.")
                .font(Palette.meta(14 * s, .bold)).foregroundStyle(Palette.amber)
                .multilineTextAlignment(.center)
                .padding(.top, 2 * s)
        }
    }

    /// iOS only. The system permission prompt fires moments after launch, and
    /// denying it breaks setup entirely — so say what's coming and why.
    private var localNetworkPage: some View {
        VStack(spacing: 14 * s) {
            Image(systemName: "wifi")
                .font(.system(size: 34 * s, weight: .bold)).foregroundStyle(Palette.amber)
            Text("ALLOW LOCAL NETWORK")
                .font(Palette.display(22 * s)).foregroundStyle(.white)
                .multilineTextAlignment(.center)
            para("iOS is about to ask whether dumbTV can find and connect to devices on your network. Tap **Allow**.")
            dim("That's how the TV reaches your Plex or Jellyfin server and shows its setup page on your phone or laptop. Without it, setup can't connect.")
        }
    }

    private var setupPage: some View {
        VStack(spacing: 14 * s) {
            Text("ADD YOUR OWN CHANNELS")
                .font(Palette.meta(13 * s, .bold)).foregroundStyle(Palette.dim).tracking(3)
            if let configURL {
                SetupCard(url: configURL)
                dim("Scan that, or open the address on a phone or laptop, to build channels from Plex, Jellyfin, or your own files.")
            } else {
                para("Open the setup page from another device on your network to build channels from Plex, Jellyfin, or your own files.")
            }

            VStack(alignment: .leading, spacing: 6 * s) {
                ForEach(Self.controls, id: \.0) { key, what in
                    HStack(alignment: .top, spacing: 10 * s) {
                        Text(key)
                            .font(Palette.meta(12 * s, .bold)).foregroundStyle(Palette.amber)
                            .frame(width: 118 * s, alignment: .leading)
                        Text(what)
                            .font(Palette.meta(12 * s)).foregroundStyle(Palette.tape)
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
            .font(Palette.meta(13 * s)).foregroundStyle(Palette.tape)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
    }
    private func dim(_ t: String) -> some View {
        Text(.init(t))
            .font(Palette.meta(11.5 * s)).foregroundStyle(Palette.dim)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
    }
}
