# The Headend — accounts, fleets, and what people pay for

**Status: DESIGN. Nothing built. Do not start from this file without the
open questions in §9 answered.**

Owner decision, 2026-08-04: **dumbTV never calls a model on its own key.** You
bring your own Anthropic key, free, on any device. What money buys is the
*headend* — one place to configure every television in the house.

---

## 0 · The rule everything else bends around

**The headend is never in the playback path.**

Unplug the internet and every dumbTV in the house keeps playing its two-week
schedule, because the schedule is already precomputed in local SQLite. The
headend configures; it never serves. If a change would make a TV go dark when
dumbtv.app is down, it is the wrong change — that is invariant #1 applied one
level up.

This is not caution for its own sake. The entire product claim is "what's on is
what's on" — a television that stops being a television when a startup's
certificate expires is a worse product than the thing it replaced.

---

## 1 · What problem this actually solves

The owner's own scenario: two Raspberry Pis, an Apple TV, and a couple of
iPads. Seven devices, one household.

Today that means configuring each one separately, and — since the AI builder
takes your own API key — pasting that key into seven browsers. Nobody will do
that. The pain is not "I want AI", it is **"I want one place."**

Secondary, and worth as much: some devices should be *different*. The iPad in
the kid's room is not the living room set. Per-device and per-group lineups are
the feature, not a bonus.

---

## 2 · Three shapes considered

| | what it is | verdict |
|---|---|---|
| **A · LAN headend** | one dumbTV on your network is the headend; others point at it | good, free, no servers — but doesn't cross houses and doesn't monetise |
| **B · Cloud control plane** | account, config sync, key in one place; never in the playback path | **chosen** |
| **C · Cloud backend** | we hold your Plex token and do everything server-side | **rejected** — see below |

**Why C is rejected.** It would let the cloud read your library directly, which
sounds convenient and is a trap: it breaks Jellyfin (almost always LAN-only),
it fails for anyone with Plex remote access off, and it means storing
media-server credentials — which turns the privacy policy and the App Store
"Data Not Collected" declaration from true into false. The convenience is not
worth becoming a company that holds other people's server credentials.

**Build B as A-plus-sync.** The device↔headend protocol is identical whether
the headend is a Pi in the closet or dumbtv.app. Write it once. Self-hosters
point at their own box for free; subscribers point at ours. That is an
open-core split rather than a paywall bolted onto an open-source project, and
it is the honest shape for a repo people can fork.

---

## 3 · Where the catalog comes from

An account does **not** give the cloud a path to your media server. Your Plex
sits on your LAN behind your router; Jellyfin usually has no remote path at
all. So:

**A device produces the digest.** It already talks to the library — that is
what `public/lineup/digest.js` does today. It uploads titles and genres only,
never files, never viewing history, never credentials.

One digest per *library*, not per device: five devices pointed at one Plex
server share one catalog. Devices pointed at different servers each contribute
their own.

The planner then runs **in the dashboard**, exactly as it runs in the config UI
today — same `public/lineup/` modules, different `api` injection. The headend
is a config store and a key vault, not a second implementation of the builder.

---

## 4 · Data model (first cut)

```
Account        email or Sign in with Apple. One per household.
Device         id, name, platform, lastSeen, groupId, pairedAt
Group          "Kids", "Living room" — a device belongs to at most one
Catalog        a digest, keyed by media-server id, uploaded by some device
Lineup         a set of channel definitions (the LineupProposal shape, already
               defined in docs/ai-lineup-builder.md §5)
Assignment     lineup → device or group
Secret         the account's Anthropic key, encrypted at rest
```

`Lineup` is deliberately the shape the builder already emits. If the headend
needed a different one, there would be a translation layer to keep in step, and
that is how the Node/Swift divergence started.

---

## 5 · Pairing

The device shows a **six-character code** on the television. You type it into
the dashboard. The device gets a long-lived token.

Not a QR code as the primary path: the setup screen already uses one for Plex
and a second QR on the same screen is confusing. Not email-link: the TV has no
mailbox. A code read off a screen and typed on a phone is the pattern every
streaming box already trained people on.

**A device never holds account credentials** — only its own device token, which
the dashboard can revoke. A stolen Apple TV must not be a compromised account.

---

## 6 · Sync

Pull, not push. The device polls for a config **version** and fetches when it
changes. Long-poll or SSE later if the latency annoys anyone.

Push (us opening a connection to a device) would need inbound reachability to
somebody's living room, which is both hard and a bad idea.

**Applying a config is additive-only, like `apply.js`.** It creates what is
missing and updates what it owns. It does *not* clear the channels table —
config import once did exactly that and destroyed SPACE (D-3). A device's
locked system channels are never the headend's to touch.

---

## 7 · The determinism prize

Because the schedule is derived from the clock and a seed that comes from the
channel's identity, **two devices given the same lineup play the same programme
at the same moment** — with no streaming, no coordination, and no shared state.
Walk from the living room to the kitchen and the show is where you left it.

This already works: the seed derivation was made byte-identical across Node and
Swift on 2026-08-04 (`channelSeed`, FNV-1a over UTF-16). ConfigAPI previously
used `UInt32.random`, which would have silently made every room different.

It is worth protecting deliberately, because it is the demo that sells the
fleet feature.

---

## 8 · Free vs paid

**Free, forever, no account.** Everything local: manual channels, packs,
playback, the rule-based lineup builder, and the AI builder with your own key
on whatever device you are configuring. Self-hosting the headend on your own
box is also free.

**Subscription — the headend.** The account. Your key in one place instead of
seven. Config pushed to a fleet. Per-device and per-group lineups. Backup,
history, rollback across the household.

The pitch is *"one place to run all your televisions."* The AI is what you do
there — not a toll on calls you are already paying Anthropic for. Paywalling
someone's own API key in an open-source project invites a fork and deserves to.

**Cost shape:** no inference cost to us at all, so no metering, no weekly caps,
no "you have used your 25 runs" failure. Hosting a config store and a key vault
is close to free per user. The real cost is *obligations* — auth, billing,
uptime, deletion requests, support — not compute.

---

## 9 · Open questions — ANSWER BEFORE BUILDING

1. **Price and shape.** Monthly, annual, lifetime? Apple takes 15% at the
   small-business rate on IAP. A web checkout avoids that but splits the
   purchase flow.
2. **Does the key really live server-side?** It is the whole point of "one
   place", but it means we hold a credential that can spend the user's money.
   Encrypted at rest is table stakes; the honest alternative is that the
   dashboard holds it in the browser and the cloud only stores config — which
   is weaker as a feature and much stronger as a promise. **This is the single
   biggest call in this document.**
3. **What does the App Store privacy declaration become?** Today it is "Data
   Not Collected" and that is true. An account with an email is collected data.
   This has to change before a build with accounts ships, and
   `docs/privacy-policy.md` has to change with it — `npm run test:lineup`
   enforces that the policy names every host the code contacts.
4. **Self-hosted headend: same code or a subset?** If the answer is "same
   code", the API has to be documented and stable, which is a real commitment.
5. **What happens when a subscription lapses?** The devices must keep playing —
   §0 — but does config sync stop, or go read-only? A television that goes dark
   on a failed card is unacceptable.
6. **Account deletion.** GDPR/CCPA mean a real delete path, including the key.

---

## 10 · Suggested order

Nothing here starts until §9.2 and §9.3 are answered.

1. **The protocol, against a LAN headend.** No accounts, no billing, no cloud —
   one dumbTV serving config to another. Proves pairing, pull-sync, and
   additive apply, and ships as a free feature on its own merits.
2. **Accounts and the hosted headend**, reusing that protocol verbatim.
3. **Billing**, last. It is the least interesting part and the easiest to get
   wrong early.

Step 1 is worth doing even if steps 2 and 3 never happen, which is the test of
whether the order is right.
