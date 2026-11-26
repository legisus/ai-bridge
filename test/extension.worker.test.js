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

  console.log(failures ? `\n${failures} TEST(S) FAILED` : "\nAll worker tests passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("harness error", e); process.exit(1); });
