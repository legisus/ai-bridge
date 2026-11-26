// AI Browser Bridge — extension service worker.
// Maintains a WebSocket to the local bridge server and executes commands
// against chrome.* APIs.
//
// Access (extension/access.js): the user grants or revokes the bridge's access
// to this Chrome session from the popup or Options. Every command captures the
// access generation when it starts, is checked before it runs and after every
// await that precedes a browser operation, and every browser operation itself
// goes through BridgeAccess.dispatch(gen, …) — the last check and the call are
// one synchronous step, so a revoke never lets a queued operation through.
//
// Direct mode (params.direct === true — the CLI default): the command is
// executed with ordinary extension APIs and never attaches chrome.debugger.
// eval runs through chrome.userScripts.execute() in the page's MAIN world
// (the documented API for running user-supplied code; the user enables it once
// with the "Allow User Scripts" toggle on the extension card); click / type /
// insertText / key are emulated with synthetic DOM events. No DevTools session,
// no "…is debugging this browser" banner, less overhead — at the cost of
// untrusted events (isTrusted:false) and active-tab-only screenshots.
//
// Debugger mode (params.direct === false — the CLI's --debugger, approved by
// the user): trusted input and eval go through chrome.debugger (DevTools
// protocol), which rich-text editors and CSP-strict apps require, plus pdf and
// background-tab screenshots. Chrome shows its banner while it is attached.

importScripts("access.js"); // BridgeAccess: access record + transition, browserSession, agentTabs, downloads

const DEFAULTS = { port: 8765, token: "", allowlist: [], indicator: true, idleDetachMs: 120000, provisionedBy: "", session: "chrome", manualMode: false, autoGrant: true };
const PASS_ALWAYS = new Set(["ping", "status"]); // touch no tab: served whatever the access state
const TYPE_CHUNK = 20; // direct-mode `type` runs from the worker in chunks, with an access check between chunks

let ws = null;
let attached = new Set(); // tabIds with debugger attached
const attaching = new Map(); // tabId -> in-flight attach promise (dedupes concurrent first-touch)
const lastActivity = new Map(); // tabId -> last command timestamp (for idle auto-detach)

// ---------- config ----------

async function config() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

// ---------- access wiring ----------

function setBadge({ text, color }) {
  try { chrome.action.setBadgeText({ text: text || "" }); chrome.action.setBadgeBackgroundColor({ color: color || "#9e9e9e" }); } catch {}
}
async function refreshBadge() {
  try { setBadge(BridgeAccess.badgeState(await BridgeAccess.readAccess())); } catch {}
}
// Revoke step: release every attached tab and every attach still in flight.
async function detachEverything() {
  for (const p of [...attaching.values()]) { try { await p; } catch {} }
  for (const tabId of [...attached]) await detachTab(tabId);
}
function sendAccess(msg) {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); } catch {}
}
BridgeAccess.configure({
  onRevoke: detachEverything,
  send: sendAccess,
  badge: setBadge,
  sessionName: async () => (await config()).session,
  log: (line) => console.info(`[bridge] ${line}`),
});
// Worker start: adopt the stored record (expired grant → revoked, missing
// expiry alarm recreated), reconcile tab/download ownership, then connect.
const initDone = (async () => {
  try { await BridgeAccess.init(); } catch (e) { console.warn("[bridge] access init failed", e); }
  await refreshBadge();
})();

// ---------- connection ----------

const NATIVE_HOST = "com.ai_bridge.host";
let lastProvisionAttempt = 0;

// Ask the native messaging host (server/native-host.js, registered with
// `npm run register-host`) for the token and port. The host also starts the
// relay server if it is not running. Silently a no-op when no host is
// registered — the manual Options-page path keeps working — and when the user
// turned Manual mode on (a pasted token must never be overwritten by a host).
async function provisionViaNativeHost(reason) {
  if ((await config()).manualMode) return;
  const now = Date.now();
  if (now - lastProvisionAttempt < 15000) return;   // throttle: once per 15 s
  lastProvisionAttempt = now;
  let port;
  try { port = chrome.runtime.connectNative(NATIVE_HOST); } catch { return; }
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== "hello" || !msg.token) return;
    const cfg = await config();
    if (cfg.manualMode) { try { port.disconnect(); } catch {} return; }
    const changed = cfg.token !== msg.token || cfg.port !== msg.port;
    // A changed token/port is picked up by the storage.onChanged listener below
    // (revoke, then reconnect); an unchanged one only needs a connect.
    await chrome.storage.local.set({ token: msg.token, port: msg.port, provisionedBy: "native-host", provisionedAt: now });
    try { port.disconnect(); } catch {}
    if (!changed && !ws) connect();
  });
  port.onDisconnect.addListener(() => {
    // Reading lastError marks it handled. It is "Specified native messaging
    // host not found." when nothing is registered — expected on a manual
    // install; the Options-page path still works.
    void chrome.runtime.lastError;
  });
}

let connecting = false; // guards the async gap before `ws` is assigned

async function connect() {
  if (connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connecting = true;
  let cfg;
  try { await initDone; cfg = await config(); } finally { connecting = false; }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (!cfg.token) { provisionViaNativeHost("no token"); return; } // not provisioned yet — native host, or paste in Options
  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${cfg.port}`);
  } catch (e) {
    provisionViaNativeHost("socket error");
    return;
  }
  ws = sock;
  let opened = false;
  sock.onopen = () => {
    opened = true;
    sock.send(JSON.stringify({ type: "auth", role: "extension", token: cfg.token }));
  };
  let announced = false;
  sock.onmessage = async (ev) => {
    if (ws !== sock) return; // a superseded socket has nothing to say
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "auth" && msg.ok) {
      // Tell the relay whether the user has granted this browser session, and
      // which session this is (browserSession), before any command is served.
      try { sock.send(JSON.stringify(await BridgeAccess.accessMessage(cfg.session))); } catch {}
      announced = true;
      BridgeAccess.logEvent({ kind: "connect" });
      return;
    }
    if (msg.type !== "command") return;
    const gen = BridgeAccess.currentGen(); // the generation this command belongs to
    let reply;
    try {
      if (!PASS_ALWAYS.has(msg.cmd)) await BridgeAccess.assertAccess(gen);
      const result = await handle(msg.cmd, msg.params || {}, gen, String(msg.id));
      reply = { type: "response", id: msg.id, ok: true, result };
    } catch (e) {
      const error = String(e && e.message || e);
      reply = { type: "response", id: msg.id, ok: false, error };
      const reason = refusalReason(error);
      if (reason) {
        const p = msg.params || {};
        BridgeAccess.logEvent({ kind: "refused", reqId: msg.id, tabId: Number.isInteger(p.tabId) ? p.tabId : undefined, origin: typeof p.url === "string" ? p.url : undefined, detail: { reason } });
      }
    }
    if (ws !== sock) return;
    try { sock.send(JSON.stringify(reply)); } catch {}
  };
  sock.onclose = () => {
    // Only the socket we currently own may clear `ws` and schedule a retry.
    // A superseded socket (the server closes the previous extension socket
    // when a new one authenticates) must not knock out the live one.
    if (ws !== sock) { if (announced) BridgeAccess.logEvent({ kind: "superseded" }); return; }
    ws = null;
    if (announced) BridgeAccess.logEvent({ kind: "disconnect", detail: { reason: "extension_disconnected" } });
    if (!opened) {
      // Never opened → server is down (or the token is stale). Chrome logs one
      // ERR_CONNECTION_REFUSED for this attempt; don't add more by retrying
      // blindly every second — let the native host start the server / refresh
      // the token (its hello calls connect()), with the 24 s alarm as backstop.
      provisionViaNativeHost("connect failed");
      return;
    }
    setTimeout(connect, 1000); // server restarted or superseded us: quick reconnect while SW is alive
  };
  sock.onerror = () => { try { sock.close(); } catch {} };
}

// A new token or port means a new (or restarted) relay: revoke first, so
// in-flight commands fail on the generation bump and the debugger is released,
// then reconnect. The new relay starts not_granted; the user grants again.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const credential = !!(changes.token || changes.port);
  const policy = !!changes.autoGrant;
  if (!credential && !policy) return;
  // One ordered recovery for whatever the save changed: a credential change
  // revokes, cleans up and replaces the socket; then the FINAL policy decides
  // (reconcile grants, OFF revokes); then reconnect.
  (async () => {
    if (credential) {
      await BridgeAccess.setAccess({ granted: false, source: "token-change" });
      try { ws && ws.close(); } catch {}
      ws = null;
    } else if (changes.autoGrant.newValue === false) {
      await BridgeAccess.setAccess({ granted: false, source: "options" });
    }
    await BridgeAccess.reconcileAuto(); // reads the policy as it is now; no-op when OFF
    await refreshBadge();
    if (credential) connect();
  })();
});

chrome.alarms.create("reconnect", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "reconnect") { connect(); idleDetachSweep(); refreshBadge(); return; }
  if (/^access-expiry-/.test(a.name)) BridgeAccess.onAlarm(a.name);
});
chrome.runtime.onStartup.addListener(() => { initDone.then(() => BridgeAccess.reconcileAuto()).then(connect, connect); });
// After any reload, update or install: revoked, with a notice in the popup.
chrome.runtime.onInstalled.addListener(() => { initDone.then(() => BridgeAccess.onInstalled()).then(connect, connect); });
connect();

// Bridge downloads of this browser session still running (reload guard);
// null when any lookup failed, so the caller cannot mistake "unknown" for "none".
async function inProgressBridgeDownloads() {
  let bridgeDownloads;
  try { ({ bridgeDownloads } = await chrome.storage.local.get("bridgeDownloads")); } catch { return null; }
  const ids = Object.keys(bridgeDownloads || {}).map(Number);
  const out = [];
  for (const id of ids) {
    try { const [it] = await chrome.downloads.search({ id }); if (it && it.state === "in_progress") out.push(id); }
    catch { return null; }
  }
  return out;
}

// Error strings that mean "refused" (an event with a fixed code); command
// failures of other kinds are not refusals and are not logged.
function refusalReason(error) {
  if (/^access_revoked:/.test(error)) return "access_revoked";
  if (/^access_not_granted:/.test(error)) return "access_not_granted";
  if (error === "privileged target refused") return "privileged_target";
  if (/ not in allowlist$/.test(error)) return "not_allowed";
  if (error === "target changed") return "target_changed";
  return null;
}

// ---------- messages from the popup and the Options page ----------
// The worker is the only writer of `access`; its own pages ask it to change
// the state. Anything else (a web page, another extension) is refused.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const own = sender && sender.id === chrome.runtime.id && String(sender.url || "").startsWith("chrome-extension://");
  if (!own) { sendResponse({ ok: false, error: "unauthorised sender" }); return false; }
  (async () => {
    switch (msg && msg.type) {
      case "access-set": {
        const policy = await BridgeAccess.autoGrantEnabled();
        if (policy === null) return { ok: false, error: "access settings could not be read; try again" };
        if (policy) return { ok: false, error: "auto-grant is on; disable it in Options to manage access by hand (to stop the bridge, disable the extension at chrome://extensions)" };
        const req = BridgeAccess.parseAccessSet(msg);
        if (req.error) return { ok: false, error: req.error };
        const rec = await BridgeAccess.setAccess({ ...req, source: msg.source || "popup" });
        return { ok: !rec.error, access: rec, ...(rec.error ? { error: rec.error } : {}) };
      }
      case "access-get": {
        const st = await BridgeAccess.status();
        const cfg = await config();
        return { ok: true, ...st, connected: !!(ws && ws.readyState === WebSocket.OPEN), session: cfg.session, autoGrant: cfg.autoGrant !== false };
      }
      case "close-agent-tabs": return { ok: true, ...(await BridgeAccess.closeAgentTabs()) };
      case "events-get": return { ok: true, events: await BridgeAccess.events() };
      case "dismiss-notices": await BridgeAccess.dismissNotices(); return { ok: true };
      default: return { ok: false, error: `unknown message: ${msg && msg.type}` };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

// ---------- target validation ----------
// Every command names the document it was validated for. validateTab reads the
// tab fresh (never trusts the caller's idea of the URL), applies the
// privileged-origin block and the allowlist to that URL, and records the main
// frame's documentId. Direct injections then run only in that document
// (chrome.scripting / userScripts `documentIds`): a replacement document makes
// Chrome reject the call, which is reported as `target changed`. The debugger
// route binds code to an execution context whose origin passed the same
// checks (see cdp below).
const originOf = (url) => { try { return new URL(String(url)).origin; } catch { return "unknown"; } };
async function allowlistOf() { return (await config()).allowlist || []; }
async function mainDocumentId(tabId) {
  try { const f = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }); return f && f.documentId ? f.documentId : null; } catch { return null; }
}
async function mainFrame(tabId) {
  try { const f = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }); return f && f.documentId ? { url: String(f.url || ""), documentId: f.documentId } : null; } catch { return null; }
}
async function validateTab(tabId, gen, { allowlist, allowBlank = false } = {}) {
  if (!Number.isInteger(tabId)) throw new Error("tabId required");
  const tab = await chrome.tabs.get(tabId);
  // The URL that is judged and the document that is bound come from the same
  // frame read; a tab whose main frame has no document (still loading, or a
  // page Chrome hides from the API) cannot be a target.
  const frame = await mainFrame(tabId);
  const url = frame ? frame.url : String(tab.url || tab.pendingUrl || "");
  const blank = BridgeAccess.blankUrl(url);
  if (!(allowBlank && blank)) BridgeAccess.assertAllowedUrl(url, allowlist);
  if (!frame && !(allowBlank && blank)) throw new Error("target changed");
  await BridgeAccess.assertAccess(gen);
  return { tabId, tab, url, origin: originOf(url), documentId: frame ? frame.documentId : null, windowId: tab.windowId, active: !!tab.active, blank };
}
// The injection target for a validated document; never a bare tab.
function docTarget(v) {
  if (!v || !v.documentId) throw new Error("target changed");
  return { tabId: v.tabId, documentIds: [v.documentId] };
}
// An injection that failed: was it because the document went away?
async function failedInjection(v, e) {
  if (/^access_/.test(String(e && e.message))) throw e;
  if (v && v.documentId) {
    const now = await mainDocumentId(v.tabId);
    if (now !== v.documentId) throw new Error("target changed");
  }
  throw e;
}

// ---------- debugger helpers ----------

// Per attached tab: the execution contexts Chrome reported (uniqueId → frame,
// origin, main world?) and the main frame's loaderId. Code runs only in a
// context whose origin passed validation (uniqueContextId); input and capture
// re-compare the loaderId right before each send (the residual one-round-trip
// window is accepted and documented).
const cdp = new Map(); // tabId -> { contexts: Map, loaderId, mainFrameId, mainOrigin }
chrome.debugger.onEvent.addListener((src, method, params) => {
  const st = src && src.tabId != null ? cdp.get(src.tabId) : null;
  if (!st) return;
  if (method === "Runtime.executionContextCreated") {
    const c = params.context || {};
    st.contexts.set(c.uniqueId, { frameId: c.auxData && c.auxData.frameId, isDefault: !!(c.auxData && c.auxData.isDefault), origin: c.origin });
  } else if (method === "Runtime.executionContextDestroyed") {
    if (params.executionContextUniqueId) st.contexts.delete(params.executionContextUniqueId);
  } else if (method === "Runtime.executionContextsCleared") {
    st.contexts.clear();
  } else if (method === "Page.frameNavigated") {
    const f = params.frame || {};
    if (!f.parentId) { st.mainFrameId = f.id; st.loaderId = f.loaderId; st.mainOrigin = originOf(f.url); st.contexts.clear(); }
  }
});
async function ensureCdpTracking(tabId, gen) {
  let st = cdp.get(tabId);
  if (!st) {
    st = { contexts: new Map(), loaderId: null, mainFrameId: null, mainOrigin: null, ready: null };
    st.ready = (async () => {
      await dbg(tabId, "Page.enable", {}, gen);
      const tree = await dbg(tabId, "Page.getFrameTree", {}, gen);
      const main = tree && tree.frameTree && tree.frameTree.frame;
      if (main) { st.mainFrameId = main.id; st.loaderId = main.loaderId; st.mainOrigin = originOf(main.url); }
      await dbg(tabId, "Runtime.enable", {}, gen); // reports the existing contexts
    })().catch((e) => { if (cdp.get(tabId) === st) cdp.delete(tabId); throw e; });
    cdp.set(tabId, st);
  }
  await st.ready; // every caller waits for the same initialisation
  return st;
}
// The main-world context of the validated document, or `target changed`.
async function contextFor(tabId, v, gen, allowlist) {
  const st = await ensureCdpTracking(tabId, gen);
  const deadline = Date.now() + 2000;
  for (;;) {
    for (const [uniqueId, c] of st.contexts) {
      if (c.frameId !== st.mainFrameId || !c.isDefault) continue;
      let ok = false;
      try { BridgeAccess.assertAllowedUrl(c.origin + "/", allowlist); ok = c.origin === v.origin; } catch { ok = false; }
      if (ok) return uniqueId;
    }
    if (Date.now() > deadline) throw new Error("target changed");
    await new Promise((r) => setTimeout(r, 50));
    await BridgeAccess.assertAccess(gen);
  }
}
// Input and capture have no context parameter: the loader (and origin) of the
// main frame must still be the one validated.
function assertLoader(tabId, v) {
  const st = cdp.get(tabId);
  if (!st || st.loaderId !== v.loaderId || st.mainOrigin !== v.origin) throw new Error("target changed");
}
async function dbgEval(tabId, v, gen, allowlist, params) {
  const uniqueContextId = await contextFor(tabId, v, gen, allowlist);
  return dbg(tabId, "Runtime.evaluate", { ...params, uniqueContextId }, gen);
}

const attachCancelled = new Set(); // tabIds whose in-flight attach was invalidated by a forbidden navigation
async function dbgAttach(tabId, gen, v, reqId) {
  if (attached.has(tabId)) { await BridgeAccess.assertAccess(gen); return; }
  // Dedupe concurrent first-touch: several commands hitting the same not-yet-attached
  // tab at once must share ONE attach, or Chrome rejects the extras with
  // "Another debugger is already attached". Later callers await the same promise.
  let p = attaching.get(tabId);
  if (!p) {
    attachCancelled.delete(tabId);
    p = BridgeAccess.dispatch(gen, () => chrome.debugger.attach({ tabId }, "1.3"))
      .then(() => { attached.add(tabId); })
      .finally(() => { attaching.delete(tabId); });
    attaching.set(tabId, p);
  }
  await p;
  // A late attach completion that finds the generation moved, or the tab
  // navigated somewhere forbidden meanwhile, detaches itself.
  try { await BridgeAccess.assertAccess(gen); }
  catch (e) { await detachTab(tabId); throw e; }
  if (attachCancelled.has(tabId)) { attachCancelled.delete(tabId); await detachTab(tabId); throw new Error("target changed"); }
  const now = await mainFrame(tabId);
  if (v && (!now || now.documentId !== v.documentId)) { await detachTab(tabId); throw new Error("target changed"); }
  BridgeAccess.logEvent({ kind: "attach", tabId, reqId, origin: v && v.origin });
  if (v) await setIndicator(tabId, true, v.documentId);
}

chrome.debugger.onDetach.addListener((src) => { if (src.tabId) { attached.delete(src.tabId); attaching.delete(src.tabId); cdp.delete(src.tabId); lastActivity.delete(src.tabId); setIndicator(src.tabId, false); } });
chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); attaching.delete(tabId); cdp.delete(tabId); indicatorDoc.delete(tabId); lastActivity.delete(tabId); BridgeAccess.forgetAgentTab(tabId); });
// The early signal: an attached tab that navigates to a privileged or
// disallowed URL is released at once (the document binding above is the
// guarantee; this just stops the banner lingering on a page we may not touch).
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info || !info.url) return;
  if (!attached.has(tabId) && !attaching.has(tabId)) return;
  try { BridgeAccess.assertAllowedUrl(info.url, await allowlistOf()); }
  catch {
    if (attaching.has(tabId)) attachCancelled.add(tabId); // the attach in flight is invalid; dbgAttach detaches it when it lands
    if (attached.has(tabId)) await detachTab(tabId, { reason: "target_changed", origin: originOf(info.url) });
  }
});

// Every debugger command: a fresh access read (an await has always preceded
// it) immediately followed by the synchronous dispatch check and the call.
// With `v` (input, capture, pdf) the frame's loader and origin are compared
// inside the same synchronous step as the send: a navigation processed during
// the access read above cannot slip a command into the replacement page.
async function dbg(tabId, method, params, gen, v) {
  await BridgeAccess.assertAccess(gen);
  return BridgeAccess.dispatch(gen, () => { if (v) assertLoader(tabId, v); return chrome.debugger.sendCommand({ tabId }, method, params || {}); });
}

// Detach one tab: release the debugger, clear its indicator and activity record.
async function detachTab(tabId, why) {
  if (attached.has(tabId)) {
    try { await chrome.debugger.detach({ tabId }); } catch (e) { /* already gone */ }
    attached.delete(tabId);
    BridgeAccess.logEvent({ kind: "detach", tabId, origin: why && why.origin, detail: why && why.reason ? { reason: why.reason } : undefined });
  }
  cdp.delete(tabId);
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
// The indicator is injected only into the document it was validated for
// (`documentId`, recorded at install and reused for the removal), never into
// whatever page the tab shows now.
const indicatorDoc = new Map(); // tabId -> documentId the indicator was installed in
async function setIndicator(tabId, on, documentId) {
  if (on && !(await config()).indicator) return;
  if (on) { if (!documentId) return; indicatorDoc.set(tabId, documentId); }
  else { documentId = indicatorDoc.get(tabId); indicatorDoc.delete(tabId); if (!documentId) return; }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
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
async function selectorCenter(tabId, selector, v, gen, allowlist) {
  await dbgAttach(tabId, gen, v);
  const r = await dbgEval(tabId, v, gen, allowlist, {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
    returnByValue: true,
  });
  return (r.result && r.result.value) || null;
}

// Run a self-contained fn(arg) in the validated document. Prefers chrome.scripting
// (no debugger banner); if the page blocks injection (the Web Store, PDF viewer),
// falls back to CSP-proof debugger eval in the validated context. fn must not
// close over outer variables.
async function pageRun(v, fn, arg, noDebugger, gen, allowlist) {
  try {
    const target = docTarget(v);
    const [res] = await BridgeAccess.dispatch(gen, () => chrome.scripting.executeScript({ target, func: fn, args: [arg] }));
    return res && res.result;
  } catch (e) {
    if (noDebugger) return failedInjection(v, e); // direct mode: never fall back to the debugger
    if (/^access_/.test(String(e && e.message))) throw e;
    await dbgAttach(v.tabId, gen, v);
    const r = await dbgEval(v.tabId, v, gen, allowlist, { expression: `(${fn.toString()})(${JSON.stringify(arg)})`, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result && r.result.value;
  }
}

// Chrome allows ~2 captureVisibleTab calls per second for the whole browser
// (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND). Parallel automations trip that,
// so direct screenshots go through a FIFO pacer that spaces calls ≥ 520 ms
// apart — no call is wasted on a guaranteed quota error and callers are served
// in order. The catch/retry below is only a safety net for edge timing. Each
// queued capture re-checks access right before it fires: a revoke while a
// screenshot waits in the queue discards it.
const CAPTURE_GAP_MS = 520;
let captureQueue = Promise.resolve();
let lastCaptureAt = 0;
function pacedCapture(windowId, gen, beforeShot) {
  const run = async () => {
    const wait = lastCaptureAt + CAPTURE_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    for (let attempt = 0; ; attempt++) {
      await BridgeAccess.assertAccess(gen);
      if (beforeShot) await beforeShot();
      try {
        lastCaptureAt = Date.now();
        return await BridgeAccess.dispatch(gen, () => chrome.tabs.captureVisibleTab(windowId, { format: "png" }));
      } catch (e) {
        if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(String(e && e.message || e)) || attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, CAPTURE_GAP_MS));
      }
    }
  };
  const p = captureQueue.then(run, run);
  captureQueue = p.catch(() => {});
  return p;
}
// captureVisibleTab shoots whatever tab is active in the window at capture
// time. Watch the window's activations across the capture and re-read the
// main frame's documentId afterwards; any change discards the image. (The
// strict boundary for screenshots is the debugger route.)
// `guard` is installed by the caller BEFORE the tab is validated, so an
// activation during validation is seen too; inside the pacer the tab must
// still be the active one right before the shot.
function activationGuard() {
  const seen = [];
  const onAct = (info) => { if (info) seen.push(info); };
  chrome.tabs.onActivated.addListener(onAct);
  return { seen, stop() { chrome.tabs.onActivated.removeListener(onAct); } };
}
async function guardedCapture(v, gen, guard) {
  try {
    const dataUrl = await pacedCapture(v.windowId, gen, async () => {
      const t = await chrome.tabs.get(v.tabId);
      if (!t.active || t.windowId !== v.windowId || guard.seen.some((i) => i.windowId === v.windowId)) throw new Error("target changed");
    });
    await new Promise((r) => setTimeout(r, 0)); // queued activation events land before this continuation
    const now = await mainFrame(v.tabId);
    if (guard.seen.some((i) => i.windowId === v.windowId) || !now || now.documentId !== v.documentId) throw new Error("target changed");
    return dataUrl;
  } finally { guard.stop(); }
}

// ---------- direct-mode (no-debugger) helpers ----------
// All of these use chrome.scripting only — they never attach the debugger, so
// no DevTools session is opened and no banner is shown. Injected functions must be
// self-contained (no closures over outer variables).

// Evaluate a user-supplied code string in the page's MAIN world through
// chrome.userScripts.execute() — the documented API for user-provided code
// (no eval, no remotely hosted code in the extension context). The user enables
// it once via "Allow User Scripts" on the extension card (Chrome 138+) or
// Developer mode (Chrome 135–137). Promises are awaited; the completion value
// of the script is returned, like Runtime.evaluate.
const USER_SCRIPTS_HELP = 'User Scripts API is not enabled for AI Browser Bridge: open chrome://extensions, click Details on the extension, turn on "Allow User Scripts" (Chrome 138+) or Developer mode (Chrome 135–137) — or add --debugger for this call';
async function directEval(v, code, gen) {
  if (!chrome.userScripts || typeof chrome.userScripts.execute !== "function") throw new Error(USER_SCRIPTS_HELP);
  let results;
  try {
    const target = docTarget(v);
    results = await BridgeAccess.dispatch(gen, () => chrome.userScripts.execute({
      target,
      js: [{ code: String(code) }],
      world: "MAIN",
      injectImmediately: true,
    }));
  } catch (e) {
    if (e && e.message === "target changed") throw e;
    try { await failedInjection(v, e); } catch (e2) { if (e2 !== e) throw e2; }
    throw new Error(`direct eval failed: ${e && e.message || e}`);
  }
  const res = results && results[0];
  if (res && res.error) throw new Error(`direct eval: ${res.error.message || res.error}`);
  return res && res.result;
}

// Run a fixed, self-contained fn(arg) via chrome.scripting (no debugger, no
// eval — CSP-safe) in the validated document. Default ISOLATED world is enough:
// page listeners still receive events dispatched here (one shared DOM); only
// event.isTrusted differs.
async function directRun(v, fn, arg, gen) {
  try {
    const target = docTarget(v);
    const [res] = await BridgeAccess.dispatch(gen, () => chrome.scripting.executeScript({
      target, func: fn, args: [arg === undefined ? null : arg],
    }));
    return res && res.result;
  } catch (e) { return failedInjection(v, e); }
}

// Synthetic click on a selector's element (found + scrolled in-page) or the
// element at viewport point (x,y). Dispatches the full pointer/mouse sequence
// plus focus, so page handlers fire as they would for a real click.
function __directClick(o) {
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
function __directInsert(o) {
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
function __directKey(o) {
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
async function __directType(o) {
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

// `gen` is the access generation captured when the command arrived. The
// caller already ran assertAccess(gen) (except for ping/status); inside, every
// await that precedes a browser operation is followed by another check, and
// every browser operation goes through BridgeAccess.dispatch(gen, …). Every
// tab command validates its target first (validateTab) and acts only on the
// document it validated.
const ck = (gen) => BridgeAccess.assertAccess(gen);

async function handle(cmd, p, gen, reqId) {
  // Record activity so the idle sweep leaves actively-driven tabs attached.
  if (p && p.tabId != null) lastActivity.set(p.tabId, Date.now());
  const allowlist = PASS_ALWAYS.has(cmd) || cmd === "reloadExtension" || cmd === "closeTabs" || cmd === "detach" || cmd === "detachAll" ? null : await allowlistOf();
  switch (cmd) {
    case "reloadExtension": {
      // Reload this extension so an updated extension/ folder takes effect
      // (same as the reload icon on chrome://extensions). The reload clears
      // session storage (tab records), so this runs the full revoke FIRST (no
      // new work is admitted, the debugger is released, downloads cancelled),
      // then waits for creations whose id has not come back yet (their
      // completion closes them), then closes the agent's tabs and verifies:
      // every owned tab gone (a lookup that fails for any reason other than
      // "No tab with id" counts as not verified), no bridge download running
      // (a failed lookup counts as running). Anything short of that refuses the
      // reload and, with auto-grant on, hands access back. No auto re-grant
      // happens while this cleanup runs.
      BridgeAccess.beginReload();
      const refuse = async (why) => { BridgeAccess.endReload(); await BridgeAccess.reconcileAuto(); throw new Error(`reload refused: cleanup incomplete (${why})`); };
      try {
        await BridgeAccess.setAccess({ granted: false, closeTabs: false, source: "reload" });
        const drainMs = typeof self.__reloadDrainMs === "number" ? self.__reloadDrainMs : 5000; // tests shorten it
        const deadline = Date.now() + drainMs;
        let pending = 0;
        for (;;) {
          const [{ pendingTabs }, { pendingDownloads }] = await Promise.all([chrome.storage.session.get("pendingTabs"), chrome.storage.local.get("pendingDownloads")]);
          pending = (pendingTabs || []).length + (pendingDownloads || []).length;
          if (!pending || Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        if (pending) return await refuse(`${pending} pending creation(s) did not complete`);
        const owned = await BridgeAccess.agentTabIds();
        await BridgeAccess.closeAgentTabs();
        const left = [];
        for (const id of owned) {
          try { await chrome.tabs.get(id); left.push(id); }
          catch (e) { if (!/No tab with id/i.test(String(e && e.message))) left.push(id); }
        }
        const running = await inProgressBridgeDownloads();
        if (left.length || running === null || running.length) return await refuse(`${left.length} agent tab(s) still open, ${running === null ? "download state unknown" : `${running.length} download(s) still running`}`);
      } catch (e) {
        if (!/^reload refused/.test(String(e && e.message))) { BridgeAccess.endReload(); await BridgeAccess.reconcileAuto(); }
        throw e;
      }
      setTimeout(() => chrome.runtime.reload(), 50);
      return { ok: true, reloading: true };
    }

    case "ping":
      return { pong: true, version: chrome.runtime.getManifest().version };

    case "listTabs": {
      // Only allowed http(s) tabs are described; the rest are listed by id.
      const tabs = await chrome.tabs.query({});
      return BridgeAccess.redactTabs(tabs, allowlist, await BridgeAccess.agentTabIds());
    }

    case "newTab": {
      // active:false → opens in background, never steals the user's focus.
      // newWindow:true → its own (unfocused) window, so later activateTab calls
      // never change the active tab of the user's / other automations' windows.
      // The destination is checked (privileged block + allowlist); the pending
      // entry is written before Chrome is called: a tab whose id comes back
      // after a revoke is closed by completeTab, not returned.
      BridgeAccess.assertAllowedUrl(p.url, allowlist);
      const nonce = await BridgeAccess.beginTab({ gen, origin: originOf(p.url), reqId });
      let tab, windowId, newWindow = false;
      try {
        await ck(gen);
        if (p.newWindow) {
          const win = await BridgeAccess.dispatch(gen, () => chrome.windows.create({ url: p.url, focused: !!p.active }));
          tab = (win.tabs && win.tabs[0]) || (await chrome.tabs.query({ windowId: win.id }))[0];
          windowId = win.id; newWindow = true;
        } else {
          // windowId → open in that specific window (e.g. an automation's own
          // window), not whichever window was focused last.
          const opts = { url: p.url, active: !!p.active };
          if (p.windowId != null) opts.windowId = p.windowId;
          tab = await BridgeAccess.dispatch(gen, () => chrome.tabs.create(opts));
          windowId = tab.windowId;
        }
      } catch (e) {
        await BridgeAccess.completeTab(nonce, null);
        throw e;
      }
      if (!(await BridgeAccess.completeTab(nonce, tab.id))) throw new Error(BridgeAccess.ACCESS_REVOKED((await config()).session));
      return newWindow ? { id: tab.id, windowId, newWindow: true } : { id: tab.id, windowId };
    }

    case "navigate": {
      // Both ends are checked: the tab as it is now (a blank tab is fine) and
      // the destination.
      BridgeAccess.assertAllowedUrl(p.url, allowlist);
      await validateTab(p.tabId, gen, { allowlist, allowBlank: true });
      await BridgeAccess.dispatch(gen, () => chrome.tabs.update(p.tabId, { url: p.url }));
      return { ok: true };
    }

    case "activateTab": {
      // Focus a tab and bring its window to the front.
      const v = await validateTab(p.tabId, gen, { allowlist });
      const tab = await BridgeAccess.dispatch(gen, () => chrome.tabs.update(p.tabId, { active: true }));
      if (tab && tab.windowId != null) {
        await BridgeAccess.dispatch(gen, () => chrome.windows.update(tab.windowId, { focused: true }));
      }
      return { ok: true, tabId: p.tabId, windowId: tab && tab.windowId, documentId: v.documentId };
    }

    case "selectTab": {
      // Make the tab active WITHIN its window without focusing the window —
      // for background automation that must never steal the user's focus
      // (activateTab does both; this does only the tab half).
      await validateTab(p.tabId, gen, { allowlist });
      await BridgeAccess.dispatch(gen, () => chrome.tabs.update(p.tabId, { active: true }));
      return { ok: true, tabId: p.tabId };
    }

    case "closeTab": {
      // A tab the bridge opened in this browser session may always be closed
      // (whatever it navigated to); any other tab is subject to the target rules.
      const own = await BridgeAccess.agentTabIds();
      if (!own.includes(p.tabId)) await validateTab(p.tabId, gen, { allowlist });
      await ck(gen);
      await BridgeAccess.dispatch(gen, () => chrome.tabs.remove(p.tabId));
      await BridgeAccess.forgetAgentTab(p.tabId);
      BridgeAccess.logEvent({ kind: "tab_closed", tabId: p.tabId, reqId });
      return { ok: true };
    }

    case "closeTabs":
      // Run cleanup / `bridge closeTabs`: closes only tabs this extension
      // opened (agentTabs); every other id comes back as skipped. No window
      // removal — a window that becomes empty is closed by Chrome itself.
      return await BridgeAccess.closeOwnedTabs(p.tabIds, { gen });

    case "eval": {
      // Direct mode: chrome.userScripts.execute in the validated document.
      // Debugger mode: Runtime.evaluate in the validated document's main-world context.
      const v = await validateTab(p.tabId, gen, { allowlist });
      if (p.direct) return await directEval(v, p.code, gen);
      await dbgAttach(p.tabId, gen, v, reqId);
      const r = await dbgEval(p.tabId, v, gen, allowlist, {
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
      // Direct mode: synthetic pointer/mouse events instead of CDP Input.dispatch*.
      const v = await validateTab(p.tabId, gen, { allowlist });
      if (p.direct) {
        const out = await directRun(v, __directClick, { selector: p.selector, x: p.x, y: p.y }, gen);
        if (out && out.error) throw new Error(`click: ${out.error}`);
        return out;
      }
      await dbgAttach(p.tabId, gen, v, reqId);
      const st = await ensureCdpTracking(p.tabId, gen); v.loaderId = st.loaderId;
      let x = p.x, y = p.y;
      if (p.selector) {
        const c = await selectorCenter(p.tabId, p.selector, v, gen, allowlist);
        if (!c) throw new Error(`click: selector not found: ${p.selector}`);
        x = Math.round(c.x); y = Math.round(c.y);
      }
      const base = { x, y, button: "left", clickCount: p.clickCount || 1 };
      for (const ev of [{ type: "mouseMoved", ...base, button: "none" }, { type: "mousePressed", ...base }, { type: "mouseReleased", ...base }]) {
        await dbg(p.tabId, "Input.dispatchMouseEvent", ev, gen, v);
      }
      return { ok: true, x, y };
    }

    case "insertText": {
      // Trusted text insertion at the current caret (equivalent of a real paste).
      // Direct mode: execCommand/native-setter insertion instead of CDP Input.insertText.
      const v = await validateTab(p.tabId, gen, { allowlist });
      if (p.direct) {
        const out = await directRun(v, __directInsert, { text: p.text }, gen);
        if (out && out.error) throw new Error(`insertText: ${out.error}`);
        return out;
      }
      await dbgAttach(p.tabId, gen, v, reqId);
      const st = await ensureCdpTracking(p.tabId, gen); v.loaderId = st.loaderId;
      await dbg(p.tabId, "Input.insertText", { text: p.text }, gen, v);
      return { ok: true };
    }

    case "key": {
      // Trusted key press, e.g. {key:"Enter", code:"Enter", modifiers:0}.
      // Optional `commands` (e.g. ["paste"], ["selectAll"]) run the matching
      // editing command with the keyDown, so shortcuts like Cmd/Ctrl+V trigger
      // the browser's native paste instead of just delivering the raw key.
      // Direct mode: synthetic KeyboardEvents (keyCode/which set for legacy handlers)
      // instead of CDP Input.dispatchKeyEvent. `commands` (native editing ops)
      // are CDP-only and are ignored in direct mode.
      const v = await validateTab(p.tabId, gen, { allowlist });
      if (p.direct) {
        return await directRun(v, __directKey,
          { key: p.key, code: p.code, modifiers: p.modifiers || 0, keycodes: __KEYCODES }, gen);
      }
      await dbgAttach(p.tabId, gen, v, reqId);
      const st = await ensureCdpTracking(p.tabId, gen); v.loaderId = st.loaderId;
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
      await dbg(p.tabId, "Input.dispatchKeyEvent", down, gen, v);
      await dbg(p.tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...ev }, gen, v);
      return { ok: true };
    }

    case "screenshot": {
      if (p.direct) {
        // No CDP: fall back to captureVisibleTab, which only shoots the ACTIVE
        // tab of its window. Background-tab capture is a CDP-only capability.
        // The activation guard goes up before validation so nothing between
        // validation and the shot escapes it.
        const guard = activationGuard();
        let v;
        try { v = await validateTab(p.tabId, gen, { allowlist }); } catch (e) { guard.stop(); throw e; }
        if (!v.active) { guard.stop(); throw new Error("direct screenshot: tab must be active in its window (captureVisibleTab limitation) — call selectTab first, or add --debugger"); }
        const dataUrl = await guardedCapture(v, gen, guard);
        return { base64: (dataUrl.split(",")[1]) || "" };
      }
      const v = await validateTab(p.tabId, gen, { allowlist });
      await dbgAttach(p.tabId, gen, v, reqId);
      const st = await ensureCdpTracking(p.tabId, gen); v.loaderId = st.loaderId;
      const r = await dbg(p.tabId, "Page.captureScreenshot", { format: "png" }, gen, v);
      return { base64: r.data };
    }

    case "pdf": {
      const v = await validateTab(p.tabId, gen, { allowlist });
      if (p.direct) throw new Error("direct pdf: Page.printToPDF is CDP-only — add --debugger for this command");
      await dbgAttach(p.tabId, gen, v, reqId);
      const st = await ensureCdpTracking(p.tabId, gen); v.loaderId = st.loaderId;
      const r = await dbg(p.tabId, "Page.printToPDF", {
        printBackground: true,
        displayHeaderFooter: false,
      }, gen, v);
      return { base64: r.data };
    }

    case "download": {
      // Uses the browser's own cookie jar — authenticated downloads just work.
      // filename is relative to the user's Downloads directory. The URL is
      // checked; ownership is recorded before the call (pending) and completed
      // when the id returns; a revoke in between cancels the download instead
      // of returning it.
      BridgeAccess.assertAllowedUrl(p.url, allowlist);
      const nonce = await BridgeAccess.beginDownload({ gen, origin: originOf(p.url), reqId });
      let id;
      try {
        await ck(gen);
        id = await BridgeAccess.dispatch(gen, () => chrome.downloads.download({
          url: p.url,
          filename: p.filename,
          conflictAction: "uniquify",
          saveAs: false,
        }));
      } catch (e) {
        await BridgeAccess.completeDownload(nonce, null);
        throw e;
      }
      if (!(await BridgeAccess.completeDownload(nonce, id))) throw new Error(BridgeAccess.ACCESS_REVOKED((await config()).session));
      // Poll until the download settles; a revoke while polling stops the wait
      // (the revoke itself cancels the download).
      const deadline = Date.now() + (p.timeoutMs || 60000);
      while (Date.now() < deadline) {
        await ck(gen);
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
      // Direct mode: synthetic per-char keydown/input/keyup, run from the worker
      // in chunks so a revoke or a navigation lands between chunks, not after
      // the whole string.
      let v = await validateTab(p.tabId, gen, { allowlist });
      const text = String(p.text ?? "");
      const delay = p.delay || 0;
      if (p.direct) {
        const chars = [...text];
        let typed = 0;
        const doc = v.documentId;
        for (let i = 0; i < chars.length || (i === 0 && !chars.length); i += TYPE_CHUNK) {
          if (i > 0) { v = await validateTab(p.tabId, gen, { allowlist }); if (v.documentId !== doc) throw new Error("target changed"); } // never type the rest into a replacement document
          const out = await directRun(v, __directType, { text: chars.slice(i, i + TYPE_CHUNK).join(""), delay }, gen);
          if (out && out.error) throw new Error(`type: ${out.error}`);
          typed += out && out.typed ? out.typed : 0;
          if (!chars.length) break;
        }
        return { ok: true, typed };
      }
      await dbgAttach(p.tabId, gen, v, reqId);
      const st = await ensureCdpTracking(p.tabId, gen); v.loaderId = st.loaderId;
      for (const ch of text) {
        await dbg(p.tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch }, gen, v);
        await dbg(p.tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: ch }, gen, v);
        if (delay) await new Promise((r) => setTimeout(r, delay));
      }
      return { ok: true, typed: [...text].length };
    }

    case "scroll": {
      // Scroll a tab: to a `selector`, to `top`/`bottom`, or by `dx`/`dy`.
      // pageRun uses chrome.scripting (no banner), falling back to the debugger
      // on special-scheme pages it can't inject into.
      const v = await validateTab(p.tabId, gen, { allowlist });
      const out = await pageRun(v, (o) => {
        if (o.selector) { const el = document.querySelector(o.selector); if (!el) return { error: "selector not found" }; el.scrollIntoView({ block: "center", inline: "center" }); return { ok: true, into: o.selector }; }
        if (o.top) { window.scrollTo(0, 0); return { ok: true, y: 0 }; }
        if (o.bottom) { window.scrollTo(0, document.body.scrollHeight); return { ok: true, y: window.scrollY }; }
        window.scrollBy(o.dx || 0, o.dy || 0); return { ok: true, x: window.scrollX, y: window.scrollY };
      }, { selector: p.selector, dx: p.dx, dy: p.dy, top: !!p.top, bottom: !!p.bottom }, p.direct, gen, allowlist);
      if (out && out.error) throw new Error(`scroll: ${out.error}`);
      return out || { ok: true };
    }

    case "waitFor": {
      // Poll until a `selector` exists or a JS `code` condition is truthy.
      // Code uses CSP-proof debugger eval; selectors go through pageRun (no banner
      // on normal pages, debugger fallback on special-scheme ones). Every tick
      // re-validates the tab (fresh URL: a redirect out of the allowlist stops
      // the poll) and re-checks access.
      const timeout = p.timeoutMs || 10000;
      const poll = p.pollMs || 200;
      const start = Date.now();
      while (Date.now() < start + timeout) {
        const v = await validateTab(p.tabId, gen, { allowlist });
        let ok = false;
        if (p.code) {
          const expr = `(() => { try { return !!(${p.code}); } catch (e) { return false; } })()`;
          if (p.direct) {
            ok = !!(await directEval(v, expr, gen));
          } else {
            await dbgAttach(p.tabId, gen, v, reqId);
            const r = await dbgEval(p.tabId, v, gen, allowlist, { expression: expr, returnByValue: true });
            ok = !!(r.result && r.result.value);
          }
        } else {
          ok = !!(await pageRun(v, (sel) => !!document.querySelector(sel), p.selector || "", p.direct, gen, allowlist));
        }
        if (ok) return { ok: true, waitedMs: Date.now() - start };
        await new Promise((r) => setTimeout(r, poll));
      }
      throw new Error(`waitFor timed out after ${timeout}ms`);
    }

    case "status": {
      const cfg = await config();
      const a = await BridgeAccess.readAccess();
      const out = { version: chrome.runtime.getManifest().version, extensionId: chrome.runtime.id, attachedTabs: [...attached], agentTabs: await BridgeAccess.agentTabIds(),
        indicator: cfg.indicator, idleDetachMs: cfg.idleDetachMs, provisionedBy: cfg.provisionedBy || "manual", session: cfg.session, manualMode: !!cfg.manualMode,
        access: a.exists ? (a.granted ? "granted" : "revoked") : "not_granted", until: a.until, accessGen: a.gen };
      // The projected event buffer: counts while not granted, redacted entries while granted.
      if (p.events === true) out.events = BridgeAccess.projectEvents(await BridgeAccess.events(), { granted: a.granted, allowlist: cfg.allowlist || [] });
      return out;
    }

    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}
