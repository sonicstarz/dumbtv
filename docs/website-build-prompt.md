# dumbTV — Website build prompt

Paste the block below to the Claude that will build the site. Hand it this
`docs/` folder (screenshots included). It reads the brief rather than needing
anything re-explained.

---

```text
You're building the marketing website for **dumbTV**, an app that turns a Plex
library into a 1990s cable box. I'm giving you a docs folder that contains
everything you need. Do not invent product facts — everything is in the docs.

## First, read these (in order)
1. `docs/HANDOFF.md` — the index; tells you what's what.
2. `docs/website-brief.md` — THE brief: product, brand, palette, page-by-page
   copy, voice, and constraints. This is your source of truth.
3. `docs/setup-guide.md` — content source for the /how-to page.
4. `docs/faq.md` — content source for the /faq page.
5. `docs/privacy-policy.md` — finished copy for the /privacy page.
6. `docs/assets/screenshots/*.png` — real app screenshots for the hero/gallery.
7. `site/` (if included) — my rough draft pages. Tone reference ONLY — elevate
   well past them.

## Build
Five deployable, static pages that resolve at these EXACT paths:
- `/`         — Landing (pitch → what makes it dumbTV → how it works → download)
- `/how-to`   — How to set it up, from `docs/setup-guide.md`. Scannable numbered
                steps; the controls table and the "link Plex" steps are what
                people come for — make them easy to find.
- `/faq`      — FAQ, from `docs/faq.md`. Render as an accordion or grouped
                sections with jump-links; keep the dry voice.
- `/support`  — A short HUB (this is the App Store Support URL): one line of
                intro + prominent links to How-To and FAQ + contact email +
                GitHub issues link. Not a wall of text.
- `/privacy`  — From `docs/privacy-policy.md`.

Output plain static files with clean-URL-friendly links (e.g. `index.html`,
`how-to.html`, `faq.html`, `support.html`, `privacy.html`). Shared styling,
consistent cross-linked nav/footer across all five.

## Non-negotiable constraints
- **No third-party requests of any kind** — no Google Fonts, analytics, tag
  managers, CDNs, or external images. **Self-host every asset.** The product's
  whole promise is "no tracking"; a tracker on the site makes us liars.
- **Retro cable-box / CRT aesthetic**, not corporate SaaS. Follow the palette
  and motifs in the brief (amber #F2B134, Prevue blues, SMPTE color bars,
  monospace wordmark, square corners, subtle scanline — never hurting legibility).
- Use the **exact approved copy** from the brief/setup/faq/privacy docs. Match
  the dry, confident voice — it sells the limitations, never apologizes for them.
- **Static, fast (<100KB/page excl. images), responsive (320→1440, no
  horizontal scroll), dark, accessible** (semantic HTML, contrast, alt text,
  `prefers-reduced-motion`), with per-page `<title>`/meta, Open Graph tags +
  a share image, and a favicon (SMPTE-tile or the amber wordmark).

## Placeholders — leave clearly marked and easy to swap
- App Store download link (app not live yet) — a `(soon)` / `#` placeholder.
- Contact email on Support/FAQ/Privacy — `[CONTACT EMAIL]`.
- The "server logs" line + date in the privacy policy — leave the bracketed
  notes as-is.

## Deliverables
The five pages, shared CSS, favicon, OG image, all self-contained with zero
external network calls. Before you finish, verify: no third-party requests,
no horizontal scroll at any width, contrast/a11y sane, every page reachable
from the nav/footer, and the landing page sells the concept in ~5 seconds.
```

---

## Notes for whoever runs this

- **If the target is the Artifacts tool** (a single self-contained HTML page):
  it can't serve five separate URL paths in one artifact. Either build the
  **landing page as the artifact** and do the other pages as follow-ups, or ask
  for the five files output as a downloadable set. The prompt targets
  **deployable static files**, which is what `dumbtv.app` actually needs.
- **Before this goes live**, decide the two open items (see `HANDOFF.md`):
  **hosting** for `dumbtv.app` and the **contact email**. Then the placeholders
  are a quick find-and-replace, not a rebuild.
- **The App Store submission is gated on this site being live** — Apple requires
  the `/privacy` and `/support` URLs to actually resolve.
