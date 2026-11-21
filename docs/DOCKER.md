# Running the bridge in Docker — isolated agent, your Chrome on the PC

**Status:** draft for the `docker-isolated` branch, 2026-11-21. Nothing in this
guide has been run yet: there is no Docker on the machine it was written on, and
the code changes it depends on (listed in [What has to change](#what-has-to-change-in-the-code))
are not implemented. Treat the Dockerfile and compose file below as the target,
not as something that works today.

## Why

Today the bridge, the agent (`bridge agent`, the Telegram daemon, an interactive
Claude Code) and Chrome all run as the same user on the same machine. The agent
can therefore read every file that user can read and run every program that
user can run. The browser is only one of the things it can reach.

The Docker layout flips that around. The agent lives in a container that owns
**nothing on the PC** except what you mount into it. Its only way to act on the
world is the bridge socket to your Chrome, and **you decide, from the browser,
whether that socket is live**: grant access when you want the agent working,
revoke it when you do not. Revoking takes effect at once, in the extension, on
the trusted side of the boundary; the container cannot undo it.

## Topology

```
PC (Windows / Linux / macOS)                        Docker container  ai-bridge
┌────────────────────────────────────┐              ┌──────────────────────────────────┐
│ Chrome, your profile               │              │ relay server   (binds 0.0.0.0)   │
│  └ AI Browser Bridge extension ────┼─ ws ─────────┼─▶ bridge CLI                     │
│    popup: [Grant] [Revoke]         │ 127.0.0.1:8765│   bridge agent  (claude / codex) │
│    allowlist, session name         │ host loopback │   channels daemon (Telegram)     │
│ Downloads\  (Chrome writes here)   │ only          │ /data  = AI_BRIDGE_HOME (volume) │
└────────────────────────────────────┘              │ /out   = screenshots, pdf (mount)│
                                                    └──────────────────────────────────┘
```

- The **extension** keeps connecting to `ws://127.0.0.1:8765` exactly as it does
  today. Docker publishes the container's port 8765 on the host's loopback
  address, so the extension never learns that the server is in a container.
- The **server** must listen on the container's `0.0.0.0` (the host cannot reach
  a container's own loopback). The "127.0.0.1 only" promise moves to the port
  mapping: `127.0.0.1:8765:8765` means nothing outside the PC can reach it.
- The **CLI, the agent and the channels daemon** run inside the container and
  talk to the server over the container's own loopback, unchanged.
- The **token** is generated inside the container on first start, in the
  `/data` volume. You paste it into the extension's Options page once. The
  native messaging host is not used in this layout (Chrome would have to start a
  process on the PC, and the server is not a process on the PC).
- **Access** is a switch in the extension. Granted: commands run. Revoked: every
  command is refused in the extension itself, the debugger is released from every
  tab, and the server/CLI report `access revoked` so the agent fails fast instead
  of retrying.

What stays on the PC: Chrome, the extension folder (loaded unpacked from a clone
or the release zip), Docker Desktop. What moves into the container: everything
under `server/`, Node, the `claude` and `codex` CLIs and their logins.

## What has to change in the code

These are the gaps between `main` and a working container. The design for each
is in
[`docs/superpowers/specs/2026-11-21-docker-isolated-access-design.md`](superpowers/specs/2026-11-21-docker-isolated-access-design.md).

| # | Change | Why it blocks Docker | Blocking? |
|---|---|---|---|
| 1 | `BRIDGE_HOST` env var for the server bind address (default `127.0.0.1`; the container sets `0.0.0.0`). | The server hard-codes `host: "127.0.0.1"` in `server/server.js`; a published port would point at nothing. | **Yes** |
| 2 | Access grant/revoke in the extension: popup with **Grant** / **Grant for 1 h** / **Revoke**, enforced in `handle()`, debugger detached on revoke, state pushed to the server. | This is the control the layout is built around. Without it the only kill switch is `docker compose stop` or clearing the token in Options. | **Yes** (the feature) |
| 3 | Browser-session identity: a name per extension instance, sent on auth; `bridge status` shows name + access state; `bridge agent` and the channels daemon check access before spending tokens. | Clear errors instead of `extension not connected`; no model tokens burnt against a revoked browser. | Yes |
| 4 | `Dockerfile` + `deploy/docker/compose.yml` (below), a non-root image with `claude` and `codex` installed. | The runnable artefact. | Yes |
| 5 | Healthcheck that tests the listening port, not `ping` (which also needs the extension). | `depends_on: service_healthy` would never pass before the extension connects. | Yes |
| 6 | README security model and PRIVACY: "binds 127.0.0.1 only" becomes "binds 127.0.0.1 by default; in Docker the port is published on the host's loopback only". | Keeps the stated model true. | Docs |
| 7 | Several browser sessions at once (Chrome + Edge, two profiles): server registry keyed by session name, `--session` on the CLI. | Not needed for one browser; today a second extension supersedes the first. | Later |
| 8 | Token rotation command (`bridge token --rotate`) so a revoked container cannot come back after you re-grant to a new one. | Convenience; deleting `/data/token` and restarting does the same. | Later |

Nothing in the extension's command set changes. The protocol gains three message
types (`hello`, `access`, and `access` fields on `status`), all described in the
spec.

## Prerequisites on the PC

- **Docker Desktop** (Windows: WSL 2 backend; macOS: Docker Desktop or OrbStack)
  or Docker Engine on Linux. `docker compose version` must work.
- **Google Chrome** (or Edge/Brave/Chromium) with the extension loaded unpacked
  from the `extension/` folder of a clone or of the release source zip. The
  folder must stay on the PC; Chrome loads it on every start.
- **Allow User Scripts** turned on for the extension (Chrome 138+), as in the
  normal install, otherwise `eval` and JS `waitFor` need `--debugger`.
- For `bridge agent` and the channels daemon: a **Claude Code login token**
  (`claude setup-token` on any machine where you are logged in prints a
  long-lived `CLAUDE_CODE_OAUTH_TOKEN`) and, if you want the Codex rung, a
  Codex login (`codex login --device-auth` inside the container once, or copy
  `~/.codex/auth.json` into the home volume).
- Nothing else: no Node on the PC, no native host, no launchd/Task Scheduler
  service. The container is the service.

## Files

### Dockerfile (repo root)

```Dockerfile
FROM node:22-bookworm-slim
# ca-certificates: outbound TLS to the model APIs. git: Claude Code wants it for
# its own bookkeeping; the agent itself never touches a repo.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code @openai/codex
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
# The node image ships an unprivileged user `node` (uid 1000). Claude Code
# refuses --dangerously-skip-permissions as root anyway.
USER node
ENV AI_BRIDGE_HOME=/data \
    BRIDGE_HOST=0.0.0.0 \
    BRIDGE_PORT=8765 \
    AI_BRIDGE_DEBUGGER=1
EXPOSE 8765
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD node -e "require('net').connect(8765,'127.0.0.1').once('connect',()=>process.exit(0)).once('error',()=>process.exit(1))"
CMD ["node", "server/server.js"]
```

`AI_BRIDGE_DEBUGGER=1` is set because there is no TTY in the container to answer
the `y/N` prompt; the host-side gate for the debugger route is the extension (see
[Access](#access-grant-and-revoke)), not the prompt.

### deploy/docker/compose.yml

```yaml
services:
  bridge:
    build: ../..
    image: ai-bridge:local
    ports:
      - "127.0.0.1:8765:8765"      # host loopback only — never 0.0.0.0
    volumes:
      - data:/data                 # token, bridge.log, journal, traces, channels.json, sessions
      - home:/home/node            # claude + codex config and logins
      - ./out:/out                 # --out files (screenshots, pdf) land here on the PC
      - ./work:/work:ro            # scripts for --file, read-only
    environment:
      - CLAUDE_CODE_OAUTH_TOKEN    # value comes from .env or the host environment
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

  channels:                        # optional: Telegram daemon
    image: ai-bridge:local
    command: ["node", "server/channels/main.js", "start"]
    network_mode: "service:bridge" # shares the relay's loopback, so the CLI's 127.0.0.1 works
    volumes:
      - data:/data
      - home:/home/node
      - ./out:/out
    environment:
      - CLAUDE_CODE_OAUTH_TOKEN
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    depends_on:
      bridge:
        condition: service_healthy
    restart: unless-stopped

volumes:
  data:
  home:
```

Named volumes, not bind mounts, for `/data` and `/home/node`: the bridge writes
mode-0600 files and takes file locks, which NTFS bind mounts on Windows do not
honour. `./out` and `./work` are bind mounts on purpose, so you can see the
screenshots and drop scripts in from the PC.

## Setup, step by step

1. **Clone on the PC** (the extension folder has to live here):
   ```
   git clone https://github.com/legisus/ai-bridge.git
   cd ai-bridge
   ```
2. **Secrets.** Create `deploy/docker/.env` (mode 600 on Linux/macOS; on
   Windows keep it out of synced folders):
   ```
   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…
   ```
   Skip this if you only want plain commands and never `bridge agent`.
3. **Build and start:**
   ```
   docker compose -f deploy/docker/compose.yml up -d --build bridge
   docker compose -f deploy/docker/compose.yml logs bridge
   # [bridge] token generated at /data/token …
   # [bridge] listening on ws://0.0.0.0:8765
   ```
4. **Read the token** and paste it into the extension:
   ```
   docker compose -f deploy/docker/compose.yml exec bridge cat /data/token
   ```
   `chrome://extensions` → Developer mode → Load unpacked → `extension/` →
   Details → **Allow User Scripts** → **Extension options** → paste the token,
   port 8765, give the browser session a **name** (for example `work-chrome`),
   Save. Leave the native-host line alone; it will say "token entered manually".
5. **Grant access.** Click the extension's toolbar icon → **Grant** (or
   **Grant for 1 h**). The badge turns green.
6. **Smoke test from the PC:**
   ```
   docker compose -f deploy/docker/compose.yml exec -T bridge node server/cli.js ping
   # {"pong":true,"version":"0.1.11","session":"work-chrome","access":"granted"}
   ```
7. **Shell helper.** Bash/zsh (Linux, macOS, WSL, Git Bash):
   ```bash
   bridge() { docker compose -f /path/to/ai-bridge/deploy/docker/compose.yml exec -T bridge node server/cli.js "$@"; }
   ```
   PowerShell:
   ```powershell
   function bridge { docker compose -f C:\path\to\ai-bridge\deploy\docker\compose.yml exec -T bridge node server/cli.js @args }
   ```
   Then `bridge listTabs`, `bridge screenshot '{"tabId":12}' --out /out/page.png`
   (the file appears in `deploy/docker/out/page.png` on the PC),
   `bridge eval '{"tabId":12}' --file /work/scrape.js`.
8. **Agent and interactive use** happen inside the container:
   ```
   bridge agent "open https://example.com and report the title"
   docker compose -f deploy/docker/compose.yml exec -it bridge claude     # interactive Claude Code, cwd /app
   ```
   For the Telegram daemon, write `channels.json` into the data volume
   (`docker compose … exec bridge sh -c 'cat > /data/channels.json'`) and
   `docker compose … up -d channels`.

## Access: grant and revoke

The extension's toolbar popup is the switch. It shows the browser session's
name, whether the server is connected, and the access state.

| State | Extension | Server / CLI | Agent |
|---|---|---|---|
| **Granted** | Commands run, subject to the host allowlist. Badge green. | `status` shows `access: granted`. | Works. |
| **Granted until T** | Same, then flips to revoked at T without you doing anything. Badge green with the remaining time in the popup. | `status` shows `until`. | Works until T; a run crossing T fails at its next command. |
| **Revoked** | Every command is refused with `access revoked`; `chrome.debugger` is detached from every tab and the tab indicators are cleared; polling commands (`waitFor`) stop at their next tick. Badge grey. | The extension pushes `{type:"access",granted:false}`; the server answers every CLI request with `access revoked by user (session "work-chrome")` without forwarding it. | `bridge agent` and channel runs check access **before** starting a model and fail fast with that message; a run in progress fails at its next command. |

Rules the design holds to:

- **The extension is the authority.** Access is checked in the extension on
  every command, regardless of what the server says. In this layout the server
  is inside the untrusted container; its copy of the state is only for better
  error messages. There is no CLI command that grants access, and the allowlist
  can only be edited in the extension.
- **Default after install is revoked.** You grant the first time; a grant
  persists across browser restarts until you revoke it or its timer runs out.
  Timed grants are the recommended way to leave an agent running unattended.
- **Revoke is not rotation.** A revoked container still holds the token. If you
  want to make sure it can never reconnect, rotate: delete `/data/token`
  (`docker compose … exec bridge rm /data/token`), restart the container, paste
  the new token into Options. Until change #8 ships that is the procedure.
- **The hard stop is still Docker.** `docker compose … stop` kills the agent,
  the server and any model session mid-flight. Revoke is the graceful version.

Other sessions: every browser profile or browser with the extension installed
is its own browser session with its own name, token field, allowlist and access
switch. With the current single-extension server, only one can be connected to
one container at a time (a second supersedes the first). Running Chrome and
Edge against one container is change #7. Running them against two containers
(two compose projects on two ports) works as soon as #1 is in.

## What the container can and cannot do

Can: act as you on any site Chrome is logged into, within the host allowlist,
while access is granted. Read page content, click, type, download (see below),
screenshot, print to PDF. Reach the internet directly (it needs that for the
model APIs).

Cannot: read or write anything on the PC outside `./out` and `./work`; run
programs on the PC; see the Chrome profile folder, cookies or passwords (it only
sees pages through the extension, like today); reach other containers; escalate
privileges (`cap_drop: ALL`, `no-new-privileges`, non-root, read-only root fs).

`download` is executed by Chrome, so the file lands in the PC's download folder,
not in the container. The agent can trigger a download but not read the result.
If you want it to, point Chrome's download location at `deploy/docker/out` and
the file appears under `/out` in the container.

## Windows notes

- Docker Desktop with the WSL 2 backend. Port publishing on `127.0.0.1` works;
  Chrome on Windows connects to `localhost:8765` through Docker Desktop's proxy.
- Keep the clone on the Windows file system (`C:\…`), not inside the WSL distro,
  so Chrome can load the `extension/` folder; the container does not need the
  clone at run time, only at build time.
- `.env` must be LF-terminated or Docker passes `\r` in the token. Save it from
  VS Code with LF, or write it from PowerShell with `Set-Content -NoNewline`.
- Use the PowerShell function above; `docker compose exec -T` is what makes
  piping and `--out` behave in a non-interactive shell.
- Named volumes live inside Docker's WSL distro. `docker compose … exec bridge
  cat /data/token` is how you read anything from them.

## Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `connect failed` from the CLI inside the container | The server is not up. | `docker compose … logs bridge`. |
| Extension options show "not provisioned" / `extension not connected` | Token not pasted, or `BRIDGE_HOST` still `127.0.0.1` inside the container so the published port is dead. | Check the log line says `listening on ws://0.0.0.0:8765`; re-paste the token; reload the extension. |
| `access revoked by user` | You revoked, or a timed grant ran out. | Popup → Grant. |
| `access not granted` on a fresh install | Default state. | Popup → Grant. |
| Chrome's `…is debugging this browser` banner stays | A `--debugger` command ran and `idleDetachMs` has not elapsed. | `bridge detachAll`, or revoke (which detaches). |
| `claude CLI not found` / `codex CLI not found` | The image was built without them. | Rebuild with the Dockerfile above. |
| `bridge agent` says not logged in | `CLAUDE_CODE_OAUTH_TOKEN` not passed through. | Check `.env` and `docker compose … exec bridge env \| grep CLAUDE`. |
| Container `unhealthy` | Port 8765 not listening. | Logs; usually a crash on start. |

## Updating

```
git pull
docker compose -f deploy/docker/compose.yml up -d --build
bridge reloadExtension        # or the reload icon on the extension card
bridge ping
```

The token survives updates (it is in the `data` volume). Re-grant is not needed
unless you reinstalled the extension.
