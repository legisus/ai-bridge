// AI Browser Bridge — extension service worker.
// Maintains a WebSocket to the local bridge server and executes commands
// against chrome.* APIs. Trusted input and CSP-proof eval go through
// chrome.debugger (DevTools protocol), so they work on sites that reject
// synthetic DOM events (webmail clients, rich-text editors, collaborative docs, ...).

const DEFAULTS = { port: 8765, token: "", allowlist: [] };

let ws = null;
let attached = new Set(); // tabIds with debugger attached
const attaching = new Map(); // tabId -> in-flight attach promise (dedupes concurrent first-touch)

// ---------- config ----------

async function config() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

// ---------- connection ----------

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const cfg = await config();
  if (!cfg.token) return; // not provisioned yet — set the token in Options
  try {
    ws = new WebSocket(`ws://127.0.0.1:${cfg.port}`);
  } catch (e) {
    return;
  }
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "auth", role: "extension", token: cfg.token }));
  };
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type !== "command") return;
    let reply;
    try {
      const result = await handle(msg.cmd, msg.params || {});
      reply = { type: "response", id: msg.id, ok: true, result };
    } catch (e) {
      reply = { type: "response", id: msg.id, ok: false, error: String(e && e.message || e) };
    }
    try { ws.send(JSON.stringify(reply)); } catch {}
  };
  ws.onclose = () => { ws = null; };
  ws.onerror = () => { try { ws && ws.close(); } catch {} };
}

chrome.alarms.create("reconnect", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "reconnect") connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// ---------- allowlist ----------

async function assertAllowed(tabId) {
  const cfg = await config();
  if (!cfg.allowlist || cfg.allowlist.length === 0) return; // empty = allow all (see README)
  const tab = await chrome.tabs.get(tabId);
  const host = (() => { try { return new URL(tab.url).hostname; } catch { return ""; } })();
  const ok = cfg.allowlist.some((pat) =>
    pat === "*" || host === pat || host.endsWith("." + pat)
  );
  if (!ok) throw new Error(`host "${host}" not in allowlist`);
}

// ---------- debugger helpers ----------

async function dbgAttach(tabId) {
  if (attached.has(tabId)) return;
  // Dedupe concurrent first-touch: several commands hitting the same not-yet-attached
  // tab at once must share ONE attach, or Chrome rejects the extras with
  // "Another debugger is already attached". Later callers await the same promise.
  let p = attaching.get(tabId);
  if (!p) {
    p = chrome.debugger.attach({ tabId }, "1.3")
      .then(() => { attached.add(tabId); })
      .finally(() => { attaching.delete(tabId); });
    attaching.set(tabId, p);
  }
  return p;
}

chrome.debugger.onDetach.addListener((src) => { if (src.tabId) { attached.delete(src.tabId); attaching.delete(src.tabId); } });
chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); attaching.delete(tabId); });

function dbg(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

// ---------- commands ----------

async function handle(cmd, p) {
  switch (cmd) {
    case "ping":
      return { pong: true, version: chrome.runtime.getManifest().version };

    case "listTabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id, windowId: t.windowId, active: t.active,
        url: t.url, title: t.title,
      }));
    }

    case "newTab": {
      // active:false → opens in background, never steals the user's focus
      const tab = await chrome.tabs.create({ url: p.url, active: !!p.active });
      return { id: tab.id, windowId: tab.windowId };
    }

    case "navigate": {
      await assertAllowed(p.tabId);
      await chrome.tabs.update(p.tabId, { url: p.url });
      return { ok: true };
    }

    case "activateTab": {
      // Focus a tab and bring its window to the front.
      const tab = await chrome.tabs.update(p.tabId, { active: true });
      if (tab && tab.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return { ok: true, tabId: p.tabId, windowId: tab && tab.windowId };
    }

    case "selectTab": {
      // Make the tab active WITHIN its window without focusing the window —
      // for background automation that must never steal the user's focus
      // (activateTab does both; this does only the tab half).
      await chrome.tabs.update(p.tabId, { active: true });
      return { ok: true, tabId: p.tabId };
    }

    case "closeTab":
      await chrome.tabs.remove(p.tabId);
      return { ok: true };

    case "eval": {
      // Runtime.evaluate via debugger: immune to page CSP, returns values.
      await assertAllowed(p.tabId);
      await dbgAttach(p.tabId);
      const r = await dbg(p.tabId, "Runtime.evaluate", {
        expression: p.code,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result?.value;
    }

    case "click": {
      // Trusted click at viewport coordinates (CSS px).
      await assertAllowed(p.tabId);
      await dbgAttach(p.tabId);
      const base = { x: p.x, y: p.y, button: "left", clickCount: 1 };
      await dbg(p.tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...base, button: "none" });
      await dbg(p.tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
      await dbg(p.tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
      return { ok: true };
    }

    case "insertText": {
      // Trusted text insertion at the current caret (equivalent of a real paste).
      await assertAllowed(p.tabId);
      await dbgAttach(p.tabId);
      await dbg(p.tabId, "Input.insertText", { text: p.text });
      return { ok: true };
    }

    case "key": {
      // Trusted key press, e.g. {key:"Enter", code:"Enter", modifiers:0}.
      // Optional `commands` (e.g. ["paste"], ["selectAll"]) run the matching
      // editing command with the keyDown, so shortcuts like Cmd/Ctrl+V trigger
      // the browser's native paste instead of just delivering the raw key.
      await assertAllowed(p.tabId);
      await dbgAttach(p.tabId);
      const ev = { key: p.key, code: p.code || p.key, modifiers: p.modifiers || 0 };
      const down = { type: "keyDown", ...ev };
      if (Array.isArray(p.commands) && p.commands.length) down.commands = p.commands;
      await dbg(p.tabId, "Input.dispatchKeyEvent", down);
      await dbg(p.tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...ev });
      return { ok: true };
    }

    case "screenshot": {
      await assertAllowed(p.tabId);
      await dbgAttach(p.tabId);
      const r = await dbg(p.tabId, "Page.captureScreenshot", { format: "png" });
      return { base64: r.data };
    }

    case "pdf": {
      await assertAllowed(p.tabId);
      await dbgAttach(p.tabId);
      const r = await dbg(p.tabId, "Page.printToPDF", {
        printBackground: true,
        displayHeaderFooter: false,
      });
      return { base64: r.data };
    }

    case "download": {
      // Uses the browser's own cookie jar — authenticated downloads just work.
      // filename is relative to the user's Downloads directory.
      const id = await chrome.downloads.download({
        url: p.url,
        filename: p.filename,
        conflictAction: "uniquify",
        saveAs: false,
      });
      // Poll until the download settles.
      const deadline = Date.now() + (p.timeoutMs || 60000);
      while (Date.now() < deadline) {
        const [item] = await chrome.downloads.search({ id });
        if (item && item.state === "complete") return { id, path: item.filename };
        if (item && item.state === "interrupted") throw new Error(`download interrupted: ${item.error}`);
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error("download timeout");
    }

    case "detach": {
      if (attached.has(p.tabId)) {
        await chrome.debugger.detach({ tabId: p.tabId });
        attached.delete(p.tabId);
      }
      return { ok: true };
    }

    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}
