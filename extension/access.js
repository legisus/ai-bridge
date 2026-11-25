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
// - access: the grant state { granted, until, gen }, written only by this
//   worker through setAccess(); a missing or malformed record reads as revoked.
(function (root) {
  "use strict";

  const randomHex32 = () => {
    const c = root.crypto || (typeof require === "function" ? require("crypto").webcrypto : null);
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const isHex32 = (v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);

  // agentTabs is a read-modify-write of one storage key; concurrent newTab /
  // closeTab / onRemoved handlers would lose updates, so every mutation runs
  // through one queue.
  let tabsQueue = Promise.resolve();
  const withTabs = (fn) => { const p = tabsQueue.then(fn, fn); tabsQueue = p.catch(() => {}); return p; };
  const readTabs = async () => {
    const { agentTabs } = await chrome.storage.session.get("agentTabs");
    return Array.isArray(agentTabs) ? agentTabs.filter(Number.isInteger) : [];
  };

  // ---- access record, generation, transition ------------------------------
  // The worker is the only writer of `access`. Every grant and revoke bumps
  // the in-memory generation BEFORE the storage write; a command captures the
  // generation when it starts and fails as soon as it no longer matches.
  const ACCESS_REVOKED = (session) => `access_revoked: access revoked by user (session "${session}")`;
  const ACCESS_NOT_GRANTED = (session) => `access_not_granted: access not granted yet (session "${session}")`;
  let hooks = { onRevoke: async () => {}, send: () => {}, badge: () => {}, sessionName: async () => "chrome", log: () => {} };
  let accessGen = 0;
  let transition = Promise.resolve();     // the in-flight grant/revoke, awaited by every check
  let transitionQueue = Promise.resolve(); // serialises transitions
  let lastRecord = { granted: false, until: null, gen: 0, exists: false };

  // Storage → normalised record. Anything off-shape is revoked; a timed grant is
  // live only while now < until.
  const normalizeRecord = (raw, now = Date.now()) => {
    const gen = raw && typeof raw === "object" && Number.isInteger(raw.gen) && raw.gen >= 0 ? raw.gen : 0;
    if (raw === undefined) return { granted: false, until: null, gen: 0, exists: false };
    if (!raw || typeof raw !== "object" || raw.granted !== true) return { granted: false, until: null, gen, exists: true };
    if (raw.until === null) return { granted: true, until: null, gen, exists: true };
    if (typeof raw.until === "number" && Number.isFinite(raw.until) && raw.until > now) return { granted: true, until: raw.until, gen, exists: true };
    return { granted: false, until: null, gen, exists: true };
  };
  const session = () => hooks.sessionName().catch(() => "chrome");

  const BridgeAccess = {
    configure(h) { hooks = { ...hooks, ...h }; },
    currentGen() { return accessGen; },

    async readAccess() {
      let raw;
      try { raw = (await chrome.storage.local.get("access")).access; }
      catch (e) { hooks.log(`access read failed: ${e && e.message}`); return { granted: false, until: null, gen: accessGen, exists: true, error: true }; }
      lastRecord = normalizeRecord(raw);
      return lastRecord;
    },

    // The transition. A grant whose `until` is not null or a finite future
    // number is treated as a revoke: nothing malformed ever grants.
    setAccess({ granted, until = null, closeTabs = false, source = "popup" } = {}) {
      const now = Date.now();
      const ok = granted === true && (until === null || (typeof until === "number" && Number.isFinite(until) && until > now));
      const run = async () => {
        const gen = ++accessGen;
        let release;
        transition = new Promise((r) => { release = r; });
        const record = { granted: ok, until: ok ? until : null, gen };
        try {
          await chrome.storage.local.set({ access: record });
          lastRecord = { ...record, exists: true };
          if (ok) await grantSteps(record);
          else await revokeSteps(record, closeTabs);
          hooks.log(`access ${ok ? "granted" : "revoked"} (gen ${gen}, source ${source})`);
        } finally { release(); }
        return record;
      };
      const p = transitionQueue.then(run, run);
      transitionQueue = p.catch(() => {});
      return p;
    },

    // gen check → await transition → read storage → gen check again.
    async assertAccess(gen) {
      const name = await session();
      if (gen !== accessGen) throw new Error(ACCESS_REVOKED(name));
      await transition;
      const a = await this.readAccess();
      if (gen !== accessGen) throw new Error(ACCESS_REVOKED(name));
      if (!a.exists) throw new Error(ACCESS_NOT_GRANTED(name));
      if (!a.granted) throw new Error(ACCESS_REVOKED(name));
    },

    // The last check and the browser call happen in the same synchronous
    // continuation: no await between them.
    dispatch(gen, thunk) {
      if (gen !== accessGen || !lastRecord.granted || (lastRecord.until !== null && Date.now() >= lastRecord.until)) {
        return session().then((name) => { throw new Error(ACCESS_REVOKED(name)); });
      }
      try { return Promise.resolve(thunk()); } catch (e) { return Promise.reject(e); }
    },

    ACCESS_REVOKED, ACCESS_NOT_GRANTED,

    async accessMessage(sessionName) {
      const [a, browserSession] = await Promise.all([this.readAccess(), this.ensureBrowserSession()]);
      return { type: "access", session: sessionName || "chrome", granted: a.granted, until: a.until, gen: a.gen, browserSession };
    },

    async ensureBrowserSession() {
      const { browserSession } = await chrome.storage.session.get("browserSession");
      if (isHex32(browserSession)) return browserSession;
      const fresh = randomHex32();
      await chrome.storage.session.set({ browserSession: fresh });
      return fresh;
    },

    agentTabIds() { return withTabs(readTabs); },
    rememberAgentTab(tabId) {
      if (!Number.isInteger(tabId)) return Promise.resolve();
      return withTabs(async () => {
        const ids = await readTabs();
        if (!ids.includes(tabId)) await chrome.storage.session.set({ agentTabs: [...ids, tabId] });
      });
    },
    forgetAgentTab(tabId) {
      return withTabs(async () => {
        const ids = await readTabs();
        if (ids.includes(tabId)) await chrome.storage.session.set({ agentTabs: ids.filter((id) => id !== tabId) });
      });
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


  // Grant/revoke side effects (alarms, downloads and tab closing arrive with the
  // next tasks; the envelope and the badge go through the configured hooks).
  async function grantSteps(record) {
    try { hooks.send(await BridgeAccess.accessMessage(await session())); } catch {}
    try { hooks.badge({ granted: true, until: record.until }); } catch {}
  }
  async function revokeSteps(record, closeTabs) {
    try { await hooks.onRevoke(); } catch (e) { hooks.log(`detach on revoke failed: ${e && e.message}`); }
    if (closeTabs) { try { await BridgeAccess.closeOwnedTabs(await BridgeAccess.agentTabIds()); } catch {} }
    try { hooks.send(await BridgeAccess.accessMessage(await session())); } catch {}
    try { hooks.badge({ granted: false, until: null }); } catch {}
  }

  if (typeof module !== "undefined" && module.exports) module.exports = BridgeAccess;
  else root.BridgeAccess = BridgeAccess;
})(typeof self !== "undefined" ? self : globalThis);
