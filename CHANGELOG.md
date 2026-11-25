# Changelog

## 0.1.11 — access switch, target guard, tab hygiene, Docker (PRs #12–#15, November 2026)

Four stacked pull requests implement the Docker-isolated design (`docs/DOCKER.md`,
design in `docs/superpowers/specs/2026-11-21-docker-isolated-access-design.md`).
Each was reviewed by Codex `gpt-6-astra` before it was ready.

### What's new

**You grant and revoke the bridge's access to Chrome** (PR #13)
- Toolbar popup with **Grant**, **Grant for 1 h**, **Revoke**, **Revoke and close
  agent tabs**, **Close agent tabs**, the connection state, the remaining time and
  the recent events. Options gains the **browser session name**, **Manual mode**
  (a pasted token is never overwritten by the native host) and the same buttons.
- The service worker is the only writer of the access state and checks it on every
  command and before every browser operation. A revoke stops work in flight,
  releases the debugger from every tab (including attachments still in progress),
  cancels bridge downloads, and, with "Revoke and close agent tabs", closes the tabs
  the agent opened. Timed grants expire on their own.
- After every install, update or extension reload the bridge starts **revoked**.
  A grant survives browser restarts.
- `bridge agent` checks the relay before every model spawn and every 10 s while a
  model runs; a revoke, a re-grant, a relay restart or another extension taking the
  connection ends the run with `access_revoked` (exit 8). No ladder climb.

**Only http(s) pages on allowed hosts are ever a target** (PR #14)
- `chrome://`, the extension's own pages, `file:`, `javascript:`, `data:`,
  `view-source:` are refused as destinations and as current targets, whatever the
  allowlist says. Every command re-reads its tab and runs only in the document it
  validated (direct mode: `documentIds`; debugger mode: the validated execution
  context, loader check right before each input/capture). A page that navigated
  underneath fails with `target changed`.
- The allowlist applies to every target: `newTab`/`navigate`/`download`
  destinations, `closeTab`/`selectTab`/`activateTab`, every `waitFor` tick.
  `listTabs` lists tabs you cannot target as `{id, url: "redacted"}`.
- Event log: the last 200 events (connect, grant, revoke, refused, tab/download
  lifecycle, attach/detach) in the popup, and `bridge status --events` for a
  redacted view from the CLI.

**Tabs no longer leak; every request is traceable** (PR #12)
- The relay keeps a registry of every tab the bridge opened (`tabs.json`: who, when,
  which run, which Chrome session, origin). An agent run's tabs are closed when the
  run ends or its process dies (`--keep-tabs` or "leave the tab open" in the task to
  keep them); only tabs the extension itself opened are ever closed, never a window.
- `bridge tabs` lists them; `bridge closeTabs --mine | --run <id> | --older-than <min>`
  closes them. Journal records carry `tabsOpened/tabsClosed/tabsRetained/keptTabs`.
- Every CLI failure prints `ERROR: <reason> (req <id>)` and a JSON line
  `{"error","reqId"}`; the relay log has one `cmd` and one `done|refused|cancelled`
  line per request with the request id, the client label (`AI_BRIDGE_CLIENT`,
  default the calling process name) and the run id; `bridge journal --trace`
  shows the same ids. `BRIDGE_BIND` sets the relay's listen address.

**Docker** (PR #15)
- `Dockerfile`, `deploy/docker/compose.yml`, `deploy/docker/.env.example`,
  `.dockerignore`: the relay and the agent in a hardened container (uid 1000,
  read-only root, no capabilities, loopback-only publish), Chrome and the
  extension stay on the host. `AI_BRIDGE_CODEX_SANDBOX=container` runs Codex
  without its own sandbox inside it.
- `test/docker-smoke.sh` (passes on macOS with Colima, arm64; pinned
  `claude` 2.1.317 and `codex` 0.171.0) and `test/docker-roundtrip.sh` (the real
  extension talking to the containerised relay).

### How to use it

1. **Update and grant.** Pull, restart the relay, reload the extension at
   `chrome://extensions`, click the extension icon, press **Grant**. `bridge ping`
   now shows `"access":"granted"`. Until you grant, every command except `ping`
   and `status` is refused with exit 8.
2. **Stop the agent at any time.** Press **Revoke** (or **Revoke and close agent
   tabs**). Running commands fail within one step; a running `bridge agent` ends
   with `access_revoked`. Press **Grant** again when you want it back; **Grant for
   1 h** for unattended runs.
3. **See what the bridge opened.** `bridge tabs`; close with
   `bridge closeTabs --mine`, `--run <id>` or `--older-than 60`.
4. **Debug a failure.** Take the `(req <id>)` from the error, `grep` it in
   `~/.ai-browser-bridge/bridge.log` (or `bridge journal --trace <runId>` for an
   agent run), and look at `bridge status --events` or the popup's "Recent events"
   for the extension's side.
5. **Run it in Docker on a PC.** Follow `docs/DOCKER.md` "Setup, step by step";
   `bash test/docker-smoke.sh` checks the container, `bash test/docker-roundtrip.sh`
   checks it against your real Chrome (it stops the host relay briefly and restores it).

### Upgrade notes

- The relay refuses everything except `ping`/`status` until an extension that
  sends the access message connects and the user has granted: after updating the
  server, reload the extension and grant once.
- `closeTab` on a tab the bridge did not open is now subject to the allowlist and
  the privileged-origin block; `listTabs` redacts tabs outside the allowlist;
  `navigate` on a non-blank privileged tab is refused.
- Restricted (messenger) runs cannot use `tabs`, `closeTabs`; their env now passes
  `AI_BRIDGE_HOME`, `AI_BRIDGE_DEBUGGER`, `AI_BRIDGE_CODEX_SANDBOX`, `AI_BRIDGE_CLIENT`.
- Extension permissions gained `webNavigation` (same install warning as `tabs`).
