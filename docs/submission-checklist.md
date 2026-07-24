# dumbTV — App Store submission checklist

Everything that's *ready* the moment Apple Developer enrollment clears. Steps
marked 🔴 need the account; 🟡 need a quick decision.

## 0. Decide up front
- 🟡 **Bundle-ID strategy.** Today the targets use **separate** IDs
  (`app.dumbtv.ios/.tvos/.mac`) → that's **three App Store listings**. For **one
  cross-platform "dumbTV" listing** (iPhone/iPad/Apple TV/Mac on a single
  product page), set all three targets to the **same** ID (e.g. `app.dumbtv.app`)
  in `project.yml`, then `xcodegen generate`. *Recommended: unify.*
- 🟡 **Price** (free / paid) and **age rating** answers (see `app-store-metadata.md`).

## 1. When enrollment clears 🔴
1. **Team ID** — developer.apple.com → Membership → copy the Team ID.
2. **App Store Connect** → reserve the name **"dumbTV"** (fallback ready if taken),
   create the app record(s), select the platforms.
3. Certificates/App IDs — no manual work needed; the release script uses
   `-allowProvisioningUpdates` so automatic signing creates them.

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

## Still to do before *tvOS* specifically can submit
- 🔴/build **tvOS layered app icon** (Brand Assets) — iOS + macOS can submit without it.
- **Launch screens** (iOS auto-generates a blank one; a branded one is optional).

## Separate: notarized .dmg (GitHub direct download, macOS)
Not App Store — uses **Developer ID** signing + notarization:
`Developer ID sign → xcrun notarytool submit → xcrun stapler staple → create-dmg`.
Build this once signing works (roadmap A4).
