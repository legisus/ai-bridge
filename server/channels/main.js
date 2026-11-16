#!/usr/bin/env node
// `bridge channels start|status` — the messenger daemon.
//
// One long-running process holds the messenger connections (Telegram first),
// turns paired users' messages into restricted `runAgent` runs, and sends the
// results back. Separate from the relay (server.js) on purpose: the relay is
// started on demand by the native host and must stay tiny.
const fs = require("fs");
const path = require("path");
const { DIR } = require("../token");
const { loadConfig, redact } = require("./config");
const { makeLogger } = require("./log");
const { Manager } = require("./manager");
const { ChannelState } = require("./state");

const LOCK_FILE = path.join(DIR, "channels.lock");
const ADAPTERS = { telegram: () => require("./telegram") };

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function readLock() {
  try { return Number(fs.readFileSync(LOCK_FILE, "utf8").trim()) || 0; } catch { return 0; }
}

function acquireLock() {
  const pid = readLock();
  if (pid && pid !== process.pid && pidAlive(pid)) throw new Error(`another channels daemon is running (pid ${pid}); stop it first or remove ${LOCK_FILE}`);
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { mode: 0o700, recursive: true });
  fs.writeFileSync(LOCK_FILE, String(process.pid), { mode: 0o600 });
  const release = () => { try { if (readLock() === process.pid) fs.unlinkSync(LOCK_FILE); } catch {} };
  return release;
}

function buildAdapters(config, deps) {
  const out = [];
  for (const [name, cfg] of Object.entries(config)) {
    const make = ADAPTERS[name];
    if (!make) throw new Error(`unknown channel "${name}" in channels.json; known channels: ${Object.keys(ADAPTERS).join(", ")}`);
    out.push(make()(cfg, deps));
  }
  return out;
}

async function start({ verbose = false } = {}) {
  const config = loadConfig();
  const log = makeLogger({ redact: (t) => redact(t, config), verbose });
  const adapters = buildAdapters(config, { log, fetch: globalThis.fetch });
  const release = acquireLock();
  const manager = new Manager({ config, adapters, state: new ChannelState(), log });
  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: stopping`);
    try { await manager.stop(); } catch {}
    release();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", release);
  await manager.start();
  const line = `channels daemon started (pid ${process.pid}): ${adapters.map((a) => a.id).join(", ")}; state in ${DIR}`;
  log(line);
  console.log(line);
  return manager;
}

function status() {
  const pid = readLock();
  console.log(pid ? `daemon: ${pidAlive(pid) ? "running" : "not running (stale lock)"} (pid ${pid})` : "daemon: not running");
  let config;
  try { config = loadConfig(); } catch (e) { console.log(`config: ${e.message}`); return; }
  for (const [name, c] of Object.entries(config)) {
    console.log(`channel ${name}: dmPolicy ${c.dmPolicy}, allowFrom ${c.allowFrom.length ? c.allowFrom.join(",") : "(none)"}, codex ${c.codex ? "on" : "off"}`);
  }
}

async function main(argv) {
  const sub = argv[0];
  const verbose = argv.includes("--verbose");
  if (sub === "start") { await start({ verbose }); return; }
  if (sub === "status") { status(); return; }
  console.error("usage: bridge channels start [--verbose] | status");
  process.exit(2);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}

module.exports = { main, start, status, LOCK_FILE, ADAPTERS, buildAdapters, acquireLock };
