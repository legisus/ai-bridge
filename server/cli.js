#!/usr/bin/env node
// AI Browser Bridge — command-line client.
//
//   bridge ping
//   bridge listTabs
//   bridge newTab '{"url":"https://example.com"}'
//   bridge eval '{"tabId":123}' --file script.js
//   bridge eval '{"tabId":123,"code":"document.title"}'
//   bridge pdf '{"tabId":123}' --out page.pdf
//   bridge download '{"url":"https://...","filename":"cert.pdf"}'
//
// Prints the JSON result on stdout; exits non-zero on error.

const WebSocket = require("ws");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.BRIDGE_PORT || 8765);
const TOKEN = fs.readFileSync(path.join(os.homedir(), ".ai-browser-bridge", "token"), "utf8").trim();

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("usage: bridge <cmd> [params-json] [--file js] [--out file] [--timeout ms]");
  process.exit(2);
}

const cmd = argv[0];
let params = {};
const flags = {};
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--file") flags.file = argv[++i];
  else if (argv[i] === "--out") flags.out = argv[++i];
  else if (argv[i] === "--timeout") flags.timeout = Number(argv[++i]);
  else params = JSON.parse(argv[i]);
}
if (flags.file) params.code = fs.readFileSync(flags.file, "utf8");

const id = crypto.randomBytes(8).toString("hex");
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const timer = setTimeout(() => { console.error("timeout"); process.exit(3); }, flags.timeout || 60000);

ws.on("open", () => ws.send(JSON.stringify({ type: "auth", role: "cli", token: TOKEN })));
ws.on("message", (data) => {
  const msg = JSON.parse(data);
  if (msg.type === "auth" && msg.ok) {
    ws.send(JSON.stringify({ type: "request", id, cmd, params }));
    return;
  }
  if (msg.type === "response" && msg.id === id) {
    clearTimeout(timer);
    if (!msg.ok) { console.error("ERROR:", msg.error); process.exit(1); }
    // Binary results (pdf/screenshot) can be written straight to a file.
    if (flags.out && msg.result && msg.result.base64) {
      fs.writeFileSync(flags.out, Buffer.from(msg.result.base64, "base64"));
      console.log(JSON.stringify({ written: flags.out }));
    } else {
      console.log(JSON.stringify(msg.result));
    }
    ws.close();
    process.exit(0);
  }
});
ws.on("error", (e) => { console.error("connect failed:", e.message); process.exit(4); });
