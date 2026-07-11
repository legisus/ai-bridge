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

## Install

1. **Server** (Node ≥ 18):
   ```bash
   npm install
   npm start          # generates ~/.ai-browser-bridge/token on first run (chmod 600)
   ```
2. **Extension:** open `chrome://extensions` → enable *Developer mode* → *Load unpacked* →
   select the `extension/` folder.
3. **Provision:** open the extension's *Options* page, paste the token from
   `~/.ai-browser-bridge/token`, save. The service worker connects within ~30 s
   (or immediately after you press *Save*).
4. **Smoke test:**
   ```bash
   node server/cli.js ping
   # {"pong":true,"version":"0.1.0"}
   ```

## Usage

```bash
bridge() { node /path/to/ai-bridge/server/cli.js "$@"; }

bridge listTabs
bridge newTab   '{"url":"https://example.com"}'               # opens in background
bridge eval     '{"tabId":123,"code":"document.title"}'
bridge eval     '{"tabId":123}' --file scrape.js              # long scripts from a file
bridge click    '{"tabId":123,"x":420,"y":310}'               # trusted click
bridge insertText '{"tabId":123,"text":"Hello"}'              # trusted "paste" at caret
bridge key      '{"tabId":123,"key":"Enter"}'
bridge key      '{"tabId":123,"key":"v","modifiers":4,"commands":["paste"]}'  # native paste from the clipboard
bridge download '{"url":"https://.../file.pdf","filename":"file.pdf"}'   # uses your cookies
bridge pdf      '{"tabId":123}' --out page.pdf
bridge screenshot '{"tabId":123}' --out page.png
bridge closeTab '{"tabId":123}'
bridge detach   '{"tabId":123}'                               # remove the debugger banner
```

For an AI agent, the contract is simple: every command is one shell invocation that
prints JSON to stdout and exits non-zero on failure.

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
- Chrome shows its native **"… is debugging this browser"** banner whenever the
  debugger is attached — you always see when trusted-input mode is active. Use
  `detach` to clear it.
- No analytics, no telemetry, no external requests of any kind.

## Test

```bash
npm test    # spins up the server, a simulated extension, and the real CLI; asserts round-trips
```

## Project layout

```
extension/    Manifest V3 extension (service worker + options page)
server/       relay server (server.js) and CLI client (cli.js)
test/         protocol round-trip test with a simulated extension
```

## Contributing

Improvements welcome — new CDP-backed commands, a Firefox port, reliability fixes.
See **[CONTRIBUTING.md](CONTRIBUTING.md)** for dev setup, the two-layer test
suite, and the security ground rules every PR must preserve.

## License

MIT © 2026 [Mykola Bielousov](https://scholar.google.com/citations?user=dOwVd0sAAAAJ)
