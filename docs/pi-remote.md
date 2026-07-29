# The remote — programming a real one for dumbTV

The Pi is the only dumbTV that expects a **physical remote**. This is the keymap
it answers to, and how to teach a remote to send it.

The map is asserted by `npm run selftest`, so it cannot drift from the code
without a test failing.

---

## The keymap

| Remote button | Sends | What dumbTV does |
| --- | --- | --- |
| **0–9** | `0`–`9` | Dial a channel. Two-second commit window, like a cable box. |
| **CH ▲ / CH ▼** | `Up` / `Down` | Previous / next channel. In the guide, move the selection. |
| **◀ / ▶** | `Left` / `Right` | Nothing — flashes ⊘. There is no seeking. |
| **OK / SELECT** | `Enter` | In the guide, watch the highlighted channel. Otherwise show the banner. |
| **GUIDE** | `g` | Open / close the guide. |
| **INFO** | `i` | Bring the banner back. |
| **CC / SUBTITLE** | `c` | Captions on / off. |
| **MUTE** | `m` | Mute on / off. Persists across channels and restarts. |
| **SLEEP** | `s` | 30 → 60 → 90 minutes → off. |
| **BACK / EXIT** | `Esc` | Dismiss the guide or the banner. Never quits. |
| **PLAY / PAUSE** | `Space` | Nothing — flashes ⊘. **This is the product, not a bug.** |

Two deliberate choices worth knowing before you program anything:

**GUIDE is not a number.** An earlier version put the guide on `1`, which meant
channel 1 could never be dialled — and channel 1 is SPACE, a channel dumbTV
ships with. Along with 10–19 and everything over 100. Every digit dials now.

**PLAY/PAUSE is bound to nothing on purpose.** Every remote ever made has that
button, and if it were left unbound mpv would handle it itself and actually
pause the broadcast. It is caught and ignored so it flashes ⊘ like the rest of
invariant #1.

---

## Option A — FLIRC (recommended, ~$20)

A [FLIRC USB](https://flirc.tv) dongle learns any infrared remote and presents
itself to the Pi as an ordinary USB keyboard. No kernel modules, no device-tree
overlays, nothing to configure on the Pi at all — dumbTV just sees key presses.

Use **any** remote you already own: an old cable box remote, a spare TV remote,
one from a charity shop. A dead 90s remote is period-correct and costs nothing.

1. Install the FLIRC GUI on a Mac/PC (not the Pi) and plug in the dongle.
2. Choose **Controllers → Full Keyboard**.
3. Click a key on the on-screen keyboard, then press the button on your remote
   you want to map to it. Work through the table above.
4. Unplug the dongle from the computer and plug it into the Pi. Done — the
   mapping lives on the dongle, not on either machine.

Because the map lives on the dongle, the same one works on any dumbTV box, and
reflashing the Pi does not lose it.

## Option B — GPIO IR receiver (~$2)

A TSOP38238 (or similar 38 kHz receiver) wired to a GPIO pin, decoded by the
kernel's `gpio-ir` driver. Cheaper and tidier inside an enclosure — no dongle
sticking out — but it needs a device-tree overlay and a keymap file, and it is
per-Pi rather than per-dongle.

Wiring: **OUT → GPIO 18**, **VCC → 3.3 V**, **GND → GND**.

```bash
# /boot/firmware/config.txt
dtoverlay=gpio-ir,gpio_pin=18
```

Then reboot and check it sees your remote:

```bash
sudo apt install ir-keytable
sudo ir-keytable -t          # press buttons; scancodes should appear
```

Write a keymap that maps those scancodes to the keys in the table
(`KEY_1`, `KEY_G`, `KEY_UP`, …), install it under `/etc/rc_keymaps/`, and load
it with `ir-keytable -w`. This is the fiddlier path; it is the right one for a
**prebuilt SD image**, where the whole stack is under our control and the buyer
should not have to program anything.

## Option C — no remote yet

A USB keyboard works, using exactly the keys in the table. So does the **phone
remote** at `http://dumbtv.local:8080/remote` — which is the fastest way to test
a fresh install before any IR hardware arrives.

---

## Checking it works

```bash
journalctl -u dumbtv -f
```

Press buttons. Every recognised key logs a line. If nothing appears:

- **FLIRC**: does the Pi see it as a keyboard? `ls /dev/input/by-id/ | grep -i flirc`
- **GPIO**: does `ir-keytable -t` show scancodes? If not, it is wiring, not software.
- **Neither**: the service needs the console — confirm `TTYPath=/dev/tty1` in
  `/etc/systemd/system/dumbtv.service` and that the user is in the `video`,
  `render` and `input` groups.
