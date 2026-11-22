# Docker-isolated agent with host-side access control — design

**Status:** design, 2026-11-21, revised the same day after the Codex `gpt-6-astra`
review (30 findings folded in; the review text is not part of the repo). Ships as the
`docker-isolated` branch on top of the channels chain (`feat/channels-core` →
`fix/intent-gate-expiry`). User-facing guide: `docs/DOCKER.md`. Builds on the relay
protocol in `server/server.js`, the extension's `handle()` in
`extension/background.js`, the agent supervisor in `server/agent.js` and the channels
daemon in `server/channels/`.

## Intent

Run everything that holds a model (the relay, `bridge agent`, the channels daemon, an
interactive Claude Code) inside a Docker container on the user's PC, while Chrome and
the extension stay on the PC. The container owns nothing on the PC except the volumes
it is given. The user controls, from the browser, whether the container may drive
Chrome at all: **grant** and **revoke** access to that browser session, with the
decision enforced on the PC side, not in the container.

Why now: the agent runs as the user with the user's whole file system and shell, and
the messenger daemon runs unattended. Isolating the model behind one socket, with a
switch the model cannot flip, is the smallest change that makes unattended operation
defensible.

## Goals

- The relay can bind an address other than loopback so a published container port
  reaches it; the loopback-only promise is kept by the port mapping instead.
- The extension has an **access switch** per browser session: granted, granted until
  a time, revoked. Revoke takes effect on the next step of every command, including
  commands already running or queued, releases the debugger everywhere, cancels
  bridge-started downloads, and cannot be undone from the CLI, the server, the
  container or a page.
- The extension refuses **privileged targets** (`chrome://`, `chrome-extension://`,
  `edge://`, `brave://`, `about:`, `devtools://`, `file://`, `view-source:`) for every
  command, so a granted agent cannot reach the extension's own pages and storage.
- The **allowlist** applies to every command's target, including destinations, and
  is re-checked during long-running commands.
- The server and CLI surface the access state (`ping`, `status`) and refuse CLI
  requests with a typed error while revoked. `bridge agent` and channel runs check it
  before every model start and stop their children when it is lost.
- A browser session has a **name**, chosen by the user in Options, that appears in
  errors and status.
- A Dockerfile and compose file that run the relay, the agent and the daemon as a
  non-root user with a read-only root file system.

## Non-goals (v1)

- Several browser sessions on one relay. The relay keeps its single extension socket;
  a second authenticating extension supersedes the first exactly as today. The
  protocol is shaped so a registry keyed by session name can be added later without
  changing the extension again.
- Grant levels finer than on/off with an expiry. A read-only level is under Later.
- Undoing page effects. Code already injected into a page (timers, workers, pending
  requests) and forms already submitted are outside the extension's control once
  started. Revoke stops the bridge; "revoke and close agent tabs" removes the pages.
- Restricting what pages themselves request. The allowlist is about which top-level
  tabs the bridge may touch, not about a page's own network traffic.
- A native messaging host for the Docker layout. The token is pasted once.
- Token rotation from the CLI. The procedure is `down -v` and re-paste.

## Anti-goals

- No path from the container, the server or a page to a granted state. No CLI
  command, no server message, no protocol field the extension would honour as a
  grant, and no reachable extension page. The extension only *reports* its state to
  the server; it never *reads* access from it.
- A revoked session must never execute a browser operation after the revoke: not a
  queued screenshot, not the completion of an attach that was in flight, not the next
  tick of a poll, not the next character of a `type`.
- Revoke must not depend on the server being alive or honest.
- No silent fallback to "granted": storage read failures, a missing record, a
  malformed `until` all read as revoked.
- The published port must never be bound on anything but the host's loopback in any
  file this repo ships.

## Trust model

```
trusted (PC): Chrome, extension service worker, Options page, popup, allowlist, access record
boundary:     ws://127.0.0.1:8765 published from the container (token presented by the extension)
untrusted:    container = relay server, CLI, agent, model sessions, channels daemon; every web page
```

The extension presents the token to whatever listens on the port; the server checks
it. The token therefore identifies the container to the extension, and any process
on the PC that binds the port first would receive it (unchanged from today; the guide
makes removing a host-side relay a prerequisite). The token authorises nothing by
itself: the extension checks access, the privileged-origin block and the allowlist on
every command. The server's view of access exists only to give the CLI a fast error
and to let the agent fail before starting a model. The extension's decision is final.

Pages are untrusted too: a page the agent opened can be hostile, and the agent's own
`eval` runs arbitrary code in it. That is why the extension's own origin is blocked
for every command, not only `newTab`/`navigate`.

## Wire contract (canonical)

Today, after `{type:"auth"}` the server sends `{type:"auth",ok:true}` and the
extension waits for `{type:"command"}` messages. One message type is added, two
fields are merged into two results, and two error codes are defined. Both documents
use only these.

**`access`, extension → server.** Sent once right after `auth ok` (before the
extension accepts any command on that socket) and again on every change:

```json
{ "type": "access", "session": "work-chrome", "granted": true, "until": null }
```

- `session` — the user-chosen name (Options; default `"chrome"`; 1–40 printable
  characters; the server truncates and strips control characters before logging).
- `granted` — boolean.
- `until` — `null` for an indefinite grant, a finite epoch-ms number in the future
  for a timed grant. Any other shape (missing, `0`, NaN, string) means **revoked**.
  The same normalisation function is used in extension storage, on the wire and in
  the server.

**Errors.** Two error strings the CLI recognises verbatim, prefixed by a code:

```
access_revoked: access revoked by user (session "work-chrome")
access_not_granted: access not granted yet (session "work-chrome")
```

The extension's own refusal (if a command somehow reaches it) uses the same
strings. The CLI exits **8** on either (codes 1–7 are taken: 1 command error, 2
usage, 3 timeout, 4 connect failed, 5 debugger not approved, 6 no token, 7
restricted-run violation).

**Results.** `ping` and `status` are always forwarded to the extension, even while
revoked (they touch no tab), and the server merges `session`, `access`
(`"granted"` | `"revoked"` | `"not_granted"`) and `until` into the result:

```json
{"pong":true,"version":"0.1.11","session":"work-chrome","access":"granted","until":null}
```

**Server bind.** `BRIDGE_BIND` (default `127.0.0.1`) is the listen address. The CLI
keeps connecting to `127.0.0.1:BRIDGE_PORT`; no client-side variable is added in v1.
The startup line prints the actual bind; a non-loopback bind appends
`— make sure only the host's loopback can reach this port`. The line is printed from
the server's `listening` event, not before it.

## Server

- Each extension socket gets a **generation** number when it authenticates. Access
  is reset to `not_granted` at that moment (not on the old socket's close, which the
  current code deliberately ignores for superseded sockets). `access` and `response`
  messages are accepted only from the current generation.
- Pending requests are tagged with the generation that received them. On extension
  disconnect or supersession every pending request of that generation is answered
  `extension disconnected`. On an `access` flip to revoked every pending request is
  answered `access_revoked` (the extension will refuse them anyway; the CLI should
  not wait for that).
- A CLI `request` other than `ping`/`status` while access is not `granted`, or while
  `until` is a number in the past, is answered without forwarding. The server
  evaluates `until` itself on every request, so a dead extension socket that never
  sent the flip still stops at T.
- Log line on each flip: `access granted (session "x", until …)` /
  `access revoked (session "x")`, and one on supersession:
  `extension superseded (gen N → N+1)`.

## Extension

### Storage

New keys in `chrome.storage.local` next to `token`, `port`, `allowlist`,
`provisionedBy`:

```
sessionName: "chrome"                          // Options
manualMode:  true | false                      // Options; true = never call the native host
access:      { granted: bool, until: null | number, gen: number }   // written by the worker only
```

`readAccess()` normalises: anything not matching the shape is `{granted:false}`. A
timed grant is live only while `Date.now() < until`.

### Single writer, revocation generation

The service worker is the only writer of `access`. The popup and the Options page
send `chrome.runtime.sendMessage({type:"access-set", granted, until, closeTabs})`;
the worker validates the sender is one of its own pages (`sender.id ===
chrome.runtime.id` and a `chrome-extension://` origin), serialises the transition
through one promise chain, writes storage, and only then acts.

Every grant and every revoke increments an in-memory `accessGen`, also persisted in
the record. Every command captures `gen = accessGen` when it starts; `assertAccess(gen)`
throws `access_revoked` if `accessGen !== gen` or the stored record is not live. The
check runs:

- at the start of `handle()` for every command except `ping` and `status`;
- **after every `await`** that precedes a browser operation (`chrome.tabs.*`,
  `chrome.debugger.*`, `chrome.scripting.*`, `chrome.userScripts.*`,
  `chrome.downloads.*`), including inside `pacedCapture()`'s queue before each
  capture, inside `waitFor` on every tick, and inside `dbgAttach()` after the attach
  promise resolves;
- in the per-character loop of `type`, which moves out of the page into the worker
  (one `Input.dispatchKeyEvent` / synthetic event per character from the worker,
  with the check between characters) so a revoke stops it mid-word.

`assertAccess` reads storage every time; a cached flag would survive a service-worker
restart with a stale value.

### Revoke (popup, Options, expiry alarm, or startup reconciliation)

1. `accessGen++`; write `access:{granted:false, until:null, gen}`.
2. Cancel every download the bridge started in this grant (`chrome.downloads.cancel`
   on the ids recorded by the `download` command).
3. Detach: for every tab in `attached` **and** every in-flight promise in
   `attaching`, await the attach if pending, then `chrome.debugger.detach`; clear the
   frame and favicon badge. A late attach completion that finds `accessGen` moved
   detaches itself before returning.
4. If `closeTabs`, close every tab recorded in `agentTabs` (ids returned by `newTab`
   during this grant).
5. Send `{type:"access", session, granted:false, until:null}` if the socket is open.
6. Badge grey, no text. Clear the `access-expiry` alarm.

### Grant

1. `accessGen++`; write `access:{granted:true, until, gen}`; reset `agentTabs`.
2. Clear any existing `access-expiry` alarm, then create one at `until` if set. The
   alarm's handler re-reads the record and revokes only if the record's `gen` still
   matches, so a stale alarm from an earlier grant cannot revoke a renewed one.
3. Send the `access` message. Badge green: `ON`, or the remaining time (`2h`, `45m`)
   for a timed grant, refreshed by the existing reconnect alarm.

Deadline checks in `assertAccess` and in the server are authoritative; the alarm is
only the thing that flips the badge and detaches on time. On worker startup the
record is reconciled: a past `until` is revoked immediately.

### Privileged-origin block

`assertTarget(url)` throws `privileged target refused` for any URL whose scheme is
not `http:` or `https:`. It runs on: the destination of `newTab`, `navigate` and
`download`; the current URL of the tab for every other command (fetched fresh, not
from the caller); every frame before `scripting.executeScript`,
`userScripts.execute` or `debugger.attach`. The allowlist cannot override it: `*`
still means "any http(s) host". `listTabs` reports such tabs with `url:"redacted"`
and no title.

### Allowlist on every target

`assertAllowed` gains a URL form and is applied to: `newTab` and `navigate`
(destination), `download` (URL), `closeTab`, `selectTab`, `activateTab` (the tab),
`waitFor` (on every tick, re-reading the tab's URL, so a redirect out of the
allowlist stops the poll), `screenshot` in direct mode (the tab must be the active
tab of its window at capture time; otherwise `tab not active` rather than capturing
whatever is in front). `listTabs` returns only tabs whose host is allowed, the rest as
`{id, url:"redacted"}` so tab ids stay usable for `closeTab`.

### Manual mode and reconnection

- `manualMode: true` (checkbox in Options, set automatically when a token is pasted)
  makes `provisionViaNativeHost()` a no-op. A native host's hello is ignored while
  manual mode is on.
- A `chrome.storage.onChanged` listener on `token` or `port` closes the open socket
  and calls `connect()`, so a changed token takes effect at once and an old server
  does not keep a live connection.
- The socket stays open while revoked: `ping`/`status` keep working so the popup can
  show "connected", and re-grant needs no reconnect. The `access` message is sent on
  every `auth ok`, so the server never carries a stale grant across reconnects.

### Popup and Options

`action.default_popup = popup.html`, same plain style as Options: session name,
connection state, access state with remaining time, and four buttons — **Grant**,
**Grant for 1 h**, **Revoke**, **Revoke and close agent tabs**. Options gains
**Browser session name**, **Manual mode**, and the same Grant/Revoke buttons, with
the hint that the default after install is revoked and that a grant survives
browser restarts.

## Agent and channel runs

- The pre-flight in `server/agent.js` parses `ping`'s stdout and requires
  `access === "granted"`; otherwise it fails with the server's message before any
  model is spawned.
- The supervisor (`runAgent`) repeats that check **before every model and judge
  spawn** (every rung, the classifier, the judge, the repair step). An access error
  ends the run with a structured terminal error `access_revoked`; the ladder does not
  climb (a stronger model cannot help).
- While a child model runs, the supervisor pings every 10 s; on `access_revoked` it
  aborts the child (the existing `signal`), records the run as failed with that
  error, and stops.
- Exit code 8 from the CLI inside the model's shell is informative to the model but
  not relied on; the supervisor's own pings are the mechanism.
- The channels daemon reports session name and access state in `/status`, answers a
  task sent while revoked with the one-line error instead of queueing it, and treats
  `access_revoked` from a running turn as a terminal error for that turn.

## Container

- `Dockerfile` at the repo root, `.dockerignore`, `deploy/docker/compose.yml`,
  `deploy/docker/.env.example`, as written in `docs/DOCKER.md`.
- The image runs as `node` (uid 1000). `/data` and `/work` are created and chowned
  to 1000 **before** `USER node`, so a fresh named volume inherits the ownership. The
  root file system is read-only, `/tmp` is tmpfs, all capabilities dropped, no new
  privileges, pids and memory limited, on both services.
- `WORKDIR /work`; every documented command uses the absolute `/app/server/...`
  path. `/work` is the one writable bind mount (scripts in, `--out` files out).
- `AI_BRIDGE_HOME=/data` holds token, log, journal, traces, channels config and
  session dirs. `/home/node` is a second named volume for the `claude` and `codex`
  logins.
- `AI_BRIDGE_DEBUGGER=1`: no TTY exists to answer the prompt. It pre-approves, it does
  not select, the debugger route.
- `AI_BRIDGE_CODEX_SANDBOX=container`: `runCodex()` passes
  `--dangerously-bypass-approvals-and-sandbox` instead of `-s workspace-write`
  (Codex's Linux sandbox needs namespaces/landlock that the hardened container
  denies). The flag is honoured only when the variable is set; the default stays
  `workspace-write`. Both CLIs are pinned in the Dockerfile.
- Healthcheck tests that port 8765 accepts a TCP connection; the channels service
  disables the inherited check.
- The channels service is behind `profiles: ["channels"]` and uses
  `network_mode: service:bridge`.
- Published port and work dir are parameterised (`BRIDGE_PUBLISH_PORT`,
  `BRIDGE_WORK_DIR`) so two compose projects can drive two browsers.
- Docker Engine 28+ is the documented floor (loopback publishing fix).
- No `/var/run/docker.sock`, no host network, no bind mount of the Chrome profile or
  the home directory.

## Tests

- `test/protocol.test.js` is first made hermetic: `AI_BRIDGE_HOME` pointed at a temp
  dir (it currently reads the real `~/.ai-browser-bridge/token`), a dynamic port
  instead of 8799, readiness taken from the server's `listening` line. Then: the
  simulated extension sends `access granted` → CLI request forwarded; `access
  revoked` → CLI gets `access_revoked`, extension receives nothing, a request that
  was pending is answered `access_revoked`; `until` in the past → treated as revoked
  with no message; `ping`/`status` forwarded while revoked and carrying `session`,
  `access`, `until`; a new extension socket authenticating while the old one is open
  resets access to `not_granted`, and an `access` message from the old socket is
  ignored; pending requests of the superseded socket get `extension disconnected`.
- `test/cli.*`: exit 8 on both access errors; the strings are matched verbatim.
- `test/agent.test.js` (the injected model runner): pre-flight with a stubbed `ping`
  returning `access:"revoked"` spawns no model; a run whose supervisor ping flips to
  revoked between rungs ends with `access_revoked` and does not climb; a child is
  aborted when the 10-s ping sees revoked.
- Server bind: start with `BRIDGE_BIND=0.0.0.0` on a dynamic port, connect from
  `127.0.0.1`, assert the warning suffix; with the default, assert the bind in the
  startup line.
- Extension: no automated harness exists (plain MV3, loaded unpacked). Rows for
  `test/TEST-PLAN.md`, run by hand: revoke during a `waitFor` stops within one tick;
  revoke during `type` stops mid-string; revoke while an attach is in flight ends
  with no tab attached and no banner; a queued direct screenshot after revoke is not
  captured; expiry alarm fires after a service-worker restart, and a late alarm does
  not revoke a renewed grant; a grant from the popup takes effect without a reload;
  `newTab` to `chrome-extension://<own id>/options.html` is refused with the
  allowlist empty and with `*`; `navigate` to a host outside the allowlist is refused
  by destination; `listTabs` redacts; changing the token in Options drops the old
  connection; a native host registered on the PC does not overwrite a pasted token in
  manual mode.
- Docker: `docker compose config` validates the file in CI; a smoke job builds the
  image, asserts the `listening on ws://0.0.0.0:8765` line, that the healthcheck turns
  healthy, that `/data/token` is created with mode 600 by uid 1000, that `--out` writes
  to `/work` succeed, and that `codex exec` can run one shell command under the exact
  compose restrictions with `AI_BRIDGE_CODEX_SANDBOX=container`. A full round trip
  needs a Chrome with the extension and stays manual.

## Later

- Registry of browser sessions keyed by name; `--session <name>` /
  `AI_BRIDGE_SESSION`; default = the only connected session, error listing names when
  several are connected. `tabId` values are per browser, so the session must be part
  of every request's routing, never inferred from a tab id.
- A read-only grant level made of commands that cannot change a page: `listTabs`,
  `snapshot`, `screenshot`, `waitFor` **by selector only**. Arbitrary JavaScript
  (`eval`, JS `waitFor`) is write-capable and stays out of it.
- `bridge token --rotate`: regenerates the token, prints the new one, drops the
  current extension socket.
- Grant notifications: the daemon tells the Telegram chat when access is granted or
  revoked, so the phone side knows why a task failed.
- A tiny native host for the Docker layout that only reads the token from a mounted
  file (never starts anything), so the paste step goes away.

## Open questions (builder decides unless marked)

- Badge text for a timed grant: remaining time vs colour only. Builder's call.
- Whether `agentTabs` should also include tabs the agent navigated (not only opened).
  Builder's call; opened-only is the minimum.
- Whether to keep the `type` loop in the page for direct mode and accept that a
  revoke lands between strings rather than between characters. The spec says move it;
  if that proves too slow for long strings, chunking by 20 characters with a check
  between chunks is acceptable.
