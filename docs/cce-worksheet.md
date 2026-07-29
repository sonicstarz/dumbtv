# CCE renewal worksheet — the pack provenance blocker

**Opened 2026-07-29 with 40 titles. 36 cleared the same day.**

These are the items whose manifests claim `rightsBasis: "NR"` ("copyright not
renewed") with no citation. The v2 validator refuses to build them until someone
records what was actually checked, which is deliberate: an unverified "not
renewed" is a lead, not a clearance — it is exactly how *March of the Wooden
Soldiers* passed as public domain for decades.

Nothing here can be automated. A script cannot open a renewal volume.

---

## Status

| Pack | Titles | State |
| --- | --- | --- |
| SUPERMAN | 17 | ✅ cleared — no renewal found |
| BOSKO & FRIENDS | 16 | ✅ cleared — no renewal found (and moot from 2027-01-01) |
| POPEYE IN COLOR | 3 | ✅ cleared — no renewal found |
| SATURDAY MORNING | 3 | ⏳ volumes located, not yet searched |
| AD BREAK | 1 | ⏳ not searched |

Source of the clearances: **"CCE Renewal Research — Public Domain Clearance
Findings", 29 July 2026** — Catalog of Copyright Entries, Third Series, Parts
12–13 (Motion Pictures and Filmstrips), volume scans via the Internet Archive.
Each cleared item now carries the volumes searched in `license.verifiedBy`.

`superman`, `popeye-color` and `bosko-and-friends` pass `verify` and are in
`packs/index.json`. `saturday-morning` and `ad-break` are excluded from the
catalog until the four below are done.

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

---

## Still outstanding — 4 titles

### 1 · SATURDAY MORNING — 3 Betty Boop titles

Claimant: **Paramount Pictures** / **Fleischer Studios**. Volumes already
located: CCE 1959, 1960, 1961, 1964, 1965.

| Manifest id | Title | Year | Check CCE |
| --- | --- | --- | --- |
| `bb-minnie-the-moocher` | Minnie the Moocher | 1932 | **1959**, **1960** |
| `bb-old-man-of-the-mountain` | The Old Man of the Mountain | 1933 | **1960**, **1961** |
| `bb-house-cleaning-blues` | House Cleaning Blues | 1937 | **1964**, **1965** |

> ⚠️ Betty Boop is the one to be careful with. Unlike the Superman and Popeye
> shorts, **several Fleischer Betty Boop cartoons WERE renewed** — this is not a
> library where non-renewal is the pattern, so a negative here needs the same
> neighbourhood check on the scans, not just an OCR miss.

### 2 · AD BREAK — 1 title, online search

| Manifest id | Title | Year |
| --- | --- | --- |
| `ford-wonderful-new-world-1960` | Wonderful New World of Fords | 1960 |

Not a CCE search. Its renewal window is **1987–88**, and the Copyright Office's
online records cover **1978 onward** — so this is a website search:
[cocatalog.loc.gov](https://cocatalog.loc.gov) → search by title and by claimant
(**Ford Motor Company**, and the producer — sponsored films were often
registered by the production house, not the sponsor).

Note: this item's manifest entry has **no `aired` field**, which is why it does
not sort by year with the rest. Worth filling in while you are there.

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
   `"CCE 1959 & 1960, Motion Pictures, Renewal Registrations — Paramount block scanned, no entry"`.

That sentence goes into the manifest as `license.verifiedBy`, which is the field
the validator is waiting for. Hand me the results in any form and I will write
them in, re-run `verify`, and rebuild the packs — the same round trip that
cleared the other 36.

---

## Closed — how the 36 were cleared

Kept because the *method* is the reusable part, and because a future reader
should be able to retrace the work rather than trust it.

**Two passes per pack.** First an OCR full-text search of every relevant
half-year renewal section. Then — because OCR silently drops entries — a visual
check of the **alphabetical neighbourhood** on the page scans, confirming the two
entries that would bracket a filing run consecutively with nothing between them.
An absence you cannot see is not an absence.

**Why the negatives are meaningful.** An absent record could be a missed filing
*or* a gap in the catalogue. What separates the two here is that the same volumes
show these rights holders **actively renewing sibling shorts**:

- Paramount's 1941 one-reelers, renewed in bulk by **Supat Industries** —
  *Snow Dogs*, reg. 25 Jul 1941 (M11369), renewed 11 Sep 1968 as R442320.
- The Popeye one-reelers, by **United Artists Associated** / **United Artists
  Television** — *What, No Spinach?* (MP6500) → R316550, 31 May 1963;
  *The Spinach Roadster* in 1964; *Scrap the Japs* (L11702) → R474660, 11 Dec 1969.
- Paramount's 1943 *Speaking of Animals*, by **National Telefilm Associates**, in 1971.

The renewal machinery was demonstrably running across these libraries in these
very volumes, and our titles are simply not in it.

**Bracketing entries confirmed on the scans** (Superman):

| Section | Page | Entries bracketing where a Superman filing would sit |
| --- | --- | --- |
| 1968 Jul–Dec | 110 | Sunset in Wyoming → Swing It, Soldier |
| 1969 Jan–Jun | 43 | Sunday Punch → Surprised Parties |
| 1969 Jul–Dec | 114 | Strictly in the Groove → Sweet Spirits of Nighter |
| 1970 Jan–Jun | 54 | The Sundown Kid → Super Mouse in Pandora's Box |
| 1970 Jul–Dec | 125 | Submarine Signal → Super Mouse in Down With Cats |
| 1971 Jan–Jun | 66 | The Sultan's Daughter → Super Rabbit |
| 1971 Jul–Dec | 154 | Sundown Valley → Swing Out the Blues |

Popeye pages examined: 1963 Jul–Dec p.125, 1964 Jan–Jun p.61, 1964 Jul–Dec
p.122, 1965 Jan–Jun p.61, 1965 Jul–Dec p.124 (the two "Popeye the Sailor Meets"
titles); 1966 Jul–Dec p.89, 1967 Jan–Jun p.43, 1967 Jul–Dec p.107 (*Aladdin*, in
the A run).

BOSKO: CCE 1958 and 1959, both halves each. No renewal found. **Moot in any
case** — the 95-year term expires 2026-12-31, so these clear by AGE on
**2027-01-01** with no renewal question at all.

---

## Two things this research explicitly did NOT settle

Both are recorded in the affected manifests' `rightsNote`, and neither is a
research task — they are decisions.

**1 · Form 4.** Every CCE renewal page carries the Copyright Office's own footer
noting the printed entries alone may not reflect the complete record, and
pre-1978 renewals are not in the online database. This is the best *published*
evidence short of a formal Copyright Office search report (**Form 4**) — the
belt-and-braces step for a high-stakes pack. Three of these ship inside an App
Store binary, which is the argument for buying it.

**2 · Character and trademark rights — open, and the bigger exposure.**
Non-renewal clears the **film** copyright only. The Superman character (**DC /
National Periodical**) and the Popeye characters (**King Features / Hearst**)
have their own separate and live chains of title — *whose renewals do appear in
these same volumes* — plus trademark rights. That is a distinct question from
the one researched here and **should be reviewed by counsel before publication**.

Operationally, until that review happens: **play the films, keep both characters
out of dumbTV marketing, artwork, store copy and screenshots.**
