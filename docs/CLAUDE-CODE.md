# Using AI Browser Bridge from Claude Code

The bridge was built for exactly this: letting Claude Code (or any terminal AI agent)
drive your real, logged-in Chrome. Every command is a single shell invocation that
prints JSON to stdout and exits non-zero on failure — no SDK, no MCP server needed.

## One-time setup

New to the project? [INSTALL.md](INSTALL.md) is the full first-time walkthrough with
troubleshooting and background-service templates. The short version:

1. Clone and install:
   ```bash
   git clone https://github.com/legisus/ai-bridge.git
   cd ai-bridge
   npm install
   ```
2. Start the server (keep it running — templates for `launchd` and systemd are in
   `deploy/`, see [INSTALL.md §7](INSTALL.md#7-keep-the-server-running)):
   ```bash
   npm start
   # first run prints: token generated at ~/.ai-browser-bridge/token
   ```
3. Load the extension: `chrome://extensions` → enable **Developer mode** →
   **Load unpacked** → select the `extension/` folder.
4. `npm run register-host`, then reload the extension: it fetches the token through
   Chrome's native messaging host and starts the server when needed. On the card click
   **Details** and turn on **Allow User Scripts** (Chrome 138+; `eval` needs it).
   Optionally set a **host allowlist** in **Extension options** so the agent can only
   touch domains you name. (No native host? Paste `~/.ai-browser-bridge/token` there.)
5. Verify:
   ```bash
   node server/cli.js ping
   # {"pong":true,"version":"0.1.10"}
   ```

## Teach Claude Code about the bridge

Add a section like this to the `CLAUDE.md` of any project where you want Claude Code
to use the browser (or to `~/.claude/CLAUDE.md` to enable it everywhere). Adjust the
path to where you cloned the repo.

```markdown
## Browser control (AI Browser Bridge)

**Token saver — default for browser tasks:** for any multi-step browser task, do NOT
drive the bridge command-by-command from this session. Delegate the whole task to the
bridge's built-in agent, which runs the mechanical steps on cheap models and uses the
strongest model only to judge the result (Haiku 4.5 → judge → Sonnet 5 → judge →
Fable 5 → judge, stops at the first pass; bills to my existing Claude subscription via
headless `claude -p`):

    node /path/to/ai-bridge/server/cli.js agent "task description" [--timeout ms] [--verbose]

It prints a verdict, an evidence report, and a per-stage token/cost summary; exits 0
on pass. Give it a complete, self-contained task description (URLs, what "done" looks
like). Only fall back to direct command-by-command driving (below) for one-off single
commands (a quick `ping`, one `eval`, one `screenshot`) or when I explicitly ask you
to drive the browser yourself.

A local bridge to my real, logged-in Chrome is available. Run commands as:

    node /path/to/ai-bridge/server/cli.js <cmd> [params-json] [--file js] [--out file] [--timeout ms]

Each call prints JSON to stdout and exits non-zero on failure. Commands run in
DIRECT mode by default (no chrome.debugger, no "is debugging" banner): eval runs via
the User Scripts API in the page's MAIN world and click/type/key are synthetic events.
Add `--debugger` to attach chrome.debugger for trusted input, `pdf`, or
background-tab screenshots. `--debugger` requires approval:
pass the flag, set `AI_BRIDGE_DEBUGGER=1`, or confirm the interactive prompt; with no
TTY and no pre-approval the command fails (exit 5) instead of attaching. `pdf` and
background-tab `screenshot` are CDP-only and always need `--debugger`. Commands:

- `ping` — health check; `{"pong":true}` means the extension is connected
- `listTabs` — all open tabs with id, url, title
- `newTab '{"url":"https://…"}'` — opens in a BACKGROUND tab (never steals focus)
- `navigate '{"tabId":N,"url":"https://…"}'`
- `eval '{"tabId":N,"code":"…"}'` — JS eval in the page; returns the value (add --debugger if a page refuses it).
  For long scripts use `eval '{"tabId":N}' --file script.js`
- `click '{"tabId":N,"x":X,"y":Y}'` — click at viewport CSS px (--debugger for isTrusted:true);
  or `click '{"tabId":N,"selector":".btn"}'` to click an element by selector
- `insertText '{"tabId":N,"text":"…"}'` — paste at the current caret
- `type '{"tabId":N,"text":"…"}'` — real per-char keystrokes (autocomplete/React widgets)
- `key '{"tabId":N,"key":"Enter"}'` — key press
- `waitFor '{"tabId":N,"selector":"#results"}'` — poll until an element appears (or `{"code":"…"}` for a JS condition)
- `scroll '{"tabId":N,"bottom":true}'` — also `{selector}`, `{top}`, `{dx,dy}`
- `screenshot '{"tabId":N}' --out page.png` — direct mode needs the tab active; add `--debugger` for background tabs
- `pdf '{"tabId":N}' --out page.pdf` — CDP-only, needs `--debugger`
- `download '{"url":"…","filename":"f.pdf"}'` — uses my cookies; lands in ~/Downloads
- `selectTab '{"tabId":N}'` — activate a tab without focusing its window
- `activateTab '{"tabId":N}'` (focuses the window — avoid unless asked) / `closeTab '{"tabId":N}'`
- `status` — version + which tabs are attached
- `detach '{"tabId":N}'` — clears Chrome's "is debugging" banner (only appears with --debugger)
- `detachAll` — release every attached tab in one call

Rules:
- Always `ping` first; if it fails, tell me to start the server / check the extension.
- Direct mode is the default and is fine for most work; only add `--debugger` when a site
  rejects synthetic events (contenteditable/ProseMirror-class rich-text editors) or you
  need pdf/background-tab screenshots.
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

The built-in `bridge agent` subcommand (see the CLAUDE.md block above and the
README's *Agent mode* section) already implements this idea end-to-end: cheap
models operate, a strong model judges. This section explains the principle and a
Claude Code-native alternative — a custom subagent — if you want finer control
over what gets delegated.

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
| `` `claude` CLI not found `` from `bridge agent` | Install Claude Code and log in — the agent runs on headless `claude -p` sessions |
| Chrome shows a "…is debugging this browser" banner | Expected whenever trusted input / eval is active; run `detach` to clear it |
