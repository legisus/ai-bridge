#!/usr/bin/env bash
# bin/bridge-docker and the smoke job's teardown against a stand-in `docker`
# (test/helpers/fake-docker): the helper's decisions — what it refuses, what it
# stops before it replaces, what it reports — without Docker. Part of
# `npm run test:docker-chrome`. Everything lives in a scratch directory that is
# also the helper's $HOME; no real container, port 8765 or state directory is
# touched. (What Chrome and the container really do: test/docker-chrome-smoke.sh.)
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
HELPER="${BRIDGE_DOCKER_UNDER_TEST:-$REPO/bin/bridge-docker}"
NODE="$(command -v node)"
SCR="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/bridge-docker-test.XXXXXX")" && pwd -P)"
H="$SCR/home"; mkdir -p "$H" "$SCR/bin"
ln -s "$REPO/test/helpers/fake-docker" "$SCR/bin/docker"
# `node …/cli.js ping` answers as a ready relay would; any other node call is the real one
printf '#!/bin/sh\ncase "$*" in *cli.js*ping*) echo %s;; *) exec "%s" "$@";; esac\n' \
  "'{\"pong\":true,\"session\":\"docker-chrome\",\"access\":\"granted\"}'" "$NODE" > "$SCR/bin/node"
chmod +x "$SCR/bin/node"
PIDS=""; RACERS=""
cleanup() { for p in $PIDS; do kill -KILL "$p" 2> /dev/null; done; rm -rf "$SCR"; }
trap cleanup EXIT

failures=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; failures=$((failures+1)); }
ok() { if eval "$2"; then pass "$1"; else fail "$1"; [ -z "${OUT:-}" ] || echo "      output: $(tail -n 3 <<< "$OUT" | tr '\n' '|')"; fi; }
free_port() { "$NODE" -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
P1="$(free_port)"; P2="$(free_port)"
N=0
fresh() { N=$((N+1)); export FAKE_DOCKER="$SCR/docker-$N"; mkdir -p "$FAKE_DOCKER/containers"; : > "$FAKE_DOCKER/log"; }
# the helper, with the stand-ins first on PATH and the scratch directory as home
bd() { env HOME="$H" PATH="$SCR/bin:$PATH" BRIDGE_DOCKER_UP_LOCK="$SCR/up.lock" BRIDGE_UP_LOCK_WAIT=60 BRIDGE_PUBLISH_PORT="${PORT:-$P1}" SCREEN_PUBLISH_PORT="${SPORT:-$P2}" "$HELPER" "$@"; }
log_has() { grep -q -- "$1" "$FAKE_DOCKER/log"; }
PROFILE="$H/docker/ai-bridge-chrome/config"; STATE="$H/.ai-browser-bridge"; DL="$H/Downloads"
container() { # $1 id, $2 project, $3 state, [$4 image], [$5 published relay port]
  local d="$FAKE_DOCKER/containers/$1"; mkdir -p "$d" "$PROFILE" "$DL"; [ -d "$STATE" ] || mkdir -m 700 "$STATE"
  echo "$2-chrome-1" > "$d/name"; echo "$2" > "$d/project"; echo "$3" > "$d/state"; echo "${4:-sha256:image-one}" > "$d/image"; echo hash-one > "$d/hash"
  printf '%s\n%s\n%s\n' "$PROFILE" "$DL" "$STATE" > "$d/mounts"
  printf '8765/tcp -> 127.0.0.1:%s\n3000/tcp -> 127.0.0.1:%s\n' "${5:-$P1}" "$P2" > "$d/ports"
}
OWN="aaaaaaaaaaaa1111111111111111111111111111111111111111111111111111"
relay() { # a stand-in host relay: a node process on …/server/server.js with the given environment. $1 = name, rest = VAR=value…
  local name="$1"; shift
  mkdir -p "$SCR/$name/server"; echo 'setInterval(() => {}, 1000);' > "$SCR/$name/server/server.js"
  env -i PATH="$PATH" "$@" "$NODE" "$SCR/$name/server/server.js" > /dev/null 2>&1 &
  RELAY_PID=$!; PIDS="$PIDS $RELAY_PID"; sleep 0.5
}

# ---- finding 1: which state directory a host relay owns ------------------------
fresh
relay relay-default HOME="$H"                      # no AI_BRIDGE_HOME: its state is ~/.ai-browser-bridge
OUT="$(bd up 2>&1)"; RC=$?
ok "production up is refused while a host relay works in ~/.ai-browser-bridge" '[ "$RC" != 0 ] && grep -q "a host relay is running on $STATE (pid $RELAY_PID)" <<< "$OUT" && ! log_has "up -d"'
kill -KILL "$RELAY_PID"; wait "$RELAY_PID" 2> /dev/null
fresh
relay relay-second HOME="$H" AI_BRIDGE_HOME="$H/.ai-browser-bridge-mac" BRIDGE_PORT=8770   # the guide's variant B
OUT="$(bd up 2>&1)"; RC=$?
ok "production up is allowed next to a host relay that works in ANOTHER state directory (variant B)" '[ "$RC" = 0 ] && log_has "up -d"'
fresh
mkdir -p "$H/docker/other profile" "$H/docker/second state"; chmod 700 "$H/docker/second state"
OUT="$(BRIDGE_DATA_DIR="$H/.ai-browser-bridge-mac/" CHROME_CONFIG_DIR="$H/docker/other profile" bd --staging up 2>&1)"; RC=$?
ok "…but not on that relay's own directory (AI_BRIDGE_HOME from its environment, path alias)" '[ "$RC" != 0 ] && grep -q "a host relay is running on $H/.ai-browser-bridge-mac (pid $RELAY_PID)" <<< "$OUT" && ! log_has "up -d"'
kill -KILL "$RELAY_PID"; wait "$RELAY_PID" 2> /dev/null
fresh
relay relay-space HOME="$H" "AI_BRIDGE_HOME=$H/docker/second state" ZZ_LAST=1
OUT="$(BRIDGE_DATA_DIR="$H/docker/second state" CHROME_CONFIG_DIR="$H/docker/other profile" bd --staging up 2>&1)"; RC=$?
ok "a relay state directory with a space in its path is read whole" '[ "$RC" != 0 ] && grep -q "a host relay is running on $H/docker/second state (pid $RELAY_PID)" <<< "$OUT"'
kill -KILL "$RELAY_PID"; wait "$RELAY_PID" 2> /dev/null
fresh
env -i HOME="$H" /bin/bash -c 'sleep 300; :' "$SCR/notes/server/server.js" > /dev/null 2>&1 & NOT=$!; PIDS="$PIDS $NOT"; sleep 0.3
OUT="$(bd up 2>&1)"; RC=$?
ok "a process that only names a server/server.js path (not a node relay) does not block production up" '[ "$RC" = 0 ] && log_has "up -d"'
pkill -KILL -P "$NOT" 2> /dev/null; kill -KILL "$NOT" 2> /dev/null; wait "$NOT" 2> /dev/null

# ---- finding 2: the project's own stopped container ---------------------------
fresh; container "$OWN" ai-bridge-chrome exited
OUT="$(bd up 2>&1)"; RC=$?
ok "up recovers the project's own STOPPED container (it is not 'another container')" '[ "$RC" = 0 ] && log_has "up -d" && ! grep -q "belongs to another container" <<< "$OUT"'
ok "…and does not try to stop a Chrome in a container that is not running" '! log_has "^exec "'
fresh; container "$OWN" some-other-project exited
OUT="$(bd up 2>&1)"; RC=$?
ok "a stopped container of ANOTHER project on the same profile is still refused" '[ "$RC" != 0 ] && grep -q "belongs to another container.*(exited) mounts the Chrome profile directory" <<< "$OUT" && ! log_has "up -d"'
"$NODE" -e 'require("net").createServer().listen(Number(process.argv[1]), "127.0.0.1")' "$P1" > /dev/null 2>&1 & LISTENER=$!; PIDS="$PIDS $LISTENER"; sleep 0.5
fresh; container "$OWN" ai-bridge-chrome exited
OUT="$(bd up 2>&1)"; RC=$?
ok "own stopped container, but the port was taken meanwhile: refused (a stopped container holds no port)" '[ "$RC" != 0 ] && grep -q "port 127.0.0.1:$P1 is already held by" <<< "$OUT" && ! log_has "up -d"'
fresh; container "$OWN" ai-bridge-chrome running
OUT="$(bd up 2>&1)"; RC=$?
ok "own RUNNING container that publishes the port: the listener on it is its own, up goes ahead" '[ "$RC" = 0 ] && log_has "up -d"'
fresh; container "$OWN" ai-bridge-chrome running sha256:image-one 1
OUT="$(bd up 2>&1)"; RC=$?
ok "own running container that publishes ANOTHER port: the held port is not its own, refused" '[ "$RC" != 0 ] && grep -q "port 127.0.0.1:$P1 is already held by" <<< "$OUT" && ! log_has "up -d"'
kill -KILL "$LISTENER" 2> /dev/null; wait "$LISTENER" 2> /dev/null
fresh; echo 1 > "$FAKE_DOCKER/ps-rc"
OUT="$(bd up 2>&1)"; RC=$?
ok "containers cannot be listed: nothing is started" '[ "$RC" != 0 ] && grep -q "could not list the containers" <<< "$OUT" && ! log_has "up -d"'

# ---- finding 3: simultaneous starts with a stale lock already there ------------
fresh; echo 2 > "$FAKE_DOCKER/up-sleep"
# a holder that died with the lock: killed outright, lock file left behind (plus the old scheme's directory)
if command -v lockf > /dev/null 2>&1; then lockf -k "$SCR/up.lock" sleep 300 & else flock "$SCR/up.lock" sleep 300 & fi
HOLDER=$!; sleep 0.5; pkill -KILL -P "$HOLDER" 2> /dev/null; kill -KILL "$HOLDER" 2> /dev/null; wait "$HOLDER" 2> /dev/null
echo 999999 >> "$SCR/up.lock"; mkdir -p "$SCR/up.lock.d"; echo 999999 > "$SCR/up.lock.d/pid"
T0=$SECONDS
for i in 1 2 3 4; do
  ( BRIDGE_DOCKER_PROJECT="race-$i" BRIDGE_DATA_DIR="$H/docker/race-data-$i" CHROME_CONFIG_DIR="$H/docker/race-profile" PORT="$(free_port)" SPORT="$(free_port)" bd --staging up > "$SCR/race-$i.log" 2>&1; echo "rc=$?" >> "$SCR/race-$i.log" ) &
  RACERS="${RACERS:-} $!"
done
wait $RACERS
WON="$(grep -l '^rc=0' "$SCR"/race-[1-4].log | wc -l | tr -d ' ')"; LOST="$(grep -l 'belongs to another container' "$SCR"/race-[1-4].log | wc -l | tr -d ' ')"
OUT="$(tail -n 2 "$SCR"/race-[1-4].log)"
ok "four simultaneous starts on one profile, a dead holder's lock in place: exactly one creates a container, three are refused" '[ "$WON" = 1 ] && [ "$LOST" = 3 ] && [ "$(ls "$FAKE_DOCKER/containers" | wc -l | tr -d " ")" = 1 ] && [ "$(grep -c "up -d" "$FAKE_DOCKER/log")" = 1 ]'
ok "…and nobody waited for the dead holder (no timeout on a stale lock)" '[ $((SECONDS - T0)) -lt 40 ]'

# ---- finding 5: replacement and failed stops -----------------------------------
STOP_SCRIPT="$REPO/deploy/docker-chrome/chrome-stop.sh"
fresh; container "$OWN" ai-bridge-chrome running
OUT="$(bd up 2>&1)"; RC=$?
ok "up on an unchanged running container: Chrome is left alone, nothing is recreated" '[ "$RC" = 0 ] && ! log_has "^exec " && log_has "up -d$"'
fresh; container "$OWN" ai-bridge-chrome running sha256:the-old-image
OUT="$(bd up 2>&1)"; RC=$?
ok "up after a rebuild (the running container has another image): Chrome is closed FIRST, then the container is replaced" '[ "$RC" = 0 ] && [ "$(grep -n "^exec .* sh -s -- loop" "$FAKE_DOCKER/log" | cut -d: -f1)" -lt "$(grep -n "up -d --force-recreate" "$FAKE_DOCKER/log" | cut -d: -f1)" ] && cmp -s "$FAKE_DOCKER/last-exec-stdin" "$STOP_SCRIPT"'
fresh; container "$OWN" ai-bridge-chrome running; echo hash-two > "$FAKE_DOCKER/config-hash"
OUT="$(bd up 2>&1)"; RC=$?
ok "…the same when only the settings changed (compose's config hash)" '[ "$RC" = 0 ] && log_has "^exec .* sh -s -- loop" && log_has "up -d --force-recreate"'
fresh; container "$OWN" ai-bridge-chrome running sha256:the-old-image; echo 1 > "$FAKE_DOCKER/stop-rc"
OUT="$(bd up 2>&1)"; RC=$?
ok "replacement when Chrome cannot be stopped: up fails and the container is NOT replaced" '[ "$RC" != 0 ] && grep -q "NOT replaced" <<< "$OUT" && ! log_has "up -d" && [ -d "$FAKE_DOCKER/containers/$OWN" ]'
fresh; container "$OWN" ai-bridge-chrome running sha256:the-old-image; echo 3 > "$FAKE_DOCKER/stop-rc"
OUT="$(bd up 2>&1)"; RC=$?
ok "replacement after a forced stop: goes ahead, and says that Chrome was terminated" '[ "$RC" = 0 ] && grep -q "WARNING: Chrome had to be terminated" <<< "$OUT" && log_has "up -d --force-recreate"'

fresh; container "$OWN" ai-bridge-chrome running
OUT="$(bd down 2>&1)"; RC=$?
ok "down, clean stop: status 0, container removed" '[ "$RC" = 0 ] && log_has "^exec .* sh -s -- loop" && [ ! -d "$FAKE_DOCKER/containers/$OWN" ]'
fresh; container "$OWN" ai-bridge-chrome running; echo 1 > "$FAKE_DOCKER/stop-rc"
OUT="$(bd down 2>&1)"; RC=$?
ok "down when Chrome cannot be stopped: status 1, the container is NOT removed" '[ "$RC" = 1 ] && grep -q "NOT removed" <<< "$OUT" && ! log_has " down" && [ -d "$FAKE_DOCKER/containers/$OWN" ]'
OUT="$(bd down --force 2>&1)"; RC=$?
ok "down --force then removes it, reports it and exits 3 (not a clean stop)" '[ "$RC" = 3 ] && grep -q "WARNING: Chrome could not be stopped" <<< "$OUT" && [ ! -d "$FAKE_DOCKER/containers/$OWN" ]'
fresh; container "$OWN" ai-bridge-chrome running; echo 3 > "$FAKE_DOCKER/stop-rc"
OUT="$(bd down 2>&1)"; RC=$?
ok "down after a forced stop: container removed, status 3 and a warning (told apart from a clean close)" '[ "$RC" = 3 ] && grep -q "WARNING: Chrome had to be terminated" <<< "$OUT" && [ ! -d "$FAKE_DOCKER/containers/$OWN" ]'
fresh; container "$OWN" ai-bridge-chrome exited
OUT="$(bd down 2>&1)"; RC=$?
ok "down on a stopped container: nothing to close, removed, status 0" '[ "$RC" = 0 ] && ! log_has "^exec " && [ ! -d "$FAKE_DOCKER/containers/$OWN" ]'

fresh; container "$OWN" ai-bridge-chrome running
OUT="$(bd restart-chrome 2>&1)"; RC=$?
ok "restart-chrome, clean: status 0, says closed cleanly" '[ "$RC" = 0 ] && grep -q "Chrome closed cleanly" <<< "$OUT" && log_has "^exec .* sh -s -- chrome"'
echo 1 > "$FAKE_DOCKER/stop-rc"
OUT="$(bd restart-chrome 2>&1)"; RC=$?
ok "restart-chrome when Chrome does not stop: status 1, and it does not claim that Chrome stopped" '[ "$RC" = 1 ] && grep -q "Chrome did not stop" <<< "$OUT" && ! grep -qi "closed cleanly\|Chrome stopped" <<< "$OUT"'
echo 3 > "$FAKE_DOCKER/stop-rc"
OUT="$(bd restart-chrome 2>&1)"; RC=$?
ok "restart-chrome after a forced stop: status 3 and a warning" '[ "$RC" = 3 ] && grep -q "WARNING: Chrome had to be terminated" <<< "$OUT" && ! grep -q "closed cleanly" <<< "$OUT"'

# ---- finding 7: the smoke job's teardown ---------------------------------------
# shellcheck source=test/helpers/smoke-teardown.sh
tear() { # runs the teardown in a subshell with the stand-in docker; prints its messages; returns its status
  ( PATH="$SCR/bin:$PATH"; RUN="smoke-t$N"; BRIDGE_DOCKER_PROJECT="ai-bridge-chrome-$RUN"; BRIDGE_PUBLISH_PORT=1; SCREEN_PUBLISH_PORT=2
    BRIDGE_DOCKER_HOME="$SCR/scratch-$N"; BD() { return 0; }
    . "$REPO/test/helpers/smoke-teardown.sh"; teardown ) 2>&1
}
scratch() { mkdir -p "$SCR/scratch-$N/config/profile"; echo data > "$SCR/scratch-$N/config/profile/Cookies"; container "$OWN" "ai-bridge-chrome-smoke-t$N" running; }
fresh; scratch; echo 1 > "$FAKE_DOCKER/ps-rc"
OUT="$(tear)"; RC=$?
ok "teardown, Docker cannot list containers (daemon unreachable): state unknown, the files are KEPT and the teardown fails" '[ "$RC" != 0 ] && grep -q "UNKNOWN" <<< "$OUT" && [ -s "$SCR/scratch-$N/config/profile/Cookies" ] && ! log_has "^rm "'
fresh; scratch; echo no > "$FAKE_DOCKER/rm-works"
OUT="$(tear)"; RC=$?
ok "teardown, a container survives the removal: the files are kept and the teardown fails" '[ "$RC" != 0 ] && grep -q "still present" <<< "$OUT" && [ -s "$SCR/scratch-$N/config/profile/Cookies" ]'
fresh; scratch
OUT="$(tear)"; RC=$?
ok "teardown, Docker confirms that no container of the run is left: only then are the files removed" '[ "$RC" = 0 ] && [ ! -e "$SCR/scratch-$N" ] && [ -z "$(ls "$FAKE_DOCKER/containers")" ]'

if [ "$failures" = 0 ]; then echo; echo "All docker-chrome helper tests passed."; else echo; echo "$failures TEST(S) FAILED"; fi
exit $(( failures > 0 ))
