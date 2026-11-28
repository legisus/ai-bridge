#!/usr/bin/env node
// The real service worker under a stub Chrome: target binding races the
// source-level assertions cannot see. Each case is a scenario Astra reproduced
// on the first target-guard review.
const { stubChrome } = require("./helpers/stub-chrome");
const { loadWorker } = require("./helpers/load-worker");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msgOf = (p) => p.then(() => null, (e) => String(e && e.message || e));

async function fresh({ allowlist = [] } = {}) {
  const S = stubChrome();
  const W = loadWorker(S);
  await W.initDone;
  await S.chrome.storage.local.set({ allowlist, token: "", indicator: true });
  await W.BridgeAccess.setAccess({ granted: true });
  S.tabs.list = [{ id: 1, windowId: 1, active: true, url: "https://ok.example/x", title: "ok" }, { id: 2, windowId: 1, active: false, url: "https://other.example/", title: "other" }];
  S.frames[1] = { url: "https://ok.example/x", documentId: "doc-ok-1" };
  S.frames[2] = { url: "https://other.example/", documentId: "doc-other" };
  S.cdp.contexts[1] = [{ uniqueId: "ctx-ok", origin: "https://ok.example", auxData: { frameId: "F0", isDefault: true } }];
  return { S, W, gen: W.BridgeAccess.currentGen() };
}

(async () => {
  // (1) the URL and the documentId come from the same frame read; no document → no injection
  {
    const { S, W, gen } = await fresh({ allowlist: ["ok.example"] });
    S.frames[1] = { url: "https://secret.example/", documentId: "doc-secret" }; // the tab navigated between tabs.get and getFrame
    const err = await msgOf(W.handle("eval", { tabId: 1, code: "1", direct: true }, gen, "r1"));
    assert(err === 'host "secret.example" not in allowlist' && S.injections.length === 0, "validateTab judges the URL of the document it binds to (frame read), not a stale tabs.get URL");
    delete S.frames[1];
    const err2 = await msgOf(W.handle("eval", { tabId: 1, code: "1", direct: true }, gen, "r2"));
    assert(err2 === "target changed" && S.injections.length === 0, "no documentId → no injection (never falls back to a bare tabId target)");
    S.frames[1] = { url: "https://ok.example/x", documentId: "doc-ok-1" };
    S.inject.result = 7;
    assert((await W.handle("eval", { tabId: 1, code: "1", direct: true }, gen, "r3")) === 7 && S.injections[0].target.documentIds[0] === "doc-ok-1", "a validated document is injected by documentId");
  }
  // (2) a direct screenshot never returns another tab's image
  {
    const { S, W, gen } = await fresh();
    S.mem.pauseNext("local", "get", { skip: 1 }); // the access read inside validateTab parks; tabs.get already answered active:true
    const p = W.handle("screenshot", { tabId: 1, direct: true }, gen, "r4");
    await sleep(5);
    S.tabs.list[0].active = false; S.tabs.list[1].active = true;      // the user switched tabs in that window…
    S.chrome.tabs.onActivated.emit({ tabId: 2, windowId: 1 });           // …before any listener could see it
    S.mem.resume();
    const err = await msgOf(p);
    assert(err === "target changed" || /must be active/.test(err), `screenshot after an activation during validation is refused (${err})`);
    assert(!S.tabs.captures.includes(2) || err === "target changed", "no foreign image is returned");
    // and a capture whose tab is no longer active right before the shot is refused too
    S.tabs.list[0].active = true; S.tabs.list[1].active = false;
    S.tabs.onCapture = async () => { S.tabs.list[0].active = false; S.tabs.list[1].active = true; S.chrome.tabs.onActivated.emit({ tabId: 2, windowId: 1 }); };
    const err2 = await msgOf(W.handle("screenshot", { tabId: 1, direct: true }, gen, "r5"));
    assert(err2 === "target changed", "an activation during the capture itself discards the image");
    S.tabs.onCapture = null;
    S.tabs.list[0].active = true; S.tabs.list[1].active = false;
    const shot = await W.handle("screenshot", { tabId: 1, direct: true }, gen, "r6");
    assert(Buffer.from(shot.base64, "base64").toString() === "shot-of-1", "an undisturbed capture returns the validated tab's image");
  }
  // (3) the loader check is in the same synchronous step as the CDP send
  {
    const { S, W, gen } = await fresh();
    // insertText: validate, attach, track; park the access read inside dbg() and navigate the frame meanwhile
    let armed = false;
    S.cdp.onSend = async (tabId, method) => {
      if (method === "Runtime.enable" && !armed) {
        armed = true;
        S.mem.pauseNext("local", "get"); // the next access read is the one inside dbg() before Input.insertText
        setTimeout(() => {
          S.chrome.debugger.onEvent.emit({ tabId: 1 }, "Page.frameNavigated", { frame: { id: "F0", loaderId: "L2", url: "https://evil.example/" } });
          S.mem.resume();
        }, 10);
      }
    };
    const err = await msgOf(W.handle("insertText", { tabId: 1, text: "hi", direct: false }, gen, "r7"));
    assert(err === "target changed" && !S.cdp.sent.some((c) => c.method === "Input.insertText"), "a navigation during the access read before Input.insertText stops the send (loader check inside dispatch)");
    S.cdp.onSend = null;
  }
  // (4) indicator injections are bound to the validated document
  {
    const { S, W, gen } = await fresh();
    await W.handle("eval", { tabId: 1, code: "1", direct: false }, gen, "r8");
    const indicator = S.injections.filter((i) => i.api === "scripting" && i.args && typeof i.args[0] === "boolean");
    assert(indicator.length >= 1 && indicator.every((i) => i.target.documentIds && i.target.documentIds[0] === "doc-ok-1"), "setIndicator injects into the validated document only");
  }
  // (5) a forbidden navigation during an attach in flight ends with the tab detached and the command failed
  {
    const { S, W, gen } = await fresh();
    let release; S.cdp.attachGate = new Promise((r) => { release = r; });
    const p = W.handle("eval", { tabId: 1, code: "1", direct: false }, gen, "r9");
    await sleep(10);
    S.frames[1] = { url: "chrome://version/", documentId: "doc-chrome" };
    S.tabs.list[0].url = "chrome://version/";
    S.chrome.tabs.onUpdated.emit(1, { url: "chrome://version/" });
    await sleep(5);
    release(); S.cdp.attachGate = null;
    const err = await msgOf(p);
    assert(err === "target changed" && S.cdp.detached.includes(1) && !S.cdp.attached.has(1), `attach completing after a forbidden navigation is detached and the command fails (${err})`);
    assert(!S.injections.some((i) => i.api === "scripting" && i.args && i.args[0] === true), "no indicator is installed on the forbidden page");
  }
  // (6) CDP tracking initialises once, concurrent callers wait, a failed init is retried
  {
    const { S, W, gen } = await fresh();
    S.cdp.failNext = "Page.enable";
    const err = await msgOf(W.handle("eval", { tabId: 1, code: "1", direct: false }, gen, "r10"));
    assert(/Page\.enable failed/.test(err), "a failed CDP init fails the command");
    const [a, b] = await Promise.all([W.handle("eval", { tabId: 1, code: "1", direct: false }, gen, "r11"), W.handle("eval", { tabId: 1, code: "2", direct: false }, gen, "r12")]);
    assert(a === "eval:ctx-ok" && b === "eval:ctx-ok" && S.cdp.sent.filter((c) => c.method === "Page.enable").length === 2, "concurrent commands share one initialisation and both evaluate in the validated context");
  }
  // (7) chunked typing stops when the document changes mid-string
  {
    const { S, W, gen } = await fresh();
    S.inject.hook = async (call) => { if (S.injections.length === 1) S.frames[1] = { url: "https://ok.example/other", documentId: "doc-ok-2" }; return [{ result: { ok: true, typed: (call.args[0].text || "").length } }]; };
    const err = await msgOf(W.handle("type", { tabId: 1, text: "a".repeat(21), direct: true }, gen, "r13"));
    assert(err === "target changed" && S.injections.length === 1, "the second chunk is not typed into a replacement document");
    S.inject.hook = null;
  }
  // (8) events of a command carry its request id
  {
    const { S, W, gen } = await fresh();
    await W.BridgeAccess.clearEvents();
    await W.handle("newTab", { url: "https://ok.example/new" }, gen, "req-new");
    await W.handle("eval", { tabId: 1, code: "1", direct: false }, gen, "req-eval");
    const ev = await W.BridgeAccess.events();
    assert(ev.some((e) => e.kind === "tab_opened" && e.reqId === "req-new"), "tab_opened carries the newTab request id");
    assert(ev.some((e) => e.kind === "attach" && e.reqId === "req-eval"), "attach carries the command's request id");
    void S;
  }

  // (9) auto-grant: a fresh worker is granted without a click; install/update keeps it; token change recovers
  {
    const S = stubChrome(); const W = loadWorker(S); await W.initDone;
    const a = await W.BridgeAccess.readAccess();
    assert(a.granted === true && a.until === null, "fresh worker with autoGrant ON starts granted");
    S.chrome.runtime.onInstalled.emit({ reason: "update" }); await sleep(30);
    assert((await W.BridgeAccess.readAccess()).granted === true && (await W.BridgeAccess.notices()).length === 0, "onInstalled keeps access and shows no reload notice");
    const g0 = W.BridgeAccess.currentGen();
    S.chrome.storage.onChanged.emit({ token: { oldValue: "a", newValue: "b" } }, "local"); await sleep(60);
    const after = await W.BridgeAccess.readAccess();
    assert(after.granted === true && W.BridgeAccess.currentGen() > g0, "a token change revokes (new generation) and auto-grant restores access");
    // manual access-set is refused while auto-grant is on
    let reply = null;
    S.chrome.runtime.onMessage.emit({ type: "access-set", granted: false }, { id: "ext-id", url: "chrome-extension://ext-id/popup.html" }, (r) => { reply = r; });
    await sleep(30);
    assert(reply && reply.ok === false && /auto-grant is on/.test(reply.error) && (await W.BridgeAccess.readAccess()).granted === true, "access-set is refused while auto-grant is on");
    // turning it off via storage revokes; manual works again
    await S.chrome.storage.local.set({ autoGrant: false });
    S.chrome.storage.onChanged.emit({ autoGrant: { oldValue: true, newValue: false } }, "local"); await sleep(60);
    assert((await W.BridgeAccess.readAccess()).granted === false, "autoGrant OFF revokes");
  }
  // (10) reloadExtension waits for pending creations and refuses when cleanup is incomplete
  {
    const { S, W, gen } = await fresh();
    S.failIds.add(1001); // the agent tab cannot be closed
    const t = await W.handle("newTab", { url: "https://ok.example/a" }, gen, "r20");
    S.tabs.list.push({ id: t.id, windowId: 1, active: false, url: "https://ok.example/a" }); S.frames[t.id] = { url: "https://ok.example/a", documentId: "d-a" };
    S.failIds.add(t.id);
    const err = await msgOf(W.handle("reloadExtension", {}, W.BridgeAccess.currentGen(), "r21"));
    assert(/reload refused: cleanup incomplete/.test(err) && S.runtime.reloads === 0, "reloadExtension refuses when an agent tab could not be closed");
    S.failIds.delete(t.id);
    const ok = await W.handle("reloadExtension", {}, W.BridgeAccess.currentGen(), "r22");
    await sleep(80);
    assert(ok && ok.reloading === true && S.runtime.reloads === 1 && S.removed.includes(t.id), "reloadExtension closes the agent tab, then reloads");
  }

  // (11) reload refuses when cleanup cannot be verified, and when creations do not drain
  {
    const { S, W, gen } = await fresh();
    const t = await W.handle("newTab", { url: "https://ok.example/a" }, gen, "r30");
    S.tabs.list.push({ id: t.id, windowId: 1, active: false, url: "https://ok.example/a" });
    S.tabs.getFail = t.id; // tabs.get throws something other than "No tab with id" for this tab
    S.failIds.add(t.id);
    let err = await msgOf(W.handle("reloadExtension", {}, W.BridgeAccess.currentGen(), "r31"));
    assert(/reload refused/.test(err) && S.runtime.reloads === 0, "a tab whose verification lookup fails counts as not cleaned");
    S.tabs.getFail = null; S.failIds.delete(t.id);
    await S.chrome.storage.local.set({ bridgeDownloads: { 91: { gen: 1 } } });
    S.downloads.items.push({ id: 91, state: "in_progress", byExtensionId: "ext-id", startTime: new Date().toISOString() });
    S.downloads.searchFail = 91;
    err = await msgOf(W.handle("reloadExtension", {}, W.BridgeAccess.currentGen(), "r32"));
    assert(/reload refused/.test(err) && S.runtime.reloads === 0 && (await S.chrome.storage.local.get("bridgeDownloads")).bridgeDownloads[91], "a download whose lookup fails blocks the reload and stays owned");
    S.downloads.searchFail = null; S.downloads.items = S.downloads.items.filter((d) => d.id !== 91); await S.chrome.storage.local.set({ bridgeDownloads: {} });
    // a creation that never completes: the drain times out and the reload is refused
    await S.chrome.storage.session.set({ pendingTabs: [{ nonce: "stuck", gen: W.BridgeAccess.currentGen(), origin: "o", startedAt: Date.now() }] });
    W.__reloadDrainMs = 300;
    err = await msgOf(W.handle("reloadExtension", {}, W.BridgeAccess.currentGen(), "r33"));
    assert(/reload refused/.test(err) && /pending/.test(err) && S.runtime.reloads === 0, "pending creations that do not drain refuse the reload");
    await S.chrome.storage.session.set({ pendingTabs: [] });
    assert((await W.BridgeAccess.readAccess()).granted === true, "after a refused reload access is back (auto-grant)");
  }
  // (12) saving Auto-grant together with a token change still replaces the socket and reconnects
  {
    const S = stubChrome(); const W = loadWorker(S); await W.initDone;
    await S.chrome.storage.local.set({ token: "b", port: 8765 }); // a provisioned extension: connect() opens a socket
    const before = W.__sockets.length;
    S.chrome.storage.onChanged.emit({ token: { oldValue: "a", newValue: "b" }, autoGrant: { oldValue: true, newValue: true } }, "local"); await sleep(80);
    assert(W.__sockets.length > before && (await W.BridgeAccess.readAccess()).granted === true, "token change in the same save as the policy: revoke, reconcile, reconnect");
    // an unreadable policy refuses manual grants (fail closed)
    let reply = null;
    S.mem.failNext("local");
    S.chrome.runtime.onMessage.emit({ type: "access-set", granted: true, until: null }, { id: "ext-id", url: "chrome-extension://ext-id/popup.html" }, (r) => { reply = r; });
    await sleep(30);
    assert(reply && reply.ok === false, "manual access-set is refused when the policy cannot be read");
  }

  // (docker-chrome 1) newTab {incognito:true}: its own incognito window, owned like any agent tab
  {
    const { S, W, gen } = await fresh({ allowlist: ["ok.example"] });
    S.windows.incognitoAllowed = true;
    const t = await W.handle("newTab", { url: "https://ok.example/priv", incognito: true }, gen, "ri1");
    const made = S.windows.created[S.windows.created.length - 1];
    assert(made && made.incognito === true && made.url === "https://ok.example/priv" && made.focused === false, "newTab incognito: chrome.windows.create({incognito:true}), unfocused");
    assert(t.incognito === true && t.newWindow === true && typeof t.id === "number" && t.windowId === S.windows.list[S.windows.list.length - 1].id, "newTab incognito: result carries id, windowId, newWindow, incognito");
    assert((await W.BridgeAccess.agentTabIds()).includes(t.id), "newTab incognito: the tab is registered as an agent tab");
    S.frames[t.id] = { url: "https://ok.example/priv", documentId: "d-priv" };
    const rows = await W.handle("listTabs", {}, gen, "ri2");
    const row = rows.find((r) => r.id === t.id);
    assert(row && row.incognito === true && row.agent === true && rows.filter((r) => r.incognito).length === 1, "listTabs marks only the incognito tab with incognito:true");
    // an ordinary newTab while an incognito window exists goes to a REGULAR window, by id
    const plain = await W.handle("newTab", { url: "https://ok.example/a" }, gen, "ri2b");
    const opts = S.tabs.created[S.tabs.created.length - 1];
    assert(opts.windowId === 1 && !("incognito" in plain) && plain.windowId === 1, "with incognito access on, an ordinary newTab names a regular window (never 'the current window')");
    const own = await W.handle("newTab", { url: "https://ok.example/w", newWindow: true }, gen, "ri2c");
    assert(S.windows.created[S.windows.created.length - 1].incognito === false && !("incognito" in own), "newWindow asks for a regular window explicitly when incognito windows are visible");
    // an explicit windowId that IS an incognito window: allowed, and the result says what the tab is
    const into = await W.handle("newTab", { url: "https://ok.example/b", windowId: t.windowId }, gen, "ri2d");
    assert(into.incognito === true && into.windowId === t.windowId, "a tab opened into an incognito window by windowId is reported as incognito");
    assert(/cannot be combined with windowId/.test(await msgOf(W.handle("newTab", { url: "https://ok.example/c", incognito: true, windowId: 1 }, gen, "ri2e"))), "incognito + windowId is refused");
    await W.handle("closeTab", { tabId: t.id }, gen, "ri3");
    assert(S.removed.includes(t.id) && !(await W.BridgeAccess.agentTabIds()).includes(t.id), "closeTab closes the incognito agent tab");
    // only incognito windows left: an ordinary newTab gets a regular window of its own
    S.windows.list = S.windows.list.filter((w) => w.incognito);
    const alone = await W.handle("newTab", { url: "https://ok.example/d" }, gen, "ri3b");
    assert(alone.newWindow === true && !("incognito" in alone) && S.windows.created[S.windows.created.length - 1].incognito === false, "no regular window open: an ordinary newTab opens a regular window, not an incognito tab");
  }
  // (docker-chrome 2) not allowed in incognito / the query fails: refused before any window exists, nothing left pending
  {
    const { S, W, gen } = await fresh({ allowlist: ["ok.example"] });
    const pending = async () => ((await S.chrome.storage.session.get("pendingTabs")).pendingTabs || []).length;
    let err = await msgOf(W.handle("newTab", { url: "https://ok.example/priv", incognito: true }, gen, "ri4"));
    assert(/^incognito not allowed/.test(err || "") && S.windows.created.length === 0, "newTab incognito is refused when the extension is not allowed in incognito (no window is created)");
    assert((await W.BridgeAccess.agentTabIds()).length === 0 && (await pending()) === 0, "a refused incognito newTab leaves no agent tab and no pending creation");
    S.windows.onIncognitoQuery = () => { throw new Error("boom"); };
    err = await msgOf(W.handle("newTab", { url: "https://ok.example/priv", incognito: true }, gen, "ri4b"));
    assert(/^incognito not allowed: Chrome did not answer/.test(err || "") && S.windows.created.length === 0 && (await pending()) === 0, "a failed permission query refuses an incognito newTab (fail closed, pending released)");
    // an unknown permission state must not weaken "ordinary tabs go to a regular window":
    // the window is named from the window list, independently of the failed query
    S.windows.list.push({ id: 77, incognito: true, focused: true });
    const plain = await W.handle("newTab", { url: "https://ok.example/a" }, gen, "ri4c");
    assert(typeof plain.id === "number" && S.tabs.created[S.tabs.created.length - 1].windowId === 1 && !("incognito" in plain), "permission query failed: an ordinary newTab still names a regular window");
    const own = await W.handle("newTab", { url: "https://ok.example/a", newWindow: true }, gen, "ri4d");
    assert(S.windows.created[S.windows.created.length - 1].incognito === false && own.newWindow === true, "permission query failed: newWindow asks for a regular window explicitly");
    S.windows.getAllFail = true;
    const alone = await W.handle("newTab", { url: "https://ok.example/a" }, gen, "ri4e");
    assert(alone.newWindow === true && S.windows.created[S.windows.created.length - 1].incognito === false, "permission query AND window list failed: a regular window of its own, never 'the current window'");
    S.windows.getAllFail = false; S.windows.list = S.windows.list.filter((w) => w.id !== 77);
    S.windows.onIncognitoQuery = null;
    const n0 = S.windows.created.length;
    // the destination rules come first, incognito or not
    assert((await msgOf(W.handle("newTab", { url: "chrome://settings", incognito: true }, gen, "ri6"))) === "privileged target refused" && S.windows.created.length === n0, "newTab incognito: privileged target refused");
    assert(/not in allowlist/.test(await msgOf(W.handle("newTab", { url: "https://other.example/", incognito: true }, gen, "ri7"))) && S.windows.created.length === n0, "newTab incognito: allowlist applies");
    assert((await pending()) === 0, "refused destinations never write a pending entry");
  }
  // (docker-chrome 3) revoke and failure interleavings of an incognito creation
  {
    const { S, W, gen } = await fresh({ allowlist: ["ok.example"] });
    S.windows.incognitoAllowed = true;
    await S.chrome.storage.local.set({ autoGrant: false }); await sleep(40);
    await W.BridgeAccess.setAccess({ granted: true });
    let g = W.BridgeAccess.currentGen();
    const pending = async () => ((await S.chrome.storage.session.get("pendingTabs")).pendingTabs || []).length;
    // (a) revoked while Chrome answers the permission query: no window
    S.windows.onIncognitoQuery = async () => { S.windows.onIncognitoQuery = null; await W.BridgeAccess.setAccess({ granted: false, source: "test" }); };
    let err = await msgOf(W.handle("newTab", { url: "https://ok.example/p", incognito: true }, g, "rj1"));
    assert(/access/i.test(err || "") && S.windows.created.length === 0 && (await pending()) === 0, "revoke during the incognito permission query: refused, no window, pending released");
    // (b) revoked while Chrome creates the window: the late tab is closed, not returned, not owned
    await W.BridgeAccess.setAccess({ granted: true }); g = W.BridgeAccess.currentGen();
    S.windows.onCreate = async () => { S.windows.onCreate = null; await W.BridgeAccess.setAccess({ granted: false, source: "test" }); };
    err = await msgOf(W.handle("newTab", { url: "https://ok.example/p", incognito: true }, g, "rj2"));
    const lateId = S.tabs.nextId;
    assert(/access/i.test(err || "") && S.windows.created.length === 1 && S.removed.includes(lateId) && !(await W.BridgeAccess.agentTabIds()).includes(lateId) && (await pending()) === 0, "revoke during incognito window creation: the late tab is closed and dropped");
    // (c) same, but the late tab cannot be closed: ownership is kept for the reload/cleanup verification
    await W.BridgeAccess.setAccess({ granted: true }); g = W.BridgeAccess.currentGen();
    S.windows.onCreate = async () => { S.windows.onCreate = null; S.failIds.add((S.tabs.nextId || 1000) + 1); await W.BridgeAccess.setAccess({ granted: false, source: "test" }); };
    err = await msgOf(W.handle("newTab", { url: "https://ok.example/p", incognito: true }, g, "rj3"));
    const stuck = S.tabs.nextId;
    assert(/access/i.test(err || "") && (await W.BridgeAccess.agentTabIds()).includes(stuck), "a late incognito tab that cannot be closed stays owned (cleanup can still find it)");
    S.failIds.delete(stuck);
    // (d) Chrome fails to create the window: error, pending released, nothing owned
    await W.BridgeAccess.setAccess({ granted: true }); g = W.BridgeAccess.currentGen();
    const ownedBefore = (await W.BridgeAccess.agentTabIds()).length;
    S.windows.onCreate = async () => { S.windows.onCreate = null; throw new Error("Incognito mode is disabled."); };
    err = await msgOf(W.handle("newTab", { url: "https://ok.example/p", incognito: true }, g, "rj4"));
    assert(err === "Incognito mode is disabled." && (await pending()) === 0 && (await W.BridgeAccess.agentTabIds()).length === ownedBefore, "incognito creation failure: the error is passed on, pending released");
    // (e) the created window comes back without its tab, or with someone else's: not owned, not closed
    for (const [name, tabsOf] of [["no tab", () => []], ["a non-incognito tab", (t) => [{ ...t, incognito: false }]], ["two tabs", (t) => [{ ...t }, { ...t, id: t.id + 500 }]]]) {
      S.windows.tabsOf = tabsOf;
      const removedBefore = S.removed.length;
      err = await msgOf(W.handle("newTab", { url: "https://ok.example/p", incognito: true }, g, "rj5"));
      assert(/could not be identified/.test(err || "") && (await pending()) === 0 && (await W.BridgeAccess.agentTabIds()).length === ownedBefore && S.removed.length === removedBefore, `incognito window reported with ${name}: no ownership taken, nothing closed, pending released`);
    }
    S.windows.tabsOf = null;
    const evs = ((await W.handle("status", { events: true }, g, "rj6")).events || {}).events || [];
    assert(evs.some((e) => e.kind === "refused" && e.reqId === "rj5" && e.detail && e.detail.reason === "tab_unidentified"), "an unidentified incognito window is recorded in the event log");
    // (f) a creation still pending blocks reloadExtension (the drain), incognito like any other
    let release; S.windows.onCreate = () => new Promise((r) => { release = r; });
    const slow = W.handle("newTab", { url: "https://ok.example/p", incognito: true }, g, "rj7");
    await sleep(40);
    W.__reloadDrainMs = 200;
    err = await msgOf(W.handle("reloadExtension", {}, W.BridgeAccess.currentGen(), "rj8"));
    assert(/reload refused/.test(err || "") && S.runtime.reloads === 0, "reloadExtension is refused while an incognito creation is pending");
    S.windows.onCreate = null; release(); await slow.catch(() => {});
    // a plain new window without a tab no longer throws a TypeError outside the cleanup path
    S.windows.incognitoAllowed = false;
    await W.BridgeAccess.setAccess({ granted: true }); g = W.BridgeAccess.currentGen();
    // an ORDINARY new window is identified the same way: only the one tab Chrome reports for it.
    // (Before: a missing tab fell back to tabs.query and could claim — and later close — a foreign tab.)
    S.tabs.list.push({ id: 777, windowId: 1, active: false, url: "https://user.example/" });
    const realQuery = S.chrome.tabs.query; let queried = 0; S.chrome.tabs.query = async (q) => { if (q && q.windowId !== undefined) queried++; return [{ id: 777, windowId: q && q.windowId }]; };
    for (const [name, tabsOf] of [["no tab", () => []], ["two tabs", (t) => [{ ...t }, { id: 777, windowId: t.windowId }]], ["an incognito tab", (t) => [{ ...t, incognito: true }]]]) {
      S.windows.tabsOf = tabsOf;
      const removedBefore = S.removed.length, owned = (await W.BridgeAccess.agentTabIds()).length;
      err = await msgOf(W.handle("newTab", { url: "https://ok.example/w", newWindow: true }, g, "rj9"));
      assert(/^window opened but its tab could not be identified/.test(err || "") && (await pending()) === 0 && (await W.BridgeAccess.agentTabIds()).length === owned && !(await W.BridgeAccess.agentTabIds()).includes(777) && S.removed.length === removedBefore && queried === 0, `newWindow reported with ${name}: no tabs.query guess, no ownership (the user's tab 777 is never claimed), pending released`);
    }
    S.chrome.tabs.query = realQuery; S.windows.tabsOf = null;
    assert(/newWindow opens its own window and cannot be combined with windowId/.test(await msgOf(W.handle("newTab", { url: "https://ok.example/w", newWindow: true, windowId: 1 }, g, "rj10"))) && (await pending()) === 0, "newWindow + windowId is refused (before anything is pending)");
  }
  // (docker-chrome 3b) a timed grant that EXPIRES while an incognito tab is being created (no revoke, no alarm)
  {
    const { S, W } = await fresh({ allowlist: ["ok.example"] });
    S.windows.incognitoAllowed = true;
    await S.chrome.storage.local.set({ autoGrant: false }); await sleep(40);
    S.alarms.failCreate = false;
    const pending = async () => ((await S.chrome.storage.session.get("pendingTabs")).pendingTabs || []).length;
    const timed = async (ms) => { await W.BridgeAccess.setAccess({ granted: true, until: Date.now() + ms }); return W.BridgeAccess.currentGen(); };
    // (a) the deadline passes while Chrome answers the permission query
    let g = await timed(60);
    S.windows.onIncognitoQuery = async () => { S.windows.onIncognitoQuery = null; await sleep(120); };
    let err = await msgOf(W.handle("newTab", { url: "https://ok.example/p", incognito: true }, g, "rx1"));
    assert(/access/i.test(err || "") && S.windows.created.length === 0 && (await pending()) === 0, "grant expires during the incognito permission query: refused at dispatch, no window, pending released");
    // (b) the deadline passes while Chrome creates the window: the tab that comes back is closed, not returned
    g = await timed(60);
    S.windows.onCreate = async () => { S.windows.onCreate = null; await sleep(120); };
    err = await msgOf(W.handle("newTab", { url: "https://ok.example/p", incognito: true }, g, "rx2"));
    const late = S.tabs.nextId;
    assert(/access/i.test(err || "") && S.windows.created.length === 1 && S.removed.includes(late) && !(await W.BridgeAccess.agentTabIds()).includes(late) && (await pending()) === 0, "grant expires during incognito window creation: the late tab is closed and dropped");
  }
  // (docker-chrome 4) the extension without incognito access behaves exactly as before
  {
    const { S, W, gen } = await fresh({ allowlist: ["ok.example"] });
    const plain = await W.handle("newTab", { url: "https://ok.example/a" }, gen, "rk1");
    const opts = S.tabs.created[S.tabs.created.length - 1];
    assert(JSON.stringify(Object.keys(plain)) === '["id","windowId"]' && !("windowId" in opts) && S.windows.created.length === 0, "incognito access off: newTab is a background tab in the current window, same result shape");
    const win = await W.handle("newTab", { url: "https://ok.example/a", newWindow: true }, gen, "rk2");
    assert(JSON.stringify(Object.keys(win)) === '["id","windowId","newWindow"]' && !("incognito" in S.windows.created[0]), "incognito access off: newWindow passes no incognito option, same result shape");
    const manifest = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", "extension", "manifest.json"), "utf8"));
    assert(manifest.incognito === undefined || manifest.incognito === "spanning", "the manifest keeps the spanning incognito mode (one worker, one relay connection)");
  }

  console.log(failures ? `\n${failures} TEST(S) FAILED` : "\nAll worker tests passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("harness error", e); process.exit(1); });
