# tvOS input — one rule, and why it keeps getting broken

Four builds in a row shipped a variant of the same bug. This document exists so
the fifth one gets caught in review instead of on a television.

| Build | Commit | What shipped broken |
|---|---|---|
| 21 | `ac9ac83` | Setup drew while the channels kept driving — Setup didn't take the remote |
| 21 | `877f491` | Two handlers fought over SELECT |
| 22 | `70ddb52` | A Button on the setup card ate the focus — SELECT dead on the watch screen |
| 24 | *(B25-1)* | The first-run carousel needed a **double** click; single did nothing |
| 24 | *(B25-2)* | Back out of a pack detail and the remote died completely |

Every one of them is the same underlying fact.

---

## The rule

> **tvOS gives focus to exactly ONE thing. `TVView` is that thing on the watch
> screen. Do not put a focusable control on any surface drawn over it.**

`TVView` declares `.focusable(!setupShowing)`, claims focus in `.onAppear`, and
reads the remote directly:

```
.onMoveCommand   → channel up/down, guide scroll, first-run paging
.onTapGesture    → SELECT  (selectPressed)
.onExitCommand   → Menu
.onPlayPauseCommand → ⊘  (invariant #1)
```

A `Button` on a card drawn above it is a **second** focusable. The tvOS focus
engine then spends your first SELECT press *moving focus onto it* and only fires
it on the second press.

**That is the entire explanation for "single click does nothing, double click
works."** It is not a debounce, not a gesture conflict, not a race.

### What to do instead

Draw the affordance, don't make it a control. The root already has the press:

```swift
#if os(tvOS)
nextLabel                                  // just the pill. SELECT is wired at the root.
#else
Button(action: advance) { nextLabel }      // touch + mouse need a real control
    .buttonStyle(.plain)
#endif
```

`SetupCard.swift` and `FirstRunPopup.swift` both carry this shape. `Engine.swift`
documents the same constraint from the other side.

### The one exception

**Setup is a full screen, not an overlay on the picture.** It sets
`setupShowing`, which turns `TVView`'s `.focusable()` *off* — so `SetupView`,
`PackGrid` and `PackDetail` are free to use real `Button`s and `@FocusState`,
because the root has stood down. This is why the pack grid works and a button on
the watch screen does not.

---

## Corollary: an overlay that takes focus must give it back

`PackDetail` is presented as an `.overlay` with its own `@FocusState`. When it
unmounts, **tvOS does not restore focus to what was underneath.** The parent's
`@FocusState` still names something, but nothing on screen holds focus — the
remote is dead and Menu is the only way out.

So: any view that presents a focus-owning overlay must re-anchor when it closes.

```swift
.onChange(of: detail?.id) { id in
    guard id == nil else { return }
    anchor = .pack(id)          // an id a visible view ACTUALLY carries
}
```

Two traps, both hit while fixing B25-2:

- **Re-anchor after the teardown, not during it.** Assigning focus inside the
  Back closure runs in the same update that removes the overlay and is dropped.
- **Never anchor on an identity nothing renders.** `.pack("")` is
  indistinguishable from no focus at all. If the tile you came from is gone (the
  detail screen has a REMOVE button), fall back to one that exists.

Every focusable in a collection needs its **own** identity. The pack grid used to
give `.pack` to the first tile and bind every other tile to `nil`, so the grid had
a single anchor and there was nowhere specific to return to.

---

## Review checklist

- [ ] No `Button`, `.focusable()` or `@FocusState` added to a view drawn over the
      watch screen while `TVView` holds focus.
- [ ] No `.onTapGesture(count: 2)` anywhere in a tvOS path. Double-press is not an
      input we accept. (The two in `TVView` are inside `#if os(iOS)` — touch
      double-tap is fine and is a different gesture.)
- [ ] Any new focus-owning overlay re-anchors its parent on dismiss.
- [ ] New remote behaviour was tried with a **real remote**. The simulator does
      not reproduce the focus engine faithfully, which is how three of these
      shipped. Build 23's commit message is the precedent: state plainly whether a
      real press was tested.
