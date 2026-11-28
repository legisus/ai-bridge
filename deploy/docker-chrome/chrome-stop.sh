#!/bin/sh
# Stop Chrome inside the container and say HOW it stopped. Run by bin/bridge-docker
# through `docker exec -i … sh -s -- <mode>` (the script comes from the helper's own
# clone, so it also works against a container built from an older image).
#
#   mode chrome : close Chrome only; the start loop brings it back and re-provisions
#   mode loop   : close Chrome AND end the start loop (nothing starts another Chrome)
#
# Exit status — the caller must tell these apart:
#   0  verified clean: Chrome took a DevTools Browser.close and its process is gone
#      (the only stop after which the cookie store is written out), or no browser
#      was running
#   3  forced: Browser.close did not close it; the browser process was sent SIGTERM
#      and is gone. Cookie changes of the last ~30 s may be lost.
#   1  failed: Chrome is still running (or the start loop did not end). Nothing
#      else was changed: a loop that was held is running again.
mode="${1:-chrome}"
browser="$(cat /tmp/chrome.pid 2>/dev/null)"
loop="$(cat /tmp/chrome-start.pid 2>/dev/null)"

# A pid file can outlive its process (a container restart keeps /tmp), and the
# number may belong to something else by now: a pid counts only together with
# its command line. (A zombie has an empty one, so it counts as gone.)
alive_as() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null && tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -q -- "$2"; }
is_browser() { alive_as "$browser" '--remote-debugging-port='; }
is_loop() { alive_as "$loop" 'chrome-start'; }
wait_gone() { # $1 test, $2 quarter-seconds
  n="$2"
  while [ "$n" -gt 0 ]; do "$1" || return 0; sleep 0.25; n=$((n - 1)); done
  ! "$1"
}

# mode loop: hold the loop still while Chrome is closed, so that it cannot start
# a new Chrome in between; it is told to end (and released) once Chrome is gone.
held=no
release() { [ "$held" = yes ] && kill -CONT "$loop" 2>/dev/null; held=no; }
trap release EXIT
trap 'exit 1' INT TERM HUP
if [ "$mode" = loop ] && is_loop; then kill -STOP "$loop" 2>/dev/null && held=yes; fi

result=0
if is_browser; then
  if timeout -k 2 15 /lsiopy/bin/python3 -I /usr/local/bin/provision.py --quit && wait_gone is_browser 80; then
    echo "chrome-stop: Chrome closed cleanly (Browser.close; the cookie store is written out)"
  else
    echo "chrome-stop: Browser.close did not close Chrome; sending SIGTERM to the browser process" >&2
    kill -TERM "$browser" 2>/dev/null
    if wait_gone is_browser 60; then
      echo "chrome-stop: FORCED: Chrome ended on SIGTERM; cookie changes of the last ~30 s may be lost" >&2
      result=3
    else
      echo "chrome-stop: FAILED: Chrome (pid $browser) is still running" >&2
      result=1
    fi
  fi
else
  echo "chrome-stop: no browser process is running"
fi

if [ "$mode" = loop ] && [ "$held" = yes ]; then
  if [ "$result" = 1 ]; then
    release                               # Chrome is still up: leave its loop as it was
  else
    kill -TERM "$loop" 2>/dev/null; release
    if ! wait_gone is_loop 160; then
      echo "chrome-stop: FAILED: the start loop (pid $loop) did not end" >&2
      result=1
    fi
  fi
fi
exit "$result"
