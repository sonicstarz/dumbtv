# dumbTV — Handoff index (website + App Store)

Everything needed to (A) build the website and (B) submit to the App Store,
in one place. This `docs/` folder is self-contained — screenshots included.

---

## A) Website build — hand these to the designer

| File | What it is |
|---|---|
| **`website-build-prompt.md`** | **The ready-to-paste prompt** for the Claude that builds the site. |
| **`website-brief.md`** | **Start here.** The full design brief — product, brand, palette, page-by-page copy, constraints. Self-contained. |
| `setup-guide.md` | Content source for the **`/how-to`** page (the full setup walkthrough). |
| `faq.md` | Content source for the **`/faq`** page (grouped Q&A). |
| `privacy-policy.md` | Finished Privacy Policy copy for the `/privacy` page. *(Fill the DATE, HOSTING NOTE, CONTACT EMAIL placeholders.)* |
| `assets/screenshots/*.png` | 4 landscape shots (iPhone 6.9" + iPad 13") for the hero/gallery. Demo/test-pattern content. |
| `../site/` | Rough **draft** HTML pages — tone/direction reference, **not** the final design. |

**The site must produce five live pages at exact URLs** (App Store requires `/support` + `/privacy`):
`https://dumbtv.app` · `/how-to` · `/faq` · `/support` · `/privacy`

**Hard constraint:** the site itself runs **no third-party trackers/analytics/cookies** (it would contradict the product's "no tracking" promise). See brief §7.

---

## B) App Store submission

| File | What it is |
|---|---|
| **`submission-checklist.md`** | The step-by-step. Account/signing/upload are **done** — remaining is the listing + submit. |
| **`app-store-metadata.md`** | Listing copy: name, subtitle, description, keywords, **App Review demo notes**, privacy = Data Not Collected. |
| `privacy-policy.md` | Source for the required **Privacy Policy URL** (once the site is live). |
| `assets/screenshots/*.png` | Required screenshot sets: **iPhone 6.9"** (2868×1320) + **iPad 13"** (2752×2064). |
| `vlckit-licensing.md` | LGPL compliance record (already cleared). |

**Remaining before "Submit for review":**
1. **Privacy Policy URL + Support URL must be LIVE** — this is why the website is the gating item. *(Not a doc — a deployed page.)*
2. Paste the listing copy + attach a build + upload screenshots in App Store Connect.
3. Answer age-rating / export-compliance; confirm price (free).
4. *(Optional)* An **Apple TV** screenshot set — none captured (no tvOS sim runtime here); grab on a real Apple TV if you want the tvOS listing illustrated.

---

## Decisions still needed from the owner (blocking the above)

1. **Where `dumbtv.app` is hosted** (Cloudflare Pages / Netlify / GitHub Pages / …) — determines clean-URL config and the honest "server logs" line in the privacy policy.
2. **Contact email** for Support + Privacy (e.g. `support@dumbtv.app`).
3. **App Store URL** — not available until approved; the site uses a swappable placeholder.

---

## Not for this handoff (ignore for site/submission)

`api-contract.md` (engineering spec) · `manual-schedule-editor.md` (future feature) — internal, not needed by the designer or for submission.
