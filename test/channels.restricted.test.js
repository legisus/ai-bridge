#!/usr/bin/env node
// Restricted-run helpers: browser-only tool allowlist, clean child env, playbook addendum.
const { BROWSER_COMMANDS, allowedTools, cleanEnv, PLAYBOOK_ADDENDUM } = require("../server/channels/restricted.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

const tools = allowedTools("node x");
assert(tools.length === BROWSER_COMMANDS.length && tools.length >= 18, "allowedTools: one pattern per browser command");
assert(tools.includes("Bash(node x eval:*)") && tools.includes("Bash(node x snapshot:*)") && tools.includes("Bash(node x ping:*)"), "allowedTools: eval, snapshot, ping present");
const banned = /\b(agent|jobs|recipe|journal|pairing|channels|claude-md|reloadExtension|detachAll|activateTab|download)\b/;
assert(!tools.some((t) => banned.test(t)), "allowedTools: no admin subcommand, no download, no activateTab/detachAll");
assert(!tools.includes("Bash(node x:*)"), "allowedTools: no blanket CLI pattern");
assert(allowedTools("/usr/local/bin/ai-bridge").includes("Bash(/usr/local/bin/ai-bridge eval:*)"), "allowedTools: works for the single binary form");

const env = cleanEnv({ PATH: "p", HOME: "h", USER: "u", LANG: "l", TMPDIR: "t", BRIDGE_PORT: "8765",
  AI_BRIDGE_TELEGRAM_TOKEN: "secret", AI_BRIDGE_RUN_ID: "r", AI_BRIDGE_JOB: "j", AI_BRIDGE_OUTBOX: "o", AI_BRIDGE_AGENT: "1",
  AWS_SECRET_ACCESS_KEY: "x", FOO: "1", SHELL: "/bin/zsh" });
assert(JSON.stringify(Object.keys(env).sort()) === JSON.stringify(["AI_BRIDGE_AGENT", "AI_BRIDGE_JOB", "AI_BRIDGE_OUTBOX", "AI_BRIDGE_RUN_ID", "BRIDGE_PORT", "HOME", "LANG", "PATH", "TMPDIR", "USER"]),
  "cleanEnv: keeps only PATH HOME USER LANG TMPDIR BRIDGE_PORT + run metadata");
assert(!("AI_BRIDGE_TELEGRAM_TOKEN" in env) && !("AWS_SECRET_ACCESS_KEY" in env), "cleanEnv: secrets dropped");
assert(cleanEnv({ PATH: "p" }).PATH === "p" && Object.keys(cleanEnv({})).length === 0, "cleanEnv: missing keys are simply absent");
const auth = cleanEnv({ CLAUDE_CODE_OAUTH_TOKEN: "o", ANTHROPIC_API_KEY: "k", AI_BRIDGE_RESTRICTED: "1", AI_BRIDGE_TELEGRAM_TOKEN: "t", MY_PROXY: "p" }, ["MY_PROXY"]);
assert(auth.CLAUDE_CODE_OAUTH_TOKEN === "o" && auth.ANTHROPIC_API_KEY === "k" && auth.AI_BRIDGE_RESTRICTED === "1" && auth.MY_PROXY === "p" && !("AI_BRIDGE_TELEGRAM_TOKEN" in auth),
  "cleanEnv: keeps the model's own auth, the restricted marker and operator passthrough; never a messenger token");

assert(PLAYBOOK_ADDENDUM.includes('before any irreversible action the task did not already name, stop and end your report with "NEEDS APPROVAL: <one line>"'), "addendum: stop-before-send line");
assert(PLAYBOOK_ADDENDUM.includes("to deliver a file, fetch it in the page with eval returning {base64} and --out <name>, or use pdf --out / screenshot --out; files in the current directory are sent to the user"), "addendum: outbox delivery line");

process.exit(failures ? 1 : 0);
