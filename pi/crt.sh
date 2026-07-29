#!/usr/bin/env bash
# dumbTV — set a Raspberry Pi up to drive a CRT.
#
#   ./pi/crt.sh            # show what is set now, change nothing
#   ./pi/crt.sh --apply    # write the display mode and reboot-required notice
#
# Two ways to get a picture onto a tube, and the cheap-looking one is better:
#
#   HDMI -> composite converter box  (RECOMMENDED)
#     A £15 box. Works on every Pi, gives a stable 480i/576i signal, and
#     handles the sync quirks that older sets are fussy about. This is what to
#     buy.
#
#   The Pi's own composite output
#     Pi 4: a 4-pole 3.5mm jack (video on the tip-ring-ring-sleeve, so you need
#     the right cable and the right pinout). Pi 5: NOT a jack at all — a solder
#     pad on the board. Either way the picture is noticeably softer than a
#     converter's, and you give up HDMI audio.
#
# 480 lines is the target. A CRT does not have more, and driving 720p into a
# converter just means the converter throws pixels away — overlays end up
# thinner and harder to read than if we had rendered them at the real size.
set -euo pipefail

say() { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }

CONFIG=/boot/firmware/config.txt
[ -f "$CONFIG" ] || CONFIG=/boot/config.txt      # pre-Bookworm
APPLY=0
for a in "$@"; do [ "$a" = "--apply" ] && APPLY=1; done

say "Current display"
if command -v tvservice >/dev/null 2>&1; then
  tvservice -s || true
fi
if [ -d /sys/class/drm ]; then
  for c in /sys/class/drm/card*-*/status; do
    [ -e "$c" ] || continue
    printf '  %-28s %s\n' "$(basename "$(dirname "$c")")" "$(cat "$c")"
  done
fi

say "Config in $CONFIG"
grep -nE '^\s*(hdmi_group|hdmi_mode|sdtv_mode|sdtv_aspect|enable_tvout|disable_overscan|overscan_)' \
  "$CONFIG" 2>/dev/null || echo "  (nothing display-related set — using defaults)"

BLOCK=$(cat <<'EOF'

# ── dumbTV: CRT output ──────────────────────────────────────────────────────
# 640x480 @60Hz, which a converter box turns into clean 480i for the tube.
hdmi_group=2
hdmi_mode=4
# Let the set overscan naturally. dumbTV already keeps everything inside a
# safe area, so cropping in firmware as well would inset it twice — tune
# DUMBTV_SAFE_AREA instead, while looking at the actual screen.
disable_overscan=1
EOF
)

if [ "$APPLY" = "1" ]; then
  if grep -q 'dumbTV: CRT output' "$CONFIG" 2>/dev/null; then
    say "Already applied — leaving $CONFIG alone"
  else
    say "Writing CRT mode to $CONFIG"
    printf '%s\n' "$BLOCK" | sudo tee -a "$CONFIG" >/dev/null
    echo "  done — REBOOT for it to take effect"
  fi
else
  say "Would append to $CONFIG (re-run with --apply)"
  printf '%s\n' "$BLOCK"
fi

cat <<'NOTES'

== Tuning it on the actual set ==

1. Reboot, then look at the screen. The picture should fill it, with the
   channel banner and the guide comfortably inside the visible area.

2. If anything is cut off at the edges, widen dumbTV's safe area rather than
   changing the display mode — the mode is right, the tube is just hiding more
   than average:

     sudo systemctl edit dumbtv
       [Service]
       Environment=DUMBTV_SAFE_AREA=0.10        # 10% inset instead of 7.5%
     sudo systemctl restart dumbtv

   Anything from 0.05 to 0.12 is reasonable. It is capped at 0.20.

3. If the picture rolls, tears, or is black and white on a colour set, that is
   the converter or the cable, not the Pi. PAL/NTSC switches on cheap
   converters are frequently mislabelled — try the other position.

4. Sound goes out over the HDMI converter's audio jack, or set the Pi to
   analogue out:  sudo raspi-config → System → Audio.

NOTES
