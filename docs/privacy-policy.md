# dumbTV — Privacy Policy

**Last updated: 4 August 2026**

dumbTV is built to collect nothing. This policy explains that in plain language.

## The short version

- **We don't collect any personal data.** No accounts, no analytics, no tracking, no advertising.
- dumbTV runs **on your device and your home network**. It talks only to **your own Plex Media Server** (or Jellyfin server) that you point it at.
- Your **Plex/Jellyfin login token stays on your device.** It is never sent to us or to any third party.
- **We operate no servers that receive your data.** There is no dumbTV cloud, account system, or backend that your usage passes through.

## What the app stores (on your device only)

To work as a cable box, dumbTV keeps a local configuration on the device — your channels, your schedule, and the credentials for the media server you linked. This data lives **only on that device** and is used **only** to play your library and show the guide. It is never transmitted to us.

dumbTV **never modifies your Plex watch state** — nothing is marked watched, and nothing is added to Continue Watching.

## Network access

dumbTV connects over your local network to:

1. **Your media server** (Plex or Jellyfin) — to browse your library and play video directly. This traffic stays between your device and your server.
2. **plex.tv** — only if you link a Plex account, to complete the standard sign-in (PIN) flow. This is a direct connection between your device and Plex; we are not in the middle.
3. **archive.org** (and, for the SPACE channel, **images.nasa.gov**) — only if you install one of the built-in content packs. Your device downloads those public-domain films straight from the source. We are not in the middle, there is no account, and nothing is reported back to us.
4. **dumbtv.app** — only when you *open the Channel Packs page*, to fetch the current list of available packs. Not on launch, not on a schedule, and never in the background: if you never open that page, dumbTV never contacts us at all. The request carries no identifier — it is a plain download of a public file, and dumbTV works without it using the copy built into the app.
5. **api.anthropic.com** — only if you set up the AI lineup builder with your own API key, and only at the moment you press *Plan a lineup*. Never on launch, never on a schedule, never in the background. See below.

That's all. dumbTV makes no other network calls — no analytics, no telemetry, no crash reporting, no check-in of any kind.

## The AI lineup builder

dumbTV can build a channel lineup for you. There are two ways it does that, and they are not the same on privacy.

**By default, nothing leaves your device.** dumbTV's own builder groups your library by genre and era using rules that run locally. It is free, it needs no account, and it makes no network call at all. If you never switch away from it, this section does not apply to you.

The other option sends your library to **Anthropic** (the makers of Claude) to get a better lineup back. This only happens if you deliberately choose it *and* paste in your own Anthropic API key. When you press *Plan a lineup*, and only then, dumbTV sends:

- **A list of the titles in your library** — the names of your shows and films, and roughly how many episodes each has.
- **The answers you gave** on that page — what you like, what to keep off, how many channels you want.

It does **not** send your video files, your viewing history, your Plex or Jellyfin credentials, your server address, or anything about who you are. There is no account and no identifier attached to the request.

**Your API key stays on that one device.** It is never synced to another device, never written to a log, and is deliberately left out of config exports — export your setup and hand it to a friend, and your key does not travel with it. It is sent to api.anthropic.com and nowhere else.

The request goes **directly from your device to Anthropic under your own key**. We are not in the middle, we never see it, and we operate no server that it passes through. What Anthropic does with it is governed by their policies — see the [Anthropic Privacy Policy](https://www.anthropic.com/legal/privacy) and [their terms](https://www.anthropic.com/legal/consumer-terms). Because it is your key and your account, that relationship is between you and them.

## This website

The dumbTV website (**dumbtv.app**) runs **no third-party analytics, advertising, or tracking cookies**. The site is hosted by **Netlify**, which keeps standard server access logs — IP address, page requested, timestamp — for security and reliability. We do not use those logs to identify or track anyone, and we do not combine them with anything else. The same applies to the pack list the app downloads from this domain.

## Children

dumbTV is safe for all ages and collects no data from anyone, including children. What plays on a channel is entirely determined by the media library you connect. An optional PIN-protected Kids Mode lets a parent limit which channels are available.

## Changes

If this policy ever changes, we'll update this page and the "Last updated" date above.

## Contact

Questions about privacy? Contact us at **_[CONTACT EMAIL — e.g. privacy@dumbtv.app]_**.

---

*This matches the app's App Store privacy declaration: **Data Not Collected**. That declaration covers data collected by **us** — and we collect none. The AI lineup builder sends data from your device to Anthropic under **your own** API key and our servers are not involved, which is why it does not change the declaration. If dumbTV ever offers AI runs on a key we supply, this has to be revisited before that ships.*
