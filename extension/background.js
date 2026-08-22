// AI Browser Bridge — extension service worker.
// Maintains a WebSocket to the local bridge server and executes commands
// against chrome.* APIs. Trusted input and CSP-proof eval go through
// chrome.debugger (DevTools protocol), so they work on sites that reject
// synthetic DOM events (webmail clients, rich-text editors, collaborative docs, ...).
//
// Stealth mode (params.stealth === true, set by the CLI's --stealth flag):
// never attaches chrome.debugger for that command. eval runs via
// chrome.scripting in the page's MAIN world; click/type/insertText/key are
// emulated with synthetic DOM events. This removes the CDP fingerprint and the
// "…is debugging this browser" banner — the footprint anti-bot systems
// (Cloudflare et al.) look for — at the cost of untrusted events (isTrusted:false,
// same as AppleScript injection) and MAIN-world eval being subject to the page's
// own CSP. Use it on sites that fight automation; keep the default CDP path for
// CSP-hard pages and background screenshots/PDF.

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

// An animated neon frame + title dot on tabs the agent is actively driving, so autonomous
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
        const STYLE_ID = "__ai_bridge_frame_style__";
        let el = document.getElementById(ID);
        let st = document.getElementById(STYLE_ID);
        if (on) {
          if (!st) {
            st = document.createElement("style");
            st.id = STYLE_ID;
            st.textContent =
              "@property --__ai_bridge_a__{syntax:'<angle>';inherits:false;initial-value:0deg}" +
              "#" + ID + "::before,#" + ID + "::after{content:'';position:absolute;inset:0;border-radius:inherit;" +
              "border:3px solid transparent;" +
              "background:conic-gradient(from var(--__ai_bridge_a__),#00e5ff,#8b5cf6,#ff2ec4,#22ffb2,#00e5ff) border-box;" +
              "-webkit-mask:linear-gradient(#000 0 0) padding-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;" +
              "mask:linear-gradient(#000 0 0) padding-box,linear-gradient(#000 0 0);mask-composite:exclude;" +
              "animation:__ai_bridge_snake__ 5s linear infinite}" +
              "#" + ID + "::after{border-width:4px;filter:blur(16px);opacity:.55}" +
              "@keyframes __ai_bridge_snake__{to{--__ai_bridge_a__:360deg}}";
            (document.documentElement || document.body).appendChild(st);
          }
          if (!el) {
            el = document.createElement("div");
            el.id = ID;
            (document.documentElement || document.body).appendChild(el);
          }
          el.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;border-radius:14px";
          if (!window.__aiBridgeFav) {
            const orig = [...document.querySelectorAll('link[rel~="icon"]')];
            const srcHref = (orig.find((l) => l.href) || {}).href || location.origin + "/favicon.ico";
            orig.forEach((l) => l.remove());
            const link = document.createElement("link");
            link.rel = "icon";
            (document.head || document.documentElement).appendChild(link);
            const c = document.createElement("canvas");
            c.width = c.height = 32;
            const ctx = c.getContext("2d");
            let hue = 190;
            let logo = null;
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => { logo = img; };
            img.src = srcHref;
            const draw = () => {
              ctx.clearRect(0, 0, 32, 32);
              if (logo) ctx.drawImage(logo, 0, 0, 32, 32);
              const g = ctx.createRadialGradient(22, 22, 1, 22, 22, 10);
              g.addColorStop(0, "hsl(" + hue + " 100% 80%)");
              g.addColorStop(0.6, "hsl(" + hue + " 100% 55%)");
              g.addColorStop(1, "hsl(" + hue + " 100% 55% / 0)");
              ctx.fillStyle = g;
              ctx.beginPath();
              ctx.arc(22, 22, 10, 0, Math.PI * 2);
              ctx.fill();
              try { link.href = c.toDataURL("image/png"); }
              catch (e) { if (logo) { logo = null; draw(); } } // cross-origin logo tainted the canvas — badge only
            };
            draw();
            window.__aiBridgeFav = { orig, link };
            window.__aiBridgeFavTimer = setInterval(() => { hue = (hue + 12) % 360; draw(); }, 400);
          }
        } else {
          if (el) el.remove();
          if (st) st.remove();
          if (window.__aiBridgeTitle != null) { document.title = window.__aiBridgeTitle; window.__aiBridgeTitle = null; }
          if (window.__aiBridgeFavTimer) { clearInterval(window.__aiBridgeFavTimer); window.__aiBridgeFavTimer = null; }
          if (window.__aiBridgeFav) {
            window.__aiBridgeFav.link.remove();
            for (const l of window.__aiBridgeFav.orig) (document.head || document.documentElement).appendChild(l);
            window.__aiBridgeFav = null;
          }
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

// Run a self-contained fn(arg) in the page. Prefers chrome.scripting (no debugger
// banner); if the page blocks injection (about:blank, chrome://, the Web Store),
// falls back to CSP-proof debugger eval. fn must not close over outer variables.
async function pageRun(tabId, fn, arg, noDebugger) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args: [arg] });
    return res && res.result;
  } catch (e) {
    if (noDebugger) throw e; // stealth: never fall back to the debugger
    await dbgAttach(tabId);
    const r = await dbg(tabId, "Runtime.evaluate", { expression: `(${fn.toString()})(${JSON.stringify(arg)})`, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result && r.result.value;
  }
}

// ---------- stealth (no-debugger) helpers ----------
// All of these use chrome.scripting only — they never attach the debugger, so
// there is no CDP fingerprint and no banner. Injected functions must be
// self-contained (no closures over outer variables).

// Evaluate an arbitrary code string in the page's MAIN world. Subject to the
// page's own CSP (unsafe-eval) — throws on strict-CSP pages, where the caller
// should drop --stealth and use the debugger path instead.
async function stealthEval(tabId, code) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (c) => Promise.resolve((0, eval)(c)),
      args: [code],
    });
    return res && res.result;
  } catch (e) {
    throw new Error(`stealth eval failed (page CSP may block eval; add --debugger for this page): ${e && e.message || e}`);
  }
}

// Run a fixed, self-contained fn(arg) via chrome.scripting (no debugger, no
// eval — CSP-safe). Default ISOLATED world is enough: page listeners still
// receive events dispatched here (one shared DOM); only event.isTrusted differs.
async function stealthRun(tabId, fn, arg) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId }, func: fn, args: [arg === undefined ? null : arg],
  });
  return res && res.result;
}

// Synthetic click on a selector's element (found + scrolled in-page) or the
// element at viewport point (x,y). Dispatches the full pointer/mouse sequence
// plus focus, so page handlers fire as they would for a real click.
function __stealthClick(o) {
  let el, x = o.x, y = o.y;
  if (o.selector) {
    el = document.querySelector(o.selector);
    if (!el) return { error: "selector not found: " + o.selector };
    el.scrollIntoView({ block: "center", inline: "center" });
    const b = el.getBoundingClientRect();
    x = b.left + b.width / 2; y = b.top + b.height / 2;
  } else {
    el = document.elementFromPoint(x, y);
    if (!el) return { error: "no element at point (" + x + "," + y + ")" };
  }
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
  try { el.focus && el.focus(); } catch (e) {}
  el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mousedown", base));
  el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mouseup", base));
  el.dispatchEvent(new MouseEvent("click", base));
  return { ok: true, x: Math.round(x), y: Math.round(y) };
}

// Insert text at the caret of the focused element (paste-equivalent), via
// execCommand then a native-setter + input-event fallback.
function __stealthInsert(o) {
  const el = document.activeElement;
  if (!el) return { error: "no active element to insert into" };
  const text = o.text || "";
  try { el.focus && el.focus(); } catch (e) {}
  try { if (document.execCommand("insertText", false, text)) return { ok: true }; } catch (e) {}
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
  if (proto) {
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, (el.value || "") + text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    return { ok: true };
  }
  if (el.isContentEditable) {
    el.textContent = (el.textContent || "") + text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return { ok: true };
  }
  return { error: "unsupported element for insertText" };
}

// keyCode/which for the legacy handlers many composers still gate Enter on —
// the KeyboardEvent constructor ignores both, so they're defined explicitly.
const __KEYCODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, " ": 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35 };

// Synthetic key press (keydown/keypress/keyup) on the focused element.
function __stealthKey(o) {
  const el = document.activeElement || document.body;
  const key = o.key, code = o.code || key, m = o.modifiers || 0;
  const KC = o.keycodes;
  const kc = KC[key] != null ? KC[key] : (key && [...key].length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const mk = (type) => {
    const e = new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, composed: true,
      altKey: !!(m & 1), ctrlKey: !!(m & 2), metaKey: !!(m & 4), shiftKey: !!(m & 8) });
    Object.defineProperty(e, "keyCode", { get: () => kc });
    Object.defineProperty(e, "which", { get: () => kc });
    return e;
  };
  el.dispatchEvent(mk("keydown"));
  el.dispatchEvent(mk("keypress"));
  el.dispatchEvent(mk("keyup"));
  return { ok: true };
}

// Synthetic per-character typing — keydown + value update + input + keyup per
// char, the sequence autocomplete / React widgets listen for.
async function __stealthType(o) {
  const el = document.activeElement;
  if (!el) return { error: "no active element to type into" };
  try { el.focus && el.focus(); } catch (e) {}
  const text = String(o.text == null ? "" : o.text), delay = o.delay || 0;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
  const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value").set : null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const ch of text) {
    const kc = ch.toUpperCase().charCodeAt(0);
    const mk = (type) => {
      const e = new KeyboardEvent(type, { key: ch, code: "Key" + ch.toUpperCase(), bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(e, "keyCode", { get: () => kc });
      Object.defineProperty(e, "which", { get: () => kc });
      return e;
    };
    el.dispatchEvent(mk("keydown"));
    if (setter) { setter.call(el, (el.value || "") + ch); el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" })); }
    else if (el.isContentEditable) { try { document.execCommand("insertText", false, ch); } catch (e) { el.textContent = (el.textContent || "") + ch; } }
    el.dispatchEvent(mk("keyup"));
    if (delay) await sleep(delay);
  }
  return { ok: true, typed: [...text].length };
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
      // active:false → opens in background, never steals the user's focus.
      // newWindow:true → its own (unfocused) window, so later activateTab calls
      // never change the active tab of the user's / other automations' windows.
      if (p.newWindow) {
        const win = await chrome.windows.create({ url: p.url, focused: !!p.active });
        const tab = (win.tabs && win.tabs[0]) || (await chrome.tabs.query({ windowId: win.id }))[0];
        return { id: tab.id, windowId: win.id, newWindow: true };
      }
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
      // Stealth: MAIN-world scripting eval instead (no CDP; page CSP applies).
      await assertAllowed(p.tabId);
      if (p.stealth) return await stealthEval(p.tabId, p.code);
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
      // Stealth: synthetic pointer/mouse events instead of CDP Input.dispatch*.
      await assertAllowed(p.tabId);
      if (p.stealth) {
        const out = await stealthRun(p.tabId, __stealthClick, { selector: p.selector, x: p.x, y: p.y });
        if (out && out.error) throw new Error(`click: ${out.error}`);
        return out;
      }
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
      // Stealth: execCommand/native-setter insertion instead of CDP Input.insertText.
      await assertAllowed(p.tabId);
      if (p.stealth) {
        const out = await stealthRun(p.tabId, __stealthInsert, { text: p.text });
        if (out && out.error) throw new Error(`insertText: ${out.error}`);
        return out;
      }
      await dbgAttach(p.tabId);
      await dbg(p.tabId, "Input.insertText", { text: p.text });
      return { ok: true };
    }

    case "key": {
      // Trusted key press, e.g. {key:"Enter", code:"Enter", modifiers:0}.
      // Optional `commands` (e.g. ["paste"], ["selectAll"]) run the matching
      // editing command with the keyDown, so shortcuts like Cmd/Ctrl+V trigger
      // the browser's native paste instead of just delivering the raw key.
      // Stealth: synthetic KeyboardEvents (keyCode/which set for legacy handlers)
      // instead of CDP Input.dispatchKeyEvent. `commands` (native editing ops)
      // are CDP-only and are ignored in stealth.
      await assertAllowed(p.tabId);
      if (p.stealth) {
        return await stealthRun(p.tabId, __stealthKey,
          { key: p.key, code: p.code, modifiers: p.modifiers || 0, keycodes: __KEYCODES });
      }
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
      if (p.stealth) {
        // No CDP: fall back to captureVisibleTab, which only shoots the ACTIVE
        // tab of its window. Background-tab capture is a CDP-only capability.
        const tab = await chrome.tabs.get(p.tabId);
        if (!tab.active) throw new Error("stealth screenshot: tab must be active in its window (captureVisibleTab limitation) — call selectTab first, or add --debugger");
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        return { base64: (dataUrl.split(",")[1]) || "" };
      }
      await dbgAttach(p.tabId);
      const r = await dbg(p.tabId, "Page.captureScreenshot", { format: "png" });
      return { base64: r.data };
    }

    case "pdf": {
      await assertAllowed(p.tabId);
      if (p.stealth) throw new Error("stealth pdf: Page.printToPDF is CDP-only — add --debugger for this command");
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
      // Stealth: synthetic per-char keydown/input/keyup instead of CDP.
      await assertAllowed(p.tabId);
      if (p.stealth) {
        const out = await stealthRun(p.tabId, __stealthType, { text: p.text, delay: p.delay || 0 });
        if (out && out.error) throw new Error(`type: ${out.error}`);
        return out;
      }
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
      // pageRun uses chrome.scripting (no banner), falling back to the debugger
      // on special-scheme pages it can't inject into.
      await assertAllowed(p.tabId);
      const out = await pageRun(p.tabId, (o) => {
        if (o.selector) { const el = document.querySelector(o.selector); if (!el) return { error: "selector not found" }; el.scrollIntoView({ block: "center", inline: "center" }); return { ok: true, into: o.selector }; }
        if (o.top) { window.scrollTo(0, 0); return { ok: true, y: 0 }; }
        if (o.bottom) { window.scrollTo(0, document.body.scrollHeight); return { ok: true, y: window.scrollY }; }
        window.scrollBy(o.dx || 0, o.dy || 0); return { ok: true, x: window.scrollX, y: window.scrollY };
      }, { selector: p.selector, dx: p.dx, dy: p.dy, top: !!p.top, bottom: !!p.bottom }, p.stealth);
      if (out && out.error) throw new Error(`scroll: ${out.error}`);
      return out || { ok: true };
    }

    case "waitFor": {
      // Poll until a `selector` exists or a JS `code` condition is truthy.
      // Code uses CSP-proof debugger eval; selectors go through pageRun (no banner
      // on normal pages, debugger fallback on special-scheme ones).
      await assertAllowed(p.tabId);
      const timeout = p.timeoutMs || 10000;
      const poll = p.pollMs || 200;
      const start = Date.now();
      while (Date.now() < start + timeout) {
        let ok = false;
        if (p.code) {
          if (p.stealth) {
            ok = !!(await stealthEval(p.tabId, `(() => { try { return !!(${p.code}); } catch (e) { return false; } })()`));
          } else {
            await dbgAttach(p.tabId);
            const r = await dbg(p.tabId, "Runtime.evaluate", { expression: `(() => { try { return !!(${p.code}); } catch (e) { return false; } })()`, returnByValue: true });
            ok = !!(r.result && r.result.value);
          }
        } else {
          ok = !!(await pageRun(p.tabId, (sel) => !!document.querySelector(sel), p.selector || "", p.stealth));
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
