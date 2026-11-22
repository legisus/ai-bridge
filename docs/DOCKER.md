# Running the bridge in Docker — isolated agent, your Chrome on the PC

**Status:** draft on the `docker-isolated` branch, 2026-11-21, revised the same day
after the Codex `gpt-6-astra` review (30 findings folded in; the review text is not
part of the repo). Nothing in this guide has been run: there is no Docker on the
machine it was written on, and the code changes it depends on (listed in
[What has to change](#what-has-to-change-in-the-code)) are not implemented. The
Dockerfile and compose file below are the target, not something that works today.

This branch stacks on the channels chain (`feat/channels-core` →
`fix/intent-gate-expiry`, PRs #5–#9): the Telegram daemon, the run journal and
`snapshot` it mentions are on those branches, not on `main`.

## Why

Today the bridge, the agent (`bridge agent`, the Telegram daemon, an interactive
Claude Code) and Chrome all run as the same user on the same machine. The agent can
read every file that user can read and run every program that user can run. The
browser is only one of the things it can reach.

The Docker layout puts the agent in a container that owns **nothing on the PC**
except the folders you mount into it. Its only way to act on the world is the bridge
socket to your Chrome, and **you decide, from the browser, whether that socket is
live**: grant access when you want the agent working, revoke it when you do not.
Revoke is enforced in the extension, on the trusted side of the boundary; the
container cannot undo it.

What revoke promises, precisely: **no further bridge command runs** after you click
it, the debugger is released from every tab, and downloads the bridge started are
cancelled. What it cannot promise: undoing what page code already started. A script
the agent injected with `eval` may have set a timer, opened a worker or fired a
request; a form it submitted stays submitted. If that matters, revoke **and close
the tabs the agent was driving** (the popup has a button for exactly that).

## Topology

```
PC (Windows / Linux / macOS)                        Docker container  ai-bridge
┌────────────────────────────────────┐              ┌──────────────────────────────────┐
│ Chrome, your profile               │              │ relay server   (binds 0.0.0.0)   │
│  └ AI Browser Bridge extension ────┼─ ws ─────────┼─▶ bridge CLI                     │
│    popup: [Grant] [Revoke]         │ 127.0.0.1:8765│   bridge agent  (claude / codex) │
│    allowlist, session name         │ host loopback │   channels daemon (Telegram)     │
│ Downloads\  (Chrome writes here)   │ only          │ /data  = AI_BRIDGE_HOME (volume) │
└────────────────────────────────────┘              │ /work  = cwd, scripts, --out files│
                                                    └──────────────────────────────────┘
```

- The **extension** keeps connecting to `ws://127.0.0.1:8765` exactly as today.
  Docker publishes the container's port 8765 on the host's loopback address, so the
  extension never learns that the server is in a container.
- The **server** must listen on the container's `0.0.0.0` (the host cannot reach a
  container's own loopback). The "127.0.0.1 only" promise moves to the port mapping:
  `127.0.0.1:8765:8765` means nothing outside the PC can reach it. This needs Docker
  Engine **28.0 or newer**; earlier releases could expose loopback-published ports to
  machines on the same L2 network.
- The **CLI, the agent and the channels daemon** run inside the container and talk
  to the server over the container's own loopback, unchanged.
- The **token** is generated inside the container on first start, in the `/data`
  volume. You paste it into the extension's Options page once. The native messaging
  host is not used in this layout, and the extension must be told so (see
  [Access](#access-grant-and-revoke), "manual mode"), otherwise a native host left
  over from a source install would overwrite the pasted token.
- **Access** is a switch in the extension. Granted: commands run. Revoked: every
  command is refused in the extension itself, the debugger is released from every
  tab, and the server/CLI report `access revoked` so the agent fails fast instead of
  retrying.

What stays on the PC: Chrome, the extension folder (loaded unpacked from the clone),
Docker Desktop. What moves into the container: everything under `server/`, Node, the
`claude` and `codex` CLIs and their logins.

## What has to change in the code

These are the gaps between the channels chain and a working container. The design
for each is in
[`docs/superpowers/specs/2026-11-21-docker-isolated-access-design.md`](superpowers/specs/2026-11-21-docker-isolated-access-design.md).

| # | Change | Why | Blocking? |
|---|---|---|---|
| 1 | `BRIDGE_BIND` env var for the server's bind address (default `127.0.0.1`; the container sets `0.0.0.0`). The CLI keeps connecting to `127.0.0.1`. | `server/server.js` hard-codes `host: "127.0.0.1"`; a published port would point at nothing. | **Yes** |
| 2 | Access grant/revoke in the extension: popup with **Grant** / **Grant for 1 h** / **Revoke** / **Revoke and close agent tabs**; enforced in the service worker with a revocation generation so in-flight and queued work stops; debugger released and bridge downloads cancelled on revoke; state pushed to the server. | The control this layout is built around. | **Yes** |
| 3 | Privileged-origin block, not overridable: the extension refuses to open, navigate to, attach to, or run code in `chrome://`, `chrome-extension://`, `edge://`, `brave://`, `about:`, `devtools://`, `file://` and `view-source:` targets, whatever the allowlist says. | Otherwise a granted agent can open the extension's own Options page and edit the allowlist or the access state from inside Chrome. | **Yes** |
| 4 | Allowlist on every command's **target**, not only on the current tab: destination URL for `newTab`/`navigate`/`download`, the tab for `closeTab`/`selectTab`/`activateTab`, re-check inside `waitFor` on every tick, `listTabs` shows only allowed hosts (others as `redacted`), `screenshot` confirms the tab is the active one in its window before capturing. | Today those commands skip `assertAllowed`, and `navigate` checks the old URL rather than the destination. With a container on the other side the allowlist becomes a real boundary. | **Yes** |
| 5 | Manual-provisioning mode in the extension: when the token was entered by hand, never call the native host; on a token or port change in Options, drop the open socket and reconnect. | Today a registered native host overwrites a pasted token, and changing the token in Options leaves the old connection open. | **Yes** |
| 6 | Browser-session name per extension instance, sent with the access state; `bridge ping`/`status` show name and access; `bridge agent` and channel runs check access before each model start and stop their children when access is lost. | Clear errors instead of `extension not connected`; no model tokens spent against a revoked browser. | Yes |
| 7 | `Dockerfile`, `.dockerignore`, `deploy/docker/compose.yml`, `deploy/docker/.env.example`; a non-root image with `/data` and `/work` owned by the image user, pinned `claude` and `codex` versions, and a Codex mode that relies on the container instead of Codex's own Linux sandbox. | The runnable artefact. Codex's `workspace-write` sandbox needs namespaces/landlock that `cap_drop: ALL` + `no-new-privileges` can block. | Yes |
| 8 | Healthcheck that tests the listening port, not `ping` (which also needs the extension). | `depends_on: service_healthy` would never pass before the token is pasted. | Yes |
| 9 | README security model and PRIVACY: "binds 127.0.0.1 only" becomes "binds 127.0.0.1 by default; in Docker the port is published on the host's loopback only". | Keeps the stated model true. | Docs |
| 10 | Several browser sessions on one relay (Chrome + Edge, two profiles): registry keyed by session name, `--session` on the CLI. | Not needed for one browser; today a second extension supersedes the first. | Later |
| 11 | `bridge token --rotate`. | Convenience; the manual procedure is below. | Later |

Nothing in the extension's command set changes. The wire protocol gains one message
type, `access`, plus `session` and `access` fields on the results of `ping` and
`status`, and two error codes, `access_revoked` and `access_not_granted`. The spec is
the single definition of that contract.

## Prerequisites on the PC

- **Docker Engine 28.0+**: Docker Desktop (Windows: WSL 2 backend; macOS: Docker
  Desktop or OrbStack) or Docker Engine on Linux. `docker compose version` must work.
- **git**, to clone the branch (the extension folder must live on the PC).
- **Google Chrome** (or Edge/Brave/Chromium) with the extension loaded unpacked from
  the `extension/` folder of the clone. The folder must stay put; Chrome loads it on
  every start.
- **Allow User Scripts** turned on for the extension (Chrome 138+), as in the normal
  install, otherwise `eval` and JS `waitFor` need `--debugger`.
- **No bridge on the PC itself.** If this PC had a source install: stop and remove its
  launchd/systemd/Task Scheduler service, run `npm run register-host -- --unregister`,
  and make sure nothing listens on 8765 (`netstat -an | findstr 8765` on Windows,
  `lsof -i :8765` elsewhere). A host relay or native host left running would compete
  for the port and could re-provision the extension.
- For `bridge agent` and the channels daemon: a **Claude Code login token**
  (`claude setup-token` on any machine where you are logged in prints a long-lived
  `CLAUDE_CODE_OAUTH_TOKEN`) and, for the Codex rung, a Codex login
  (`codex login --device-auth` inside the container once; it lands in the `home`
  volume).
- Nothing else: no Node on the PC, no native host, no background service. The
  container is the service.

## Files

### Dockerfile (repo root)

```Dockerfile
FROM node:22-bookworm-slim
# ca-certificates: outbound TLS to the model APIs. git: Claude Code wants it for
# its own bookkeeping; the agent itself never touches a repo.
# Pin the two CLIs: their sandbox and auth behaviour changes between releases.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@2.1.0 @openai/codex@0.171.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
# State and work dirs owned by the unprivileged image user *before* USER switches.
# A fresh named volume copies the image's ownership of /data; a bind mount does not
# (see compose.yml for ./work).
RUN mkdir -p /data /work && chown 1000:1000 /data /work && chmod 700 /data
USER node
ENV AI_BRIDGE_HOME=/data \
    BRIDGE_BIND=0.0.0.0 \
    BRIDGE_PORT=8765 \
    AI_BRIDGE_DEBUGGER=1 \
    AI_BRIDGE_CODEX_SANDBOX=container
WORKDIR /work
EXPOSE 8765
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD node -e "require('net').connect(8765,'127.0.0.1').once('connect',()=>process.exit(0)).once('error',()=>process.exit(1))"
CMD ["node", "/app/server/server.js"]
```

- `AI_BRIDGE_DEBUGGER=1` pre-approves the `--debugger` route because there is no
  TTY in the container to answer the `y/N` prompt. It does **not** make commands use
  the debugger; each call still has to pass `--debugger`. The host-side gate is the
  access switch plus the banner Chrome shows while attached.
- `AI_BRIDGE_CODEX_SANDBOX=container` tells the agent's Codex rung to run `codex`
  with its own sandbox off (the container is the sandbox) instead of
  `--sandbox workspace-write`, which needs kernel features the hardened container
  drops. Whether the pinned Codex works under this compose file is one of the things
  the first real run has to establish.
- The pinned `claude` version is a placeholder: use whatever is current when the
  image is first built, then keep it pinned.

### .dockerignore (repo root)

```
node_modules
dist
docs
extension
macos
test
*.png
*.log
deploy/docker/.env
deploy/docker/work
```

### deploy/docker/compose.yml

```yaml
services:
  bridge:
    build: ../..
    image: ai-bridge:local
    ports:
      - "127.0.0.1:${BRIDGE_PUBLISH_PORT:-8765}:8765"   # host loopback only — never 0.0.0.0
    volumes:
      - data:/data                                     # token, log, journal, traces, channels.json, sessions
      - home:/home/node                                # claude + codex config and logins
      - ${BRIDGE_WORK_DIR:-./work}:/work               # cwd: scripts for --file, --out files
    environment:
      - CLAUDE_CODE_OAUTH_TOKEN                        # from .env or the host environment
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    pids_limit: 256
    mem_limit: 2g
    restart: unless-stopped

  channels:                                            # Telegram daemon; only with --profile channels
    profiles: ["channels"]
    image: ai-bridge:local
    command: ["node", "/app/server/channels/main.js", "start"]
    network_mode: "service:bridge"                     # shares the relay's loopback; CLI's 127.0.0.1 works
    volumes:
      - data:/data
      - home:/home/node
      - ${BRIDGE_WORK_DIR:-./work}:/work
    environment:
      - CLAUDE_CODE_OAUTH_TOKEN
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    pids_limit: 256
    mem_limit: 2g
    healthcheck:
      disable: true                                    # the inherited check tests the relay's port, not this daemon
    depends_on:
      bridge:
        condition: service_healthy
    restart: unless-stopped

volumes:
  data:
  home:
```

### deploy/docker/.env.example

```
# Copy to .env (same folder). Never commit .env.
CLAUDE_CODE_OAUTH_TOKEN=
# Host port the relay is published on (change for a second instance).
BRIDGE_PUBLISH_PORT=8765
# Folder on the PC mounted as /work (scripts in, screenshots/pdf out).
BRIDGE_WORK_DIR=./work
```

Named volumes, not bind mounts, for `/data` and `/home/node`: the bridge writes
mode-0600 files and takes file locks, which NTFS bind mounts on Windows do not
honour. `/work` is a bind mount on purpose so you can see outputs and drop scripts in
from the PC. On Linux Docker creates a missing bind directory as root, which uid 1000
cannot write: create it yourself first (`mkdir -p deploy/docker/work && chown 1000
deploy/docker/work`, or run with `user: "${UID}:${GID}"` added to both services).
Docker Desktop on Windows and macOS maps ownership for you.

`.gitignore` on this branch excludes `deploy/docker/.env` and `deploy/docker/work/`.

## Setup, step by step

1. **Clone the branch on the PC** (the extension folder has to live here):
   ```
   git clone -b docker-isolated https://github.com/legisus/ai-bridge.git
   cd ai-bridge
   ```
2. **Secrets.** `cp deploy/docker/.env.example deploy/docker/.env` and fill in
   `CLAUDE_CODE_OAUTH_TOKEN`. Mode 600 on Linux/macOS; on Windows keep the clone out
   of synced folders. Skip the token if you only want plain commands and never
   `bridge agent`.
3. **Build and start the relay:**
   ```
   docker compose -f deploy/docker/compose.yml up -d --build bridge
   docker compose -f deploy/docker/compose.yml logs bridge
   # [bridge] token generated at /data/token …
   # [bridge] listening on ws://0.0.0.0:8765 — make sure only the host's loopback can reach this port
   ```
4. **Read the token** and paste it into the extension:
   ```
   docker compose -f deploy/docker/compose.yml exec bridge cat /data/token
   ```
   `chrome://extensions` → Developer mode → Load unpacked → `extension/` → Details →
   **Allow User Scripts** → **Extension options** → paste the token, port 8765, tick
   **Manual mode (never ask the native host)**, give the browser session a **name**
   (for example `work-chrome`), Save. The status line should read "token entered
   manually".
5. **Grant access.** Click the extension's toolbar icon → **Grant** (or **Grant for
   1 h**). The badge turns green.
6. **Smoke test from the PC:**
   ```
   docker compose -f deploy/docker/compose.yml exec -T bridge node /app/server/cli.js ping
   # {"pong":true,"version":"0.1.11","session":"work-chrome","access":"granted","until":null}
   ```
7. **Shell helper.** PowerShell **7.3 or newer** (5.1 mangles the JSON quotes):
   ```powershell
   function bridge { docker compose -f C:\path\to\ai-bridge\deploy\docker\compose.yml exec -T bridge node /app/server/cli.js @args }
   ```
   bash/zsh on Linux, macOS, WSL:
   ```bash
   bridge() { docker compose -f /path/to/ai-bridge/deploy/docker/compose.yml exec -T bridge node /app/server/cli.js "$@"; }
   ```
   Git Bash on Windows rewrites `/work/...` into a Windows path before Docker sees
   it; turn that off inside the wrapper:
   ```bash
   bridge() { MSYS_NO_PATHCONV=1 docker compose -f "C:/path/to/ai-bridge/deploy/docker/compose.yml" exec -T bridge node /app/server/cli.js "$@"; }
   ```
   Then `bridge listTabs`, `bridge eval '{"tabId":12}' --file scrape.js` (the file
   is `deploy/docker/work/scrape.js` on the PC; the container's cwd is `/work`),
   `bridge screenshot '{"tabId":12}' --out page.png --debugger` (background tabs
   need the debugger route; or `bridge selectTab '{"tabId":12}'` first and omit
   `--debugger`). The screenshot appears in `deploy/docker/work/page.png`.
8. **Agent and interactive use** happen inside the container:
   ```
   bridge agent "open https://example.com and report the title"
   docker compose -f deploy/docker/compose.yml exec -it bridge claude     # interactive Claude Code, cwd /work
   ```
   For the Telegram daemon, write `channels.json` into the data volume
   (`docker compose -f deploy/docker/compose.yml exec -T bridge sh -c 'cat > /data/channels.json' < channels.json`)
   and start it with its profile:
   ```
   docker compose -f deploy/docker/compose.yml --profile channels up -d
   ```

## Access: grant and revoke

The extension's toolbar popup is the switch. It shows the browser session's name,
whether the server is connected, and the access state. The popup only *asks* the
service worker to change state; the worker is the single writer of the access
record, so the popup, the Options page and the expiry alarm can never race.

| State | Extension | Server / CLI | Agent |
|---|---|---|---|
| **Granted** (`until: null`) | Commands run, subject to the allowlist and the privileged-origin block. Badge green `ON`. | `ping`/`status` show `access: "granted"`. | Works. |
| **Granted until T** | Same until T, then revoked by the worker's alarm, or by the next command's own deadline check if the alarm is late. Badge shows the remaining time. | `until` is shown; the server also treats a past `until` as revoked on its own. | Works until T; a run crossing T fails at its next command. |
| **Revoked** (default after install) | Every command except `ping` and `status` is refused with `access_revoked`; work already in flight stops at its next step; `chrome.debugger` is detached from every tab, including attachments that were still in progress; downloads the bridge started are cancelled; tab indicators are cleared. Badge grey. | The extension pushes `{type:"access", granted:false}`; the server fails every pending and new CLI request with `access revoked by user (session "work-chrome")` without forwarding it. | `bridge agent` and channel runs check access **before** every model and judge start and fail fast; a running model session is terminated when a revoke is seen; the ladder never climbs on an access error. |
| **Revoke and close agent tabs** | As revoked, plus every tab the agent opened with `newTab` in this grant is closed. | Same. | Same. |

Rules the design holds to:

- **The extension is the authority.** Access is checked in the service worker on
  every command and again after every internal wait, regardless of what the server
  says. In this layout the server is inside the untrusted container; its copy of the
  state only gives better error messages. There is no CLI command that grants access,
  and the allowlist can only be edited in the extension's Options page, which the
  agent cannot open (privileged-origin block).
- **Default after install is revoked.** You grant the first time; a grant persists
  across browser restarts until you revoke it or its timer runs out. Timed grants are
  the recommended way to leave an agent running unattended.
- **Revoke stops the bridge, not the page.** See [Why](#why). Use "Revoke and close
  agent tabs" when you want the pages gone too.
- **Revoke is not rotation.** A revoked container still holds the token, and so does
  anything that copied it. If you suspect the container, the sequence is: revoke →
  `docker compose -f deploy/docker/compose.yml down -v` (removes the container and
  both volumes, including the token and the model logins) → `up -d --build bridge` →
  paste the new token → grant. Until change #11 ships that is the procedure.
- **The hard stop is still Docker.** `docker compose -f deploy/docker/compose.yml
  stop` kills the agent, the server and any model session mid-flight. Revoke is the
  graceful version.
- **The token identifies the container to the extension, not the other way round.**
  The extension sends the token to whatever is listening on the published port; the
  server checks it. Any process on the PC that can bind port 8765 before Docker does
  would receive the token. That is the same property the non-Docker install has had
  from the start; the prerequisite step of removing any host-side relay is what keeps
  it harmless.

Other sessions: every browser profile or browser with the extension installed is its
own browser session with its own name, token field, allowlist and access switch. The
current relay keeps one extension connected; a second supersedes the first. Two
browsers on one container is change #10. Two browsers on two containers works once
change #1 is in: run a second compose project with its own `.env`
(`BRIDGE_PUBLISH_PORT=8766`, `BRIDGE_WORK_DIR=./work-edge`) and
`docker compose -p bridge-edge -f deploy/docker/compose.yml up -d bridge`; in that
browser's Options set port 8766. The named volumes are per project automatically.

## What the container can and cannot do

Can: act as you on any site Chrome is logged into, within the allowlist, while access
is granted. Through the page it sees what page JavaScript sees: page text, form field
values including a password typed into a visible field, cookies that are not
`HttpOnly`, and the clipboard when it pastes with the debugger route. It can trigger
downloads, which Chrome writes to the PC's download folder. It can reach the
internet, and also the PC's other services and your LAN: Docker's bridge network
restricts what comes *in* to the published port, not what the container connects
*out* to. Add an egress rule on the host if that matters.

Cannot: read or write the PC's file system except `/work`; run programs on the PC;
read the Chrome profile folder, the cookie database or the password store directly;
open `chrome://`, extension or `file://` pages (change #3); escalate privileges in
the container (`cap_drop: ALL`, `no-new-privileges`, non-root, read-only root fs);
grant itself access or edit the allowlist.

`download` is executed by Chrome, so the file lands in the PC's download folder, not
in the container. The agent can trigger a download but not read the result. If you
want it to, point Chrome's download location at `deploy/docker/work` and the file
appears under `/work`.

## Windows notes

- Docker Desktop with the WSL 2 backend, Engine 28+. Port publishing on `127.0.0.1`
  works; Chrome on Windows connects to `localhost:8765` through Docker Desktop's
  proxy.
- Keep the clone on the Windows file system (`C:\…`), not inside the WSL distro, so
  Chrome can load the `extension/` folder.
- PowerShell 7.3+ for the `bridge` function, or Git Bash with `MSYS_NO_PATHCONV=1`
  as shown above. Windows PowerShell 5.1 strips the quotes from JSON arguments.
- `.env` may have Windows line endings; compose trims them. The token must not
  contain spaces or quotes.
- Named volumes live inside Docker's WSL distro.
  `docker compose -f deploy/docker/compose.yml exec bridge cat /data/token` is how
  you read anything from them.

## Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `connect failed` from the CLI inside the container | The server is not up. | `docker compose -f deploy/docker/compose.yml logs bridge`. |
| Options show "not provisioned" / `extension not connected` | Token not pasted, or the server still binds `127.0.0.1` inside the container so the published port is dead. | Check the log says `listening on ws://0.0.0.0:8765`; re-paste the token; reload the extension. |
| Token in Options changes by itself | A native host from an old source install re-provisioned the extension. | Tick **Manual mode** in Options; unregister the host (prerequisites). |
| `EACCES … /data/token` in the logs | The `/data` volume is not owned by uid 1000 (an image built without the `chown` line, or a volume created by an older image). | Rebuild; `docker compose … down -v` and start again if the volume predates the fix. |
| `EACCES` writing `--out` files | `./work` on a Linux host was created by Docker as root. | `chown 1000 deploy/docker/work`, or add `user:` to the services. |
| `access revoked by user` (exit 8) | You revoked, or a timed grant ran out. | Popup → Grant. |
| `access not granted` (exit 8) | Fresh install, or the extension reconnected and has not sent its state yet. | Popup → Grant; wait a second and retry. |
| Chrome's `…is debugging this browser` banner stays | A `--debugger` command ran and `idleDetachMs` has not elapsed. | `bridge detachAll`, or revoke (which detaches). |
| `claude CLI not found` / `codex CLI not found` | The image was built without them. | Rebuild with the Dockerfile above. |
| `bridge agent` says not logged in | `CLAUDE_CODE_OAUTH_TOKEN` not passed through. | `docker compose … exec -T bridge sh -c 'test -n "$CLAUDE_CODE_OAUTH_TOKEN" && echo set || echo missing'`. |
| Codex rung fails with a sandbox error | Codex tried to build its own Linux sandbox inside the hardened container. | Confirm `AI_BRIDGE_CODEX_SANDBOX=container` is in the environment; rebuild. |
| Container `unhealthy` | Port 8765 not listening. | Logs; usually a crash on start. |

## Updating

```
git pull
docker compose -f deploy/docker/compose.yml up -d --build bridge        # add --profile channels if you run the daemon
bridge reloadExtension        # or the reload icon on the extension card
bridge ping
```

The token survives updates (it is in the `data` volume). Re-grant is not needed
unless you reinstalled the extension.
