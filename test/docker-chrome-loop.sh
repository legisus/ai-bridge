#!/usr/bin/env bash
# The Chrome loop (deploy/docker-chrome/chrome-start.sh) and the stop script
# (chrome-stop.sh) as PROCESSES, in one-off containers of the image with a
# stand-in browser (test/helpers/fake-chrome.py): what they do when a supervisor
# dies, when a stop arrives in the middle of provisioning, when Chrome will not
# close. Needs Docker and the built image; nothing is published, nothing is
# mounted except this clone's test/helpers and deploy/docker-chrome (read-only),
# every container is --rm and unnamed. Run by test/docker-chrome-smoke.sh, or
# alone:
#
#   CHROME_IMAGE=ai-bridge-chrome:local bash test/docker-chrome-loop.sh
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
IMAGE="${CHROME_IMAGE:-ai-bridge-chrome:local}"
failures=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; failures=$((failures+1)); }
expect() { # $1 name, $2 marker that the in-container script prints on success, $3 its output
  if grep -q "^OK $2\$" <<< "$3"; then pass "$1"; else fail "$1"; echo "      $(grep -E "^(NOT OK|OK|loop|stop|log:)" <<< "$3" | tail -n 12 | tr '\n' '|')"; fi
}
# One container per scenario: the image's own chrome-start.sh and provision.py,
# the stand-in as CHROME_BIN, a pretend Wayland socket, the profile in /tmp.
scenario() { # stdin = bash script run inside (common helpers are prepended); its output ends up in $OUT
  OUT="$({ cat <<'PRE'
mkdir -p /tmp/xdg /tmp/cfg /config
printf '#!/bin/sh\nexec python3 /t/fake-chrome.py "$@"\n' > /tmp/fake-chrome; chmod +x /tmp/fake-chrome
python3 -c 'import socket,time; s=socket.socket(socket.AF_UNIX); s.bind("/tmp/xdg/wayland-0"); time.sleep(600)' &
sleep 1
mode() { echo "$1" > /tmp/fake-chrome.mode; }
start_loop() { /usr/local/bin/chrome-start.sh & LOOP=$!; }
browser() { cat /tmp/chrome.pid 2>/dev/null; }
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null && [ -n "$(tr -d '\0' < /proc/$1/cmdline 2>/dev/null)" ]; }
wait_for() { local n="$1"; shift; while [ "$n" -gt 0 ]; do "$@" && return 0; sleep 0.5; n=$((n-1)); done; return 1; }
new_browser() { local b; b="$(browser)"; [ -n "$b" ] && [ "$b" != "${1:-}" ] && alive "$b" && grep -q -- --remote-debugging-port "/proc/$b/cmdline"; }
cdp_up() { curl -fsS -m 2 -o /dev/null http://127.0.0.1:9222/json/version 2>/dev/null; }
fakes() { pgrep -f "fake-chrome.py" | wc -l | tr -d ' '; }
stop_script() { sh -s -- "$1" < /src/chrome-stop.sh; }
say() { if [ "$1" = 0 ]; then echo "OK $2"; else echo "NOT OK $2"; fi; }
finish() { echo "log: $(tail -n 8 /config/chrome-start.log 2>/dev/null | tr '\n' '~')"; echo "fake: $(tr '\n' '~' < /tmp/fake-chrome.log 2>/dev/null)"; }
trap finish EXIT
PRE
    cat; } | docker run --rm -i --entrypoint bash \
      -e CHROME_BIN=/tmp/fake-chrome -e CHROME_CDP_WAIT="${CDP_WAIT:-600}" -e CHROME_LOCK_POLL=1 -e XDG_RUNTIME_DIR=/tmp/xdg -e WAYLAND_DISPLAY=wayland-0 -e CHROME_PROFILE_DIR=/tmp/cfg/profile \
      -v "$REPO/test/helpers:/t:ro" -v "$REPO/deploy/docker-chrome:/src:ro" "$IMAGE" -s 2>&1)"
}

# ---- the profile lock outlives the loop (review finding 4) ---------------------
scenario <<'IN'
mode nocdp; start_loop; wait_for 30 new_browser; B1="$(browser)"
[ "$(readlink /proc/$B1/fd/9)" = /tmp/cfg/.chrome-profile.lock ]; say $? browser-holds-lock
touch /tmp/cfg/profile/SingletonLock
kill -KILL "$LOOP"; wait "$LOOP" 2>/dev/null; sleep 1
alive "$B1"; say $? browser-survives-its-loop
# a second loop that cannot see that browser (pgrep -x chrome does not match the stand-in, as in another container)
start_loop; sleep 6
alive "$B1" && [ "$(fakes)" = 1 ] && [ "$(browser)" = "$B1" ] && [ -e /tmp/cfg/profile/SingletonLock ] && grep -q "in use by another chrome-start loop" /config/chrome-start.log; say $? second-loop-kept-out
kill -TERM "$B1"
wait_for 30 new_browser "$B1" && [ "$(fakes)" = 1 ] && grep -q "free again" /config/chrome-start.log; say $? second-loop-takes-over-after-the-browser
IN
expect "the browser itself holds the profile lock (descriptor inherited from the loop)" browser-holds-lock "$OUT"
expect "kill -9 of the loop leaves its browser running" browser-survives-its-loop "$OUT"
expect "a second loop does not start a browser on that profile and leaves the Singleton files alone while the orphaned browser lives" second-loop-kept-out "$OUT"
expect "…and takes the profile once that browser is gone" second-loop-takes-over-after-the-browser "$OUT"

# ---- a stop request in the middle of provisioning (review finding 9) -----------
scenario <<'IN'
mode cdp; start_loop; wait_for 30 cdp_up
# no /data/token in this container: provision.py sits in its wait for the token — provisioning is under way
wait_for 30 pgrep -f "provision.py$" > /dev/null; say $? provisioning-running
B1="$(browser)"; T0=$(date +%s)
kill -TERM "$LOOP"; wait "$LOOP"; RC=$?; T1=$(date +%s)
echo "loop exit $RC after $((T1 - T0)) s"
[ "$RC" = 0 ] && [ $((T1 - T0)) -le 30 ]; say $? loop-ended-in-time
sleep 1
! pgrep -f "provision.py" > /dev/null; say $? no-provisioning-left
! alive "$B1" && [ "$(fakes)" = 0 ] && grep -q "Browser.close" /tmp/fake-chrome.log && ! grep -q SIGTERM /tmp/fake-chrome.log; say $? browser-closed-cleanly
grep -q "stop requested" /config/chrome-start.log; say $? logged
IN
expect "provisioning is running when the stop arrives" provisioning-running "$OUT"
expect "termination during provisioning: the loop ends, with status 0, within 30 s" loop-ended-in-time "$OUT"
expect "…no provisioning process is left behind" no-provisioning-left "$OUT"
expect "…and the browser was closed with Browser.close, not killed, and not restarted" browser-closed-cleanly "$OUT"

# ---- chrome-stop.sh: clean, forced, failed (review finding 5) ------------------
scenario <<'IN'
mode cdp; start_loop; wait_for 30 cdp_up; B1="$(browser)"
stop_script chrome; RC=$?; echo "stop chrome -> $RC"
[ "$RC" = 0 ] && grep -q "$B1 Browser.close" /tmp/fake-chrome.log; say $? clean-is-0
wait_for 30 new_browser "$B1" && wait_for 30 cdp_up && alive "$LOOP"; say $? loop-restarts-chrome
B2="$(browser)"
stop_script loop; RC=$?; echo "stop loop -> $RC"
[ "$RC" = 0 ] && ! alive "$LOOP" && ! alive "$B2" && [ "$(fakes)" = 0 ] && grep -q "$B2 Browser.close" /tmp/fake-chrome.log; say $? loop-mode-ends-both
sleep 5; [ "$(fakes)" = 0 ]; say $? nothing-restarted
# no loop any more, a browser that lives on (started by hand with Chrome's flags): the stop still closes it cleanly
/tmp/fake-chrome --remote-debugging-port=9222 & echo $! > /tmp/chrome.pid; wait_for 30 cdp_up
stop_script loop; RC=$?; echo "stop orphan -> $RC"
[ "$RC" = 0 ] && [ "$(fakes)" = 0 ]; say $? orphan-closed-cleanly
stop_script loop; RC=$?
[ "$RC" = 0 ]; say $? nothing-running-is-0
IN
expect "chrome-stop chrome: Browser.close taken, process gone -> status 0 (verified clean)" clean-is-0 "$OUT"
expect "…and the loop starts the next Chrome" loop-restarts-chrome "$OUT"
expect "chrome-stop loop: Chrome closed cleanly AND the loop ended -> status 0" loop-mode-ends-both "$OUT"
expect "…and nothing starts another Chrome afterwards" nothing-restarted "$OUT"
expect "chrome-stop loop with a dead loop and a surviving browser: closes that browser cleanly" orphan-closed-cleanly "$OUT"
expect "chrome-stop with nothing running: status 0" nothing-running-is-0 "$OUT"

scenario <<'IN'
mode nocdp; start_loop; wait_for 30 new_browser; B1="$(browser)"
stop_script chrome; RC=$?; echo "stop chrome (no DevTools) -> $RC"
[ "$RC" = 3 ] && ! alive "$B1" && grep -q "$B1 SIGTERM" /tmp/fake-chrome.log; say $? forced-is-3
mode nocdp+ignore-term; wait_for 30 new_browser "$B1"; B2="$(browser)"; sleep 1
stop_script loop; RC=$?; echo "stop loop (deaf browser) -> $RC"
[ "$RC" = 1 ] && alive "$B2"; say $? failed-is-1
state="$(awk '{print $3}' /proc/$LOOP/stat 2>/dev/null)"; echo "loop state $state"
alive "$LOOP" && [ "$state" != T ] && [ "$(browser)" = "$B2" ]; say $? failed-stop-leaves-the-loop-running
IN
expect "chrome-stop when Browser.close is not possible: SIGTERM, process gone -> status 3 (forced, told apart from clean)" forced-is-3 "$OUT"
expect "chrome-stop when Chrome will not end: status 1, Chrome still there" failed-is-1 "$OUT"
expect "…and the loop it had held is running again, with the same Chrome" failed-stop-leaves-the-loop-running "$OUT"

if [ "$failures" = 0 ]; then echo; echo "All docker-chrome loop tests passed."; else echo; echo "$failures TEST(S) FAILED"; fi
exit $(( failures > 0 ))
