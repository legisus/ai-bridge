// Channel configuration: ~/.ai-browser-bridge/channels.json (must be 0600).
//
//   { "telegram": { "token": "123:ABC", "dmPolicy": "pairing", "allowFrom": ["123456789"], "codex": false } }
//
// A token may also come from AI_BRIDGE_<CHANNEL>_TOKEN, which wins over the file.
const fs = require("fs");
const path = require("path");
const { DIR } = require("../token");
const { POLICIES } = require("./policy");

const CONFIG_FILE = path.join(DIR, "channels.json");
const DEFAULTS = { accountId: "default", dmPolicy: "pairing", allowFrom: [], codex: false, envPassthrough: [] };

function loadConfig({ env = process.env, file = CONFIG_FILE } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) {
    if (e.code === "ENOENT") throw new Error(`${file} not found — create it with your bot token (see docs/CHANNELS.md)`);
    throw e;
  }
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`${file} is group/world readable (mode 0o${mode.toString(8)}); run chmod 600 ${file}`);
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error(`${file}: invalid JSON (${e.message})`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file}: expected an object keyed by channel name`);

  const out = {};
  for (const [channel, c0] of Object.entries(parsed)) {
    const c = { ...DEFAULTS, ...(c0 || {}) };
    const envKey = `AI_BRIDGE_${channel.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
    if (env[envKey]) c.token = env[envKey];
    if (!c.token) throw new Error(`channel ${channel}: no token in ${file} and ${envKey} is not set`);
    if (!POLICIES.includes(c.dmPolicy)) throw new Error(`channel ${channel}: dmPolicy must be one of ${POLICIES.join(", ")} (got "${c.dmPolicy}")`);
    c.allowFrom = Array.isArray(c.allowFrom) ? c.allowFrom.map(String) : [];
    c.codex = c.codex === true;
    c.envPassthrough = Array.isArray(c.envPassthrough) ? c.envPassthrough.map(String) : [];
    out[channel] = c;
  }
  return out;
}

// Replace every configured secret with <redacted>.
function redact(text, config) {
  let s = text == null ? "" : String(text);
  for (const c of Object.values(config || {})) {
    for (const key of ["token", "appToken", "secret", "clientSecret", "accessToken"]) {
      const v = c && c[key];
      if (typeof v === "string" && v.length >= 6) s = s.split(v).join("<redacted>");
    }
  }
  return s;
}

module.exports = { CONFIG_FILE, DEFAULTS, loadConfig, redact };
