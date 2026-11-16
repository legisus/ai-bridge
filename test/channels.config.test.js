#!/usr/bin/env node
// Channel config: defaults, env overrides, mode check, redaction; rotating redacted logger.
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-config-"));
const { CONFIG_FILE, loadConfig, redact } = require("../server/channels/config.js");
const { makeLogger } = require("../server/channels/log.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

assert(CONFIG_FILE === path.join(process.env.AI_BRIDGE_HOME, "channels.json"), "CONFIG_FILE under AI_BRIDGE_HOME");

// missing file → clear error
let err = null; try { loadConfig({ env: {} }); } catch (e) { err = e; }
assert(err && /channels\.json/.test(err.message) && /not found|missing/i.test(err.message), "loadConfig: missing file names the path");

// defaults
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { token: "123:ABC" } }), { mode: 0o600 });
let cfg = loadConfig({ env: {} });
assert(cfg.telegram.token === "123:ABC" && cfg.telegram.dmPolicy === "pairing" && JSON.stringify(cfg.telegram.allowFrom) === "[]" && cfg.telegram.codex === false && cfg.telegram.accountId === "default",
  "loadConfig: defaults applied (pairing, empty allowFrom, codex false, default account)");

// env override wins
cfg = loadConfig({ env: { AI_BRIDGE_TELEGRAM_TOKEN: "999:ENV" } });
assert(cfg.telegram.token === "999:ENV", "loadConfig: AI_BRIDGE_<CHANNEL>_TOKEN overrides the file");

// explicit values kept, allowFrom normalised to strings
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { token: "t", dmPolicy: "allowlist", allowFrom: [42, "7"], codex: true } }), { mode: 0o600 });
cfg = loadConfig({ env: {} });
assert(cfg.telegram.dmPolicy === "allowlist" && JSON.stringify(cfg.telegram.allowFrom) === '["42","7"]' && cfg.telegram.codex === true, "loadConfig: explicit values kept, allowFrom stringified");
assert(JSON.stringify(cfg.telegram.envPassthrough) === "[]", "loadConfig: envPassthrough defaults to []");
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { token: "t", envPassthrough: ["HTTPS_PROXY", 7] } }), { mode: 0o600 });
assert(JSON.stringify(loadConfig({ env: {} }).telegram.envPassthrough) === '["HTTPS_PROXY","7"]', "loadConfig: envPassthrough kept as strings");

// bad policy rejected
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { token: "t", dmPolicy: "yolo" } }), { mode: 0o600 });
err = null; try { loadConfig({ env: {} }); } catch (e) { err = e; }
assert(err && /dmPolicy/.test(err.message), "loadConfig: unknown dmPolicy rejected");

// no token anywhere → error naming the channel
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: {} }), { mode: 0o600 });
err = null; try { loadConfig({ env: {} }); } catch (e) { err = e; }
assert(err && /telegram/.test(err.message) && /token/.test(err.message), "loadConfig: missing token names the channel");

// mode check
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { token: "t" } }));
fs.chmodSync(CONFIG_FILE, 0o644);
err = null; try { loadConfig({ env: {} }); } catch (e) { err = e; }
assert(err && /chmod 600/.test(err.message), "loadConfig: group/world-readable file refused");
fs.chmodSync(CONFIG_FILE, 0o600);
cfg = loadConfig({ env: { AI_BRIDGE_TELEGRAM_TOKEN: "sec-ret_TOKEN:1" } });

// redact
assert(redact("sent sec-ret_TOKEN:1 to x", cfg) === "sent <redacted> to x", "redact: token value replaced");
assert(redact("nothing here", cfg) === "nothing here", "redact: untouched when no token present");
assert(redact(null, cfg) === "", "redact: null → empty string");

// logger: redaction + rotation
{
  const file = path.join(process.env.AI_BRIDGE_HOME, "channels.log");
  const log = makeLogger({ file, maxBytes: 200, keep: 3, redact: (t) => redact(t, cfg) });
  log("hello sec-ret_TOKEN:1 world");
  const first = fs.readFileSync(file, "utf8");
  assert(/^\d{4}-\d{2}-\d{2}T.*hello <redacted> world\n$/.test(first), "logger: timestamped line with the token redacted");
  for (let i = 0; i < 50; i++) log(`line ${i} ${"x".repeat(20)}`);
  const names = fs.readdirSync(process.env.AI_BRIDGE_HOME).filter((n) => n.startsWith("channels.log"));
  assert(names.includes("channels.log") && names.includes("channels.log.1"), "logger: rotated to .1");
  assert(!names.includes("channels.log.4"), "logger: keeps at most 3 rotated files");
  assert(fs.statSync(file).size <= 200 + 100, "logger: current file stays near maxBytes");
}

fs.rmSync(process.env.AI_BRIDGE_HOME, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
