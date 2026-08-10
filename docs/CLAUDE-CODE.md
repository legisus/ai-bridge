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

Each call prints JSON to stdout and exits non-zero on failure. Commands run in
STEALTH mode by default (no chrome.debugger, no "is debugging" banner): eval uses
MAIN-world scripting (subject to page CSP) and click/type/key are synthetic events.
Add `--debugger` (alias `--no-stealth`) to attach chrome.debugger for trusted input,
CSP-proof eval, `pdf`, or background-tab screenshots. `--debugger` requires approval:
pass the flag, set `AI_BRIDGE_DEBUGGER=1`, or confirm the interactive prompt; with no
TTY and no pre-approval the command fails (exit 5) instead of attaching. `pdf` and
background-tab `screenshot` are CDP-only and always need `--debugger`. Commands:

- `ping` — health check; `{"pong":true}` means the extension is connected
- `listTabs` — all open tabs with id, url, title
- `newTab '{"url":"https://…"}'` — opens in a BACKGROUND tab (never steals focus)
- `navigate '{"tabId":N,"url":"https://…"}'`
- `eval '{"tabId":N,"code":"…"}'` — JS eval (stealth: page-CSP; --debugger: CSP-proof); returns the value.
  For long scripts use `eval '{"tabId":N}' --file script.js`
- `click '{"tabId":N,"x":X,"y":Y}'` — click at viewport CSS px (--debugger for isTrusted:true)
- `insertText '{"tabId":N,"text":"…"}'` — paste at the current caret
- `key '{"tabId":N,"key":"Enter"}'` — key press
- `screenshot '{"tabId":N}' --out page.png` — stealth needs the tab active; add `--debugger` for background tabs
- `pdf '{"tabId":N}' --out page.pdf` — CDP-only, needs `--debugger`
- `download '{"url":"…","filename":"f.pdf"}'` — uses my cookies; lands in ~/Downloads
- `activateTab '{"tabId":N}'` / `closeTab '{"tabId":N}'`
- `detach '{"tabId":N}'` — clears Chrome's "is debugging" banner (only appears with --debugger)

Rules:
- Always `ping` first; if it fails, tell me to start the server / check the extension.
- Stealth is the default and is fine for most work; only add `--debugger` when a site
  rejects synthetic events (contenteditable/ProseMirror-class rich-text editors), the
  page's CSP blocks stealth eval, or you need pdf/background-tab screenshots.
- Open new tabs in the background (default) — do not steal my focus.
- `detach` from any tab you drove with `--debugger` when finished so the banner goes away.
- This is my real browser with my real sessions: never log out, change account
  settings, or submit destructive forms without asking me first.
```

That's the whole integration. Once the block is in `CLAUDE.md`, you can ask things
like *"open my webmail, find the invoice from ACME and save the attachment"* and Claude
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

## Model routing: delegate the mechanics, keep the judgment

Browser driving is cheap mechanical work wrapped around a few expensive judgments — so
running the whole loop on your most capable model wastes tokens. Two things make it costly
if you don't split it: the model re-derives which command to send on every step, and the
raw material (DOM dumps, page text, screenshot image tokens) piles up in the main context
window and gets re-sent on every subsequent turn.

Both problems disappear if you delegate the mechanical steps to a **subagent running a
cheaper model**, and keep only the judgment on your main model:

- **Mechanical → cheap subagent:** navigating, reading the DOM, clicking, typing,
  screenshots, polling `waitFor`, collecting concrete facts. The DOM and screenshots stay
  in the subagent's context; only a short structured result comes back.
- **Judgment → main model:** deciding *what* to verify, interpreting whether something is
  actually correct, composing the test plan, drawing the conclusion.

Rule of thumb: *"go here and tell me X"* → delegate. *"is this right / what should we check"*
→ do it yourself. A one-off single command (a quick `ping`, one screenshot) isn't worth the
subagent hop — the win is on multi-step sequences.

In Claude Code, drop an agent definition at `~/.claude/agents/ai-bridge-driver.md`:

```markdown
---
name: ai-bridge-driver
description: Executes a concrete browser task through the AI Browser Bridge CLI and reports
  back a compact result. Delegate mechanical multi-step browser sequences here so the noisy
  DOM dumps and screenshots stay out of the main context. Give it one clear goal and the
  exact facts to collect; it returns a short structured answer, not raw page dumps.
model: haiku   # or sonnet for vision-heavy / ambiguous pages; the parent keeps the judgment
tools: Bash, Read
---

You drive the AI Browser Bridge. Run each command as one shell invocation:
`bridge() { node /path/to/ai-bridge/server/cli.js "$@"; }`. `ping` first. Prefer `eval`
to read pages (wrap multi-statement code in an IIFE returning a JSON string). For visual
checks, `screenshot --out /tmp/x.png` then Read the file. Never dump raw DOM back — distill
to the facts you were asked for and report PASS/FAIL/BLOCKED. Real user sessions: never log
out, change settings, or submit destructive forms; if the goal implies that, stop and report.
```

Then the parent agent calls it for the mechanical legs and reasons over the compact results
itself. In practice a full multi-step verification (a dozen CLI calls plus a screenshot) burns
its tokens inside the subagent and returns a few lines — the main context stays small and the
expensive model only spends tokens where the thinking actually is.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `connect failed: …` from the CLI | Server isn't running — `npm start` in the repo |
| `ERROR: extension not connected` | Extension not loaded/provisioned, or wrong token/port in Options; it reconnects within ~30 s of the server starting |
| `host "…" not in allowlist` | Add the domain in the extension Options, or clear the allowlist |
| Chrome shows a "…is debugging this browser" banner | Expected whenever trusted input / eval is active; run `detach` to clear it |
