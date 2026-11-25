# Running the bridge in Docker — isolated agent, your Chrome on the PC

**Status:** draft on the `docker-isolated` branch, 2026-11-21, revised the same day
after five rounds of the Codex `gpt-6-astra` review (30 + 7 + 3 + 1 + 1 findings
folded in; approved as a draft design in round six, with the untested CLI pin pair
left as an implementation gate; the review text is not part of the repo). Nothing in this guide has been run: there is no Docker on the
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
except the folders you mount into it. Its only way to act on **your browser** is the
bridge socket (it can still reach the internet and your network directly, see
[What the container can and cannot do](#what-the-container-can-and-cannot-do)), and **you decide, from the browser, whether that socket is
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
  command except `ping` and `status` is refused in the extension itself, the
  debugger is released from every tab, and the server/CLI report `access revoked`
  so the agent fails fast instead of retrying.

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
| 12 | The restricted-run env filter (`server/channels/restricted.js`) passes `AI_BRIDGE_HOME`, `AI_BRIDGE_DEBUGGER` and `AI_BRIDGE_CODEX_SANDBOX` through to channel children (never messenger tokens). | Today it keeps only `BRIDGE_PORT`, so a channel run inside the container would look for the token under `/home/node/.ai-browser-bridge` and exit 6. | **Yes** |
| 13 | Extension event log: a ring buffer of the last 200 events (connect, grant, revoke, refused command, closed tab, cancelled download, detach) kept in session storage, shown in full in the popup and in redacted form by `bridge status --events`; every CLI failure prints the request id, and every server log and trace line carries request id, client label, run id and outcome, written once per request. | Today the service worker logs nothing at all, so a refused command leaves no trace on the Chrome side, the server log says `cmd newTab {...}` without saying who asked, and a locally refused command of a run is never traced. | **Yes** |
| 14 | Tab hygiene: the server keeps a registry of every tab the bridge opened (who, when, which run, which Chrome session) and closes a run's tabs when the run ends or its supervisor dies, with the extension confirming ownership of every tab before closing it (`--keep-tabs` to opt out); `bridge tabs` lists them; `bridge closeTabs --mine / --run <id> / --older-than <min>`; the popup gets a standalone **Close agent tabs** button. Not Docker-specific: the host layout leaks the same tabs today. | The bridge has opened 2,378 tabs and closed 1,966 since its log began (503 of them in their own windows); 8 of the last 49 agent runs left tabs behind, passing runs included, because closing is a prompt rule the model may ignore and a failed or aborted run never reaches it. | **Yes** |

The wire protocol gains: the `access` message from the extension (session name,
granted, until, generation, Chrome-session id); `run` / `runEnd` messages from the
agent's lease connection; one new extension command, `closeTabs`, used only for
bridge-owned tabs; an `events` option on `status`; `session`, `access` and identity
fields on the results of `ping` and `status`; and two error codes, `access_revoked`
and `access_not_granted`. The spec's "Wire contract" section is the single
definition of that contract.

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
# procps: the channels daemon's crash recovery calls `ps` to inspect a recorded pid.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git procps \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@2.1.317 @openai/codex@0.171.0
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
- The pinned pair (`claude` 2.1.317, `codex` 0.171.0) is the pair installed on the
  machine this guide was written on; it is **untested** in this container and under
  this compose file. The first build fixes the pair that passes the Docker smoke job
  and records it here; after that, bump only with the smoke job.

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
deploy/docker/.env*
deploy/docker/work*
deploy/docker/channels*.json
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
cannot write: create it yourself first (`mkdir -p deploy/docker/work && sudo chown
1000 deploy/docker/work`). Do not work around it with a compose `user:` override:
that changes the process identity, not the ownership of `/data` (0700, uid 1000)
or `/home/node`, and the token becomes unreadable. Docker Desktop on Windows and
macOS maps ownership for you.

`.gitignore` on this branch excludes `deploy/docker/.env*` (except `.env.example`),
`deploy/docker/work*/` and `deploy/docker/channels*.json`, so a second instance's
env file and work dir, and a `channels.json` kept next to the compose file, never
get committed.

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
   # {"pong":true,"version":"0.1.11","session":"work-chrome","access":"granted","until":null,"accessGen":3,"extGen":1,"serverId":"7f3a…"}
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
   Use `--debugger` whenever the picture is evidence: a stealth screenshot captures
   whichever tab is in front at that instant, and the extension can only detect,
   not prevent, a tab switch during the capture; the debugger route is bound to
   the tab it is attached to.
8. **Agent and interactive use** happen inside the container:
   ```
   bridge agent "open https://example.com and report the title"
   docker compose -f deploy/docker/compose.yml exec -it bridge claude     # interactive Claude Code, cwd /work
   ```
   For the Telegram daemon, keep your `channels.json` at
   `deploy/docker/channels.json` (that path is git-ignored; the repo root is not),
   write it into the data volume
   (`docker compose -f deploy/docker/compose.yml exec -T bridge sh -c 'cat > /data/channels.json' < deploy/docker/channels.json`)
   and start it with its profile:
   ```
   docker compose -f deploy/docker/compose.yml --profile channels up -d
   ```
   From then on **every** compose command for this project carries
   `--profile channels`, including `stop` and `down`; without it compose ignores
   the daemon and leaves it running.

## Access: grant and revoke

The extension's toolbar popup is the switch. It shows the browser session's name,
whether the server is connected, and the access state. The popup only *asks* the
service worker to change state; the worker is the single writer of the access
record, so the popup, the Options page and the expiry alarm can never race.

| State | Extension | Server / CLI | Agent |
|---|---|---|---|
| **Granted** (`until: null`) | Commands run, subject to the allowlist and the privileged-origin block. Badge green `ON`. | `ping`/`status` show `access: "granted"`. | Works. |
| **Granted until T** | Same until T, then revoked by the worker's alarm, or by the next command's own deadline check if the alarm is late. Badge shows the remaining time. | `until` is shown; the server also treats a past `until` as revoked on its own. | Works until T; a run crossing T fails at its next command. |
| **Revoked** (default after install) | Every command except `ping` and `status` is refused with `access_revoked`; work already in flight stops at its next step; `chrome.debugger` is detached from every tab, including attachments that were still in progress; every download the bridge started in this browser session and not yet finished is cancelled; tab indicators are cleared. Badge grey. | The extension pushes `{type:"access", session:"work-chrome", granted:false, until:null, gen:4, browserSession:"…"}`; the server fails every pending and new CLI request other than `ping`/`status` with `access revoked by user (session "work-chrome")` without forwarding it. | Every run is bound to the identity it started under: the server process (`serverId`), the extension connection (`extGen`) and the access **generation** (`accessGen`), all shown by `ping`. `bridge agent` and channel runs check before every model and judge start and poll while a model runs; any change of the three, not only a revoked state, ends the run, so a revoke followed by a quick re-grant, a server restart, or another Chrome profile taking over the connection all stop the old run. The ladder never climbs on an access error. |
| **Revoke and close agent tabs** | As revoked, plus every tab the agent opened with `newTab` since Chrome last started (any grant) is closed. A tab whose opening was cut short by a service-worker restart before its id was recorded cannot be identified and is not closed; the popup shows a count of such tabs. | Same. | Same. |

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
- **"Agent tabs" are remembered only until Chrome restarts or the extension is
  reloaded.** Chrome reuses tab numbers across restarts, so the extension forgets
  which tabs the agent opened when the browser starts, and Chrome also clears that
  memory on an extension reload or update; after either, they are ordinary tabs and
  "Revoke and close agent tabs" leaves them alone. Close them yourself. Downloads
  are remembered across both (Chrome's download ids are stable). The grant survives
  a browser restart but **not** an extension reload: after a reload the extension
  starts revoked, with a popup note saying why, so the agent cannot use
  `reloadExtension` to wipe the tab records and carry on; `reloadExtension` itself
  first revokes, closes the agent tabs and cancels the bridge downloads, then
  reloads.
- **Revoke is not rotation.** A revoked container still holds the token, and so does
  anything that copied it. If you suspect the container, the sequence is:
  1. revoke in the popup;
  2. `docker compose -f deploy/docker/compose.yml --profile channels down -v`
     (removes both containers and both volumes, including the token and the model
     logins);
  3. quarantine the work dir: `mv deploy/docker/work deploy/docker/work.quarantine-<date>`
     and create a fresh, empty one. The old one is where a compromised agent could
     have left instructions or config for its successor; copy back only files you
     have read;
  4. invalidate the model credentials **at the provider**, then issue new ones.
     Issuing a replacement does not kill the old one, and `codex logout` only
     deletes the local file:
     - Codex: OpenAI's own help page says the ChatGPT **Active sessions** list
       "does not show or manage" Codex CLI sessions, and **Log out of all
       sessions** (Settings → Security, up to 30 min to propagate) does not say
       whether it covers them. There is no verified way to invalidate a copied
       Codex CLI login from the account; `codex logout` only deletes the local
       file. Do all of: Log out of all sessions, change the account password, and
       ask OpenAI support to revoke the Codex CLI grant; then `codex login
       --device-auth` again. Until support confirms, treat the old login as live
       and watch the account's usage.
     - Claude Code: there is no self-service revoke for a `claude setup-token`
       token as of this writing (the CLI only mints; feature requests
       anthropics/claude-code#48373 and #57400 are open). Treat the old token as
       live for its full lifetime (one year), change the account password and
       ask Anthropic support to revoke the token, then mint a new one with
       `claude setup-token`. The token's scope is inference only, so the exposure
       is model usage billed to the account, not chat history.
     Put the new token into `deploy/docker/.env` **before** the next step;
  5. `up -d --build bridge` → paste the new bridge token into the extension →
     grant.
  Until change #11 ships that is the procedure. The bridge token itself is
  replaced by `down -v` (a fresh `/data` means a fresh token).
- **The hard stop is still Docker.** `docker compose -f deploy/docker/compose.yml
  --profile channels stop` kills the daemon, the agent, the server and any model
  session mid-flight (keep `--profile channels` even if you never started the
  daemon; it is harmless then). Revoke is the graceful version.
- **The token tells the server a legitimate client from a stranger; it proves
  nothing to the extension.** The extension sends the token to whatever is listening
  on the published port and the server checks it. Any process on the PC that can
  bind port 8765 before Docker does would receive the token. That is the same
  property the non-Docker install has had from the start; the prerequisite step of
  removing any host-side relay is what keeps it harmless.

Other sessions: every browser profile or browser with the extension installed is its
own browser session with its own name, token field, allowlist and access switch. The
current relay keeps one extension connected; a second supersedes the first. Two
browsers on one container is change #10. Two browsers on two containers works once
change #1 is in: give the second instance its own env file
`deploy/docker/.env.edge` with `BRIDGE_PUBLISH_PORT=8766` and
`BRIDGE_WORK_DIR=./work-edge`, then
```
docker compose -p bridge-edge --env-file deploy/docker/.env.edge -f deploy/docker/compose.yml up -d --build bridge
```
and in that browser's Options set port 8766. A second shell helper carries the same
`-p` and `--env-file`. The named volumes are per project automatically.

## What the container can and cannot do

Can: act as you on any site Chrome is logged into, within the allowlist, while access
is granted. Through the page it sees what page JavaScript sees: page text, form field
values including a password typed into a visible field, cookies that are not
`HttpOnly`, and the clipboard when it pastes with the debugger route. It can trigger
downloads, which Chrome writes to the PC's download folder. It can reach the
internet, and also the PC's other services and your LAN: Docker's bridge network
restricts what comes *in* to the published port, not what the container connects
*out* to. Add an egress rule on the host if that matters.

Cannot: read or write the PC's file system directly, except `/work` (Chrome can
still write a download it triggered, see below); run programs on the PC;
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

## Debugging

Everything the bridge writes lives in the `data` volume, so it survives restarts
and is readable from the PC:

```
docker compose -f deploy/docker/compose.yml logs -f bridge          # server log (also /data/bridge.log)
docker compose -f deploy/docker/compose.yml exec bridge sh -c 'tail -50 /data/bridge.log'
bridge status --events                                              # extension's last 200 events (grant, revoke, refused, closed tab…)
bridge journal                                                      # agent runs, verdicts, cost
bridge journal --trace <runId>                                      # every bridge command of one run
bridge tabs                                                         # tabs the bridge opened, with age, owner and run id
docker compose -f deploy/docker/compose.yml --profile channels logs -f channels   # Telegram daemon (also /data/channels.log, rotated)
```

Each server log line names the request id, the client label (`AI_BRIDGE_CLIENT`,
default the process name), the run id when the command came from an agent run,
and the outcome (`done`, `refused …`, `cancelled …`), once per request. The CLI
prints the same request id with every failure, `ERROR: … (req <id>)`, so an
`access_revoked` or `target changed` can be matched to the log line, to the trace
line, and, when the command reached Chrome, to the extension's event list. A
command the server refused without forwarding has no extension event; the log
line says `refused`, which is the whole story.

`bridge status --events` is a redacted view: while access is revoked it shows only
how many events of each kind happened; while granted it hides the origin and tab
of any event about a page outside the current allowlist. The full list, with
origins, is in the popup and in the service worker's `console` at
`chrome://extensions` → the bridge card → **service worker**, on the PC only.

`bridge agent … --verbose` prints each rung's model, judge verdict and token spend
while the run goes. A run stopped by a revoke ends with the structured reason
`access_revoked` rather than a model failure.

Node's inspector is deliberately not exposed by the compose file (it would be
another published port). To step through the server, run it on the PC outside
Docker for that session.

### Abandoned tabs

Tabs the bridge opens are supposed to be closed by whoever opened them. In
practice they are not: a model may ignore the "close your window's tabs" rule, a
run that fails, times out or is revoked never reaches it, and launchd jobs that
drive the CLI directly have no cleanup step at all. Change #14 fixes this at the
server, which remembers every tab the bridge opened (who, when, which run, which
Chrome session) and closes a run's tabs when the run ends, however it ends:

- The agent holds an open connection to the relay for the life of the run. When
  it says it is done, or when that connection drops because the agent process
  crashed or was killed, the relay closes the run's tabs. `bridge agent
  --keep-tabs`, or a task that says to leave a tab open, keeps them.
- Only tabs the bridge itself opened are ever closed, one by one, and the
  extension checks each one against its own record before closing. Windows are
  never closed as a whole, so a tab you opened or dragged into the agent's window
  stays; Chrome closes a window on its own when its last tab goes.
- If the run ended because you revoked access, nothing can be closed from the
  container side (that is the point of revoking). Those tabs are listed as
  *retained* by `bridge tabs`; close them with **Close agent tabs** or **Revoke
  and close agent tabs** in the popup.
- After Chrome restarts, earlier records are dead: Chrome reuses tab numbers, so
  the bridge never acts on a tab id from a previous Chrome session.
- For direct CLI use, `bridge tabs` shows what is open and who opened it, and
  `bridge closeTabs --older-than 60` closes bridge-opened tabs no bridge command
  has touched for an hour. There is no automatic sweep.

Limits: if the relay itself dies mid-run, its registry on disk survives but the
run's end is only noticed when the agent reconnects or you run `bridge
closeTabs`; and nothing closes while Chrome is not connected.

## Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `connect failed` from the CLI inside the container | The server is not up. | `docker compose -f deploy/docker/compose.yml logs bridge`. |
| Options show "not provisioned" / `extension not connected` | Token not pasted, or the server still binds `127.0.0.1` inside the container so the published port is dead. | Check the log says `listening on ws://0.0.0.0:8765`; re-paste the token; reload the extension. |
| Token in Options changes by itself | A native host from an old source install re-provisioned the extension. | Tick **Manual mode** in Options; unregister the host (prerequisites). |
| `EACCES … /data/token` in the logs | The `/data` volume is not owned by uid 1000 (an image built without the `chown` line, or a volume created by an older image). | Rebuild; `docker compose … down -v` and start again if the volume predates the fix. |
| `EACCES` writing `--out` files | `./work` on a Linux host was created by Docker as root. | `sudo chown 1000 deploy/docker/work`. Do not add `user:` to the services (see the note under `.env.example`). |
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
docker compose -f deploy/docker/compose.yml up -d --build bridge                              # relay only
docker compose -f deploy/docker/compose.yml --profile channels up -d --build bridge channels  # relay + daemon
bridge reloadExtension        # revokes, closes agent tabs, cancels bridge downloads, then reloads
bridge ping                   # → access "revoked": grant again in the popup
```

A reload (this command, the reload icon, or an extension update) always leaves the
extension revoked; grant again afterwards.

Name both services in the second form: with a profile active, `up --build bridge`
alone rebuilds the relay and leaves the daemon on the old image.

The bridge token survives container updates (it is in the `data` volume).
Reloading or updating the extension revokes access; grant again in the popup.
