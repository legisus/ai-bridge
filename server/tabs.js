// Registry of the tabs the bridge opened (design: docs/superpowers/specs/
// 2026-11-21-docker-isolated-access-design.md, "Tab hygiene").
//
// One row per tab created through `newTab`, persisted in
// AI_BRIDGE_HOME/tabs.json so a relay restart does not forget them. Rows are
// bound to the Chrome session that created them (`browserSession`, sent by
// the extension in every `access` message): Chrome tab ids are unique only
// within one browser session, so a row from an earlier session is "dead" —
// listed, never acted on, pruned on the next reconciliation. The server keeps
// `lastCmdAt` itself (it sees every command that names a tab), so
// `bridge closeTabs --older-than` does not depend on the worker's memory.
"use strict";

const fs = require("fs");
const { atomicWrite } = require("./atomic");

const isInt = (v) => Number.isInteger(v);

function openRegistry(file, { log = console.error } = {}) {
  let browserSession = null;
  let pending = []; // { reqId, runId, client, origin, createdAt, browserSession }
  let tabs = [];    // { tabId, browserSession, runId, client, origin, createdAt, lastCmdAt, reqId, status, late? }

  // ---- load / save ---------------------------------------------------------
  try {
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || !Array.isArray(data.tabs) || !Array.isArray(data.pending)) throw new Error("bad shape");
    browserSession = typeof data.browserSession === "string" ? data.browserSession : null;
    pending = data.pending.filter((p) => p && typeof p.reqId === "string");
    tabs = data.tabs.filter((t) => t && isInt(t.tabId) && typeof t.browserSession === "string");
  } catch (e) {
    if (e.code !== "ENOENT") {
      const aside = `${file}.corrupt-${Date.now()}`;
      try { fs.renameSync(file, aside); } catch {}
      log(`tabs.json unreadable, starting empty (kept as ${aside}): ${e.message}`);
    }
  }
  function save() {
    atomicWrite(file, JSON.stringify({ version: 1, browserSession, pending, tabs }, null, 1));
  }

  const current = () => tabs.filter((t) => t.browserSession === browserSession);
  const liveRow = (tabId) => current().find((t) => t.tabId === tabId);

  const registry = {
    get browserSession() { return browserSession; },
    setBrowserSession(id) { browserSession = id; save(); },

    // ---- creations ---------------------------------------------------------
    addPending(p) {
      pending.push({ reqId: String(p.reqId), runId: p.runId || null, client: String(p.client || "cli"), origin: String(p.origin || "unknown"),
        createdAt: p.createdAt || Date.now(), browserSession: p.browserSession || browserSession });
      save();
    },
    completePending(reqId, tabId) {
      const i = pending.findIndex((p) => p.reqId === reqId);
      if (i < 0 || !isInt(tabId)) return null;
      const [p] = pending.splice(i, 1);
      const row = { tabId, browserSession: p.browserSession, runId: p.runId, client: p.client, origin: p.origin,
        createdAt: p.createdAt, lastCmdAt: p.createdAt, reqId: p.reqId, status: "live" };
      tabs = tabs.filter((t) => !(t.tabId === tabId && t.browserSession === row.browserSession)); // a reused id replaces the stale row
      tabs.push(row);
      save();
      return row;
    },
    dropPending(reqId) {
      const n = pending.length;
      pending = pending.filter((p) => p.reqId !== reqId);
      if (pending.length !== n) save();
    },
    pendingForRun(runId) { return pending.filter((p) => p.runId === runId).length; },

    // ---- activity / removal -------------------------------------------------
    touch(tabId, at = Date.now()) {
      const row = liveRow(tabId);
      if (row) { row.lastCmdAt = at; save(); }
    },
    remove(tabIds) {
      const ids = new Set((tabIds || []).filter(isInt));
      const n = tabs.length;
      tabs = tabs.filter((t) => !(ids.has(t.tabId) && t.browserSession === browserSession));
      if (tabs.length !== n) save();
      return n - tabs.length;
    },
    markRetained(runId) {
      let n = 0;
      for (const t of current()) if (t.runId === runId && t.status === "live") { t.status = "retained"; n++; }
      if (n) save();
      return n;
    },
    markRetainedTab(tabId) { const row = liveRow(tabId); if (row && row.status === "live") { row.status = "retained"; save(); } },
    markLate(tabId) { const row = liveRow(tabId); if (row) { row.late = true; save(); } },
    rowsForRun(runId) { return current().filter((t) => t.runId === runId && t.status === "live"); },

    // ---- queries -----------------------------------------------------------
    // Automatic cleanup selects live rows only; an explicit `bridge closeTabs`
    // (includeRetained) may also pick up tabs retained after a revoke.
    select({ client, runId, olderThanMs, includeRetained = false, now = Date.now() } = {}) {
      if (client === undefined && runId === undefined && olderThanMs === undefined) return [];
      return current().filter((t) => (t.status === "live" || (includeRetained && t.status === "retained"))
        && (client === undefined || t.client === client)
        && (runId === undefined || t.runId === runId)
        && (olderThanMs === undefined || now - t.lastCmdAt > olderThanMs)).map((t) => t.tabId);
    },
    list() {
      return { current: current().map((t) => ({ ...t })), dead: tabs.filter((t) => t.browserSession !== browserSession).map((t) => ({ ...t })) };
    },
    // The extension's own view of what it owns: current-session rows it no
    // longer lists are gone (closed by the user or lost to a reload), and rows
    // of earlier sessions are meaningless now.
    reconcile(agentTabIds) {
      const own = new Set((agentTabIds || []).filter(isInt));
      const n = tabs.length;
      tabs = tabs.filter((t) => t.browserSession === browserSession && own.has(t.tabId));
      if (tabs.length !== n) save();
      return { dropped: n - tabs.length };
    },
    originOf(url) { try { return new URL(String(url)).origin; } catch { return "unknown"; } },
  };
  return registry;
}

module.exports = { openRegistry };
