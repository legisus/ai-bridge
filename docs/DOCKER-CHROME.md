# Chrome in Docker (macOS, Colima)

One container with **Google Chrome**, the AI Browser Bridge extension and the relay.
The jobs and the CLI stay on the Mac and reach the relay through a loopback port; the
Mac's own Chrome is no longer driven by anything. Design:
`docs/superpowers/specs/2026-11-26-docker-chrome-design.md`.

This is the opposite of `docs/DOCKER.md` (agent in the container, Chrome on the host).
Use this one when the browser itself should be a separate thing: its own sessions, its
own screen that a job may take over at any time.

```
Mac                                              container  ai-bridge-chrome
 jobs, bots, `bridge` CLI ── ws 127.0.0.1:8765 ──▶ relay (server.js)
 browser tab http://127.0.0.1:3000 ◀── screen ───  Google Chrome + extension
 ~/docker/ai-bridge-chrome/config   = /config      (Chrome profile, logs)
 ~/.ai-browser-bridge               = /data        (token, traces, journal, tabs.json)
 ~/Downloads                        = /config/Downloads
```

## What is in the image

- Base `ghcr.io/linuxserver/baseimage-selkies` (web screen, Wayland compositor, s6),
  pinned by digest. It ships **no browser**. It is the parent of `linuxserver/chromium`;
  building on the parent is how the image contains no Chromium. The build fails if a
  Chromium package or any second browser executable is present.
- Google Chrome stable from Google's `.deb` (arm64 on Apple silicon). The installed
  version and the package's sha256 are recorded in the image
  (`/opt/ai-bridge/CHROME_VERSION`, `CHROME_DEB_SHA256`) and printed by the build. Chrome
  is updated by rebuilding, never inside a running container. To pin a package:
  `bridge-docker build --build-arg CHROME_DEB_URL=… --build-arg CHROME_DEB_SHA256=…`.
- Node 22, this repository's `server/` and `extension/` under `/opt/ai-bridge`. Relay and
  extension always come from the same commit; the image label
  `org.opencontainers.image.revision` names it (`-dirty` when the sources differed).

## Chrome flags

`chrome-start.sh` starts Chrome with an explicit profile directory (`/config/profile`),
the debug port on the container's loopback (`--remote-debugging-port=9222`, never
published), `--enable-unsafe-extension-debugging` (needed to load the extension), the
three anti-throttle flags, `--password-store=basic`, Wayland, `--no-first-run`,
`--start-maximized`.

Not passed, on purpose: `--no-sandbox`, `--test-type`, `--headless`, fake-update flags.
Chrome's own sandbox runs; the container has `seccomp=unconfined` for the user
namespaces it needs. `chrome://sandbox` reports "adequately sandboxed" (the smoke job
checks it).

`--password-store=basic` must stay: with it Chrome encrypts cookies with a fixed key, so
the profile directory can be copied or restored and stays logged in.

## Provisioning (every Chrome start)

Branded Chrome no longer has `--load-extension`. The extension is loaded over the
DevTools protocol, and an extension loaded that way is **not recorded in the profile**:
after a Chrome restart it is gone. Its id and its `chrome.storage` come back when it is
loaded again; its toggles do not. So `provision.py` runs after every Chrome start (and by
hand: `bridge-docker provision`):

0. Developer mode on (a profile setting; without it Chrome disables unpacked extensions).
1. Load the extension — skipped when it is already loaded and enabled, because loading
   it again is a reload and the worker would lose which tabs it owns.
2. "Allow in incognito" and "Allow User Scripts" on (only clicked when off).
3. `chrome.storage.local`: the relay token from `/data/token`, port 8765, session name
   `docker-chrome` (only written when different).
4. Wait until the relay reports `session docker-chrome`, `access granted` (auto-grant
   grants by itself). Non-zero exit after 60 s; the start loop retries every 15 s.

The token is never printed.

## Requirements

- Colima + the Docker CLI + the compose plugin. Sizing used here: 4 CPU / 6 GB
  (`colima stop && colima start --cpu 4 --memory 6`), started at login by
  `brew services start colima`.
- **Every mount must be under `$HOME`.** Colima shares only the home directory; a bind
  mount from anywhere else silently becomes a folder inside the VM (the 2026-11-26 spike
  lost its profile to that). `bridge-docker` refuses such a path.
- The VM's Docker disk is 20 GB by default. The image is about 5 GB. If it fills up:
  `colima stop && colima start --disk 40` (Colima grows a disk, it never shrinks one).

## Commands

```
bin/bridge-docker [--staging] build | up | down [--force] | status | restart-chrome | provision | screen | logs [chrome] | cli <args…> | env
```

| | production (default) | `--staging` |
|---|---|---|
| relay port | `127.0.0.1:8765` | `127.0.0.1:8766` |
| state (`/data`) | `~/.ai-browser-bridge` | `~/docker/ai-bridge-chrome/staging-data` |
| downloads | `~/Downloads` | `~/docker/ai-bridge-chrome/staging-downloads` |
| Chrome profile | `~/docker/ai-bridge-chrome/config` | the same directory |
| screen | `http://127.0.0.1:3000` | the same port |

Production is the layout every job already uses (default port, default token file), so
nothing in the jobs changes. It cannot start while a host relay owns port 8765 or
`~/.ai-browser-bridge`: `up` refuses.

Staging runs next to a live host relay, with its own token and state, on the **same
Chrome profile** — logins made in staging are the production logins. Use the CLI through
the helper (`bridge-docker --staging cli ping`) or set
`AI_BRIDGE_HOME=~/docker/ai-bridge-chrome/staging-data BRIDGE_PORT=8766`.

Staging and production never run at the same time: the profile belongs to one Chrome.
Three things enforce it.

- `up` compares physical paths (symlinks, `..`, trailing slashes resolved) and refuses
  while any **other** container, running or stopped, mounts the profile directory or the
  state directory. The project's own container is not "another" one, whatever its state:
  after a stop, a failed start or a Docker restart, `up` starts it again. If Docker
  cannot list the containers, `up` starts nothing.
- `up` is serialized on the Mac: the checks and the creation run under a lock held by
  the operating system (`lockf`; `flock` on Linux). The lock ends with the process that
  holds it, however that process dies, so there is no stale lock to clean up.
- Chrome holds a lock file on the profile volume for as long as **the browser process**
  lives — not just its start loop. A container started around the helper does not start
  a second Chrome on the profile, also when the first container's loop has died and only
  its Chrome is left. A loop that does not get the lock waits for it.

`up` also refuses:

- a mount whose physical path is outside `$HOME`;
- a state directory that is not mode 700, or a token that is not this user's, mode 600
  (refused, never repaired);
- a state directory that a relay **on the host** works in. Which directory that is, is
  read from the relay process itself (`AI_BRIDGE_HOME` in its environment, else
  `~/.ai-browser-bridge` of its home), under any spelling of the path. A host relay on a
  different directory does not block `up` (variant B below); when a relay's environment
  cannot be read, it is taken to own `~/.ai-browser-bridge`;
- a port that something else holds. Whether a port is the project's own is asked from
  Docker (`docker port`), not assumed: a stopped container of ours holds none.

### Stopping Chrome: clean, forced, failed

Chrome commits cookies on a ~30 s timer, and a SIGTERM exits without the final commit
(measured here: a cookie set seconds before a SIGTERM was gone after the restart). The
only stop after which the cookie store is on disk is a DevTools `Browser.close`, the same
as Chrome's own Quit. So every stop the helper makes goes through
`deploy/docker-chrome/chrome-stop.sh`, which reports **how** Chrome stopped:

| | what happened | `down` | `restart-chrome` | `up` that replaces the container |
|---|---|---|---|---|
| clean | `Browser.close` taken, browser process gone | removes the container, exit 0 | exit 0 | replaces it |
| forced | `Browser.close` did not work; SIGTERM to the browser process, gone | removes it, **warning, exit 3** | **warning, exit 3** | replaces it, **warning** |
| failed | Chrome is still running | **keeps the container, exit 1** (`down --force` removes it anyway: warning, exit 3) | exit 1 | **refuses, nothing is replaced** |

`up` replaces the container when the image was rebuilt or a setting changed (the image id
and Compose's own hash of the settings are compared with the running container). Compose
alone would stop the old container with a SIGTERM; the helper closes Chrome first and
only then lets Compose recreate it. With nothing changed, `up` leaves the running
container and its Chrome alone. So the update path is `bridge-docker build`, then
`bridge-docker up`.

The container has `restart: unless-stopped`: it comes back with Docker. After `down` it
stays down.

## The screen

`bridge-docker screen` opens `http://127.0.0.1:3000`: the container's desktop with
Chrome, for logging in when a session expires, watching a job, solving a captcha.
Loopback only, no password by default (`CUSTOM_USER` / `PASSWORD` in the environment
turn the base image's login on).

## Incognito windows

`bridge newTab '{"url":"…","incognito":true}'` opens the URL in an incognito window of
its own and returns `{"id", "windowId", "newWindow": true, "incognito": true}`
(`incognito` or `newWindow` together with `windowId` is refused: a window of its own is a
new window). The tab is
an agent tab like any other (`listTabs` marks it `"incognito": true`, `closeTab` /
`closeTabs` and run cleanup close it). It needs "Allow in incognito" on the extension —
provisioning turns it on in the container; on a Chrome without it the command is refused
before anything opens.

Know this about incognito: **all open incognito windows share one session**, and it ends
only when the last of them is closed. A caller that needs a clean session must check
that no incognito tab is open before it starts, and must close its own when done.

While the extension can see incognito windows, a `newTab` that did not ask for incognito
always goes to a regular window (never "the current window", which might be an incognito
one). With the toggle off — the default, and the state of a Chrome on the host — nothing
about `newTab` changes.

## Switch-over (one time, run by the operator)

Until this is done the container runs in staging next to the untouched host layout.
Order matters: the host relay and the Mac extension must be out of the way **before**
the container takes port 8765, or the Mac extension would connect to the container's
relay and supersede the container's Chrome (the relay serves one extension).

**Before:** the `docker-chrome` work is merged and pulled into `~/IdeaProjects/ai-bridge`,
`bin/bridge-docker build` has been run from there, `ln -sf
~/IdeaProjects/ai-bridge/bin/bridge-docker ~/bin/bridge-docker`. The co-host bot's
bridge-transport change is merged and pulled.

**The layout (decided): variant A — everything into the container.** The Mac extension
is switched off; `bridge …` from any session, and every job, drives the Docker Chrome.
The Mac's Chrome is never driven by the bridge, and there is no second relay on the Mac.
The steps below are variant A.

Variant B is kept here as an alternative that was **not built and not tested**: a second
relay on the Mac for ad-hoc work. The Mac extension stays but moves off port 8765 to its
own relay (`AI_BRIDGE_HOME=~/.ai-browser-bridge-mac BRIDGE_PORT=8770 node
server/server.js`), with that relay's token and port 8770 pasted into the extension's
Options; sessions that want the Mac's Chrome set those two variables. The helper allows
it — a host relay that works in another state directory does not block production `up`
— but nothing else about it has been exercised. It differs from A in step 6 and in the
rollback.

The launchd jobs on this Mac that use the bridge (the "launchers" below):

```bash
BRIDGE_JOBS="com.turo.cohost com.turo.fleetstats.snapshot com.turo.fleetstats.citations com.turo.fleetstats.weekly com.citation-watch.daily com.loan-watch.manual com.recall-parts-watch"
PAUSED=~/docker/ai-bridge-chrome/paused-jobs.txt        # label + plist path of every job this procedure paused
```

1. **Drain.** No bridge job running, and the bot idle:
   ```bash
   pgrep -fl "server/cli.js" ; bridge tabs                       # no agent run, no leftover agent tabs
   tail -n 400 ~/IdeaProjects/turo-cohost-assistant/logs/agent.log | grep 'event:' | tail -n 1
   #   ^ the newest event line must be more than 5 minutes old
   python3 - <<'EOF'
   import json, os
   s = json.load(open(os.path.expanduser("~/IdeaProjects/turo-cohost-assistant/state.json")))
   open_ = [k for k in ("compose", "citation", "citation_scan", "maint", "gps", "carwash") if s.get(k)]
   print("open sessions:", open_ or "none")                       # must print: none
   EOF
   ```
   If something is running, wait for it. Do not go on from an observation alone: an idle
   moment says nothing about the next minute, which is what step 2 is for.
2. **Pause the launchers, and write down which ones.** Only jobs that are loaded now
   are paused, and exactly those are resumed later. `disable` keeps a job off across a
   logout or reboot in the middle of the migration; `bootout` unloads it now.
   ```bash
   [ ! -s "$PAUSED" ] || echo "STOP: $PAUSED already lists paused jobs — resume or review them first"
   : > "$PAUSED"
   for l in $BRIDGE_JOBS; do
     plist="$(launchctl print "gui/$(id -u)/$l" 2>/dev/null | awk '$1 == "path" { print $3; exit }')"
     [ -n "$plist" ] || { echo "not loaded, left alone: $l"; continue; }
     echo "$l $plist" >> "$PAUSED"
     launchctl disable "gui/$(id -u)/$l"
     launchctl bootout "gui/$(id -u)/$l"
   done
   cat "$PAUSED"
   ```
3. **Now it is quiet, and stays quiet.** Nothing may be loaded, nothing may be running:
   ```bash
   while read -r l _; do launchctl print "gui/$(id -u)/$l" > /dev/null 2>&1 && echo "STILL LOADED: $l"; done < "$PAUSED"
   pgrep -fl "server/cli.js|fleetstats|turo-cohost" ; bridge tabs    # no output from pgrep, no agent tabs
   ```
   Any `STILL LOADED` line or any process: stop here and clear it first.
4. **Write down how the Mac extension is provisioned** (for the rollback). In the Mac
   Chrome: AI Browser Bridge → Options → the port, and whether **Manual mode** is ticked.
   The original setup on this Mac is: port 8765, Manual mode **off**, "token received from
   the native host".
   ```bash
   echo "# mac-extension: port 8765, manual mode OFF (native host)" >> "$PAUSED"     # write what Options really shows
   ```
5. **Release the profile:** `bridge-docker --staging down` (it must exit 0: Chrome closed
   cleanly; see "Stopping Chrome").
6. **Host relay off.** On this Mac the relay on 8765 is started by the native messaging
   host, not by the launchd job (which exits 1), so all three:
   ```bash
   launchctl bootout gui/$(id -u)/com.ai-bridge.server
   mv ~/Library/LaunchAgents/com.ai-bridge.server.plist ~/Library/LaunchAgents/com.ai-bridge.server.plist.bak
   (cd ~/IdeaProjects/ai-bridge && npm run register-host -- --unregister)
   kill $(lsof -nP -iTCP:8765 -sTCP:LISTEN -t)
   lsof -nP -iTCP:8765 -sTCP:LISTEN || echo "8765 is free"
   ```
   **Mac extension off.** `chrome://extensions` in the Mac Chrome's Default profile → AI
   Browser Bridge → switch it **off** (do not remove it and do not change its Options:
   the rollback switches it on again as it is). Nothing on the Mac may reconnect to 8765.
   (Variant B instead: point the extension at the second relay; its popup must not say
   "connected" to 8765.)
7. **Production up:** `bridge-docker up`, then `bridge ping` must show
   `"session":"docker-chrome","access":"granted"` and `bridge-docker status` must be green.
   If macOS asks whether Colima may access the Downloads folder, allow it (or set
   `CHROME_DOWNLOADS_DIR` to another folder under `$HOME`).
8. **Logins.** `bridge-docker screen`; whatever shows a login page is logged in once, by
   hand: Turo (the operator's account), Upcar, The Toll Roads, Mister Car Wash (Default account), Google;
   Wheelbase, Roamly, LinkedIn, lender portals on first use.
9. **Verify, with the launchers still paused.** Set `"transport": "bridge"` in
   `~/IdeaProjects/turo-cohost-assistant/config.json` (the bot is not running; it reads
   this when it is resumed). Then, once by hand: `fleetstats` snapshot, `fleetstats
   citations --no-telegram`, the toll-roads recipe, the car-wash recipe, one Upcar sync.
   A job that stops at a login wall is cleared on the screen. If this does not come out
   right, do not resume: fix it, or roll back.
10. **Resume the launchers** — exactly the recorded ones, only now:
    ```bash
    grep -v '^#' "$PAUSED" | while read -r l plist; do
      launchctl enable "gui/$(id -u)/$l"
      launchctl bootstrap "gui/$(id -u)" "$plist"
    done
    grep -v '^#' "$PAUSED" | while read -r l _; do launchctl print "gui/$(id -u)/$l" > /dev/null 2>&1 || echo "NOT LOADED: $l"; done
    mv "$PAUSED" "$PAUSED.done-$(date +%Y%m%d-%H%M)"
    ```
    The bot starts at once (watch `logs/agent.log`, send `/check` from Telegram); the
    calendar jobs wait for their next time.

Not touched by any of this: the second host account's Turo work (AppleScript into the Mac Chrome's
Profile 4) and the iPhone-mirroring door control.

### Rollback

The same discipline in the other direction: launchers paused first, the old layout
restored **and verified**, launchers resumed last.

1. **Drain and pause.** Steps 1–3 of the switch-over, unchanged (drain check, pause and
   record into `$PAUSED`, confirm that nothing is loaded or running). If the switch-over
   stopped half-way, `$PAUSED` still lists the jobs and they are still paused: keep the
   file as it is and go on.
2. **Bot back to its old transport**, while it is not running: `"transport":
   "osascript"` in `config.json`. (Its AppleScript path needs the Mac Chrome with the Turo
   inbox window: `bash scripts/launch_agent_chrome.sh`.)
3. **Release the port:** `bridge-docker down` (exit 0 = Chrome closed cleanly; exit 3 =
   it had to be terminated, the last ~30 s of cookie changes in the Docker profile may be
   missing; exit 1 = nothing was removed, look at `bridge-docker logs chrome`).
   `lsof -nP -iTCP:8765 -sTCP:LISTEN` shows nothing.
4. **Host layout back, as it was:**
   ```bash
   (cd ~/IdeaProjects/ai-bridge && npm run register-host)
   mv ~/Library/LaunchAgents/com.ai-bridge.server.plist.bak ~/Library/LaunchAgents/com.ai-bridge.server.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ai-bridge.server.plist
   ```
   then switch the AI Browser Bridge extension **on** again in the Mac Chrome.
5. **Restore the recorded provisioning mode — explicitly.** Open the extension's Options
   and make it what step 4 of the switch-over wrote down. For the original setup of this
   Mac that is: port **8765** and **Manual mode off**. Manual mode off is required, not
   optional: while it is on, the extension never asks the native host
   (`provisionViaNativeHost()` returns at once), so it keeps whatever token it has and
   does not follow the host relay's token. A token pasted by hand makes one connection
   work and leaves native provisioning disabled — that is not the original layout.
   - Variant A never changed the Options, so this should already be the case; look anyway.
   - Variant B changed them (pasting a token switches Manual mode **on**): stop the second
     relay (port 8770), set the port back to 8765, untick Manual mode, Save. Do not paste
     the token from `~/.ai-browser-bridge/token`; with Manual mode off the native host
     delivers it.
   Options must then read "token received from the native host".
6. **Verify the restored layout**, launchers still paused: `bridge ping` shows
   `"session":"chrome"`, `"access":"granted"`; `bridge newTab '{"url":"https://example.com"}'`
   and `bridge closeTab` on the returned id work in the Mac Chrome; `lsof -nP
   -iTCP:8765 -sTCP:LISTEN` shows the host relay (node), not Docker. If not: stay paused
   and fix it.
7. **Resume the launchers** — step 10 of the switch-over, from the same record. Not
   before step 6 is green.
8. Optional: `bridge-docker --staging up` to keep the Docker Chrome's sessions warm.

## Backup of the logins

The sessions are the directory `~/docker/ai-bridge-chrome/config/profile`. With the
container down (`bridge-docker down`), copy it; to restore, copy it back. Do not copy it
while Chrome runs.

## Troubleshooting

| Symptom | Look at |
|---|---|
| `up` says not ready | `bridge-docker logs chrome` (the loop's log: Chrome starts, provisioning lines), `bridge-docker logs` |
| `extension not connected` | Chrome is restarting or provisioning failed: `bridge-docker provision` prints which step |
| `User Scripts API is not enabled` | the toggle is off: `bridge-docker provision` |
| `incognito not allowed` | same: `bridge-docker provision` |
| a job sees a login page | `bridge-docker screen`, log in; cookies stay in the profile |
| Chrome hangs | `bridge-docker restart-chrome`, then `status` |
| `restart-chrome` / `down` exits 3 | Chrome did not take `Browser.close` and was terminated; done, but the last ~30 s of cookie changes may be missing |
| `down` exits 1, "NOT removed" | Chrome could not be stopped: `bridge-docker logs chrome`; `down --force` removes the container anyway |
| `up` says "could not be stopped … NOT replaced" | the same, before a replacement: the old container is still there and running |
| container gone after a reboot | `colima status`; `brew services list \| grep colima`; `bridge-docker up` |
| container stopped (exited) | `bridge-docker up` starts the project's own stopped container again |
| `up` refuses: profile belongs to another container | the other mode is still there: `bridge-docker [--staging] down` |
| `up` refuses: port 8765 held | the host relay still runs: switch-over step 6, or use `--staging` |
| `up` refuses: a host relay is running on … | a relay on the Mac works in that state directory (the message names its pid): stop it, or use another directory |
| Chrome loop log: "profile … is in use … waiting" | another container's Chrome (or a Chrome whose loop died) has the profile; this one starts when that browser is gone |

## Tests

- `npm test` includes `test/docker-chrome.files.test.js` and the incognito cases in
  `test/extension.worker.test.js`. The files test is a **structural** check: it matches
  text in the Dockerfile, the start script, the compose file and the helper (a flag is
  absent, a bound is written down, a guard exists). It does not prove behaviour.
- `npm run test:docker-chrome` adds, without Docker:
  - `test/docker-chrome.provision.test.py` — provisioning decisions against a fake
    DevTools endpoint, including a connection that dies and stays dead (the temporary tab
    is closed over a fresh connection; if that is impossible too, it is reported);
    needs `python3`.
  - `test/docker-chrome.helper.test.sh` — `bin/bridge-docker` against a stand-in `docker`
    (`test/helpers/fake-docker`): a host relay on the same state directory is refused and
    one on another directory is not; the project's own stopped container is recovered;
    ports; four simultaneous `up`s with a dead holder's lock in place; Chrome is stopped
    before a replacement; failed and forced stops and their exit statuses; and the smoke
    job's teardown when Docker cannot list containers (files kept, teardown fails).
- `bash test/docker-chrome-loop.sh` (needs Docker and the built image; about two
  minutes; one-off containers, nothing published, a stand-in browser): the Chrome loop
  and the stop script as processes. The browser keeps the profile lock when its loop is
  killed, and a second loop stays off the profile until that browser is gone; a stop
  that arrives during provisioning ends the loop within its bound, leaves no provisioning
  process and closes the browser with `Browser.close`; `chrome-stop.sh` returns 0 / 3 / 1
  for a clean / forced / failed stop and leaves the loop running after a failed one.
- `bash test/docker-chrome-smoke.sh` (needs Docker and network; several minutes): builds
  the image and runs a throwaway instance with an empty profile on free ports. It runs
  the loop test above and asserts:
  no Chromium package, binary or directory and no second browser executable in the image;
  the package is Google's `google-chrome-stable`; relay up as the Mac user, token 0600;
  the running executable is `/opt/google/chrome/chrome` without `--no-sandbox`; the real
  Chrome process holds the profile lock;
  `chrome://sandbox` adequate; the debug port on the container's loopback only and
  unpublished; the screen answers; `newTab` / stealth `eval` / `selectTab` + `screenshot`
  / `download` / incognito open-eval-list-close / `closeTab`; a provisioning run by hand
  changes nothing; after a Chrome restart **and after a container restart** everything
  works again, the relay's registry has a fresh browser session and no ownership is
  carried over, and the profile kept its cookie and localStorage; `down` + `up` and an
  `up` with **another image** each keep a cookie set immediately before (Chrome is closed
  cleanly before the container is replaced); and that a live host relay has the same
  `serverId`, `extGen`, `accessGen` and pid before and after.
  It also runs the Chrome loop against a stand-in browser that never opens its debug
  port, tries the refusals (same profile under three spellings, same state directory, the
  host relay's state directory, a mount outside `$HOME`, a world-readable state
  directory, two `up`s at once, a second container on the profile volume — also after the
  first container's loop was killed and only its Chrome is left) and compares the Mac
  after its own teardown: host relay identity, the Mac Chrome's pid, and the pids of the
  launchd jobs named in `HOST_WATCH_LABELS`. The teardown deletes the run's directories
  only after Docker has confirmed that the run's containers are gone.
  It never uses port 8765 or the real profile, and never writes to `~/.ai-browser-bridge`.
  Not covered: that the web screen shows Chrome and takes input — the job only checks that
  the screen's page is served; look at `bridge-docker screen` once by eye.

## Limits

- One Chrome profile, one extension, one relay. A second profile needs a multi-session
  relay (not built).
- The debug port stays open inside the container (loopback). Anything running inside the
  container can drive Chrome; the boundary is the container.
- Any stop that is not made by the helper (`down`, `restart-chrome`, an `up` that
  replaces the container) — `docker stop`, `docker compose up` by hand, a Docker or VM
  restart, a reboot, power loss — can lose the cookie changes of the last ~30 seconds.
  Logins older than that are on disk. Before a planned reboot: `bridge-docker down`.
- A Chrome whose start loop has died keeps running and keeps the profile, but nothing
  restarts it when it exits. `bridge-docker down` closes it cleanly; `up` starts afresh.
- Sites see `Linux x86_64` in the user agent and the brands `Google Chrome` / `Chromium`
  (every Chrome reports both).
