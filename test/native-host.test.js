#!/usr/bin/env node
// Native messaging host test: speaks Chrome's stdio framing to
// server/native-host.js in an isolated state dir and asserts that it
// (1) starts the relay server detached, (2) hands over the token from the
// token file, (3) answers ping, and (4) the server keeps running after the
// host exits (Chrome closing the port must not kill the relay).

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const PORT = 8798;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-nh-"));
const env = { ...process.env, BRIDGE_PORT: String(PORT), AI_BRIDGE_HOME: HOME };
const HOST = path.join(__dirname, "..", "server", "native-host.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

const frame = (obj) => { const b = Buffer.from(JSON.stringify(obj)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length, 0); return Buffer.concat([h, b]); };
function listening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}

(async () => {
  assert(!(await listening(PORT)), "precondition: test port free");

  const host = spawn("node", [HOST], { env, stdio: ["pipe", "pipe", "pipe"] });
  const frames = [];
  let buf = Buffer.alloc(0);
  const waiters = [];
  host.stdout.on("data", (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      frames.push(JSON.parse(buf.subarray(4, 4 + len).toString()));
      buf = buf.subarray(4 + len);
      while (waiters.length) waiters.shift()();
    }
  });
  const next = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for frame")), ms);
    const check = () => { const f = frames.find(pred); if (f) { clearTimeout(t); resolve(f); return true; } return false; };
    if (!check()) waiters.push(() => check());
  });

  let serverPid = null;
  try {
    const hello = await next((f) => f.type === "hello" || f.type === "error");
    assert(hello.type === "hello", `host sends hello (${hello.type === "error" ? hello.error : "ok"})`);
    const token = fs.readFileSync(path.join(HOME, "token"), "utf8").trim();
    assert(hello.token === token && token.length === 48, "hello carries the token from the state dir");
    assert(hello.port === PORT, "hello carries the port");
    assert(hello.started === true && Number.isInteger(hello.serverPid), "host started the server (pid reported)");
    serverPid = hello.serverPid;
    assert(await listening(PORT), "server is listening after hello");

    host.stdin.write(frame({ type: "ping" }));
    const pong = await next((f) => f.type === "pong");
    assert(pong.version === require("../package.json").version, "ping → pong with version");

    host.stdin.write(frame({ type: "status" }));
    const st = await next((f) => f.type === "status");
    assert(st.listening === true && st.port === PORT, "status reports listening");

    // Chrome closes the port → host exits; the detached server must survive.
    host.stdin.end();
    const code = await new Promise((r) => host.on("exit", r));
    assert(code === 0, "host exits 0 when stdin closes");
    await new Promise((r) => setTimeout(r, 300));
    assert(await listening(PORT), "server keeps running after the host exits");

    // Second host run finds the server already up and does not start another.
    const host2 = spawn("node", [HOST], { env, stdio: ["pipe", "pipe", "pipe"] });
    const out2 = await new Promise((resolve) => { let b = Buffer.alloc(0); host2.stdout.on("data", (c) => { b = Buffer.concat([b, c]); if (b.length >= 4 && b.length >= 4 + b.readUInt32LE(0)) resolve(JSON.parse(b.subarray(4, 4 + b.readUInt32LE(0)).toString())); }); });
    assert(out2.type === "hello" && out2.started === false && out2.token === token, "second host reuses the running server, same token");
    host2.stdin.end();
  } catch (e) {
    assert(false, `native host flow: ${e.message}`);
  } finally {
    if (serverPid) { try { process.kill(serverPid); } catch {} }
    try { host.kill(); } catch {}
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} native-host test(s) FAILED` : "\nAll native-host tests passed.");
  process.exit(failures ? 1 : 0);
})();
