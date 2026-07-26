# dumbTV — Website Design Brief

*Hand this whole file to a fresh Claude (or any designer). It assumes zero prior
knowledge of the project. Build the marketing site + the two legally-required
App Store pages from this.*

---

## 0. TL;DR — what to build

A small, fast, **static** website for **dumbTV** at **`dumbtv.app`**, consisting of five pages:

1. **Landing page** (`/`) — the pitch + how it works + download.
2. **How-To / Setup** (`/how-to`) — the step-by-step "get it running" walkthrough.
3. **FAQ** (`/faq`) — frequently asked questions.
4. **Support** (`/support`) — a hub: links to How-To + FAQ, plus contact. *(App Store-required URL.)*
5. **Privacy Policy** (`/privacy`) — *(App Store-required URL.)*

It must look like a **1990s cable box / TV** — that *is* the product. Retro, warm, a little CRT. No corporate SaaS gradient-blob energy.

**Hard rule:** the site itself must have **no third-party tracking, analytics, ad, or cookie scripts.** The entire product promise is "no account, no cloud, no tracking" — a Google Analytics tag on the marketing page would make us liars. Keep it clean.

---

## 1. What dumbTV is (product context)

dumbTV turns a person's **Plex media library** into a **1990s cable box**. Instead of scrolling a grid of thumbnails deciding what to watch, you turn it on and **take what's on**.

- You build **channels** once (Saturday-morning cartoons, a movie channel, a marathon channel) from your own Plex shows/movies.
- dumbTV **precomputes a two-week schedule** and runs each channel as a continuous broadcast, whether anyone's watching or not.
- Tune in and you **join the show already in progress** — exactly like real TV.
- **No pausing, no skipping, no "are you still watching."** It's live; what's on is on. *(This is a feature, not a limitation — lean into it.)*
- **Self-contained:** runs entirely on the user's device + home network, talks only to their own Plex server, token never leaves the device. **No account, no cloud, no tracking.**
- Ships on **iPhone, iPad, Apple TV, and Mac** (App Store). Also self-hostable on **Raspberry Pi / Windows** (open source on GitHub). You configure any device from a browser on your network.
- Comes with a **built-in demo lineup** so you can see it working before linking anything.

**The one-line positioning:** *"Your Plex library, as a 1990s cable box. What's on is what's on."*

**GitHub:** `https://github.com/sonicstarz/dumbtv`

---

## 2. Goals & success criteria

The site has to:

1. **Explain the concept in ~5 seconds** to someone who's never heard of it. The "anti-streaming, it's just cable" hook has to land above the fold.
2. **Satisfy the App Store** — a live, reachable **Privacy Policy URL** and **Support URL** are mandatory for submission. This is currently the last blocker before we can submit. These two pages existing and being reachable matters more than polish.
3. **Give a download path** — App Store badge (link TBD until live; use a placeholder that's easy to swap) + a GitHub link for self-hosters.
4. **Feel like the product** — someone who lands here should already get the retro-TV vibe before they read a word.
5. **Load instantly, work everywhere, respect privacy** (see constraints).

---

## 3. Required URLs (do not rename these paths)

These exact URLs go into App Store Connect and must resolve:

| Purpose | URL |
|---|---|
| Marketing / landing | `https://dumbtv.app` |
| How-To / Setup | `https://dumbtv.app/how-to` |
| FAQ | `https://dumbtv.app/faq` |
| Support *(App Store-required)* | `https://dumbtv.app/support` |
| Privacy Policy *(App Store-required)* | `https://dumbtv.app/privacy` |

Serve them at clean paths (`/how-to`, `/faq`, `/support`, `/privacy`). `.html` fallbacks are fine, but the canonical links must be the clean ones. The two App Store-required URLs (`/support`, `/privacy`) must resolve.

---

## 4. Audience & voice

**Audience:** Plex users, cord-cutters, home-theater tinkerers, 30–50-somethings nostalgic for flipping channels. Technically comfortable (they run a media server) but the site should still be plain-spoken, not jargon-y.

**Voice:** dry, confident, a little wry. Short sentences. The product is opinionated and the copy should be too. It never apologizes for the limitations — it *sells* them.

- ✅ "No pausing. No skipping. It's live — that's the point."
- ✅ "There's always something on."
- ✅ "The anti-streaming app."
- ❌ "Leverage your media ecosystem." ❌ "Seamless. Powerful. Intuitive." ❌ emoji-salad.

Signature line to use somewhere (footer is good): **"what's on is what's on."**

---

## 5. Visual identity

**Concept:** a retro television / cable box / Prevue-Guide. Think SMPTE color bars, amber phosphor text, the blue TV-listings channel, Archivo-Black-style condensed numerals, square corners, subtle CRT texture. Warm and analog, not cold and flat.

### Palette (taken straight from the app — match it)

| Token | Hex | Use |
|---|---|---|
| Amber (phosphor) | `#F2B134` | primary accent, headings, links, channel numbers, CTA |
| Prevue blue (top) | `#2B3A8F` | the "TV guide" blue field / section backgrounds |
| Prevue blue (bottom) | `#16205A` | gradient partner for the above |
| Deep background | `#06132F` → `#06060A` | page background (near-black navy) |
| Ice | `#DFE4FF` | light text on blue |
| Tape (warm white) | `#E8E4D9` | body text on dark |
| Dim | `#A9A4B8` | secondary/muted text |
| Peri | `#B9C2F0` | tertiary text on blue |

**SMPTE color bars** (a signature motif — use as a top rule / divider):
grey · yellow · cyan · green · magenta · red · blue, e.g.
`#c0c0c0 #c0c000 #00c0c0 #00c000 #c000c0 #c00000 #0000c0`.

### Type
- **Display / headings / the wordmark:** a heavy monospace or condensed grotesque with a "channel readout" feel (system `ui-monospace`/Menlo is an acceptable no-dependency default; if using a webfont, self-host it — no Google Fonts CDN, per the no-third-party rule). Big amber "dumbTV" wordmark.
- **Body:** system UI sans (`-apple-system, system-ui`) for readability. Don't set long paragraphs in monospace.
- Generous letter-spacing on the wordmark and section labels; think channel/station idents.

### Motifs to use
- SMPTE bars as dividers.
- An amber "lower-third" banner (channel number + show title) like the app's on-screen banner — great as a hero visual.
- A faint scanline / CRT vignette texture (keep it *subtle* — never hurt legibility).
- Square corners on panels; rounded only on the CTA pill.
- A blue "TV guide grid" section to echo the in-app guide.

### Don'ts
- No stock photography of generic people on couches.
- No purple SaaS gradients, no glassmorphism, no floating 3D blobs.
- No 1px hairlines that would shimmer on a CRT (spiritual nod to the app's CRT-safe rules).
- Don't drown legibility in the retro texture.

---

## 6. Page-by-page content

Copy below is **ready to use** — it's adapted from the approved App Store listing. Edit for fit, but keep the voice.

### 6a. Landing (`/`)

**Above the fold**
- Wordmark: **dumbTV**
- Tagline: **Your Plex library, as a 1990s cable box.**
- Subhead: *There's always something on. Flip channels and take what's playing.*
- CTAs: **Download on the App Store** *(placeholder link — see §9)* · **GitHub** (`https://github.com/sonicstarz/dumbtv`)
- Hero visual: the amber lower-third banner over a "channel playing" frame, or SMPTE bars + a station ident. (Screenshots to come — see §8; design around a 16:9 device frame.)

**Pitch paragraph**
> It's the anti-streaming app. No grid of thumbnails, no "are you still watching," no endless choice. You build channels once — Saturday cartoons, a movie channel, a marathon — and dumbTV runs them as continuous broadcasts, whether anyone's watching or not. Tune in and you join the show already in progress, exactly like real TV.

**"What makes it dumbTV" (icon list or checklist)**
- **No menus.** Turn it on, take what's on.
- **Join in progress.** Every channel is always mid-broadcast.
- **No pausing, no skipping.** It's live — that's the point.
- **Never transcodes, never touches your watch state.**
- **Self-contained.** Runs on your device and your network. No cloud, no account, no tracking.
- **iPhone, iPad, Apple TV & Mac.** Configure from any browser on your network.

**"How it works" (3 steps)**
1. Install dumbTV; it shows a setup URL + QR code.
2. Open that on your phone, link Plex, build a channel.
3. Flip channels and watch. There's always something on.

**Closing note (muted)**
> Requires a Plex Media Server on your network. Comes with a built-in demo lineup so you can see it working first.

**Footer:** Support · Privacy · GitHub · *"what's on is what's on."*

### 6b. Privacy Policy (`/privacy`)

The real story is genuinely simple, which is a selling point — write it plainly, not in legalese. Must state:

- **dumbTV collects no personal data. No analytics, no tracking, no ads, no account.**
- It runs on your device and talks **only to your own Plex Media Server** on your network. Your **Plex token stays on your device** and is never sent to us or any third party.
- **We operate no servers** that receive your data. There is no dumbTV cloud.
- The **website** (`dumbtv.app`) itself sets no tracking cookies and runs no third-party analytics. *(Note the host may keep standard server access logs — state honestly whatever the chosen host does; see §10.)*
- Contact for privacy questions: *(email — see open questions §10).*
- "Data Not Collected" — this matches the app's `PrivacyInfo.xcprivacy` declaration.
- Last-updated date.

Keep it short, human, and truthful. This page doubles as a **trust/marketing** asset.

### 6c. How-To / Setup (`/how-to`)

The full "get it running" walkthrough. **Content source: `setup-guide.md`** —
use it as-is (it's written for end users). Structure it as clear numbered steps
with plenty of headings:

1. What you need · 2. Install (per platform) · 3. First launch / the SET UP card
(incl. the iOS "Allow local network" call-out) · 4. Open the setup page · 5. Link
Plex · 6. Build your first channel · 7. Watch (the controls table) · the guide ·
optional extras (Kids Mode / Bedtime / PIN / Commercials) · demo mode.

Prioritize **scannability** — someone mid-setup is skimming for the next step.
Keep the retro styling but don't let texture fight legibility. The **controls
table** and the **link-Plex steps** are the two things people come here for;
make them easy to find. Link out to the FAQ for edge cases.

### 6d. FAQ (`/faq`)

**Content source: `faq.md`** — grouped questions (The basics · Watching ·
Building channels · Setup & privacy · Trouble). Render as an **accordion** or as
plain grouped sections with jump-links; either is fine. Keep the dry voice — the
answers sell the limitations ("Why can't I pause?" → "Because it's live TV.
That's the entire idea."). Cross-link to How-To and Privacy where relevant.

### 6e. Support (`/support`)

A short **hub**, not a wall of text — this is the App Store Support URL, so it
must be genuinely helpful in a glance:

- One line: "Need help with dumbTV? Start here."
- Prominent links to **How-To** (`/how-to`) and the **FAQ** (`/faq`).
- **Contact:** support email *(see §10)* + the **GitHub issues** link
  (`https://github.com/sonicstarz/dumbtv/issues`) for bugs.
- Optionally a 3-line quick-start recap (install → open setup URL → link Plex →
  build a channel) that links into How-To.

---

## 7. Technical requirements & constraints

- **Static site.** Plain HTML/CSS, minimal-to-no JS. No build step required to view. (A static-site generator is fine if it outputs plain files, but it isn't necessary for three pages.)
- **No third-party requests.** No Google Fonts, no analytics, no tag managers, no external CDNs. **Self-host every asset** (fonts, images, icons). This is both a privacy promise and a performance win. *(Enforced spiritually the way the app forbids third-party calls.)*
- **Fast:** should be well under 100KB per page excluding screenshots; images optimized/lazy-loaded.
- **Responsive:** looks right from 320px phones to desktop. The page body must never scroll horizontally.
- **Dark by default** (it's a TV). It can be dark-only — committing to the single dark CRT look is on-brand and fine.
- **Accessible:** real semantic HTML, sufficient contrast (amber-on-navy passes; check the muted greys), focus styles, alt text on all imagery, `prefers-reduced-motion` respected for any scanline/flicker animation.
- **SEO/meta:** per-page `<title>` + `<meta description>`, Open Graph + Twitter card tags with a share image (see §8), favicon.
- **Clean URLs** for `/privacy` and `/support` (host-dependent — see §10).
- **Favicon / touch icon:** use the app's identity — a small **SMPTE-test-pattern** tile or the amber "dumbTV" mark.

---

## 8. Assets

**Available / can be produced from the app:**
- **App icon:** an SMPTE **test-pattern** tile (the app's icon) — good source for favicon + OG image motif.
- **Screenshots — captured, included in this handoff at `assets/screenshots/`** (landscape, retina):
  - `iphone-6.9-1-watch-banner.png` / `ipad-13-1-watch-banner.png` — a channel playing with the amber lower-third banner + the Guide/Mute/CC controls + the setup QR card. *(Great hero candidate.)*
  - `iphone-6.9-2-guide.png` / `ipad-13-2-guide.png` — the Prevue-style guide grid (video preview + NOW PLAYING panel + blue timeline).
  - **Note:** these are from the built-in **demo lineup**, so the on-screen video is the **SMPTE test pattern**, not real show art (which is actually on-brand). For the marketing hero, real-Plex-content shots from a device will look richer — treat these as production-ready placeholders that can be swapped. Design the hero + a small gallery around these 16:9 frames; optional tasteful **device/CRT frames**.
- **Palette + motifs:** as specified in §5.

**To produce (design):**
- **OG/social share image** (1200×630) — wordmark + tagline over SMPTE bars / a channel banner.
- **App Store badge** (official Apple asset) once the store link is live.
- Optional: a subtle looping hero (a "channel flip"), but **only** if it respects `prefers-reduced-motion` and doesn't hurt load time. Static hero is perfectly acceptable.

---

## 9. What already exists (starting point)

There are **draft pages in the repo at `site/`** — `index.html`, `privacy.html`, `support.html`. They're rough but establish the direction (amber on navy, SMPTE top bar, mono wordmark, the approved copy). **Treat them as a content/tone reference, not a design ceiling** — the ask is to elevate them into a real, polished site while keeping the copy and the retro-TV concept. Reuse the copy that's there; it's approved.

The **App Store download link is not live yet** — use an obvious placeholder (e.g. a disabled/`(soon)` badge or a `#` link) that's trivial to swap for the real App Store URL later.

---

## 10. Open questions / decisions the owner still needs to make

*(Flag these; don't block the build on them — use sensible placeholders.)*

1. **Hosting** — where does `dumbtv.app` deploy? (Cloudflare Pages / Netlify / GitHub Pages / other.) This determines how clean URLs (`/privacy`, `/support`) and any redirects are configured, and what the honest "server logs" line in the privacy policy should say.
2. **Contact email** — what address goes on Support + Privacy? (e.g. `support@dumbtv.app` / `hello@dumbtv.app`.)
3. **App Store URL** — not available until the app is approved; leave a swappable placeholder.
4. **Download buttons** — one generic "App Store" badge, or per-platform (iPhone/iPad/Apple TV/Mac are one universal purchase, so one badge is likely enough) + a separate "self-host on Pi/Windows → GitHub" path.
5. **Pricing** — the app is free; if that stays true, the site can say "Free." Confirm before stating a price.

---

## 11. Deliverables & acceptance

- [ ] `/` landing page — polished, on-brand, copy from §6a, responsive, dark, no third-party requests.
- [ ] `/privacy` — truthful, plain-language, from §6b.
- [ ] `/support` — quick start + FAQ + contact, from §6c.
- [ ] Shared styling (self-hosted), favicon, OG/meta tags, share image.
- [ ] All three cross-linked in a consistent footer; SMPTE-bar motif present.
- [ ] Passes: no horizontal scroll 320→1440px, contrast/a11y check, no external network calls, fast load.
- [ ] App Store link + contact email left as clearly-marked, easy-to-swap placeholders.

**Definition of done:** the two required pages resolve at the exact URLs in §3, the landing page sells the concept in five seconds, and nothing on the site phones home to a third party.
