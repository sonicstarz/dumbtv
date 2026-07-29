# dumbTV — FAQ

Source copy for the `/faq` page. Grouped for scanning; the site can render these
as an accordion or plain sections. Keep the dry, plain-spoken voice.

## The basics

**What is dumbTV?**
It turns your Plex library into a 1990s cable box. Instead of scrolling a grid
deciding what to watch, you turn it on and take what's on. You build channels
once; dumbTV runs them as continuous broadcasts and you join whatever's already
airing.

**Do I need a Plex server?**
Yes — a Plex Media Server on your network, with some shows or movies in it.
(Jellyfin works too.) You can try dumbTV without one using the built-in demo.

**Can I try it before linking anything?**
Yes. On first launch with nothing configured, dumbTV runs a built-in **demo
lineup** off a bundled clip — real channels, real guide, join-in-progress — with
a DEMO chip in the corner. Link Plex whenever you're ready.

**What devices does it run on?**
iPhone, iPad, Apple TV, and Mac. You can also self-host on a Raspberry Pi or
Windows.

**Is it free? Is there an account?**
No account, ever. No sign-up, no cloud. *(Price: [confirm — free].)*

## Watching

**Why can't I pause, skip, or rewind?**
Because it's live TV — what's on is on. That's the entire idea, not a missing
feature. Those keys just flash a ⊘. It's the antidote to endless choice and
"are you still watching."

**How do I change channels / open the guide?**
- **iPhone/iPad:** swipe up/down to change channels; double-tap for channel info
  and the Guide/Mute/CC controls.
- **Apple TV:** arrows/swipe to change channels; press select for info, again for
  the guide.
- **Mac:** ↑/↓ (or ⌘↑/⌘↓) to change channels; space for info; G for the guide;
  type a number to jump.

**What's the guide?**
A Prevue-style grid — channels down the side, time across the top, a red line at
"now," and what's on next. Highlight a channel and select it to tune.

**Does it change my Plex watch state?**
No. Nothing is marked watched, and nothing is added to Continue Watching. dumbTV
never touches your Plex history.

**What can I watch?**
Anything in your library that **direct-plays**. dumbTV never transcodes — that's
what keeps channel changes and join-in-progress instant. Most standard formats
play fine; a few exotic containers may be skipped and logged.

## Building channels

**How do I build a channel?**
In the web setup page (opened from your phone or laptop): Channels → New → give it
a number and name → Add content (search your library) → pick an ordering mode →
Create. dumbTV builds a two-week schedule instantly.

**What are the ordering modes?**
In order (sequential), Release order (by air date), Shuffle (mixed but
**deterministic** — the printed guide is always true), and Marathon (long blocks
of one thing).

**Can a channel be just one show? Or a mix?**
Either. One show, a themed grab-bag, a movie channel — your call.

**How many channels can I make?**
As many as you like.

**Can I add commercials?**
Yes — drop your own retro ad clips/bumpers into the media folder and toggle
**Run Ads** on a channel (it's off by default) for breaks between programs.

**Is there a kids/parental option?**
Yes. Kids Mode locks the TV to channels you've marked kid-safe, and a household
PIN protects the settings. There's also a Bedtime / dark-hours option so channels
go dark overnight.

## Setup & privacy

**How do I get the setup QR / address back after linking Plex?**
Tune to **channel 0**. Dial `0`, or pick the **SETUP** row at the top of the
guide. Channel 00 is always the setup screen — it shows the QR code and the
config address any time, configured or not. Change the channel to leave.

**Where do I configure it — on the TV?**
On your phone or laptop. The TV shows a setup URL + QR code; you do everything in
that web page. Nothing to type on the TV itself.

**iOS asked to connect to devices on my network — is that safe?**
Yes, and you should allow it. That permission is how dumbTV reaches your Plex
server and serves its setup page. Denying it prevents setup from connecting.

**Does dumbTV collect my data or track me?**
No. No analytics, no tracking, no ads, no account. It runs on your device and
your network and talks only to your own media server. Your Plex token never
leaves your device. (See the Privacy Policy.)

**Does it work without internet?**
It needs your local network and your media server. There's no cloud dependency —
it plays from your own server.

**Can I watch dumbTV channels inside Plex, Jellyfin or Channels DVR?**
Not as live channels, and that's deliberate. Making channels appear in another
app means pretending to be an HDHomeRun tuner and serving a continuous encoded
stream for each one — permanent transcoding, which is exactly what dumbTV is
built not to do. Transcoding kills instant seeking, and instant seeking is how
you join a show already in progress.

What you can do is take the **listings**: dumbTV publishes its full schedule as
XMLTV at `/api/xmltv`, so any guide app that reads XMLTV can show what's on.
And you can watch on essentially anything already — iPhone, iPad, Apple TV, Mac,
or a browser pointed at `/tv`.

**Do you need a beefy machine / hardware transcoding?**
No, and that's a real difference from other projects in this space. dumbTV never
transcodes, so there is nothing to accelerate. A Raspberry Pi is plenty.

**Why is all the built-in content so old?**
Because it's genuinely public domain, and dumbTV checks rather than assumes.
Every bundled item records what its public-domain status rests on — a US
government production, an old-enough publication date, or a verified failure to
renew — and anything that can't be evidenced doesn't ship. dumbTV doesn't
include Creative Commons material either: it's free to use but usually requires
on-screen attribution, and a television is a bad place to put a credits line.

## Trouble

**The setup page won't load.**
Make sure your phone/laptop is on the same network as the TV, and that you
allowed local-network access on iOS. Re-type the exact address on the SET UP card.

**"Link Plex" can't find my server.**
Enter the code at **plex.tv/link** while signed into the same Plex account that
owns the server, and make sure the server is on and on your network.

**A channel says "please stand by" / shows colour bars.**
Colour bars mean it's still tuning. "Please stand by" means nothing is scheduled
right now — the channel is empty or inside your Bedtime window. Add content in
the web config or check dark-hours.

**Still stuck?**
Contact us at **[CONTACT EMAIL]** or open an issue on GitHub.
