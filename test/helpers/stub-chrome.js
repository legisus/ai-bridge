// A stub `chrome` for testing extension/access.js in Node. Every call resolves
// on a later tick so interleavings (a revoke landing during a storage read) are
// real; `pauseNext`/`resume`/`failNext` make specific races deterministic.
"use strict";

function stubChrome() {
  const mem = { session: {}, local: {} };
  const pauses = {}; // `${area}:${op}` -> { promise, resolve }
  const fails = new Set();
  const tick = () => new Promise((r) => setImmediate(r));
  const gate = async (area, op) => {
    await tick();
    if (fails.has(area)) { fails.delete(area); throw new Error(`storage ${area} unavailable`); }
    const key = `${area}:${op}`;
    if (pauses[key]) { const p = pauses[key].promise; delete pauses[key]; await p; }
  };
  const area = (name) => ({
    get: async (q) => {
      await gate(name, "get");
      const out = {};
      const keys = typeof q === "string" ? [q] : Array.isArray(q) ? q : Object.keys(q || {});
      for (const k of keys) out[k] = k in mem[name] ? mem[name][k] : (q && typeof q === "object" && !Array.isArray(q) ? q[k] : undefined);
      return out;
    },
    set: async (o) => { await gate(name, "set"); Object.assign(mem[name], o); },
    remove: async (k) => { await gate(name, "remove"); for (const key of Array.isArray(k) ? k : [k]) delete mem[name][key]; },
    clear: async () => { await gate(name, "clear"); mem[name] = {}; },
  });
  mem.pauseNext = (areaName, op = "get") => {
    let resolve; const promise = new Promise((r) => { resolve = r; });
    pauses[`${areaName}:${op}`] = { promise, resolve };
    mem._resume = resolve;
  };
  mem.resume = () => { if (mem._resume) mem._resume(); mem._resume = null; };
  mem.failNext = (areaName) => fails.add(areaName);

  const removed = [];
  const failIds = new Set();
  const tabs = { list: [] };
  const downloads = { items: [], cancelled: [], nextId: 1 };
  const alarms = { list: [], failCreate: false };
  const badge = [];
  const runtime = { id: "ext-id", reloads: 0 };

  const chrome = {
    storage: { session: area("session"), local: area("local") },
    tabs: {
      remove: async (id) => { await tick(); if (failIds.has(id)) throw new Error("No tab with id"); removed.push(id); tabs.list = tabs.list.filter((t) => t.id !== id); },
      query: async () => { await tick(); return tabs.list.map((t) => ({ ...t })); },
      create: async (opts) => { await tick(); const t = { id: tabs.nextId = (tabs.nextId || 1000) + 1, windowId: 1, url: opts && opts.url }; tabs.list.push(t); return t; },
    },
    downloads: {
      download: async (opts) => { await tick(); const id = downloads.nextId++; downloads.items.push({ id, state: "in_progress", byExtensionId: runtime.id, startTime: new Date().toISOString(), url: opts && opts.url }); return id; },
      search: async (q = {}) => {
        await tick();
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
    },
    action: {
      setBadgeText: async (o) => { await tick(); badge.push({ text: o.text }); },
      setBadgeBackgroundColor: async (o) => { await tick(); badge.push({ color: o.color }); },
    },
    runtime: { id: runtime.id, reload: () => { runtime.reloads++; } },
  };
  return { chrome, mem, removed, failIds, tabs, downloads, alarms, badge, runtime };
}

module.exports = { stubChrome };
