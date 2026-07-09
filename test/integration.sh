#!/usr/bin/env bash
# Live integration test for AI Browser Bridge.
# Requires: server running + extension loaded, provisioned, and connected.
# Exercises every command that replaces an AppleScript technique used in the
# original browser-automation session. Prints a PASS/FAIL table; exits non-zero
# on any failure. Runs in a throwaway background tab; does not touch your tabs.

set -u
CLI="$(cd "$(dirname "$0")/.." && pwd)/server/cli.js"
b() { node "$CLI" "$@" --timeout 10000; }
pass=0; fail=0
ok()   { echo "PASS  $1"; pass=$((pass+1)); }
bad()  { echo "FAIL  $1  -- $2"; fail=$((fail+1)); }
check(){ [ "$2" = "$3" ] && ok "$1" || bad "$1" "got:$2 want:$3"; }

echo "== AI Browser Bridge :: integration =="

# 0) health -------------------------------------------------------------
PONG=$(b ping | node -e 'process.stdin.on("data",d=>{try{console.log(JSON.parse(d).pong)}catch{console.log("ERR")}})')
check "ping (health)" "$PONG" "true"
[ "$PONG" = "true" ] || { echo "extension not connected — aborting"; exit 2; }

# 1) newTab (background) — replaces: make new tab/window ----------------
TID=$(b newTab '{"url":"about:blank"}' | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))')
[ -n "$TID" ] && ok "newTab (background about:blank) → id $TID" || { bad "newTab" "no id"; exit 2; }

# inject a self-contained fixture into the blank page via eval
cat > /tmp/fixture.js <<'EOF'
(function(){
  document.title = "BridgeTest";
  document.body.innerHTML =
    '<input id="in" value="">' +
    '<div id="editable" contenteditable="true"></div>' +
    '<button id="btn" style="position:fixed;left:50px;top:200px;width:120px;height:40px">Go</button>' +
    '<a id="dl" href="data:text/plain,bridge-download-ok" download="bridge-dl.txt">dl</a>';
  window.__clicked = false; window.__lastKey = "";
  document.getElementById("btn").addEventListener("click", function(){ window.__clicked = true; });
  document.addEventListener("keydown", function(e){ window.__lastKey = e.key; });
  return document.title;
})();
EOF
FTITLE=$(b eval "{\"tabId\":$TID}" --file /tmp/fixture.js | tr -d '"')
check "eval (inject fixture, read title)" "$FTITLE" "BridgeTest"

# 2) listTabs — replaces: list tabs / find by URL substring -------------
SEEN=$(b listTabs | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s);console.log(t.some(x=>x.id==='"$TID"')?"yes":"no")})')
check "listTabs (fixture tab present)" "$SEEN" "yes"

# 3) eval read — replaces: execute javascript to scrape ----------------
HASBTN=$(b eval "{\"tabId\":$TID,\"code\":\"!!document.getElementById('btn')\"}")
check "eval (DOM read/scrape)" "$HASBTN" "true"

# 4) insertText — replaces: trusted Cmd+V paste ------------------------
b eval "{\"tabId\":$TID,\"code\":\"document.getElementById('in').focus()\"}" >/dev/null
b insertText "{\"tabId\":$TID,\"text\":\"pasted-text\"}" >/dev/null
INVAL=$(b eval "{\"tabId\":$TID,\"code\":\"document.getElementById('in').value\"}" | tr -d '"')
check "insertText (trusted paste into input)" "$INVAL" "pasted-text"

# 5) click at coords — replaces: System Events trusted click -----------
XY=$(b eval "{\"tabId\":$TID,\"code\":\"(function(){var r=document.getElementById('btn').getBoundingClientRect();return Math.round(r.left+r.width/2)+','+Math.round(r.top+r.height/2)})()\"}" | tr -d '"')
CX="${XY%,*}"; CY="${XY#*,}"
b click "{\"tabId\":$TID,\"x\":$CX,\"y\":$CY}" >/dev/null
CLICKED=$(b eval "{\"tabId\":$TID,\"code\":\"window.__clicked\"}")
check "click (trusted click fires handler)" "$CLICKED" "true"

# 6) key — replaces: trusted keystroke (Enter/Cmd+A etc.) --------------
b eval "{\"tabId\":$TID,\"code\":\"document.getElementById('in').focus()\"}" >/dev/null
b key "{\"tabId\":$TID,\"key\":\"Enter\"}" >/dev/null
LASTKEY=$(b eval "{\"tabId\":$TID,\"code\":\"window.__lastKey\"}" | tr -d '"')
check "key (trusted keydown Enter)" "$LASTKEY" "Enter"

# 7) navigate — replaces: set URL of tab -------------------------------
b navigate "{\"tabId\":$TID,\"url\":\"https://example.com/\"}" >/dev/null
sleep 2
NAVHOST=$(b eval "{\"tabId\":$TID,\"code\":\"location.hostname\"}" | tr -d '"')
check "navigate (URL change)" "$NAVHOST" "example.com"

# 8) pdf — replaces: chrome --headless --print-to-pdf ------------------
b pdf "{\"tabId\":$TID}" --out /tmp/bridge-test.pdf >/dev/null
HEAD=$(head -c 4 /tmp/bridge-test.pdf 2>/dev/null)
check "pdf (print-to-PDF, %PDF header)" "$HEAD" "%PDF"

# 9) screenshot — replaces: screencapture -----------------------------
b screenshot "{\"tabId\":$TID}" --out /tmp/bridge-test.png >/dev/null
PNG=$(node -e 'const b=require("fs").readFileSync("/tmp/bridge-test.png");console.log(b[0]===0x89&&b[1]===0x50?"png":"no")' 2>/dev/null)
check "screenshot (PNG magic bytes)" "$PNG" "png"

# 10) download — replaces: fetch attachment → base64 → file ------------
rm -f ~/Downloads/bridge-dl*.txt 2>/dev/null
DL=$(b download '{"url":"data:text/plain,bridge-download-ok","filename":"bridge-dl.txt"}' | node -e 'process.stdin.on("data",d=>{try{console.log(JSON.parse(d).path?"ok":"no")}catch{console.log("no")}})')
check "download (authenticated download to disk)" "$DL" "ok"
rm -f ~/Downloads/bridge-dl*.txt 2>/dev/null

# 11) activateTab — replaces: activate / set index / focus window ------
ACT=$(b activateTab "{\"tabId\":$TID}" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).ok))')
check "activateTab (focus tab+window)" "$ACT" "true"

# 12) detach — replaces: (clear the debugger banner) -------------------
DET=$(b detach "{\"tabId\":$TID}" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).ok))')
check "detach (release debugger)" "$DET" "true"

# 13) closeTab — replaces: close tab/window ----------------------------
b closeTab "{\"tabId\":$TID}" >/dev/null
GONE=$(b listTabs | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s);console.log(t.some(x=>x.id==='"$TID"')?"still-there":"gone")})')
check "closeTab (tab removed)" "$GONE" "gone"

echo "----------------------------------------"
echo "RESULT: $pass passed, $fail failed"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
