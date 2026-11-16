#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests. Records argv to $FAKE_CLAUDE_LOG and
// behaves per $FAKE_CLAUDE_MODE: "ok" prints a passing JSON result; "hang" spawns
// a grandchild, records both pids to $FAKE_CLAUDE_PIDS, and never exits.
const fs = require("fs");
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + "\n");
if (process.env.FAKE_CLAUDE_MODE === "hang") {
  const { spawn } = require("child_process");
  const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  if (process.env.FAKE_CLAUDE_PIDS) fs.writeFileSync(process.env.FAKE_CLAUDE_PIDS, JSON.stringify({ parent: process.pid, child: c.pid }));
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(JSON.stringify({ result: "EVIDENCE REPORT\nTask: t\nActions: 1\nFinal state: ok\nScreenshots: none\nBlockers: none", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 }));
}
