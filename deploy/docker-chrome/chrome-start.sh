#!/bin/bash
# The Wayland session's autostart (labwc runs it as the image user): keep one
# Google Chrome running on the profile volume, and provision the AI Browser
# Bridge extension after EVERY Chrome start. An extension loaded over the
# DevTools protocol is not recorded in the profile, so it is gone when Chrome
# restarts; its id and chrome.storage survive, its toggles do not.
#
# Flags (docs/DOCKER-CHROME.md "Chrome flags"): no --no-sandbox, no --test-type,
# no fake-update flag; Chrome's own sandbox runs (the container has
# seccomp=unconfined for the user namespaces it needs). The debug port listens on
# the container's loopback only and is never published.
set -u
PROFILE="${CHROME_PROFILE_DIR:-/config/profile}"
START_URL="${CHROME_START_URL:-https://turo.com/us/en/inbox/messages}"
DEBUG_PORT=9222
LOG=/config/chrome-start.log
export HOME=/config
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/config/.XDG}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"

log() {
  # size cap: keep the last ~200 lines once the file passes 256 KB
  if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 262144 ]; then
    tail -n 200 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
  fi
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"
}

# One Chrome per PROFILE, not just per container. The lock file lives on the
# profile volume itself, so it is shared by every container that mounts the
# volume: a second container (or a second autostart run in this one) does not
# get it, never removes the first one's Singleton links and never starts a
# second Chrome on the same profile.
mkdir -p "$PROFILE"
exec 9> "$(dirname "$PROFILE")/.chrome-profile.lock"
if ! flock -n 9; then
  log "$(hostname): the Chrome profile $PROFILE is in use by another chrome-start loop (another container?) — not starting Chrome here"
  exit 0
fi

provision_until_ok() { # $1 = Chrome pid; retried while this Chrome lives
  local pid="$1" n=0
  while kill -0 "$pid" 2>/dev/null; do
    n=$((n+1))
    if timeout -k 5 180 /lsiopy/bin/python3 -I /usr/local/bin/provision.py >> "$LOG" 2>&1; then
      log "provisioned (attempt $n)"; return 0
    fi
    log "provision attempt $n failed; retrying in 15 s"
    sleep 15
  done
}

# Stop requested (`bridge-docker down`, session end): close Chrome the clean way
# and leave; do not start another one. "Clean" is a DevTools Browser.close —
# the only stop after which the cookie store is written out (a SIGTERM exits
# without the final commit and loses up to ~30 s of cookie changes).
CHROME_PID=""; PROV_PID=""
gone() { ! kill -0 "$1" 2>/dev/null; }
wait_gone() { # $1 pid, $2 quarter-seconds
  for _ in $(seq 1 "$2"); do gone "$1" && return 0; sleep 0.25; done; return 1
}
quit_chrome() { # ask (10 s), then TERM (5 s), then KILL: every step is bounded
  timeout -k 2 10 /lsiopy/bin/python3 -I /usr/local/bin/provision.py --quit >> "$LOG" 2>&1 || kill -TERM "$CHROME_PID" 2>/dev/null
  wait_gone "$CHROME_PID" 40 && return 0
  kill -TERM "$CHROME_PID" 2>/dev/null; wait_gone "$CHROME_PID" 20 && return 0
  log "Chrome ignored the stop; killing it"
  kill -KILL "$CHROME_PID" 2>/dev/null; wait_gone "$CHROME_PID" 8
}
stop_provisioning() { # the retry subshell AND the python it is running
  [ -n "$PROV_PID" ] || return 0
  pkill -TERM -P "$PROV_PID" 2>/dev/null
  kill "$PROV_PID" 2>/dev/null; wait "$PROV_PID" 2>/dev/null
  PROV_PID=""
}
stop() {
  log "stop requested; closing Chrome"
  stop_provisioning
  if [ -n "$CHROME_PID" ] && ! gone "$CHROME_PID"; then quit_chrome; fi
  exit 0
}
trap stop TERM INT HUP
echo $$ > /tmp/chrome-start.pid        # `bridge-docker down` signals this loop

CHROME_BIN="${CHROME_BIN:-/usr/bin/google-chrome-stable}"   # the tests swap in a stand-in that never opens the debug port
CDP_WAIT="${CHROME_CDP_WAIT:-60}"
while true; do
  # The compositor must be there, or Chrome exits at once and the loop spins.
  for _ in $(seq 1 60); do [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && break; sleep 1; done
  [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] || { log "no Wayland socket at $XDG_RUNTIME_DIR/$WAYLAND_DISPLAY after 60 s; retrying"; continue; }
  if pgrep -x chrome > /dev/null; then
    log "a Chrome is already running; waiting for it to exit"
    while pgrep -x chrome > /dev/null; do sleep 2; done
  fi
  rm -f "$PROFILE"/Singleton*            # stale lock after an unclean stop
  log "starting $(cat /opt/ai-bridge/CHROME_VERSION 2>/dev/null || echo 'Google Chrome')"
  "$CHROME_BIN" \
    --user-data-dir="$PROFILE" \
    --remote-debugging-port="$DEBUG_PORT" \
    --enable-unsafe-extension-debugging \
    --ozone-platform=wayland --password-store=basic --no-first-run --start-maximized \
    --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
    --disable-background-timer-throttling \
    "$START_URL" > /config/chrome.log 2>&1 9>&- &
  CHROME_PID=$!
  # The browser process (google-chrome-stable execs it): what the helper
  # waits on after it has asked Chrome to quit.
  echo "$CHROME_PID" > /tmp/chrome.pid
  # Wait for the debug port, bounded by a deadline AND by the life of the
  # Chrome just started (it may die before it ever listens).
  cdp=no
  for _ in $(seq 1 "$CDP_WAIT"); do
    if curl -fsS -m 2 -o /dev/null "http://127.0.0.1:${DEBUG_PORT}/json/version" 2>/dev/null; then cdp=yes; break; fi
    gone "$CHROME_PID" && break
    sleep 1
  done
  PROV_PID=""
  if [ "$cdp" = yes ]; then
    provision_until_ok "$CHROME_PID" 9>&- &
    PROV_PID=$!
    wait "$CHROME_PID"; code=$?
    stop_provisioning
    log "Chrome exited (status $code); restarting in 3 s"
  else
    if ! gone "$CHROME_PID"; then
      # Running but no debug port after the deadline: this Chrome can never be
      # provisioned. Stop it (TERM, then KILL); the loop starts a fresh one.
      log "Chrome is up but the debug port never opened within ${CDP_WAIT} s; stopping it (see /config/chrome.log)"
      kill -TERM "$CHROME_PID" 2>/dev/null
      wait_gone "$CHROME_PID" 20 || { kill -KILL "$CHROME_PID" 2>/dev/null; wait_gone "$CHROME_PID" 8; }
    fi
    wait "$CHROME_PID" 2>/dev/null; code=$?
    log "Chrome exited (status $code) before its debug port opened; last lines of /config/chrome.log: $(tail -n 3 /config/chrome.log 2>/dev/null | tr '\n' ' ' | cut -c1-400); restarting in 3 s"
  fi
  CHROME_PID=""
  sleep 3
done
