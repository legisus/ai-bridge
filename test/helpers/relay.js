// Test harness for the relay: a server on a temp AI_BRIDGE_HOME and a dynamic
// port, a fake extension, the real CLI, and a run-lease socket. Every test
// that talks to server/server.js goes through here so nothing touches the
// real ~/.ai-browser-bridge or a fixed port.
"use strict";

const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const SERVER = path.join(__dirname, "..", "..", "server", "server.js");
const CLI = path.join(__dirname, "..", "..", "server", "cli.js");

const randomHex32 = () => crypto.randomBytes(16).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spawn the relay; resolve once its "listening on ws://<bind>:<port>" line is out.
function startRelay({ env = {}, home } = {}) {
  const ownHome = !home;
  home = home || fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-relay-"));
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, BRIDGE_PORT: "0", AI_BRIDGE_HOME: home, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "";
  proc.stderr.on("data", (d) => { err += d; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`relay did not start: ${out}${err}`)); }, 5000);
    proc.stdout.on("data", (d) => {
      out += d;
      const m = /listening on ws:\/\/[^:\s]+:(\d+)/.exec(out);
      if (!m) return;
      clearTimeout(timer);
      const relay = {
        port: Number(m[1]), home, proc,
        token: fs.readFileSync(path.join(home, "token"), "utf8").trim(),
        logFile: path.join(home, "bridge.log"),
        stop({ keepHome = false } = {}) {
          try { proc.kill(); } catch {}
          if (ownHome && !keepHome) { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} }
        },
      };
      resolve(relay);
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`relay exited ${code}: ${out}${err}`)); });
  });
}

// A simulated extension socket. Sends `access granted` after auth unless
// access === false. `handler(cmd, params, id)` returns the result, or
// undefined to leave the command unanswered (answer later with respond()).
// `hold(cmd, params)` → true leaves a command unanswered while the default
// handler serves everything else.
function fakeExtension(relay, { browserSession = randomHex32(), session = "chrome", access = true, handler, hold, agentTabs = [] } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}`);
  const ext = {
    ws, browserSession, session, received: [], agentTabs: [...agentTabs],
    nextTabId: 100,
    sendAccess(fields = {}) {
      ws.send(JSON.stringify({ type: "access", session, granted: true, until: null, gen: 1, browserSession, ...fields }));
    },
    respond(id, { ok = true, result, error } = {}) {
      ws.send(JSON.stringify({ type: "response", id, ok, ...(ok ? { result } : { error }) }));
    },
    waitFor(cmd, { timeoutMs = 3000 } = {}) {
      return new Promise((resolve, reject) => {
        const seen = ext.received.length;
        const t0 = Date.now();
        const tick = () => {
          const m = ext.received.slice(seen).find((x) => x.cmd === cmd);
          if (m) return resolve(m);
          if (Date.now() - t0 > timeoutMs) return reject(new Error(`no ${cmd} command within ${timeoutMs} ms`));
          setTimeout(tick, 10);
        };
        tick();
      });
    },
    close() { try { ws.close(); } catch {} },
  };
  const defaultHandler = (cmd, params) => {
    switch (cmd) {
      case "ping": return { pong: true, version: "test" };
      case "status": return { version: "test", attachedTabs: [], agentTabs: [...ext.agentTabs] };
      case "newTab": {
        if (/fail\.example/.test(String(params && params.url))) return { __error: "could not create" };
        const id = ext.nextTabId++;
        ext.agentTabs.push(id);
        return { id, windowId: 1 };
      }
      case "closeTabs": {
        const ids = Array.isArray(params && params.tabIds) ? params.tabIds : [];
        ext.agentTabs = ext.agentTabs.filter((t) => !ids.includes(t));
        return { closed: ids, skipped: [] };
      }
      case "closeTab": ext.agentTabs = ext.agentTabs.filter((t) => t !== (params && params.tabId)); return { ok: true };
      default: return { echo: cmd, params };
    }
  };
  return new Promise((resolve, reject) => {
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", role: "extension", token: relay.token })));
    ws.on("error", reject);
    ws.on("message", (data) => {
      const msg = JSON.parse(data);
      if (msg.type === "auth" && msg.ok) {
        if (access !== false) ext.sendAccess();
        setTimeout(() => resolve(ext), 50);
        return;
      }
      if (msg.type !== "command") return;
      ext.received.push(msg);
      if (hold && hold(msg.cmd, msg.params || {})) return;
      let result = handler ? handler(msg.cmd, msg.params || {}, msg.id) : undefined;
      if (result === undefined && !handler) result = defaultHandler(msg.cmd, msg.params || {});
      else if (result === undefined && handler) result = undefined;
      if (result === undefined) return; // held; the test answers via respond()
      if (result && result.__error) return ext.respond(msg.id, { ok: false, error: result.__error });
      ext.respond(msg.id, { ok: true, result });
    });
  });
}

// Run the real CLI against the relay.
function cli(relay, args, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, BRIDGE_PORT: String(relay.port), AI_BRIDGE_HOME: relay.home, ...env },
      timeout: 20000, maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      let json = null;
      try { json = JSON.parse(String(stdout).split("\n")[0]); } catch {}
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), json });
    });
  });
}

// A supervisor's lease socket: auth as cli, register the run, keep it open.
function leaseSocket(relay, { runId, client = "test", keepTabs = false }) {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}`);
  const lease = {
    ws, messages: [],
    send(obj) { ws.send(JSON.stringify(obj)); },
    end() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no runEnd ack")), 10000);
        const onMsg = (d) => {
          const m = JSON.parse(d);
          if (m.type !== "runEnd") return;
          clearTimeout(timer); ws.off("message", onMsg);
          try { ws.close(); } catch {}
          resolve(m);
        };
        ws.on("message", onMsg);
        lease.send({ type: "runEnd", runId });
      });
    },
    close() { try { ws.close(); } catch {} },
  };
  return new Promise((resolve, reject) => {
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", role: "cli", token: relay.token })));
    ws.on("error", reject);
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      lease.messages.push(m);
      if (m.type === "auth" && m.ok) return lease.send({ type: "run", runId, client, keepTabs });
      if (m.type === "run") return m.ok ? resolve(lease) : reject(new Error(m.error || "run refused"));
    });
  });
}

module.exports = { startRelay, fakeExtension, cli, leaseSocket, randomHex32, sleep };
