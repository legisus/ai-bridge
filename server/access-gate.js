// The agent's access gate (design: docs/superpowers/specs/2026-11-21-docker-
// isolated-access-design.md, "Agent and channel runs").
//
// The supervisor never trusts a model child to notice that the user revoked
// the browser. It pings the relay itself: the pre-flight requires
// access === "granted" and latches the identity triple (serverId, extGen,
// accessGen); every later check requires the same triple. Any change — a
// revoke, a revoke-then-regrant, a relay restart, another extension taking the
// connection — a non-granted state, a disconnected extension, a malformed reply
// or two consecutive ping timeouts end the run with the structured error
// `access_revoked` and abort the running child. The ladder never climbs on it.
"use strict";

const { spawn } = require("child_process");
const { selfArgs } = require("./runtime");

class AccessError extends Error {
  constructor(reason) {
    super(`access_revoked: ${reason}`);
    this.name = "AccessError";
    this.code = "access_revoked";
    this.reason = reason;
  }
}

// `bridge ping` through the CLI: the first stdout line as JSON. Rejects with
// Error("timeout") after timeoutMs, with the CLI's stderr on a non-zero exit.
function defaultPing({ timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, selfArgs(["ping", "--timeout", String(timeoutMs)]), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", done = false;
    const finish = (fn) => { if (!done) { done = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => finish(() => { try { child.kill("SIGKILL"); } catch {} reject(new Error("timeout")); }), timeoutMs + 500);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) => finish(() => {
      if (code !== 0) return reject(new Error((err.trim() || out.trim() || `ping exited ${code}`).split("\n")[0]));
      try { resolve(JSON.parse(out.split("\n")[0])); } catch { reject(new Error("malformed ping reply")); }
    }));
  });
}

function createAccessGate({ ping = defaultPing, intervalMs = 10000, timeoutMs = 5000 } = {}) {
  let identity = null;
  let timeouts = 0;

  // One ping, interpreted. Returns the reply; throws AccessError for every
  // non-granted outcome. A single timeout is tolerated (returns null).
  async function probe() {
    let reply;
    try { reply = await ping({ timeoutMs }); }
    catch (e) {
      const msg = String(e && e.message || e);
      if (/^timeout$/i.test(msg)) {
        timeouts++;
        if (timeouts >= 2) throw new AccessError("ping timed out twice");
        return null;
      }
      if (/extension not connected/.test(msg)) throw new AccessError("extension not connected");
      if (/^(ERROR: )?access_(revoked|not_granted): (.*?)(?: \(req [0-9a-f]+\))?$/.test(msg)) {
        throw new AccessError(msg.replace(/^ERROR: /, "").replace(/^access_(revoked|not_granted): /, "").replace(/ \(req [0-9a-f]+\)$/, ""));
      }
      throw new AccessError(`ping failed: ${msg.slice(0, 160)}`);
    }
    timeouts = 0;
    if (!reply || typeof reply !== "object" || typeof reply.serverId !== "string" || !Number.isInteger(reply.extGen) || !Number.isInteger(reply.accessGen) || typeof reply.access !== "string") {
      throw new AccessError("malformed ping reply (relay without the access contract?)");
    }
    const session = typeof reply.session === "string" ? reply.session : "chrome";
    if (reply.access === "not_granted") throw new AccessError(`access not granted yet (session "${session}")`);
    if (reply.access !== "granted") throw new AccessError(`access revoked by user (session "${session}")`);
    return reply;
  }

  const gate = {
    get identity() { return identity; },
    async preflight() {
      const r = await probe();
      if (!r) throw new AccessError("ping timed out");
      identity = { serverId: r.serverId, extGen: r.extGen, accessGen: r.accessGen, session: typeof r.session === "string" ? r.session : "chrome" };
      return { ...identity };
    },
    async check() {
      if (!identity) return gate.preflight().then(() => undefined);
      const r = await probe();
      if (!r) return; // one tolerated timeout
      const changed = ["serverId", "extGen", "accessGen"].filter((k) => r[k] !== identity[k]);
      if (changed.length) throw new AccessError(`identity changed (${changed.join(", ")})`);
    },
    intervalMs,
  };
  return gate;
}

// Run one model child under the gate: a check before the spawn, a check every
// intervalMs while it runs; a failing check aborts the child and the
// AccessError is what the caller sees, whatever the child died of.
async function withAccess(gate, run, opts = {}) {
  await gate.check();
  const controller = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  let failure = null;
  let checking = false;
  const timer = setInterval(() => {
    if (checking || failure) return;
    checking = true;
    gate.check().catch((e) => { failure = e instanceof AccessError ? e : new AccessError(String(e && e.message || e)); controller.abort(); }).finally(() => { checking = false; });
  }, gate.intervalMs);
  try {
    return await run({ ...opts, signal: controller.signal });
  } catch (e) {
    if (failure) throw failure;
    throw e;
  } finally {
    clearInterval(timer);
    if (failure) throw failure;
  }
}

// Tests only: AI_BRIDGE_NO_ACCESS_GATE=1 makes the default gate a pass-through
// (the unit tests inject a mock runner and have no relay to ping).
function passthroughGate() {
  return { identity: null, intervalMs: 3600e3, async preflight() { return null; }, async check() {} };
}
function defaultGate() {
  return process.env.AI_BRIDGE_NO_ACCESS_GATE === "1" ? passthroughGate() : createAccessGate();
}

module.exports = { AccessError, createAccessGate, withAccess, defaultPing, defaultGate, passthroughGate };
