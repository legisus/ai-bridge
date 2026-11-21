# Docker-isolated agent with host-side access control — design

**Status:** design, 2026-11-21. Ships as the `docker-isolated` branch. User-facing
guide: `docs/DOCKER.md`. Builds on the relay protocol in `server/server.js` and
the extension's `handle()` in `extension/background.js`; does not touch the
channels daemon's command set beyond reading the new access state.

## Intent

Run everything that holds a model (the relay, `bridge agent`, the channels daemon,
an interactive Claude Code) inside a Docker container on the user's PC, while Chrome
and the extension stay on the PC. The container owns nothing on the PC except the
volumes it is given. The user controls, from the browser, whether the container may
drive Chrome at all: **grant** and **revoke** access to that browser session, with
the decision enforced on the PC side, not in the container.

Why now: the agent currently runs as the user with the user's whole file system and
shell. The messenger daemon in particular runs unattended. Isolating the model behind
one socket, with a switch the model cannot flip, is the smallest change that makes
unattended operation defensible.

## Goals

- The relay can bind an address other than loopback so a published container port
  reaches it; the loopback-only promise is kept by the port mapping instead.
- The extension has an **access switch** per browser session: granted, granted until a
  time, revoked. Revoke is immediate, releases the debugger everywhere, and cannot be
  undone from the CLI, the server or the container.
- The server and CLI surface the access state (`status`, `ping`) and refuse CLI requests
  with a clear error while revoked. `bridge agent` and channel runs check it before
  spending model tokens.
- A browser session has a **name**, chosen by the user in Options, that appears in
  errors and status so two browsers are distinguishable.
- A Dockerfile and compose file that run the relay, the agent and the daemon as a
  non-root user with a read-only root file system.

## Non-goals (v1)

- Several browser sessions on one relay. The relay keeps its single extension socket;
  a second authenticating extension supersedes the first exactly as today. The
  protocol below is shaped so a registry keyed by session name can be added later
  without changing the extension again.
- Per-command or per-site grants beyond the existing host allowlist. The switch is
  on/off (with an expiry). A read-only level is listed under Later.
- A native messaging host for the Docker layout. The token is pasted once.
- Token rotation from the CLI. Delete `/data/token` and restart.
- Changing what commands exist or how they execute.

## Anti-goals

- No path from the container to a granted state. No CLI command, no server message,
  no protocol field the extension would honour as a grant. The extension only ever
  *reports* its state to the server; it never *reads* access from it.
- A revoked session must never run a command, including one already queued in the
  server, one that arrives during the revoke, or the next tick of a polling command.
- Revoke must not depend on the server being alive or honest. If the socket is dead
  or the server ignores the `access` message, commands are still refused in the
  extension.
- No silent fallback to "granted": storage read failures, a missing field, an
  unparseable expiry — all read as revoked.
- The published port must never be bound on anything but the host's loopback in any
  file this repo ships.

## Trust model

```
trusted (PC): Chrome, extension, Options page, popup, allowlist, access state
boundary:     ws://127.0.0.1:8765 published from the container (token-authenticated)
untrusted:    container = relay server, CLI, agent, model sessions, channels daemon
```

The token authenticates *the container* to the extension. It does not authorise
anything by itself: the extension checks access and the allowlist on every command.
The server's view of access exists only to give the CLI a fast, readable error and
to let the agent fail before starting a model. The extension's decision is final.

## Protocol

Today, after `{type:"auth"}` the server sends `{type:"auth",ok:true}` and the
extension waits for `{type:"command"}` messages. Additions:

**Extension → server**, once per connection right after `auth ok`, and again on every
change:

```json
{ "type": "access", "session": "work-chrome", "granted": true, "until": 1763700000000 }
```

- `session` — the user-chosen name (Options; default `"chrome"`; 1–40 printable chars,
  the server truncates and strips control characters before logging).
- `granted` — boolean. `until` — epoch ms, present only for a timed grant.

Every command the extension executes still goes through its own check; this message
is advisory for the server.

**Server behaviour:**

- Keeps `access = { session, granted, until }` for the current extension socket; resets
  to `{ granted:false }` when the extension disconnects.
- A CLI `request` while `granted === false`, or while `until` is in the past, is
  answered without forwarding:
  `{ ok:false, error:"access revoked by user (session \"work-chrome\")" }`
  (`"access not granted (session …)"` when no `access` message has arrived yet). A
  request while no extension is connected keeps today's `extension not connected`.
- Expiry: the server treats a past `until` as revoked on its own, so a dead extension
  socket that never sent the flip still stops at T. The extension does the same
  locally with an alarm.
- `ping` and `status` are handled as today (forwarded) but the server merges
  `session` and `access` into the result: `{"pong":true,"version":…,"session":"work-chrome","access":"granted"|"revoked","until":…}`.
  `status` likewise. These two commands are **always** forwarded, even while
  revoked, so the user can see connection state — the extension answers them without
  touching any tab.
- Log line on each flip: `access granted (session "x", until …)` / `access revoked (session "x")`.

**Server bind:** `BRIDGE_HOST` (default `127.0.0.1`). The startup line prints the
actual bind. A bind on anything other than `127.0.0.1`/`::1` prints one warning:
`listening on 0.0.0.0 — make sure only the host's loopback can reach this port`.

**CLI:** new optional `BRIDGE_HOST` for the connect address (default `127.0.0.1`),
for the split layout where the CLI runs in another container; unused by the compose
file in this spec (the daemon shares the relay's network namespace). `cli.js` maps
the two access errors to exit code **6** so scripts can tell "revoked" from "down".

**Agent (`bridge agent`) and channel runs:** the pre-flight `ping` already fails fast
when the server or extension is down. It now also fails fast when `access` is not
`granted`, with the server's message, before any model is started. A run already in
flight sees the error on its next command and ends as a failed run (the ladder does
not climb on an access error — retrying with a stronger model cannot help).

The channels daemon reports the session name and access state in `/status`, and
answers a task sent while revoked with the same one-line error instead of queueing it.

## Extension

**Storage** (`chrome.storage.local`), new keys next to `token`, `port`, `allowlist`:

```
sessionName: "chrome"          // Options
access: { granted: false, until: 0 }   // popup / Options; absent = revoked
```

Reads go through one function `getAccess()` that returns `granted:false` on any
error, missing key, non-boolean `granted`, or `until` that is not a finite number.
A timed grant is `granted:true, until:T`; it is live only while `Date.now() < T`.

**Enforcement.** `handle(cmd, params)` begins with:

```
if (cmd !== "ping" && cmd !== "status") await assertAccess();   // throws "access revoked"
```

`assertAccess()` reads storage every time (no cached flag — the service worker can be
restarted and the popup writes storage directly). Polling commands (`waitFor`, the
`type` per-character loop, `scroll` with retries) call `assertAccess()` on every tick,
so a revoke stops them within one interval.

**Revoke** (popup, Options, or the expiry alarm):

1. Write `access:{granted:false}`.
2. `detachAll()` — same code path as the CLI command: release `chrome.debugger` on every
   attached tab, clear the frame and favicon badge.
3. Send `{type:"access", session, granted:false}` if the socket is open.
4. Update the badge (grey, no text).

**Grant** (popup or Options): write `access:{granted:true, until}`, create a
`chrome.alarms` alarm `access-expiry` at `until` if set (the alarm handler runs the
revoke steps), send the `access` message, badge green (`ON`, or the remaining hours
`2h` for a timed grant, refreshed by the reconnect alarm).

**Socket lifecycle.** The socket stays open while revoked. The user can re-grant
without waiting for the 24-second reconnect alarm, and `ping`/`status` keep working
so the popup can show "connected". On `auth ok` the extension sends the current
`access` message before anything else. On every reconnect it is sent again, so the
server never holds a stale "granted" from a previous socket.

**Popup** (`action.default_popup = popup.html`, new file, same plain style as
Options): session name, connection state (connected / server not running /
not provisioned), access state with remaining time, and three buttons — **Grant**,
**Grant for 1 h**, **Revoke**. Nothing else; the allowlist and token stay in Options.
The badge is the always-visible version of the same state.

**Options**: a **Browser session name** field; the same Grant / Revoke buttons; a
hint that the default after install is revoked.

**Default**: on install, `access` is absent, so revoked. A grant persists across
browser restarts (storage), so a timed grant is the recommended way to leave an agent
running; the Options hint says so.

## Container

- `Dockerfile` at the repo root, `deploy/docker/compose.yml`, as written in
  `docs/DOCKER.md`. The image runs as the `node` user, root fs read-only, `/tmp` tmpfs,
  all capabilities dropped, no new privileges, pids and memory limited.
- `AI_BRIDGE_HOME=/data` (existing env var) puts token, log, journal, traces, channels
  config and session dirs on one named volume. `/home/node` is a second named volume
  for the `claude` and `codex` logins.
- `AI_BRIDGE_DEBUGGER=1` in the image: no TTY exists to answer the prompt. The
  host-side gate for debugger use is the access switch plus the banner Chrome shows.
- Healthcheck tests that port 8765 accepts a TCP connection. It must not use `ping`
  (needs the extension) or the container would never become healthy before the user
  pastes the token.
- The channels service uses `network_mode: service:bridge` so its CLI reaches the relay
  on 127.0.0.1 without a second published port and without `BRIDGE_HOST` on the CLI.
- No `/var/run/docker.sock`, no host network, no bind mount of the Chrome profile or
  the home directory.

## Tests

- `test/protocol.test.js`: a simulated extension sends `access granted`, CLI request is
  forwarded; sends `access revoked`, CLI request gets `access revoked by user (session
  "x")` and the extension receives nothing; `until` in the past is treated as revoked
  without a message; `ping`/`status` are forwarded while revoked and carry `session` and
  `access`; reconnect without an `access` message → `access not granted`.
- `test/cli.*`: exit code 6 on the two access errors.
- `test/agent.test.js`: pre-flight fails on `access revoked` before any model spawn (the
  existing fake-ping hook); a mid-run access error does not climb the ladder.
- Server bind: start with `BRIDGE_HOST=0.0.0.0` on a random port in the test, connect
  from `127.0.0.1`; with the default, confirm the bind address in the startup line.
- Extension: no automated harness exists (plain MV3, loaded unpacked). Add rows to
  `test/TEST-PLAN.md` for: revoke during a `waitFor` stops within one tick; revoke
  detaches the debugger and clears the banner; expiry alarm fires after the service
  worker was restarted; a `grant` written by the popup takes effect on the next command
  without a reload.
- Docker: `docker compose config` validates the file in CI; a smoke job builds the
  image and asserts `listening on ws://0.0.0.0:8765` in the logs and that the healthcheck
  turns healthy. A full round trip needs a Chrome with the extension and stays manual.

## Later

- Registry of browser sessions keyed by name; `--session <name>` /
  `AI_BRIDGE_SESSION`; default = the only connected session, error listing names when
  several are connected. `tabId` values are per browser, so the session must be part of
  every request's routing, never inferred from a tab id.
- Access levels: `read` (listTabs, eval, snapshot, screenshot, waitFor) vs `act`
  (click, type, insertText, key, navigate, download, closeTab) vs `debugger`. The popup
  would grant one level; the extension maps each command to a level.
- `bridge token --rotate`: regenerates the token, prints the new one, drops the current
  extension socket.
- Grant notifications: the daemon tells the Telegram chat when access is granted or
  revoked, so the phone side knows why a task failed.
- A tiny native host for the Docker layout that only reads the token from a mounted
  file (never starts anything), so the paste step goes away.

## Open questions (builder decides unless marked)

- Where the expiry countdown lives on the badge (text `2h` vs colour only). Builder's call.
- Whether `status` while revoked should still list attached tabs (there are none after
  a revoke, so probably moot). Builder's call.
- Should a grant survive the extension being updated/reloaded? Storage survives a
  reload, so yes by construction; document it.
