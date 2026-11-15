#!/usr/bin/env node
// AI Browser Bridge — command-line client.
//
//   bridge ping
//   bridge listTabs
//   bridge newTab '{"url":"https://example.com"}'                  # background tab
//   bridge newTab '{"url":"https://example.com","newWindow":true}' # own unfocused window
//   bridge eval '{"tabId":123}' --file script.js
//   bridge eval '{"tabId":123,"code":"document.title"}'
//   bridge pdf '{"tabId":123}' --out page.pdf
//   bridge download '{"url":"https://...","filename":"cert.pdf"}'
//   bridge snapshot '{"tabId":123}'                                 # DOM digest (text + interactive elements)
//   bridge journal [--days 30] [--job name] [--json]                # agent run journal (economy-mode candidates)
//
// Prints the JSON result on stdout; exits non-zero on error.

const WebSocket = require("ws");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.BRIDGE_PORT || 8765);
const { TOKEN_FILE } = require("./token");

// Read lazily so usage/help work before the server ever ran, and a missing
// token is a one-line explanation instead of a stack trace.
function readToken() {
  try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); }
  catch {
    console.error(`ERROR: no token at ${TOKEN_FILE} — start the server once (npm start / ai-bridge serve) or register the native host and reload the extension; it creates the token.`);
    process.exit(6);
  }
}

const { SELF_CMD } = require("./runtime");

function main(argv) {
if (argv.length === 0) {
  console.error("usage: bridge <cmd> [params-json] [--file js] [--out file] [--timeout ms] [--debugger]");
  console.error('       bridge agent "task description" [--timeout ms] [--verbose] [--job name]');
  console.error("       bridge snapshot '{\"tabId\":N}' [--debugger]   # DOM digest: text + interactive elements with selectors");
  console.error("       bridge journal [--days N] [--job name] [--json] | --trace <runId>");
  console.error("       bridge recipe propose|run|show <job> | validate|import <file>   # economy mode recipes");
  console.error("       bridge jobs [set <job> --mode regular|audit|economy --risk read|write] | reset <job>");
  console.error("       bridge claude-md [--project] [--print]   # teach Claude Code the bridge (writes CLAUDE.md)");
  console.error("  Direct mode is the DEFAULT: commands use ordinary extension APIs and");
  console.error("  never attach chrome.debugger (no DevTools session, no debugging banner).");
  console.error("  eval runs via chrome.userScripts (enable \"Allow User Scripts\" once on the");
  console.error("  extension card); click/type/insertText/key use synthetic input.");
  console.error("  --debugger: attach chrome.debugger for this call —");
  console.error("             trusted input + CSP-proof eval, at the cost of the debugging");
  console.error("             banner. Requires approval: pass this flag, set");
  console.error("             AI_BRIDGE_DEBUGGER=1, or confirm the interactive prompt.");
  console.error("  pdf and background-tab screenshots are CDP-only and always need approval.");
  process.exit(2);
}

// `bridge claude-md` — append the CLAUDE.md block (with this CLI's path) for Claude Code.
if (argv[0] === "claude-md") { require("./claude-md").main(argv.slice(1)); return; }

// `bridge agent "task"` — token-saver agent: cheap models operate, Fable judges.
if (argv[0] === "agent") {
  require("./agent").main(argv.slice(1)).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
  return;
}

// `bridge journal` — runs grouped by job signature; `--trace <runId>` dumps one run's commands.
if (argv[0] === "journal") { require("./journal").main(argv.slice(1)); return; }
// `bridge recipe …` / `bridge jobs …` — economy mode: deterministic replays + per-job state.
if (argv[0] === "recipe") {
  require("./recipe-cli").main(argv.slice(1)).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
  return;
}
if (argv[0] === "jobs") { require("./jobs").main(argv.slice(1)); return; }

let cmd = argv[0];
let params = {};
const flags = {};
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--file") flags.file = argv[++i];
  else if (argv[i] === "--out") flags.out = argv[++i];
  else if (argv[i] === "--timeout") flags.timeout = Number(argv[++i]);
  else if (argv[i] === "--direct" || argv[i] === "--stealth") flags.direct = true;   // explicit (default anyway); --stealth = pre-0.1.10 alias
  else if (argv[i] === "--debugger" || argv[i] === "--no-stealth") flags.debugger = true; // --no-stealth = pre-0.1.10 alias
  else params = JSON.parse(argv[i]);
}
if (flags.file) params.code = fs.readFileSync(flags.file, "utf8");

// `bridge snapshot` is an eval of the bundled DOM-digest script — no extension
// update needed, and models get selectors instead of pixels.
const meta = {};
if (cmd === "snapshot") {
  meta.as = { cmd: "snapshot", params };          // trace it as `snapshot`, not as a 10 KB eval
  params = require("./snapshot").buildEvalParams(params);
  cmd = "eval";
}

// Set by `bridge agent` for its child model processes: the server traces every
// command of the run to ~/.ai-browser-bridge/traces/<runId>.jsonl.
if (process.env.AI_BRIDGE_RUN_ID) meta.runId = process.env.AI_BRIDGE_RUN_ID;
if (process.env.AI_BRIDGE_JOB) meta.job = process.env.AI_BRIDGE_JOB;

// Commands with no direct-mode equivalent — Page.printToPDF is CDP-only, so pdf
// always needs the debugger (and thus approval).
const CDP_ONLY = new Set(["pdf"]);

// Ask the user, on the TTY, before attaching chrome.debugger. Resolves to
// true only on an explicit yes; prompt goes to stderr so stdout stays clean JSON.
function promptApproval(command) {
  return new Promise((resolve) => {
    const rl = require("readline").createInterface({ input: process.stdin, output: process.stderr });
    rl.question(
      `"${command}" needs chrome.debugger (attaches the DevTools debugger and shows the "is debugging this browser" banner). Approve? [y/N] `,
      (ans) => { rl.close(); resolve(/^y(es)?$/i.test(String(ans).trim())); }
    );
  });
}

// Resolve direct vs debugger mode before opening the socket. Direct is the
// default; the debugger is used only when the command needs it AND it has been approved.
async function resolveMode() {
  if (flags.direct && !flags.debugger) { params.direct = true; return; } // explicit opt-in
  const needsDebugger = flags.debugger || CDP_ONLY.has(cmd);
  if (!needsDebugger) { params.direct = true; return; }
  // The debugger is wanted — require approval.
  if (flags.debugger || process.env.AI_BRIDGE_DEBUGGER === "1") {
    params.direct = false; return; // pre-approved via flag or env
  }
  if (process.stdin.isTTY) {
    if (await promptApproval(cmd)) { params.direct = false; return; }
    console.error(`ERROR: chrome.debugger not approved for "${cmd}" — aborting.`);
    process.exit(5);
  }
  // No TTY to prompt and no pre-approval: never silently attach, never hang.
  console.error(`ERROR: "${cmd}" needs chrome.debugger but there is no TTY to approve it. Add --debugger or set AI_BRIDGE_DEBUGGER=1 to approve.`);
  process.exit(5);
}

function send() {
  const TOKEN = readToken();
  const id = crypto.randomBytes(8).toString("hex");
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const timer = setTimeout(() => { console.error("timeout"); process.exit(3); }, flags.timeout || 60000);

  ws.on("open", () => ws.send(JSON.stringify({ type: "auth", role: "cli", token: TOKEN })));
  ws.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.type === "auth" && msg.ok) {
      ws.send(JSON.stringify({ type: "request", id, cmd, params, ...(meta.runId ? { meta } : {}) }));
      return;
    }
    if (msg.type === "response" && msg.id === id) {
      clearTimeout(timer);
      if (!msg.ok) { console.error("ERROR:", msg.error); process.exit(1); }
      // Binary results (pdf/screenshot) can be written straight to a file.
      let out;
      if (flags.out && msg.result && msg.result.base64) {
        fs.writeFileSync(flags.out, Buffer.from(msg.result.base64, "base64"));
        out = JSON.stringify({ written: flags.out });
      } else {
        out = JSON.stringify(msg.result);
      }
      ws.close();
      // process.exit() right after console.log truncates large outputs: stdout
      // to a pipe is async and exit doesn't wait for the flush. Write with a
      // callback and exit only once the payload is fully out.
      process.stdout.write(out + "\n", () => process.exit(0));
    }
  });
  ws.on("error", (e) => { console.error("connect failed:", e.message); process.exit(4); });
}

resolveMode().then(send);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { main };
