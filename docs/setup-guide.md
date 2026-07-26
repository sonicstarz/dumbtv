# dumbTV — Setup Guide

Turn your Plex library into a 1990s cable box. This walks you from a fresh
install to flipping channels, in about five minutes.

---

## What you need

- **A device to watch on:** iPhone, iPad, Apple TV, or Mac (also Raspberry Pi or Windows if you self-host).
- **A Plex Media Server** on the same network, with some shows or movies in it.
  *(No Plex yet? You can still try dumbTV — it ships with a built-in demo. See [Just want to look around?](#just-want-to-look-around) at the end.)*

There's **no account to create** and nothing runs in the cloud. dumbTV talks only to your own Plex server, and your Plex token never leaves your device.

---

## Step 1 — Install dumbTV

| Platform | How |
|---|---|
| **iPhone / iPad / Apple TV** | Install from the App Store (or TestFlight during the beta). |
| **Mac** | App Store, or the notarized `.dmg` from the website. |
| **Raspberry Pi** | Run `pi/install.sh` — installs everything and boots straight to the TV. |
| **Windows** | Run `dumbTV-Setup.exe`. |

Open the app. Because dumbTV is a television, it opens straight into the picture — no menus.

---

## Step 2 — First launch: the welcome card

The first time you open dumbTV, it pages you through a short **welcome card**. It
is worth reading, because it sets the one expectation that matters: **channels are
already playing behind it.** dumbTV comes with real public-domain content built
in, so it is a working television before you connect anything.

The last page carries the setup details:

- a **QR code**, and
- a **web address** like `http://192.168.1.118:8080`.

That address is dumbTV's built-in setup page. **All configuration happens there**,
from your phone or laptop — there's nothing to type on the TV itself.

Press **DONE** on the last page and the card is gone for good. If you need the
address again later, **tune to channel 0** at any time.

### iPhone / iPad: allow local network access

One page of the welcome card is a heads-up about this, because it matters:

> **iOS will ask whether dumbTV can find and connect to devices on your network.
> Tap "Allow".**

That permission is the whole game on iOS. It's how dumbTV reaches your Plex or
Jellyfin server, and how it serves this setup page to your phone or laptop. If you
tap **Don't Allow**, setup cannot connect and the app will look broken. If you
already declined it, you can turn it back on in
**iOS Settings → dumbTV → Local Network**.

There is no equivalent prompt on Apple TV, Mac, Raspberry Pi, or Windows.

---

## Step 3 — Open the setup page

On your phone or laptop, on the **same Wi-Fi/network** as the TV:

- **Scan the QR code** with your phone camera, **or**
- **type the address** into any browser, **or**
- on iPhone/iPad/Mac, just **tap the address on screen** — it opens the page right there.

You'll land on the dumbTV config app. The three things you'll use are **Server**, **Channels**, and (optionally) **Commercials** and **Settings**.

---

## Step 4 — Link your library

1. Go to **Server** (under CONNECT).
2. Choose your backend — **Plex** (or Jellyfin).
3. Under **Link your account**, click **Link Plex**. dumbTV shows you a short **PIN**.
4. In another tab, go to **[plex.tv/link](https://plex.tv/link)**, sign in, and **enter that code**.
5. Come back — dumbTV finds your server and lists your **Libraries**.

Your token is stored **only on the device** running dumbTV. dumbTV never touches your Plex watch state — nothing gets marked watched, nothing lands in Continue Watching.

*(Jellyfin: pick Jellyfin instead, enter your server address, and sign in with your username/password.)*

---

## Step 5 — Build your first channel

1. Go to **Channels**, then **New**.
2. Give it a **number** and a **name** (e.g. `2` · "Retro Toons").
3. Click **Add content** and use **Search** to find shows or movies from your library. Add as many as you like — a channel can be one show or a whole grab-bag.
4. Pick an **ordering mode** — how the channel decides what plays next:
   - **In order** — sequential, episode 1, 2, 3…
   - **Release order** — by air date.
   - **Shuffle** — mixed up, but **deterministic** (the guide always tells the truth — if it says a show is on at 4:00, it's on at 4:00).
   - **Marathon** — long blocks of one thing.
5. *(Optional)* Under **Advanced**, toggle **Run Ads** if you want retro commercial breaks between programs. It's **off by default**.
6. Click **Create this channel**.

dumbTV immediately builds a **two-week schedule** for that channel and starts broadcasting it — whether anyone's watching or not. Add a few more channels the same way.

The TV updates **live** as you make changes — glance over and your new channel is already there.

---

## Step 6 — Watch

Turn to the TV. Tune to a channel and you **join whatever's already airing**, mid-show, exactly like real cable. Here's how you drive it:

| | Bring up channel info | Change channel | Open the guide | Jump to a channel |
|---|---|---|---|---|
| **iPhone / iPad** | **double-tap** the screen | **swipe up / down** | double-tap → **GUIDE** | *(use the guide)* |
| **Apple TV** | press **select** | **swipe / arrows up-down** | press **select** again while info is up | *(use the guide)* |
| **Mac** | **space bar** | **↑ / ↓** (or ⌘↑ / ⌘↓) | **G**, or space → GUIDE | **type the number** |
| **Raspberry Pi (IR remote)** | any button | **CH ▲ / ▼** | **GUIDE** | **type the number** |

Bringing up the channel info also gives you a **Guide**, **Mute**, and **CC** (captions) row on phone/tablet/Mac.

**A few things are deliberately missing:** there's **no pause, no skipping, no rewind**. It's live TV — what's on is on. Those keys just flash a `⊘`. That's the whole idea, not a bug.

---

## The guide

Open the guide for a Prevue-style grid — channels down the side, time across the top, a red line marking *now*, and what's on next. Highlight a channel and select it to tune. Tapping the channel you're **already** watching just closes the guide; tuning to a **new** one waits until the picture is up before it leaves the guide, so you never land on a black screen.

---

## Optional extras (Settings)

- **Kids Mode** — lock the TV to the channels you've marked kid-safe. Turn it on/off from the (PIN-protected) settings.
- **Bedtime / dark hours** — have channels go dark (a "please stand by" card) overnight, e.g. 8pm–7am.
- **Household PIN** — gate the settings so kids can't reconfigure the box.
- **Commercials** — drop in your own retro ad clips/bumpers (a `media/ads` folder) to play in the ad breaks.

---

## Getting back to the setup screen

Need the QR code or setup address again after you've linked Plex? **Tune to
channel 0.** Dial `0`, or open the guide and pick the **SETUP** row at the very
top. Channel 00 is always the setup screen — it shows the QR and the address
whether or not anything is configured. Change the channel to leave it.

---

## Just want to look around?

You don't need Plex to see how it works. On first launch with nothing linked, dumbTV runs a **built-in demo lineup** — a few channels off a bundled test clip, complete with the guide and join-in-progress. A **DEMO** chip shows in the corner. Link Plex whenever you're ready and the demo disappears.

---

## Troubleshooting

**The setup page won't load.**
Make sure your phone/laptop is on the **same network** as the TV, and that you allowed **local network** access on iOS. Re-type the exact address shown on the SET UP card.

**"Link Plex" isn't finding my server.**
Confirm the code at **plex.tv/link** while signed into the **same Plex account** that owns the server, and that the server is powered on and on your network.

**A show won't play / gets skipped.**
dumbTV **never transcodes** — it direct-plays only. A file your device can't play directly is excluded and logged rather than transcoded (that's what keeps channel changes instant). Most standard formats play fine; some exotic containers won't.

**The channel is showing "please stand by."**
That channel has nothing scheduled right now (empty channel, or it's inside your Bedtime window). Add content to it, or check dark-hours in Settings.

**Nothing is on / colour bars.**
Colour bars mean the picture is still coming up (tuning). If it persists, the channel may have no playable content — add shows in the web config.

---

## Why it works this way

dumbTV doesn't stream on demand — it **precomputes a schedule** and plays from the clock. That's what makes channel changes instant, lets you join shows in progress, keeps a **truthful printable guide**, and survives a power cut (turn it back on and the right thing is on). The "limitations" — no pause, no menus, no endless choice — are the product. **What's on is what's on.**
