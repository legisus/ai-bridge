#!/usr/bin/env node
// `bridge channels start|status` and `bridge pairing` entry points via the real CLI.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };
const cli = path.join(__dirname, "..", "server", "cli.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-chmain-"));
const run = (args) => new Promise((resolve) => execFile(process.execPath, [cli, ...args], { env: { ...process.env, AI_BRIDGE_HOME: home }, timeout: 15000 },
  (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout), stderr: String(stderr) })));

(async () => {
  // no config → exit 1 naming the file
  let r = await run(["channels", "start"]);
  assert(r.code === 1 && /channels\.json/.test(r.stderr), "channels start: missing config → exit 1 naming channels.json");

  // unknown channel → exit 1 listing the known ones
  fs.writeFileSync(path.join(home, "channels.json"), JSON.stringify({ viber: { token: "x" } }), { mode: 0o600 });
  r = await run(["channels", "start"]);
  assert(r.code === 1 && /viber/.test(r.stderr) && /telegram/.test(r.stderr), "channels start: unknown channel → exit 1 listing telegram");

  // lock held by a live pid → exit 1 mentioning the pid
  fs.writeFileSync(path.join(home, "channels.json"), JSON.stringify({ telegram: { token: "x" } }), { mode: 0o600 });
  fs.writeFileSync(path.join(home, "channels.lock"), String(process.pid));
  r = await run(["channels", "start"]);
  assert(r.code === 1 && /another channels daemon is running \(pid \d+\)/.test(r.stderr), "channels start: live lock → exit 1 with pid");

  // status: shows the lock pid and channels, never the token
  r = await run(["channels", "status"]);
  assert(r.code === 0 && r.stdout.includes(`pid ${process.pid}`) && r.stdout.includes("telegram") && !r.stdout.includes('"x"'), "channels status: lock pid + channel list, no token");
  fs.unlinkSync(path.join(home, "channels.lock"));

  // stale lock (dead pid) is ignored; the daemon then starts and fails on the fake token… so give it a bogus apiBase and stop it
  fs.writeFileSync(path.join(home, "channels.lock"), "999999");
  fs.writeFileSync(path.join(home, "channels.json"), JSON.stringify({ telegram: { token: "x", apiBase: "http://127.0.0.1:9" } }), { mode: 0o600 });
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, [cli, "channels", "start"], { env: { ...process.env, AI_BRIDGE_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  await new Promise((res) => setTimeout(res, 1200));
  const lock = fs.existsSync(path.join(home, "channels.lock")) ? fs.readFileSync(path.join(home, "channels.lock"), "utf8") : "";
  assert(lock === String(child.pid), "channels start: stale lock replaced with the daemon's pid");
  assert(/channels daemon started/.test(out) && /telegram/.test(out), "channels start: announces start and the channel");
  child.kill("SIGTERM");
  await new Promise((res) => child.on("close", res));
  assert(!fs.existsSync(path.join(home, "channels.lock")), "channels start: lock removed on SIGTERM");

  // acquireLock in-process: exclusive create, own pid tolerated, dead pid reclaimed
  {
    process.env.AI_BRIDGE_HOME = home;
    const { acquireLock, LOCK_FILE } = require("../server/channels/main.js");
    const rel = acquireLock();
    assert(fs.readFileSync(LOCK_FILE, "utf8") === String(process.pid), "acquireLock: writes our pid");
    const rel2 = acquireLock();
    assert(fs.readFileSync(LOCK_FILE, "utf8") === String(process.pid), "acquireLock: re-acquire by the same pid is a no-op");
    rel2(); rel();
    assert(!fs.existsSync(LOCK_FILE), "acquireLock: release removes the lock");
    fs.writeFileSync(LOCK_FILE, "999999");
    const rel3 = acquireLock();
    assert(fs.readFileSync(LOCK_FILE, "utf8") === String(process.pid), "acquireLock: dead pid reclaimed");
    rel3();
  }

  // pairing CLI through the dispatcher
  r = await run(["pairing", "list"]);
  assert(r.code === 0 && /no pending/.test(r.stdout), "pairing list: empty store prints 'no pending'");
  r = await run(["pairing", "approve", "telegram", "ZZZZZZ"]);
  assert(r.code === 1 && /no pending request/.test(r.stderr), "pairing approve: unknown code → exit 1");

  // usage mentions the new subcommands
  r = await run([]);
  assert(/bridge channels start/.test(r.stderr) && /bridge pairing/.test(r.stderr), "usage: lists channels and pairing");

  fs.rmSync(home, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})();
