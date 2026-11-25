#!/usr/bin/env node
// AI Browser Bridge — local relay server.
// One persistent "extension" client (the Chrome extension) and any number of
// transient "cli" clients. CLI requests are forwarded to the extension; its
// responses are routed back by request id.
//
// Security model: binds 127.0.0.1 only; every client must present the token
// from ~/.ai-browser-bridge/token (created on first start, chmod 600).
//
// Access: the extension reports whether the user has granted it the browser
// session (`access` message, server/access.js). While access is not granted,
// every command except ping/status is refused here without forwarding; the
// extension enforces the same rule on its side. Each extension socket gets a
// generation number; `ping`/`status` results carry (serverId, extGen,
// accessGen) so a run can notice a different server, extension or grant.

const { WebSocketServer } = require("ws");
const fs = require("fs");
const { TOKEN_FILE, LOG_FILE, ensureToken } = require("./token");
const crypto = require("crypto");
const { appendTrace, safeRunId } = require("./journal");
const { normalizeAccess, stateOf, ACCESS_REVOKED, ACCESS_NOT_GRANTED } = require("./access");

const PORT = Number(process.env.BRIDGE_PORT || 8765);
// Listen address. 127.0.0.1 unless the relay runs in a container, where the
// compose file publishes the port on the host's loopback (docs/DOCKER.md).
const BIND = process.env.BRIDGE_BIND || "127.0.0.1";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`;
  try { fs.appendFileSync(LOG_FILE, entry); } catch {}
  console.log(`[bridge] ${line}`);
}

function start({ port = PORT, bind = BIND } = {}) {
const { token: TOKEN, created } = ensureToken();
if (created) console.log(`[bridge] token generated at ${TOKEN_FILE} — the extension picks it up via the native host (npm run register-host), or paste it into Options`);

const serverId = crypto.randomBytes(16).toString("hex"); // identity of this server process
let ext = null;                       // { sock, gen, access } — the single extension socket
let extGen = 0;                       // bumped on every extension authentication
const pending = new Map();            // request id -> { id, sock, cmd, params, meta, t0, gen }
const PASS_ALWAYS = new Set(["ping", "status"]); // touch no tab: forwarded whatever the access state

const accessState = () => (ext ? stateOf(ext.access) : "not_granted");
const sessionName = () => (ext && ext.access ? ext.access.session : "chrome");
const extUp = () => !!(ext && ext.sock.readyState === 1);

// A client label for the log: AI_BRIDGE_CLIENT from the CLI (or its parent
// process name), printable, at most 40 characters.
function sanitizeClient(v) {
  const c = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
  return c || "cli";
}

// The one place a request ends. Logs the terminal line, traces it when the
// request belongs to a run, answers the CLI socket (if still open) or the
// internal caller — exactly once per request, whatever the outcome:
//   { kind: "done", ok, result?, error? }     forwarded result from the extension
//   { kind: "refused", error }                local refusal (access, not connected)
//   { kind: "cancelled", reason }             extension gone, superseded, revoked
function finish(req, outcome) {
  if (!pending.delete(req.id)) return; // already finished
  const ms = Date.now() - req.t0;
  const who = `${req.id} ${req.client} ${req.runId || "-"}`;
  let ok = false, error, result;
  if (outcome.kind === "done") {
    ok = !!outcome.ok; result = ok ? outcome.result : undefined; error = ok ? undefined : String(outcome.error);
    log(`${who} done ${ok ? "ok" : "fail"} ${ms}ms${ok ? "" : ` ${error.slice(0, 200)}`}`);
  } else if (outcome.kind === "refused") {
    error = outcome.error;
    log(`${who} refused ${error.split(":")[0]}`);
  } else {
    error = outcome.reason;
    log(`${who} cancelled ${error}`);
  }
  if (req.runId) {
    const as = req.meta && req.meta.as && typeof req.meta.as === "object" ? req.meta.as : null; // e.g. snapshot sent as eval
    appendTrace(req.runId, {
      ts: new Date(req.t0).toISOString(), reqId: req.id, client: req.client, outcome: outcome.kind,
      job: req.meta && req.meta.job ? String(req.meta.job) : undefined,
      cmd: as && as.cmd ? String(as.cmd) : req.cmd, params: as ? as.params : req.params,
      ok, error, ms, result,
    });
  }
  const msg = { type: "response", id: req.id, ok, ...(ok ? { result } : { error }) };
  if (req.sock && req.sock.readyState === 1) req.sock.send(JSON.stringify(msg));
  if (req.resolve) req.resolve({ ok, result, error });
}
// Cancel every pending request of one extension generation that `filter` selects.
function cancelPending(gen, filter, reason) {
  for (const r of [...pending.values()]) if (r.gen === gen && filter(r)) finish(r, { kind: "cancelled", reason });
}
function dropExtension(reason) {
  if (!ext) return;
  const { sock: oldSock, gen } = ext;
  ext = null;
  log(reason);
  try { oldSock.close(); } catch {}
  cancelPending(gen, () => true, "extension disconnected");
}

const wss = new WebSocketServer({ host: bind, port, maxPayload: 64 * 1024 * 1024 });
wss.on("listening", () => {
  log(`listening on ws://${bind}:${wss.address().port}${LOOPBACK.has(bind) ? "" : " — make sure only the host's loopback can reach this port"}`);
});

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
        if (ext) dropExtension(`extension superseded (gen ${ext.gen} → ${extGen + 1})`);
        extGen++;
        ext = { sock, gen: extGen, access: null }; // not_granted until its first access message
        log(`extension connected (gen ${extGen})`);
      }
      sock.send(JSON.stringify({ type: "auth", ok: true }));
      return;
    }

    if (role === "cli" && msg.type === "request") {
      // meta: { client, runId?, job?, as? } from the CLI (AI_BRIDGE_CLIENT, AI_BRIDGE_RUN_ID…).
      const meta = msg.meta && typeof msg.meta === "object" ? msg.meta : null;
      const req = { id: String(msg.id), sock, cmd: msg.cmd, params: msg.params, meta, t0: Date.now(), gen: ext ? ext.gen : 0,
        client: sanitizeClient(meta && meta.client), runId: meta ? safeRunId(meta.runId) : null };
      pending.set(req.id, req);
      log(`${req.id} ${req.client} ${req.runId || "-"} cmd ${msg.cmd} ${JSON.stringify(msg.params || {}).slice(0, 200)}`);
      if (!extUp()) return finish(req, { kind: "refused", error: "extension not connected" });
      if (!PASS_ALWAYS.has(msg.cmd) && accessState() !== "granted") {
        return finish(req, { kind: "refused", error: ext.access == null ? ACCESS_NOT_GRANTED(sessionName()) : ACCESS_REVOKED(sessionName()) });
      }
      ext.sock.send(JSON.stringify({ type: "command", id: msg.id, cmd: msg.cmd, params: msg.params }));
      return;
    }

    if (role === "extension" && msg.type === "access") {
      if (!ext || sock !== ext.sock) return; // a superseded socket has no say
      const prev = stateOf(ext.access);
      const a = normalizeAccess(msg);
      ext.access = a;
      if (a.reason === "bad_until" || a.reason === "bad_browser_session") log(`access message rejected: ${a.reason} (treated as revoked)`);
      const next = stateOf(a);
      if (next !== prev) {
        log(next === "granted"
          ? `access granted (session "${a.session}", until ${a.until === null ? "never" : new Date(a.until).toISOString()})`
          : `access revoked (session "${a.session}")`);
      }
      // The extension will refuse them anyway; do not make the CLI wait for that.
      if (next !== "granted") cancelPending(ext.gen, (r) => !PASS_ALWAYS.has(r.cmd), ACCESS_REVOKED(a.session));
      return;
    }

    if (role === "extension" && msg.type === "response") {
      if (!ext || sock !== ext.sock) return; // late answer from a superseded socket
      const req = pending.get(String(msg.id));
      if (!req) return;
      let result = msg.result;
      if (msg.ok && PASS_ALWAYS.has(req.cmd)) {
        const base = result && typeof result === "object" ? result : { value: result };
        result = { ...base, session: sessionName(), access: accessState(), until: ext.access ? ext.access.until : null,
          accessGen: ext.access ? ext.access.gen : 0, extGen: ext.gen, serverId };
      }
      finish(req, { kind: "done", ok: !!msg.ok, result, error: msg.error });
      return;
    }
  });

  sock.on("close", () => {
    if (ext && sock === ext.sock) dropExtension("extension disconnected");
    // A CLI that went away only loses its answer; the request itself still
    // finishes (and is logged, traced and, for newTab, recorded) when the
    // extension responds.
    for (const r of pending.values()) if (r.sock === sock) r.sock = null;
  });
});

return wss;
}

if (require.main === module) start();
module.exports = { start };
