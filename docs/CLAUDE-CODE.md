# Using AI Browser Bridge from Claude Code

The bridge was built for exactly this: letting Claude Code (or any terminal AI agent)
drive your real, logged-in Chrome. Every command is a single shell invocation that
prints JSON to stdout and exits non-zero on failure — no SDK, no MCP server needed.

## One-time setup

1. Clone and install:
   ```bash
   git clone https://github.com/<you>/ai-bridge.git
   cd ai-bridge
   npm install
   ```
2. Start the server (keep it running; a login item, `tmux` pane, or `launchd`/systemd
   unit all work):
   ```bash
   npm start
   # first run prints: token generated at ~/.ai-browser-bridge/token
   ```
3. Load the extension: `chrome://extensions` → enable **Developer mode** →
   **Load unpacked** → select the `extension/` folder.
4. Open the extension's **Options** page, paste the token from
   `~/.ai-browser-bridge/token`, and save. Optionally set a **host allowlist** so the
   agent can only touch domains you name.
5. Verify:
   ```bash
   node server/cli.js ping
   # {"pong":true,"version":"0.1.0"}
   ```

## Teach Claude Code about the bridge

Add a section like this to the `CLAUDE.md` of any project where you want Claude Code
to use the browser (or to `~/.claude/CLAUDE.md` to enable it everywhere). Adjust the
path to where you cloned the repo.

```markdown
## Browser control (AI Browser Bridge)

A local bridge to my real, logged-in Chrome is available. Run commands as:

    node /path/to/ai-bridge/server/cli.js <cmd> [params-json] [--file js] [--out file] [--timeout ms]

Each call prints JSON to stdout and exits non-zero on failure. Commands:

- `ping` — health check; `{"pong":true}` means the extension is connected
- `listTabs` — all open tabs with id, url, title
- `newTab '{"url":"https://…"}'` — opens in a BACKGROUND tab (never steals focus)
- `navigate '{"tabId":N,"url":"https://…"}'`
- `eval '{"tabId":N,"code":"…"}'` — CSP-proof JS eval; returns the value.
  For long scripts use `eval '{"tabId":N}' --file script.js`
- `click '{"tabId":N,"x":X,"y":Y}'` — trusted click (isTrusted:true) at viewport CSS px
- `insertText '{"tabId":N,"text":"…"}'` — trusted paste at the current caret
- `key '{"tabId":N,"key":"Enter"}'` — trusted key press
- `screenshot '{"tabId":N}' --out page.png`
- `pdf '{"tabId":N}' --out page.pdf`
- `download '{"url":"…","filename":"f.pdf"}'` — uses my cookies; lands in ~/Downloads
- `activateTab '{"tabId":N}'` / `closeTab '{"tabId":N}'`
- `detach '{"tabId":N}'` — clears Chrome's "is debugging" banner when you're done

Rules:
- Always `ping` first; if it fails, tell me to start the server / check the extension.
- Prefer `eval` for reading pages; use `click`/`insertText`/`key` only when a site
  rejects synthetic events (rich editors like Google Docs, Grammarly).
- Open new tabs in the background (default) — do not steal my focus.
- `detach` from tabs when finished so the debugger banner goes away.
- This is my real browser with my real sessions: never log out, change account
  settings, or submit destructive forms without asking me first.
```

That's the whole integration. Once the block is in `CLAUDE.md`, you can ask things
like *"open my Gmail, find the invoice from ACME and save the attachment"* and Claude
Code will compose the calls itself.

### Optional: shell alias

If you approve a `bridge` alias in your shell profile, prompts get shorter:

```bash
alias bridge='node /path/to/ai-bridge/server/cli.js'
```

### Optional: pre-approve the command

To avoid a permission prompt on every call, allow the CLI in
`.claude/settings.json` of the project (or your user settings):

```json
{
  "permissions": {
    "allow": [
      "Bash(node /path/to/ai-bridge/server/cli.js *)"
    ]
  }
}
```

Think before you do this: it lets the agent act in your logged-in browser without
asking each time. The extension's **host allowlist** (Options page) is the safety net
that keeps commands confined to domains you chose.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `connect failed: …` from the CLI | Server isn't running — `npm start` in the repo |
| `ERROR: extension not connected` | Extension not loaded/provisioned, or wrong token/port in Options; it reconnects within ~30 s of the server starting |
| `host "…" not in allowlist` | Add the domain in the extension Options, or clear the allowlist |
| Chrome shows a "…is debugging this browser" banner | Expected whenever trusted input / eval is active; run `detach` to clear it |
