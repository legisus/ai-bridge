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
  let evQueue = Promise.resolve();
  const withEvents = (fn) => { const p = evQueue.then(fn, fn); evQueue = p.catch(() => {}); return p; };
  const EVENT_LIMIT = 200;
  const EVENT_KINDS = new Set(["connect", "disconnect", "superseded", "grant", "revoke", "refused", "tab_opened", "tab_closed", "download_started", "download_cancelled", "attach", "detach"]);
  const REASONS = new Set(["access_revoked", "access_not_granted", "privileged_target", "not_allowed", "target_changed", "extension_disconnected"]);
  const SOURCES = new Set(["popup", "options", "alarm", "reload", "startup", "token-change", "auto"]);

  // ---- access record, generation, transition ------------------------------
  // The worker is the only writer of `access`. Every grant and revoke bumps
  // the in-memory generation BEFORE the storage write; a command captures the
  // generation when it starts and fails as soon as it no longer matches.
  const ACCESS_REVOKED = (session) => `access_revoked: access revoked by user (session "${session}")`;
  const ACCESS_NOT_GRANTED = (session) => `access_not_granted: access not granted yet (session "${session}")`;
  let hooks = { onRevoke: async () => {}, send: () => {}, badge: () => {}, sessionName: async () => "chrome", log: () => {} };
  let accessGen = 0;
  let reloading = false;                  // a reload's revoke/cleanup is in progress: no auto re-grant
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
      catch (e) {
        hooks.log(`access read failed: ${e && e.message}`);
        lastRecord = { granted: false, until: null, gen: accessGen, exists: true, error: true }; // a failed read never leaves a cached grant behind
        return lastRecord;
      }
      const rec = normalizeRecord(raw);
      // A record from an earlier generation (a write that never landed, a stale
      // snapshot) is not this generation's grant.
      if (rec.exists && accessGen !== 0 && rec.gen !== accessGen) { rec.granted = false; rec.until = null; rec.stale = true; }
      lastRecord = rec;
      return rec;
    },

    // The transition. A grant whose `until` is not null or a finite future
    // number is treated as a revoke: nothing malformed ever grants.
    // `ifGen`: only transition if the stored record still has that generation
    // and is granted (the expiry alarm); otherwise return the current record
    // untouched with `skipped: true`. The condition is evaluated inside the
    // serialised queue, so a renewal that landed first wins.
    setAccess({ granted, until = null, closeTabs = false, source = "popup", ifGen, unlessIndefinite = false } = {}) {
      const now = Date.now();
      const ok = granted === true && (until === null || (typeof until === "number" && Number.isFinite(until) && until > now));
      const run = async () => {
        if (ifGen !== undefined) {
          let raw; try { raw = (await chrome.storage.local.get("access")).access; } catch { raw = null; }
          if (!raw || typeof raw !== "object" || raw.gen !== ifGen || raw.granted !== true || ifGen !== accessGen) return { ...lastRecord, skipped: true };
        }
        if (unlessIndefinite) {
          // Auto-grant reconciliation, decided INSIDE the serialised transition:
          // the policy is read here (a flip queued before us has landed), a
          // reload that began meanwhile wins, and an unreadable policy denies
          // until a later reconciliation succeeds.
          if (reloading) return { ...lastRecord, skipped: true, reloading: true };
          const on = await BridgeAccess.autoGrantEnabled();
          if (on === null) { lastRecord = { granted: false, until: null, gen: accessGen, exists: true, error: true }; return { ...lastRecord, skipped: true, error: "storage read failed" }; }
          if (!on) return { ...lastRecord, skipped: true };
          let cur; try { cur = normalizeRecord((await chrome.storage.local.get("access")).access); } catch { cur = null; }
          if (reloading) return { ...lastRecord, skipped: true, reloading: true };
          if (cur && cur.granted && cur.until === null && (accessGen === 0 || cur.gen === accessGen)) { if (accessGen === 0) accessGen = cur.gen; lastRecord = cur; return { ...cur, skipped: true }; }
          if (cur === null) { lastRecord = { granted: false, until: null, gen: accessGen, exists: true, error: true }; return { ...lastRecord, skipped: true, error: "storage read failed" }; }
        }
        const gen = ++accessGen;
        let release;
        transition = new Promise((r) => { release = r; });
        const record = { granted: ok, until: ok ? until : null, gen };
        // Deny in memory before the write: a command racing this transition
        // sees the new generation whatever happens to storage.
        lastRecord = { ...record, exists: true };
        let writeError = null;
        try {
          try { await chrome.storage.local.set({ access: record }); }
          catch (e) { writeError = e; hooks.log(`access write failed: ${e && e.message}`); }
          if (ok && !writeError) await grantSteps(record);
          else {
            // A revoke whose write failed still revokes (the memory latch and the
            // gen mismatch deny every command); a grant whose write failed is
            // not a grant.
            if (ok && writeError) { record.granted = false; record.until = null; lastRecord = { ...record, exists: true }; }
            await revokeSteps(record, closeTabs);
          }
          hooks.log(`access ${record.granted ? "granted" : "revoked"} (gen ${gen}, source ${source}${writeError ? ", storage write failed" : ""})`);
          await BridgeAccess.logEvent({ kind: record.granted ? "grant" : "revoke", detail: { source, gen, until: record.until === null ? undefined : record.until } }).catch(() => {});
        } finally { release(); }
        return writeError ? { ...record, error: "storage write failed" } : record;
      };
      const p = transitionQueue.then(run, run);
      transitionQueue = p.catch(() => {});
      return p;
    },

    // The popup/Options request, after JSON transport (NaN → null): a timed
    // request must say so, or a lost `until` would become an indefinite grant.
    parseAccessSet(msg) {
      if (!msg || typeof msg !== "object") return { error: "bad request" };
      if (msg.granted !== true) return { granted: false, until: null, closeTabs: msg.closeTabs === true };
      if (msg.timed === true) {
        if (typeof msg.until !== "number" || !Number.isFinite(msg.until) || msg.until <= Date.now()) return { error: "invalid until for a timed grant" };
        return { granted: true, until: msg.until, closeTabs: false };
      }
      if (msg.until !== null && msg.until !== undefined) return { error: "a timed grant must set timed:true" };
      return { granted: true, until: null, closeTabs: false };
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

    // ---- event log -------------------------------------------------------------
    // The last 200 things the worker did or refused, in session storage, for the
    // popup (in full) and for `status {events:true}` (projected: see below).
    // Origins only, fixed detail codes, never an error string.
    logEvent({ kind, reqId, tabId, origin, detail } = {}) {
      if (!EVENT_KINDS.has(kind)) return Promise.resolve();
      const e = { t: Date.now(), kind };
      if (reqId !== undefined && reqId !== null) e.reqId = String(reqId);
      if (Number.isInteger(tabId)) e.tabId = tabId;
      if (origin) { try { e.origin = new URL(String(origin)).origin; } catch { e.origin = String(origin).split(/[/?#]/)[0]; } }
      if (detail && typeof detail === "object") {
        const d = {};
        if (REASONS.has(detail.reason)) d.reason = detail.reason;
        if (SOURCES.has(detail.source)) d.source = detail.source;
        if (Number.isFinite(detail.gen)) d.gen = detail.gen;
        if (Number.isFinite(detail.until)) d.until = detail.until;
        if (Object.keys(d).length) e.detail = d;
      }
      try { hooks.log(`event ${kind}${e.reqId ? ` req ${e.reqId}` : ""}${e.origin ? ` ${e.origin}` : ""}${e.detail ? ` ${JSON.stringify(e.detail)}` : ""}`); } catch {}
      return withEvents(async () => {
        const { events } = await chrome.storage.session.get("events");
        const list = Array.isArray(events) ? events : [];
        list.push(e);
        await chrome.storage.session.set({ events: list.slice(-EVENT_LIMIT) });
      });
    },
    async events() { const { events } = await chrome.storage.session.get("events"); return Array.isArray(events) ? events : []; },
    clearEvents() { return withEvents(() => chrome.storage.session.remove("events")); },
    // What goes over the wire. Not granted: counts per kind. Granted: entries,
    // with the origin redacted (and the tab id dropped) for anything privileged
    // or outside the CURRENT allowlist; detail already holds only fixed codes.
    projectEvents(entries, { granted, allowlist } = {}) {
      const list = Array.isArray(entries) ? entries : [];
      if (!granted) {
        const counts = {};
        for (const e of list) counts[e.kind] = (counts[e.kind] || 0) + 1;
        return { counts };
      }
      return {
        events: list.map((e) => {
          const out = { t: e.t, kind: e.kind };
          if (e.reqId) out.reqId = e.reqId;
          const ok = e.origin && this.isHttpUrl(e.origin) && this.hostAllowed(new URL(e.origin).hostname, allowlist);
          if (e.origin) out.origin = ok ? e.origin : "redacted";
          if (ok && Number.isInteger(e.tabId)) out.tabId = e.tabId;
          if (e.detail) out.detail = { ...e.detail };
          return out;
        }),
      };
    },

    // ---- target rules ----------------------------------------------------------
    // Only http(s) documents are ever a target: not Chrome's own pages, not this
    // extension's pages, not file:, javascript:, data: or view-source:. The
    // allowlist cannot override this (`*` means any http(s) host).
    isHttpUrl(url) {
      try { const u = new URL(String(url)); return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname; } catch { return false; }
    },
    assertTarget(url) { if (!this.isHttpUrl(url)) throw new Error("privileged target refused"); },
    hostAllowed(host, allowlist) {
      if (!Array.isArray(allowlist) || allowlist.length === 0) return true; // empty = allow all (see README)
      return allowlist.some((pat) => pat === "*" || host === pat || host.endsWith("." + pat));
    },
    assertAllowedUrl(url, allowlist) {
      this.assertTarget(url);
      const host = new URL(String(url)).hostname;
      if (!this.hostAllowed(host, allowlist)) throw new Error(`host "${host}" not in allowlist`);
    },
    // A tab the agent may not touch is listed with its id only.
    redactTabs(tabs, allowlist, agentTabIds = []) {
      return (tabs || []).map((t) => {
        const ok = this.isHttpUrl(t.url) && this.hostAllowed(new URL(t.url).hostname, allowlist);
        const base = { id: t.id, windowId: t.windowId, active: t.active };
        if (agentTabIds.includes(t.id)) base.agent = true;
        return ok ? { ...base, url: t.url, title: t.title } : { ...base, url: "redacted" };
      });
    },
    // A fresh or empty tab: no document to protect, so a command that supplies
    // its own destination (navigate) may use it.
    blankUrl(url) { const u = String(url || ""); return u === "" || u === "about:blank" || /^chrome:\/\/newtab\/?$/.test(u) || /^chrome:\/\/new-tab-page\/?/.test(u); },

    // ---- alarms, reload, startup --------------------------------------------
    // `access-expiry-<gen>` fires the revoke on time; the gen in the name keeps
    // a stale alarm from an earlier grant away from a renewed one.
    async onAlarm(name) {
      const m = /^access-expiry-(\d+)$/.exec(String(name || ""));
      if (!m) return false;
      const rec = await this.setAccess({ granted: false, source: "alarm", ifGen: Number(m[1]) });
      return !rec.skipped;
    },
    // ---- auto-grant (always on) -------------------------------------------------
    // The user's policy (Options, default ON): the bridge is granted whenever the
    // extension runs; the extension's own enable/disable toggle is the stop
    // switch. Reconciliation is one serialised, idempotent transition.
    // true/false, or null when the setting cannot be read (callers fail closed).
    async autoGrantEnabled() {
      try { const { autoGrant } = await chrome.storage.local.get({ autoGrant: true }); return autoGrant !== false; } catch { return null; }
    },
    // The decision (reloading? policy on? already indefinite?) is made inside
    // the queued transition, see setAccess(unlessIndefinite).
    reconcileAuto({ source = "auto" } = {}) {
      if (reloading) return Promise.resolve({ ...lastRecord, skipped: true, reloading: true }); // never re-grant while a reload cleans up
      return this.setAccess({ granted: true, until: null, source, unlessIndefinite: true });
    },
    async setAutoGrant(on) {
      await chrome.storage.local.set({ autoGrant: on !== false });
      if (on !== false) { await this.dismissNotices(); return this.reconcileAuto({ source: "auto" }); }
      return this.setAccess({ granted: false, source: "options" });
    },
    beginReload() { reloading = true; },
    endReload() { reloading = false; },

    // After any reload, update or install: with auto-grant ON the new worker is
    // granted again (the reload itself revoked and cleaned up first); with it
    // OFF the bridge starts revoked and the user is told why.
    async onInstalled() {
      if (await this.autoGrantEnabled()) { await this.dismissNotices(); return this.reconcileAuto(); }
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
      // Ownership first, so a download recovered from a pending entry is known
      // to the revoke/sweep that follows.
      if (typeof this.reconcileOwnership === "function") await this.reconcileOwnership();
      if (raw && typeof raw === "object" && raw.granted === true && !a.granted) {
        await this.setAccess({ granted: false, source: "startup" }); // expired while the worker was away
      } else if (!a.granted) {
        if (typeof this.cancelBridgeDownloads === "function") await this.cancelBridgeDownloads(); // revoked start: nothing of ours may keep running
      } else if (a.until !== null) {
        const have = (await chrome.alarms.getAll().catch(() => [])).some((x) => x.name === `access-expiry-${a.gen}`);
        if (!have) await chrome.alarms.create(`access-expiry-${a.gen}`, { when: a.until }).catch((e) => hooks.log(`alarm recreate failed: ${e && e.message}`));
      }
      await this.reconcileAuto({ source: "auto" }); // the always-on policy, when enabled
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
    beginTab({ gen, origin, reqId }) {
      const nonce = randomHex32();
      return withTabs(async () => {
        const list = await readPending("session", "pendingTabs");
        await chrome.storage.session.set({ pendingTabs: [...list, { nonce, gen, origin: String(origin || "unknown"), startedAt: Date.now(), ...(reqId ? { reqId: String(reqId) } : {}) }] });
        return nonce;
      });
    },
    async completeTab(nonce, tabId) {
      // The pending entry becomes ownership in ONE write, so the tab is never
      // untracked in between; a completion judged dead afterwards closes it
      // and drops the ownership again.
      const entry = await withTabs(async () => {
        const list = await readPending("session", "pendingTabs");
        const e = list.find((x) => x.nonce === nonce) || null;
        const ids = await readTabs();
        const own = Number.isInteger(tabId) && !ids.includes(tabId) ? [...ids, tabId] : ids;
        await chrome.storage.session.set({ pendingTabs: list.filter((x) => x.nonce !== nonce), agentTabs: own });
        return e;
      });
      const gen = entry ? entry.gen : -1;
      const liveNow = async () => { await transition; const a = await this.readAccess(); return gen === accessGen && a.granted && (a.until === null || Date.now() < a.until); };
      if (Number.isInteger(tabId) && (await liveNow())) {
        if (gen === accessGen && lastRecord.granted) { this.logEvent({ kind: "tab_opened", tabId, origin: entry && entry.origin, reqId: entry && entry.reqId }).catch(() => {}); return true; }
      }
      if (Number.isInteger(tabId)) await this.forgetAgentTab(tabId);
      if (Number.isInteger(tabId)) { try { await chrome.tabs.remove(tabId); this.logEvent({ kind: "tab_closed", tabId, origin: entry && entry.origin, reqId: entry && entry.reqId, detail: { reason: "access_revoked" } }).catch(() => {}); } catch {} }
      return false;
    },
    beginDownload({ gen, origin, reqId }) {
      const nonce = randomHex32();
      return withDownloads(async () => {
        const list = await readPending("local", "pendingDownloads");
        await chrome.storage.local.set({ pendingDownloads: [...list, { nonce, gen, origin: String(origin || "unknown"), startedAt: Date.now(), ...(reqId ? { reqId: String(reqId) } : {}) }] });
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
      const liveNow = async () => { await transition; const a = await this.readAccess(); return gen === accessGen && a.granted && (a.until === null || Date.now() < a.until); };
      if (Number.isInteger(downloadId)) {
        // Record ownership first (so a revoke's sweep can find it), then decide.
        await withDownloads(async () => { const m = await readMap("bridgeDownloads"); m[downloadId] = { gen }; await chrome.storage.local.set({ bridgeDownloads: m }); });
        if ((await liveNow()) && gen === accessGen) { this.logEvent({ kind: "download_started", origin: entry && entry.origin, reqId: entry && entry.reqId }).catch(() => {}); return true; }
        try { await chrome.downloads.cancel(downloadId); this.logEvent({ kind: "download_cancelled", origin: entry && entry.origin, reqId: entry && entry.reqId, detail: { reason: "access_revoked" } }).catch(() => {}); } catch {}
      }
      return false;
    },
    // Every bridge download of this browser session (all grants) still running
    // is cancelled; finished ones are left alone; vanished ids are forgotten.
    async cancelBridgeDownloads() {
      const cancelled = [];
      await withDownloads(async () => {
        const m = await readMap("bridgeDownloads");
        for (const id of Object.keys(m).map(Number)) {
          let items = null;
          try { items = await chrome.downloads.search({ id }); } catch { continue; } // lookup failed: keep the record, decide next time
          const item = items && items[0];
          if (!item) { delete m[id]; continue; }
          if (item.state === "in_progress") { try { await chrome.downloads.cancel(id); cancelled.push(id); BridgeAccess.logEvent({ kind: "download_cancelled", detail: { reason: "access_revoked" } }).catch(() => {}); } catch {} }
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
    // With `gen` (the remote closeTabs command) every removal is a dispatched
    // browser operation: checked against the generation and the deadline right
    // before the call. Without it (popup, revoke) the caller is trusted.
    async closeOwnedTabs(tabIds, { gen } = {}) {
      const closed = [], skipped = [];
      if (!Array.isArray(tabIds)) return { closed, skipped };
      const guard = async () => { if (gen === undefined) return; await this.assertAccess(gen); };
      await guard();
      const own = await this.agentTabIds();
      await guard();
      for (const id of tabIds) {
        if (!Number.isInteger(id) || !own.includes(id)) { skipped.push(id); continue; }
        let gone = true;
        try {
          if (gen === undefined) await chrome.tabs.remove(id);
          else await this.dispatch(gen, () => chrome.tabs.remove(id));
          closed.push(id);
        } catch (e) {
          if (gen !== undefined && /^access_/.test(String(e && e.message))) throw e;
          skipped.push(id);
          gone = /No tab with id/i.test(String(e && e.message)); // already closed by the user → forget; any other failure keeps ownership
        }
        if (gone) await this.forgetAgentTab(id);
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
