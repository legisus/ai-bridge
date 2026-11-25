#!/usr/bin/env bash
# Round trip on the authoring machine: the real Chrome extension talks to the
# relay running inside the container (docs/DOCKER.md). Stops the host relay,
# publishes the container on 127.0.0.1:8765 with the host's existing token
# (so the extension reconnects on its own), waits for the extension, reads the
# access handshake from both sides, then stops the container and restores the
# host relay. Needs Docker; not part of `npm test`. Prints ROUNDTRIP OK.
set -uo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME=ai-bridge-roundtrip
export BRIDGE_PUBLISH_PORT=8765
export BRIDGE_WORK_DIR="$(mktemp -d "$PWD/deploy/docker/work-roundtrip.XXXXXX")"
COMPOSE=(docker compose -f deploy/docker/compose.yml)
HOST_HOME="${AI_BRIDGE_HOME:-$HOME/.ai-browser-bridge}"
failures=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; failures=$((failures+1)); }

# 1) stop the host relay (the native host restarts it once the port is free again)
HOST_PID="$(pgrep -f 'server/server.js' | head -1 || true)"
if [ -n "$HOST_PID" ]; then kill "$HOST_PID" && sleep 1 && pass "host relay stopped (pid $HOST_PID)"; else echo "SKIP  no host relay running"; fi

restore() {
  "${COMPOSE[@]}" down -v --remove-orphans > /dev/null 2>&1 || true
  rm -rf "$BRIDGE_WORK_DIR"
  if ! pgrep -f 'server/server.js' > /dev/null; then
    (cd "$PWD" && nohup node server/server.js >> "$HOST_HOME/server.out" 2>&1 &)
    sleep 2
  fi
  OUT="$(node server/cli.js ping --timeout 5000 2>&1 || true)"
  grep -q '"pong":true' <<< "$OUT" && pass "host relay restored and the extension is back on it" || fail "host relay restore ($OUT)"
}
trap restore EXIT

# 2) build, create the volumes, copy the host token in, start
"${COMPOSE[@]}" build > "${BRIDGE_WORK_DIR}/build.log" 2>&1 || { fail "image builds"; exit 1; }
"${COMPOSE[@]}" create bridge > /dev/null 2>&1 || { fail "compose create"; exit 1; }
docker run --rm -v ai-bridge-roundtrip_data:/data -v "$HOST_HOME/token:/src/token:ro" --user 1000:1000 ai-bridge:local \
  sh -c 'cp /src/token /data/token && chmod 600 /data/token' > /dev/null 2>&1 && pass "host token copied into /data" || { fail "token copy"; exit 1; }
"${COMPOSE[@]}" up -d bridge > /dev/null 2>&1 || { fail "compose up"; exit 1; }
for i in $(seq 1 30); do "${COMPOSE[@]}" logs bridge 2>/dev/null | grep -q 'listening on ws://0.0.0.0:8765' && break; sleep 1; done

# 3) the extension reconnects on its own (reconnect alarm ≤ 24 s, quick retry 1 s)
CONNECTED=0
for i in $(seq 1 45); do "${COMPOSE[@]}" logs bridge 2>/dev/null | grep -q 'extension connected' && { CONNECTED=1; break; }; sleep 1; done
[ "$CONNECTED" = 1 ] && pass "the real Chrome extension connected to the containerised relay" || fail "extension did not connect within 45 s"
LOGS="$("${COMPOSE[@]}" logs bridge 2>/dev/null)"
grep -q 'access granted\|access revoked' <<< "$LOGS" && pass "access handshake logged by the relay: $(grep -o 'access \(granted\|revoked\)[^\n]*' <<< "$LOGS" | tail -1)" || fail "no access message from the extension"

# 4) ping from inside and from the host
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
  grep -q 'access_\(revoked\|not_granted\)' <<< "$R" && pass "not granted: listTabs from inside is refused ($ACCESS) — fail closed holds in the container" || fail "listTabs refusal ($R)"
fi
echo "--- relay log (container) ---"; "${COMPOSE[@]}" logs bridge 2>/dev/null | tail -8

[ $failures -eq 0 ] && echo "ROUNDTRIP OK (extension access: ${ACCESS:-?})" || echo "ROUNDTRIP FAILED: $failures"
exit $failures
