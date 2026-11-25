#!/usr/bin/env bash
# Docker smoke job (docs/DOCKER.md "Tests"): builds the image, starts the relay in
# a throwaway compose project on a free loopback port, and asserts the guide's
# list. Needs Docker; not part of `npm test`. Prints SMOKE OK and the pinned CLI
# versions on success. Never touches ~/.ai-browser-bridge.
#
#   bash test/docker-smoke.sh            # full run
#   KEEP=1 bash test/docker-smoke.sh     # leave the project running for a look
set -uo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME=ai-bridge-smoke
# The work dir is a bind mount: it must live under a path the Docker VM shares
# with the host (Colima/Docker Desktop share $HOME; macOS's /var/folders is not
# shared), so it goes under the repo, where deploy/docker/work*/ is git-ignored.
export BRIDGE_WORK_DIR="$(mktemp -d "$PWD/deploy/docker/work-smoke.XXXXXX")"
export BRIDGE_PUBLISH_PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
COMPOSE=(docker compose -f deploy/docker/compose.yml)
failures=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; failures=$((failures+1)); }
check() { if eval "$2" > /dev/null 2>&1; then pass "$1"; else fail "$1"; fi; }
cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then echo "KEEP=1: project ai-bridge-smoke left running on 127.0.0.1:${BRIDGE_PUBLISH_PORT}"; return; fi
  "${COMPOSE[@]}" down -v --remove-orphans > /dev/null 2>&1 || true
  docker volume ls -q --filter name=ai-bridge-smoke_ | xargs -r docker volume rm > /dev/null 2>&1 || true # anything a manual `docker run -v` left
  rm -rf "$BRIDGE_WORK_DIR"
}
trap cleanup EXIT

echo "smoke: port ${BRIDGE_PUBLISH_PORT}, work dir ${BRIDGE_WORK_DIR}"
# 1) build
if "${COMPOSE[@]}" build > "${BRIDGE_WORK_DIR}/build.log" 2>&1; then pass "image builds"; else fail "image builds (see ${BRIDGE_WORK_DIR}/build.log)"; tail -20 "${BRIDGE_WORK_DIR}/build.log"; exit 1; fi

# 3) up + listening line
"${COMPOSE[@]}" up -d bridge > "${BRIDGE_WORK_DIR}/up.log" 2>&1 || { fail "compose up"; tail -5 "${BRIDGE_WORK_DIR}/up.log"; exit 1; }
for i in $(seq 1 30); do
  if "${COMPOSE[@]}" logs bridge 2>/dev/null | grep -q 'listening on ws://0.0.0.0:8765'; then break; fi; sleep 1
done
LOGS="$("${COMPOSE[@]}" logs bridge 2>/dev/null)"
check "relay logs the listening line with the loopback warning" "grep -q 'listening on ws://0.0.0.0:8765 — make sure only the host.s loopback can reach this port' <<< \"\$LOGS\""

# 4) healthcheck
HEALTHY=0
for i in $(seq 1 60); do
  st="$(docker inspect --format '{{.State.Health.Status}}' "$("${COMPOSE[@]}" ps -q bridge)" 2>/dev/null || true)"
  if [ "$st" = "healthy" ]; then HEALTHY=1; break; fi; sleep 1
done
[ "$HEALTHY" = 1 ] && pass "healthcheck turns healthy with no extension and no token pasted" || fail "healthcheck healthy (last status: ${st:-unknown})"

# 5) token mode and owner
check "/data/token is mode 600 owned by uid 1000" "[ \"\$(\"\${COMPOSE[@]}\" exec -T bridge stat -c '%a %u' /data/token)\" = '600 1000' ]"
check "/data is mode 700 owned by uid 1000" "[ \"\$(\"\${COMPOSE[@]}\" exec -T bridge stat -c '%a %u' /data)\" = '700 1000' ]"
check "the relay runs as uid 1000 (node)" "[ \"\$(\"\${COMPOSE[@]}\" exec -T bridge id -u)\" = 1000 ]"

# 6) CLI inside the container
OUT="$("${COMPOSE[@]}" exec -T bridge node /app/server/cli.js ping --timeout 3000 2>&1)"; code=$?
[ $code -eq 1 ] && grep -q 'extension not connected' <<< "$OUT" && pass "cli ping inside: relay up, no extension (exit 1)" || fail "cli ping inside (exit $code: $OUT)"
OUT="$("${COMPOSE[@]}" exec -T bridge node /app/server/cli.js tabs 2>&1)"
grep -q 'no bridge-opened tabs recorded' <<< "$OUT" && pass "cli tabs inside reads the empty registry" || fail "cli tabs inside ($OUT)"
check "the published port answers on the host loopback" "node -e 'const s=require(\"net\").connect(${BRIDGE_PUBLISH_PORT},\"127.0.0.1\");s.once(\"connect\",()=>{s.end();process.exit(0)});s.once(\"error\",()=>process.exit(1))'"
HOSTOUT="$(BRIDGE_PORT=${BRIDGE_PUBLISH_PORT} AI_BRIDGE_HOME="${BRIDGE_WORK_DIR}/fakehome" node server/cli.js ping --timeout 3000 2>&1 || true)"
grep -q 'no token at' <<< "$HOSTOUT" && pass "host CLI without the container's token is refused cleanly (exit 6)" || fail "host CLI without token ($HOSTOUT)"

# 7) /work is writable and visible on the host
"${COMPOSE[@]}" exec -T bridge sh -c 'echo smoke > /work/smoke.txt' > /dev/null 2>&1
[ "$(cat "${BRIDGE_WORK_DIR}/smoke.txt" 2>/dev/null)" = "smoke" ] && pass "/work write from inside is visible on the host" || fail "/work write"
check "read-only root fs refuses a write outside /data,/work,/tmp" "! \"\${COMPOSE[@]}\" exec -T bridge sh -c 'echo x > /app/x'"

# 8) pinned CLIs
CV="$("${COMPOSE[@]}" exec -T bridge claude --version 2>&1 | head -1)"
XV="$("${COMPOSE[@]}" exec -T bridge codex --version 2>&1 | head -1)"
grep -q '2\.1\.317' <<< "$CV" && pass "claude pinned: $CV" || fail "claude version ($CV)"
grep -q '0\.171\.0' <<< "$XV" && pass "codex pinned: $XV" || fail "codex version ($XV)"

# 9) codex one-shot under the compose restrictions (needs a login). The login
#    is copied into the `home` volume AFTER compose created it (compose refuses
#    a volume it did not create); never logged, never committed.
if [ -f "$HOME/.codex/auth.json" ]; then
  docker run --rm -v ai-bridge-smoke_home:/home/node -v "$HOME/.codex:/src:ro" --user 1000:1000 ai-bridge:local \
    sh -c 'mkdir -p /home/node/.codex && cp /src/auth.json /home/node/.codex/auth.json && chmod 600 /home/node/.codex/auth.json' > /dev/null 2>&1 \
    && CODEX_AUTH=1 || CODEX_AUTH=0
else CODEX_AUTH=0; fi
if [ "$CODEX_AUTH" = 1 ]; then
  OUT="$("${COMPOSE[@]}" exec -T -e AI_BRIDGE_CODEX_SANDBOX=container bridge sh -c 'cd /work && timeout 180 codex exec --skip-git-repo-check --ephemeral --sandbox danger-full-access -m gpt-6-astra -o /tmp/codex-out.txt "Run the shell command: echo smoke-ok. Reply with only its output." < /dev/null > /tmp/codex.log 2>&1; cat /tmp/codex-out.txt' 2>&1)"
  if grep -q 'smoke-ok' <<< "$OUT"; then pass "codex exec runs a shell command inside the hardened container"
  else fail "codex exec inside"; "${COMPOSE[@]}" exec -T bridge sh -c 'tail -15 /tmp/codex.log' 2>&1 | sed 's/^/      /'; fi
else
  echo "SKIP  codex exec inside (no ~/.codex/auth.json on this machine)"
fi

# 10) down -v leaves nothing behind (done by cleanup); report
if [ $failures -eq 0 ]; then echo "SMOKE OK (claude ${CV}, codex ${XV}, $(docker version --format '{{.Server.Os}}/{{.Server.Arch}}'))"; else echo "SMOKE FAILED: $failures check(s)"; fi
exit $failures
