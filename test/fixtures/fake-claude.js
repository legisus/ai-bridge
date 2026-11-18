#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests. Records argv to $FAKE_CLAUDE_LOG and
// behaves per $FAKE_CLAUDE_MODE:
//   "ok"       prints a passing JSON result (session_id echoes --session-id/--resume)
//   "hang"     spawns a grandchild, records both pids to $FAKE_CLAUDE_PIDS, never exits
//   "noconv"   with --resume: "No conversation found with session ID" on stderr, exit 1; else "ok"
//   "approval" like "ok" but the result ends with a NEEDS APPROVAL line
//   "echo"     like "ok" but the result is the -p text
const fs = require("fs");
const argv = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(argv) + "\n");
const mode = process.env.FAKE_CLAUDE_MODE || "ok";
const after = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
const sessionId = after("--session-id") || after("--resume") || "none";
if (mode === "hang") {
  const { spawn } = require("child_process");
  const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  if (process.env.FAKE_CLAUDE_PIDS) fs.writeFileSync(process.env.FAKE_CLAUDE_PIDS, JSON.stringify({ parent: process.pid, child: c.pid }));
  setInterval(() => {}, 1000);
} else if (mode === "noconv" && argv.includes("--resume")) {
  process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
  process.exit(1);
} else {
  let result = "EVIDENCE REPORT\nTask: t\nActions: 1\nFinal state: ok\nScreenshots: none\nBlockers: none";
  if (mode === "approval") result += "\nNEEDS APPROVAL: send the reply";
  if (mode === "echo") result = after("-p") || "";
  process.stdout.write(JSON.stringify({ result, session_id: sessionId, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.01 }));
}
