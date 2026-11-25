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
  const readPending = async (area, key) => { const v = (await chrome.storage[area].get(key))[key]; return Array.isArray(v) ? v : []; };
  const readMap = async (key) => { const v = (await chrome.storage.local.get(key))[key]; return v && typeof v === "object" ? { ...v } : {}; };
  let dlQueue = Promise.resolve();
  const withDownloads = (fn) => { const p = dlQueue.then(fn, fn); dlQueue = p.catch(() => {}); return p; };

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

    // ---- alarms, reload, startup --------------------------------------------
    // `access-expiry-<gen>` fires the revoke on time; the gen in the name keeps
    // a stale alarm from an earlier grant away from a renewed one.
    async onAlarm(name) {
      const m = /^access-expiry-(\d+)$/.exec(String(name || ""));
      if (!m) return false;
      const gen = Number(m[1]);
      let raw; try { raw = (await chrome.storage.local.get("access")).access; } catch { return false; }
      if (!raw || typeof raw !== "object" || raw.gen !== gen || raw.granted !== true) return false;
      await this.setAccess({ granted: false, source: "alarm" });
      return true;
    },
    // After any reload, update or install: revoked, and the user is told why.
    async onInstalled() {
      await this.setAccess({ granted: false, source: "reload" });
      await this.setNotice("access was revoked because the extension was reloaded; tabs opened before the reload are no longer tracked");
    },
    // Worker start: adopt the stored generation and reconcile the record.
    async init() {
      await this.ensureBrowserSession();
      let raw; try { raw = (await chrome.storage.local.get("access")).access; } catch { raw = null; }
      const storedGen = raw && typeof raw === "object" && Number.isInteger(raw.gen) && raw.gen >= 0 ? raw.gen : 0;
      if (storedGen > accessGen) accessGen = storedGen;
      const a = normalizeRecord(raw);
      lastRecord = a;
      if (raw && typeof raw === "object" && raw.granted === true && !a.granted) {
        await this.setAccess({ granted: false, source: "startup" }); // expired while the worker was away
      } else if (a.granted && a.until !== null) {
        const have = (await chrome.alarms.getAll().catch(() => [])).some((x) => x.name === `access-expiry-${a.gen}`);
        if (!have) await chrome.alarms.create(`access-expiry-${a.gen}`, { when: a.until }).catch((e) => hooks.log(`alarm recreate failed: ${e && e.message}`));
      }
      if (typeof this.reconcileOwnership === "function") await this.reconcileOwnership();
    },

    // ---- notices (popup) ----------------------------------------------------
    async notices() { const { notices } = await chrome.storage.local.get("notices"); return Array.isArray(notices) ? notices : []; },
    async setNotice(text) { const n = await this.notices(); if (!n.includes(text)) await chrome.storage.local.set({ notices: [...n, text] }); },
    async dismissNotices() { await chrome.storage.local.remove("notices"); },

    badgeState(record, now = Date.now()) {
      if (!record || !record.granted) return { text: "", color: "#9e9e9e" };
      if (record.until === null) return { text: "ON", color: "#1e8e3e" };
      const min = Math.max(0, Math.round((record.until - now) / 60000));
      return { text: min >= 60 ? `${Math.floor(min / 60)}h` : `${min}m`, color: "#1e8e3e" };
    },

    // ---- ownership with pending entries --------------------------------------
    // A pending entry is written BEFORE the browser call, so a worker restart
    // or a revoke between the call and the id coming back never loses the fact
    // that it was ours. A completion under a moved generation closes/cancels.
    beginTab({ gen, origin }) {
      const nonce = randomHex32();
      return withTabs(async () => {
        const list = await readPending("session", "pendingTabs");
        await chrome.storage.session.set({ pendingTabs: [...list, { nonce, gen, origin: String(origin || "unknown"), startedAt: Date.now() }] });
        return nonce;
      });
    },
    async completeTab(nonce, tabId) {
      const entry = await withTabs(async () => {
        const list = await readPending("session", "pendingTabs");
        const e = list.find((x) => x.nonce === nonce) || null;
        await chrome.storage.session.set({ pendingTabs: list.filter((x) => x.nonce !== nonce) });
        return e;
      });
      const gen = entry ? entry.gen : -1;
      const live = gen === accessGen && (await this.readAccess()).granted;
      if (live && Number.isInteger(tabId)) { await this.rememberAgentTab(tabId); return true; }
      if (Number.isInteger(tabId)) { try { await chrome.tabs.remove(tabId); } catch {} }
      return false;
    },
    beginDownload({ gen, origin }) {
      const nonce = randomHex32();
      return withDownloads(async () => {
        const list = await readPending("local", "pendingDownloads");
        await chrome.storage.local.set({ pendingDownloads: [...list, { nonce, gen, origin: String(origin || "unknown"), startedAt: Date.now() }] });
        return nonce;
      });
    },
    async completeDownload(nonce, downloadId) {
      const entry = await withDownloads(async () => {
        const list = await readPending("local", "pendingDownloads");
        const e = list.find((x) => x.nonce === nonce) || null;
        await chrome.storage.local.set({ pendingDownloads: list.filter((x) => x.nonce !== nonce) });
        return e;
      });
      const gen = entry ? entry.gen : -1;
      const live = gen === accessGen && (await this.readAccess()).granted;
      if (live && Number.isInteger(downloadId)) {
        await withDownloads(async () => { const m = await readMap("bridgeDownloads"); m[downloadId] = { gen }; await chrome.storage.local.set({ bridgeDownloads: m }); });
        return true;
      }
      if (Number.isInteger(downloadId)) { try { await chrome.downloads.cancel(downloadId); } catch {} }
      return false;
    },
    // Every bridge download of this browser session (all grants) still running
    // is cancelled; finished ones are left alone; vanished ids are forgotten.
    async cancelBridgeDownloads() {
      const cancelled = [];
      await withDownloads(async () => {
        const m = await readMap("bridgeDownloads");
        for (const id of Object.keys(m).map(Number)) {
          let item = null;
          try { [item] = await chrome.downloads.search({ id }); } catch {}
          if (!item) { delete m[id]; continue; }
          if (item.state === "in_progress") { try { await chrome.downloads.cancel(id); cancelled.push(id); } catch {} }
        }
        await chrome.storage.local.set({ bridgeDownloads: m });
      });
      return { cancelled };
    },
    // Worker start: drop records of tabs/downloads that no longer exist, adopt
    // pending downloads by byExtensionId, drop (never guess) pending tabs.
    async reconcileOwnership() {
      const out = { droppedTabs: 0, droppedDownloads: 0, adoptedDownloads: 0, unidentifiedTabs: 0 };
      await withTabs(async () => {
        let existing = null;
        try { existing = new Set((await chrome.tabs.query({})).map((t) => t.id)); } catch {}
        const ids = await readTabs();
        const kept = existing ? ids.filter((id) => existing.has(id)) : ids;
        out.droppedTabs = ids.length - kept.length;
        const pendingTabs = await readPending("session", "pendingTabs");
        out.unidentifiedTabs = pendingTabs.length;
        await chrome.storage.session.set({ agentTabs: kept, pendingTabs: [] });
      });
      await withDownloads(async () => {
        const m = await readMap("bridgeDownloads");
        let all = [];
        try { all = await chrome.downloads.search({}); } catch {}
        const existing = new Set(all.map((d) => d.id));
        for (const id of Object.keys(m).map(Number)) if (!existing.has(id)) { delete m[id]; out.droppedDownloads++; }
        const pending = await readPending("local", "pendingDownloads");
        for (const p of pending) {
          let items = [];
          try { items = await chrome.downloads.search({ startedAfter: new Date(p.startedAt).toISOString(), orderBy: ["-startTime"] }); } catch {}
          const mine = items.filter((d) => d.byExtensionId === chrome.runtime.id && !m[d.id]);
          if (mine.length) { m[mine[mine.length - 1].id] = { gen: p.gen }; out.adoptedDownloads++; }
        }
        await chrome.storage.local.set({ bridgeDownloads: m, pendingDownloads: [] });
      });
      if (out.unidentifiedTabs) await this.setNotice(`${out.unidentifiedTabs} tab(s) the agent may have opened could not be identified`);
      return out;
    },

    // Popup "Close agent tabs": every tab the bridge opened, access unchanged.
    async closeAgentTabs() { const r = await this.closeOwnedTabs(await this.agentTabIds()); return { closed: r.closed }; },
    async status() {
      const a = await this.readAccess();
      return { granted: a.granted, until: a.until, gen: a.gen, remainingMs: a.granted && a.until !== null ? Math.max(0, a.until - Date.now()) : null,
        browserSession: await this.ensureBrowserSession(), notices: await this.notices(), agentTabs: await this.agentTabIds() };
    },

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
  async function clearExpiryAlarms() {
    try { for (const a of await chrome.alarms.getAll()) if (/^access-expiry-/.test(a.name)) await chrome.alarms.clear(a.name); } catch {}
  }
  function badge(record) { try { hooks.badge({ ...BridgeAccess.badgeState(record), granted: record.granted, until: record.until }); } catch {} }
  async function grantSteps(record) {
    await clearExpiryAlarms();
    if (record.until !== null) {
      // The deadline is enforced by assertAccess/dispatch anyway; the alarm only flips the badge and detaches on time.
      try { await chrome.alarms.create(`access-expiry-${record.gen}`, { when: record.until }); }
      catch (e) { hooks.log(`expiry alarm not created: ${e && e.message}`); }
    }
    try { hooks.send(await BridgeAccess.accessMessage(await session())); } catch {}
    badge(record);
  }
  async function revokeSteps(record, closeTabs) {
    if (typeof BridgeAccess.cancelBridgeDownloads === "function") { try { await BridgeAccess.cancelBridgeDownloads(); } catch {} }
    try { await hooks.onRevoke(); } catch (e) { hooks.log(`detach on revoke failed: ${e && e.message}`); }
    if (closeTabs) { try { await BridgeAccess.closeOwnedTabs(await BridgeAccess.agentTabIds()); } catch {} }
    try { hooks.send(await BridgeAccess.accessMessage(await session())); } catch {}
    badge(record);
    await clearExpiryAlarms();
  }

  if (typeof module !== "undefined" && module.exports) module.exports = BridgeAccess;
  else root.BridgeAccess = BridgeAccess;
})(typeof self !== "undefined" ? self : globalThis);
