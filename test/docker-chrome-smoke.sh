#!/usr/bin/env bash
# Smoke job for "Chrome in Docker" (docs/DOCKER-CHROME.md "Tests"). Needs Docker
# (Colima) and network; not part of `npm test`. Builds the image, runs a
# THROWAWAY instance (its own compose project, its own directories under
# ~/docker, free loopback ports, an empty Chrome profile) and asserts the list
# below. It never uses port 8765, ~/.ai-browser-bridge or the real profile, and
# it checks that a live host relay is exactly as it was before.
#
#   bash test/docker-chrome-smoke.sh              # build + full run
#   SKIP_BUILD=1 bash test/docker-chrome-smoke.sh # use the image that is there
#   KEEP=1 bash test/docker-chrome-smoke.sh       # leave the instance running
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
HELPER="$REPO/bin/bridge-docker"
RUN="smoke-$$"
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
export BRIDGE_DOCKER_HOME="$HOME/docker/ai-bridge-chrome-$RUN"       # under $HOME: Colima shares nothing else
export BRIDGE_DOCKER_PROJECT="ai-bridge-chrome-$RUN"
export BRIDGE_PUBLISH_PORT="$(free_port)"
export SCREEN_PUBLISH_PORT="$(free_port)"
export BRIDGE_DATA_DIR="$BRIDGE_DOCKER_HOME/data"
export CHROME_CONFIG_DIR="$BRIDGE_DOCKER_HOME/config"
export CHROME_DOWNLOADS_DIR="$BRIDGE_DOCKER_HOME/downloads"
export CHROME_IMAGE="${CHROME_IMAGE:-ai-bridge-chrome:local}"
BD() { "$HELPER" --staging "$@"; }
# Every bridge call of this job names its port and state directory explicitly.
B() { AI_BRIDGE_HOME="$BRIDGE_DATA_DIR" BRIDGE_PORT="$BRIDGE_PUBLISH_PORT" node "$REPO/server/cli.js" "$@"; }
HOST() { AI_BRIDGE_HOME="$HOME/.ai-browser-bridge" BRIDGE_PORT=8765 node "$REPO/server/cli.js" "$@"; }
jget() { python3 -c 'import sys,json
try: v=json.load(sys.stdin)
except Exception: sys.exit(1)
for k in sys.argv[1].split("."): v=v[int(k)] if isinstance(v,list) else v.get(k) if isinstance(v,dict) else None
print("" if v is None else v)' "$1"; }

failures=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; failures=$((failures+1)); }
check() { if eval "$2" > /dev/null 2>&1; then pass "$1"; else fail "$1"; fi; }
C() { docker compose -f "$REPO/deploy/docker-chrome/compose.yml" -p "$BRIDGE_DOCKER_PROJECT" ps -q chrome 2>/dev/null | head -1; }
wait_ready() { # $1 seconds
  local n=$(( $1 / 3 ))
  for _ in $(seq 1 "$n"); do B ping --timeout 4000 2>/dev/null | grep -q '"session":"docker-chrome".*"access":"granted"' && return 0; sleep 3; done
  return 1
}
host_identity() { # serverId/extGen/accessGen/session of the live host relay + the pids listening on 8765
  local pong; pong="$(HOST ping --timeout 4000 2>/dev/null)" || { echo "none"; return; }
  echo "$(jget serverId <<< "$pong")/$(jget extGen <<< "$pong")/$(jget accessGen <<< "$pong")/$(jget session <<< "$pong") pids:$(lsof -nP -iTCP:8765 -sTCP:LISTEN -t 2>/dev/null | sort -u | paste -sd, -)"
}
# What else on the Mac must be exactly as before: the Mac's own Chrome (oldest
# "Google Chrome" process) and any launchd job named in HOST_WATCH_LABELS
# (space-separated labels, e.g. a bot daemon) — by pid.
host_processes() {
  local out="chrome:$(pgrep -o -x 'Google Chrome' 2>/dev/null || echo none)" l
  for l in ${HOST_WATCH_LABELS:-}; do out="$out $l:$(launchctl list 2>/dev/null | awk -v l="$l" '$3==l {print $1}')"; done
  echo "$out"
}
# Teardown: only this run's containers and files; the files go only when Docker
# has confirmed that the containers are gone (test/helpers/smoke-teardown.sh).
SMOKE_EXTRA_IMAGES=""
. "$REPO/test/helpers/smoke-teardown.sh"
trap teardown EXIT

HOST_BEFORE="$(host_identity)"; HOSTP_BEFORE="$(host_processes)"
echo "smoke: project $BRIDGE_DOCKER_PROJECT, relay port $BRIDGE_PUBLISH_PORT, screen port $SCREEN_PUBLISH_PORT, files $BRIDGE_DOCKER_HOME"
echo "host relay before: $HOST_BEFORE"
echo "host processes before: $HOSTP_BEFORE"
[ "$BRIDGE_PUBLISH_PORT" != 8765 ] || { echo "refusing to run on the live port"; exit 1; }

# ---- 1) image ---------------------------------------------------------------
if [ "${SKIP_BUILD:-0}" != 1 ]; then
  if "$HELPER" build > /tmp/docker-chrome-smoke-build.$$ 2>&1; then pass "image builds"; else fail "image builds"; tail -20 /tmp/docker-chrome-smoke-build.$$; exit 1; fi
  rm -f /tmp/docker-chrome-smoke-build.$$
fi
IMG() { docker run --rm --entrypoint sh "$CHROME_IMAGE" -c "$1" 2>/dev/null; }
check "no Chromium package in the image" '[ -z "$(IMG "dpkg-query -W -f=\"\\\${Package}\\n\" | grep -i chromium")" ]'
check "no chromium binary on PATH" '[ -z "$(IMG "command -v chromium chromium-browser chromium-shell chromedriver wrapped-chromium")" ]'
OTHER="$(IMG "find / -xdev \( -path /proc -o -path /sys -o -path /opt/google \) -prune -o -type f -perm /111 ! -name chrome-start.sh \( -iname 'chromium*' -o -iname chrome -o -iname 'chrome-*' -o -iname headless_shell -o -iname firefox -o -iname 'firefox-*' \) -print")"
if [ -z "$OTHER" ]; then pass "no other browser executable anywhere in the image's filesystem"; else fail "other browser executables: $OTHER"; fi
check "no Chromium directories (/usr/lib/chromium*, /usr/share/chromium*, /etc/chromium*, /snap)" '[ -z "$(IMG "ls -d /usr/lib/chromium* /usr/lib/*/chromium* /usr/share/chromium* /etc/chromium* /snap 2>/dev/null")" ]'
PKG="$(IMG "dpkg-query -W -f='\${Package} \${Version} \${Maintainer}' google-chrome-stable")"
if grep -q '^google-chrome-stable [0-9].*Chrome Linux Team' <<< "$PKG"; then pass "the browser package is Google's google-chrome-stable ($PKG)"; else fail "google-chrome-stable package: '$PKG'"; fi
echo "      image under test: id $(docker image inspect "$CHROME_IMAGE" --format '{{.Id}}'), source commit $(docker image inspect "$CHROME_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'), $(IMG 'cat /opt/ai-bridge/CHROME_VERSION'), .deb sha256 $(IMG 'cat /opt/ai-bridge/CHROME_DEB_SHA256')"
check "image labels name the installed Chrome version and package checksum" '[ "$(docker image inspect "$CHROME_IMAGE" --format "{{index .Config.Labels \"ai-bridge.chrome.version\"}}")" = "$(IMG "cat /opt/ai-bridge/CHROME_VERSION")" ] && [ "$(docker image inspect "$CHROME_IMAGE" --format "{{index .Config.Labels \"ai-bridge.chrome.deb-sha256\"}}")" = "$(IMG "cat /opt/ai-bridge/CHROME_DEB_SHA256")" ]'

# ---- 1b) the Chrome loop against a browser that never opens its debug port ----
# A stand-in binary (sleeps forever) in a one-off container, no relay, no screen:
# the loop must give up on it at the deadline, kill it, say so, and try again.
HANG="$(docker run --rm --entrypoint bash -e CHROME_BIN=/tmp/fake-chrome -e CHROME_CDP_WAIT=4 -e XDG_RUNTIME_DIR=/tmp/xdg -e WAYLAND_DISPLAY=wayland-0 -e CHROME_PROFILE_DIR=/tmp/cfg/profile "$CHROME_IMAGE" -c '
  mkdir -p /tmp/xdg /tmp/cfg /config && printf "#!/bin/bash\nexec sleep 600\n" > /tmp/fake-chrome && chmod +x /tmp/fake-chrome
  python3 -c "import socket,time; s=socket.socket(socket.AF_UNIX); s.bind(\"/tmp/xdg/wayland-0\"); time.sleep(60)" &
  sleep 1; timeout 22 /usr/local/bin/chrome-start.sh; echo "loop exit $?"; pgrep -c -x sleep; cat /config/chrome-start.log' 2>&1)"
if grep -q "debug port never opened within 4 s; stopping it" <<< "$HANG" && [ "$(grep -c "before its debug port opened" <<< "$HANG")" -ge 2 ]; then pass "a Chrome that never opens its debug port is stopped at the deadline and restarted (no endless wait)"; else fail "pre-CDP hang handling: $(tail -n 6 <<< "$HANG" | tr '\n' '|')"; fi

# ---- 1c) the loop and the stop script as processes, with a stand-in browser ----
# (supervisor death, a stop during provisioning, clean / forced / failed stops)
if LOOP_OUT="$(CHROME_IMAGE="$CHROME_IMAGE" bash "$REPO/test/docker-chrome-loop.sh" 2>&1)"; then pass "loop and stop-script behaviour ($(grep -c '^PASS' <<< "$LOOP_OUT") cases, test/docker-chrome-loop.sh)"; else fail "loop and stop-script behaviour (test/docker-chrome-loop.sh)"; fi
grep -E '^(PASS|FAIL|      )' <<< "$LOOP_OUT" | sed 's/^/      /'

# ---- 2) up ------------------------------------------------------------------
if BD up > "/tmp/docker-chrome-smoke-up.$$" 2>&1; then pass "bridge-docker up: relay reports session docker-chrome, access granted"; else fail "bridge-docker up"; tail -15 "/tmp/docker-chrome-smoke-up.$$"; BD logs chrome 2>&1 | tail -20; exit 1; fi
rm -f "/tmp/docker-chrome-smoke-up.$$"
CID="$(C)"
PONG1="$(B ping)"; SERVER1="$(jget serverId <<< "$PONG1")"; GEN1="$(jget extGen <<< "$PONG1")"
echo "      $PONG1"
check "relay reachable from the Mac on 127.0.0.1:$BRIDGE_PUBLISH_PORT" 'nc -z -w 3 127.0.0.1 "$BRIDGE_PUBLISH_PORT"'
check "status shows the extension's session name docker-chrome" '[ "$(B status | jget session)" = docker-chrome ]'
check "bridge-docker status is green" 'BD status'

# ---- 3) who runs what, as whom ----------------------------------------------
check "the relay runs as the Mac user's uid inside the container" '[ "$(docker exec "$CID" sh -c "ps -o uid= -C node | head -1 | tr -d \" \"")" = "$(id -u)" ]'
check "state directory is private and the token is 0600, owned by this user, on the Mac" '[ "$(stat -f "%Lp %u" "$BRIDGE_DATA_DIR")" = "700 $(id -u)" ] && [ "$(stat -f "%Lp %u" "$BRIDGE_DATA_DIR/token")" = "600 $(id -u)" ]'
TOKEN_SUM1="$(shasum -a 256 "$BRIDGE_DATA_DIR/token" | cut -d' ' -f1)"
EXE="$(docker exec -u abc "$CID" sh -c 'readlink /proc/$(pgrep -o -x chrome)/exe')"
if [ "$EXE" = /opt/google/chrome/chrome ]; then pass "the running browser executable is /opt/google/chrome/chrome"; else fail "running browser executable: '$EXE'"; fi
CMDLINE="$(docker exec -u abc "$CID" sh -c 'tr "\0" " " < /proc/$(pgrep -o -x chrome)/cmdline')"
check "Chrome runs without --no-sandbox / --test-type / --headless" '! grep -qE -- "--no-sandbox|--test-type|--headless|--disable-setuid-sandbox" <<< "$CMDLINE"'
check "Chrome runs on the explicit profile directory with the loopback debug port" 'grep -q -- "--user-data-dir=/config/profile " <<< "$CMDLINE" && grep -q -- "--remote-debugging-port=9222" <<< "$CMDLINE"'
check "the real Chrome process holds the profile lock itself (it outlives the loop that started it)" '[ "$(docker exec -u abc "$CID" sh -c "readlink /proc/\$(cat /tmp/chrome.pid)/fd/9")" = /config/.chrome-profile.lock ]'
VER="$(docker exec "$CID" curl -fsS http://127.0.0.1:9222/json/version)"
check "CDP /json/version: Browser is Chrome/<version>" '[[ "$(jget Browser <<< "$VER")" == Chrome/* ]]'
SANDBOX="$(docker exec -u abc "$CID" /lsiopy/bin/python3 -I -c '
import json, time, urllib.request, websocket
v = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/version"))
ws = websocket.create_connection(v["webSocketDebuggerUrl"], suppress_origin=True, timeout=20); n = [0]
def call(m, s=None, **p):
    n[0] += 1; d = {"id": n[0], "method": m, "params": p}
    if s: d["sessionId"] = s
    ws.send(json.dumps(d))
    while True:
        r = json.loads(ws.recv())
        if r.get("id") == n[0]: return r.get("result", {})
t = call("Target.createTarget", url="chrome://sandbox", background=True)["targetId"]
s = call("Target.attachToTarget", targetId=t, flatten=True)["sessionId"]
text = ""
for _ in range(20):
    time.sleep(0.5)
    text = call("Runtime.evaluate", s, expression="document.body ? document.body.innerText : \"\"", returnByValue=True).get("result", {}).get("value", "")
    if "sandboxed" in text: break
call("Target.closeTarget", targetId=t)
print(" | ".join(l for l in text.splitlines() if l.strip()))' 2>&1)"
if grep -q "You are adequately sandboxed" <<< "$SANDBOX"; then pass "chrome://sandbox: You are adequately sandboxed"; else fail "chrome://sandbox says: $SANDBOX"; fi
LISTEN="$(docker exec "$CID" sh -c 'ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null' | grep ':9222 ')"
check "the debug port listens on the container's loopback only" 'grep -q "127.0.0.1:9222" <<< "$LISTEN" && ! grep -qE "(0\.0\.0\.0|\*|\[::\]):9222" <<< "$LISTEN"'
check "9222 is not reachable from the Mac and not published" '! nc -z -w 2 127.0.0.1 9222 && ! docker port "$CID" | grep -q 9222'
check "everything published is on 127.0.0.1" '[ -z "$(docker port "$CID" | grep -v "127.0.0.1:")" ]'
check "the screen answers on http://127.0.0.1:$SCREEN_PUBLISH_PORT (Selkies)" 'curl -fsS -m 10 "http://127.0.0.1:$SCREEN_PUBLISH_PORT/" | grep -qi selkies'

# ---- 4) the bridge, end to end ----------------------------------------------
functional() { # $1 = label
  local L="$1" T I out
  T="$(B newTab '{"url":"https://example.com"}' | jget id)"
  if [ -n "$T" ]; then pass "$L: newTab https://example.com"; else fail "$L: newTab"; return; fi
  for _ in 1 2 3 4 5 6; do out="$(B eval "{\"tabId\":$T,\"code\":\"document.title\"}" 2>&1)"; [ "$out" = '"Example Domain"' ] && break; sleep 2; done
  if [ "$out" = '"Example Domain"' ]; then pass "$L: stealth eval works (Allow User Scripts is on)"; else fail "$L: stealth eval: $out"; fi
  out="$(B eval "{\"tabId\":$T,\"code\":\"navigator.userAgentData.brands.map(b=>b.brand).join('|')\"}" 2>&1)"
  if grep -q "Google Chrome" <<< "$out"; then pass "$L: the page sees the brand Google Chrome"; else fail "$L: brands: $out"; fi
  I="$(B newTab '{"url":"https://example.com","incognito":true}')"
  if [ "$(jget incognito <<< "$I")" = True ]; then pass "$L: incognito newTab opens an incognito window"; else fail "$L: incognito newTab: $I"; fi
  I="$(jget id <<< "$I")"
  if [ -n "$I" ]; then
    for _ in 1 2 3 4 5 6; do out="$(B eval "{\"tabId\":$I,\"code\":\"document.title\"}" 2>&1)"; [ "$out" = '"Example Domain"' ] && break; sleep 2; done
    if [ "$out" = '"Example Domain"' ]; then pass "$L: stealth eval in the incognito tab"; else fail "$L: incognito eval: $out"; fi
    out="$(B listTabs | python3 -c 'import sys,json; r=[t for t in json.load(sys.stdin) if t.get("incognito")]; print(len(r), all(t.get("agent") for t in r))')"
    if [ "$out" = "1 True" ]; then pass "$L: listTabs marks exactly the incognito tab, as an agent tab"; else fail "$L: listTabs incognito rows: $out"; fi
    out="$(B newTab '{"url":"https://example.com/?plain"}')"
    if [ -z "$(jget incognito <<< "$out")" ]; then pass "$L: an ordinary newTab stays in the regular window while an incognito window is open"; else fail "$L: ordinary newTab landed incognito: $out"; fi
    B closeTab "{\"tabId\":$(jget id <<< "$out")}" > /dev/null 2>&1
    check "$L: closeTab closes the incognito tab" 'B closeTab "{\"tabId\":$I}" && [ "$(B listTabs | grep -c "\"incognito\":true")" = 0 ]'
  fi
  check "$L: closeTab" 'B closeTab "{\"tabId\":$T}"'
}
functional "first start"

T="$(B newTab '{"url":"https://example.com"}' | jget id)"; sleep 3
check "selectTab + screenshot writes a PNG" 'B selectTab "{\"tabId\":$T}" && sleep 1 && B screenshot "{\"tabId\":$T}" --out "$BRIDGE_DOCKER_HOME/shot.png" && [ "$(head -c 4 "$BRIDGE_DOCKER_HOME/shot.png" | xxd -p)" = 89504e47 ] && [ "$(stat -f %z "$BRIDGE_DOCKER_HOME/shot.png")" -gt 2000 ]'
B download '{"url":"https://example.com/","filename":"docker-chrome-smoke.html"}' > /dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8; do [ -s "$CHROME_DOWNLOADS_DIR/docker-chrome-smoke.html" ] && break; sleep 1; done
check "download lands in the Mac-side downloads directory, owned by this user" '[ -s "$CHROME_DOWNLOADS_DIR/docker-chrome-smoke.html" ] && [ "$(stat -f %u "$CHROME_DOWNLOADS_DIR/docker-chrome-smoke.html")" = "$(id -u)" ]'
B eval "{\"tabId\":$T,\"code\":\"localStorage.setItem('smoke','$RUN'); document.cookie='smoke=$RUN; max-age=3600; path=/'; 1\"}" > /dev/null 2>&1

# ---- 5) provisioning by hand leaves a healthy extension alone ----------------
PROV="$(BD provision 2>&1)"
P2="$(B ping)"
check "provision by hand: extension not reloaded (same extGen, same serverId), nothing rewritten" 'grep -q "not reloaded" <<< "$PROV" && grep -q "toggles: already on" <<< "$PROV" && grep -q "storage: unchanged" <<< "$PROV" && [ "$(jget extGen <<< "$P2")" = "$GEN1" ] && [ "$(jget serverId <<< "$P2")" = "$SERVER1" ]'
OWNED="$(B listTabs | grep -c "\"id\":$T,[^}]*\"agent\":true")"; OUT="$(B eval "{\"tabId\":$T,\"code\":\"document.title\"}" 2>&1)"
if [ "$OWNED" = 1 ] && [ "$OUT" = '"Example Domain"' ]; then pass "provision by hand: the tab opened before is still owned and usable"; else fail "provision by hand: the tab opened before is still owned and usable (owned=$OWNED eval=$OUT)"; fi
check "provision output does not contain the token" '! grep -q "$(cat "$BRIDGE_DATA_DIR/token")" <<< "$PROV"'
B closeTab "{\"tabId\":$T}" > /dev/null 2>&1

# ---- 6) Chrome restart inside the container ----------------------------------
BS1="$(jget browserSession < "$BRIDGE_DATA_DIR/tabs.json" 2>/dev/null)"
STALE="$(B newTab '{"url":"https://example.com/?left-open"}' | jget id)"      # owned by this browser session; Chrome is about to restart under it
BD restart-chrome > /dev/null 2>&1
sleep 4
if wait_ready 90; then
  P3="$(B ping)"
  check "after a Chrome restart: green again, same relay (serverId), higher extGen (the extension was provisioned again)" '[ "$(jget serverId <<< "$P3")" = "$SERVER1" ] && [ "$(jget extGen <<< "$P3")" -gt "$GEN1" ]'
  BS2="$(jget browserSession < "$BRIDGE_DATA_DIR/tabs.json" 2>/dev/null)"
  if [ -n "$BS1" ] && [ -n "$BS2" ] && [ "$BS1" != "$BS2" ]; then pass "after a Chrome restart: a fresh browserSession in the relay's registry"; else fail "browserSession before/after a Chrome restart: '$BS1' / '$BS2'"; fi
  OWN="$(B status | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("agentTabs") or []))')"
  REG="$(B tabs --json 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d["current"]), int(sys.argv[1]) in [t["tabId"] for t in d["current"]])' "$STALE" 2>&1)"
  if [ "$OWN" = 0 ] && [ "$REG" = "0 False" ]; then pass "after a Chrome restart: no ownership carried over (the extension owns no tab; the registry has no current tab: the old session's tab is dead or pruned)"; else fail "stale ownership after a Chrome restart: agentTabs=$OWN registry(current count, old tab still current)=$REG"; fi
  functional "after Chrome restart"
  T="$(B newTab '{"url":"https://example.com"}' | jget id)"; sleep 3
  OUT="$(B eval "{\"tabId\":$T,\"code\":\"localStorage.getItem('smoke')+'/'+(document.cookie.match(/smoke=([^;]+)/)||[])[1]\"}" 2>&1)"
  if [ "$OUT" = "\"$RUN/$RUN\"" ]; then pass "after a Chrome restart: the profile kept its site data (localStorage + cookie)"; else fail "after a Chrome restart: site data: $OUT"; fi
  B closeTab "{\"tabId\":$T}" > /dev/null 2>&1
else
  fail "after a Chrome restart: not ready within 90 s"; BD logs chrome 2>&1 | tail -15
fi

# ---- 7) container restart -----------------------------------------------------
BS3="$(jget browserSession < "$BRIDGE_DATA_DIR/tabs.json" 2>/dev/null)"
STALE2="$(B newTab '{"url":"https://example.com/?left-open-2"}' | jget id)"   # owned by this browser session; the whole container is about to restart under it
docker restart "$CID" > /dev/null 2>&1
sleep 5
if wait_ready 150; then
  P4="$(B ping)"
  BS4="$(jget browserSession < "$BRIDGE_DATA_DIR/tabs.json" 2>/dev/null)"
  if [ -n "$BS3" ] && [ -n "$BS4" ] && [ "$BS3" != "$BS4" ]; then pass "after a container restart: a fresh browserSession in the relay's registry"; else fail "browserSession before/after a container restart: '$BS3' / '$BS4'"; fi
  OWN="$(B status | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("agentTabs") or []))')"
  REG="$(B tabs --json 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d["current"]), int(sys.argv[1]) in [t["tabId"] for t in d["current"]])' "$STALE2" 2>&1)"
  if [ -n "$STALE2" ] && [ "$OWN" = 0 ] && [ "$REG" = "0 False" ]; then pass "after a container restart: no ownership carried over (the extension owns no tab; the registry has no current tab)"; else fail "stale ownership after a container restart: tab=$STALE2 agentTabs=$OWN registry(current count, old tab still current)=$REG"; fi
  check "after a container restart: green again with a new relay (new serverId)" '[ -n "$(jget serverId <<< "$P4")" ] && [ "$(jget serverId <<< "$P4")" != "$SERVER1" ]'
  check "after a container restart: the token is the same file content" '[ "$(shasum -a 256 "$BRIDGE_DATA_DIR/token" | cut -d" " -f1)" = "$TOKEN_SUM1" ]'
  functional "after container restart"
  T="$(B newTab '{"url":"https://example.com"}' | jget id)"; sleep 3
  OUT="$(B eval "{\"tabId\":$T,\"code\":\"localStorage.getItem('smoke')+'/'+(document.cookie.match(/smoke=([^;]+)/)||[])[1]\"}" 2>&1)"
  if [ "$OUT" = "\"$RUN/$RUN\"" ]; then pass "after a container restart: the profile kept its site data (localStorage + cookie)"; else fail "after a container restart: site data: $OUT"; fi
  B closeTab "{\"tabId\":$T}" > /dev/null 2>&1
  check "one Chrome loop, one browser process tree" '[ "$(docker exec "$CID" pgrep -c -f "^/bin/bash /usr/local/bin/chrome-start.sh")" -ge 1 ] && [ "$(docker exec -u abc "$CID" sh -c "pgrep -x chrome -a | grep -vc -- --type=")" = 1 ]'
else
  fail "after a container restart: not ready within 150 s"; BD logs chrome 2>&1 | tail -15
fi

# ---- 8) recreation: down (clean stop) + up = a NEW container on the same directories ----
B eval "{\"tabId\":$(B newTab '{"url":"https://example.com"}' | jget id),\"code\":\"document.cookie='recreate=$RUN; max-age=3600; path=/'; 1\"}" > /dev/null 2>&1   # seconds before the stop: only a clean stop keeps it
OLD_CID="$CID"
BD down > /dev/null 2>&1
check "down: the container is gone, the state and the profile stay" '[ -z "$(C)" ] && [ -s "$BRIDGE_DATA_DIR/token" ] && [ -d "$CHROME_CONFIG_DIR/profile/Default" ]'
if BD up > /dev/null 2>&1; then
  CID="$(C)"
  check "recreated: a new container, the same token, green" '[ -n "$CID" ] && [ "$CID" != "$OLD_CID" ] && [ "$(shasum -a 256 "$BRIDGE_DATA_DIR/token" | cut -d" " -f1)" = "$TOKEN_SUM1" ] && BD status'
  T="$(B newTab '{"url":"https://example.com"}' | jget id)"; sleep 3
  OUT="$(B eval "{\"tabId\":$T,\"code\":\"localStorage.getItem('smoke')+'/'+(document.cookie.match(/recreate=([^;]+)/)||[])[1]\"}" 2>&1)"
  if [ "$OUT" = "\"$RUN/$RUN\"" ]; then pass "recreated: the profile kept its data, including a cookie set seconds before the stop (clean Browser.close)"; else fail "recreated: site data: $OUT"; fi
  B closeTab "{\"tabId\":$T}" > /dev/null 2>&1
else
  fail "bridge-docker up after down"; BD logs chrome 2>&1 | tail -15
fi

# ---- 8b) replacement: `up` with another image right after a cookie was set ------
# The advertised rebuild-and-up path. Compose replaces the container; the helper
# must have closed Chrome cleanly BEFORE that, or this cookie is lost.
REPL_IMAGE="ai-bridge-chrome-$RUN:replace"
if printf 'FROM %s\nLABEL ai-bridge.smoke.replace=%s\n' "$CHROME_IMAGE" "$RUN" | docker build -q -t "$REPL_IMAGE" - > /dev/null 2>&1; then
  SMOKE_EXTRA_IMAGES="$REPL_IMAGE"
  B eval "{\"tabId\":$(B newTab '{"url":"https://example.com"}' | jget id),\"code\":\"document.cookie='replace=$RUN; max-age=3600; path=/'; 1\"}" > /dev/null 2>&1
  OLD_CID="$CID"
  OUT="$(CHROME_IMAGE="$REPL_IMAGE" BD up 2>&1)"; RC=$?
  CID="$(C)"
  check "up with a new image: Chrome is closed cleanly first, then the container is replaced" '[ "$RC" = 0 ] && grep -q "closing Chrome before it is replaced" <<< "$OUT" && grep -q "Chrome closed cleanly" <<< "$OUT" && [ -n "$CID" ] && [ "$CID" != "$OLD_CID" ] && [ "$(docker inspect "$CID" --format "{{.Config.Image}}")" = "$REPL_IMAGE" ]'
  T="$(B newTab '{"url":"https://example.com"}' | jget id)"; sleep 3
  OUT="$(B eval "{\"tabId\":$T,\"code\":\"(document.cookie.match(/replace=([^;]+)/)||[])[1]\"}" 2>&1)"
  if [ "$OUT" = "\"$RUN\"" ]; then pass "replaced: a cookie set immediately before the replacement is still there"; else fail "replaced: cookie set before the replacement: $OUT"; fi
  B closeTab "{\"tabId\":$T}" > /dev/null 2>&1
  OUT="$(CHROME_IMAGE="$REPL_IMAGE" BD up 2>&1)"; RC=$?
  check "up again with nothing changed: the container and its Chrome are left alone" '[ "$RC" = 0 ] && ! grep -q "closing Chrome" <<< "$OUT" && [ "$(C)" = "$CID" ]'
else
  fail "could not build the replacement image $REPL_IMAGE"
fi

# ---- 9) the guards (nothing below may start a container) -----------------------
N_BEFORE="$(docker ps -aq | wc -l | tr -d ' ')"
P2="$(free_port)"; S2="$(free_port)"
OUT="$(BRIDGE_DOCKER_PROJECT="${BRIDGE_DOCKER_PROJECT}-b" BRIDGE_PUBLISH_PORT="$P2" SCREEN_PUBLISH_PORT="$S2" BRIDGE_DATA_DIR="$BRIDGE_DOCKER_HOME/data-b" "$HELPER" --staging up 2>&1)"
check "a second instance on the same profile directory is refused" 'grep -q "belongs to another container.*Chrome profile directory" <<< "$OUT"'
ln -s "$CHROME_CONFIG_DIR" "$BRIDGE_DOCKER_HOME/config-alias"
for ALIAS in "$CHROME_CONFIG_DIR/" "$BRIDGE_DOCKER_HOME/data/../config" "$BRIDGE_DOCKER_HOME/config-alias"; do
  OUT="$(BRIDGE_DOCKER_PROJECT="${BRIDGE_DOCKER_PROJECT}-b" BRIDGE_PUBLISH_PORT="$P2" SCREEN_PUBLISH_PORT="$S2" BRIDGE_DATA_DIR="$BRIDGE_DOCKER_HOME/data-b" CHROME_CONFIG_DIR="$ALIAS" "$HELPER" --staging up 2>&1)"
  check "…also under another spelling of the path (${ALIAS#$BRIDGE_DOCKER_HOME/})" 'grep -q "belongs to another container.*Chrome profile directory" <<< "$OUT"'
done
OUT="$(BRIDGE_DOCKER_PROJECT="${BRIDGE_DOCKER_PROJECT}-b" BRIDGE_PUBLISH_PORT="$P2" SCREEN_PUBLISH_PORT="$S2" CHROME_CONFIG_DIR="$BRIDGE_DOCKER_HOME/config-b" BRIDGE_DATA_DIR="$BRIDGE_DATA_DIR/" "$HELPER" --staging up 2>&1)"
check "a second instance on the same state directory is refused (own profile, own ports, path alias)" 'grep -q "belongs to another container.*state directory" <<< "$OUT"'
OUT="$(BRIDGE_DOCKER_PROJECT="${BRIDGE_DOCKER_PROJECT}-c" CHROME_CONFIG_DIR=/tmp/ai-bridge-chrome-outside "$HELPER" --staging up 2>&1)"
check "a mount outside \$HOME is refused" 'grep -q "not under \$HOME" <<< "$OUT"'
if [ "$HOST_BEFORE" != none ]; then
  # the LIVE state directory under an alias, with its own ports and profile: refused while the host relay runs (nothing is written to it)
  for ALIAS in "$HOME/.ai-browser-bridge/" "$HOME/./.ai-browser-bridge"; do
    OUT="$(BRIDGE_DOCKER_PROJECT="${BRIDGE_DOCKER_PROJECT}-d" BRIDGE_PUBLISH_PORT="$P2" SCREEN_PUBLISH_PORT="$S2" CHROME_CONFIG_DIR="$BRIDGE_DOCKER_HOME/config-d" CHROME_DOWNLOADS_DIR="$BRIDGE_DOCKER_HOME/downloads-d" BRIDGE_DATA_DIR="$ALIAS" "$HELPER" --staging up 2>&1)"
    check "the host relay's state directory is refused under the alias ${ALIAS#$HOME/}" 'grep -q "a host relay is running on .*/\.ai-browser-bridge (pid" <<< "$OUT"'
  done
fi
mkdir -m 755 "$BRIDGE_DOCKER_HOME/data-open"
OUT="$(BRIDGE_DOCKER_PROJECT="${BRIDGE_DOCKER_PROJECT}-e" BRIDGE_PUBLISH_PORT="$P2" SCREEN_PUBLISH_PORT="$S2" CHROME_CONFIG_DIR="$BRIDGE_DOCKER_HOME/config-e" BRIDGE_DATA_DIR="$BRIDGE_DOCKER_HOME/data-open" "$HELPER" --staging up 2>&1)"
check "a state directory that others can read is refused, not repaired" 'grep -q "must be mode 700" <<< "$OUT" && [ "$(stat -f %Lp "$BRIDGE_DOCKER_HOME/data-open")" = 755 ]'
check "none of the refused starts created a container" '[ "$(docker ps -aq | wc -l | tr -d " ")" = "$N_BEFORE" ]'
# The profile lock itself, with the helper's guard out of the way: a second
# container on the same /config (plain `docker run`, nothing published) must
# not start a Chrome on the profile.
RIVAL="$(docker run -d --name "ai-bridge-chrome-$RUN-rival" --security-opt seccomp=unconfined --shm-size 1g -e PUID="$(id -u)" -e PGID="$(id -g)" -v "$CHROME_CONFIG_DIR:/config" -v "$BRIDGE_DOCKER_HOME/data-rival:/data" "$CHROME_IMAGE" 2>/dev/null)"
for _ in $(seq 1 30); do grep -q "in use by another chrome-start loop" "$CHROME_CONFIG_DIR/chrome-start.log" 2>/dev/null && break; sleep 2; done
check "a second container on the same profile volume does not start Chrome (profile lock)" 'grep -q "in use by another chrome-start loop" "$CHROME_CONFIG_DIR/chrome-start.log" && [ "$(docker exec "$RIVAL" pgrep -c -x chrome)" = 0 ] && [ "$(docker exec -u abc "$CID" sh -c "pgrep -x chrome -a | grep -vc -- --type=")" = 1 ] && B ping | grep -q "\"access\":\"granted\""'
# …and the same when the loop that started the Chrome is dead while its Chrome
# lives on: the rival cannot see that Chrome (another pid namespace); only the
# lock, held by the browser itself, keeps it off the profile.
docker exec -u abc "$CID" sh -c 'kill -KILL "$(cat /tmp/chrome-start.pid)"'
sleep 14                                  # the rival asks for the lock every 5 s
check "the loop is killed, its Chrome lives on: the Chrome still holds the profile lock" '[ "$(docker exec "$CID" pgrep -c -f "chrome-start.sh")" = 0 ] && [ "$(docker exec -u abc "$CID" sh -c "pgrep -x chrome -a | grep -vc -- --type=")" = 1 ] && [ "$(docker exec -u abc "$CID" sh -c "readlink /proc/\$(cat /tmp/chrome.pid)/fd/9")" = /config/.chrome-profile.lock ]'
check "…so the second container still starts no Chrome and the Singleton links are untouched" '[ "$(docker exec "$RIVAL" pgrep -c -x chrome)" = 0 ] && ! grep -q "free again" "$CHROME_CONFIG_DIR/chrome-start.log" && docker exec "$CID" test -L /config/profile/SingletonLock && B ping | grep -q "\"access\":\"granted\""'
docker rm -f "$RIVAL" > /dev/null 2>&1
OUT="$(BD down 2>&1)"; RC=$?
check "down with a dead loop: the orphaned Chrome is still closed cleanly (status 0), the container is gone" '[ "$RC" = 0 ] && grep -q "Chrome closed cleanly" <<< "$OUT" && [ -z "$(C)" ]'
# two `up`s at the same moment on one fresh profile: exactly one may win
( BRIDGE_DOCKER_PROJECT="ai-bridge-chrome-$RUN-r1" BRIDGE_PUBLISH_PORT="$(free_port)" SCREEN_PUBLISH_PORT="$(free_port)" CHROME_CONFIG_DIR="$BRIDGE_DOCKER_HOME/config-race" BRIDGE_DATA_DIR="$BRIDGE_DOCKER_HOME/data-r1" "$HELPER" --staging up > "$BRIDGE_DOCKER_HOME/race1.log" 2>&1; echo "rc=$?" >> "$BRIDGE_DOCKER_HOME/race1.log" ) &
( BRIDGE_DOCKER_PROJECT="ai-bridge-chrome-$RUN-r2" BRIDGE_PUBLISH_PORT="$(free_port)" SCREEN_PUBLISH_PORT="$(free_port)" CHROME_CONFIG_DIR="$BRIDGE_DOCKER_HOME/config-race" BRIDGE_DATA_DIR="$BRIDGE_DOCKER_HOME/data-r2" "$HELPER" --staging up > "$BRIDGE_DOCKER_HOME/race2.log" 2>&1; echo "rc=$?" >> "$BRIDGE_DOCKER_HOME/race2.log" ) &
wait
WON="$(grep -l '^rc=0' "$BRIDGE_DOCKER_HOME"/race[12].log | wc -l | tr -d ' ')"; LOST="$(grep -l "belongs to another container" "$BRIDGE_DOCKER_HOME"/race[12].log | wc -l | tr -d ' ')"
if [ "$WON" = 1 ] && [ "$LOST" = 1 ] && [ "$(docker ps -q --filter "name=^ai-bridge-chrome-$RUN-r" | wc -l | tr -d ' ')" = 1 ]; then pass "two concurrent starts on one profile: one runs, one is refused"; else fail "concurrent starts: won=$WON refused=$LOST ($(tail -n 1 "$BRIDGE_DOCKER_HOME/race1.log") | $(tail -n 1 "$BRIDGE_DOCKER_HOME/race2.log"))"; fi
for r in r1 r2; do BRIDGE_DOCKER_PROJECT="ai-bridge-chrome-$RUN-$r" CHROME_CONFIG_DIR="$BRIDGE_DOCKER_HOME/config-race" BRIDGE_DATA_DIR="$BRIDGE_DOCKER_HOME/data-$r" "$HELPER" --staging down > /dev/null 2>&1; done

# ---- 10) teardown first, then: the Mac is exactly as it was --------------------
if [ "${KEEP:-0}" != 1 ]; then
  teardown; TEARDOWN_RC=$?
  check "teardown: Docker confirms no container of this run, no files, both ports released" '[ "$TEARDOWN_RC" = 0 ] && LEFT="$(leftovers)" && [ -z "$LEFT" ] && [ ! -e "$BRIDGE_DOCKER_HOME" ] && ! nc -z -w 1 127.0.0.1 "$BRIDGE_PUBLISH_PORT" && ! nc -z -w 1 127.0.0.1 "$SCREEN_PUBLISH_PORT"'
else
  teardown
fi
HOST_AFTER="$(host_identity)"; HOSTP_AFTER="$(host_processes)"
echo "host relay after:  $HOST_AFTER"
echo "host processes after:  $HOSTP_AFTER"
if [ "$HOST_BEFORE" = "$HOST_AFTER" ]; then pass "the host relay is untouched (same serverId / extGen / accessGen / session / pid)"; else fail "the host relay changed: '$HOST_BEFORE' -> '$HOST_AFTER'"; fi
if [ "$HOSTP_BEFORE" = "$HOSTP_AFTER" ]; then pass "the Mac's Chrome and the watched launchd jobs have the same pids"; else fail "host processes changed: '$HOSTP_BEFORE' -> '$HOSTP_AFTER'"; fi

if [ "$failures" = 0 ]; then echo; echo "SMOKE OK"; else echo; echo "SMOKE FAILED: $failures"; fi
exit $(( failures > 0 ))
