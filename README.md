# AI Browser Bridge

A minimal, open-source bridge that lets an **AI coding agent** (Claude Code, or any local
tool that can run a shell command) drive **your real, logged-in browser** — safely, on
localhost, with no cloud in the loop.

Born from a practical problem: an AI agent working in a terminal needed to download email
attachments, fill review forms, and drive web editors on sites the user was logged into.
OS-level input synthesis is platform-bound, steals window focus, and its
synthetic events are rejected by CSP-strict web apps and rich-text editors. This bridge
fixes all of that with three small pieces:

```
AI agent / your scripts          bridge server               Chrome extension
   `bridge <cmd>` CLI  ⇄  ws://127.0.0.1:8765 (token)  ⇄  service worker (MV3)
                                                             │ chrome.tabs / scripting
                                                             │ chrome.debugger  → trusted input, CSP-proof eval
                                                             │ chrome.downloads → authenticated downloads
```

## Why the `chrome.debugger` route matters

- **Trusted input.** `Input.dispatchMouseEvent` / `Input.insertText` produce events with
  `isTrusted: true` — rich editors (contenteditable, ProseMirror- and Slate-class apps) accept
  them where synthetic DOM events are ignored.
- **CSP-proof eval.** `Runtime.evaluate` works on pages whose Content-Security-Policy
  blocks injected `eval`.
- **No focus stealing.** Everything runs in background tabs (`newTab` opens with
  `active:false`); your work is never interrupted.
- **Your sessions, no re-login.** The extension lives in your normal profile, so webmail,
  dashboards, internal tools — anything you're logged into — just work. This also sidesteps
  Chrome 136+'s restriction on `--remote-debugging-port` with the default profile.
- **Cross-platform.** macOS, Windows, Linux — no OS-level input scripting or
  accessibility APIs required.

## Stealth by default, debugger on approval

By default every command runs in **stealth mode**: the bridge drives the tab
*without* attaching `chrome.debugger`, so there's no CDP fingerprint and no
"… is debugging this browser" banner. `eval` runs via `chrome.scripting` in the
page's MAIN world; `click`/`type`/`insertText`/`key` are emulated with synthetic
DOM events. This is what you want on sites that fight automation — at the cost of
untrusted events (`isTrusted: false`) and MAIN-world eval being subject to the
page's own CSP.

When you need the `chrome.debugger` route — trusted input, CSP-proof eval, `pdf`,
or background-tab screenshots — request it per command with **`--debugger`**
(alias `--no-stealth`). Because attaching the debugger shows the browser banner,
it requires **approval**, resolved in this order:

1. `--debugger` flag on the call — pre-approved (works headless).
2. `AI_BRIDGE_DEBUGGER=1` in the environment — pre-approved (works headless).
3. Otherwise, if stdin is a TTY — an interactive `y/N` prompt.
4. Needed but not approved and no TTY — the command **fails fast** (exit 5)
   rather than silently attaching or hanging.

`pdf` and background-tab `screenshot` are CDP-only, so they always need approval.
(`--stealth` still exists as a legacy no-op, since stealth is now the default.)

## Install

Short version (full first-time walkthrough with troubleshooting, background
service templates and Windows notes: **[docs/INSTALL.md](docs/INSTALL.md)**):

1. **Server** (Node ≥ 18):
   ```bash
   git clone https://github.com/legisus/ai-bridge.git && cd ai-bridge
   npm install
   npm start          # generates ~/.ai-browser-bridge/token on first run (chmod 600)
   ```
2. **Extension:** open `chrome://extensions` → enable *Developer mode* → *Load unpacked* →
   select the `extension/` folder.
3. **Provision:** on the extension card click *Details* → *Extension options*, paste the
   token from `~/.ai-browser-bridge/token`, save. The service worker connects on save
   (and retries every ~24 s on its own).
4. **Smoke test:**
   ```bash
   node server/cli.js ping
   # {"pong":true,"version":"0.1.9"}
   ```
   `connect failed` = server not running; `extension not connected` = token not saved
   or wrong — re-save Options, wait 30 s, retry.
5. **Keep it running:** copy the template from `deploy/launchd/` (macOS) or
   `deploy/systemd/` (Linux), fix the paths, load it. See INSTALL.md §7.

## Usage

```bash
bridge() { node /path/to/ai-bridge/server/cli.js "$@"; }

bridge listTabs
bridge newTab   '{"url":"https://example.com"}'               # opens in background
bridge newTab   '{"url":"https://example.com","newWindow":true}'  # own unfocused window (isolates activateTab)
bridge eval     '{"tabId":123,"code":"document.title"}'
bridge eval     '{"tabId":123}' --file scrape.js              # long scripts from a file
bridge click    '{"tabId":123,"x":420,"y":310}'               # trusted click at CSS px
bridge click    '{"tabId":123,"selector":".submit-btn"}'      # …or click an element by selector (no pixel math)
bridge insertText '{"tabId":123,"text":"Hello"}'              # trusted "paste" at caret
bridge type     '{"tabId":123,"text":"hello"}'                # real per-char keystrokes (autocomplete/React widgets)
bridge key      '{"tabId":123,"key":"Enter"}'
bridge key      '{"tabId":123,"key":"v","modifiers":4,"commands":["paste"]}'  # native paste from the clipboard
bridge waitFor  '{"tabId":123,"selector":"#results"}'         # poll until an element appears
bridge waitFor  '{"tabId":123,"code":"document.readyState==='"'"'complete'"'"'"}'  # …or a JS condition
bridge scroll   '{"tabId":123,"bottom":true}'                 # also: {selector}, {top}, {dx,dy}
bridge download '{"url":"https://.../file.pdf","filename":"file.pdf"}'   # uses your cookies
bridge pdf      '{"tabId":123}' --out page.pdf
bridge screenshot '{"tabId":123}' --out page.png
bridge selectTab '{"tabId":123}'                              # activate tab, don't focus its window
bridge activateTab '{"tabId":123}'                            # activate tab AND bring its window to front
bridge status                                                 # version + which tabs are attached
bridge closeTab '{"tabId":123}'
bridge detach   '{"tabId":123}'                               # release debugger + clear the tab indicator
bridge detachAll                                              # release every attached tab in one call
```

For an AI agent, the contract is simple: every command is one shell invocation that
prints JSON to stdout and exits non-zero on failure.

## Agent mode — hand it a whole task

Instead of driving the bridge command-by-command, you can hand it a complete task
and let the built-in **token-saver agent** do the driving:

```bash
bridge agent "open https://example.com and report the page title and first heading"
bridge agent "…" --timeout 600000 --verbose
```

It spawns headless Claude Code sessions (`claude -p`) and walks an escalation
ladder: a cheap model attempts the task first, a strong model judges the evidence,
and only on failure does a stronger model retry —

```
ops: Haiku 4.5  → judge (Fable 5) → pass? done
ops: Sonnet 5   → judge (Fable 5) → pass? done
ops: Fable 5    → judge (Fable 5) → final verdict
```

The judge only ever sees the task plus the ops session's short evidence report —
never the full browsing transcript — so the expensive model's token spend stays
minimal. The command prints the verdict, the evidence report, and a per-stage
token/cost summary, and exits 0 only on a pass.

Requirements & notes:

- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code) must be
  installed and logged in** — usage bills to your existing Claude subscription.
- The agent pings the bridge before spending any model tokens, and fails fast if
  the server or extension is down.
- Give it a complete, self-contained task description: URLs, credentials context
  ("I'm already logged in"), and what "done" looks like.
- Default timeout is 10 minutes per stage (`--timeout` is in ms).
- The ops sessions are confined to bridge CLI calls (`--allowedTools`), and a
  recursion guard stops them from invoking `bridge agent` themselves.

## Concurrency

The server is a many-CLI → single-extension relay. Any number of CLI clients can
connect at once; each request carries a random id and its response is routed back to
the CLI that sent it, so concurrent clients never cross wires.

The scaling axis is **tabs, not throughput** — everything funnels through one browser
and one extension. The rule that keeps concurrency safe:

- **One CLI per tab.** Driving N *different* tabs from N parallel CLI calls works
  cleanly — each tab attaches its own debugger session independently.
- **Don't point two clients at the same tab.** Concurrent trusted input (`click`,
  `insertText`, `key`) on one tab interleaves into garbage, and — before v0.1.2 —
  simultaneous *first* commands on a not-yet-attached tab could race the debugger
  attach (`Another debugger is already attached`). v0.1.2 dedupes that attach, but
  same-tab writes are still logically single-writer: serialize them.

## Use from Claude Code

See **[docs/CLAUDE-CODE.md](docs/CLAUDE-CODE.md)** for a copy-paste `CLAUDE.md`
block that teaches Claude Code every command, plus permission and troubleshooting
notes. Once added, you can ask things like *"open the dashboard tab and screenshot
the error"* and the agent composes the CLI calls itself.

## Security model

Read this before installing — the extension can act as *you* on any site you're logged into.

- The server binds **127.0.0.1 only**; nothing is reachable from the network.
- Every client must present the **token** from `~/.ai-browser-bridge/token`
  (created `chmod 600`). Without it, sockets are dropped.
- Optional **host allowlist** (extension Options): restrict commands to named domains
  and their subdomains. Empty list = allow all — set it if you want defense in depth.
- Every command is **logged** to `~/.ai-browser-bridge/bridge.log`.
- Commands run in **stealth mode by default** (no debugger, no banner). The
  `chrome.debugger` route is opt-in via `--debugger` and gated behind approval —
  see [Stealth by default, debugger on approval](#stealth-by-default-debugger-on-approval).
- Chrome shows its native **"… is debugging this browser"** banner whenever the
  debugger is attached — so whenever you *do* approve `--debugger`, you always see
  that trusted-input mode is active. Clear it with `detach` (one tab) or
  `detachAll` (every attached tab). Idle tabs also auto-detach after `idleDetachMs`
  (default 2 min; set in Options), so banners never pile up. (The banner is
  browser-enforced and can't be hidden from an extension; that's the point.)
- **Per-tab activity indicator** (on by default, toggle in Options): a thin neon
  frame with colors flowing around the page edge, plus a small color-shifting glow
  badge on the tab's favicon, mark exactly which tabs the agent is driving —
  finer-grained than the global banner. The original favicon is restored and the
  frame removed on `detach`.
- No analytics, no telemetry, no external requests of any kind.

## Test

```bash
npm test    # spins up the server, a simulated extension, and the real CLI; asserts round-trips
```

## Project layout

```
extension/    Manifest V3 extension (service worker + options page)
server/       relay server (server.js), CLI client (cli.js), token-saver agent (agent.js)
deploy/       launchd / systemd templates to run the server as a background service
docs/         INSTALL.md (first-time setup) and CLAUDE-CODE.md (Claude Code integration)
test/         protocol round-trip test with a simulated extension
```

## Contributing

Improvements welcome — new CDP-backed commands, a Firefox port, reliability fixes.
See **[CONTRIBUTING.md](CONTRIBUTING.md)** for dev setup, the two-layer test
suite, and the security ground rules every PR must preserve.

## License

MIT © 2026 [Mykola Bielousov](https://scholar.google.com/citations?user=dOwVd0sAAAAJ)
