#!/usr/bin/env node
// Register (or remove) the native messaging host manifest so Chrome can launch
// server/native-host.js for the AI Browser Bridge extension. Run once per machine:
//
//   npm run register-host                    # Chrome, Chromium, Brave, Edge if present
//   npm run register-host -- --extension-id <id>   # add another extension id (e.g. the store build)
//   npm run register-host -- --unregister
//
// The default extension id comes from extension/EXTENSION_ID, which is derived
// from the fixed "key" in extension/manifest.json, so it is the same on every
// machine that loads the unpacked extension.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOST_NAME = "com.ai_bridge.host";
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_ID = fs.readFileSync(path.join(ROOT, "extension", "EXTENSION_ID"), "utf8").trim();
const STATE_DIR = process.env.AI_BRIDGE_HOME || path.join(os.homedir(), ".ai-browser-bridge");

const argv = process.argv.slice(2);
const ids = [DEFAULT_ID];
let unregister = false, printOnly = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--extension-id") ids.push(argv[++i]);
  else if (argv[i] === "--unregister") unregister = true;
  else if (argv[i] === "--print") printOnly = true;
  else { console.error(`unknown flag ${argv[i]}`); process.exit(2); }
}

// Where each Chromium-based browser looks for user-level host manifests.
function manifestDirs() {
  const h = os.homedir();
  if (process.platform === "darwin") {
    const as = path.join(h, "Library", "Application Support");
    return [
      ["Google Chrome", path.join(as, "Google", "Chrome", "NativeMessagingHosts")],
      ["Chrome Beta", path.join(as, "Google", "Chrome Beta", "NativeMessagingHosts")],
      ["Chrome Canary", path.join(as, "Google", "Chrome Canary", "NativeMessagingHosts")],
      ["Chromium", path.join(as, "Chromium", "NativeMessagingHosts")],
      ["Brave", path.join(as, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts")],
      ["Microsoft Edge", path.join(as, "Microsoft Edge", "NativeMessagingHosts")],
      ["Arc", path.join(as, "Arc", "User Data", "NativeMessagingHosts")],
    ];
  }
  if (process.platform === "linux") {
    const c = path.join(h, ".config");
    return [
      ["Google Chrome", path.join(c, "google-chrome", "NativeMessagingHosts")],
      ["Chromium", path.join(c, "chromium", "NativeMessagingHosts")],
      ["Brave", path.join(c, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts")],
      ["Microsoft Edge", path.join(c, "microsoft-edge", "NativeMessagingHosts")],
    ];
  }
  return []; // windows: registry, see below
}

// Prefer a stable node path (Homebrew/system symlink) over the versioned
// Cellar path process.execPath resolves to, so `brew upgrade node` does not
// break the host.
function nodePath() {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const target = real(process.execPath);
  for (const c of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
    if (real(c) === target) return c;
  }
  return process.execPath;
}

// The manifest's "path" must be an executable. Wrap node + the host script so
// Chrome's minimal environment (no PATH lookups) still finds the right node.
function writeWrapper() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const host = path.join(__dirname, "native-host.js");
  if (process.platform === "win32") {
    const p = path.join(STATE_DIR, "native-host.cmd");
    fs.writeFileSync(p, `@echo off\r\n"${nodePath()}" "${host}" %*\r\n`);
    return p;
  }
  const p = path.join(STATE_DIR, "native-host.sh");
  fs.writeFileSync(p, `#!/bin/sh\nexec "${nodePath()}" "${host}" "$@"\n`, { mode: 0o755 });
  return p;
}

function manifestJson(wrapper) {
  return JSON.stringify({
    name: HOST_NAME,
    description: "AI Browser Bridge — starts the local relay server and hands the extension its token",
    path: wrapper,
    type: "stdio",
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  }, null, 2) + "\n";
}

function main() {
  if (printOnly) { console.log(manifestJson(path.join(STATE_DIR, process.platform === "win32" ? "native-host.cmd" : "native-host.sh"))); return; }
  const wrapper = unregister ? null : writeWrapper();
  const json = unregister ? null : manifestJson(wrapper);

  if (process.platform === "win32") {
    const file = path.join(STATE_DIR, `${HOST_NAME}.json`);
    const keys = [
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
      `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
      `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`,
      `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
    ];
    if (unregister) {
      for (const k of keys) { try { execFileSync("reg", ["delete", k, "/f"], { stdio: "ignore" }); console.log(`removed ${k}`); } catch {} }
      try { fs.unlinkSync(file); } catch {}
      return;
    }
    fs.writeFileSync(file, json);
    for (const k of keys) {
      try { execFileSync("reg", ["add", k, "/ve", "/t", "REG_SZ", "/d", file, "/f"], { stdio: "ignore" }); console.log(`registered ${k}`); } catch {}
    }
    console.log(`manifest: ${file}`);
    return;
  }

  let done = 0;
  for (const [name, dir] of manifestDirs()) {
    const file = path.join(dir, `${HOST_NAME}.json`);
    const browserPresent = fs.existsSync(path.dirname(dir));
    if (unregister) {
      if (fs.existsSync(file)) { fs.unlinkSync(file); console.log(`removed  ${name}: ${file}`); done++; }
      continue;
    }
    if (!browserPresent && name !== "Google Chrome") continue; // always register for Chrome
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, json);
    console.log(`registered ${name}: ${file}`);
    done++;
  }
  if (!unregister) {
    console.log(`host executable: ${wrapper}`);
    console.log(`allowed extension ids: ${ids.join(", ")}`);
    console.log("Now (re)load the extension at chrome://extensions — it will fetch the token by itself.");
  } else if (!done) console.log("nothing to remove");
}

main();
