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
const { TOKEN_FILE, LOG_FILE, ensureToken } = require("./token");
const { appendTrace } = require("./journal");

const PORT = Number(process.env.BRIDGE_PORT || 8765);

function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`;
  try { fs.appendFileSync(LOG_FILE, entry); } catch {}
  console.log(`[bridge] ${line}`);
}

function start() {
const { token: TOKEN, created } = ensureToken();
if (created) console.log(`[bridge] token generated at ${TOKEN_FILE} — the extension picks it up via the native host (npm run register-host), or paste it into Options`);

let extension = null;                 // the single extension socket
const pending = new Map();            // request id -> { sock, cmd, params, meta, t0 }

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
      // meta.runId/job come from `bridge agent` via the CLI (AI_BRIDGE_RUN_ID);
      // every command of that run is traced to traces/<runId>.jsonl.
      const meta = msg.meta && typeof msg.meta === "object" ? msg.meta : null;
      pending.set(msg.id, { sock, cmd: msg.cmd, params: msg.params, meta, t0: Date.now() });
      log(`cmd ${msg.cmd} ${JSON.stringify(msg.params || {}).slice(0, 200)}${meta && meta.runId ? ` run=${meta.runId}` : ""}`);
      extension.send(JSON.stringify({ type: "command", id: msg.id, cmd: msg.cmd, params: msg.params }));
      return;
    }

    if (role === "extension" && msg.type === "response") {
      const req = pending.get(msg.id);
      pending.delete(msg.id);
      if (!req) return;
      if (req.meta && req.meta.runId) {
        appendTrace(req.meta.runId, {
          ts: new Date(req.t0).toISOString(), job: req.meta.job || undefined,
          cmd: req.cmd, params: req.params, ok: !!msg.ok, error: msg.ok ? undefined : msg.error,
          ms: Date.now() - req.t0, result: msg.ok ? msg.result : undefined,
        });
      }
      if (req.sock.readyState === 1) req.sock.send(JSON.stringify(msg));
      return;
    }
  });

  sock.on("close", () => {
    if (sock === extension) { extension = null; log("extension disconnected"); }
    for (const [id, r] of pending) if (r.sock === sock) pending.delete(id);
  });
});

log(`listening on ws://127.0.0.1:${PORT}`);
}

if (require.main === module) start();
module.exports = { start };
