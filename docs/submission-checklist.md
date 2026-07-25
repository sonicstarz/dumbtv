# dumbTV — App Store submission checklist

Everything that's *ready* the moment Apple Developer enrollment clears. Steps
marked 🔴 need the account; 🟡 need a quick decision.

## 0. Decisions — RESOLVED
- ✅ **Bundle ID: unified** to **`app.dumbtv.app`** across all three targets
  (one cross-platform "dumbTV" listing; universal purchase). Set in `project.yml`.
- ✅ **Team ID: `B875CKJ7J5`** (set in `project.yml` base settings).
- ✅ **Price: Free** — no in-app purchase, so no tax/banking needed.
- ✅ **Platforms: all three** (iOS + macOS + tvOS) submitted together.

## 1. Account setup 🔴 (Apple sites — only the account holder)
1. **Sign the agreement** — App Store Connect → Business → Agreements, Tax, and
   Banking → accept the Program License Agreement. (Free app → nothing else.)
2. **Register the App ID** — developer.apple.com → Certificates, Identifiers &
   Profiles → Identifiers → **+** → App IDs → App → **Explicit**, Bundle ID
   `app.dumbtv.app`, no capabilities → Register.
3. **Create the app record** — App Store Connect → Apps → **+** → platforms
   iOS/macOS/tvOS, name **dumbTV**, Bundle ID `app.dumbtv.app`, SKU `dumbtv-app`,
   Full Access.
4. **Add your Apple ID to Xcode** — Xcode → Settings → Accounts → **+** (Apple
   ID), so automatic signing can create certs/profiles.

## 2. Build + export (one command) 🔴
```bash
./apple/build-release.sh <TEAM_ID>            # all three, or: ... <TEAM_ID> ios macos
```
Produces `apple/build/export/<scheme>/`. This flips signing on via build-setting
overrides — no project.yml edit needed. (Or set `DEVELOPMENT_TEAM` in
`project.yml` and enable signing there if you prefer.)

## 3. Upload 🔴
- **Transporter.app** (drag the exported `.ipa`/`.pkg`), or
- `xcrun altool --upload-app -f <file> --apiKey <KEY> --apiIssuer <ISSUER>`

## 4. Fill the listing 🔴🟡
- Copy from `docs/app-store-metadata.md` (description, keywords, subtitle, what's-new).
- **App Review note** (already drafted): reviewers use the built-in DEMO lineup — no Plex needed.
- **Privacy:** Data Not Collected (matches `PrivacyInfo.xcprivacy`).
- **Screenshots** per device class (shot-list in the metadata doc).
- **URLs:** privacy policy + support — needs the `dumbtv.app` pages (Track E) live first.
- Submit for review.

## Ready NOW (done, no account needed)
- ✅ App icon (iOS + macOS), privacy manifest, in-app `/licenses`, all 3 LGPL gates
- ✅ `NSLocalNetworkUsageDescription` + ATS local networking, v1.0
- ✅ macOS App Sandbox entitlements, `build-release.sh`, `ExportOptions-AppStore.plist`
- ✅ Demo mode (App Review path), 45 tests, CI

## tvOS specifics — DONE
- ✅ **tvOS layered app icon** (Brand Assets: App Icon front/back layers, Top
  Shelf + Wide, App Store icon) — real assets present in `Assets.xcassets`.
- Launch screen: iOS auto-generates one; a branded one is optional.

## Separate: notarized .dmg (GitHub direct download, macOS)
Not App Store — uses **Developer ID** signing + notarization:
`Developer ID sign → xcrun notarytool submit → xcrun stapler staple → create-dmg`.
Build this once signing works (roadmap A4).
