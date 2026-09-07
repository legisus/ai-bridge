#!/usr/bin/env node
// Single-executable build test. Skips (exit 0) when dist/ai-bridge is absent,
// so `npm test` works without a build; run `npm run build:sea` first to cover it.
// Exercises every dispatch mode of the binary in an isolated state dir:
// serve, CLI round-trip through a simulated extension, host mode (as Chrome
// invokes it, with a chrome-extension:// origin argument), register-host, agent
// usage — all with node removed from PATH.
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const BIN = path.join(__dirname, "..", "dist", process.platform === "win32" ? "ai-bridge.exe" : "ai-bridge");
if (!fs.existsSync(BIN)) { console.log("SKIP  sea: dist/ai-bridge not built (npm run build:sea)"); process.exit(0); }

const PORT = 8796;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-sea-"));
// No node on PATH: the binary must be self-contained.
const env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE || "", PATH: process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin", BRIDGE_PORT: String(PORT), AI_BRIDGE_HOME: HOME };
const EXT_ID = fs.readFileSync(path.join(__dirname, "..", "extension", "EXTENSION_ID"), "utf8").trim();

let failures = 0;
const assert = (c, n) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}`); if (!c) failures++; };
const cli = (args) => new Promise((res) => execFile(BIN, args, { env }, (e, out, err) => res({ code: e ? e.code : 0, out, err })));
const listening = (port) => new Promise((r) => { const s = net.connect({ host: "127.0.0.1", port }); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); });
const frame = (o) => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length, 0); return Buffer.concat([h, b]); };

(async () => {
  let serve = null, ext = null;
  try {
    // no args → usage, exit 2
    const u = await cli([]);
    assert(u.code === 2 && /usage: bridge/.test(u.err), "no args → usage, exit 2");

    // serve
    serve = spawn(BIN, ["serve"], { env, stdio: "pipe" });
    for (let i = 0; i < 50 && !(await listening(PORT)); i++) await new Promise((r) => setTimeout(r, 100));
    assert(await listening(PORT), "`ai-bridge serve` listens on the test port");
    const token = fs.readFileSync(path.join(HOME, "token"), "utf8").trim();
    assert(token.length === 48, "serve generated a token in AI_BRIDGE_HOME");

    // simulated extension
    ext = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((r) => ext.on("open", r));
    ext.send(JSON.stringify({ type: "auth", role: "extension", token }));
    ext.on("message", (d) => { const m = JSON.parse(d); if (m.type === "command") ext.send(JSON.stringify({ type: "response", id: m.id, ok: true, result: { echo: m.cmd, params: m.params } })); });
    await new Promise((r) => setTimeout(r, 200));

    // CLI round trip
    const lt = await cli(["listTabs"]);
    assert(lt.code === 0 && JSON.parse(lt.out).echo === "listTabs", "CLI round-trip through the binary (listTabs)");
    const ev = await cli(["eval", '{"tabId":1,"code":"1+1"}']);
    assert(JSON.parse(ev.out).params.direct === true, "CLI sends direct:true by default");
    const dbg = await cli(["type", '{"tabId":1,"text":"x"}', "--debugger"]);
    assert(JSON.parse(dbg.out).params.direct === false, "--debugger flag works in the binary");

    // host mode as Chrome invokes it: origin as argv[2]
    const host = spawn(BIN, [`chrome-extension://${EXT_ID}/`], { env, stdio: "pipe" });
    const hello = await new Promise((resolve, reject) => {
      let b = Buffer.alloc(0); const t = setTimeout(() => reject(new Error("no hello")), 8000);
      host.stdout.on("data", (c) => { b = Buffer.concat([b, c]); if (b.length >= 4 && b.length >= 4 + b.readUInt32LE(0)) { clearTimeout(t); resolve(JSON.parse(b.subarray(4, 4 + b.readUInt32LE(0)).toString())); } });
    });
    assert(hello.type === "hello" && hello.token === token && hello.port === PORT && hello.started === false, "host mode (chrome-extension:// argv) sends hello, reuses running server");
    host.stdin.write(frame({ type: "ping" }));
    host.stdin.end();
    await new Promise((r) => host.on("exit", r));

    // host mode starts the server when it is down
    serve.kill(); await new Promise((r) => setTimeout(r, 300));
    assert(!(await listening(PORT)), "serve killed");
    const host2 = spawn(BIN, ["host"], { env, stdio: "pipe" });
    const hello2 = await new Promise((resolve, reject) => {
      let b = Buffer.alloc(0); const t = setTimeout(() => reject(new Error("no hello")), 10000);
      host2.stdout.on("data", (c) => { b = Buffer.concat([b, c]); if (b.length >= 4 && b.length >= 4 + b.readUInt32LE(0)) { clearTimeout(t); resolve(JSON.parse(b.subarray(4, 4 + b.readUInt32LE(0)).toString())); } });
    });
    assert(hello2.type === "hello" && hello2.started === true && Number.isInteger(hello2.serverPid), "host mode spawns `serve` from the binary when the server is down");
    assert(await listening(PORT), "spawned server is listening");
    host2.stdin.end(); await new Promise((r) => host2.on("exit", r));
    try { process.kill(hello2.serverPid); } catch {}

    // register-host --print points at the binary itself
    const rp = await cli(["register-host", "--print"]);
    const man = JSON.parse(rp.out);
    assert(man.path === BIN && man.allowed_origins[0] === `chrome-extension://${EXT_ID}/`, "register-host --print: manifest path is the binary, embedded extension id");

    // agent usage
    const ag = await cli(["agent"]);
    assert(ag.code === 2 && /usage: bridge agent/.test(ag.err), "agent subcommand dispatches in-process");
  } catch (e) {
    assert(false, `sea flow: ${e.message}`);
  } finally {
    try { ext && ext.close(); } catch {}
    try { serve && serve.kill(); } catch {}
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} sea test(s) FAILED` : "\nAll sea tests passed.");
  process.exit(failures ? 1 : 0);
})();
