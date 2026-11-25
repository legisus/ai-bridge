# Access Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user grant and revoke the bridge's access to their Chrome session from the extension (popup and Options), with a fail-closed transition the service worker enforces on every command, and make `bridge agent` stop a run the moment access changes.

**Architecture:** `extension/access.js` (from slice 1) grows into the single writer of the `access` record: a serialised grant/revoke transition with an in-memory generation, `assertAccess(gen)` / `dispatch(gen, thunk)` checks, ownership bookkeeping for tabs and downloads with pending entries, expiry alarms, reload and startup reconciliation. `background.js` calls those checks at the start of every command and after every `await` before a browser operation, and gains a popup, Options fields and the `runtime.onMessage` handler the pages talk to. On the agent side a new `server/access-gate.js` pings the relay, latches the identity triple `(serverId, extGen, accessGen)` and aborts the running model child when anything changes; `restricted.js` passes the env the container needs.

**Tech Stack:** Node.js ≥ 18 CommonJS (`ws` only); MV3 extension in plain JS, classic service worker (`importScripts`), `chrome.storage.local/session`, `chrome.alarms`, `chrome.downloads`, `chrome.action`; tests are plain `node test/*.test.js` scripts in `npm test`, extension logic tested in Node with a stub `chrome`.

**Spec:** `docs/superpowers/specs/2026-11-21-docker-isolated-access-design.md`, sections *Goals/Anti-goals*, *Wire contract*, *Extension → Storage / Single writer / Revoke / Grant / Manual mode and reconnection / Popup and Options*, *Agent and channel runs*, *Tests*, *Open questions*. Builds on the `tab-hygiene` branch (PR #12): `extension/access.js` already provides `ensureBrowserSession`, `accessState`, `accessMessage`, `agentTabIds`, `rememberAgentTab`, `forgetAgentTab`, `closeOwnedTabs`; the relay already enforces the gate and the identity triple.

## Global Constraints

- Branch `access-switch` stacks on `tab-hygiene`; PR against `tab-hygiene`; Astra (`gpt-6-astra`) reviews before the user merges; no `Co-Authored-By` trailers.
- No new npm dependencies; no bundler; `background.js` stays a classic worker loading `access.js` with `importScripts`.
- Fail closed everywhere: a storage read failure, a missing record, a malformed `until` or `granted` all read as **revoked**. "A revoked session must never execute a browser operation after the revoke: not a queued screenshot, not the completion of an attach that was in flight, not the next tick of a poll, not the next character of a `type`."
- The service worker is the **only writer** of `access`. Pages send `chrome.runtime.sendMessage({type:"access-set", granted, until, closeTabs})`; the worker accepts it only when `sender.id === chrome.runtime.id` and `sender.url` starts with `chrome-extension://`.
- Transition order is fixed: bump `accessGen` and set `transition` **before** the storage write; `assertAccess(gen)` compares the generation, awaits `transition`, reads storage, **compares the generation again**, then returns; `dispatch(gen, thunk)` re-compares generation and deadline synchronously and calls the thunk in the same tick.
- Error strings are exactly `access_revoked: access revoked by user (session "<name>")` and `access_not_granted: access not granted yet (session "<name>")` (same as `server/access.js`).
- Revoke steps, in order: write record; cancel every in-progress bridge download (all grants of this browser session); detach every attached and in-flight tab; if `closeTabs`, close every `agentTabs` tab; send the canonical `access` envelope; badge grey; clear the `access-expiry-<gen>` alarm. Grant: write record; clear all `access-expiry-*` alarms, create `access-expiry-<gen>` at `until` if set; send `access`; badge green `ON` or remaining time.
- `reloadExtension` runs the full revoke transition with `closeTabs:true` and awaits it before scheduling the reload; `chrome.runtime.onInstalled` writes `access:{granted:false}` with a bumped gen and sets the notice "access was revoked because the extension was reloaded; tabs opened before the reload are no longer tracked".
- Download records live in `chrome.storage.local`; tab records in `chrome.storage.session`. A persisted numeric tab id never authorises closing a tab after a browser restart; pending tabs are never guessed from their URL.
- Agent: one gate wraps every model spawn (rungs, judge, classifier, repair, `runTurn`); the pre-flight requires `access === "granted"` and latches the triple; the check runs before every spawn and every 10 s while a child runs; any change, a non-granted state, `extension not connected`, a malformed reply, or two consecutive 5-s ping timeouts end the run with the terminal error `access_revoked`; the ladder does not climb on it.
- `cleanEnv` passes `AI_BRIDGE_HOME`, `AI_BRIDGE_DEBUGGER`, `AI_BRIDGE_CODEX_SANDBOX`; every `AI_BRIDGE_*_TOKEN` stays denied.

## Plan decisions

1. **Storage keys.** The session name stays under the key `session` (shipped in slice 1 as `DEFAULTS.session` and `status.session`), not `sessionName`; `agentTabs` stays `number[]` (gen is "for logging only"); pending entries store the **origin**, not the URL. The spec's storage list is amended accordingly (Task 8).
2. **Hooks instead of chrome calls inside `access.js`.** Detaching, sending the `access` envelope and the badge are worker concerns; `access.js` takes them through `BridgeAccess.configure({ onRevoke, send, badge, sessionName, log })` so the transition is testable in Node and `background.js` keeps its debugger code.
3. **Deadline source for `dispatch`.** The synchronous re-check uses the record `assertAccess` last read (`lastRecord.until`); a timed grant is live only while `Date.now() < until`.
4. **`not_granted` vs `revoked` in the extension.** The extension answers `access_not_granted` when no `access` record exists in storage, `access_revoked` in every other non-granted case.
5. **`type` in direct mode** moves into the worker in chunks of 20 characters (one `scripting.executeScript` per chunk, `assertAccess` between chunks), the alternative the spec's open question allows; debugger mode checks between every character as the spec says.
6. **Agent gate is its own module** (`server/access-gate.js`) with an injectable `ping`; `runAgent` and `runTurn` take it through `deps.accessGate` / option `accessGate`; the 10-s poll and 5-s timeout are constructor options so tests run in milliseconds. `main`'s existing CLI pre-flight is replaced by the gate's pre-flight inside `runAgent`.
7. **Channels daemon changes** (`/status` reporting access, refusing a task while revoked) are deferred to the channels follow-up: the daemon is paused and its bots deleted. `runTurn` is gated here, so a revoked turn still ends with `access_revoked`.
8. **Default after upgrade.** With this slice the stored default for an absent record flips to *revoked* and `onInstalled` writes revoked: after reloading the extension the user grants once in the popup. The guide says so.
9. **Version** bumps to 0.1.11 (manifest + package.json), matching the spec's `ping` example.
10. **`AI_BRIDGE_CLIENT`** joins `cleanEnv`'s keep list with the three spec'd keys so restricted children keep their client label.

## Review Focus

1. `access-set` with `until` in the past, `0`, `NaN` or a string must never produce a grant. (Task 1)
2. Grant and Revoke clicked almost together must serialise, end in the last one's state, and never leave a command with a stale generation passing. (Task 1)
3. `chrome.alarms.create` failing or unavailable must not make a timed grant indefinite: the deadline is enforced by `assertAccess`/`dispatch` regardless. (Task 2)
4. A `runtime.onMessage` from a web page or another extension must be ignored; only the extension's own pages can change access. (Task 4)
5. The agent's `ping` returning non-JSON, an error exit, or `extension not connected` mid-run ends the run with `access_revoked`, not a crash or a climb. (Task 6)

---

### Task 1: Access record, serialised transition, `assertAccess` and `dispatch`

**Files:**
- Create: `test/helpers/stub-chrome.js`
- Modify: `extension/access.js`
- Modify: `test/extension.access.test.js`

**Interfaces:**
- Produces `test/helpers/stub-chrome.js`: `stubChrome() → { chrome, mem, removed, failIds, alarms, downloads, badge, messages, tabs }` — promise-based `storage.local/session` (`get/set/remove/clear`, with `mem.failNext("local")` making the next `get` reject), `tabs.remove/query/create`, `downloads.download/search/cancel` (items in `downloads.items`, `search` honours `id`, `state`, `startedAfter`), `alarms.create/clear/clearAll/getAll` (in `alarms.list`; `alarms.failCreate = true` makes `create` throw), `action.setBadgeText/setBadgeBackgroundColor` (recorded in `badge`), `runtime.id = "ext-id"`, `runtime.reload` (counted). Every async call resolves on a later microtask so interleavings are real.
- Produces in `extension/access.js` (in addition to slice 1):
  - `configure({ onRevoke = async () => {}, send = () => {}, badge = () => {}, sessionName = async () => "chrome", log = () => {} })`.
  - `currentGen() → number` — in-memory `accessGen`, loaded from the stored record by `init()` (Task 2) or `0`.
  - `readAccess() → Promise<{ granted, until, gen, exists }>` — normalised: `exists` false when no record; any wrong shape → `granted:false`; a timed grant is `granted` only while `Date.now() < until`. **Replaces** slice 1's `accessState()` default: an absent record is now `{granted:false, until:null, gen:0, exists:false}`.
  - `setAccess({ granted, until = null, closeTabs = false, source = "popup" }) → Promise<record>` — the transition: validates (`granted === true` and (`until === null` or finite number `> Date.now()`), else the call is a **revoke**); serialised through one promise chain; `accessGen++` and `transition` set before the write; then the revoke/grant steps (Task 2 fills in alarms, downloads, tabs); resolves the written record.
  - `assertAccess(gen) → Promise<void>` — throws `Error(ACCESS_REVOKED(session))` when `gen !== accessGen` (checked before and after the read) or the record is not live, `Error(ACCESS_NOT_GRANTED(session))` when no record exists.
  - `dispatch(gen, thunk) → Promise<any>` — synchronous re-check of `gen` and `lastRecord.until`, then `thunk()` in the same tick; throws `ACCESS_REVOKED` otherwise.
  - `ACCESS_REVOKED(session)`, `ACCESS_NOT_GRANTED(session)` string builders (copied from `server/access.js`; the extension cannot `require` it).

- [ ] **Step 1: Write the failing tests** — move the stub out of `test/extension.access.test.js` into the helper, then add:

```js
const bsess = () => "chrome";
B.configure({ sessionName: async () => "work-chrome" });
// fail-closed record shapes
assert((await B.readAccess()).granted === false && (await B.readAccess()).exists === false, "absent record → revoked, exists:false");
for (const bad of [{ granted: true, until: "soon" }, { granted: true, until: 0 }, { granted: true, until: Date.now() - 1 }, { granted: "true", until: null }, { granted: true }, "junk"]) {
  await S.chrome.storage.local.set({ access: bad });
  assert((await B.readAccess()).granted === false, `malformed record ${JSON.stringify(bad)} → revoked`);
}
// grant / revoke transitions
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
// assertAccess: happy path, stale gen, not granted, revoked
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
const pending = B.assertAccess(g2);
await B.setAccess({ granted: false }); // bumps the gen while the read is parked
S.mem.resume();
err = null; try { await pending; } catch (e) { err = e.message; }
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
await new Promise((r) => setTimeout(r, 40));
ran = false; try { await B.dispatch(g4, () => { ran = true; }); } catch {}
assert(!ran, "dispatch refuses once the timed grant has expired");
// a command that starts during the write waits for it
S.mem.pauseNext("local", "set");
const t = B.setAccess({ granted: true });
const g5 = B.currentGen();
const waiting = B.assertAccess(g5);
let settled = false; waiting.then(() => { settled = true; }, () => { settled = true; });
await new Promise((r) => setTimeout(r, 10));
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
```

Update slice 1's assertions that relied on the *granted* default: "absent record → slice-1 default (granted)" becomes "absent record → revoked"; `accessMessage` with no record now reports `granted:false`.

- [ ] **Step 2: Run to verify it fails**

Run: `node test/extension.access.test.js`
Expected: FAIL — `B.configure is not a function`.

- [ ] **Step 3: Implement** the stub helper (`pauseNext(area, op = "get")`, `resume()`, `failNext(area)`) and the `access.js` additions. `accessMessage` now uses `readAccess`.

- [ ] **Step 4: Run to verify it passes**

Run: `node test/extension.access.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/stub-chrome.js extension/access.js test/extension.access.test.js
git commit -m "extension: access record with fail-closed read, serialised grant/revoke transition, assertAccess and dispatch"
```

---

### Task 2: Expiry alarms, hooks, reload and startup reconciliation, popup helpers

**Files:**
- Modify: `extension/access.js`
- Modify: `test/extension.access.test.js`

**Interfaces:**
- Consumes Task 1's `setAccess`, `configure`, `readAccess`.
- Produces in `extension/access.js`:
  - Grant step: `chrome.alarms.clear` for every `access-expiry-*` (via `getAll`), then `chrome.alarms.create("access-expiry-<gen>", { when: until })` when `until` is set; a throwing `alarms.create` is caught and logged, the grant still succeeds.
  - Revoke step: hooks `onRevoke()` awaited (detach), `send(accessMessage)`, `badge({granted:false})`; alarms cleared.
  - `onAlarm(name) → Promise<boolean>` — parses `access-expiry-<gen>`; revokes with `source:"alarm"` only when the stored record's `gen` equals it and it is still granted; returns whether it revoked.
  - `onInstalled() → Promise<void>` — `setAccess({granted:false, source:"reload"})` and `setNotice("access was revoked because the extension was reloaded; tabs opened before the reload are no longer tracked")`.
  - `init() → Promise<void>` — worker start: `ensureBrowserSession()`, `accessGen = record.gen`, reconcile: a past `until` → revoke (`source:"startup"`); a live timed grant with no `access-expiry-<gen>` alarm → alarm recreated; then Task 3's ownership reconciliation.
  - `notices() → Promise<string[]>`, `setNotice(text)`, `dismissNotices()` — `chrome.storage.local` key `notices`.
  - `badgeState(record, now) → { text: "ON" | "<n>h" | "<n>m" | "", color: "#1e8e3e" | "#9e9e9e" }` — pure; `"ON"` for indefinite, remaining time for a timed grant (hours when ≥ 60 min), empty grey when revoked.
  - `closeAgentTabs() → Promise<{ closed: number[] }>` — closes every `agentTabs` tab (all gens), access unchanged.
  - `status() → Promise<{ granted, until, gen, remainingMs, browserSession, notices }>` for the popup.

- [ ] **Step 1: Write the failing tests**

```js
// alarms
await B.setAccess({ granted: true, until: Date.now() + 3600e3 });
let g = B.currentGen();
assert(S.alarms.list.some((a) => a.name === `access-expiry-${g}` ) && S.alarms.list.length === 1, "timed grant creates access-expiry-<gen>");
await B.setAccess({ granted: true });
assert(S.alarms.list.length === 0, "indefinite grant clears expiry alarms");
await B.setAccess({ granted: true, until: Date.now() + 3600e3 }); g = B.currentGen();
assert((await B.onAlarm(`access-expiry-${g - 1}`)) === false && (await B.readAccess()).granted === true, "a stale alarm from an earlier grant does not revoke");
assert((await B.onAlarm(`access-expiry-${g}`)) === true && (await B.readAccess()).granted === false, "the current alarm revokes");
S.alarms.failCreate = true;
const rec = await B.setAccess({ granted: true, until: Date.now() + 30 });
assert(rec.granted === true, "alarm failure does not fail the grant");
await new Promise((r) => setTimeout(r, 40));
let err = null; try { await B.assertAccess(B.currentGen()); } catch (e) { err = e.message; }
assert(/^access_revoked:/.test(err), "…and the deadline still holds without the alarm");
S.alarms.failCreate = false;
// hooks
const calls = [];
B.configure({ sessionName: async () => "chrome", onRevoke: async () => { calls.push("detach"); }, send: (m) => calls.push(`send:${m.granted}:${m.gen}`), badge: (b) => calls.push(`badge:${b.text}`) });
await B.setAccess({ granted: true });
assert(calls.join() === `send:true:${B.currentGen()},badge:ON`, "grant: access envelope sent, badge ON");
calls.length = 0;
await B.setAccess({ granted: false });
assert(calls[0] === "detach" && calls[1] === `send:false:${B.currentGen()}` && calls[2] === "badge:", "revoke: detach, then envelope, then grey badge, in order");
// badgeState
assert(B.badgeState({ granted: true, until: null }).text === "ON" && B.badgeState({ granted: true, until: Date.now() + 2.5 * 3600e3 }).text === "2h" && B.badgeState({ granted: true, until: Date.now() + 45 * 60e3 }).text === "45m" && B.badgeState({ granted: false, until: null }).text === "", "badgeState");
// onInstalled → revoked, bumped gen, notice
await B.setAccess({ granted: true }); g = B.currentGen();
await B.onInstalled();
assert((await B.readAccess()).granted === false && B.currentGen() === g + 1 && /reloaded/.test((await B.notices())[0]), "onInstalled revokes with a bumped gen and sets the notice");
await B.dismissNotices(); assert((await B.notices()).length === 0, "dismissNotices");
// init reconciliation: past until → revoked; live grant without alarm → alarm recreated; gen loaded
await S.chrome.storage.local.set({ access: { granted: true, until: Date.now() - 1, gen: 40 } });
await B.init();
assert((await B.readAccess()).granted === false && B.currentGen() === 41, "init: expired grant revoked at startup");
await S.chrome.storage.local.set({ access: { granted: true, until: Date.now() + 3600e3, gen: 50 } }); S.alarms.list.length = 0;
await B.init();
assert(B.currentGen() === 50 && S.alarms.list.some((a) => a.name === "access-expiry-50"), "init: missing expiry alarm recreated, gen loaded from the record");
// popup helpers
await B.rememberAgentTab(70); await B.rememberAgentTab(71);
const c = await B.closeAgentTabs();
assert(JSON.stringify(c.closed) === "[70,71]" && (await B.readAccess()).granted === true && (await B.agentTabIds()).length === 0, "Close agent tabs closes every agent tab and leaves access unchanged");
const st = await B.status();
assert(st.granted === true && st.remainingMs > 0 && /^[0-9a-f]{32}$/.test(st.browserSession) && Array.isArray(st.notices), "status() for the popup");
```

- [ ] **Step 2: Run to verify it fails** — `node test/extension.access.test.js` → FAIL at "timed grant creates access-expiry-<gen>".
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run to verify it passes** — all PASS.
- [ ] **Step 5: Commit** — `git commit -m "extension: expiry alarms per generation, revoke/grant hooks and badge, reload and startup reconciliation, popup helpers"`.

---

### Task 3: Ownership with pending entries — tabs and downloads

**Files:**
- Modify: `extension/access.js`
- Modify: `test/extension.access.test.js`

**Interfaces:**
- Produces in `extension/access.js`:
  - `beginTab({ gen, origin }) → Promise<string nonce>` — appends to session `pendingTabs` `[{nonce, gen, origin, startedAt}]` **before** the caller creates the tab.
  - `completeTab(nonce, tabId) → Promise<boolean>` — removes the pending entry; when `gen === currentGen()` and the record is granted: `rememberAgentTab(tabId)`, returns `true`; otherwise closes the tab itself (`chrome.tabs.remove`) and returns `false` (the caller reports `access_revoked`).
  - `beginDownload({ gen, origin }) → Promise<string nonce>` / `completeDownload(nonce, downloadId) → Promise<boolean>` — local `pendingDownloads` / `bridgeDownloads: {[id]: {gen}}`; on a moved gen the download is cancelled and `false` returned.
  - `cancelBridgeDownloads() → Promise<{ cancelled: number[] }>` — every `bridgeDownloads` id whose `downloads.search({id})` item is `in_progress` is cancelled; finished ones left alone; records of ids that no longer exist dropped. Called by the revoke step (Task 2) **before** `onRevoke`.
  - `reconcileOwnership() → Promise<{ droppedTabs, droppedDownloads, adoptedDownloads, unidentifiedTabs }>` — called from `init()`: `agentTabs` filtered by `chrome.tabs.query({})`; `bridgeDownloads` filtered by `downloads.search({})`; each `pendingDownloads` entry matched by `downloads.search({ startedAfter: new Date(startedAt).toISOString(), orderBy: ["-startTime"] })` filtered on `item.byExtensionId === chrome.runtime.id` and adopted (first match) or dropped; every `pendingTabs` entry dropped and counted into the notice `"N tab(s) the agent may have opened could not be identified"` (no notice when 0).

- [ ] **Step 1: Write the failing tests**

```js
await B.setAccess({ granted: true }); let g = B.currentGen();
let n = await B.beginTab({ gen: g, origin: "https://a.example" });
assert((await S.chrome.storage.session.get("pendingTabs")).pendingTabs.length === 1, "beginTab records a pending entry before creation");
assert((await B.completeTab(n, 300)) === true && (await B.agentTabIds()).includes(300) && (await S.chrome.storage.session.get("pendingTabs")).pendingTabs.length === 0, "completeTab adopts the tab under a live grant");
n = await B.beginTab({ gen: g, origin: "https://a.example" });
await B.setAccess({ granted: false });
assert((await B.completeTab(n, 301)) === false && S.removed.includes(301) && !(await B.agentTabIds()).includes(301), "a tab whose creation completes after a revoke is closed, not adopted");
// downloads
await B.setAccess({ granted: true }); g = B.currentGen();
n = await B.beginDownload({ gen: g, origin: "https://d.example" });
S.downloads.items.push({ id: 9, state: "in_progress", byExtensionId: "ext-id", startTime: new Date().toISOString() });
assert((await B.completeDownload(n, 9)) === true && (await S.chrome.storage.local.get("bridgeDownloads")).bridgeDownloads[9].gen === g, "completeDownload records ownership in local storage");
n = await B.beginDownload({ gen: g, origin: "https://d.example" });
S.downloads.items.push({ id: 10, state: "in_progress", byExtensionId: "ext-id", startTime: new Date().toISOString() });
await B.setAccess({ granted: false });
assert((await B.completeDownload(n, 10)) === false && S.downloads.cancelled.includes(10), "a download whose id arrives after a revoke is cancelled");
assert(S.downloads.cancelled.includes(9), "revoke cancels the in-progress bridge download");
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
const r = await B.reconcileOwnership();
assert(JSON.stringify(await B.agentTabIds()) === "[300]" && r.droppedTabs === 1, "reconcile: agent tabs that no longer exist are dropped");
const bd = (await S.chrome.storage.local.get("bridgeDownloads")).bridgeDownloads;
assert(!bd[404] && bd[12] && !bd[13] && r.adoptedDownloads === 1, "reconcile: pending download adopted by byExtensionId filter, foreign one ignored, stale record dropped");
assert(r.unidentifiedTabs === 1 && (await S.chrome.storage.session.get("pendingTabs")).pendingTabs.length === 0 && /1 tab\(s\) the agent may have opened could not be identified/.test((await B.notices()).join()), "reconcile: pending tab dropped and counted, never guessed");
```

- [ ] **Step 2: Run to verify it fails** — FAIL at "beginTab records a pending entry".
- [ ] **Step 3: Implement.** `init()` (Task 2) calls `reconcileOwnership()` last.
- [ ] **Step 4: Run** — all PASS.
- [ ] **Step 5: Commit** — `git commit -m "extension: pending tab/download entries, ownership completion after a revoke closes or cancels, startup reconciliation with byExtensionId"`.

---

### Task 4: Service-worker wiring — checks on every command, messages from pages, manual mode

**Files:**
- Modify: `extension/background.js`
- Modify: `extension/manifest.json` (`action.default_popup`, version 0.1.11)
- Modify: `test/extension.access.test.js` (source-level wiring assertions)

**Interfaces:**
- Consumes Tasks 1–3.
- Produces in `background.js`:
  - Worker start: `BridgeAccess.configure({ onRevoke: detachEverything, send: sendAccess, badge: setBadge, sessionName: async () => (await config()).session })`; `await BridgeAccess.init()` before `connect()` (`connect()` awaits an `initDone` promise).
  - `sock.onmessage`: `if (ws !== sock) return;` first; on `auth ok` send `accessMessage`; for a command: `const gen = BridgeAccess.currentGen()`; `ping`/`status` run unchecked; every other command: `await BridgeAccess.assertAccess(gen)` then `handle(msg.cmd, msg.params, gen)`; `access_*` errors are returned as the error string unchanged.
  - `handle(cmd, p, gen)`: after every `await` that precedes a browser operation `await BridgeAccess.assertAccess(gen)`; every `chrome.tabs.*`, `chrome.debugger.*`, `chrome.scripting.*`, `chrome.userScripts.*`, `chrome.downloads.*` call that acts on the browser goes through `BridgeAccess.dispatch(gen, () => …)` (`setIndicator` and `detachTab` excepted: they only remove). `dbgAttach(tabId, gen)` re-checks after the attach promise resolves and detaches itself on failure; `pacedCapture(windowId, gen)` checks before each capture; `waitFor` checks on every tick; direct `type` runs in 20-character chunks from the worker with a check between chunks, debugger `type` checks between characters; `newTab` uses `beginTab`/`completeTab` (a `false` completion throws `ACCESS_REVOKED`); `download` uses `beginDownload`/`completeDownload`.
  - `reloadExtension`: `await BridgeAccess.setAccess({ granted: false, closeTabs: true, source: "reload" })` then schedule `chrome.runtime.reload()`.
  - Listeners: `chrome.runtime.onInstalled` → `BridgeAccess.onInstalled()` then `connect()`; `chrome.runtime.onStartup` → `init` then `connect`; `chrome.alarms.onAlarm` → `BridgeAccess.onAlarm(a.name)` for `access-expiry-*`, badge refresh on `reconnect`; `chrome.runtime.onMessage` handles `{type:"access-set", granted, until, closeTabs}`, `{type:"access-get"}` → `status()`, `{type:"close-agent-tabs"}`, `{type:"dismiss-notices"}` only when `sender.id === chrome.runtime.id && String(sender.url || "").startsWith("chrome-extension://")`, replying `{ok:false, error:"unauthorised sender"}` otherwise.
  - `manualMode` (`DEFAULTS.manualMode = false`): `provisionViaNativeHost` returns immediately when set; `chrome.storage.onChanged` on `token`/`port`: `await BridgeAccess.setAccess({ granted: false, source: "token-change" })`, close `ws`, `connect()`.
  - `setBadge({text, color})` via `chrome.action.setBadgeText/BackgroundColor`; `detachEverything()` awaits in-flight attaches then detaches and clears indicators.

- [ ] **Step 1: Write the failing source-level assertions** (background.js cannot load in Node; the behaviours are covered by Tasks 1–3 and the manual rows):

```js
const src = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");
const man = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8"));
assert(man.action && man.action.default_popup === "popup.html" && man.version === "0.1.11", "manifest: popup registered, version 0.1.11");
assert(/BridgeAccess\.configure\(\{[\s\S]*onRevoke[\s\S]*send[\s\S]*badge[\s\S]*sessionName/.test(src), "worker configures the access hooks");
assert(/await BridgeAccess\.init\(\)/.test(src), "worker runs init() at start");
assert(/sock\.onmessage = async \(ev\) => \{\s*if \(ws !== sock\) return;/.test(src), "messages from a superseded socket are dropped");
assert(/const gen = BridgeAccess\.currentGen\(\)/.test(src) && /await BridgeAccess\.assertAccess\(gen\)/.test(src) && /handle\(msg\.cmd, msg\.params \|\| \{\}, gen\)/.test(src), "every command captures gen and is checked before handle()");
assert(!/PASS_ALWAYS|\["ping", "status"\]/.test(src) || /ping|status/.test(src), "ping/status bypass present");
assert((src.match(/BridgeAccess\.dispatch\(gen, /g) || []).length >= 25, "browser operations go through dispatch(gen, …)");
for (const re of [/chrome\.tabs\.create\(/, /chrome\.tabs\.update\(/, /chrome\.tabs\.remove\(/, /chrome\.debugger\.attach\(/, /chrome\.debugger\.sendCommand\(/, /chrome\.scripting\.executeScript\(/, /chrome\.userScripts\.execute\(/, /chrome\.downloads\.download\(/, /chrome\.tabs\.captureVisibleTab\(/]) {
  const lines = src.split("\n").filter((l) => re.test(l) && !/setIndicator|detachTab|BridgeAccess\.dispatch|__owned__/.test(l));
  assert(lines.length === 0, `no bare ${re.source} outside dispatch (${lines.length} found)`);
}
assert(/case "reloadExtension":[\s\S]*?await BridgeAccess\.setAccess\(\{ granted: false, closeTabs: true, source: "reload" \}\)[\s\S]*?chrome\.runtime\.reload\(\)/.test(src), "reloadExtension revokes and closes agent tabs before reloading");
assert(/chrome\.runtime\.onInstalled\.addListener\([\s\S]*?BridgeAccess\.onInstalled\(\)/.test(src), "onInstalled → revoked");
assert(/chrome\.runtime\.onMessage\.addListener/.test(src) && /sender\.id === chrome\.runtime\.id/.test(src) && /startsWith\("chrome-extension:\/\/"\)/.test(src) && /unauthorised sender/.test(src), "runtime.onMessage validates the sender");
for (const t of ["access-set", "access-get", "close-agent-tabs", "dismiss-notices"]) assert(src.includes(`"${t}"`), `onMessage handles ${t}`);
assert(/manualMode/.test(src) && /chrome\.storage\.onChanged\.addListener/.test(src) && /source: "token-change"/.test(src), "manual mode and token-change revoke wired");
assert(/BridgeAccess\.beginTab\(/.test(src) && /BridgeAccess\.completeTab\(/.test(src) && /BridgeAccess\.beginDownload\(/.test(src) && /BridgeAccess\.completeDownload\(/.test(src), "newTab/download use pending entries");
assert(/TYPE_CHUNK = 20/.test(src), "direct type is chunked from the worker");
```

- [ ] **Step 2: Run to verify it fails** — FAIL at "manifest: popup registered".
- [ ] **Step 3: Implement** the wiring. Then load it in the real Chrome: `node server/cli.js reloadExtension`, then `ping` (relay old: `pong`), `status` (shows `session`, `agentTabs`), and `newTab` must now fail with `access_not_granted…` from the extension until a grant (the popup arrives in Task 5; for this step grant via the worker console: `BridgeAccess.setAccess({granted:true})`). Record the outcome in the commit message.
- [ ] **Step 4: Run** `node test/extension.access.test.js && node --check extension/background.js` — PASS, no syntax error.
- [ ] **Step 5: Commit** — `git commit -m "extension: access checks on every command (assertAccess + dispatch), pending tab/download ownership, reload revokes first, page messages with sender validation, manual mode"`.

---

### Task 5: Popup and Options

**Files:**
- Create: `extension/popup.html`, `extension/popup.js`
- Modify: `extension/options.html`, `extension/options.js`
- Modify: `test/extension.access.test.js` (source-level assertions)

**Interfaces:**
- Consumes the `runtime.onMessage` types from Task 4.
- Produces `popup.html/js`: session name, connection state (from `status` message: `connected` boolean added to `access-get`'s reply by the worker), access state with remaining time, notices with a dismiss link, buttons **Grant**, **Grant for 1 h** (`until = Date.now() + 3600e3`), **Revoke**, **Revoke and close agent tabs**, **Close agent tabs**; refreshes every second while open.
- Produces in Options: **Browser session name** (`session`, 1–40 printable chars, default `chrome`), **Manual mode** checkbox (`manualMode`; pasting a token different from the stored one sets it), the same Grant/Revoke buttons, and the hint "After install the bridge is revoked; a grant survives browser restarts but not an extension reload."

- [ ] **Step 1: Write the failing assertions**

```js
const pop = fs.readFileSync(path.join(__dirname, "..", "extension", "popup.js"), "utf8");
const popHtml = fs.readFileSync(path.join(__dirname, "..", "extension", "popup.html"), "utf8");
for (const t of ["access-set", "access-get", "close-agent-tabs", "dismiss-notices"]) assert(pop.includes(`"${t}"`), `popup sends ${t}`);
assert(/3600e3|3600 \* 1000|60 \* 60 \* 1000/.test(pop), "popup has the 1-hour grant");
for (const label of ["Grant", "Grant for 1 h", "Revoke", "Revoke and close agent tabs", "Close agent tabs"]) assert(popHtml.includes(label), `popup button: ${label}`);
const optHtml = fs.readFileSync(path.join(__dirname, "..", "extension", "options.html"), "utf8");
const opt = fs.readFileSync(path.join(__dirname, "..", "extension", "options.js"), "utf8");
assert(/Browser session name/.test(optHtml) && /Manual mode/.test(optHtml) && /revoked/.test(optHtml) && /survives browser restarts/.test(optHtml), "Options: session name, manual mode, hint");
assert(/manualMode/.test(opt) && /session:/.test(opt) && /"access-set"/.test(opt), "Options saves session/manualMode and can grant/revoke");
```

- [ ] **Step 2: Run to verify it fails** — FAIL: `popup.js` missing.
- [ ] **Step 3: Implement** the pages (plain HTML/JS, same style as Options). Load in the real Chrome once: reload, open the popup, **Grant**, `node server/cli.js newTab '{"url":"https://example.com"}'` succeeds, **Revoke**, the same command exits 8 with `access_revoked…` from the extension (the relay on the Mac is still the old one and forwards everything). Record in the commit message.
- [ ] **Step 4: Run** `node test/extension.access.test.js` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "extension: popup with Grant / Grant for 1 h / Revoke / Revoke and close agent tabs / Close agent tabs; Options gains session name, manual mode and the access buttons"`.

---

### Task 6: Agent access gate (`withAccess`)

**Files:**
- Create: `server/access-gate.js`
- Modify: `server/agent.js` (`runAgent`, `runTurn`, `main`)
- Create: `test/agent.access.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces `server/access-gate.js`:
  - `class AccessError extends Error` — `name: "AccessError"`, `code: "access_revoked"`, `message` starts with `access_revoked: ` followed by the reason (`access revoked by user (session "x")`, `access not granted yet (session "x")`, `identity changed (serverId|extGen|accessGen)`, `extension not connected`, `malformed ping reply`, `ping timed out twice`).
  - `defaultPing({ timeoutMs }) → Promise<object>` — spawns `selfArgs(["ping", "--timeout", String(timeoutMs)])`, parses the first stdout line as JSON; rejects with `Error("timeout")` after `timeoutMs`, with the CLI's error text on a non-zero exit.
  - `createAccessGate({ ping = defaultPing, intervalMs = 10000, timeoutMs = 5000 } = {}) → gate` with `gate.preflight() → Promise<{serverId, extGen, accessGen, session}>` (throws `AccessError` unless `access === "granted"` and the three fields are present; latches them), `gate.check() → Promise<void>` (throws `AccessError` on any triple change, non-granted, malformed reply, `extension not connected`, or the second consecutive timeout; a single timeout is tolerated and the counter resets on success), `gate.identity` (latched triple or `null`).
  - `withAccess(gate, run, opts) → Promise<result>` — `await gate.check()`; creates an `AbortController` chained to `opts.signal`; starts `setInterval(gate.check, intervalMs)` whose failure aborts the controller and remembers the `AccessError`; `await run({ ...opts, signal: controller.signal })`; on any rejection, if an `AccessError` was remembered throw it instead; always clears the interval.
- Produces in `server/agent.js`: `runAgent(task, opts, run, deps)` — `const gate = D.accessGate || createAccessGate()`; after the lease is opened (before any `run`): `const identity = await gate.preflight()`; every `run(...)` call in `runAgent` (classifier, rungs, approval retries, judge, repair via `D.propose`'s `run`) goes through `guarded = (o) => withAccess(gate, run, o)`; an `AccessError` anywhere ends the ladder: `finalVerdict = { verdict: "fail", feedback: e.message }`, `blocker = "access_revoked"`, no further rung, no repair/learn; the journal record carries `blocker: "access_revoked"`. `runTurn(opts, run)` gains `opts.accessGate` (default `createAccessGate()`), runs `preflight()` then `withAccess`. `main` drops its own CLI pre-flight (the gate does it) and prints `ERROR: <message>` with exit 8 when `report.blocker === "access_revoked"`.
- Modify `package.json`: add `test/agent.access.test.js`.

- [ ] **Step 1: Write the failing tests** `test/agent.access.test.js` (mock runner from `test/agent.test.js`'s pattern; `mockPing(replies)` returns the queued reply objects in order, repeating the last; a reply of `"timeout"` rejects after `timeoutMs`; `"malformed"` resolves `"not json"`):

```js
const { createAccessGate, withAccess, AccessError } = require("../server/access-gate.js");
const granted = (over = {}) => ({ pong: true, access: "granted", serverId: "s1", extGen: 1, accessGen: 3, session: "chrome", ...over });
// gate unit
let gate = createAccessGate({ ping: mockPing([granted()]), intervalMs: 20, timeoutMs: 30 });
const id = await gate.preflight(); assert(id.serverId === "s1" && id.extGen === 1 && id.accessGen === 3, "preflight latches the triple");
await gate.check();
for (const [name, reply] of [["accessGen", granted({ accessGen: 4 })], ["extGen", granted({ extGen: 2 })], ["serverId", granted({ serverId: "s2" })]]) {
  gate = createAccessGate({ ping: mockPing([granted(), reply]), intervalMs: 20, timeoutMs: 30 }); await gate.preflight();
  let e = null; try { await gate.check(); } catch (x) { e = x; }
  assert(e instanceof AccessError && /identity changed/.test(e.message) && /^access_revoked: /.test(e.message), `a changed ${name} ends the run`);
}
gate = createAccessGate({ ping: mockPing([granted({ access: "revoked" })]) });
let e = null; try { await gate.preflight(); } catch (x) { e = x; }
assert(e instanceof AccessError && /access_revoked: access revoked by user \(session "chrome"\)/.test(e.message), "preflight with revoked → access_revoked");
gate = createAccessGate({ ping: mockPing([granted({ access: "not_granted" })]) });
e = null; try { await gate.preflight(); } catch (x) { e = x; }
assert(/access not granted yet/.test(e.message) && /^access_revoked: /.test(e.message), "not_granted → structured access_revoked with the not-granted reason");
gate = createAccessGate({ ping: mockPing([granted(), "malformed"]) }); await gate.preflight();
e = null; try { await gate.check(); } catch (x) { e = x; }
assert(e instanceof AccessError && /malformed/.test(e.message), "malformed reply → access_revoked");
gate = createAccessGate({ ping: mockPing([granted(), { error: "extension not connected" }]) }); await gate.preflight();
e = null; try { await gate.check(); } catch (x) { e = x; }
assert(e instanceof AccessError && /extension not connected/.test(e.message), "extension not connected → access_revoked");
gate = createAccessGate({ ping: mockPing([granted(), "timeout", granted(), "timeout", "timeout"]), timeoutMs: 20 }); await gate.preflight();
await gate.check(); // one timeout tolerated
await gate.check(); // success resets
e = null; try { await gate.check(); await gate.check(); } catch (x) { e = x; }
assert(e instanceof AccessError && /twice/.test(e.message), "two consecutive timeouts end the run, one is tolerated");
// withAccess aborts a running child
gate = createAccessGate({ ping: mockPing([granted(), granted(), granted({ access: "revoked" })]), intervalMs: 15, timeoutMs: 30 }); await gate.preflight();
let aborted = false;
e = null; try { await withAccess(gate, (o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => { aborted = true; rej(Object.assign(new Error("cancelled"), { name: "AbortError" })); })), {}); } catch (x) { e = x; }
assert(aborted && e instanceof AccessError, "withAccess: the 10-s poll seeing revoked aborts the child and surfaces access_revoked");
// runAgent integration
const { runAgent, runTurn } = require("../server/agent.js");
{ const m = mockRun(['{"verdict":"pass","feedback":"ok"}']); const g = createAccessGate({ ping: mockPing([granted({ access: "revoked" })]) });
  const r = await runAgent("t", {}, m.run, { accessGate: g, openLease: noLease });
  assert(m.calls.length === 0 && r.verdict.verdict === "fail" && r.blocker === "access_revoked" && r.record.blocker === "access_revoked", "pre-flight revoked: no model spawned, run recorded as access_revoked"); }
{ const m = mockRun(['{"verdict":"fail","feedback":"no"}', '{"verdict":"pass","feedback":"ok"}']);
  const g = createAccessGate({ ping: mockPing([granted(), granted(), granted(), granted({ access: "revoked" })]), intervalMs: 1000 }); // preflight, check(ops1), check(judge1), check(ops2) → revoked
  const r = await runAgent("t", {}, m.run, { accessGate: g, openLease: noLease });
  assert(m.calls.length === 2 && r.blocker === "access_revoked" && r.verdict.verdict === "fail", "revoke between rungs: the ladder does not climb"); }
{ const m = mockRun([]); const g = createAccessGate({ ping: mockPing([granted(), granted({ accessGen: 9 })]), intervalMs: 1000 });
  const r = await runAgent("t", {}, m.run, { accessGate: g, openLease: noLease });
  assert(m.calls.length === 0 && /identity changed/.test(r.verdict.feedback), "a regrant between preflight and the first spawn ends the run"); }
{ // classifier goes through the gate: an uncertain job match spawns the classifier only after a check
  const jobsDir = …; // create one job whose task text is a near match so findJobForTask returns `uncertain` (see jobs.findJobForTask); then:
  const pings = []; const g = createAccessGate({ ping: async () => { pings.push(Date.now()); return granted(); } });
  const m = mockRun(['{"verdict":"pass","feedback":"ok"}']);
  await runAgent("near match task text", {}, m.run, { accessGate: g, openLease: noLease });
  assert(pings.length >= m.calls.length + 1, "every spawn (classifier included) is preceded by a check"); }
{ // runTurn through the gate
  const g = createAccessGate({ ping: mockPing([granted({ access: "revoked" })]) });
  let err = null; try { await runTurn({ model: "m", text: "hi", claudeSessionId: "u", cwd: os.tmpdir(), accessGate: g, baseEnv: {} }, async () => ({ result: "x", session_id: "u" })); } catch (x) { err = x; }
  assert(err instanceof AccessError, "runTurn: revoked → AccessError, no spawn"); }
```

`noLease = async () => ({ end: async () => null, close() {} })`. For the classifier case, if building an uncertain match is awkward, assert instead that `pings.length === m.calls.length + 1` for a plain run (preflight + one check per spawn) and name the classifier coverage in the deferred list.

- [ ] **Step 2: Run to verify it fails** — `node test/agent.access.test.js` → FAIL: module not found.
- [ ] **Step 3: Implement** `server/access-gate.js` and the `agent.js` changes. Existing `test/agent.test.js` runs must keep passing: its `runAgent` calls pass no gate, so the default gate's `defaultPing` would hit the real relay — give `runAgent` the rule "no `deps.accessGate` **and** `process.env.AI_BRIDGE_NO_ACCESS_GATE === "1"` → a pass-through gate", set that env at the top of `test/agent.test.js` and `test/agent.turn.test.js`, and document it as test-only next to `BRIDGE_DRAIN_MS`.
- [ ] **Step 4: Run** `node test/agent.access.test.js && node test/agent.test.js && node test/agent.turn.test.js` — all PASS.
- [ ] **Step 5: Commit** — `git commit -m "agent: access gate latches (serverId, extGen, accessGen), checks before every spawn and every 10 s, aborts the child and ends the run with access_revoked; runTurn gated"`.

---

### Task 7: Restricted env passthrough

**Files:**
- Modify: `server/channels/restricted.js`
- Modify: `test/channels.restricted.test.js`

- [ ] **Step 1: Write the failing test**

```js
const e2 = cleanEnv({ AI_BRIDGE_HOME: "/data", AI_BRIDGE_DEBUGGER: "1", AI_BRIDGE_CODEX_SANDBOX: "container", AI_BRIDGE_CLIENT: "bridge agent", AI_BRIDGE_TELEGRAM_TOKEN: "t", AI_BRIDGE_TELEGRAM_TURO_TOKEN: "t2", PATH: "p" });
assert(e2.AI_BRIDGE_HOME === "/data" && e2.AI_BRIDGE_DEBUGGER === "1" && e2.AI_BRIDGE_CODEX_SANDBOX === "container" && e2.AI_BRIDGE_CLIENT === "bridge agent", "cleanEnv: passes AI_BRIDGE_HOME/DEBUGGER/CODEX_SANDBOX/CLIENT");
assert(!("AI_BRIDGE_TELEGRAM_TOKEN" in e2) && !("AI_BRIDGE_TELEGRAM_TURO_TOKEN" in e2), "cleanEnv: messenger tokens still denied");
assert(!("AI_BRIDGE_TELEGRAM_TOKEN" in cleanEnv({ AI_BRIDGE_TELEGRAM_TOKEN: "t" }, ["AI_BRIDGE_TELEGRAM_TOKEN"])), "cleanEnv: envPassthrough cannot re-admit a token");
```

- [ ] **Step 2: Run** `node test/channels.restricted.test.js` — FAIL on the passthrough line.
- [ ] **Step 3: Implement** — `KEEP_AI` gains the four keys; update the existing "keeps only …" assertion's expectation list.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "channels: restricted env passes AI_BRIDGE_HOME, AI_BRIDGE_DEBUGGER, AI_BRIDGE_CODEX_SANDBOX, AI_BRIDGE_CLIENT; tokens stay denied"`.

---

### Task 8: Docs, spec status, manual test rows, version

**Files:**
- Modify: `docs/superpowers/specs/2026-11-21-docker-isolated-access-design.md` (status paragraph; Storage: `session` key, `agentTabs` as ids, origin in pending entries; `AI_BRIDGE_NO_ACCESS_GATE` test knob next to `BRIDGE_DRAIN_MS`; channels daemon items marked deferred)
- Modify: `docs/DOCKER.md` (*Access: grant and revoke* → "implemented"; change-table rows #2/#3 partially; after-upgrade note: grant once in the popup)
- Modify: `README.md` (Security model: grant/revoke paragraph; Install: grant in the popup), `docs/INSTALL.md` (same step)
- Modify: `test/TEST-PLAN.md` (the spec's by-hand rows: revoke during `waitFor`; revoke during `type`; revoke while an attach is in flight; queued direct screenshot after revoke; expiry alarm after a worker restart; grant from the popup without reload; token change in Options revokes; manual mode ignores the native host; download in progress cancelled on revoke, finished one not; "revoke and close" after a worker restart)
- Modify: `package.json` version 0.1.11

- [ ] **Step 1: Make the edits.** `npm test` still green; `git diff --stat` touches only these files.
- [ ] **Step 2: Commit** — `git commit -m "docs: access switch as implemented (popup/Options, fail-closed transition, agent gate), manual test rows, version 0.1.11"`.

---

### Task 9: Branch review and PR

- [ ] **Step 1:** `npm test` on the branch; paste the pass summary into the PR body.
- [ ] **Step 2:** Astra review of `git diff tab-hygiene..HEAD` against the spec sections at the top, the plan decisions as intentional, the Review Focus list and the ledger rulings; fold findings test-first; repeat until APPROVE or "With fixes" fully folded.
- [ ] **Step 3:** PR against `tab-hygiene`; review text stays out of the repo; the PR body says that after merging the user must reload the extension and **Grant** once in the popup.
