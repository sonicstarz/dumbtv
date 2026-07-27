#!/bin/sh
# Container first-run niceties. Deliberately thin — the app already handles its
# own schema, migrations and top-up on boot; this only covers things that are
# specific to running inside a container.
set -e

# A bind-mounted host directory arrives owned by the host user, which may not be
# `node`. Say so plainly instead of dying on an opaque SQLITE_CANTOPEN later.
if [ ! -w "$(dirname "${DUMBTV_DB:-/data/dumbtv.db}")" ]; then
  echo "dumbTV: /data is not writable by uid $(id -u)."
  echo "        Use a named volume (the default in docker-compose.yml), or run:"
  echo "        chown -R $(id -u):$(id -g) <your-host-dir>"
  exit 1
fi

# Jellyfin/Plex usually live on the host or another container. Docker Desktop
# and colima resolve host.docker.internal automatically; on plain Linux they do
# not, which is the single most common "why can't dumbTV see my server" report.
# The compose file maps it via extra_hosts — this only warns if that's missing.
if [ "${DUMBTV_CHECK_HOST_GATEWAY:-1}" = "1" ]; then
  if ! getent hosts host.docker.internal >/dev/null 2>&1; then
    echo "dumbTV: note — host.docker.internal does not resolve in this container."
    echo "        If your Jellyfin/Plex runs on the Docker host, add to your service:"
    echo "          extra_hosts:"
    echo "            - \"host.docker.internal:host-gateway\""
  fi
fi

exec "$@"
