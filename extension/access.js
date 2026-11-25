// AI Browser Bridge — access and tab-ownership bookkeeping for the service
// worker (design: docs/superpowers/specs/2026-11-21-docker-isolated-access-
// design.md). Loaded by background.js with importScripts(); loadable in Node
// with a stub `chrome` for the tests (test/extension.access.test.js).
//
// - browserSession: a random id for the current Chrome session, kept in
//   chrome.storage.session (cleared on browser restart and extension reload)
//   and sent in every `access` message. Tab ids are unique only within one
//   browser session; the relay uses this id to tell a live tab from a stale
//   record.
// - agentTabs: the ids of the tabs the bridge opened, in session storage.
//   `closeTabs` closes only ids in this set — never a tab the user opened.
// - access: the grant state. This version has no grant/revoke UI yet, so the
//   stored default is "granted, indefinite, gen 1"; the switch lands next.
(function (root) {
  "use strict";

  const randomHex32 = () => {
    const c = root.crypto || (typeof require === "function" ? require("crypto").webcrypto : null);
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const isHex32 = (v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
  const DEFAULT_ACCESS = { granted: true, until: null, gen: 1 };

  const BridgeAccess = {
    async ensureBrowserSession() {
      const { browserSession } = await chrome.storage.session.get("browserSession");
      if (isHex32(browserSession)) return browserSession;
      const fresh = randomHex32();
      await chrome.storage.session.set({ browserSession: fresh });
      return fresh;
    },

    async accessState() {
      const { access } = await chrome.storage.local.get({ access: DEFAULT_ACCESS });
      const a = access && typeof access === "object" ? access : DEFAULT_ACCESS;
      return { granted: a.granted === true, until: typeof a.until === "number" ? a.until : null, gen: Number.isInteger(a.gen) ? a.gen : 0 };
    },

    async accessMessage(session) {
      const [a, browserSession] = await Promise.all([this.accessState(), this.ensureBrowserSession()]);
      return { type: "access", session: session || "chrome", granted: a.granted, until: a.until, gen: a.gen, browserSession };
    },

    async agentTabIds() {
      const { agentTabs } = await chrome.storage.session.get("agentTabs");
      return Array.isArray(agentTabs) ? agentTabs.filter(Number.isInteger) : [];
    },
    async rememberAgentTab(tabId) {
      if (!Number.isInteger(tabId)) return;
      const ids = await this.agentTabIds();
      if (!ids.includes(tabId)) await chrome.storage.session.set({ agentTabs: [...ids, tabId] });
    },
    async forgetAgentTab(tabId) {
      const ids = await this.agentTabIds();
      if (ids.includes(tabId)) await chrome.storage.session.set({ agentTabs: ids.filter((id) => id !== tabId) });
    },

    // Close the intersection of `tabIds` with agentTabs, one tab at a time;
    // everything else is reported as skipped. An id whose removal fails (the
    // user closed it already) is skipped too and forgotten.
    async closeOwnedTabs(tabIds) {
      const closed = [], skipped = [];
      if (!Array.isArray(tabIds)) return { closed, skipped };
      const own = await this.agentTabIds();
      for (const id of tabIds) {
        if (!Number.isInteger(id) || !own.includes(id)) { skipped.push(id); continue; }
        try { await chrome.tabs.remove(id); closed.push(id); }
        catch { skipped.push(id); }
        await this.forgetAgentTab(id);
      }
      return { closed, skipped };
    },
  };

  if (typeof module !== "undefined" && module.exports) module.exports = BridgeAccess;
  else root.BridgeAccess = BridgeAccess;
})(typeof self !== "undefined" ? self : globalThis);
