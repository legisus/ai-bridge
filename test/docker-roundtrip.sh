#!/usr/bin/env bash
# Round trip on the authoring machine: the real Chrome extension talks to the
# relay running inside the container (docs/DOCKER.md). Everything slow happens
# while the host relay still runs (build, volumes, token copy); then the exact
# process listening on 8765 is stopped, the container is published on
# 127.0.0.1:8765 at once, the extension reconnects by itself, the access
# handshake is read from both sides, and the host relay is restored (the native
# host restarts it when the extension cannot connect; otherwise it is started
# the way the native host does) and verified before the result is reported.
# Needs Docker; not part of `npm test`. Prints ROUNDTRIP OK and exits 0 only
# when the round trip AND the restoration succeeded.
set -uo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME="ai-bridge-roundtrip-$$"
export BRIDGE_PUBLISH_PORT=8765
export BRIDGE_WORK_DIR="$(mktemp -d "$PWD/deploy/docker/work-roundtrip.XXXXXX")"
COMPOSE=(docker compose -f deploy/docker/compose.yml)
HOST_HOME="${AI_BRIDGE_HOME:-$HOME/.ai-browser-bridge}"
failures=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; failures=$((failures+1)); }
listener_pid() { lsof -nP -iTCP:8765 -sTCP:LISTEN -t 2>/dev/null | head -1; }
listener_is_host_relay() { local pid="$1"; [ -n "$pid" ] && ps -o command= -p "$pid" 2>/dev/null | grep -q 'server/server\.js'; }
relay_answers() { node server/cli.js ping --timeout 4000 2>/dev/null | grep -q '"pong":true'; }

# ---- 0) preflight: token, image, volumes — all while the host relay keeps running ----
[ -s "$HOST_HOME/token" ] || { fail "no host token at $HOST_HOME/token"; exit 1; }
HOST_PID="$(listener_pid)"
if listener_is_host_relay "$HOST_PID"; then pass "host relay is the 8765 listener (pid $HOST_PID)"; else fail "the 8765 listener is not the host relay (pid ${HOST_PID:-none}); refusing to stop it"; exit 1; fi
"${COMPOSE[@]}" build > "${BRIDGE_WORK_DIR}/build.log" 2>&1 && pass "image builds" || { fail "image builds (see ${BRIDGE_WORK_DIR}/build.log)"; exit 1; }
"${COMPOSE[@]}" create bridge > /dev/null 2>&1 && pass "volumes and container created" || { fail "compose create"; exit 1; }
docker run --rm -v "${COMPOSE_PROJECT_NAME}_data:/data" -v "$HOST_HOME/token:/src/token:ro" --user 1000:1000 ai-bridge:local \
  sh -c 'cp /src/token /data/token && chmod 600 /data/token' > /dev/null 2>&1 && pass "host token copied into /data (the extension keeps its token)" || { fail "token copy"; exit 1; }

# ---- restoration: runs on every exit path; its result is part of the exit status ----
RESTORED=0
restore() {
  "${COMPOSE[@]}" down -v --remove-orphans > /dev/null 2>&1 || true
  docker volume ls -q --filter "name=${COMPOSE_PROJECT_NAME}_" | xargs -r docker volume rm > /dev/null 2>&1 || true
  rm -rf "$BRIDGE_WORK_DIR"
  # The native host restarts the relay when the extension's connect fails; give it a
  # moment, then start the relay the same way the host does if nothing listens.
  for i in $(seq 1 20); do listener_is_host_relay "$(listener_pid)" && break; sleep 1; done
  if ! listener_is_host_relay "$(listener_pid)"; then
    (nohup node server/server.js >> "$HOST_HOME/server.out" 2>&1 &)
    sleep 2
  fi
  for i in $(seq 1 60); do relay_answers && { RESTORED=1; break; }; sleep 1; done
  [ "$RESTORED" = 1 ] && pass "host relay restored and the extension is back on it (pid $(listener_pid))" || fail "host relay not answering after restoration; start it with: node server/server.js"
}
cleanup_on_abort() { if [ "$RESTORED" = 0 ]; then restore; fi; }
trap cleanup_on_abort EXIT

# ---- 1) handoff: stop the exact listener, publish the container immediately ----
kill "$HOST_PID" && sleep 0.5 && pass "host relay stopped (pid $HOST_PID)" || { fail "could not stop pid $HOST_PID"; exit 1; }
"${COMPOSE[@]}" up -d bridge > "${BRIDGE_WORK_DIR}/up.log" 2>&1 || { fail "compose up (a host relay may have reclaimed 8765 first: $(tail -1 "${BRIDGE_WORK_DIR}/up.log"))"; exit 1; }
for i in $(seq 1 30); do "${COMPOSE[@]}" logs bridge 2>/dev/null | grep -q 'listening on ws://0.0.0.0:8765' && break; sleep 1; done
CID="$("${COMPOSE[@]}" ps -q bridge)"
if docker port "$CID" 8765 2>/dev/null | grep -q '127.0.0.1:8765'; then pass "container published on 127.0.0.1:8765"; else fail "container not published on 8765 (a host relay reclaimed the port?)"; exit 1; fi

# ---- 2) the extension reconnects on its own (quick retry 1 s, alarm ≤ 24 s) ----
CONNECTED=0
for i in $(seq 1 60); do "${COMPOSE[@]}" logs bridge 2>/dev/null | grep -q 'extension connected' && { CONNECTED=1; break; }; sleep 1; done
[ "$CONNECTED" = 1 ] && pass "the real Chrome extension connected to the containerised relay" || fail "extension did not connect within 60 s (reload it at chrome://extensions and rerun)"
LOGS="$("${COMPOSE[@]}" logs bridge 2>/dev/null)"
ACC_LINE="$(grep -o 'access \(granted\|revoked\).*' <<< "$LOGS" | tail -1)"
[ -n "$ACC_LINE" ] && pass "access handshake logged by the relay: $ACC_LINE" || fail "no access message from the extension"

# ---- 3) ping from inside and from the host; fail-closed inside the container ----
IN="$("${COMPOSE[@]}" exec -T bridge node /app/server/cli.js ping --timeout 5000 2>&1)"
grep -q '"pong":true' <<< "$IN" && grep -q '"access":"' <<< "$IN" && pass "cli ping inside the container: $IN" || fail "ping inside ($IN)"
OUTH="$(node server/cli.js ping --timeout 5000 2>&1)"
grep -q '"pong":true' <<< "$OUTH" && pass "host cli ping through the published port: $OUTH" || fail "host ping ($OUTH)"
ACCESS="$(sed -n 's/.*"access":"\([a-z_]*\)".*/\1/p' <<< "$IN")"
if [ "$ACCESS" = "granted" ]; then
  T="$("${COMPOSE[@]}" exec -T bridge node /app/server/cli.js listTabs --timeout 5000 2>&1)"
  grep -q '"id":' <<< "$T" && pass "granted: listTabs from inside the container works" || fail "listTabs inside ($T)"
else
  R="$("${COMPOSE[@]}" exec -T bridge node /app/server/cli.js listTabs --timeout 5000 2>&1 || true)"
  grep -q 'access_\(revoked\|not_granted\)' <<< "$R" && pass "not granted ($ACCESS): listTabs from inside is refused — fail closed holds in the container" || fail "listTabs refusal ($R)"
fi
echo "--- relay log (container) ---"; "${COMPOSE[@]}" logs bridge 2>/dev/null | tail -8

# ---- 4) restore first, then report ----
trap - EXIT
restore
if [ $failures -eq 0 ]; then echo "ROUNDTRIP OK (extension access: ${ACCESS:-?})"; else echo "ROUNDTRIP FAILED: $failures check(s)"; fi
exit $failures
