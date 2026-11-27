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
bin/bridge-docker [--staging] build | up | down | status | restart-chrome | provision | screen | logs [chrome] | cli <args…> | env
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
Three things enforce it. `up` compares physical paths (symlinks, `..`, trailing slashes
resolved) and refuses while any other container, running or stopped, mounts the profile
directory or the state directory; `up` is serialized on the Mac, so two starts cannot both
pass that check; and the Chrome loop holds a lock file on the profile volume itself, so
even a container started around the helper does not start a second Chrome on the profile.

`up` also refuses: a mount whose physical path is outside `$HOME`; a state directory that
is not mode 700 or a token that is not this user's, mode 600 (refused, never repaired);
`~/.ai-browser-bridge` under any spelling while a host relay runs.

`restart-chrome` and `down` close Chrome through DevTools (`Browser.close`, the same as
Chrome's own Quit). That is the only stop after which the cookie store is on disk: Chrome
commits cookies on a ~30 s timer and a SIGTERM exits without the final commit (measured
here: a cookie set seconds before a SIGTERM was gone after the restart).

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

**Decide first (operator):** where ad-hoc browser work from Claude sessions goes after
the switch.
- **A — everything into the container.** The Mac extension is removed; `bridge …` from
  any session drives the Docker Chrome. Simplest; the Mac's Chrome is never driven.
- **B — a second relay on the Mac for ad-hoc work** (the 2026-11-26 recommendation). The
  Mac extension stays but is moved off port 8765: its own relay
  (`AI_BRIDGE_HOME=~/.ai-browser-bridge-mac BRIDGE_PORT=8770 node server/server.js`), its
  own token, and port 8770 + that token pasted into the extension's Options. Sessions
  that want the Mac's Chrome set those two variables. Not built or tested here; step 4
  below is where it would happen.

1. **Quiet window.** No bridge job running, and the bot idle:
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
2. **Release the profile:** `bridge-docker --staging down`.
3. **Host relay off.** On this Mac the relay on 8765 is started by the native messaging
   host, not by the launchd job (which exits 1), so all three:
   ```bash
   launchctl bootout gui/$(id -u)/com.ai-bridge.server
   mv ~/Library/LaunchAgents/com.ai-bridge.server.plist ~/Library/LaunchAgents/com.ai-bridge.server.plist.bak
   (cd ~/IdeaProjects/ai-bridge && npm run register-host -- --unregister)
   kill $(lsof -nP -iTCP:8765 -sTCP:LISTEN -t)
   lsof -nP -iTCP:8765 -sTCP:LISTEN || echo "8765 is free"
   ```
4. **Mac extension off port 8765.** Variant A: `chrome://extensions` in the Mac Chrome's
   Default profile → AI Browser Bridge → off (or Remove). Variant B: point it at the
   second relay as described above. Either way, check that nothing on the Mac reconnects:
   the Mac extension's popup must not say "connected" to 8765.
5. **Production up:** `bridge-docker up`, then `bridge ping` must show
   `"session":"docker-chrome","access":"granted"` and `bridge-docker status` must be green.
   If macOS asks whether Colima may access the Downloads folder, allow it (or set
   `CHROME_DOWNLOADS_DIR` to another folder under `$HOME`).
6. **Logins.** `bridge-docker screen`; whatever shows a login page is logged in once, by
   hand: Turo (the operator's account), Upcar, The Toll Roads, Mister Car Wash (Default account), Google;
   Wheelbase, Roamly, LinkedIn, lender portals on first use.
7. **Co-host bot.** Repeat the idle check of step 1, then set `"transport": "bridge"` in
   `~/IdeaProjects/turo-cohost-assistant/config.json` and
   `launchctl kickstart -k gui/$(id -u)/com.turo.cohost`. Watch `logs/agent.log`; send
   `/check` from Telegram.
8. **Jobs, once by hand:** `fleetstats` snapshot, `fleetstats citations --no-telegram`, the
   toll-roads recipe, the car-wash recipe, one Upcar sync. A job that stops at a login
   wall is cleared on the screen.

Not touched by any of this: the second host account's Turo work (AppleScript into the Mac Chrome's
Profile 4) and the iPhone-mirroring door control.

### Rollback

1. Bot back first: idle check (step 1), `"transport": "osascript"` in `config.json`,
   `launchctl kickstart -k gui/$(id -u)/com.turo.cohost`. (Its AppleScript path needs the
   Mac Chrome with the Turo inbox window: `bash scripts/launch_agent_chrome.sh`.)
2. Release the port: `bridge-docker down`; `lsof -nP -iTCP:8765 -sTCP:LISTEN` shows nothing.
3. Host layout back, as it was:
   ```bash
   (cd ~/IdeaProjects/ai-bridge && npm run register-host)
   mv ~/Library/LaunchAgents/com.ai-bridge.server.plist.bak ~/Library/LaunchAgents/com.ai-bridge.server.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ai-bridge.server.plist
   ```
   then enable the AI Browser Bridge extension in the Mac Chrome again. The native host
   provisions it and starts the relay; `bridge ping` shows `"session":"chrome"`,
   `"access":"granted"`.
   Variant B only: pasting a token in Options had switched the extension to **Manual
   mode**, in which the native host no longer provisions it. Stop the second relay
   (port 8770), then in Options set the port back to 8765, paste the token from
   `~/.ai-browser-bridge/token` **or** turn Manual mode off so the native host fills it in
   again, and check `bridge ping` as above.
4. Keep the jobs paused until that ping is green; only then let them run again.
5. Optional: `bridge-docker --staging up` to keep the Docker Chrome's sessions warm.

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
| container gone after a reboot | `colima status`; `brew services list \| grep colima`; `bridge-docker up` |
| `up` refuses: profile belongs to another container | the other mode is still there: `bridge-docker [--staging] down` |
| `up` refuses: port 8765 held | the host relay still runs: switch-over step 3, or use `--staging` |

## Tests

- `npm test` includes `test/docker-chrome.files.test.js` (what the Dockerfile, the start
  script, the compose file and the helper must never say) and the incognito cases in
  `test/extension.worker.test.js`.
- `npm run test:docker-chrome` adds `test/docker-chrome.provision.test.py`
  (provisioning decisions against a fake DevTools endpoint; needs `python3`).
- `bash test/docker-chrome-smoke.sh` (needs Docker and network; several minutes): builds
  the image and runs a throwaway instance with an empty profile on free ports. It asserts:
  no Chromium package, binary or directory and no second browser executable in the image;
  the package is Google's `google-chrome-stable`; relay up as the Mac user, token 0600;
  the running executable is `/opt/google/chrome/chrome` without `--no-sandbox`;
  `chrome://sandbox` adequate; the debug port on the container's loopback only and
  unpublished; the screen answers; `newTab` / stealth `eval` / `selectTab` + `screenshot`
  / `download` / incognito open-eval-list-close / `closeTab`; a provisioning run by hand
  changes nothing; after a Chrome restart and after a container restart everything works
  again and the profile kept its cookie and localStorage; the two `up` guards; and that a
  live host relay has the same `serverId`, `extGen`, `accessGen` and pid before and after.
  It also runs the Chrome loop against a stand-in browser that never opens its debug
  port, restarts and recreates the container, tries the refusals (same profile under
  three spellings, same state directory, the host relay's state directory, a mount outside
  `$HOME`, a world-readable state directory, two `up`s at once, a second container on the
  profile volume) and compares the Mac after its own teardown: host relay identity, the
  Mac Chrome's pid, and the pids of the launchd jobs named in `HOST_WATCH_LABELS`.
  It never uses port 8765 or the real profile, and never writes to `~/.ai-browser-bridge`.
  Not covered: that the web screen shows Chrome and takes input — the job only checks that
  the screen's page is served; look at `bridge-docker screen` once by eye.

## Limits

- One Chrome profile, one extension, one relay. A second profile needs a multi-session
  relay (not built).
- The debug port stays open inside the container (loopback). Anything running inside the
  container can drive Chrome; the boundary is the container.
- Any stop that is not `bridge-docker down` / `restart-chrome` — `docker stop`, a Docker or
  VM restart, a reboot, power loss — can lose the cookie changes of the last ~30 seconds.
  Logins older than that are on disk. Before a planned reboot: `bridge-docker down`.
- Sites see `Linux x86_64` in the user agent and the brands `Google Chrome` / `Chromium`
  (every Chrome reports both).
