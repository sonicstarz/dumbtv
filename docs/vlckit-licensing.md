# VLCKit / LibVLC licensing — App Store compliance note

**Status:** Reviewed 2026-07-24. **Verdict: clearable — LGPL, not GPL. App Store distribution is allowed** provided the checklist below is met. One item still needs a concrete verification (GPL-module audit of the shipped binary).

dumbTV's Apple apps play video through **VLCKit** via the Swift package
[`tylerjonesio/vlckit-spm`](https://github.com/tylerjonesio/vlckit-spm)
(`import VLCKitSPM`, v3.5.1+), which bundles VideoLAN's VLCKit binaries as a
dynamic xcframework.

## The core question, answered

The App Store licensing problem people remember is a **GPL** problem, not an
LGPL one: every app shipped from the App Store is wrapped in Apple's DRM and
bound by Apple's usage terms, which are **incompatible with the GPL**. That is
why Apple pulled VLC from the store in 2011.

VideoLAN then **relicensed libVLC and VLCKit from GPLv2 to LGPLv2.1+**
specifically to make App Store distribution possible, and VLC has been back on
the App Store ever since. **LGPLv2.1 is compatible with App Store distribution.**
VLCKit and the SPM wrapper are both **LGPL-2.1**.

So: dumbTV can ship VLCKit in a closed-source App Store app, and **dumbTV's own
source can stay proprietary** — LGPL only reaches the LGPL library itself, not
the app that links it.

## Our obligations under LGPLv2.1 (and how dumbTV meets them)

1. **Dynamic linking (so a user could swap in their own VLCKit build).**
   - ✅ Met by construction: the SPM package ships VLCKit as a **dynamic
     framework**. **Do not statically link it.** This is the single most
     important technical requirement — static linking would drag in the
     LGPL's relinking obligations.

2. **Attribution + notice of the user's LGPL rights.**
   - ⬜ **Action:** add an in-app **"Licenses / Acknowledgements"** screen (and a
     line in the GitHub release notes + the `.dmg` about box) stating dumbTV
     embeds VLCKit, that VLCKit is LGPLv2.1, and linking to its source. Include
     the full LGPLv2.1 text.

3. **Provide the corresponding source of the exact VLCKit version used**
   (plus any modifications — we make none).
   - ⬜ **Action:** record the pinned VLCKit version and link to VideoLAN's
     source for that tag (a written offer / URL in the acknowledgements screen
     satisfies this). We ship VLCKit **unmodified**, which keeps this trivial.

4. **Don't forbid reverse-engineering for the user's own debugging** of the
   LGPL portion.
   - ✅ Our EULA/terms must not contain such a clause. Nothing to do unless we
     add a restrictive EULA later.

## The one real risk to verify: GPL modules in the binary

libVLC is modular. The **core + most modules are LGPL**, but a handful of
optional modules (certain codecs/demuxers, `libdvdcss`, etc.) are **GPL**. If a
GPL module ends up compiled into the shipped xcframework, the whole binary is
effectively GPL again and the App Store problem returns.

VideoLAN's official Apple binaries used for App Store apps are built
**LGPL-only** (GPL modules excluded), and `tylerjonesio/vlckit-spm` is itself
labelled LGPL-2.1 and bundles those official builds — so this is **very likely
already clean**. But it must be confirmed, not assumed.

- ⬜ **Action (blocking gate before submission):** confirm the specific VLCKit
  xcframework the package pulls contains **no GPL modules** — check VideoLAN's
  build config / module list for the pinned version, or ask in the VLCKit
  tracker. If in doubt, pin to a known LGPL-only VideoLAN release.

## Precedent (why this is low-risk)

- VLC's own iOS/tvOS app ships on the App Store today, built on this same LGPL
  VLCKit. Many third-party VLCKit apps are approved. The path is well-trodden.

## Bottom line for the roadmap

Not a blocker to *building* — only a **pre-submission gate**. Two concrete
deliverables remain: (a) the in-app **acknowledgements/licenses screen** with
LGPL text + VLCKit source link, and (b) the **GPL-module audit** of the pinned
binary. Both are cheap and independent of Apple Developer enrollment.

## Sources
- VLCKit relicensing GPL→LGPL for App Store; MobileVLCKit/VLCKit licensing —
  Felix Paul Kühne (VLCKit maintainer): https://www.feepk.net/2014/12/02/mobilevlckit-and-vlckit-part-1/
- LGPL and the App Store (background): https://lwn.net/Articles/526355/
- The GPL, the App Store, and the 2011 VLC removal: https://www.aol.com/news/2011-01-09-the-gpl-the-app-store-and-you.html
- SPM wrapper (LGPL-2.1, v3.5.1+): https://github.com/tylerjonesio/vlckit-spm
