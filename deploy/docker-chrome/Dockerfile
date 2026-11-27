# Google Chrome + the AI Browser Bridge extension + the relay, on a web screen.
# docs/DOCKER-CHROME.md is the guide. Build context = the repository root:
#   docker build -f deploy/docker-chrome/Dockerfile -t ai-bridge-chrome:local .
#
# The base is the Selkies base image (web screen on :3000, labwc/Wayland, s6, the
# /config layout), which ships NO browser. It is the parent of
# lscr.io/linuxserver/chromium; using the parent is how this image stays free of
# Chromium. Pinned by digest (arm64 manifest list entry, tag debiantrixie, 2026-11).
ARG BASE_IMAGE=ghcr.io/linuxserver/baseimage-selkies@sha256:793fc3628ad6e089aecfd9f862de3ad5d9df05f1db783363c812f77d6541ccc3
FROM ${BASE_IMAGE}

# Chrome is whatever "stable" is at build time unless a pinned .deb URL is given.
# Google publishes Linux Chrome for arm64 and amd64; the default follows the
# build platform.
# CHROME_DEB_SHA256, when given, must match the downloaded package. The version
# and checksum of what was actually installed are recorded in the image
# (/opt/ai-bridge/CHROME_VERSION, CHROME_DEB_SHA256) and printed by the build.
ARG CHROME_DEB_URL=""
ARG CHROME_DEB_SHA256=""
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    url="${CHROME_DEB_URL:-https://dl.google.com/linux/direct/google-chrome-stable_current_${arch}.deb}"; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl procps; \
    curl -fsSL -o /tmp/chrome.deb "$url"; \
    sum="$(sha256sum /tmp/chrome.deb | cut -d' ' -f1)"; \
    if [ -n "${CHROME_DEB_SHA256}" ] && [ "$sum" != "${CHROME_DEB_SHA256}" ]; then echo "Chrome .deb checksum mismatch: $sum" >&2; exit 1; fi; \
    test "$(dpkg-deb -f /tmp/chrome.deb Package)" = google-chrome-stable; \
    apt-get install -y --no-install-recommends /tmp/chrome.deb; \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; \
    apt-get install -y --no-install-recommends nodejs; \
    /lsiopy/bin/pip install --no-cache-dir websocket-client; \
    rm -f /tmp/chrome.deb /etc/cron.daily/google-chrome; \
    apt-get autoclean; rm -rf /var/lib/apt/lists/* /var/tmp/* /tmp/* /config/.cache; \
    mkdir -p /opt/ai-bridge /data; \
    echo "$sum" > /opt/ai-bridge/CHROME_DEB_SHA256; \
    dpkg-query -W -f='Google Chrome ${Version}\n' google-chrome-stable | tee /opt/ai-bridge/CHROME_VERSION

WORKDIR /opt/ai-bridge
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY extension ./extension
COPY deploy/docker-chrome/chrome-start.sh deploy/docker-chrome/provision.py /usr/local/bin/
COPY deploy/docker-chrome/root/ /

# The Wayland session's autostart is the Chrome loop. (The base copies this file
# into /config/.config/labwc/autostart on first start.)
RUN set -eux; \
    chmod 755 /usr/local/bin/chrome-start.sh /usr/local/bin/provision.py /etc/s6-overlay/s6-rc.d/svc-relay/run; \
    printf '#!/bin/bash\nexec /usr/local/bin/chrome-start.sh\n' > /defaults/autostart_wayland; \
    cp /defaults/autostart_wayland /defaults/autostart; \
    chmod -R a+rX /opt/ai-bridge

# No Chromium, anywhere: fail the build if a package, a binary or a library
# directory of it is present. (The smoke job repeats this against the image.)
RUN set -eu; \
    if dpkg-query -W -f='${Package}\n' | grep -i chromium; then echo "chromium package present" >&2; exit 1; fi; \
    for b in chromium chromium-browser chromium-shell chromedriver wrapped-chromium; do \
      if command -v "$b"; then echo "chromium binary present: $b" >&2; exit 1; fi; \
    done; \
    if ls -d /usr/lib/chromium* /usr/lib/*/chromium* /usr/share/chromium* /etc/chromium* /snap/chromium* 2>/dev/null | grep .; then echo "chromium files present" >&2; exit 1; fi; \
    if find / -xdev \( -path /proc -o -path /sys -o -path /opt/google \) -prune -o -type f -perm /111 ! -name chrome-start.sh \( -iname 'chromium*' -o -iname 'chrome' -o -iname 'chrome-*' -o -iname 'headless_shell' \) -print | grep .; then echo "another browser executable present" >&2; exit 1; fi; \
    test -x /opt/google/chrome/chrome

ARG GIT_COMMIT=unknown
LABEL org.opencontainers.image.title="ai-bridge-chrome" \
      org.opencontainers.image.revision="${GIT_COMMIT}"
ENV TITLE="AI Bridge Chrome" \
    PIXELFLUX_WAYLAND=true \
    AI_BRIDGE_COMMIT="${GIT_COMMIT}"
WORKDIR /config
EXPOSE 3000 8765
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s \
  CMD node -e "require('net').connect(8765,'127.0.0.1').once('connect',()=>process.exit(0)).once('error',()=>process.exit(1))"
