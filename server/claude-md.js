// `bridge claude-md` — write the CLAUDE.md block that teaches Claude Code the
// bridge, with THIS machine's CLI path filled in. Pasting the block by hand is
// error-prone (a stray quote or backtick in a terminal paste gives zsh a
// "parse error"), so this does the append:
//
//   bridge claude-md            # append to ~/.claude/CLAUDE.md (every project)
//   bridge claude-md --project  # append to ./CLAUDE.md (this project only)
//   bridge claude-md --print    # print the block to stdout, write nothing
//
// It is idempotent: when the target already has the block's heading nothing is
// written and the command says so.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { SELF_CMD } = require("./runtime");

const HEADING = "## Browser control (AI Browser Bridge)";

function snippet(cmd = SELF_CMD) {
  return `${HEADING}

**Token saver — default for browser tasks:** for any multi-step browser task, do NOT
drive the bridge command-by-command from this session. Delegate the whole task to the
bridge's built-in agent, which runs the mechanical steps on cheaper models and uses the
strongest model only to judge the result (Opus 5.5 → judge → Fable 5.1 → judge →
Codex Astra 6 → judge; stops at the first pass; bills to my existing Claude subscription
via headless \`claude -p\`; the Codex rung is skipped with an error if the \`codex\` CLI
is not installed):

    ${cmd} agent "task description" [--timeout ms] [--verbose]

It prints a verdict, an evidence report and a per-stage token/cost summary; exits 0 on
pass. Give it a complete, self-contained task description (URLs, what "done" looks
like). Only fall back to direct command-by-command driving (below) for one-off single
commands (a quick \`ping\`, one \`eval\`, one \`screenshot\`) or when I explicitly ask you
to drive the browser yourself.

A local bridge to my real, logged-in Chrome is available in every session. Run commands as:

    ${cmd} <cmd> [params-json] [--file js] [--out file] [--timeout ms]

Each call prints JSON to stdout and exits non-zero on failure. The auth token lives in
\`~/.ai-browser-bridge/token\`; the CLI reads it automatically. If \`ping\` fails with
"connect failed", the server is not running — reload the extension at chrome://extensions
(the native host starts the server) or start it by hand. If it fails with "extension not
connected", wait ~30 s for the extension's reconnect alarm, and if it still fails ask me
to reload the extension.

**Direct mode is the default — no debugger banner.** Every command drives the tab
without attaching chrome.debugger (eval via the User Scripts API in the page's MAIN
world, subject to page CSP; click/type/key via synthetic events). Add \`--debugger\` ONLY
when you need trusted input, CSP-proof eval, \`pdf\`, or a background-tab screenshot.
\`pdf\` and background-tab \`screenshot\` are CDP-only and always need it.

Commands:
- \`ping\` — health check; \`{"pong":true}\` means the extension is connected
- \`listTabs\` — all open tabs with id, url, title
- \`newTab '{"url":"https://…"}'\` — opens in a BACKGROUND tab (never steals focus)
- \`navigate '{"tabId":N,"url":"https://…"}'\`
- \`eval '{"tabId":N,"code":"…"}'\` — JS eval in the page; returns the value.
  Long scripts: \`eval '{"tabId":N}' --file script.js\`. If the script returns
  \`{base64: "..."}\`, add \`--out file\` to write it to disk directly.
- \`click '{"tabId":N,"x":X,"y":Y}'\` — click at viewport CSS px (\`--debugger\` for isTrusted:true);
  or \`click '{"tabId":N,"selector":".btn"}'\` to click an element by selector
- \`insertText '{"tabId":N,"text":"…"}'\` — paste at the current caret
- \`type '{"tabId":N,"text":"…"}'\` — real per-char keystrokes (autocomplete/React widgets)
- \`key '{"tabId":N,"key":"Enter"}'\` — key press
- \`waitFor '{"tabId":N,"selector":"#results"}'\` — poll until an element appears (or \`{"code":"…"}\`)
- \`scroll '{"tabId":N,"bottom":true}'\` — also \`{selector}\`, \`{top}\`, \`{dx,dy}\`
- \`screenshot '{"tabId":N}' --out page.png\` — direct mode needs the tab active; \`--debugger\` for background tabs
- \`pdf '{"tabId":N}' --out page.pdf\` — CDP-only, needs \`--debugger\`
- \`download '{"url":"…","filename":"f.pdf"}'\` — uses my cookies; lands in ~/Downloads
- \`selectTab '{"tabId":N}'\` — activate a tab without focusing its window
- \`activateTab '{"tabId":N}'\` (focuses the window — avoid unless asked) / \`closeTab '{"tabId":N}'\`
- \`status\` — version + which tabs are attached
- \`detach '{"tabId":N}'\` — clears Chrome's "is debugging" banner (only appears after \`--debugger\`)
- \`detachAll\` — release every attached tab in one call

Rules:
- Always \`ping\` first.
- Prefer \`eval\` for reading pages; use \`click\`/\`insertText\`/\`key\` only when a site
  rejects synthetic events (rich editors, CSP-strict apps).
- After a \`click\`, verify focus/position with \`eval\` before typing — page layouts shift
  while loading. Screenshot to locate elements when unsure.
- Open new tabs in the background (default) — do not steal focus.
- \`detach\` from any tab you drove with \`--debugger\` when finished.
- This is my real browser with my real sessions: never log out, change account
  settings, or submit destructive/irreversible forms without asking me first.
- Screenshots may capture private data (chat history, mail) — treat them as
  confidential and never publish or commit them.

## Payments — NEVER click Pay
Never click a Pay / Submit Payment / Place Order / Confirm Purchase button or otherwise
trigger a charge, debit or transfer, on any site, even if I asked you to "pay" something.
Do everything up to the final confirmation screen, then stop and hand the final click to me.
`;
}

function targetFile(flags) {
  return flags.project ? path.resolve("CLAUDE.md") : path.join(os.homedir(), ".claude", "CLAUDE.md");
}

// Returns {file, action} where action is "created" | "appended" | "exists".
function install(flags = {}, cmd = SELF_CMD) {
  const file = targetFile(flags);
  let existing = "";
  try { existing = fs.readFileSync(file, "utf8"); } catch {}
  if (existing.includes(HEADING)) return { file, action: "exists" };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sep = existing && !existing.endsWith("\n") ? "\n\n" : existing ? "\n" : "";
  fs.appendFileSync(file, sep + snippet(cmd));
  return { file, action: existing ? "appended" : "created" };
}

function main(argv) {
  const flags = {};
  for (const a of argv) {
    if (a === "--print") flags.print = true;
    else if (a === "--project") flags.project = true;
    else { console.error(`usage: bridge claude-md [--project] [--print]`); process.exit(2); }
  }
  if (flags.print) { process.stdout.write(snippet()); return; }
  const { file, action } = install(flags);
  if (action === "exists") console.log(`${file} already has "${HEADING}" — nothing written.`);
  else console.log(`${action} ${file} — Claude Code now knows the bridge (CLI: ${SELF_CMD}). Start a new Claude Code session to pick it up.`);
}

module.exports = { main, snippet, install, HEADING };
