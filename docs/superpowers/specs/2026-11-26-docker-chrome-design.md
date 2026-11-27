# Chrome in Docker on the Mac — isolated browser for every bridge job

**Status:** implemented on the `docker-chrome` branch, 2026-11-27 (image, provisioning,
`bin/bridge-docker`, incognito windows, smoke job; guide: `docs/DOCKER-CHROME.md`); running
in staging (port 8766) with the profile carried over from the spike. The one-time
switch-over is not done — it is the operator's. Where the build differs from this text,
the guide and "Implementation notes" at the end are right. Design of 2026-11-26, decided
with the operator after a two-step spike on this Mac (Colima, arm64). Companion to
`2026-11-21-docker-isolated-access-design.md`, which is the *opposite* layout (agent in
the container, Chrome on the PC); both stay valid, they serve different machines.

## Intent

The co-host bot and the other bridge jobs drive the operator's own Chrome. Most of the
time that is invisible, but some steps need the tab in the foreground (stealth
screenshots after `activateTab`, `--debugger` clicks, Gmail shots, citation payment
pages), and then the bot takes the operator's screen. The operator wants the bot's
browser to be a separate thing: its own Chrome, its own logged-in sessions, its own
screen the bot may take over at will, while the Mac's Chrome stays the operator's.

Why Docker and not a macOS VM: the operator asked for Docker. The spike showed it works
(see "What the spike proved"), so the VM alternative is not pursued.

## What the spike proved (2026-11-26, this Mac)

Real Google Chrome 158 (Google's arm64 Linux `.deb`) on Debian 13 inside Colima, driven
first over CDP and then over the ai-bridge extension + relay running in the same
container, with the CLI on the Mac:

- Turo login, inbox, trips, a reload, `/api/me`, `/api/v2/feeds/upcoming-trips`,
  `/api/v2/feeds/conversation`, `/api/reservation/detail`: no Cloudflare challenge.
- Chrome's own sandbox works in the container (`chrome://sandbox` says "adequately
  sandboxed"); the `--no-sandbox` flag the linuxserver base image uses is not needed.
- The user agent reports `Linux x86_64`; the arm64 build is not visible to sites.
- The relay (`fix/intent-gate-expiry` tip, `BRIDGE_BIND=0.0.0.0`) runs unchanged in the
  container; the Mac CLI on a published port did `newTab`, stealth `eval`, a same-origin
  `fetch`, `selectTab` + `screenshot`, `closeTab`. The Mac's own relay and extension were
  untouched meanwhile.
- `Extensions.loadUnpacked` over CDP (`--enable-unsafe-extension-debugging`) loads the
  extension with a stable id; `chrome.storage.local` can be provisioned from the service
  worker target; auto-grant then grants by itself. The "Allow User Scripts" toggle on the
  extension's details page can be flipped over CDP (click the inner `cr-toggle`).
- **A CDP-loaded extension is not recorded in the profile: it is gone after a Chrome
  restart.** Reloading it at the next start gives the same id and the storage (token,
  port, session name) is still there; only the User Scripts toggle is off again.
- Colima shares `$HOME` only. A bind mount from `/private/tmp/...` silently became a
  VM-local folder. Every volume in this design lives under the operator's home.

## Goals

1. Every bridge-backed job on this Mac (co-host bot, fleet-stats snapshot/weekly/
   citations, citation-watch, loan-watch, recall-parts-watch, ad-hoc `bridge agent`
   runs) drives the container's Chrome instead of the Mac's, **without code changes in
   the jobs**: same CLI path, same port 8765, same token file.
2. The Mac's Chrome is no longer driven by anything. The operator can keep working while
   a job takes screenshots, activates tabs, or attaches the debugger.
3. The operator can see and use the container's Chrome from a browser tab on the Mac
   (log in when a session expires, watch a job, solve a captcha).
4. The container comes back by itself after a reboot, a Chrome crash or a Colima restart,
   and re-provisions the extension every time Chrome starts.
5. The Turo co-host bot stays on the Mac exactly where it is (launchd, Telegram daemon,
   Ollama fallback, Fleet files, iPhone Mirroring door control) and only changes how it
   reaches Turo.

## Non-goals (v1)

- Moving the bot, the Telegram daemon or `bridge agent` into Docker. They stay on the Mac.
- The second host's Turo account. Its finance pulls keep using AppleScript into the Mac Chrome's
  Profile 4 (`scripts/agent/finance.py`) and are not touched.
- A second Chrome profile in the container, or several extensions on one relay.
- Running this on the Windows/Linux PC (that is the other design).
- Hardening the container against its own contents (the relay, Chrome and the screen
  server trust each other inside; the boundary is the container).
- The Chrome Web Store listing; the extension is loaded unpacked, as today.

## Anti-goals

- The Mac's Chrome extension staying active. With the shared token it would reconnect to
  the container relay and **supersede** the container's Chrome (one extension per relay).
  It must be removed or disabled as part of the switch.
- Any route that gets Turo to challenge the session: no headless, no `--test-type`, no
  `--no-sandbox`, no automation flags beyond the loopback debug port.
- Exposing the relay or the screen beyond the Mac's loopback.
- Losing the logged-in sessions on an image rebuild: the profile is a volume, never part
  of the image.

## Constraints

- Mac: Apple M4, 16 GB RAM, macOS 27.2. Docker = Colima 0.10 (`vz`, 2 CPU / 4 GB / 20 GB
  today) + Homebrew docker CLI + compose plugin. No Docker Desktop.
- Google Chrome arm64 `.deb` from `https://dl.google.com/linux/direct/google-chrome-stable_current_arm64.deb`
  (Chrome 158 at spike time). Chrome 136+ refuses `--remote-debugging-port` on the
  default profile directory, so the profile path must be explicit and non-default.
- `--load-extension` is gone from branded Chrome (137+); the only non-interactive way to
  load an unpacked extension is `Extensions.loadUnpacked` over CDP with
  `--enable-unsafe-extension-debugging`, and it does not persist (see above).
- The relay serves one extension at a time; the CLI connects to `127.0.0.1:${BRIDGE_PORT}`
  with the token from `${AI_BRIDGE_HOME:-~/.ai-browser-bridge}/token`.
- Jobs call `node ~/IdeaProjects/ai-bridge/server/cli.js` directly (co-host `bridge.py`,
  fleet-stats, citation-watch, loan-watch, recall-parts-watch) with default port and
  token path. `bridge agent`, recipes, journal, `jobs.json` live on the Mac under
  `~/.ai-browser-bridge` and stay there.
- The co-host driver `scripts/turo_chrome.py` already has a `bridge` transport
  (`config.json` `"transport"`, env `TURO_TRANSPORT`), selected by the four primitives
  `_find_tab / run_js / nav / _focus_tab`; everything above them is transport-agnostic.
- The second host account's Turo work and the iPhone-mirroring door control are AppleScript against the Mac
  and stay that way.

## Topology

```
Mac (this machine)                                   Colima VM → container  ai-bridge-chrome
┌──────────────────────────────────────────┐          ┌───────────────────────────────────────┐
│ co-host bot (launchd)  ─┐                │          │ Google Chrome (arm64), sandbox ON       │
│ fleet-stats, citation-, │ node cli.js ───┼─ ws ─────┼─▶ relay  server.js  BRIDGE_BIND=0.0.0.0 │
│ loan-, recall-watch     │ 127.0.0.1:8765 │ publish  │     ▲ ws 127.0.0.1:8765 (container)     │
│ bridge agent (claude/   ┘ token: ~/.ai-  │ 127.0.0.1│     └ AI Browser Bridge extension       │
│   codex on the Mac)      browser-bridge/ │  :8765   │        (loaded at every Chrome start)   │
│                                          │          │ Selkies web screen  :3000 ──────────────┼─▶ Mac browser tab
│ Mac Chrome: operator's own, no extension │          │ /config = profile + Downloads (volume)  │
│ 2nd-host finance: AppleScript → Profile 4│          │ /data   = relay log, tabs.json          │
└──────────────────────────────────────────┘          └───────────────────────────────────────┘
```

- One container, one Chrome profile (the operator's own identity), one extension, one
  relay. Port 8765 of the container is published on the Mac's loopback as 8765, so every
  job keeps its defaults.
- The Mac's host relay (`com.ai-bridge.server`) is stopped and unloaded; its plist is kept
  as `.bak` for rollback.
- The screen is Selkies (what the linuxserver base image ships) on the Mac's loopback
  port 3000. The operator opens `http://127.0.0.1:3000` in any Mac browser.

## The container

### Image

`deploy/docker-chrome/Dockerfile`, built on this Mac (arm64), pinned:

- Base: `lscr.io/linuxserver/chromium` pinned by digest (it brings Selkies, the Wayland
  compositor, s6 and the `/config` layout the spike ran on). Its Chromium is left
  installed but unused; removing it is the builder's call if image size matters.
- Add: Google Chrome stable from the arm64 `.deb` (download at build time; record the
  version in the image label), Node 22 (NodeSource), `procps`, Python `websocket-client`
  into the image's Python (`/lsiopy/bin/pip`) for the provisioning script.
- Copy the repo's `server/`, `package.json`, `package-lock.json`, `npm ci --omit=dev`
  into `/opt/ai-bridge`; copy `extension/` into `/opt/ai-bridge/extension` (the repo's
  `.dockerignore` excludes `extension`, so this Dockerfile needs its own ignore file or
  the extension is bind-mounted read-only from the clone; builder's call, the bind mount
  is what the spike used and keeps the extension in step with the clone).
- Replace `/usr/bin/wrapped-chromium` (what the base image's autostart runs) with
  `chrome-start.sh` below, and `/defaults/autostart` with a line that runs it.
- Add an s6 service (or a second autostart line) for the relay:
  `node /opt/ai-bridge/server/server.js` as the `abc` user with
  `AI_BRIDGE_HOME=/data BRIDGE_BIND=0.0.0.0 BRIDGE_PORT=8765 AI_BRIDGE_DEBUGGER=1`.
  The relay must be up before Chrome's extension connects; both retry, so order is a
  convenience, not a requirement.

### `chrome-start.sh` (runs in the Wayland session, as `abc`, forever)

```
loop:
  rm -f /config/profile/Singleton*            # stale lock after an unclean stop
  google-chrome-stable \
    --user-data-dir=/config/profile \         # explicit, non-default (debug port rule)
    --remote-debugging-port=9222 \            # container loopback only; never published
    --enable-unsafe-extension-debugging \
    --ozone-platform=wayland --password-store=basic --no-first-run --start-maximized \
    --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
    --disable-background-timer-throttling \
    https://turo.com/us/en/inbox/messages &
  wait for http://127.0.0.1:9222/json/version
  provision.py                                # below; idempotent
  wait for the chrome process; log the exit; sleep 3; repeat
```

No `--no-sandbox`, no `--test-type`, no `--simulate-outdated-no-au` (the base image's
flags). The profile path `/config/profile` is a volume.

### `provision.py` (every Chrome start; also runnable by hand)

1. `Extensions.loadUnpacked` with the extension path → id (stable for a fixed path).
2. Attach to the extension's service worker target and `chrome.storage.local.set`:
   `{ token, port: 8765, manualMode: true, provisionedBy: "manual", session: "docker-chrome" }`.
   `allowlist` is left as it is (empty = every host, same as the Mac today).
   `token` is read from `/data/token`.
3. Open `chrome://extensions/?id=<id>` in a new target, flip **Allow User Scripts** on
   (`extensions-manager → extensions-detail-view → #allow-user-scripts → cr-toggle`,
   click only when off) and, for the incognito addition below, **Allow in incognito**
   (`#allow-incognito`). Close the target.
4. Poll the relay's `status` until `access: granted` and `session: docker-chrome`
   (auto-grant is on by default; the spike saw the grant within seconds). Exit non-zero
   after 60 s so the start script logs it and the next loop retries.

Steps 2–3 are idempotent: storage set with the same values is a no-op for the worker's
`onChanged` reconnect path, and the toggles are only clicked when off.

### State directory and token (my call, after the builder check)

`/data` **is** the Mac's `~/.ai-browser-bridge`, bind-mounted read-write, not a separate
directory. Reason: the relay writes the run journal and the per-run traces
(`server/server.js` `finish()` → `appendTrace`, run manager `patchJournal`) that the
Mac-side `bridge agent` and `bridge recipe propose` read back for economy-mode repair and
learning; `bridge tabs` / `closeTabs` read `tabs.json` the same way. A separate directory
would silently stop economy mode (toll-roads-pull and mcw-memberships-pull are in it
today). The token is therefore shared with no extra mount; `ensureToken()` only reads an
existing file. The container runs as the Mac user's ids, `PUID=501 PGID=20`, so the
mode-700 directory and anything Chrome writes to `~/Downloads` keep the right owner.

### Volumes (all under `$HOME`, see the Colima constraint)

| Container path | Mac path | Holds |
|---|---|---|
| `/config` | `~/docker/ai-bridge-chrome/config` | Chrome profile (`/config/profile`), Selkies state, Chrome logs |
| `/config/Downloads` | `~/Downloads` | bridge `download` results land where the Mac jobs already look |
| `/data` | `~/.ai-browser-bridge` | token, relay log, `tabs.json`, journal, traces, recipes, `jobs.json` (shared with the Mac-side CLI/agent) |
| `/opt/ai-bridge/extension` (ro) | `~/IdeaProjects/ai-bridge/extension` | only if the builder picks the bind-mount option |

`PUID=501 PGID=20` (the Mac user; the base image creates `abc` with those ids). Builder
verifies ownership of a file Chrome writes to `~/Downloads` through the virtiofs share; no
current job reads `~/Downloads` or uses `download`, so this only has to work for ad-hoc use.

### Compose (`deploy/docker-chrome/compose.yml`)

- `ports: 127.0.0.1:8765:8765` and `127.0.0.1:3000:3000`. Nothing else published; 9222 is
  never published.
- `shm_size: 1g`, `security_opt: seccomp=unconfined` (Chrome's sandbox needs user
  namespaces; the base image documents this), `restart: unless-stopped`,
  `mem_limit: 3g`, `TZ=America/Los_Angeles`.
- Optional `CUSTOM_USER`/`PASSWORD` for the Selkies screen (base image feature); off by
  default because the port is loopback-only. Builder's call.
- Healthcheck: the relay port is listening (same check as the other Docker design). The
  "really healthy" signal is `bridge ping` showing `session: docker-chrome, access: granted`.

### Colima

Raise the VM to 4 CPU / 6 GB (`colima stop; colima start --cpu 4 --memory 6`); Chrome
with a dozen agent tabs plus the compositor is cramped in 4 GB. Colima starts at login via
`brew services start colima` so the container is back after a reboot without a hand.

## Mac side

### `bin/bridge-docker` helper (in the ai-bridge repo, symlinked into `~/bin`)

`up` (colima running → compose up -d → wait for `ping` to show `docker-chrome`), `down`,
`restart-chrome` (kills Chrome in the container; the loop restarts and re-provisions),
`provision` (re-runs `provision.py`), `screen` (opens `http://127.0.0.1:3000`), `logs`,
`status` (`bridge ping` + `docker ps` line + Chrome version).

### Switch-over (one-time, in this order)

1. Build the image, `bridge-docker up`. Confirm `ping` says `docker-chrome` / granted.
2. Log in once through the screen (the container's Chrome has no sessions until this is
   done; a job that hits a login wall stops there and the screen clears it):
   - Turo (the operator's account) — co-host bot, fleet-stats
   - Upcar host account — `agent/upcar.py` talks to the API with a ~60-day JWT from `~/.config/upcar.env`; when it expires the bot reads a fresh one from a logged-in upcar.ai tab's localStorage through the bridge, so the container's Chrome must hold the Upcar login
   - The Toll Roads — toll-roads-pull recipe (has a login hook, `~/bin/tollroads-login.sh`)
   - Mister Car Wash, Default account — mcw-memberships-pull recipe (the second account goes through incognito, logs in every run)
   - The operator's Google account — Gmail shots (`gmail_shot.py`) and the Gemini web prompt route (`gemini_web_prompt.py`, the only working Gemini access)
   - Wheelbase host and Roamly — ad-hoc runs the operator asks for; log in on first use
   - LinkedIn — ai-news publish (manual job); on first use
   - Lender portals (loan-watch, manual job) — on first use
   - KBB, citation portals, NHTSA/Mopar, court sites — no login
3. Stop the host relay. Today the relay on 8765 is spawned by the **native messaging
   host** (`server/native-host.js` `ensureServer()`), not by the launchd job (which exits
   1), so three things: `launchctl bootout gui/501/com.ai-bridge.server` and move the plist
   to `.bak`; `npm run register-host -- --unregister` so Chrome can never respawn a Mac
   relay on 8765 while the container is down; `kill` the running relay. Then the published
   container port takes over 8765. (Verified by the builder check, 2026-11-26.)
4. In the Mac Chrome, remove (or disable) the AI Browser Bridge extension from the
   Default profile. (Anti-goal above: it would supersede the container's extension.)
5. Co-host bot: `config.json` `"transport": "bridge"`, restart the daemon
   (`launchctl kickstart -k gui/501/com.turo.cohost`, after checking `agent.log` is idle).
6. Run the smoke list below.

### Rollback

Reverse: `transport` back to `osascript`, re-enable the extension, load the plist back,
`bridge-docker down`. Nothing in the jobs changed, so nothing else moves.

## Co-host bot changes (`~/IdeaProjects/turo-cohost-assistant`, its own PR)

| File | Change |
|---|---|
| `config.json` | `"transport": "bridge"` |
| `scripts/turo_agent.py` ~L605 | "no Turo tab → open one" uses `bridge.new_tab(inbox_url)` instead of AppleScript `make new window` |
| `scripts/agent/mcw.py` Profile 2 flow | The second account's reads move to an **incognito window through the bridge** (bridge addition below): open incognito on `/authentication/`, log in with `MCW_*` creds (always, incognito has no session), read the two sources, close the window. The Default-account read is already a bridge/economy job and is untouched. |
| `scripts/launch_agent_chrome.sh` | no longer part of the Turo path; keep only if something else needs the Mac Chrome flags (nothing known) — delete, mention in docs |
| `scripts/agent/doctor.py` | diagnostics text: replace the AppleScript probe advice with `bridge ping` / `bridge-docker status` / `bridge tabs` |
| `scripts/agent/chrome.py` | unchanged (subprocess wrapper over the driver) |
| `scripts/agent/finance.py` (second host) | **unchanged**, stays AppleScript into the Mac Chrome Profile 4 |
| `scripts/mirror_driver.py` | unchanged (iPhone Mirroring, not Chrome) |
| tests | `tests/test_transport*.py` cover the bridge branch of the four primitives; a test that `turo_agent` never shells out to `osascript` on the Turo path; `tests/test_mcw_*` for the incognito flow with the bridge stubbed |

Known behaviour differences the builder must keep: `_bridge_tab_id()` picks the inbox tab
by URL on every call; `stage_message` / `send_thread` already have bridge branches
(`stage` waits for the real `message-send` button; never Enter). Sends through the
container must keep the "already posted?" check before a retry.

## Bridge addition: incognito windows (my call; fallback below)

`newTab` gains `{"incognito": true}`: the extension does
`chrome.windows.create({ incognito: true, url })` and returns the tab id; the tab is
registered like any agent tab and closed by the run's tab hygiene. It requires the
extension's **Allow in incognito** toggle, which `provision.py` flips next to User
Scripts. `listTabs` shows incognito tabs with `"incognito": true`. One test in
`test/extension.worker.test.js` with the stub Chrome.

Why: the operator asked for the second car-wash account without a second profile, and
incognito gives a clean session that cannot collide with the Default account's cookies
(logging out of the Default account would also knock out the economy recipe's session).
Fallback if incognito turns out to be blocked by the site: log in / log out in a normal
tab and let the economy recipe's login hook re-login the Default account.

## Tests and the smoke list

- `test/docker-chrome-smoke.sh` (Mac, needs Colima): build → up → within 90 s `ping` shows
  `session docker-chrome`, `access granted`, Chrome version in `status` → `newTab`
  `https://example.com` → stealth `eval document.title` (proves User Scripts) →
  `selectTab` + `screenshot` → `download` of a small file lands in `~/Downloads` →
  `closeTab` → `bridge-docker restart-chrome` → within 60 s `ping` is green again with a
  higher `extGen` (proves re-provisioning).
- Turo check (needs the operator's login): `newTab` inbox → `eval` the conversation feed
  returns items → no challenge markers.
- Co-host: `pytest` green; one live `/check` from Telegram reads the inbox through the
  container; one approved send posts and the "already posted" guard still passes.
- Jobs: run `fleetstats` snapshot, `fleetstats citations --no-telegram`, the toll-roads
  economy recipe, the carwash recipe and one Upcar calendar sync once by hand; all five
  must pass without a login wall (or stop at a login wall the screen can clear).

## Later

- A second Chrome profile for the second host in the container (needs multi-session relay, #10 of the
  other design).
- Policy-installed extension (`ExtensionInstallForcelist` with a local update manifest,
  packed CRX with a key kept in `~/.ai-browser-bridge/extension-key.pem`) to drop the CDP
  port entirely. Not needed for Google: the operator signed into the Google account in the
  spike Chrome (debug port on) on 2026-11-26 with the normal device-tap challenge, and the
  Gmail inbox loads through the bridge afterwards. Stays "Later".
- `bridge-docker backup` of the profile volume (sessions survive a Colima disk reset).

## Open questions (builder decides unless marked)

- Extension in the image vs bind-mounted from the clone: bind mount keeps it in step with
  the relay code on the Mac; image copy makes the container self-contained. Either.
- Keep the base image's Chromium or `apt remove` it.
- Selkies password on or off.
- Before `up`: remove the spike container (`turo-spike`, holds port 3000) and its images
  (~15 GB on the 20 GB Colima disk); first `docker cp` its `/config/profile-cdp` out into
  the real profile volume so the logins done in the spike carry over.
- **Operator:** see the switch-over question in the conversation of 2026-11-26 (whether
  the ad-hoc Claude-session browser work moves into the container too, or a second Mac
  relay stays for it). The answer is recorded in the "Non-goals" / "Switch-over" sections
  once given.


## Implementation notes (2026-11-27, where the build differs from the design)

- **No Chromium in the image** (operator: "no chromium"): the base is
  `ghcr.io/linuxserver/baseimage-selkies` (the browser-less parent of
  `linuxserver/chromium`), not `linuxserver/chromium` with its Chromium left unused.
- **The extension is copied into the image** (not bind-mounted), so relay and extension
  are one commit; `extension/` came off `.dockerignore`.
- **Provisioning gained a step 0, Developer mode**: without it Chrome disables the
  unpacked extension as soon as "Allow in incognito" reloads it. And it does not load an
  extension that is already loaded and enabled (that would be a reload).
- **Storage is written from the extension's options page** (service-worker target as the
  fallback), toggles first, storage second.
- **Chrome is stopped through DevTools `Browser.close`**, not a signal: a SIGTERM loses
  the cookie changes of the last ~30 s.
- **Staging** (`bridge-docker --staging`: port 8766, own state directory, the production
  profile) exists so the container can run and be logged in next to the live host relay
  before the switch-over. In staging `/data` is NOT `~/.ai-browser-bridge` — two relays
  must not share `tabs.json` and the log. In production it is, as designed.
- **Switch-over order corrected**: the host relay and the Mac extension leave port 8765
  *before* the container takes it (the text above starts the container first, which
  cannot bind the port and would let the Mac extension supersede the container's).
  Rollback also restores the native-host registration.
- **Incognito**: all incognito windows share one session, so the second-account reader insists on
  a clean one (no incognito tab open), logs in every time and verifies its tab is closed.
  With incognito access on, ordinary tabs are opened in a regular window by id.
- **The co-host bot keeps `scripts/launch_agent_chrome.sh`**: `osascript` stays the
  default transport and the rollback path.
- **Open (operator):** whether ad-hoc Claude-session browser work moves into the container
  (A) or keeps a second relay on the Mac (B). The guide describes both; nothing was
  decided or torn down.
