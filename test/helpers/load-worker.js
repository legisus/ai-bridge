// Load the real extension service worker (extension/background.js, with
// importScripts("access.js")) into a Node vm context on top of a stub `chrome`
// (test/helpers/stub-chrome.js). Returns the context: its globals are the
// worker's — handle(), validateTab(), BridgeAccess, attached, cdp, initDone…
// A WebSocket stub never connects, so the worker sits idle until a test calls
// handle() directly, exactly as sock.onmessage would.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "..", "..", "extension");

function loadWorker(S) {
  const sockets = [];
  class FakeWebSocket {
    constructor() { sockets.push(this); this.readyState = 0; setTimeout(() => { this.readyState = 3; if (this.onclose) this.onclose(); }, 0); }
    send() {} close() {}
  }
  FakeWebSocket.OPEN = 1; FakeWebSocket.CONNECTING = 0;
  const sandbox = {
    chrome: S.chrome,
    WebSocket: FakeWebSocket,
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    URL, TextEncoder, TextDecoder, Buffer,
    crypto: require("crypto").webcrypto,
  };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  sandbox.__sockets = sockets; // every WebSocket the worker opened
  const ctx = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx, { filename: f }); };
  vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), ctx, { filename: "background.js" });
  // Top-level const/let bindings of the worker script are not properties of
  // the vm global; read the ones the tests need from the context itself.
  for (const name of ["initDone", "attached", "attaching", "cdp"]) {
    try { sandbox[name] = vm.runInContext(name, ctx); } catch {}
  }
  return sandbox; // the vm global: handle, validateTab, BridgeAccess, … plus the bindings above
}

module.exports = { loadWorker };
