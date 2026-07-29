# `content/` — the single source of truth for what dumbTV can play

`catalog.json` is the master list of every public-domain title we have ever
considered, cleared, shipped, or ruled out. **One row per title.**

It exists because the same information used to live in four places at once — a
field guide in `~/Downloads`, `docs/cce-worksheet.md`, three build handoffs, and
the pack manifests — with no single owner. Every research pass rediscovered the
same titles and re-litigated the same decisions. That is the loop this file ends.

```
content/catalog.json   ← you edit this (or the research pass does)
        │
        ├── scripts/catalog.js report     what is shippable, what is not, why
        ├── scripts/catalog.js notion     rows to push to the Notion tracker
        └── scripts/catalog.js manifests  regenerate packs/*/manifest.json
```

Manifests are **generated**. Do not hand-edit `packs/*/manifest.json` for
rights fields — edit here and regenerate, or the next sync silently reverts you.

---

## The rights basis, and which way each one ships

| Basis | Means | Download | Preload (App Store binary) |
| --- | --- | --- | --- |
| `GOV` | US federal work, 17 USC §105. Never had copyright. | ✅ | ✅ |
| `AGE` | Published ≥95 years ago. Deterministic. | ✅ | ✅ |
| `NR` | Renewal checked in the CCE and none found. Needs `verifiedBy`. | ✅ | ✅ |
| `CLAIMED` | **A credible source lists it as PD. We have not checked.** Needs `claimedBy`. | ✅ | ⛔ |
| `BLOCKED` | Known copyrighted. Never ships anywhere. | ⛔ | ⛔ |

`CLAIMED` is the one that makes this catalog move. It lets a title ship the day
we find it, instead of waiting behind a research queue — while keeping it out of
the one place a mistake is expensive.

### Why the two columns differ

A download-catalog entry is **reversible**: the catalog is server-side, we pull
it in minutes, and the bytes come from the Internet Archive rather than from us.

A preloaded item is **not**. It ships inside the binary, cannot be recalled
remotely, needs an app-review cycle to remove, and a rights complaint routed
through Apple can take down the whole app rather than the one file.

That asymmetry — not caution in the abstract — is the entire reason `CLAIMED`
ships one way and not the other.

### Two things `CLAIMED` is honest about

- **"Listed as public domain" is not a legal status.** IA's PD marks are
  user-submitted. *It's a Wonderful Life* is on half the PD sites on the
  internet and is not public domain. The `BLOCKED` rows exist to record every
  such trap we have already identified so nobody re-adds one.
- **Copyright ≠ character.** A film can be clear while the character is not.
  Superman (DC/National) and Popeye (King Features/Hearst) both have live chains
  of title. `characterRisk: true` marks those rows: **play the film, keep the
  character out of all marketing, artwork, store copy and screenshots.**

---

## Row shape

```jsonc
{
  "id": "wb-porkys-railroad",          // stable slug, also the pack item id
  "title": "Porky's Railroad",
  "year": 1937,
  "studio": "Warner Bros.",
  "series": "Looney Tunes",
  "basis": "CLAIMED",
  "claimedBy": "https://…",            // required when basis is CLAIMED
  "verifiedBy": null,                  // required when basis is NR
  "cceVolumes": "1964, 1965",          // which volumes a research pass must open
  "iaItem": "ltmm-publicdomain",       // Internet Archive identifier
  "pack": "looney-tunes",              // target pack, or null if unassigned
  "status": "candidate",               // candidate | shipped | blocked
  "contentWarning": ["racial-caricature"],
  "characterRisk": false,
  "notes": "Blue Ribbon reissue — verify individually."
}
```

`cceVolumes` is precomputed as `year + 27` and `year + 28`, because that is the
renewal window and having it in the row is what makes the research pass
mechanical rather than a lookup every time.
