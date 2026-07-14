// AI Browser Bridge — extension service worker.
// Maintains a WebSocket to the local bridge server and executes commands
// against chrome.* APIs. Trusted input and CSP-proof eval go through
// chrome.debugger (DevTools protocol), so they work on sites that reject
// synthetic DOM events (webmail clients, rich-text editors, collaborative docs, ...).

const DEFAULTS = { port: 8765, token: "", allowlist: [], indicator: true, idleDetachMs: 120000 };

let ws = null;
let attached = new Set(); // tabIds with debugger attached
const attaching = new Map(); // tabId -> in-flight attach promise (dedupes concurrent first-touch)
const lastActivity = new Map(); // tabId -> last command timestamp (for idle auto-detach)

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
  ws.onclose = () => { ws = null; setTimeout(connect, 1000); }; // quick reconnect while SW is alive; the alarm is the backstop
  ws.onerror = () => { try { ws && ws.close(); } catch {} };
}

chrome.alarms.create("reconnect", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "reconnect") { connect(); idleDetachSweep(); } });
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
      .then(() => { attached.add(tabId); return setIndicator(tabId, true); })
      .finally(() => { attaching.delete(tabId); });
    attaching.set(tabId, p);
  }
  return p;
}

chrome.debugger.onDetach.addListener((src) => { if (src.tabId) { attached.delete(src.tabId); attaching.delete(src.tabId); lastActivity.delete(src.tabId); setIndicator(src.tabId, false); } });
chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); attaching.delete(tabId); lastActivity.delete(tabId); });

function dbg(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

// Detach one tab: release the debugger, clear its indicator and activity record.
async function detachTab(tabId) {
  if (attached.has(tabId)) {
    try { await chrome.debugger.detach({ tabId }); } catch (e) { /* already gone */ }
    attached.delete(tabId);
  }
  lastActivity.delete(tabId);
  await setIndicator(tabId, false);
}

// Auto-detach tabs left idle past `idleDetachMs`, so debugger banners never pile
// up on tabs the agent is done with. Runs on the reconnect alarm (~every 24s).
// A later command simply re-attaches — the per-tab lock keeps that safe.
async function idleDetachSweep() {
  const ms = (await config()).idleDetachMs;
  if (!ms || ms <= 0) return;
  const now = Date.now();
  for (const tabId of [...attached]) {
    if (now - (lastActivity.get(tabId) || 0) > ms) await detachTab(tabId);
  }
}

// ---------- visual indicator ----------

// A green frame + title dot on tabs the agent is actively driving, so autonomous
// work is visible per-tab — more granular than Chrome's global debugger banner
// (it shows WHICH tabs are live). Toggle via the "indicator" option; removal
// always runs regardless of the flag so nothing is left stuck on.
async function setIndicator(tabId, on) {
  if (on && !(await config()).indicator) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (on) => {
        const ID = "__ai_bridge_frame__";
        let el = document.getElementById(ID);
        if (on) {
          if (!el) {
            el = document.createElement("div");
            el.id = ID;
            el.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;border:6px solid #16a34a;box-shadow:inset 0 0 0 2px rgba(22,163,74,.35)";
            (document.documentElement || document.body).appendChild(el);
          }
          if (window.__aiBridgeTitle == null) { window.__aiBridgeTitle = document.title; document.title = "🟢 " + document.title; }
        } else {
          if (el) el.remove();
          if (window.__aiBridgeTitle != null) { document.title = window.__aiBridgeTitle; window.__aiBridgeTitle = null; }
        }
      },
      args: [on],
    });
  } catch (e) { /* injection blocked on chrome://, PDF viewer, etc. — non-fatal */ }
}

// Resolve a CSS selector to its viewport-center coordinates (CSS px), scrolling it
// into view first — lets click target elements by selector with no pixel math.
async function selectorCenter(tabId, selector) {
  await dbgAttach(tabId);
  const r = await dbg(tabId, "Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
    returnByValue: true,
  });
  return (r.result && r.result.value) || null;
}

// ---------- commands ----------

async function handle(cmd, p) {
  // Record activity so the idle sweep leaves actively-driven tabs attached.
  if (p && p.tabId != null) lastActivity.set(p.tabId, Date.now());
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
      // Trusted click at viewport coordinates (CSS px), or at a CSS `selector`'s
      // center (resolved in-page — no screenshot/DPR pixel math needed).
      await assertAllowed(p.tabId);
      await dbgAttach(p.tabId);
      let x = p.x, y = p.y;
      if (p.selector) {
        const c = await selectorCenter(p.tabId, p.selector);
        if (!c) throw new Error(`click: selector not found: ${p.selector}`);
        x = Math.round(c.x); y = Math.round(c.y);
      }
      const base = { x, y, button: "left", clickCount: p.clickCount || 1 };
      await dbg(p.tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...base, button: "none" });
      await dbg(p.tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
      await dbg(p.tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
      return { ok: true, x, y };
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
      const mods = p.modifiers || 0;
      const ev = { key: p.key, code: p.code || p.key, modifiers: mods };
      const down = { type: "keyDown", ...ev };
      // A printable character needs `text` set, or CDP delivers the key event
      // without actually inserting the character. Skip it when Ctrl/Meta is held
      // (that's a shortcut like Ctrl+A, not text entry).
      const isChar = typeof p.key === "string" && [...p.key].length === 1;
      const ctrlOrMeta = (mods & 2) || (mods & 4); // Ctrl=2, Meta=4
      const text = p.text != null ? p.text : (isChar && !ctrlOrMeta ? p.key : null);
      if (text != null) { down.text = text; down.unmodifiedText = text; }
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
      await detachTab(p.tabId);
      return { ok: true };
    }

    case "detachAll": {
      // Release every attached tab at once — clears all debugger banners the
      // bridge is holding in a single call.
      const ids = [...attached];
      for (const tabId of ids) await detachTab(tabId);
      return { ok: true, detached: ids };
    }

    case "type": {
      // Real per-character keystrokes — what autocomplete / React widgets listen
      // for, where insertText (a paste) is silently ignored.
      await assertAllowed(p.tabId);
      await dbgAttach(p.tabId);
      const text = String(p.text ?? "");
      const delay = p.delay || 0;
      for (const ch of text) {
        await dbg(p.tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
        await dbg(p.tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: ch });
        if (delay) await new Promise((r) => setTimeout(r, delay));
      }
      return { ok: true, typed: [...text].length };
    }

    case "scroll": {
      // Scroll a tab: to a `selector`, to `top`/`bottom`, or by `dx`/`dy`.
      // Uses chrome.scripting (no debugger, no banner) — it's a plain page action.
      await assertAllowed(p.tabId);
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: p.tabId },
        func: (o) => {
          if (o.selector) { const el = document.querySelector(o.selector); if (!el) return { error: "selector not found" }; el.scrollIntoView({ block: "center", inline: "center" }); return { ok: true, into: o.selector }; }
          if (o.top) { window.scrollTo(0, 0); return { ok: true, y: 0 }; }
          if (o.bottom) { window.scrollTo(0, document.body.scrollHeight); return { ok: true, y: window.scrollY }; }
          window.scrollBy(o.dx || 0, o.dy || 0); return { ok: true, x: window.scrollX, y: window.scrollY };
        },
        args: [{ selector: p.selector, dx: p.dx, dy: p.dy, top: !!p.top, bottom: !!p.bottom }],
      });
      const out = res && res.result;
      if (out && out.error) throw new Error(`scroll: ${out.error}`);
      return out || { ok: true };
    }

    case "waitFor": {
      // Poll until a `selector` exists or a JS `code` condition is truthy.
      // Selector checks use chrome.scripting (no banner); code uses CSP-proof eval.
      await assertAllowed(p.tabId);
      const timeout = p.timeoutMs || 10000;
      const poll = p.pollMs || 200;
      const start = Date.now();
      while (Date.now() < start + timeout) {
        let ok = false;
        if (p.code) {
          await dbgAttach(p.tabId);
          const r = await dbg(p.tabId, "Runtime.evaluate", { expression: `(() => { try { return !!(${p.code}); } catch (e) { return false; } })()`, returnByValue: true });
          ok = !!(r.result && r.result.value);
        } else {
          const [res] = await chrome.scripting.executeScript({ target: { tabId: p.tabId }, func: (sel) => !!document.querySelector(sel), args: [p.selector || ""] });
          ok = !!(res && res.result);
        }
        if (ok) return { ok: true, waitedMs: Date.now() - start };
        await new Promise((r) => setTimeout(r, poll));
      }
      throw new Error(`waitFor timed out after ${timeout}ms`);
    }

    case "status": {
      const cfg = await config();
      return { version: chrome.runtime.getManifest().version, attachedTabs: [...attached], indicator: cfg.indicator, idleDetachMs: cfg.idleDetachMs };
    }

    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}
