# dumbTV — headless self-host image (Track B).
#
# What this runs: the Fastify config server + the BROWSER television at /tv.
# There is deliberately no mpv in here. mpv needs a display, and a container on
# someone else's laptop has none — but dumbTV already ships a full TV in the
# browser (public/tv.html), so `DUMBTV_PLAYER=none` gives you the whole product
# through two tabs: the setup page and the picture. On a Pi you want the mpv
# path instead; use pi/install.sh, not this.
#
#   docker compose up -d      → setup at :8080, television at :8080/tv
#
# Base image choice is forced by better-sqlite3: it publishes glibc prebuilds
# only, no musl. On Alpine every build would drag in python3 + build-essential
# and compile SQLite from source. Debian slim pulls a prebuilt binary instead —
# smaller in practice and far faster to build.
FROM node:22-bookworm-slim

# ffmpeg/ffprobe are real dependencies, not extras: ffprobe reads durations when
# scanning local folders and ad assets, and ffmpeg measures loudness for the
# commercial leveling. Jellyfin-only users technically never touch them, but an
# image that silently can't scan local media is a half-product.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so edits to src/ don't re-run npm install on every build.
# --chown on COPY, not a later `chown -R`: a recursive chown rewrites every
# file into a fresh layer, which cost 60 MB of pure duplication.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node packs/index.json ./packs/index.json
# Plain COPY (not --chmod, which requires BuildKit): the executable bit is
# tracked in git, so this builds on the classic builder too.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Create the data dirs owned by `node` BEFORE declaring the volume. Order is
# load-bearing: Docker seeds a new named volume from the image's content and
# ownership at the mount point, and any layer that touches that path AFTER a
# VOLUME instruction is discarded. Chowning afterwards silently did nothing, the
# volume came up root-owned, and the app couldn't write its database.
RUN install -d -o node -g node /data /media

# Everything that must survive `docker compose down` lives here: the SQLite
# database and any content packs downloaded through the picker. config.js puts
# downloaded packs beside the DB, so one volume covers both.
ENV DUMBTV_DB=/data/dumbtv.db \
    DUMBTV_MEDIA=/media \
    DUMBTV_PLAYER=none \
    DUMBTV_HOST=0.0.0.0 \
    DUMBTV_PORT=8080 \
    NODE_ENV=production
VOLUME ["/data"]

EXPOSE 8080

# Running as root in a media container that writes a mounted volume is needless
# risk. The node user ships with the base image.
USER node

# tini so Ctrl-C and `docker stop` actually reach Node as SIGINT/SIGTERM —
# dumbTV traps both to shut the player and server down cleanly.
ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "src/index.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DUMBTV_PORT||8080)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
