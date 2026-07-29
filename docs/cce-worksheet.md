# CCE renewal worksheet — the 40 titles blocking the pack pipeline

**Written 2026-07-29.** These are the items whose manifests claim `rightsBasis: "NR"`
("copyright not renewed") with no citation. The v2 validator refuses to build them
until someone records what was actually checked, which is deliberate: an
unverified "not renewed" is a lead, not a clearance — it is exactly how *March of
the Wooden Soldiers* passed as public domain for decades.

Nothing here can be automated. A script cannot open a renewal volume.

---

## The rule you are checking against

A film published in the US between **1923 and 1963** kept its copyright only if
the owner filed a **renewal in the 28th year** after publication. Miss that
window and the work fell into the public domain permanently.

So for each title: **find the renewal volumes for `year + 27` and `year + 28`,
and confirm no renewal was filed.** Both years, because filings straddle the
boundary and clerks were not always precise.

(Works published 1964–1977 got automatic renewal under the 1992 Act. None of
ours are in that range — the Ford film is 1960, so it still needed a filing.)

## Where to look

**For everything except the Ford film — the printed Catalog of Copyright Entries.**
The Copyright Office published these; they are scanned and free:

- archive.org, search: `Catalog of Copyright Entries Motion Pictures`
- You want the **Motion Pictures** class, **Renewal Registrations** section.
- Also on Google Books and HathiTrust.

**For the 1960 Ford film — copyright.gov.** Its renewal window is 1987–88, and
the Copyright Office's online records cover **1978 onward**, so this one is a
website search rather than a scanned book:
[cocatalog.loc.gov](https://cocatalog.loc.gov) → search by title and by claimant.

## The efficient way to do this

**These are not 40 separate searches — they are 9 volume-pairs.** Everything
from one production year renews in the same two volumes, so you open a volume
once and scan for every title from that year at the same time.

Better still: search by **claimant** rather than by title. Paramount, Warner
Bros. and National Comics each renewed in bulk, so if a studio filed for its
1942 catalogue you will see the whole block at once — and any of your titles
either appears in it or does not.

---

## The worksheet

### 1 · BOSKO & FRIENDS — 16 titles, 1931 → check CCE **1958** and **1959**

Claimant to search: **Warner Bros. Pictures** (also *Leon Schlesinger*, the
producer, who sometimes filed separately).

- [ ] Big Man from the North
- [ ] Ain't Nature Grand
- [ ] Ups 'n Downs
- [ ] Dumb Patrol
- [ ] Yodeling Yokels
- [ ] Bosko's Holiday
- [ ] The Tree's Knees
- [ ] Lady, Play Your Mandolin!
- [ ] Smile, Darn Ya, Smile!
- [ ] One More Time
- [ ] Bosko Shipwrecked!
- [ ] Bosko the Doughboy
- [ ] You Don't Know What You're Doin'!
- [ ] Bosko's Soda Fountain
- [ ] Bosko's Fox Hunt
- [ ] Red Headed Baby

> ⏳ **These 16 have an escape hatch.** 1931 publications clear by AGE on
> **2027-01-01** under the 95-year rule — five months away. If you would rather
> not do this research at all, waiting resolves them with no lookup and no risk.
> Everything else on this list does not have that option.

### 2 · SUPERMAN — 17 titles → three volume-pairs

Claimant to search: **Paramount Pictures**, and **National Comics Publications**
(the character's owner; the well-repeated story is that National let the shorts
lapse, which is precisely the claim needing verification).

**1941 → check CCE 1968 and 1969**
- [ ] The Mad Scientist
- [ ] The Mechanical Monsters

**1942 → check CCE 1969 and 1970**
- [ ] Billion Dollar Limited
- [ ] The Arctic Giant
- [ ] The Bulleteers
- [ ] The Magnetic Telescope
- [ ] Electric Earthquake
- [ ] Volcano
- [ ] Terror on the Midway
- [ ] Japoteurs
- [ ] Showdown
- [ ] Eleventh Hour
- [ ] Destruction, Inc.

**1943 → check CCE 1970 and 1971**
- [ ] The Mummy Strikes
- [ ] Jungle Drums
- [ ] The Underground World
- [ ] Secret Agent

### 3 · POPEYE IN COLOR — 3 titles → three volume-pairs

Claimant: **Paramount Pictures** / **King Features Syndicate**.

- [ ] 1936 · Popeye the Sailor Meets Sindbad the Sailor → CCE **1963**, **1964**
- [ ] 1937 · Popeye the Sailor Meets Ali Baba's Forty Thieves → CCE **1964**, **1965**
- [ ] 1939 · Aladdin and His Wonderful Lamp → CCE **1966**, **1967**

### 4 · SATURDAY MORNING — 3 Betty Boop titles

Claimant: **Paramount Pictures** / **Fleischer Studios**.

- [ ] 1932 · Minnie the Moocher → CCE **1959**, **1960**
- [ ] 1933 · The Old Man of the Mountain → CCE **1960**, **1961**
- [ ] 1937 · House Cleaning Blues → CCE **1964**, **1965**

### 5 · AD BREAK — 1 title, online search

- [ ] 1960 · Wonderful New World of Fords → **cocatalog.loc.gov**, renewal window
      **1987–1988**. Search the title and the claimant (**Ford Motor Company**,
      and the producer — sponsored films were often registered by the production
      house, not the sponsor).

---

## Two traps to watch for

**The retitled reissue.** A short re-released under a new name could carry its
own fresh registration. Finding nothing under the original title is not the end
of the search — scan the claimant's block for anything that looks like the same
film wearing a different hat. This is what caught out *Wooden Soldiers*.

**The restoration.** Even where the film is clear, a modern restoration is its
own derivative copyright. Our packs already pull raw Archive scans rather than
boutique transfers, and that rule stands regardless of what you find here.

---

## What to write down

For each title, two things:

1. **Did you find a renewal?** If yes — that title cannot ship, full stop.
2. **What did you check?** The volume and year, e.g.
   `"CCE 1969 & 1970, Motion Pictures, Renewal Registrations — Paramount block scanned, no entry"`.

That sentence goes into the manifest as `license.verifiedBy`, which is the field
the validator is waiting for. Hand me the results in any form — a list, a photo
of your notes — and I will write them into the manifests, re-run `verify`, and
rebuild the packs.

## If you would rather not do this

Three alternatives, all legitimate:

- **Wait on BOSKO** (five months) and **drop the other 24** from the shipped packs.
  SNAFU, SPACE and EARLY DISNEY are GOV/AGE basis, already pass, and are enough
  for a preload lineup.
- **Narrow the packs** to what is citable and reduce them rather than removing them.
- **Pay for it.** A copyright search firm will run these for roughly $75–150 per
  title, which is real money for 24 titles but is a defensible expense given three
  of these packs ship inside the App Store binary.
