#!/usr/bin/env node
// End-to-end protocol test: starts the server, connects a fake "extension"
// that answers listTabs/eval, then drives it through the real CLI and asserts
// the round-trip. Also verifies that a bad token is rejected.

const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const run = promisify(execFile); // async: keeps this process's event loop free
                                 // so the simulated extension can answer
const WebSocket = require("ws");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 8799; // test port, avoid clashing with a running bridge
const env = { ...process.env, BRIDGE_PORT: String(PORT) };
const TOKEN_FILE = path.join(os.homedir(), ".ai-browser-bridge", "token");

let failures = 0;
const assert = (cond, name) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
};

(async () => {
  const server = spawn("node", [path.join(__dirname, "..", "server", "server.js")], { env, stdio: "pipe" });
  await new Promise((r) => setTimeout(r, 700));
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();

  // 1) bad token must be rejected
  await new Promise((resolve) => {
    const bad = new WebSocket(`ws://127.0.0.1:${PORT}`);
    bad.on("open", () => bad.send(JSON.stringify({ type: "auth", role: "extension", token: "wrong" })));
    bad.on("close", () => { assert(true, "bad token rejected (socket closed)"); resolve(); });
    setTimeout(() => { assert(false, "bad token rejected (socket closed)"); resolve(); }, 2000);
  });

  // 2) fake extension answers commands
  const ext = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ext.on("open", () => ext.send(JSON.stringify({ type: "auth", role: "extension", token })));
  ext.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.type !== "command") return;
    const results = {
      listTabs: [{ id: 1, url: "https://example.com", title: "Example", active: true, windowId: 1 }],
      eval: "Example Domain",
      ping: { pong: true, version: "test" },
      status: { version: "test", attachedTabs: [1], indicator: true },
    };
    // Unknown/newer commands: echo the params so tests can assert the CLI forwarded them.
    const result = msg.cmd in results ? results[msg.cmd] : { echo: msg.cmd, params: msg.params };
    ext.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result }));
  });
  await new Promise((r) => setTimeout(r, 500));

  // 3) real CLI round-trips through the server to the fake extension
  const cli = path.join(__dirname, "..", "server", "cli.js");
  try {
    const tabs = JSON.parse((await run("node", [cli, "listTabs", "--timeout", "5000"], { env })).stdout);
    assert(Array.isArray(tabs) && tabs[0].url === "https://example.com", "cli listTabs round-trip");

    const evald = JSON.parse((await run("node", [cli, "eval", '{"tabId":1,"code":"document.title"}', "--timeout", "5000"], { env })).stdout);
    assert(evald === "Example Domain", "cli eval round-trip");

    const pong = JSON.parse((await run("node", [cli, "ping", "--timeout", "5000"], { env })).stdout);
    assert(pong.pong === true, "cli ping round-trip");

    const status = JSON.parse((await run("node", [cli, "status", "--timeout", "5000"], { env })).stdout);
    assert(status.version === "test" && Array.isArray(status.attachedTabs), "cli status round-trip");

    // v0.1.3 commands must forward their params through the relay unchanged
    const typed = JSON.parse((await run("node", [cli, "type", '{"tabId":1,"text":"hi"}', "--timeout", "5000"], { env })).stdout);
    assert(typed.echo === "type" && typed.params.text === "hi", "cli type forwards params");

    const clicked = JSON.parse((await run("node", [cli, "click", '{"tabId":1,"selector":".btn"}', "--timeout", "5000"], { env })).stdout);
    assert(clicked.params && clicked.params.selector === ".btn", "cli click(selector) forwards params");

    const waited = JSON.parse((await run("node", [cli, "waitFor", '{"tabId":1,"selector":"#x"}', "--timeout", "5000"], { env })).stdout);
    assert(waited.params.selector === "#x", "cli waitFor forwards params");

    const scrolled = JSON.parse((await run("node", [cli, "scroll", '{"tabId":1,"bottom":true}', "--timeout", "5000"], { env })).stdout);
    assert(scrolled.params.bottom === true, "cli scroll forwards params");
  } catch (e) {
    assert(false, `cli round-trip threw: ${e.message}`);
  } finally {
    ext.close();
    server.kill();
  }
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
