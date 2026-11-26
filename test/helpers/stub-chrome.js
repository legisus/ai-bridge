// A stub `chrome` for testing extension/access.js in Node. Every call resolves
// on a later tick so interleavings (a revoke landing during a storage read) are
// real; `pauseNext`/`resume`/`failNext` make specific races deterministic.
"use strict";

function stubChrome() {
  const mem = { session: {}, local: {} };
  const pauses = {}; // `${area}:${op}` -> { promise, resolve }
  const fails = new Set();
  const tick = () => new Promise((r) => setImmediate(r));
  // pre: the call reaches the storage backend (may fail); post: the reply is
  // delivered (may be delayed). A paused `get` therefore returns the value as
  // it was when the call was processed — like Chrome, where a revoke landing
  // while a read is in flight does not change what that read returns.
  const pre = async (area) => {
    await tick();
    if (fails.has(area)) { fails.delete(area); throw new Error(`storage ${area} unavailable`); }
  };
  const post = async (area, op) => {
    const key = `${area}:${op}`;
    const entry = pauses[key];
    if (!entry) return;
    if (entry.skip > 0) { entry.skip--; return; } // let the first N matching calls through
    delete pauses[key];
    await entry.promise;
  };
  const gate = async (area, op) => { await pre(area); await post(area, op); };
  const area = (name) => ({
    get: async (q) => {
      await pre(name);
      const out = {};
      const keys = typeof q === "string" ? [q] : Array.isArray(q) ? q : Object.keys(q || {});
      for (const k of keys) out[k] = k in mem[name] ? JSON.parse(JSON.stringify(mem[name][k])) : (q && typeof q === "object" && !Array.isArray(q) ? q[k] : undefined);
      await post(name, "get");
      return out;
    },
    set: async (o) => { await gate(name, "set"); Object.assign(mem[name], o); },
    remove: async (k) => { await gate(name, "remove"); for (const key of Array.isArray(k) ? k : [k]) delete mem[name][key]; },
    clear: async () => { await gate(name, "clear"); mem[name] = {}; },
  });
  mem.pauseNext = (areaName, op = "get", { skip = 0 } = {}) => {
    let resolve; const promise = new Promise((r) => { resolve = r; });
    pauses[`${areaName}:${op}`] = { promise, resolve, skip };
    mem._resume = resolve;
  };
  mem.resume = () => { if (mem._resume) mem._resume(); mem._resume = null; };
  mem.failNext = (areaName) => fails.add(areaName);

  const removed = [];
  const failIds = new Set(); // ids whose removal fails for a transient reason (tab stays)
  const goneIds = new Set(); // ids Chrome no longer knows ("No tab with id")
  // An event with addListener/removeListener/emit (chrome.* events).
  const event = () => { const fns = new Set(); return { addListener: (f) => fns.add(f), removeListener: (f) => fns.delete(f), hasListener: (f) => fns.has(f), emit: (...a) => { for (const f of [...fns]) f(...a); }, size: () => fns.size }; };
  const tabs = { list: [], captures: [], onCapture: null, getFail: null, onActivated: event(), onUpdated: event(), onRemoved: event() };
  const frames = {};                 // tabId -> { url, documentId } for webNavigation.getFrame
  const injections = [];             // scripting.executeScript / userScripts.execute calls
  const inject = { result: null, hook: null }; // hook(call) may throw or return a result
  const cdp = { sent: [], attached: new Set(), detached: [], attachGate: null, contexts: {}, loaderId: "L1", onSend: null, onEvent: event(), onDetach: event(), failNext: null };
  const downloads = { items: [], cancelled: [], nextId: 1, searchFail: null };
  const alarms = { list: [], failCreate: false, onAlarm: event() };
  const badge = [];
  const runtime = { id: "ext-id", reloads: 0, onMessage: event(), onStartup: event(), onInstalled: event(), messagesToNative: [] };
  const storageChanged = event();
  const windows = { list: [{ id: 1 }], nextId: 2 };

  // Chrome refuses to inject into a document that is gone: emulate documentIds.
  const injectInto = async (api, call) => {
    await tick();
    injections.push({ api, ...call });
    if (inject.hook) { const r = await inject.hook(call, api); if (r !== undefined) return r; }
    const ids = call.target && call.target.documentIds;
    if (ids) {
      const f = frames[call.target.tabId];
      if (!f || !ids.includes(f.documentId)) throw new Error(`Error: No frame with documentId ${ids[0]} in tab ${call.target.tabId}`);
    }
    return [{ result: inject.result }];
  };

  const chrome = {
    storage: { session: area("session"), local: area("local"), onChanged: storageChanged },
    tabs: {
      remove: async (id) => { await tick(); if (goneIds.has(id)) throw new Error(`No tab with id: ${id}.`); if (failIds.has(id)) throw new Error("Tabs cannot be edited right now (user may be dragging a tab)."); removed.push(id); tabs.list = tabs.list.filter((t) => t.id !== id); },
      query: async (q) => { await tick(); return tabs.list.filter((t) => !q || q.windowId === undefined || t.windowId === q.windowId).map((t) => ({ ...t })); },
      get: async (id) => { await tick(); if (tabs.getFail === id) throw new Error("The tab was closed."); const t = tabs.list.find((x) => x.id === id); if (!t) throw new Error(`No tab with id: ${id}.`); return { ...t }; },
      create: async (opts) => { await tick(); const t = { id: tabs.nextId = (tabs.nextId || 1000) + 1, windowId: opts && opts.windowId || 1, url: opts && opts.url, active: !!(opts && opts.active) }; tabs.list.push(t); return { ...t }; },
      update: async (id, props) => { await tick(); const t = tabs.list.find((x) => x.id === id); if (!t) throw new Error(`No tab with id: ${id}.`); Object.assign(t, props); return { ...t }; },
      captureVisibleTab: async (windowId) => { await tick(); if (tabs.onCapture) await tabs.onCapture(windowId); const active = tabs.list.find((t) => t.windowId === windowId && t.active); tabs.captures.push(active ? active.id : null); return `data:image/png;base64,${Buffer.from(`shot-of-${active ? active.id : "none"}`).toString("base64")}`; },
      onActivated: tabs.onActivated, onUpdated: tabs.onUpdated, onRemoved: tabs.onRemoved,
    },
    windows: {
      create: async (opts) => { await tick(); const id = windows.nextId++; windows.list.push({ id }); const t = { id: tabs.nextId = (tabs.nextId || 1000) + 1, windowId: id, url: opts && opts.url, active: true }; tabs.list.push(t); return { id, tabs: [{ ...t }] }; },
      update: async () => { await tick(); return {}; },
    },
    webNavigation: {
      getFrame: async ({ tabId }) => { await tick(); const f = frames[tabId]; if (!f) return null; return { frameId: 0, parentFrameId: -1, url: f.url, documentId: f.documentId }; },
    },
    scripting: { executeScript: (call) => injectInto("scripting", call) },
    userScripts: { execute: (call) => injectInto("userScripts", call) },
    debugger: {
      attach: async ({ tabId }) => { await tick(); if (cdp.attachGate) await cdp.attachGate; cdp.attached.add(tabId); },
      detach: async ({ tabId }) => { await tick(); cdp.attached.delete(tabId); cdp.detached.push(tabId); },
      sendCommand: async ({ tabId }, method, params) => {
        await tick();
        cdp.sent.push({ tabId, method, params });
        if (cdp.failNext === method) { cdp.failNext = null; throw new Error(`${method} failed`); }
        if (cdp.onSend) await cdp.onSend(tabId, method, params);
        if (method === "Page.getFrameTree") { const f = frames[tabId] || { url: "about:blank" }; return { frameTree: { frame: { id: "F0", loaderId: cdp.loaderId, url: f.url } } }; }
        if (method === "Runtime.enable") { for (const c of cdp.contexts[tabId] || []) cdp.onEvent.emit({ tabId }, "Runtime.executionContextCreated", { context: c }); return {}; }
        if (method === "Runtime.evaluate") return { result: { value: `eval:${params && params.uniqueContextId}` } };
        if (method === "Page.captureScreenshot") return { data: "QUJD" };
        return {};
      },
      onEvent: cdp.onEvent, onDetach: cdp.onDetach,
    },
    downloads: {
      download: async (opts) => { await tick(); const id = downloads.nextId++; downloads.items.push({ id, state: "in_progress", byExtensionId: runtime.id, startTime: new Date().toISOString(), url: opts && opts.url }); return id; },
      search: async (q = {}) => {
        await tick();
        if (downloads.searchFail !== null && q.id === downloads.searchFail) throw new Error("downloads unavailable");
        let items = downloads.items.slice();
        if (q.id !== undefined) items = items.filter((i) => i.id === q.id);
        if (q.state) items = items.filter((i) => i.state === q.state);
        if (q.startedAfter) items = items.filter((i) => Date.parse(i.startTime) >= Date.parse(q.startedAfter));
        if (q.orderBy && q.orderBy.includes("-startTime")) items.sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
        return items.map((i) => ({ ...i }));
      },
      cancel: async (id) => { await tick(); downloads.cancelled.push(id); const it = downloads.items.find((i) => i.id === id); if (it) it.state = "interrupted"; },
    },
    alarms: {
      create: async (name, info) => { await tick(); if (alarms.failCreate) throw new Error("alarms unavailable"); alarms.list = alarms.list.filter((a) => a.name !== name); alarms.list.push({ name, scheduledTime: info && info.when }); },
      clear: async (name) => { await tick(); const n = alarms.list.length; alarms.list = alarms.list.filter((a) => a.name !== name); return alarms.list.length !== n; },
      clearAll: async () => { await tick(); alarms.list = []; return true; },
      getAll: async () => { await tick(); return alarms.list.map((a) => ({ ...a })); },
      onAlarm: alarms.onAlarm,
    },
    action: {
      setBadgeText: async (o) => { await tick(); badge.push({ text: o.text }); },
      setBadgeBackgroundColor: async (o) => { await tick(); badge.push({ color: o.color }); },
    },
    runtime: {
      id: runtime.id, reload: () => { runtime.reloads++; }, getManifest: () => ({ version: "test" }),
      onMessage: runtime.onMessage, onStartup: runtime.onStartup, onInstalled: runtime.onInstalled,
      connectNative: () => ({ onMessage: event(), onDisconnect: event(), disconnect() {} }),
      get lastError() { return undefined; },
    },
  };
  return { chrome, mem, removed, failIds, goneIds, tabs, frames, injections, inject, cdp, windows, downloads, alarms, badge, runtime, event };
}

module.exports = { stubChrome };
