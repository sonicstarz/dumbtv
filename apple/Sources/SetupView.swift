import SwiftUI
import dumbTVCore

/// The native Setup surface — the on-device path from "just installed" to
/// "watching a channel", with no second device involved.
///
/// WHY THIS EXISTS AT ALL (Notion: Phase — Native Setup on Apple):
/// the driver is App Review, not elegance. A reviewer handed an Apple TV who
/// cannot configure the app on the device in front of them may reject it as
/// incomplete, and tvOS has no WKWebView — so there is no wrap-the-web-UI
/// shortcut. Every established tvOS media client in this category does server
/// setup natively; that is the bar being measured against.
///
/// WHAT IT DELIBERATELY IS NOT: a replacement for the web config UI. It owns the
/// critical path only — link a server, pick a library, make one channel, see
/// diagnostics. Bulk curation, per-item overrides, excludes, rules, ad assets and
/// pack management stay on the web, because doing them with a D-pad would be
/// worse than walking to a laptop. The web UI is reframed here as a companion,
/// not deleted.
///
/// PRESENTED AS AN OVERLAY, NOT A TAB. A `TabView` would let SwiftUI tear down
/// and rebuild `TVView` on tab switches, which would take the single persistent
/// video surface (F3) with it. An overlay keeps the player mounted underneath —
/// so opening Setup never interrupts what is on.
///
/// Button styling splits by platform — see `body`. tvOS uses the stock style
/// because focus IS the interface there; this custom style is for everywhere else.

/// Buttons on iOS/macOS, where focus is not how you navigate.
///
/// NOT used on tvOS. Two attempts got this wrong there and both are worth
/// remembering: tvOS's default style fills the shape with the accent colour, so
/// `.tint(amber)` gave amber-on-amber and DONE/LINK PLEX became solid BLANK
/// pills; then `.plain` plus `@Environment(\.isFocused)` took the background
/// back but drew no focus state at all, so the screen came up with nothing
/// highlighted and the remote had nothing to move between. tvOS now uses the
/// system style and the system focus ring.
private struct SetupButtonStyle: ButtonStyle {
    var prominent = false
    var scale: CGFloat = 1
    @Environment(\.isFocused) private var focused: Bool

    func makeBody(configuration: Configuration) -> some View {
        let active = focused || configuration.isPressed
        return configuration.label
            .padding(.horizontal, 14 * scale)
            .padding(.vertical, 8 * scale)
            // Dark text once there is an amber fill behind it; amber text when
            // there isn't. Never amber-on-amber.
            .foregroundStyle(active ? Palette.prevue2 : (prominent ? Palette.amber : Palette.ice))
            .background(active ? Palette.amber : Color.white.opacity(prominent ? 0.10 : 0.05))
            .overlay(RoundedRectangle(cornerRadius: 4)
                .stroke(active ? Palette.amber : Palette.dim.opacity(0.45), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }
}

struct SetupView: View {
    @ObservedObject var model: SetupModel
    @ObservedObject var diag: SystemDiagnostics
    var configURL: String?
    var onClose: () -> Void

    /// Type scale. A 10pt label is fine 18 inches from a phone and illegible
    /// across a living room, so tvOS gets everything close to twice the size —
    /// and a much wider column, since a 760pt frame on a 4K panel is a stripe.
    #if os(tvOS)
    private let z: CGFloat = 1.9
    private let columnWidth: CGFloat = 1500
    #else
    private let z: CGFloat = 1
    private let columnWidth: CGFloat = 760
    #endif

    /// Scaled monospace. Every size in this file goes through here.
    private func f(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        Palette.mono(size * z, weight)
    }

    @State private var jfURL = ""
    @State private var jfUser = ""
    @State private var jfPass = ""
    @State private var showJellyfin = false

    /// Where the remote lands when Setup opens.
    ///
    /// tvOS does not hand focus into a view that appears inside an `.overlay` on
    /// its own — the screen came up correctly rendered with NOTHING highlighted,
    /// so the remote had nothing to move between and the whole page read as
    /// frozen. Set explicitly once `refresh()` has resolved, which is also when
    /// we know whether the first real control is LINK PLEX or a library row.
    private enum Anchor: Hashable { case link, library, done }
    @FocusState private var anchor: Anchor?

    @State private var chanName = ""
    @State private var chanNumber = ""
    @State private var chanOrdering = "sequential"
    @State private var chosenLibrary: SetupModel.PickLibrary?

    var body: some View {
        ZStack {
            // Opaque: this is a screen, not a scrim. A half-visible programme
            // moving behind a form is unreadable on a CRT.
            Palette.prevue2.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 22 * z) {
                    header
                    if let e = model.error { banner(e, Palette.tally) }
                    if let n = model.notice { banner(n, Palette.amber) }
                    if let b = model.busy { banner(b, Palette.dim) }

                    linkSection
                    if model.isLinked { channelSection }
                    diagnosticsSection
                    companionSection
                }
                .padding(28 * z)
                .frame(maxWidth: columnWidth, alignment: .leading)
            }
        }
        // BUTTON STYLING SPLITS BY PLATFORM, and tvOS gets the stock one.
        //
        // A custom ButtonStyle reading @Environment(\.isFocused) drew no focus
        // state at all on tvOS: the screen came up with nothing highlighted and
        // the remote had nothing to move between. Fighting the focus engine for
        // cosmetics is the wrong trade on the one platform where focus IS the
        // interface — and a reviewer expects tvOS buttons to look like tvOS
        // buttons. So tvOS uses the system style and the system focus ring; we
        // only guarantee the label contrasts (see below). Everywhere else keeps
        // the palette, where focus isn't how you navigate.
        #if os(tvOS)
        .buttonStyle(.automatic)
        #else
        .buttonStyle(SetupButtonStyle(scale: z))
        .tint(Palette.amber)
        #endif
        .task {
            await model.refresh()
            if chanNumber.isEmpty { chanNumber = String(model.suggestedChannelNumber) }
            if chanOrdering.isEmpty || model.orderingModes.first(where: { $0.id == chanOrdering }) == nil {
                chanOrdering = model.orderingModes.first?.id ?? "sequential"
            }
            // After refresh, so "is there a library to pick?" is already answered.
            anchor = model.isLinked ? (model.libraries.isEmpty ? .done : .library) : .link
        }
        #if os(tvOS)
        .onExitCommand(perform: onClose)
        #endif
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text("SET UP dumbTV").font(f(20, .bold)).foregroundStyle(Palette.amber)
                Text(model.linkSummary).font(f(12)).foregroundStyle(Palette.peri)
            }
            Spacer()
            Button(action: onClose) {
                Text("DONE").font(f(13, .bold))
            }
            .focused($anchor, equals: .done)
            #if !os(tvOS)
            .buttonStyle(SetupButtonStyle(prominent: true, scale: z))
            #endif
        }
    }

    private func banner(_ text: String, _ color: Color) -> some View {
        Text(text)
            .font(f(12))
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(Color.black.opacity(0.35))
            .overlay(Rectangle().stroke(color.opacity(0.5), lineWidth: 1))
    }

    private func sectionTitle(_ s: String) -> some View {
        Text(s).font(f(13, .bold)).foregroundStyle(Palette.ice)
    }

    /// Step numbers are computed, never written down. "MAKE A CHANNEL" only
    /// exists once a server is linked, so hardcoding them printed a list that
    /// went 1 · 3 · 4 on a fresh install — which reads as a missing step rather
    /// than an inapplicable one.
    private var channelStep: Int { 2 }
    private var diagnosticsStep: Int { model.isLinked ? 3 : 2 }
    private var companionStep: Int { model.isLinked ? 4 : 3 }

    // MARK: - O2 · Link a media server

    @ViewBuilder
    private var linkSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("1 · YOUR MEDIA SERVER")

            if let code = model.pinCode {
                // The whole reason native setup is viable on a remote: nobody
                // types a password. They type four characters on a device that
                // already has a keyboard, and we poll for the token.
                VStack(alignment: .leading, spacing: 8) {
                    Text("Go to plex.tv/link and enter:")
                        .font(f(12)).foregroundStyle(Palette.peri)
                    Text(code)
                        .font(f(44, .bold))
                        .foregroundStyle(.white)
                        .tracking(6)
                    Text(model.pinPolling ? "Waiting for Plex…" : "")
                        .font(f(11)).foregroundStyle(Palette.dim)
                    Button("CANCEL") { model.cancelPlexLink() }.font(f(12))
                }
            } else if !model.plexServers.isEmpty {
                Text("Choose a server:").font(f(12)).foregroundStyle(Palette.peri)
                ForEach(model.plexServers) { s in
                    Button(s.name) { Task { await model.chooseServer(s) } }
                        .font(f(14))
                }
            } else if model.isLinked {
                Text(model.linkSummary).font(f(13)).foregroundStyle(.white)
                HStack(spacing: 14) {
                    if model.plexLinked {
                        Button("UNLINK PLEX") { Task { await model.unlinkPlex() } }
                    }
                    if model.jellyfinURL != nil {
                        Button("UNLINK JELLYFIN") { Task { await model.unlinkJellyfin() } }
                    }
                }
                .font(f(12))
            } else {
                Text("dumbTV needs somewhere to get shows from.")
                    .font(f(12)).foregroundStyle(Palette.peri)
                Button("LINK PLEX") { Task { await model.startPlexLink() } }
                    .font(f(15, .bold))
                    .focused($anchor, equals: .link)
                    #if !os(tvOS)
            .buttonStyle(SetupButtonStyle(prominent: true, scale: z))
            #endif
                Button(showJellyfin ? "HIDE JELLYFIN" : "USE JELLYFIN INSTEAD") {
                    showJellyfin.toggle()
                }
                .font(f(12))

                if showJellyfin {
                    VStack(alignment: .leading, spacing: 8) {
                        field("Server address", "http://192.168.1.10:8096", $jfURL)
                        field("Username", "", $jfUser)
                        secureField("Password", $jfPass)
                        Button("CONNECT") {
                            Task { await model.connectJellyfin(url: jfURL, user: jfUser, pass: jfPass) }
                        }
                        .font(f(14, .bold))
                        #if !os(tvOS)
            .buttonStyle(SetupButtonStyle(prominent: true, scale: z))
            #endif
                        Text("Jellyfin has no code-based link, so this one needs typing. On a remote, the web companion below is easier.")
                            .font(f(10)).foregroundStyle(Palette.dim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 4)
                }
            }
        }
    }

    private func field(_ label: String, _ placeholder: String, _ text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(f(10)).foregroundStyle(Palette.dim)
            TextField(placeholder, text: text)
                .font(f(13))
                #if !os(tvOS)
                .textFieldStyle(.roundedBorder)
                #endif
                #if os(iOS)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                #endif
        }
    }

    private func secureField(_ label: String, _ text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(f(10)).foregroundStyle(Palette.dim)
            SecureField("", text: text)
                .font(f(13))
                #if !os(tvOS)
                .textFieldStyle(.roundedBorder)
                #endif
        }
    }

    // MARK: - O3 + O4 · A library, and one channel

    @ViewBuilder
    private var channelSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("\(channelStep) · MAKE A CHANNEL")

            if model.libraries.isEmpty {
                Text("No libraries came back from your server.")
                    .font(f(12)).foregroundStyle(Palette.dim)
                Button("RELOAD LIBRARIES") { Task { await model.loadLibraries() } }
                    .font(f(12))
            } else {
                Text("Which library?").font(f(11)).foregroundStyle(Palette.dim)
                ForEach(Array(model.libraries.enumerated()), id: \.element.id) { idx, lib in
                    Button {
                        chosenLibrary = lib
                        if chanName.isEmpty { chanName = lib.title.uppercased() }
                    } label: {
                        HStack {
                            Text(chosenLibrary?.id == lib.id ? "●" : "○")
                            Text("\(lib.title)  (\(lib.type))")
                        }
                        .font(f(13))
                    }
                    // Only the first row is an anchor; the rest are reached by
                    // moving down from it.
                    .focused($anchor, equals: idx == 0 ? .library : nil)
                }

                if let lib = chosenLibrary {
                    VStack(alignment: .leading, spacing: 8) {
                        field("Channel name", lib.title.uppercased(), $chanName)
                        field("Channel number", String(model.suggestedChannelNumber), $chanNumber)

                        if !model.orderingModes.isEmpty {
                            Text("Order").font(f(10)).foregroundStyle(Palette.dim)
                            ForEach(model.orderingModes) { m in
                                Button {
                                    chanOrdering = m.id
                                } label: {
                                    HStack(alignment: .top) {
                                        Text(chanOrdering == m.id ? "●" : "○")
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(m.label).font(f(12))
                                            if !m.blurb.isEmpty {
                                                Text(m.blurb).font(f(9))
                                                    .foregroundStyle(Palette.dim)
                                                    .fixedSize(horizontal: false, vertical: true)
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        Button("CREATE CHANNEL") {
                            Task {
                                let n = Int(chanNumber.trimmingCharacters(in: .whitespaces))
                                    ?? model.suggestedChannelNumber
                                if await model.createChannel(name: chanName, number: n,
                                                             library: lib, ordering: chanOrdering) {
                                    chosenLibrary = nil
                                    chanName = ""
                                    chanNumber = String(model.suggestedChannelNumber)
                                }
                            }
                        }
                        .font(f(15, .bold))
                        #if !os(tvOS)
            .buttonStyle(SetupButtonStyle(prominent: true, scale: z))
            #endif
                        .disabled(model.busy != nil)

                        Text("This adds every title in \(lib.title). Fine-tuning what's in it — excludes, ordering per item, ad breaks — lives in the web companion.")
                            .font(f(10)).foregroundStyle(Palette.dim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 6)
                }
            }

            if !model.channels.isEmpty {
                Text("Channels on this device").font(f(11)).foregroundStyle(Palette.dim)
                    .padding(.top, 6)
                ForEach(model.channels) { c in
                    Text("\(String(format: "%02d", c.number))   \(c.name)")
                        .font(f(12)).foregroundStyle(Palette.tape)
                }
            }
        }
    }

    // MARK: - O5 · Diagnostics

    private var diagnosticsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("\(diagnosticsStep) · DIAGNOSTICS")
            // Same facts channel 00 reports. They live here too because a
            // reviewer — or anyone chasing the "every build resets the app"
            // report — should not have to know about a hidden channel.
            if let fallback = diag.storageFallback {
                banner("⚠ TEMPORARY STORAGE — \(fallback). Settings will not survive.", Palette.tally)
            }
            row("Platform", diag.platform)
            row("Backend", model.backend.rawValue)
            row("Config server", "\(diag.serverState)  :\(diag.serverPort)")
            row("LAN address", diag.lanIP)
            row("Database", diag.storePath)
            row("DB age", diag.dbAgeDescription)
            row("Rows", diag.dbRowSummary)
            if let e = diag.storeError { row("Store error", e) }
        }
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(k).font(f(10)).foregroundStyle(Palette.dim)
                .frame(width: 110 * z, alignment: .leading)
            Text(v).font(f(10)).foregroundStyle(Palette.tape)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - O6 · The web UI, reframed

    private var companionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("\(companionStep) · WEB COMPANION  (optional)")
            Text("Everything above can be done right here. For bulk work — reordering hundreds of episodes, ad breaks, content packs — open this on a phone or laptop on the same network:")
                .font(f(11)).foregroundStyle(Palette.peri)
                .fixedSize(horizontal: false, vertical: true)
            if let url = configURL {
                SetupCard(url: url)
            } else {
                banner("The config server isn't running, so there's no companion URL. Everything above still works — it talks to the app directly, not over the network.", Palette.dim)
            }
            #if os(iOS)
            // F6. iOS 14+ gates local-network access behind a prompt, and a user
            // who declined it loses the companion entirely with no obvious way
            // back. Native Setup is unaffected (in-process, no network), which is
            // exactly why it is now the front door.
            Text("If the address doesn't load: iOS may have blocked local network access. Settings → Privacy & Security → Local Network → dumbTV.")
                .font(f(10)).foregroundStyle(Palette.dim)
                .fixedSize(horizontal: false, vertical: true)
            #endif
        }
    }
}
