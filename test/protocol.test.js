#!/usr/bin/env node
// End-to-end protocol test: starts the relay on a temp AI_BRIDGE_HOME and a
// dynamic port (test/helpers/relay.js), connects a fake "extension" that
// answers listTabs/eval, then drives it through the real CLI and asserts the
// round-trip. Also verifies that a bad token is rejected and that BRIDGE_BIND
// is honoured.

const WebSocket = require("ws");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startRelay, fakeExtension, cli } = require("./helpers/relay");

let failures = 0;
const assert = (cond, name) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
};

(async () => {
  const relay = await startRelay();
  assert(Number.isInteger(relay.port) && relay.port !== 8765, "relay picked a dynamic port");
  assert(relay.home !== path.join(os.homedir(), ".ai-browser-bridge") && fs.existsSync(path.join(relay.home, "token")), "relay runs on a temp AI_BRIDGE_HOME");

  // 1) bad token must be rejected
  await new Promise((resolve) => {
    const bad = new WebSocket(`ws://127.0.0.1:${relay.port}`);
    bad.on("open", () => bad.send(JSON.stringify({ type: "auth", role: "extension", token: "wrong" })));
    bad.on("close", () => { assert(true, "bad token rejected (socket closed)"); resolve(); });
    setTimeout(() => { assert(false, "bad token rejected (socket closed)"); resolve(); }, 2000);
  });

  // 2) fake extension answers commands
  const ext = await fakeExtension(relay, {
    handler: (cmd, params) => {
      const results = {
        listTabs: [{ id: 1, url: "https://example.com", title: "Example", active: true, windowId: 1 }],
        eval: "Example Domain",
        ping: { pong: true, version: "test" },
        status: { version: "test", attachedTabs: [1], indicator: true, idleDetachMs: 120000 },
        detachAll: { ok: true, detached: [1, 2] },
      };
      // Unknown/newer commands: echo the params so tests can assert the CLI forwarded them.
      return cmd in results ? results[cmd] : { echo: cmd, params };
    },
  });

  // 3) real CLI round-trips through the server to the fake extension
  const run = async (args, env) => {
    const r = await cli(relay, [...args, "--timeout", "5000"], { env });
    if (r.code !== 0) throw Object.assign(new Error(`exit ${r.code}: ${r.stderr}`), { code: r.code, stderr: r.stderr });
    return r.json;
  };
  try {
    const tabs = await run(["listTabs"]);
    assert(Array.isArray(tabs) && tabs[0].url === "https://example.com", "cli listTabs round-trip");

    const evald = await run(["eval", '{"tabId":1,"code":"document.title"}']);
    assert(evald === "Example Domain", "cli eval round-trip");

    const pong = await run(["ping"]);
    assert(pong.pong === true, "cli ping round-trip");

    const status = await run(["status"]);
    assert(status.version === "test" && Array.isArray(status.attachedTabs) && typeof status.idleDetachMs === "number", "cli status round-trip");

    const detachedAll = await run(["detachAll"]);
    assert(detachedAll.ok === true && Array.isArray(detachedAll.detached), "cli detachAll round-trip");

    // v0.1.3 commands must forward their params through the relay unchanged
    const typed = await run(["type", '{"tabId":1,"text":"hi"}']);
    assert(typed.echo === "type" && typed.params.text === "hi", "cli type forwards params");

    const clicked = await run(["click", '{"tabId":1,"selector":".btn"}']);
    assert(clicked.params && clicked.params.selector === ".btn", "cli click(selector) forwards params");

    const waited = await run(["waitFor", '{"tabId":1,"selector":"#x"}']);
    assert(waited.params.selector === "#x", "cli waitFor forwards params");

    const scrolled = await run(["scroll", '{"tabId":1,"bottom":true}']);
    assert(scrolled.params.bottom === true, "cli scroll forwards params");

    // economy-mode: `snapshot` is sent as an eval carrying the DOM-digest script
    const snap = await run(["snapshot", '{"tabId":1,"maxText":50}']);
    assert(snap === "Example Domain", "cli snapshot round-trips as eval");

    // v0.1.7: no-debugger mode is the default; the debugger is opt-in with approval. (v0.1.10: wire field renamed stealth → direct.)
    const defDirect = await run(["type", '{"tabId":1,"text":"hi"}']);
    assert(defDirect.params.direct === true, "default sends direct:true");

    // --debugger pre-approves the debugger path (no prompt): direct:false
    const dbg = await run(["type", '{"tabId":1,"text":"hi"}', "--debugger"]);
    assert(dbg.params.direct === false, "--debugger sends direct:false");

    // --no-stealth is kept as a pre-0.1.10 alias for --debugger
    const noStealth = await run(["type", '{"tabId":1,"text":"hi"}', "--no-stealth"]);
    assert(noStealth.params.direct === false, "--no-stealth aliases --debugger");

    // AI_BRIDGE_DEBUGGER=1 pre-approves the CDP-only pdf command
    const pdfEnv = await run(["pdf", '{"tabId":1}'], { AI_BRIDGE_DEBUGGER: "1" });
    assert(pdfEnv.echo === "pdf" && pdfEnv.params.direct === false, "AI_BRIDGE_DEBUGGER=1 pre-approves pdf");

    // pdf is CDP-only: with no TTY and no approval it must fail fast, not send
    const pdfBlocked = await cli(relay, ["pdf", '{"tabId":1}', "--timeout", "5000"]);
    assert(pdfBlocked.code !== 0 && /debugger/i.test(pdfBlocked.stderr), "pdf without TTY/approval exits non-zero without sending");

    // BRIDGE_BIND: non-loopback bind logs the warning suffix; default bind does not
    const bound = await startRelay({ env: { BRIDGE_BIND: "0.0.0.0" } });
    assert(/listening on ws:\/\/0\.0\.0\.0:\d+ — make sure only the host's loopback can reach this port/.test(fs.readFileSync(bound.logFile, "utf8")), "BRIDGE_BIND=0.0.0.0 logs the warning suffix");
    const r = await cli(bound, ["ping", "--timeout", "3000"]);
    assert(r.code === 1 && /extension not connected/.test(r.stderr), "0.0.0.0 relay reachable from 127.0.0.1 (no extension → exit 1)");
    bound.stop();
    assert(/listening on ws:\/\/127\.0\.0\.1:\d+$/m.test(fs.readFileSync(relay.logFile, "utf8")), "default bind logged without the suffix");
  } catch (e) {
    assert(false, `cli round-trip threw: ${e.message}`);
  } finally {
    ext.close();
    relay.stop();
  }
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
