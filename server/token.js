// Shared paths + token bootstrap for the server and the native messaging host.
// AI_BRIDGE_HOME overrides the state directory (used by the tests).
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const DIR = process.env.AI_BRIDGE_HOME || path.join(os.homedir(), ".ai-browser-bridge");
const TOKEN_FILE = path.join(DIR, "token");
const LOG_FILE = path.join(DIR, "bridge.log");
const SERVER_OUT = path.join(DIR, "server.out");

// Create the state dir and a random token on first use; return the token.
// Returns { token, created } so callers can print a hint only on first run.
function ensureToken() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { mode: 0o700, recursive: true });
  let created = false;
  if (!fs.existsSync(TOKEN_FILE)) {
    fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
    created = true;
  }
  return { token: fs.readFileSync(TOKEN_FILE, "utf8").trim(), created };
}

module.exports = { DIR, TOKEN_FILE, LOG_FILE, SERVER_OUT, ensureToken };
