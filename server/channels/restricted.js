// Restricted runs: what a channel-originated task may do.
//
// Inbound messenger text is untrusted. The ops model that acts on it gets an
// allowlist of browser commands only — no `agent`, `jobs`, `recipe`, `journal`,
// `pairing`, `channels`, `claude-md`, no `download` (lands outside the outbox),
// no `activateTab`/`detachAll` (touch the user's other windows) — and a child
// environment with no secrets in it.

const BROWSER_COMMANDS = [
  "ping", "status", "listTabs", "newTab", "navigate", "eval", "click", "type", "insertText", "key",
  "waitFor", "scroll", "snapshot", "screenshot", "pdf", "selectTab", "closeTab", "detach",
];

// One Claude Code tool pattern per command: `Bash(<selfCmd> <cmd>:*)`.
function allowedTools(selfCmd) {
  return BROWSER_COMMANDS.map((c) => `Bash(${selfCmd} ${c}:*)`);
}

const KEEP = new Set(["PATH", "HOME", "USER", "LANG", "TMPDIR", "BRIDGE_PORT"]);
// The model's own credentials: without them `claude -p` / `codex` cannot start
// (servers authenticate through env). Messenger tokens are never in this list.
const KEEP_AUTH = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "CODEX_HOME", "OPENAI_API_KEY"]);
const KEEP_AI = new Set(["AI_BRIDGE_RUN_ID", "AI_BRIDGE_JOB", "AI_BRIDGE_OUTBOX", "AI_BRIDGE_AGENT", "AI_BRIDGE_RESTRICTED"]);

// `extraKeys`: operator-configured passthrough (channels.json "envPassthrough").
function cleanEnv(src = process.env, extraKeys = []) {
  const extra = new Set(extraKeys || []);
  const out = {};
  for (const [k, v] of Object.entries(src)) if ((KEEP.has(k) || KEEP_AUTH.has(k) || KEEP_AI.has(k) || extra.has(k)) && v !== undefined) out[k] = v;
  return out;
}

const PLAYBOOK_ADDENDUM = `Additional rules for this run (it was requested from a messenger):
- You are limited to browser commands; administrative bridge subcommands are unavailable.
- before any irreversible action the task did not already name, stop and end your report with "NEEDS APPROVAL: <one line>" describing exactly what you are about to do; you will be re-run with an answer.
- to deliver a file, fetch it in the page with eval returning {base64} and --out <name>, or use pdf --out / screenshot --out; files in the current directory are sent to the user. Do not use download.`;

module.exports = { BROWSER_COMMANDS, KEEP_AUTH, allowedTools, cleanEnv, PLAYBOOK_ADDENDUM };
