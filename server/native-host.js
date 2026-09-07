#!/usr/bin/env node
// AI Browser Bridge — Chrome native messaging host.
//
// Chrome launches this process when the extension calls
// chrome.runtime.connectNative("com.ai_bridge.host") and talks to it over
// stdin/stdout (4-byte little-endian length prefix + JSON). Its job is small:
//
//   1. make sure the relay server is running on 127.0.0.1:PORT — start it
//      detached if it is not (so it outlives this process and Chrome);
//   2. hand the extension the token and port ("hello"), so nothing has to be
//      pasted into the Options page;
//   3. answer ping/status until Chrome closes the port, then exit.
//
// The WebSocket stays the data channel; native messaging is only used for
// bootstrap. Never write anything but frames to stdout.

const fs = require("fs");
const net = require("net");
const { spawn } = require("child_process");
const { LOG_FILE, SERVER_OUT, ensureToken } = require("./token");
const { serverArgs } = require("./runtime");

const PORT = Number(process.env.BRIDGE_PORT || 8765);
const VERSION = require("../package.json").version;

function log(line) {
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} native-host ${line}\n`); } catch {}
}

// ---------- framing ----------
function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

let buf = Buffer.alloc(0);
function onData(chunk) {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) return;
    const body = buf.subarray(4, 4 + len).toString("utf8");
    buf = buf.subarray(4 + len);
    let msg = null;
    try { msg = JSON.parse(body); } catch { continue; }
    onMessage(msg);
  }
}

// ---------- server lifecycle ----------
function isListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.setTimeout(500, () => { s.destroy(); resolve(false); });
  });
}

async function ensureServer() {
  if (await isListening(PORT)) return { started: false, pid: null };
  const out = fs.openSync(SERVER_OUT, "a");
  const child = spawn(process.execPath, serverArgs(), {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, BRIDGE_PORT: String(PORT) },
  });
  child.unref();
  log(`started server pid ${child.pid} on ${PORT}`);
  for (let i = 0; i < 50; i++) {            // up to ~5 s
    if (await isListening(PORT)) return { started: true, pid: child.pid };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start listening on ${PORT} within 5 s (see ${SERVER_OUT})`);
}

// ---------- protocol ----------
async function onMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ping") return send({ type: "pong", version: VERSION });
  if (msg.type === "status") return send({ type: "status", port: PORT, listening: await isListening(PORT), version: VERSION });
  if (msg.type === "hello") return hello();
}

async function hello() {
  try {
    const { token } = ensureToken();
    const { started, pid } = await ensureServer();
    send({ type: "hello", token, port: PORT, started, serverPid: pid, version: VERSION });
  } catch (e) {
    log(`hello failed: ${e.message}`);
    send({ type: "error", error: String(e && e.message || e) });
  }
}

function main() {
  process.stdin.on("data", onData);
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
  hello(); // Chrome opens the port; we speak first so the extension needs no request.
}

if (require.main === module) main();
module.exports = { main };
