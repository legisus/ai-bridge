// CLI side of the window recorder. The recorder itself (ScreenCaptureKit) lives in the
// macOS app — the screen-recording permission belongs to that app. This module:
//   • resolves {tabId} → the Chrome window title through the bridge,
//   • talks to the app over ~/.ai-browser-bridge/app.sock (starting the app if needed),
//   • on recordStop moves the mp4 to --out and writes <out>.steps.json
//     (done here, with the caller's file permissions — the app never touches ~/Documents).
const fs = require("fs");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { DIR, TOKEN_FILE } = require("./token");

const SOCK = path.join(DIR, "app.sock");
const APP_BUNDLE_ID = "com.ai-bridge.app";

function fail(msg, code = 1) { console.error("ERROR:", msg); process.exit(code); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appCall(cmd, params, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(SOCK);
    let buf = "";
    const t = setTimeout(() => { s.destroy(); reject(new Error("recorder app timed out")); }, timeoutMs);
    s.on("connect", () => s.write(JSON.stringify({ cmd, params }) + "\n"));
    s.on("data", (d) => { buf += d; });
    s.on("end", () => { clearTimeout(t); try { resolve(JSON.parse(buf)); } catch { reject(new Error("bad reply from recorder app")); } });
    s.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

async function appCallStarting(cmd, params) {
  try { return await appCall(cmd, params); }
  catch (e) {
    if (!/ENOENT|ECONNREFUSED/.test(String(e.code || e.message))) throw e;
  }
  if (process.platform !== "darwin") throw new Error("window recording needs the macOS app (AI Browser Bridge.app)");
  spawnSync("open", ["-g", "-b", APP_BUNDLE_ID]);
  for (let i = 0; i < 25; i++) {
    await sleep(400);
    try { return await appCall(cmd, params); } catch (e) { if (!/ENOENT|ECONNREFUSED/.test(String(e.code || e.message))) throw e; }
  }
  throw new Error("the AI Browser Bridge app is not running — install/open “AI Browser Bridge.app” (macos/build-app.sh) and retry");
}

// Ask the extension through the relay (only for tabId → title).
function bridgeCall(cmd, params, direct = true) {
  const WebSocket = require("ws");
  const port = Number(process.env.BRIDGE_PORT || 8765);
  let token;
  try { token = fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return Promise.reject(new Error(`no token at ${TOKEN_FILE} — start the server first`)); }
  return new Promise((resolve, reject) => {
    const id = crypto.randomBytes(8).toString("hex");
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const t = setTimeout(() => { ws.terminate(); reject(new Error("bridge timeout")); }, 15000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", role: "cli", token })));
    ws.on("message", (data) => {
      const m = JSON.parse(data);
      if (m.type === "auth" && m.ok) ws.send(JSON.stringify({ type: "request", id, cmd, params: { ...params, direct } }));
      else if (m.type === "response" && m.id === id) { clearTimeout(t); ws.close(); m.ok ? resolve(m.result) : reject(new Error(m.error)); }
    });
    ws.on("error", (e) => { clearTimeout(t); reject(new Error("connect failed: " + e.message)); });
  });
}

function moveFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.renameSync(src, dst); }
  catch { fs.copyFileSync(src, dst); fs.unlinkSync(src); }   // different volume
}

async function main(argv) {
  const cmd = argv[0];
  let params = {}, out = null;
  const flags = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--debugger") flags.debugger = true;
    else if (argv[i] === "--timeout") i++;
    else params = JSON.parse(argv[i]);
  }

  if (cmd === "recordStart") {
    const area = params.area || "content";
    if (area !== "content" && area !== "window") fail(`area must be "content" (page only, default) or "window"`);
    const tabs = (params.tabId != null || area === "content") ? await bridgeCall("listTabs", {}) : [];
    if (params.tabId != null && !params.window) {
      const tab = tabs.find((t) => t.id === params.tabId);
      if (!tab) fail(`no tab ${params.tabId}`);
      params.window = tab.title || "";
      if (!params.window) fail(`tab ${params.tabId} has no title yet — pass "window" explicitly`);
    }
    if (area === "content") {
      // Measure the page area through the tab itself: everything above the viewport
      // (tab strip, address bar, bookmarks, "started debugging" bar) is cut away.
      let tabId = params.tabId;
      if (tabId == null) {
        const w = await appCallStarting("recordResolve", { window: params.window || "" });
        if (!w.ok) { console.error("ERROR:", w.error); process.exit(w.code === "permission" ? 7 : 1); }
        const same = (a, b) => a === b || (a.includes("…") && (b.startsWith(a.split("…")[0]) && b.endsWith(a.split("…").pop())));
        const cands = tabs.filter((t) => t.active && t.title && same(w.title, t.title));
        if (cands.length !== 1) fail(`cannot tell which tab is shown in the window “${w.title}” (${cands.length} candidates) — pass {"tabId":N} or "area":"window"`);
        tabId = cands[0].id;
      }
      // 1) screenshot of the visible page (needs no User Scripts, no debugger): its pixel size is the viewport
      // 2) fallback: eval of innerWidth/innerHeight/outerHeight (User Scripts, or --debugger when the caller passes it)
      const win = await appCallStarting("recordResolve", { window: params.window || "" });
      let crop = null;
      try {
        const shot = await bridgeCall("screenshot", { tabId });
        const png = Buffer.from(shot.base64, "base64");
        const pw = png.readUInt32BE(16), ph = png.readUInt32BE(20);
        const scale = Math.max(1, Math.round((pw / win.width) * 2) / 2);   // pixels per point
        crop = { top: Math.ceil(win.height - ph / scale) + 1, width: pw / scale };   // +1: skip the infobar border line
      } catch {}
      if (!crop) {
        let m;
        try {
          m = await bridgeCall("eval", { tabId, code: "JSON.stringify([innerWidth,innerHeight,outerWidth,outerHeight])" }, !flags.debugger);
        } catch (e) {
          fail(`cannot measure the page area (${e.message}). Make the tab visible (activateTab), enable “Allow User Scripts”, pass --debugger, or use "area":"window".`);
        }
        const [iw, ih, ow, oh] = JSON.parse(typeof m === "string" ? m : (m && (m.value ?? m.result)) ?? m);
        crop = { top: oh - ih, width: iw };
      }
      if (!(crop.top >= 0 && crop.top < win.height - 100)) fail(`unexpected page area ${JSON.stringify(crop)}`);
      params.crop = crop;
    }
    delete params.tabId; delete params.area;
  }
  if (cmd === "recordStop" && !out) fail("recordStop needs --out file.mp4");

  const r = await appCallStarting(cmd, params);
  if (!r.ok) {
    console.error("ERROR:", r.error);
    process.exit(r.code === "permission" ? 7 : 1);
  }

  if (cmd === "recordStop") {
    const mp4 = path.resolve(out);
    const steps = path.resolve(out + ".steps.json");
    moveFile(r.file, mp4);
    const doc = { recId: r.recId, video: path.basename(mp4), durationSec: r.durationSec, fps: r.fps, size: r.size, window: r.window, steps: r.steps };
    fs.writeFileSync(steps, JSON.stringify(doc, null, 2) + "\n");
    const res = { written: mp4, steps: steps, durationSec: r.durationSec, frames: r.frames, audioBuffers: r.audioBuffers, stepCount: r.steps.length };
    if (r.warning) res.warning = r.warning;
    process.stdout.write(JSON.stringify(res) + "\n", () => process.exit(0));
    return;
  }
  delete r.ok;
  process.stdout.write(JSON.stringify(r) + "\n", () => process.exit(0));
}

module.exports = { main };
