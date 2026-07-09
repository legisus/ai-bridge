#!/usr/bin/env node
// AI Browser Bridge — local relay server.
// One persistent "extension" client (the Chrome extension) and any number of
// transient "cli" clients. CLI requests are forwarded to the extension; its
// responses are routed back by request id.
//
// Security model: binds 127.0.0.1 only; every client must present the token
// from ~/.ai-browser-bridge/token (created on first start, chmod 600).

const { WebSocketServer } = require("ws");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.BRIDGE_PORT || 8765);
const DIR = path.join(os.homedir(), ".ai-browser-bridge");
const TOKEN_FILE = path.join(DIR, "token");
const LOG_FILE = path.join(DIR, "bridge.log");

function ensureToken() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { mode: 0o700 });
  if (!fs.existsSync(TOKEN_FILE)) {
    fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
    console.log(`[bridge] token generated at ${TOKEN_FILE} — paste it into the extension's Options page`);
  }
  return fs.readFileSync(TOKEN_FILE, "utf8").trim();
}

function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`;
  try { fs.appendFileSync(LOG_FILE, entry); } catch {}
  console.log(`[bridge] ${line}`);
}

const TOKEN = ensureToken();

let extension = null;                 // the single extension socket
const pending = new Map();            // request id -> cli socket

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT, maxPayload: 64 * 1024 * 1024 });

wss.on("connection", (sock) => {
  let role = null;

  sock.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return sock.close(); }

    // First message must authenticate.
    if (!role) {
      if (msg.type !== "auth" || msg.token !== TOKEN) {
        log(`auth failed (${msg.role || "unknown"})`);
        return sock.close();
      }
      role = msg.role === "extension" ? "extension" : "cli";
      if (role === "extension") {
        if (extension) try { extension.close(); } catch {}
        extension = sock;
        log("extension connected");
      }
      sock.send(JSON.stringify({ type: "auth", ok: true }));
      return;
    }

    if (role === "cli" && msg.type === "request") {
      if (!extension || extension.readyState !== 1) {
        return sock.send(JSON.stringify({ type: "response", id: msg.id, ok: false, error: "extension not connected" }));
      }
      pending.set(msg.id, sock);
      log(`cmd ${msg.cmd} ${JSON.stringify(msg.params || {}).slice(0, 200)}`);
      extension.send(JSON.stringify({ type: "command", id: msg.id, cmd: msg.cmd, params: msg.params }));
      return;
    }

    if (role === "extension" && msg.type === "response") {
      const cli = pending.get(msg.id);
      pending.delete(msg.id);
      if (cli && cli.readyState === 1) cli.send(JSON.stringify(msg));
      return;
    }
  });

  sock.on("close", () => {
    if (sock === extension) { extension = null; log("extension disconnected"); }
    for (const [id, c] of pending) if (c === sock) pending.delete(id);
  });
});

log(`listening on ws://127.0.0.1:${PORT}`);
