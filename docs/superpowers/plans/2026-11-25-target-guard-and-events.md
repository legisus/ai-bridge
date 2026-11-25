# Target Guard and Event Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every browser operation of the extension bound to a validated http(s) document on an allowed host (no `chrome://`, no extension pages, no allowlist bypass through a redirect or a race), and give the user and the agent an event log that correlates with the relay's request ids.

**Architecture:** `extension/access.js` gains the pure target rules (`assertTarget`, URL-form allowlist, `listTabs` redaction) and the 200-entry event ring buffer with its redacted projection. `background.js` validates every command's target against a fresh tab/frame read, binds direct-route injections to the validated `documentId` (`chrome.webNavigation.getFrame` + `documentIds`) and debugger-route code to a `uniqueContextId` whose origin passed the same checks, tracks `loaderId` for input/capture, guards direct screenshots with `tabs.onActivated`, and detaches on `tabs.onUpdated` to a bad URL. `status {events:true}` returns the projection; the popup shows the full buffer; the CLI gains `bridge status --events`.

**Tech Stack:** as before (MV3 classic worker, plain JS, Node tests with the stub `chrome`; manifest gains the `webNavigation` permission).

**Spec:** `docs/superpowers/specs/2026-11-21-docker-isolated-access-design.md`, sections *Privileged-origin block*, *Allowlist on every target*, *Observability*, *Tests* (extension harness and `status {events:true}` rows), *Open questions* (`agentTabs` opened-only). Builds on `access-switch`.

## Global Constraints

- Branch `target-guard` stacks on `access-switch`; PR against `access-switch`; Astra reviews; no co-author trailers; no new dependencies.
- `assertTarget(url)` throws `privileged target refused` for any URL whose scheme is not `http:` or `https:`; the allowlist cannot override it (`*` means any http(s) host). It runs on the destination of `newTab`, `navigate`, `download`; on the current URL of the tab (fetched fresh) for every other tab command; before `scripting.executeScript`, `userScripts.execute`, `debugger.attach`.
- Direct route: validation reads `chrome.webNavigation.getFrame({tabId, frameId: 0})` and keeps `documentId`; `scripting.executeScript` / `userScripts.execute` get `target: {tabId, documentIds: [documentId]}`; a rejection because the document is gone is reported as `target changed`.
- Debugger route, code: after attach `Runtime.enable`; from `Runtime.executionContextCreated` pick the main-world (`auxData.isDefault`) context of frame 0 whose `origin` passes `assertTarget` and the allowlist **and** equals the validated URL's origin; `Runtime.evaluate`/`callFunctionOn` carry `uniqueContextId`; no matching context within 2 s → `target changed`.
- Debugger route, input and capture: `Page.enable`, track the main frame's `loaderId` through `Page.frameNavigated`; compare immediately before each `Input.*` / `Page.captureScreenshot`; a mismatch → `target changed`. The residual one-round-trip window is accepted and documented.
- Direct `screenshot`: the tab must be active in its window; `tabs.onActivated` for that window is observed across the capture and the main frame's `documentId` compared before/after; any activation or change → the image is discarded and the command fails `target changed`.
- `listTabs` returns `{id, windowId, active, url, title}` for allowed http(s) tabs and `{id, windowId, active, url: "redacted"}` (no title) for privileged or non-allowed ones. `closeTab` on a redacted tab is allowed only when the tab is in `agentTabs` of the current browser session.
- `assertAllowed` gains a URL form and applies to `newTab` (destination), `navigate` (current and destination), `download` (URL), `closeTab`/`selectTab`/`activateTab` (tab), `waitFor` (every tick, fresh URL), direct `screenshot` (active-tab rule).
- Events: ring buffer of the last 200 entries `{t, kind, reqId?, tabId?, origin?, detail?}` in `chrome.storage.session` under `events`, written through `logEvent()`, each also `console.info`; URLs stored as origin only. Kinds: `connect`, `disconnect`, `superseded`, `grant`, `revoke`, `refused`, `tab_opened`, `tab_closed`, `download_started`, `download_cancelled`, `attach`, `detach`. `detail` values are fixed codes: `reason` ∈ {`access_revoked`, `access_not_granted`, `privileged_target`, `not_allowed`, `target_changed`, `extension_disconnected`}, `source` ∈ {`popup`, `options`, `alarm`, `reload`, `startup`, `token-change`}, `gen`, `until` numbers.
- Projection for `status {events:true}`: while access is not granted, counts per kind only; while granted, entries with `origin` replaced by `"redacted"` and `tabId` dropped for any origin that is privileged or outside the **current** allowlist, and `detail` limited to `reason`, `source`, `gen`, `until`. A test records a refusal for `https://secret.example` outside the allowlist and asserts the host appears nowhere in the projected JSON.
- `reqId` is the wire `id` of the command the event belongs to (dispatched commands only).

## Plan decisions

1. **`assertAllowed` reads the allowlist once per command** and passes it to the pure helpers; `waitFor` re-reads the tab URL every tick but the allowlist once (an allowlist edit mid-poll takes effect on the next command).
2. **Context tracking per attached tab** lives in a `Map<tabId, {contexts: Map<uniqueId, {frameId, origin, isDefault}>, loaderId, validated: {origin, documentId}}>` maintained from `chrome.debugger.onEvent`; `Runtime.enable`/`Page.enable` are sent once per attach.
3. **Direct `type`/`click`/`insertText`/`key`/`scroll`/`waitFor(selector)`** bind to the `documentId` read at validation; the chunked `type` re-validates the document before each chunk (a navigation mid-string stops typing).
4. **Events are written by `access.js`** (`logEvent`) and read by the popup through a new `events-get` message; the worker logs connection events, refusals and attach/detach; `access.js` logs grant/revoke/tab/download events itself.
5. **`bridge status --events`** is a CLI flag that sets `params.events = true`; the relay forwards it unchanged (no server change). Restricted runs may use it (it is a read of redacted data).
6. **`webNavigation` permission** is added to the manifest; its install warning is the one `tabs` already shows.
7. **Tabs navigated (not opened) by the agent are not added to `agentTabs`** (the spec's open question: opened-only is the minimum).

## Review Focus

1. A `newTab` to `javascript:` or `data:` URLs must be refused as privileged, not opened. (Task 1)
2. `listTabs` with an empty allowlist still redacts `chrome://` and `chrome-extension://` tabs. (Task 1)
3. A `navigate` whose destination passes but whose current tab is `chrome://newtab` must still be allowed (the destination is what matters for a blank tab) — decide: the current URL check applies only when the tab's URL is http(s) or `about:blank`/`chrome://newtab`; other privileged current URLs are refused. (Task 3)
4. A `waitFor` on a tab that redirects to a disallowed host mid-poll stops with `not allowed`, not with a timeout. (Task 3)
5. An event with a `detail` carrying a free-text error must never reach the projection; only the fixed codes do. (Task 2)

---

### Task 1: Pure target rules in `access.js`

**Files:** Modify `extension/access.js`, `extension/manifest.json` (`webNavigation`); test `test/extension.access.test.js`.

**Produces:** `assertTarget(url)` (throws `Error("privileged target refused")`), `isHttpUrl(url) → boolean`, `hostAllowed(host, allowlist) → boolean` (empty list = all; `*`; exact or subdomain), `assertAllowedUrl(url, allowlist)` (runs `assertTarget` first, then throws `` `host "${host}" not in allowlist` ``), `redactTabs(tabs, allowlist, agentTabIds) → [{id, windowId, active, url, title?}]` (redacted entries have `url: "redacted"` and no `title`; `agent: true` on entries whose id is in `agentTabIds`), `blankUrl(url) → boolean` for `about:blank` / `chrome://newtab/` / empty.

- [ ] Step 1 tests: `assertTarget` throws for `chrome://extensions`, `chrome-extension://x/options.html`, `about:blank`, `javascript:alert(1)`, `data:text/html,x`, `file:///etc/passwd`, `view-source:https://a`, `devtools://x`, `edge://x`, `brave://x`, `""`, `undefined`; passes for `https://a.example/p?q` and `http://localhost:8080/`. `hostAllowed("a.b.example", ["example"])` true, `["b.example"]` true, `["c.example"]` false, `[]` true, `["*"]` true. `assertAllowedUrl("chrome://x", ["*"])` still throws privileged. `redactTabs([{id:1,url:"https://ok.example/x",title:"T"},{id:2,url:"chrome://extensions",title:"E"},{id:3,url:"https://no.example",title:"N"}], ["ok.example"], [3])` → entry 1 full, entry 2 `{id:2, url:"redacted"}` without title, entry 3 redacted with `agent: true`; with `[]` allowlist entry 3 is full and entry 2 still redacted. Manifest has `webNavigation`.
- [ ] Step 2: run → FAIL (`assertTarget is not a function`).
- [ ] Step 3: implement.
- [ ] Step 4: run → PASS.
- [ ] Step 5: commit `extension: pure target rules — privileged-origin block, URL-form allowlist, listTabs redaction`.

### Task 2: Event ring buffer and projection

**Files:** Modify `extension/access.js`; test `test/extension.access.test.js`.

**Produces:** `logEvent({kind, reqId, tabId, origin, detail})` (session key `events`, 200 max, oldest dropped, `console.info` each, `origin` reduced to an origin if a URL slipped in, `detail` restricted to the whitelisted keys with fixed codes — anything else dropped), `events() → Promise<entry[]>`, `projectEvents(entries, {granted, allowlist}) → {counts} | {events}` per the Global Constraints, `clearEvents()`.

- [ ] Step 1 tests: 205 `logEvent`s keep the last 200; a refusal event `{kind:"refused", reqId:"abc", tabId:5, origin:"https://secret.example", detail:{reason:"not_allowed", error:"host secret.example not in allowlist"}}` with allowlist `["ok.example"]`: `projectEvents(..., {granted:true, allowlist})` → the JSON contains neither `secret.example` nor `tabId` nor `error`, has `origin:"redacted"`, `reqId:"abc"`, `detail.reason:"not_allowed"`; `{granted:false}` → `{counts:{refused:1,...}}` with no entries; an event for `https://ok.example` keeps its origin and tabId; a `detail.reason` not in the fixed set is dropped by `logEvent`; `origin` given as a full URL is stored as origin only; grant/revoke events are logged by `setAccess` with `detail.source` and `detail.gen` (and `until` for timed grants).
- [ ] Steps 2–5 as usual; commit `extension: 200-entry event ring buffer with redacted projection`.

### Task 3: Worker wiring — validated targets, document binding, redaction, events

**Files:** Modify `extension/background.js`, `extension/popup.html/js` (events list + `events-get`), `server/cli.js` (`--events`), `docs/*`; test `test/extension.access.test.js` (source-level), `test/protocol.test.js` (`bridge status --events` forwards `events:true`).

**Produces in background.js:**
- `validateTab(tabId, gen, { allowlist }) → Promise<{ url, origin, documentId }>`: fresh `chrome.tabs.get`, `assertTarget(url)` (blank URLs allowed only where the command supplies a destination), `assertAllowedUrl`, `chrome.webNavigation.getFrame({tabId, frameId: 0})` → `documentId`.
- Direct injections pass `target: {tabId, documentIds: [documentId]}`; a rejection mentioning the document/frame → `Error("target changed")`.
- Debugger: `ensureCdpTracking(tabId)` sends `Runtime.enable` + `Page.enable` once per attach; `chrome.debugger.onEvent` maintains contexts and `loaderId`; `contextFor(tabId, validated) → uniqueContextId | throws target changed` (waits up to 2 s for a matching context); every `Runtime.evaluate` carries `uniqueContextId`; `assertLoader(tabId)` before each `Input.*`/`Page.captureScreenshot`.
- Direct screenshot: `onActivated` guard and `documentId` compare → `target changed`.
- `chrome.tabs.onUpdated`: attached or indicator-marked tab whose URL becomes privileged or disallowed → `detachTab` + `logEvent({kind:"detach", detail:{reason:"target_changed"}})`.
- `listTabs` → `redactTabs(tabs, allowlist, agentTabIds)`; `closeTab` on a redacted tab allowed only if in `agentTabs`.
- `status`: `p.events === true` → `events: projectEvents(await events(), {granted, allowlist})`.
- Events logged: connect/disconnect/superseded (the latter when the server closes a socket we still own while another is open — log `disconnect` with `detail.reason:"extension_disconnected"`), refused (the `catch` in `sock.onmessage` maps `access_*`/`privileged target refused`/`not in allowlist`/`target changed` errors to reason codes with the command's `reqId` and the tab/origin when known), attach/detach, tab_opened/tab_closed (from `completeTab`/`closeTab`), download_started/cancelled.
- Popup: "Recent events" section (last 20, newest first, full origins) via `events-get`.
- CLI: `bridge status --events`.

- [ ] Step 1 tests: source-level — `webNavigation.getFrame`, `documentIds: [`, `uniqueContextId`, `Runtime.enable`, `Page.enable`, `frameNavigated`, `loaderId`, `tabs.onActivated`, `tabs.onUpdated`, `redactTabs(`, `projectEvents(`, `logEvent(` with each kind present, `"target changed"`, `events-get`; every `assertAllowed(` call site replaced by `validateTab(`; protocol test: `bridge status --events` forwards `params.events === true` (fake extension echoes params for status when `events` is set).
- [ ] Steps 2–5; load in the real Chrome: `bridge listTabs` shows `chrome://` tabs redacted; `bridge newTab '{"url":"chrome://extensions"}'` → `privileged target refused`; `bridge status --events` returns counts while revoked and entries while granted; commit.

### Task 4: Docs and review

- Spec status paragraph; guide (#3/#4 implemented, `status --events` live, residual CDP window stated); README security bullet; TEST-PLAN rows (attached tab redirected to `chrome://` detaches; `newTab` to the Options page refused with `*`; redirect out of the allowlist stops `waitFor`).
- `npm test`; Astra review of `git diff access-switch..HEAD`; fold; PR against `access-switch`.
