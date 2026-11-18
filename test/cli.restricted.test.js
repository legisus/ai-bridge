#!/usr/bin/env node
// CLI boundary under AI_BRIDGE_RESTRICTED=1: admin subcommands refused, --out/--file
// confined to AI_BRIDGE_OUTBOX. Checked before any socket is opened (no server needed).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };
const cli = path.join(__dirname, "..", "server", "cli.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-clir-"));
const outbox = path.join(home, "outbox", "run1"); fs.mkdirSync(outbox, { recursive: true });
const other = path.join(home, "elsewhere"); fs.mkdirSync(other);
fs.writeFileSync(path.join(home, "pairing.json"), "{}");
const run = (args, extraEnv = {}, cwd = outbox) => new Promise((resolve) => execFile(process.execPath, [cli, ...args],
  { cwd, env: { ...process.env, AI_BRIDGE_HOME: home, AI_BRIDGE_RESTRICTED: "1", AI_BRIDGE_OUTBOX: outbox, BRIDGE_PORT: "1", ...extraEnv }, timeout: 10000 },
  (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout), stderr: String(stderr) })));

(async () => {
  for (const sub of ["agent", "jobs", "recipe", "journal", "pairing", "channels", "claude-md", "download", "activateTab", "detachAll", "reloadExtension"]) {
    const r = await run([sub, "{}"]);
    assert(r.code === 7 && /restricted/.test(r.stderr), `restricted: ${sub} refused with exit 7`);
  }
  let r = await run(["eval", '{"tabId":1,"code":"1"}', "--out", path.join(home, "pairing.json")]);
  assert(r.code === 7 && /restricted|outbox/.test(r.stderr) && fs.readFileSync(path.join(home, "pairing.json"), "utf8") === "{}", "restricted: --out outside the outbox refused, target untouched");
  r = await run(["eval", '{"tabId":1,"code":"1"}', "--out", "../../pairing.json"]);
  assert(r.code === 7, "restricted: --out with .. traversal refused");
  fs.symlinkSync(other, path.join(outbox, "link"));
  r = await run(["eval", '{"tabId":1,"code":"1"}', "--out", "link/x.png"]);
  assert(r.code === 7, "restricted: --out through a symlinked dir inside the outbox refused");
  r = await run(["eval", '{"tabId":1}', "--file", "/etc/hosts"]);
  assert(r.code === 7, "restricted: --file outside the outbox refused");
  for (const bad of ["CLAUDE.md", "claude.md", "sub/CLAUDE.local.md", ".mcp.json", ".claude/settings.json", "x/.claude/hooks.json", ".hidden.png", "AGENTS.md", "settings.local.json", "leftover"]) {
    r = await run(["eval", '{"tabId":1,"code":"1"}', "--out", bad]);
    assert(r.code === 7 && /instruction or configuration file/.test(r.stderr), `restricted: --out ${bad} refused (instruction file)`);
  }
  r = await run(["eval", '{"tabId":1}', "--file", "CLAUDE.md"]);
  assert(r.code === 7, "restricted: --file CLAUDE.md refused");
  r = await run(["eval", '{"tabId":1,"code":"1"}', "--out", "settings-page.png"]);
  assert(r.code !== 7, "restricted: a name that merely contains 'settings' passes");
  // allowed shapes get past the boundary and fail later on the (absent) relay
  r = await run(["eval", '{"tabId":1,"code":"1"}', "--out", "shot.png"]);
  assert(r.code !== 7 && !/restricted/.test(r.stderr), "restricted: relative --out inside the outbox passes the boundary");
  r = await run(["eval", '{"tabId":1,"code":"1"}', "--out", path.join(outbox, "deep", "shot.png")]);
  assert(r.code !== 7, "restricted: absolute --out inside the outbox passes the boundary");
  r = await run(["snapshot", '{"tabId":1}']);
  assert(r.code !== 7, "restricted: snapshot passes the boundary");
  // unrestricted: nothing refused
  r = await run(["jobs"], { AI_BRIDGE_RESTRICTED: "" });
  assert(r.code !== 7, "unrestricted: jobs not refused");
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})();
