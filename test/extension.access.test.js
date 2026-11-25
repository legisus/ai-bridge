#!/usr/bin/env node
// extension/access.js under a stub `chrome`: browserSession, the access record
// (fail-closed), the serialised grant/revoke transition, assertAccess/dispatch
// races, agentTabs bookkeeping and closeTabs. Also checks that background.js
// wires the module in.
const fs = require("fs");
const path = require("path");
const { stubChrome } = require("./helpers/stub-chrome");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const S = stubChrome();
  global.chrome = S.chrome;
  const B = require("../extension/access.js");

  // ---- browserSession ----------------------------------------------------
  const bs = await B.ensureBrowserSession();
  assert(/^[0-9a-f]{32}$/.test(bs) && (await B.ensureBrowserSession()) === bs, "browserSession created once and stable");
  await S.chrome.storage.session.set({ browserSession: "garbage" });
  assert(/^[0-9a-f]{32}$/.test(await B.ensureBrowserSession()), "malformed stored browserSession replaced");
  await S.chrome.storage.session.clear(); // simulated reload / browser restart
  assert((await B.ensureBrowserSession()) !== bs, "cleared session storage → new browserSession");

  // ---- agentTabs / closeTabs (slice 1) -----------------------------------
  await B.rememberAgentTab(10); await B.rememberAgentTab(11); await B.rememberAgentTab(11);
  assert(JSON.stringify(await B.agentTabIds()) === "[10,11]", "agentTabs de-duplicated");
  let r = await B.closeOwnedTabs([10, 99, "x"]);
  assert(JSON.stringify(r.closed) === "[10]" && JSON.stringify(r.skipped) === '[99,"x"]' && JSON.stringify(S.removed) === "[10]" && JSON.stringify(await B.agentTabIds()) === "[11]", "closeTabs closes only owned ids, reports the rest skipped");
  S.failIds.add(11);
  r = await B.closeOwnedTabs([11]);
  assert(r.closed.length === 0 && JSON.stringify(r.skipped) === "[11]" && (await B.agentTabIds()).length === 0, "remove rejection → skipped and forgotten");
  await B.rememberAgentTab(12); await B.forgetAgentTab(12);
  assert((await B.agentTabIds()).length === 0, "forgetAgentTab");
  r = await B.closeOwnedTabs("nope");
  assert(r.closed.length === 0 && r.skipped.length === 0, "closeTabs with a non-array closes nothing");
  await S.chrome.storage.session.set({ agentTabs: [] });
  await Promise.all([B.rememberAgentTab(20), B.rememberAgentTab(21), B.rememberAgentTab(22)]);
  assert(JSON.stringify(await B.agentTabIds()) === "[20,21,22]", "concurrent rememberAgentTab keeps every tab");
  await Promise.all([B.forgetAgentTab(21), B.rememberAgentTab(23)]);
  assert(JSON.stringify(await B.agentTabIds()) === "[20,22,23]", "concurrent forget + remember: removed tab stays removed, new tab kept");

  // ---- access record: fail closed ----------------------------------------
  B.configure({ sessionName: async () => "work-chrome" });
  let a = await B.readAccess();
  assert(a.granted === false && a.exists === false, "absent record → revoked, exists:false");
  for (const bad of [{ granted: true, until: "soon" }, { granted: true, until: 0 }, { granted: true, until: Date.now() - 1 }, { granted: "true", until: null }, { granted: true }, "junk", 7]) {
    await S.chrome.storage.local.set({ access: bad });
    assert((await B.readAccess()).granted === false, `malformed record ${JSON.stringify(bad)} → revoked`);
  }
  await S.chrome.storage.local.set({ access: { granted: true, until: Date.now() + 60000, gen: 2 } });
  assert((await B.readAccess()).granted === true, "well-formed timed grant reads as granted");
  let msg = await B.accessMessage("work-chrome");
  assert(msg.type === "access" && msg.granted === true && msg.gen === 2 && /^[0-9a-f]{32}$/.test(msg.browserSession) && msg.session === "work-chrome", "access message reflects the stored record and carries browserSession");
  await S.chrome.storage.local.remove("access");
  msg = await B.accessMessage("c");
  assert(msg.granted === false && msg.until === null, "access message with no record is not granted");

  // ---- grant / revoke transitions ----------------------------------------
  let rec = await B.setAccess({ granted: true });
  assert(rec.granted === true && rec.until === null && rec.gen === 1 && B.currentGen() === 1, "grant: gen 1, indefinite");
  rec = await B.setAccess({ granted: false });
  assert(rec.granted === false && rec.gen === 2 && (await B.readAccess()).granted === false, "revoke bumps gen and persists");
  for (const bad of [Date.now() - 5, 0, NaN, "1h"]) {
    rec = await B.setAccess({ granted: true, until: bad });
    assert(rec.granted === false, `grant with until ${String(bad)} is treated as a revoke`);
  }
  const soon = Date.now() + 60000;
  rec = await B.setAccess({ granted: true, until: soon });
  assert(rec.granted === true && rec.until === soon, "timed grant stored");

  // ---- assertAccess -------------------------------------------------------
  const g = B.currentGen();
  await B.assertAccess(g);
  let err = null; try { await B.assertAccess(g - 1); } catch (e) { err = e.message; }
  assert(err === 'access_revoked: access revoked by user (session "work-chrome")', "stale gen → access_revoked with the session name");
  await S.chrome.storage.local.remove("access");
  err = null; try { await B.assertAccess(B.currentGen()); } catch (e) { err = e.message; }
  assert(err === 'access_not_granted: access not granted yet (session "work-chrome")', "no record → access_not_granted");
  // revoke resolved DURING the storage read fails the command
  await B.setAccess({ granted: true });
  const g2 = B.currentGen();
  S.mem.pauseNext("local"); // the next storage.local.get waits until S.mem.resume()
  const pendingCheck = B.assertAccess(g2);
  await sleep(5);
  const revoke = B.setAccess({ granted: false }); // bumps the gen while the read is parked
  await sleep(5);
  S.mem.resume();
  await revoke;
  err = null; try { await pendingCheck; } catch (e) { err = e.message; }
  assert(/^access_revoked:/.test(err), "a revoke landing during the storage read fails the command");
  // check passed → revoke → dispatch fails
  await B.setAccess({ granted: true });
  const g3 = B.currentGen();
  await B.assertAccess(g3);
  await B.setAccess({ granted: false });
  let ran = false; err = null;
  try { await B.dispatch(g3, () => { ran = true; return 1; }); } catch (e) { err = e.message; }
  assert(!ran && /^access_revoked:/.test(err), "dispatch after a revoke never calls the thunk");
  // dispatch honours the deadline synchronously
  await B.setAccess({ granted: true, until: Date.now() + 30 });
  const g4 = B.currentGen(); await B.assertAccess(g4);
  await sleep(40);
  ran = false; err = null; try { await B.dispatch(g4, () => { ran = true; }); } catch (e) { err = e.message; }
  assert(!ran && /^access_revoked:/.test(err), "dispatch refuses once the timed grant has expired");
  await B.setAccess({ granted: true });
  const g4b = B.currentGen(); await B.assertAccess(g4b);
  assert((await B.dispatch(g4b, () => 42)) === 42, "dispatch runs the thunk under a live grant");
  // a command that starts during the write waits for it
  S.mem.pauseNext("local", "set");
  const t = B.setAccess({ granted: true });
  await sleep(5);
  const g5 = B.currentGen();
  const waiting = B.assertAccess(g5);
  let settled = false; waiting.then(() => { settled = true; }, () => { settled = true; });
  await sleep(10);
  assert(!settled, "assertAccess waits for an in-flight transition");
  S.mem.resume(); await t; await waiting;
  assert(settled, "…and resolves once the write is done");
  // near-simultaneous grant + revoke serialise, last wins, gens monotonic
  const before = B.currentGen();
  const [a1, a2] = await Promise.all([B.setAccess({ granted: true }), B.setAccess({ granted: false })]);
  assert(a1.gen === before + 1 && a2.gen === before + 2 && (await B.readAccess()).granted === false, "concurrent grant+revoke: serialised, last wins");
  // storage read failure reads as revoked
  await B.setAccess({ granted: true });
  S.mem.failNext("local");
  err = null; try { await B.assertAccess(B.currentGen()); } catch (e) { err = e.message; }
  assert(/^access_revoked:/.test(err), "storage failure → access_revoked");

  // ---- alarms, hooks, reload, startup, popup helpers (Task 2) -----------
  await B.setAccess({ granted: true, until: Date.now() + 3600e3 });
  let gg = B.currentGen();
  assert(S.alarms.list.some((x) => x.name === `access-expiry-${gg}`) && S.alarms.list.length === 1, "timed grant creates access-expiry-<gen>");
  await B.setAccess({ granted: true });
  assert(S.alarms.list.length === 0, "indefinite grant clears expiry alarms");
  await B.setAccess({ granted: true, until: Date.now() + 3600e3 }); gg = B.currentGen();
  assert((await B.onAlarm(`access-expiry-${gg - 1}`)) === false && (await B.readAccess()).granted === true, "a stale alarm from an earlier grant does not revoke");
  assert((await B.onAlarm(`access-expiry-${gg}`)) === true && (await B.readAccess()).granted === false && S.alarms.list.length === 0, "the current alarm revokes and clears the alarm");
  assert((await B.onAlarm("reconnect")) === false, "other alarms are ignored");
  S.alarms.failCreate = true;
  rec = await B.setAccess({ granted: true, until: Date.now() + 30 });
  assert(rec.granted === true, "alarm failure does not fail the grant");
  await sleep(40);
  err = null; try { await B.assertAccess(B.currentGen()); } catch (e) { err = e.message; }
  assert(/^access_revoked:/.test(err), "…and the deadline still holds without the alarm");
  S.alarms.failCreate = false;
  // hooks, in order
  const calls = [];
  B.configure({ sessionName: async () => "chrome", onRevoke: async () => { calls.push("detach"); }, send: (m) => calls.push(`send:${m.granted}:${m.gen}`), badge: (b) => calls.push(`badge:${b.text}`) });
  await B.setAccess({ granted: true });
  assert(calls.join() === `send:true:${B.currentGen()},badge:ON`, "grant: access envelope sent, badge ON");
  calls.length = 0;
  await B.setAccess({ granted: false });
  assert(calls.join() === `detach,send:false:${B.currentGen()},badge:`, "revoke: detach, then envelope, then grey badge, in order");
  assert(B.badgeState({ granted: true, until: null }).text === "ON" && B.badgeState({ granted: true, until: Date.now() + 2.5 * 3600e3 }).text === "2h" && B.badgeState({ granted: true, until: Date.now() + 45 * 60e3 }).text === "45m" && B.badgeState({ granted: false, until: null }).text === "" && B.badgeState({ granted: false, until: null }).color !== B.badgeState({ granted: true, until: null }).color, "badgeState");
  // onInstalled → revoked, bumped gen, notice
  await B.setAccess({ granted: true }); gg = B.currentGen();
  await B.onInstalled();
  assert((await B.readAccess()).granted === false && B.currentGen() === gg + 1 && /reloaded/.test((await B.notices())[0]), "onInstalled revokes with a bumped gen and sets the notice");
  await B.dismissNotices(); assert((await B.notices()).length === 0, "dismissNotices");
  // init reconciliation
  await S.chrome.storage.local.set({ access: { granted: true, until: Date.now() - 1, gen: 40 } });
  await B.init();
  assert((await B.readAccess()).granted === false && B.currentGen() === 41, "init: expired grant revoked at startup");
  await S.chrome.storage.local.set({ access: { granted: true, until: Date.now() + 3600e3, gen: 50 } }); S.alarms.list.length = 0;
  await B.init();
  assert(B.currentGen() === 50 && S.alarms.list.some((x) => x.name === "access-expiry-50"), "init: missing expiry alarm recreated, gen loaded from the record");
  await B.assertAccess(50);
  assert(true, "init: a live grant stays live and passes the check");
  // popup helpers
  await S.chrome.storage.session.set({ agentTabs: [] });
  await B.rememberAgentTab(70); await B.rememberAgentTab(71);
  const cl = await B.closeAgentTabs();
  assert(JSON.stringify(cl.closed) === "[70,71]" && (await B.readAccess()).granted === true && (await B.agentTabIds()).length === 0, "Close agent tabs closes every agent tab and leaves access unchanged");
  const st = await B.status();
  assert(st.granted === true && st.remainingMs > 0 && st.gen === 50 && /^[0-9a-f]{32}$/.test(st.browserSession) && Array.isArray(st.notices), "status() for the popup");

  // ---- pending tabs / downloads, reconciliation (Task 3) -----------------
  await B.setAccess({ granted: true }); let g6 = B.currentGen();
  let n = await B.beginTab({ gen: g6, origin: "https://a.example" });
  assert((await S.chrome.storage.session.get("pendingTabs")).pendingTabs.length === 1, "beginTab records a pending entry before creation");
  assert((await B.completeTab(n, 300)) === true && (await B.agentTabIds()).includes(300) && (await S.chrome.storage.session.get("pendingTabs")).pendingTabs.length === 0, "completeTab adopts the tab under a live grant");
  n = await B.beginTab({ gen: g6, origin: "https://a.example" });
  await B.setAccess({ granted: false });
  assert((await B.completeTab(n, 301)) === false && S.removed.includes(301) && !(await B.agentTabIds()).includes(301), "a tab whose creation completes after a revoke is closed, not adopted");
  // downloads
  await B.setAccess({ granted: true }); g6 = B.currentGen();
  n = await B.beginDownload({ gen: g6, origin: "https://d.example" });
  S.downloads.items.push({ id: 9, state: "in_progress", byExtensionId: "ext-id", startTime: new Date().toISOString() });
  assert((await B.completeDownload(n, 9)) === true && (await S.chrome.storage.local.get("bridgeDownloads")).bridgeDownloads[9].gen === g6 && (await S.chrome.storage.local.get("pendingDownloads")).pendingDownloads.length === 0, "completeDownload records ownership in local storage");
  n = await B.beginDownload({ gen: g6, origin: "https://d.example" });
  S.downloads.items.push({ id: 10, state: "in_progress", byExtensionId: "ext-id", startTime: new Date().toISOString() });
  await B.setAccess({ granted: false });
  assert(S.downloads.cancelled.includes(9), "revoke cancels the in-progress bridge download");
  assert((await B.completeDownload(n, 10)) === false && S.downloads.cancelled.includes(10), "a download whose id arrives after a revoke is cancelled");
  S.downloads.items.push({ id: 11, state: "complete", byExtensionId: "ext-id", startTime: new Date().toISOString() });
  await S.chrome.storage.local.set({ bridgeDownloads: { 11: { gen: 1 } } });
  await B.setAccess({ granted: true }); await B.setAccess({ granted: false });
  assert(!S.downloads.cancelled.includes(11), "a finished download is left alone");
  // reconciliation at worker start
  await S.chrome.storage.session.set({ agentTabs: [300, 999], pendingTabs: [{ nonce: "x", gen: 1, origin: "o", startedAt: Date.now() - 1000 }] });
  S.tabs.list = [{ id: 300 }];
  const started = Date.now() - 500;
  await S.chrome.storage.local.set({ pendingDownloads: [{ nonce: "p", gen: 1, origin: "o", startedAt: started }], bridgeDownloads: { 9: { gen: 1 }, 404: { gen: 1 } } });
  S.downloads.items.push({ id: 12, state: "in_progress", byExtensionId: "ext-id", startTime: new Date(started + 10).toISOString() });
  S.downloads.items.push({ id: 13, state: "in_progress", byExtensionId: "other", startTime: new Date(started + 20).toISOString() });
  const rr = await B.reconcileOwnership();
  assert(JSON.stringify(await B.agentTabIds()) === "[300]" && rr.droppedTabs === 1, "reconcile: agent tabs that no longer exist are dropped");
  const bd = (await S.chrome.storage.local.get("bridgeDownloads")).bridgeDownloads;
  assert(!bd[404] && bd[12] && !bd[13] && bd[9] && rr.adoptedDownloads === 1 && rr.droppedDownloads === 1, "reconcile: pending download adopted by byExtensionId filter, foreign one ignored, stale record dropped");
  assert(rr.unidentifiedTabs === 1 && (await S.chrome.storage.session.get("pendingTabs")).pendingTabs.length === 0 && /1 tab\(s\) the agent may have opened could not be identified/.test((await B.notices()).join()), "reconcile: pending tab dropped and counted, never guessed");
  await B.dismissNotices();

  // ---- review fixes (Astra on access-switch) --------------------------------
  B.configure({ onRevoke: async () => { calls.push("detach"); }, send: () => {}, badge: () => {}, sessionName: async () => "chrome" });
  // (1) remote closeTabs is generation-aware: a revoke during its ownership read stops it
  await B.setAccess({ granted: true }); let g7 = B.currentGen();
  await S.chrome.storage.session.set({ agentTabs: [400] });
  S.mem.pauseNext("session", "get");
  const closing = B.closeOwnedTabs([400], { gen: g7 });
  await sleep(5);
  await B.setAccess({ granted: false });
  S.mem.resume();
  err = await closing.then(() => null, (e) => e.message);
  assert(/^access_revoked:/.test(err) && !S.removed.includes(400), "remote closeTabs: revoke during the ownership read → access_revoked, tab untouched");
  assert(JSON.stringify((await B.closeOwnedTabs([400])).closed) === "[400]", "trusted closeTabs (popup/revoke path, no gen) still closes");
  // (2) completeTab / completeDownload re-check the generation after their storage read
  await B.setAccess({ granted: true }); g7 = B.currentGen();
  let nonce = await B.beginTab({ gen: g7, origin: "https://a.example" });
  S.mem.pauseNext("local", "get"); // the completion's access read is in flight: its reply (granted) is delivered after the revoke completed
  const completing = B.completeTab(nonce, 401);
  await sleep(5);
  await B.setAccess({ granted: false });
  S.mem.resume();
  assert((await completing) === false && S.removed.includes(401) && !(await B.agentTabIds()).includes(401), "completeTab: a revoke completing during its access read → tab closed, not adopted");
  await B.setAccess({ granted: true }); g7 = B.currentGen();
  nonce = await B.beginDownload({ gen: g7, origin: "https://d.example" });
  S.downloads.items.push({ id: 30, state: "in_progress", byExtensionId: "ext-id", startTime: new Date().toISOString() });
  S.mem.pauseNext("local", "get", { skip: 2 }); // pending read, ownership read pass; the access read parks
  const completingD = B.completeDownload(nonce, 30);
  await sleep(5);
  await B.setAccess({ granted: false });
  S.mem.resume();
  assert((await completingD) === false && S.downloads.cancelled.includes(30), "completeDownload: a revoke completing during its access read → not adopted, download cancelled");
  // (3) a failed revoke write still denies
  await B.setAccess({ granted: true }); g7 = B.currentGen();
  calls.length = 0;
  S.mem.failNext("local");
  const failedRevoke = await B.setAccess({ granted: false }).then(() => "ok", (e) => `threw: ${e.message}`);
  const g8 = B.currentGen();
  err = await B.assertAccess(g8).then(() => null, (e) => e.message);
  assert(/^access_revoked:/.test(err), `failed revoke write: the new generation is still denied (${failedRevoke})`);
  err = await B.dispatch(g8, () => "ran").then((v) => v, (e) => e.message);
  assert(/^access_revoked:/.test(err), "failed revoke write: dispatch refuses");
  assert(calls.includes("detach"), "failed revoke write: cleanup (detach) still ran");
  err = await B.assertAccess(g7).then(() => null, (e) => e.message);
  assert(/^access_revoked:/.test(err), "failed revoke write: the old generation is denied too");
  // (3b) a record whose gen does not match the in-memory generation is revoked
  await B.setAccess({ granted: true }); g7 = B.currentGen();
  await S.chrome.storage.local.set({ access: { granted: true, until: null, gen: g7 - 1 } });
  err = await B.assertAccess(g7).then(() => null, (e) => e.message);
  assert(/^access_revoked:/.test(err), "a stored record with a stale gen reads as revoked");
  // (4) access-set parsing: JSON transport turns NaN into null; a timed request must not become indefinite
  assert(B.parseAccessSet({ granted: true, until: null }).until === null && B.parseAccessSet({ granted: true, until: null }).granted === true, "parseAccessSet: indefinite grant");
  const rt = JSON.parse(JSON.stringify({ granted: true, until: NaN, timed: true }));
  assert(B.parseAccessSet(rt).error && !B.parseAccessSet(rt).granted, "parseAccessSet: timed request with until lost in transport → error, no grant");
  assert(B.parseAccessSet({ granted: true, until: Date.now() + 1000, timed: true }).granted === true, "parseAccessSet: timed grant");
  assert(B.parseAccessSet({ granted: true, until: 5, timed: true }).error, "parseAccessSet: timed grant in the past → error");
  assert(B.parseAccessSet({ granted: false, until: null }).granted === false && !B.parseAccessSet({ granted: false }).error, "parseAccessSet: revoke");
  assert(B.parseAccessSet({ granted: true, until: null, timed: true }).error, "parseAccessSet: timed:true with null until → error");
  // (5) startup: pending downloads are reconciled before the revoke sweep, and an already-revoked start cancels in-progress bridge downloads
  const st5 = Date.now() - 500;
  await S.chrome.storage.local.set({ access: { granted: true, until: Date.now() - 1, gen: 60 }, pendingDownloads: [{ nonce: "q", gen: 60, origin: "o", startedAt: st5 }], bridgeDownloads: {} });
  S.downloads.items.push({ id: 20, state: "in_progress", byExtensionId: "ext-id", startTime: new Date(st5 + 5).toISOString() });
  await B.init();
  assert((await B.readAccess()).granted === false && S.downloads.cancelled.includes(20), "init: a pending download recovered at an expired-grant startup is cancelled");
  await S.chrome.storage.local.set({ access: { granted: false, until: null, gen: 61 }, bridgeDownloads: { 21: { gen: 60 } }, pendingDownloads: [] });
  S.downloads.items.push({ id: 21, state: "in_progress", byExtensionId: "ext-id", startTime: new Date().toISOString() });
  await B.init();
  assert(S.downloads.cancelled.includes(21), "init: an already-revoked start still cancels in-progress bridge downloads");
  // (6) a failed access read invalidates the cached authorisation
  await B.setAccess({ granted: true }); g7 = B.currentGen(); await B.assertAccess(g7);
  S.mem.failNext("local");
  await B.readAccess();
  err = await B.dispatch(g7, () => "ran").then((v) => v, (e) => e.message);
  assert(/^access_revoked:/.test(err), "dispatch refuses after a failed access read");
  // (9) a stale expiry alarm whose read overlaps a renewal never revokes the renewed grant
  await B.setAccess({ granted: true, until: Date.now() + 3600e3 }); const gA = B.currentGen();
  S.mem.pauseNext("local", "get");
  const alarmP = B.onAlarm(`access-expiry-${gA}`);
  await sleep(5);
  const renew = B.setAccess({ granted: true });
  await sleep(5);
  S.mem.resume();
  await alarmP; await renew;
  assert((await B.readAccess()).granted === true, "an alarm racing a renewal cannot revoke the renewed grant");

  // ---- background.js wiring (source level) -------------------------------
  const src = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");
  assert(/^importScripts\("access\.js"\);/m.test(src), "background.js imports access.js");
  assert(/case "closeTabs"/.test(src) && /closeOwnedTabs\(/.test(src), "background.js handles closeTabs via BridgeAccess");
  assert(/agentTabs:/.test(src) && /agentTabIds\(\)/.test(src), "background.js status reports agentTabs");
  assert(/rememberAgentTab\(|completeTab\(/.test(src) && /forgetAgentTab\(/.test(src), "background.js records opened/closed tabs");
  assert(/accessMessage\(/.test(src) && /msg\.type === "auth"/.test(src), "background.js sends the access message after auth");
  assert(/session: "chrome"/.test(src), "DEFAULTS has the session name");
  const closeTabCase = /case "closeTab":([\s\S]*?)return \{ ok: true \};/.exec(src);
  assert(closeTabCase && /assertAllowed\(p\.tabId\)/.test(closeTabCase[1]) && closeTabCase[1].indexOf("assertAllowed") < closeTabCase[1].indexOf("chrome.tabs.remove"), "closeTab checks the allowlist before removing a tab");

  // ---- Task 4: worker wiring ------------------------------------------------
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8"));
  assert(man.action && man.action.default_popup === "popup.html" && man.version === "0.1.11", "manifest: popup registered, version 0.1.11");
  assert(/BridgeAccess\.configure\(\{[\s\S]*?onRevoke[\s\S]*?send[\s\S]*?badge[\s\S]*?sessionName/.test(src), "worker configures the access hooks");
  assert(/await BridgeAccess\.init\(\)/.test(src), "worker runs init() at start");
  assert(/sock\.onmessage = async \(ev\) => \{\s*if \(ws !== sock\) return;/.test(src), "messages from a superseded socket are dropped");
  assert(/const gen = BridgeAccess\.currentGen\(\)/.test(src) && /await BridgeAccess\.assertAccess\(gen\)/.test(src) && /handle\(msg\.cmd, msg\.params \|\| \{\}, gen\)/.test(src), "every command captures gen and is checked before handle()");
  assert(/PASS_ALWAYS = new Set\(\["ping", "status"\]\)/.test(src), "ping/status bypass present");
  assert((src.match(/BridgeAccess\.dispatch\(gen, /g) || []).length >= 15, `browser operations go through dispatch(gen, …) (${(src.match(/BridgeAccess\.dispatch\(gen, /g) || []).length})`);
  // Every browser operation line (comments and the indicator's own injection, which only adds/removes a frame, excluded) is a dispatch line.
  const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/async function setIndicator[\s\S]*?\n}\n/, "");
  for (const re of [/chrome\.tabs\.create\(/, /chrome\.tabs\.update\(/, /chrome\.tabs\.remove\(/, /chrome\.debugger\.attach\(/, /chrome\.debugger\.sendCommand\(/, /chrome\.scripting\.executeScript\(/, /chrome\.userScripts\.execute\(/, /chrome\.downloads\.download\(/, /chrome\.tabs\.captureVisibleTab\(/, /chrome\.windows\.create\(/]) {
    const lines = code.split("\n").filter((l) => re.test(l) && !/BridgeAccess\.dispatch/.test(l));
    assert(lines.length === 0, `no bare ${re.source} outside dispatch (${lines.length} found)`);
  }
  assert(/case "reloadExtension":[\s\S]*?await BridgeAccess\.setAccess\(\{ granted: false, closeTabs: true, source: "reload" \}\)[\s\S]*?chrome\.runtime\.reload\(\)/.test(src), "reloadExtension revokes and closes agent tabs before reloading");
  assert(/chrome\.runtime\.onInstalled\.addListener\([\s\S]*?BridgeAccess\.onInstalled\(\)/.test(src), "onInstalled → revoked");
  assert(/chrome\.runtime\.onMessage\.addListener/.test(src) && /sender\.id === chrome\.runtime\.id/.test(src) && /startsWith\("chrome-extension:\/\/"\)/.test(src) && /unauthorised sender/.test(src), "runtime.onMessage validates the sender");
  for (const t of ["access-set", "access-get", "close-agent-tabs", "dismiss-notices"]) assert(src.includes(`"${t}"`), `onMessage handles ${t}`);
  assert(/manualMode/.test(src) && /chrome\.storage\.onChanged\.addListener/.test(src) && /source: "token-change"/.test(src), "manual mode and token-change revoke wired");
  assert(/BridgeAccess\.beginTab\(/.test(src) && /BridgeAccess\.completeTab\(/.test(src) && /BridgeAccess\.beginDownload\(/.test(src) && /BridgeAccess\.completeDownload\(/.test(src), "newTab/download use pending entries");
  assert(/TYPE_CHUNK = 20/.test(src), "direct type is chunked from the worker");
  assert(/access-expiry-/.test(src) && /BridgeAccess\.onAlarm\(/.test(src), "expiry alarms routed to BridgeAccess.onAlarm");
  assert(/async function dbg\(tabId, method, params, gen\) \{\s*await BridgeAccess\.assertAccess\(gen\);/.test(src), "every debugger command re-reads access before its synchronous dispatch");
  assert(/case "closeTabs":[\s\S]*?closeOwnedTabs\(p\.tabIds, \{ gen \}\)/.test(src), "remote closeTabs passes its generation");
  assert(/parseAccessSet\(/.test(src), "access-set goes through parseAccessSet");

  // ---- Task 5: popup and Options --------------------------------------------
  const pop = fs.readFileSync(path.join(__dirname, "..", "extension", "popup.js"), "utf8");
  const popHtml = fs.readFileSync(path.join(__dirname, "..", "extension", "popup.html"), "utf8");
  for (const t of ["access-set", "access-get", "close-agent-tabs", "dismiss-notices"]) assert(pop.includes(`"${t}"`), `popup sends ${t}`);
  assert(/3600e3|3600 \* 1000|60 \* 60 \* 1000/.test(pop), "popup has the 1-hour grant");
  for (const label of ["Grant", "Grant for 1 h", "Revoke", "Revoke and close agent tabs", "Close agent tabs"]) assert(popHtml.includes(label), `popup button: ${label}`);
  assert(/popup\.js/.test(popHtml) && !/<script>[^<]/.test(popHtml), "popup loads its script from a file (MV3 CSP)");
  const optHtml = fs.readFileSync(path.join(__dirname, "..", "extension", "options.html"), "utf8");
  const opt = fs.readFileSync(path.join(__dirname, "..", "extension", "options.js"), "utf8");
  assert(/Browser session name/.test(optHtml) && /Manual mode/.test(optHtml) && /revoked/.test(optHtml) && /survives browser restarts/.test(optHtml), "Options: session name, manual mode, hint");
  assert(/manualMode/.test(opt) && /session:/.test(opt) && /"access-set"/.test(opt), "Options saves session/manualMode and can grant/revoke");

  console.log(failures ? `\n${failures} TEST(S) FAILED` : "\nAll extension access tests passed.");
  process.exit(failures ? 1 : 0);
})();
