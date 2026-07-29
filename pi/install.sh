#!/usr/bin/env bash
# dumbTV — Raspberry Pi installer.
#
# Turns a Raspberry Pi into a boot-to-TV appliance: installs Node + mpv, runs
# dumbTV as a systemd service, and advertises it at dumbtv.local. Configure it
# from any phone/laptop browser on the network.
#
#   curl -fsSL https://raw.githubusercontent.com/sonicstarz/dumbtv/main/pi/install.sh | bash
#
# Tested target: Raspberry Pi OS (Bookworm, 64-bit). Pi 4 recommended.
set -euo pipefail

say() { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }
# --packs: after install, download the starter public-domain channel packs so
# the Pi has real content on first boot without linking Plex (Track I).
WANT_PACKS=0
for a in "$@"; do [ "$a" = "--packs" ] && WANT_PACKS=1; done
[ "$(id -u)" -eq 0 ] && SUDO="" || SUDO="sudo"
USER_NAME="$(whoami)"
APP_DIR="${DUMBTV_DIR:-$HOME/dumbtv}"

say "System packages (mpv, git, avahi)"
$SUDO apt-get update
$SUDO apt-get install -y mpv git avahi-daemon curl ca-certificates

say "Node.js 22 (better-sqlite3 needs a modern Node)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi
echo "node $(node -v)"

say "dumbTV app -> $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone --depth 1 https://github.com/sonicstarz/dumbtv.git "$APP_DIR"
fi
cd "$APP_DIR"
npm install --omit=dev

say "systemd service (boot to dumbTV)"
# Renders mpv straight to HDMI via DRM/KMS on the console — no desktop needed.
$SUDO tee /etc/systemd/system/dumbtv.service >/dev/null <<UNIT
[Unit]
Description=dumbTV
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$APP_DIR
Environment=DUMBTV_PLAYER=mpv
# mpv on a console Pi needs DRM output; the engine passes these through.
Environment="DUMBTV_MPV_ARGS=--vo=gpu --gpu-context=drm"
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=3
# Give the service the console/TTY so mpv can own the screen.
TTYPath=/dev/tty1
StandardInput=tty
StandardOutput=journal

[Install]
WantedBy=multi-user.target
UNIT

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now dumbtv

if [ "$WANT_PACKS" = "1" ]; then
  say "Starter content packs (public domain)"
  ( cd "$APP_DIR" && node scripts/install-starter-packs.js ) || \
    echo "  (pack install skipped/failed — you can run 'npm run install-starter-packs' later)"
fi

say "mDNS (dumbtv.local)"
$SUDO systemctl enable --now avahi-daemon
$SUDO hostnamectl set-hostname dumbtv 2>/dev/null || true

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<DONE

== dumbTV is installed and running ==

Configure it from another device's browser:
    http://dumbtv.local:8080     (or http://${IP:-<pi-ip>}:8080)

Then link Plex, build a channel, and plug the Pi's HDMI into your TV.

Next, on the Pi itself:

  - A remote:  a FLIRC dongle turns any old IR remote into this. See
               docs/pi-remote.md for the keymap and how to program it.
               No remote yet? Open http://dumbtv.local:8080/remote on a phone —
               it drives the same player.

  - A CRT:     ./pi/crt.sh            shows what your display is doing now
               ./pi/crt.sh --apply    sets a 480-line mode, then reboot
               Use an HDMI->composite converter box rather than the Pi's own
               composite out — steadier sync, and a much better picture.

  - Overnight: set a sleep window in the web UI under Settings. The picture
               blanks and comes back in the morning; the schedule keeps running,
               so the channel is mid-programme when it returns. Blanking, never
               halting — it wakes instantly on any key.

Notes:
  - Display output uses mpv DRM/KMS (--vo=gpu --gpu-context=drm). If the
    picture doesn't appear, confirm HDMI is detected and the user is in the
    'video', 'render' and 'input' groups:
      sudo usermod -aG video,render,input $USER_NAME
  - Edges cut off on a CRT? Widen the safe area rather than the display mode:
      sudo systemctl edit dumbtv     ->  Environment=DUMBTV_SAFE_AREA=0.10
  - Logs:      journalctl -u dumbtv -f
  - Restart:   sudo systemctl restart dumbtv
DONE
