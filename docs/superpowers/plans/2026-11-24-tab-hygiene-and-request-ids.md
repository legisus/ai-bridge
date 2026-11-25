# Tab Hygiene and Request-Id Correlation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the bridge leaking Chrome tabs (change #14) and make every bridge request traceable end to end by its wire id (change #13), as the first implementation slice of the Docker-isolated design.

**Architecture:** The relay (`server/server.js`) gains a server-side tab registry persisted in `AI_BRIDGE_HOME/tabs.json`, a run-lease manager that cleans up a run's tabs when the supervisor's lease socket ends, and one `finish(req, outcome)` path that logs and traces every terminal outcome once. The extension gains a `browserSession` id, an `agentTabs` set in session storage and the `closeTabs` command. Because `browserSession` rides on the `access` message, this slice also implements the **server side** of the access contract (generation, identity triple, gate, merged `ping`/`status` fields); the extension sends `access` with a stored default of *granted* and gets its switch, popup and privileged-origin logic in the next slice.

**Tech Stack:** Node.js ≥ 18 CommonJS, only dependency `ws`; MV3 extension in plain JS loaded unpacked; tests are plain `node test/*.test.js` scripts chained in `npm test` (no framework, no TypeScript, no CI).

**Spec:** `docs/superpowers/specs/2026-11-21-docker-isolated-access-design.md` (sections *Wire contract*, *Server*, *Observability*, *Tab hygiene*, *Agent and channel runs*, *Tests*). User guide: `docs/DOCKER.md` (*Debugging*, *Abandoned tabs*).

## Global Constraints

- Branch stacks on `docker-isolated` (which stacks on `fix/intent-gate-expiry`); every change goes through a PR the user merges; Codex `gpt-6-astra` reviews before merge; no `Co-Authored-By` trailers.
- No new npm dependencies. Node ≥ 18. Extension stays plain JS; `background.js` is a classic (non-module) service worker, so shared code loads with `importScripts`.
- Error strings on the wire stay **strings**; the two access errors are exactly `access_revoked: access revoked by user (session "<name>")` and `access_not_granted: access not granted yet (session "<name>")`; the CLI exits **8** on either (1 command error, 2 usage, 3 timeout, 4 connect failed, 5 debugger, 6 no token, 7 restricted).
- `browserSession` is 32 lowercase hex characters; an `access` message without a well-formed one is treated as **revoked**. `until` is `null` or a finite epoch-ms number in the future; anything else means revoked.
- Server log line format: `<ts> <reqId> <client> <runId|-> cmd <cmd> <params≤200 chars>` and `<ts> <reqId> <client> <runId|-> done ok <ms>ms` / `done fail <ms>ms <error>` / `refused <code>` / `cancelled <reason>`.
- Drain after a run ends: 5 s (`BRIDGE_DRAIN_MS` overrides it for tests only). Pending creations survive the deadline; a late response completes the record and triggers one more `closeTabs`.
- Cleanup closes only individually owned tabs via `closeTabs {tabIds}`; the extension intersects with its own `agentTabs`; no window removal; nothing closes while access is not granted (tabs are marked *retained*).
- `tabs` and `closeTabs` join `RESTRICTED_DENY`. No automatic idle sweep.
- Nothing in logs, traces or the registry contains page content, tokens or full URLs beyond what today's `cmd` log line already prints; the registry stores the **origin** only.

## Plan decisions (the spec left these to the builder; Astra reviews them with the code)

1. **Slice boundary.** The server-side access contract (`access` message, `extGen`, `serverId`, gate, pending cancellation, merged `ping`/`status` fields) is implemented here. The extension sends `access` from a stored state whose slice-1 default is `{granted:true, until:null, gen:1}`; the install-starts-revoked rule, popup, Options, expiry alarm, `assertAccess`, document binding and the event buffer are the next slice. The `withAccess(run)` latch in the agent is also the next slice.
2. **`bridge tabs` reads `AI_BRIDGE_HOME/tabs.json` directly.** The file is server-maintained and records the current `browserSession`, so the CLI needs no new wire message; `bridge closeTabs` selects ids from the file and sends the ordinary `closeTabs` request.
3. **Reconciliation source.** The extension's `status` result gains `agentTabs: number[]`. The server reconciles the registry on every `status` response and issues its own `status` whenever an `access` message arrives, which covers relay restart and extension reconnect. (Spec amendment, Task 11.)
4. **`runEnd` ack.** The server answers `{type:"runEnd", runId, ok:true, tabs:{opened, closed, retained, kept}}` after drain and cleanup; `{type:"run"}` is answered `{type:"run", runId, ok, error?}`. The supervisor copies the counts into the journal record; late creations are patched into `journal.jsonl` by the server through `journal.patchRun`. (Spec amendment, Task 11.)
5. **CLI failure output.** stderr gets `ERROR: <string> (req <id>)`; stdout gets one JSON line `{"error":"<string>","reqId":"<id>"}`. Success output is unchanged.
6. **`client` label.** `AI_BRIDGE_CLIENT`, else the parent process name (`ps -o comm= -p <ppid>`, basename), else `cli`; the server strips control characters and truncates to 40 characters. `bridge agent` sets `AI_BRIDGE_CLIENT=bridge agent` for its children.
7. **Server-internal requests** (`closeTabs` for cleanup, `status` for reconciliation) use ids `srv-<n>`, client `server`, go through the same gate and the same `finish()`.
8. **Channel turns** (`runTurn`) get no lease in this slice: a conversational session may want its tab to survive the turn, which needs its own `keepTabs` rule. Noted in the guide as a limit.
9. **`BRIDGE_BIND`** (change #1) is implemented here because the `listening`-event startup line it needs is the same code the hermetic tests need.

## Review Focus

Inputs the spec implies but no spec test names, each pinned to a task below:

1. `closeTab {tabId}` on a tab the registry does not know (a user tab) must leave the registry untouched and stay allowlist-gated as today. (Task 6)
2. A corrupt or truncated `tabs.json` must not stop the relay from starting: it starts empty, keeps the bad file aside and logs once. (Task 5)
3. A `newTab` whose extension response is `ok:false` must drop the pending record and not count as opened. (Task 6)
4. `closeTabs` with `tabIds` that is not an array of integers must be refused by the server before forwarding, with a plain error, not forwarded as-is. (Task 8)
5. Extension `closeTabs` where `chrome.tabs.remove` rejects (the user already closed the tab) must report that id as skipped and forget it from `agentTabs`. (Task 10)
6. Ordinary `request` messages on a lease socket are served normally (a lease socket is a CLI socket). (Task 7)

---

### Task 1: Hermetic test harness, `listening` line from the event, `BRIDGE_BIND`

**Files:**
- Create: `test/helpers/relay.js`
- Modify: `server/server.js` (listen options + startup line)
- Modify: `test/protocol.test.js` (use the harness; no real `~/.ai-browser-bridge`, no fixed port)
- Modify: `test/trace.test.js` (use the harness)

**Interfaces:**
- Produces `test/helpers/relay.js`:
  - `startRelay({ env = {} } = {}) → Promise<{ port, home, token, proc, logFile, stop() }>` — spawns `server/server.js` with a fresh temp `AI_BRIDGE_HOME`, `BRIDGE_PORT=0` and `env` merged; resolves when stdout shows `listening on ws://<bind>:<port>`; `token` read from `<home>/token`.
  - `fakeExtension(relay, { browserSession = randomHex32(), session = "chrome", access = true, handler } = {}) → Promise<Ext>` — authenticates as `extension`; after `auth ok` sends `access` `{granted:true, until:null, gen:1, browserSession}` unless `access === false`; `Ext.received` = every `command` message; `Ext.sendAccess(fields)` merges over the defaults and sends; `Ext.waitFor(cmd, { timeoutMs = 3000 }) → Promise<command>`; `Ext.close()`. Default `handler(cmd, params, id)` answers `ping → {pong:true, version:"test"}`, `status → {version:"test", attachedTabs:[], agentTabs: <ids it created so far>}`, `newTab → {id: 100, 101, …, windowId: 1}`, `closeTabs → {closed: params.tabIds, skipped: []}`, `closeTab → {ok:true}`, anything else `{echo: cmd, params}`; a custom handler returning `undefined` means "do not answer" (the test answers later with `Ext.respond(id, {ok, result, error})`).
  - `cli(relay, args, { env = {} } = {}) → Promise<{ code, stdout, stderr, json }>` — runs `server/cli.js` with `BRIDGE_PORT=<port>`, `AI_BRIDGE_HOME=<home>`; `json` is `JSON.parse` of the first stdout line or `null`.
  - `leaseSocket(relay, { runId, client = "test", keepTabs = false }) → Promise<{ ws, messages, send(obj), end() → Promise<ack>, close() }>` — authenticates as `cli`, sends `run`, resolves after the `run` ack (rejects when `ok:false`).
  - `randomHex32()`.
- Produces in `server/server.js`: `start({ port = Number(process.env.BRIDGE_PORT || 8765), bind = process.env.BRIDGE_BIND || "127.0.0.1" } = {})` returns the `WebSocketServer`; the startup line `listening on ws://<bind>:<actual port>` is logged from the `listening` event, with the suffix ` — make sure only the host's loopback can reach this port` when `bind` is not `127.0.0.1` / `localhost` / `::1`.

- [ ] **Step 1: Write the failing tests** in `test/protocol.test.js` (replace the fixed-port/real-home preamble):

```js
const { startRelay, fakeExtension, cli } = require("./helpers/relay");
// … inside the async main:
const relay = await startRelay();
assert(/^\d+$/.test(String(relay.port)) && relay.port !== 8765, "relay picked a dynamic port");
assert(!fs.existsSync(path.join(os.homedir(), ".ai-browser-bridge", "token")) || relay.home !== path.join(os.homedir(), ".ai-browser-bridge"), "relay runs on a temp AI_BRIDGE_HOME");
// bad-token test and the existing round-trips, now through `cli(relay, [...])` and `fakeExtension(relay)`
// new:
const bound = await startRelay({ env: { BRIDGE_BIND: "0.0.0.0" } });
assert(/listening on ws:\/\/0\.0\.0\.0:\d+ — make sure only the host's loopback can reach this port/.test(fs.readFileSync(bound.logFile, "utf8")), "BRIDGE_BIND=0.0.0.0 logs the warning suffix");
const r = await cli(bound, ["ping", "--timeout", "3000"]);
assert(r.code === 1 && /extension not connected/.test(r.stderr), "0.0.0.0 relay reachable from 127.0.0.1 (no extension → exit 1)");
bound.stop();
assert(/listening on ws:\/\/127\.0\.0\.1:\d+$/m.test(fs.readFileSync(relay.logFile, "utf8")), "default bind logged without the suffix");
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/protocol.test.js`
Expected: FAIL — `Cannot find module './helpers/relay'`.

- [ ] **Step 3: Implement `test/helpers/relay.js`** with the interface above. Readiness: read `proc.stdout` line by line until `/listening on ws:\/\/[^:]+:(\d+)/` matches; reject after 5 s with the collected stderr. `stop()` kills the process and removes the temp home.

- [ ] **Step 4: Implement the server changes**: `start(opts)`, `new WebSocketServer({ host: bind, port, maxPayload })`, `wss.on("listening", …)` logs the line using `wss.address().port`; the `require.main` block calls `start()`. Keep everything else in the file as it is for now.

- [ ] **Step 5: Port `test/trace.test.js` to the harness** (replace its own spawn/sleep/token preamble with `startRelay` + `fakeExtension` with a custom handler for `boom`/`screenshot`/`eval`).

- [ ] **Step 6: Run both tests**

Run: `node test/protocol.test.js && node test/trace.test.js`
Expected: `ALL TESTS PASSED` / `All trace tests passed.`

- [ ] **Step 7: Commit**

```bash
git add test/helpers/relay.js test/protocol.test.js test/trace.test.js server/server.js
git commit -m "test: hermetic relay harness (temp home, dynamic port); server logs the listening line from the event and honours BRIDGE_BIND"
```

---

### Task 2: Access normalisation module

**Files:**
- Create: `server/access.js`
- Create: `test/access.test.js`
- Modify: `package.json` (append `&& node test/access.test.js` to `scripts.test`)

**Interfaces:**
- Produces `server/access.js`:
  - `normalizeAccess(msg, now = Date.now()) → { granted: boolean, until: number|null, session: string, gen: number, browserSession: string|null, reason: string|null }` — `session`: `String(msg.session ?? "chrome")` with control characters stripped, truncated to 40, `"chrome"` if empty; `gen`: non-negative integer else `0`; `browserSession`: the value if `/^[0-9a-f]{32}$/` else `null`; `granted` is `true` only when `msg.granted === true` **and** `browserSession !== null` **and** (`msg.until === null` **or** `Number.isFinite(msg.until) && msg.until > now`); `until` is `null` or that number; `reason` is `null` when granted, else one of `"not_granted"` (`granted !== true`), `"bad_until"`, `"bad_browser_session"`.
  - `isGrantedNow(a, now = Date.now()) → boolean` — `a.granted && (a.until === null || a.until > now)`.
  - `stateOf(a, now) → "granted" | "revoked" | "not_granted"` — `a == null` → `not_granted`; `isGrantedNow` → `granted`; else `revoked`.
  - `ACCESS_REVOKED(session) → string`, `ACCESS_NOT_GRANTED(session) → string` — the two exact strings from Global Constraints.
  - `isAccessError(s) → boolean` — `typeof s === "string" && /^access_(revoked|not_granted):/.test(s)`.

- [ ] **Step 1: Write the failing test** `test/access.test.js` (same `assert` style as `test/journal.test.js`):

```js
const A = require("../server/access.js");
const bs = "a".repeat(32);
assert(A.normalizeAccess({ granted: true, until: null, gen: 3, session: "work-chrome", browserSession: bs }).granted === true, "granted indefinite");
assert(A.normalizeAccess({ granted: true, until: Date.now() + 60000, browserSession: bs }).granted === true, "granted timed future");
assert(A.normalizeAccess({ granted: true, until: Date.now() - 1, browserSession: bs }).reason === "bad_until", "until in the past → revoked");
for (const bad of [undefined, 0, NaN, "soon", "1700000000000"]) assert(A.normalizeAccess({ granted: true, until: bad, browserSession: bs }).granted === false, `until ${String(bad)} → revoked`);
assert(A.normalizeAccess({ granted: true, until: null }).reason === "bad_browser_session", "missing browserSession → revoked");
assert(A.normalizeAccess({ granted: true, until: null, browserSession: "A".repeat(32) }).granted === false, "uppercase browserSession rejected");
assert(A.normalizeAccess({ granted: "true", until: null, browserSession: bs }).reason === "not_granted", "granted must be boolean true");
assert(A.normalizeAccess({ granted: true, until: null, browserSession: bs, session: "x\u0007y".padEnd(60, "z") }).session.length === 40 && !/\u0007/.test(A.normalizeAccess({ session: "x\u0007y" }).session), "session sanitised and truncated");
assert(A.normalizeAccess({ granted: true, until: null, browserSession: bs, gen: -1 }).gen === 0 && A.normalizeAccess({ gen: 7 }).gen === 7, "gen normalised");
assert(A.stateOf(null) === "not_granted" && A.stateOf(A.normalizeAccess({ granted: false, until: null, browserSession: bs })) === "revoked", "stateOf");
assert(A.ACCESS_REVOKED("work-chrome") === 'access_revoked: access revoked by user (session "work-chrome")', "revoked string");
assert(A.ACCESS_NOT_GRANTED("chrome") === 'access_not_granted: access not granted yet (session "chrome")', "not granted string");
assert(A.isAccessError(A.ACCESS_REVOKED("x")) && A.isAccessError(A.ACCESS_NOT_GRANTED("x")) && !A.isAccessError("extension not connected"), "isAccessError");
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/access.test.js`
Expected: FAIL — `Cannot find module '../server/access.js'`.

- [ ] **Step 3: Implement `server/access.js`** per the interface.

- [ ] **Step 4: Run to verify it passes**

Run: `node test/access.test.js`
Expected: all PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/access.js test/access.test.js package.json
git commit -m "server: access normalisation (until/browserSession/session rules, the two access error strings)"
```

---

### Task 3: Server access gate, extension generation and identity triple; CLI exit 8

**Files:**
- Modify: `server/server.js`
- Modify: `server/cli.js` (exit 8)
- Create: `test/protocol.access.test.js`
- Modify: `package.json` (append the test)

**Interfaces:**
- Consumes `server/access.js` (Task 2), harness (Task 1).
- Produces in `server/server.js` (module-internal, named here so later tasks hook into them):
  - `serverId` — 32-hex random, once per process.
  - `ext` — `null` or `{ sock, gen, access }` where `access` is `null` until the first well-formed `access` message of that generation; `extGen` counter incremented on every extension authentication.
  - `accessState() → "granted" | "revoked" | "not_granted"` — `stateOf(ext && ext.access)`; `"not_granted"` when no extension.
  - Pending map entries: `{ id, sock, cmd, params, meta, t0, gen }` (`gen` = extension generation that received it).
  - Gate on CLI `request`: no extension → `extension not connected`; `cmd` not `ping`/`status` and `accessState() !== "granted"` → error `ACCESS_NOT_GRANTED(session)` when `ext.access == null`, else `ACCESS_REVOKED(session)`; `session` is `ext.access ? ext.access.session : "chrome"`.
  - On `access` message from the **current** generation only: `ext.access = normalizeAccess(msg)`; log `access granted (session "x", until <iso|never>)` / `access revoked (session "x")` on each change of `stateOf`, plus `access message rejected: <reason>` when `reason` is `bad_browser_session` or `bad_until`; when the new state is not `granted`, answer every pending request of this generation whose `cmd` is not `ping`/`status` with `ACCESS_REVOKED(session)`.
  - On extension authenticate while one is connected: log `extension superseded (gen N → N+1)`, close the old socket, answer its pending requests `extension disconnected`; `ext.access` starts `null` (`not_granted`).
  - On `ping`/`status` `ok` responses: merge `{ session, access: accessState(), until, accessGen, extGen, serverId }` into `result` (`until` `null` when no access; `accessGen` = `ext.access ? ext.access.gen : 0`).
- Produces in `server/cli.js`: exit code **8** when `isAccessError(msg.error)`.

- [ ] **Step 1: Write the failing tests** `test/protocol.access.test.js`:

```js
const relay = await startRelay();
// no access yet
let ext = await fakeExtension(relay, { access: false });
let r = await cli(relay, ["eval", '{"tabId":1,"code":"1"}', "--timeout", "3000"]);
assert(r.code === 8 && /^access_not_granted: access not granted yet \(session "chrome"\)/.test(r.json.error), "not granted → exit 8, exact string");
assert(ext.received.length === 0, "nothing forwarded while not granted");
r = await cli(relay, ["ping", "--timeout", "3000"]);
assert(r.json.pong === true && r.json.access === "not_granted" && r.json.accessGen === 0 && r.json.extGen === 1 && /^[0-9a-f]{32}$/.test(r.json.serverId) && r.json.until === null, "ping forwarded while not granted, carries identity fields");
// granted
const bs = randomHex32();
ext.sendAccess({ granted: true, until: null, gen: 3, session: "work-chrome", browserSession: bs });
await new Promise((res) => setTimeout(res, 100));
r = await cli(relay, ["eval", '{"tabId":1,"code":"1"}', "--timeout", "3000"]);
assert(r.code === 0 && ext.received.some((m) => m.cmd === "eval"), "granted → forwarded");
r = await cli(relay, ["status", "--timeout", "3000"]);
assert(r.json.session === "work-chrome" && r.json.access === "granted" && r.json.accessGen === 3, "status merges session/access/accessGen");
// revoke: pending eval answered, pending ping survives
let holdId = null;
ext = await fakeExtension(relay, { handler: (cmd, p, id) => { if (cmd === "eval") { holdId = id; return undefined; } if (cmd === "ping") return { pong: true }; } }); // new ext → gen 2
ext.sendAccess({ granted: true, until: null, gen: 1 });
await new Promise((res) => setTimeout(res, 100));
const pendingEval = cli(relay, ["eval", '{"tabId":1,"code":"1"}', "--timeout", "3000"]);
await ext.waitFor("eval");
ext.sendAccess({ granted: false, until: null, gen: 2 });
r = await pendingEval;
assert(r.code === 8 && /^access_revoked: access revoked by user \(session "chrome"\)/.test(r.json.error), "pending eval answered access_revoked on revoke");
const evalsBefore = ext.received.filter((m) => m.cmd === "eval").length;
r = await cli(relay, ["eval", '{"tabId":1,"code":"1"}', "--timeout", "3000"]);
assert(r.code === 8 && /^access_revoked:/.test(r.json.error) && ext.received.filter((m) => m.cmd === "eval").length === evalsBefore, "revoked → refused locally, extension receives nothing");
r = await cli(relay, ["ping", "--timeout", "3000"]);
assert(r.json.pong === true && r.json.access === "revoked" && r.json.extGen === 2, "ping forwarded while revoked");
// until in the past → revoked, no message
ext.sendAccess({ granted: true, until: Date.now() - 10, gen: 3 });
await new Promise((res) => setTimeout(res, 100));
r = await cli(relay, ["eval", '{"tabId":1,"code":"1"}', "--timeout", "3000"]);
assert(r.code === 8, "until in the past → revoked");
// missing browserSession → revoked
ext.sendAccess({ granted: true, until: null, gen: 4, browserSession: undefined });
await new Promise((res) => setTimeout(res, 100));
assert((await cli(relay, ["eval", '{"tabId":1,"code":"1"}', "--timeout", "3000"])).code === 8, "access without browserSession → revoked");
assert(/access message rejected: bad_browser_session/.test(fs.readFileSync(relay.logFile, "utf8")), "rejection logged");
// a pending ping survives a revoke
let heldPingId = null;
ext = await fakeExtension(relay, { handler: (cmd, p, id) => { if (cmd === "ping") { heldPingId = id; return undefined; } } }); // gen 3
await new Promise((res) => setTimeout(res, 100));
let held = cli(relay, ["ping", "--timeout", "3000"]);
await ext.waitFor("ping");
ext.sendAccess({ granted: false, until: null, gen: 2 });
await new Promise((res) => setTimeout(res, 100));
ext.respond(heldPingId, { ok: true, result: { pong: true } });
r = await held;
assert(r.code === 0 && r.json.pong === true && r.json.access === "revoked", "pending ping survives a revoke");
// supersession: pending request on the old socket is cancelled, access resets, old socket's access is ignored
const old = ext;
held = cli(relay, ["ping", "--timeout", "3000"]);
await old.waitFor("ping");
const fresh = await fakeExtension(relay, { access: false }); // gen 4
r = await held;
assert(r.code === 1 && r.json.error === "extension disconnected", "pending request of the superseded socket gets extension disconnected");
try { old.sendAccess({ granted: true, until: null, gen: 9 }); } catch {}
await new Promise((res) => setTimeout(res, 100));
r = await cli(relay, ["ping", "--timeout", "3000"]);
assert(r.json.access === "not_granted" && r.json.extGen === 4 && r.json.accessGen === 0, "new extension socket resets access to not_granted and bumps extGen; old socket's access ignored");
assert(/extension superseded \(gen 3 → 4\)/.test(fs.readFileSync(relay.logFile, "utf8")), "supersession logged");
// serverId differs between processes
const relay2 = await startRelay(); await fakeExtension(relay2);
assert((await cli(relay2, ["ping", "--timeout", "3000"])).json.serverId !== r.json.serverId, "serverId differs between two server processes");
relay2.stop();
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/protocol.access.test.js`
Expected: FAIL on "not granted → exit 8" (today the eval is forwarded).

- [ ] **Step 3: Implement the server changes** listed under Interfaces. Keep `pending` answers going through one local helper `answer(req, msg)` for now (Task 4 replaces it with `finish`).

- [ ] **Step 4: Implement exit 8 in `server/cli.js`**: on `!msg.ok`, `process.exit(isAccessError(msg.error) ? 8 : 1)`.

- [ ] **Step 5: Run the tests**

Run: `node test/protocol.access.test.js && node test/protocol.test.js && node test/trace.test.js`
Expected: all PASS. (`protocol.test.js` passes because `fakeExtension` sends `access granted` by default.)

- [ ] **Step 6: Commit**

```bash
git add server/server.js server/cli.js test/protocol.access.test.js package.json
git commit -m "server: access gate with extension generation and identity triple; ping/status carry session, access, until, accessGen, extGen, serverId; CLI exits 8 on access errors"
```

---

### Task 4: One `finish()` path, request-id log lines, `client`, trace outcomes, CLI `(req <id>)`

**Files:**
- Modify: `server/server.js`
- Modify: `server/cli.js` (always send `meta` with `client`; failure output)
- Modify: `server/journal.js` (`--trace` formatter)
- Create: `test/protocol.log.test.js`
- Modify: `test/trace.test.js` (assert `reqId`, `client`, `outcome` on entries; `--trace` output shows the id)
- Modify: `package.json`

**Interfaces:**
- Consumes Task 3's pending entries; adds `client` and `runId` to them.
- Produces in `server/server.js`:
  - `finish(req, outcome)` — the only place that deletes from `pending`, logs the terminal line, traces when `req.runId`, and answers `req.sock` (if open) or resolves `req.resolve` (internal requests, Task 6). Outcome shapes: `{ kind: "done", ok: boolean, result?, error?: string }` (ms computed from `req.t0`), `{ kind: "refused", error: string }`, `{ kind: "cancelled", reason: string }`. The wire response is always `{ type: "response", id, ok, result?, error? }`; for `refused`/`cancelled`, `ok:false` and `error` = the string.
  - Log lines exactly as in Global Constraints; `code` for `refused` is the error up to the first `:` (so `access_revoked`, `access_not_granted`, `extension not connected`).
  - `sanitizeClient(s) → string` — strip control characters, trim, truncate to 40, default `cli`.
  - Trace entry gains `reqId`, `client`, `outcome` (`"done"|"refused"|"cancelled"`); `ok` is `false` for refused/cancelled with `error` set.
- Produces in `server/cli.js`: `meta` is always sent as `{ client, runId?, job?, as? }`; `client = process.env.AI_BRIDGE_CLIENT || parentProcessName() || "cli"`; on failure stderr `ERROR: <error> (req <id>)` and stdout `{"error":"…","reqId":"…"}`.
- Produces in `server/journal.js`: `--trace` text line `${ts} ${reqId||"-"} ${ms}ms ${ok ? "ok  " : outcome === "refused" ? "REF " : outcome === "cancelled" ? "CAN " : "FAIL"} ${cmd} …`.

- [ ] **Step 1: Write the failing tests** `test/protocol.log.test.js`:

```js
const relay = await startRelay();
const env = { AI_BRIDGE_RUN_ID: "logrun0001", AI_BRIDGE_CLIENT: "unit test" };
const ext = await fakeExtension(relay, { handler: (cmd, p, id) => { if (cmd === "eval") return undefined; } });
// forwarded result
let r = await cli(relay, ["newTab", '{"url":"https://example.com/a?b=1"}', "--timeout", "3000"], { env });
assert(r.code === 0, "newTab ok");
// local refusal
await ext.sendAccess({ granted: false, until: null, gen: 2 }); await sleep(100);
r = await cli(relay, ["newTab", '{"url":"https://example.com/"}', "--timeout", "3000"], { env });
assert(r.code === 8 && /^ERROR: access_revoked: .* \(req [0-9a-f]{16}\)$/m.test(r.stderr) && r.json.reqId && r.json.error === r.stderr.match(/ERROR: (.*) \(req/)[1], "refusal prints (req <id>) and JSON error with reqId");
// cancellation
await ext.sendAccess({ granted: true, until: null, gen: 3 }); await sleep(100);
const held = cli(relay, ["eval", '{"tabId":1,"code":"1"}', "--timeout", "3000"], { env });
await ext.waitFor("eval"); ext.close();
r = await held;
assert(r.code === 1 && r.json.error === "extension disconnected" && /\(req [0-9a-f]{16}\)/.test(r.stderr), "cancellation prints (req <id>)");
// log lines
const log = fs.readFileSync(relay.logFile, "utf8");
const lines = log.split("\n");
const cmdLine = lines.find((l) => / cmd newTab /.test(l));
assert(/^\S+ [0-9a-f]{16} unit test logrun0001 cmd newTab \{"url":"https:\/\/example\.com\/a\?b=1"/.test(cmdLine), "cmd line: <ts> <reqId> <client> <runId> cmd …");
const reqId = cmdLine.split(" ")[1];
assert(lines.filter((l) => l.includes(reqId)).length === 2 && new RegExp(`${reqId} unit test logrun0001 done ok \\d+ms$`).test(lines.find((l) => l.includes(reqId) && / done /.test(l))), "done line once, same reqId");
assert(lines.some((l) => / unit test logrun0001 refused access_revoked$/.test(l)), "refused line with code");
assert(lines.some((l) => / unit test logrun0001 cancelled extension disconnected$/.test(l)), "cancelled line");
assert(lines.filter((l) => / (done|refused|cancelled) /.test(l)).length === 3, "each terminal outcome logged exactly once");
// trace
const t = fs.readFileSync(path.join(relay.home, "traces", "logrun0001.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
assert(t.length === 3 && t.map((e) => e.outcome).join() === "done,refused,cancelled" && t.every((e) => /^[0-9a-f]{16}$/.test(e.reqId) && e.client === "unit test"), "trace has reqId/client/outcome for all three outcomes");
assert(t[1].ok === false && /^access_revoked:/.test(t[1].error), "refused trace entry carries the error");
// client default and sanitising
r = await cli(relay, ["ping", "--timeout", "3000"], { env: { AI_BRIDGE_CLIENT: "" } });
assert(new RegExp(` [0-9a-f]{16} (node|cli|sh|zsh|bash)\\S* - cmd ping`).test(fs.readFileSync(relay.logFile, "utf8")), "client defaults to the parent process name");
r = await cli(relay, ["ping", "--timeout", "3000"], { env: { AI_BRIDGE_CLIENT: "x\u0007y".padEnd(80, "q") } });
assert(!/\u0007/.test(fs.readFileSync(relay.logFile, "utf8")) && new RegExp(` xy${"q".repeat(38)} - cmd ping`).test(fs.readFileSync(relay.logFile, "utf8")), "client sanitised and truncated to 40");
const dump = (await cli(relay, ["journal", "--trace", "logrun0001"])).stdout;
assert(dump.split("\n").filter(Boolean).length === 3 && dump.includes(reqId) && /REF  newTab/.test(dump) && /CAN  eval/.test(dump), "bridge journal --trace prints reqId and outcome");
```

(`sleep` = `(ms) => new Promise((r) => setTimeout(r, ms))`; the CLI's request id is 16 hex characters today — keep it.)

- [ ] **Step 2: Run to verify it fails**

Run: `node test/protocol.log.test.js`
Expected: FAIL at "refusal prints (req <id>)".

- [ ] **Step 3: Implement `finish()` in `server/server.js`** and route every terminal outcome through it: forwarded responses (`done`), gate refusals and `extension not connected` (`refused`), extension close/supersession (`cancelled "extension disconnected"`), revoke of pending non-ping/status (`cancelled` with reason = `ACCESS_REVOKED(session)`). The `cmd` log line is written when the request is accepted (before gate evaluation), so a refused request has a `cmd` line and a `refused` line. Pending entries gain `client: sanitizeClient(meta.client)` and `runId` (`safeRunId(meta.runId) || null`).

- [ ] **Step 4: Implement the CLI side**: `parentProcessName()` (`execFileSync("ps", ["-o","comm=","-p", String(process.ppid)])`, basename, `null` on any error or on win32); always send `meta`; failure output per Interfaces.

- [ ] **Step 5: Update `server/journal.js` `--trace` formatter** and `test/trace.test.js` (entries carry `reqId`/`client`/`outcome`; the existing count of 5 entries stays, since `ping` without a run id is still untraced).

- [ ] **Step 6: Run the tests**

Run: `node test/protocol.log.test.js && node test/trace.test.js && node test/protocol.test.js && node test/protocol.access.test.js`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add server/server.js server/cli.js server/journal.js test/protocol.log.test.js test/trace.test.js package.json
git commit -m "server: single finish() path logs and traces every terminal outcome once with reqId/client/runId; CLI prints (req <id>) and sends its client label"
```

---

### Task 5: Tab registry module

**Files:**
- Create: `server/tabs.js`
- Modify: `server/token.js` (export `TABS_FILE = path.join(DIR, "tabs.json")`)
- Create: `test/tabs.registry.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes `server/atomic.js` `atomicWrite`.
- Produces `server/tabs.js`:
  - `openRegistry(file, { log = console.error } = {}) → Registry` — loads the file; on missing file starts empty; on unparsable JSON renames it to `<file>.corrupt-<epoch ms>`, logs `tabs.json unreadable, starting empty (kept as …)` once and starts empty.
  - Row shape: `{ tabId, browserSession, runId: string|null, client, origin, createdAt, lastCmdAt, reqId, status: "live"|"retained", late?: true }`. Pending shape: `{ reqId, runId, client, origin, createdAt, browserSession }`.
  - `registry.browserSession` (string|null), `registry.setBrowserSession(id)`.
  - `registry.addPending(p)`; `registry.completePending(reqId, tabId) → row|null` (row gets `lastCmdAt = createdAt`, `status: "live"`, `browserSession` from the pending entry; `null` when `reqId` unknown); `registry.dropPending(reqId)`; `registry.pendingForRun(runId) → number`.
  - `registry.touch(tabId, at)` — live or retained row of the current session only.
  - `registry.remove(tabIds) → number`; `registry.markRetained(runId) → number`; `registry.rowsForRun(runId) → row[]` (current session, `status === "live"`).
  - `registry.select({ client, runId, olderThanMs, now = Date.now() }) → number[]` — current session, `live` rows matching every given filter; `olderThanMs` compares `now - lastCmdAt > olderThanMs`; no filter given → `[]`.
  - `registry.list() → { current: row[], dead: row[] }` — `dead` = rows whose `browserSession` differs from the current one.
  - `registry.reconcile(agentTabIds) → { dropped: number }` — removes current-session rows whose `tabId` is not in the list and every dead row.
  - `registry.originOf(url) → string` — `new URL(url).origin` or `"unknown"`.
  - Every mutator saves with `atomicWrite(file, JSON.stringify({ version: 1, browserSession, pending, tabs }, null, 1))`.

- [ ] **Step 1: Write the failing test** `test/tabs.registry.test.js`:

```js
const { openRegistry } = require("../server/tabs.js");
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-tabs-")), "tabs.json");
let R = openRegistry(file);
const bs1 = "1".repeat(32), bs2 = "2".repeat(32);
R.setBrowserSession(bs1);
R.addPending({ reqId: "r1", runId: "run1", client: "bridge agent", origin: "https://example.com", createdAt: 1000, browserSession: bs1 });
assert(R.pendingForRun("run1") === 1 && R.completePending("zzz", 5) === null, "pending counted; unknown reqId → null");
const row = R.completePending("r1", 501);
assert(row.tabId === 501 && row.lastCmdAt === 1000 && row.status === "live" && R.pendingForRun("run1") === 0, "completePending: lastCmdAt = createdAt");
R.addPending({ reqId: "r2", runId: null, client: "zsh", origin: "https://b.example", createdAt: 2000, browserSession: bs1 }); R.completePending("r2", 502);
assert(JSON.stringify(R.select({ olderThanMs: 500, now: 1800 })) === "[501]", "--older-than by lastCmdAt (never-touched tab selected by createdAt)");
R.touch(501, 5000);
assert(R.select({ olderThanMs: 500, now: 5100 }).length === 0 && JSON.stringify(R.select({ olderThanMs: 500, now: 6000 })) === "[501,502]", "touch refreshes lastCmdAt");
assert(JSON.stringify(R.select({ client: "zsh" })) === "[502]" && JSON.stringify(R.select({ runId: "run1" })) === "[501]" && R.select({}).length === 0, "select by client / run / nothing");
R.setBrowserSession(bs2);
assert(R.select({ client: "zsh" }).length === 0 && R.list().dead.length === 2 && R.list().current.length === 0, "rows from another browser session are dead, never selected");
R.addPending({ reqId: "r3", runId: "run2", client: "c", origin: "o", createdAt: 1, browserSession: bs2 }); R.completePending("r3", 7);
assert(R.reconcile([7]).dropped === 2 && R.list().dead.length === 0 && R.list().current.length === 1, "reconcile prunes dead rows, keeps listed live ones");
assert(R.reconcile([]).dropped === 1 && R.list().current.length === 0, "reconcile drops current rows the extension no longer owns");
R.addPending({ reqId: "r4", runId: "run3", client: "c", origin: "o", createdAt: 1, browserSession: bs2 }); R.completePending("r4", 8);
assert(R.markRetained("run3") === 1 && R.rowsForRun("run3").length === 0 && R.list().current[0].status === "retained", "markRetained");
R.touch(8, 99); assert(R.list().current[0].lastCmdAt === 99, "touch works on retained rows");
assert(R.remove([8, 9999]) === 1 && R.list().current.length === 0, "remove returns the count removed");
// persistence
R.addPending({ reqId: "r5", runId: null, client: "c", origin: "o", createdAt: 1, browserSession: bs2 }); R.completePending("r5", 9);
const R2 = openRegistry(file);
assert(R2.browserSession === bs2 && R2.list().current.length === 1 && R2.list().current[0].tabId === 9, "reloaded from disk");
assert((fs.statSync(file).mode & 0o777) === 0o600, "tabs.json mode 600");
assert(R.originOf("https://a.example/x?y=1") === "https://a.example" && R.originOf("nope") === "unknown", "originOf");
// corrupt file
fs.writeFileSync(file, "{not json");
const logged = []; const R3 = openRegistry(file, { log: (l) => logged.push(l) });
assert(R3.list().current.length === 0 && logged.length === 1 && /unreadable/.test(logged[0]) && fs.readdirSync(path.dirname(file)).some((f) => /^tabs\.json\.corrupt-\d+$/.test(f)), "corrupt tabs.json → empty registry, file kept aside, logged once");
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/tabs.registry.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/tabs.js`** and the `TABS_FILE` export.

- [ ] **Step 4: Run to verify it passes**

Run: `node test/tabs.registry.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tabs.js server/token.js test/tabs.registry.test.js package.json
git commit -m "server: tab registry persisted in tabs.json (browser-session binding, pending creations, lastCmdAt, select/reconcile)"
```

---

### Task 6: Registry wiring in the relay (creation bookkeeping independent of the CLI socket)

**Files:**
- Modify: `server/server.js`
- Create: `test/protocol.tabs.test.js` (part 1)
- Modify: `package.json`

**Interfaces:**
- Consumes `openRegistry` (Task 5), `finish` (Task 4), `accessState` (Task 3).
- Produces in `server/server.js`:
  - `registry = openRegistry(TABS_FILE, { log })` at start.
  - `sendInternal(cmd, params) → Promise<{ ok, result?, error? }>` — creates a pending entry `{ id: "srv-<n>", sock: null, client: "server", runId: null, resolve }`, runs the same gate (`refused` resolves `{ok:false, error}`), forwards, resolves from `finish`.
  - Hooks in the request path and in `finish`:
    - On forwarding `newTab`: `registry.addPending({ reqId: id, runId, client, origin: registry.originOf(params.url), createdAt: t0, browserSession: ext.access.browserSession })`.
    - In `finish` for `newTab`: `done ok` with integer `result.id` → `registry.completePending(id, result.id)` (then Task 7 hooks); any other outcome → `registry.dropPending(id)`.
    - **CLI socket close no longer deletes pending entries**: the entry's `sock` is set to `null`, so the response still reaches `finish` and bookkeeping completes (CLI disconnect only removes "who to answer").
    - Any command with integer `params.tabId` that finishes `done ok` → `registry.touch(tabId, Date.now())`.
    - `closeTab` `done ok` → `registry.remove([params.tabId])`; `closeTabs` `done ok` → `registry.remove(result.closed)` when it is an array.
    - `status` `done ok` with `Array.isArray(result.agentTabs)` → `registry.reconcile(result.agentTabs)`.
    - On every accepted `access` message with a `browserSession`: `registry.setBrowserSession(bs)`; when the state is `granted`, `sendInternal("status", {})` (reconciliation).

- [ ] **Step 1: Write the failing tests** (first half of `test/protocol.tabs.test.js`):

```js
const relay = await startRelay();
const bs = randomHex32();
let holdNewTab = null;
const ext = await fakeExtension(relay, { browserSession: bs, handler: (cmd, p, id) => { if (cmd === "newTab" && /hold/.test(p.url)) { holdNewTab = id; return undefined; } } });
await sleep(150);
const tabsFile = path.join(relay.home, "tabs.json");
assert(JSON.parse(fs.readFileSync(tabsFile, "utf8")).browserSession === bs, "registry records the browser session from the access message");
assert(ext.received.some((m) => m.cmd === "status"), "server issued its own status for reconciliation after access");
// CLI disconnects before the extension answers
const p = cli(relay, ["newTab", '{"url":"https://hold.example/x"}', "--timeout", "300"], { env: { AI_BRIDGE_CLIENT: "t" } });
await ext.waitFor("newTab");
await p; // CLI timed out (exit 3) and closed its socket
ext.respond(holdNewTab, { ok: true, result: { id: 777, windowId: 1 } });
await sleep(100);
let reg = JSON.parse(fs.readFileSync(tabsFile, "utf8"));
assert(reg.tabs.some((r) => r.tabId === 777 && r.client === "t" && r.origin === "https://hold.example" && r.lastCmdAt === r.createdAt), "late response after CLI disconnect still recorded");
assert(/ srv-\d+ server - cmd status /.test(fs.readFileSync(relay.logFile, "utf8")), "internal requests logged with srv- ids and client server");
// failed creation
await cli(relay, ["newTab", '{"url":"https://fail.example/"}', "--timeout", "3000"]); // make the handler answer ok:false for fail.example
reg = JSON.parse(fs.readFileSync(tabsFile, "utf8"));
assert(!reg.tabs.some((r) => r.origin === "https://fail.example") && reg.pending.length === 0, "failed newTab leaves no row and no pending entry");
// touch, closeTab, user tab untouched
await cli(relay, ["eval", '{"tabId":777,"code":"1"}', "--timeout", "3000"]);
reg = JSON.parse(fs.readFileSync(tabsFile, "utf8"));
assert(reg.tabs.find((r) => r.tabId === 777).lastCmdAt > reg.tabs.find((r) => r.tabId === 777).createdAt, "a command on the tab refreshes lastCmdAt");
await cli(relay, ["closeTab", '{"tabId":4242}', "--timeout", "3000"]);
assert(JSON.parse(fs.readFileSync(tabsFile, "utf8")).tabs.length === reg.tabs.length, "closeTab on an unknown (user) tab leaves the registry untouched");
await cli(relay, ["closeTab", '{"tabId":777}', "--timeout", "3000"]);
assert(!JSON.parse(fs.readFileSync(tabsFile, "utf8")).tabs.some((r) => r.tabId === 777), "closeTab removes the row");
// reconciliation on status
await cli(relay, ["newTab", '{"url":"https://a.example/"}', "--timeout", "3000"]);
ext.agentTabs = []; // handler's status now reports no owned tabs
await cli(relay, ["status", "--timeout", "3000"]);
assert(JSON.parse(fs.readFileSync(tabsFile, "utf8")).tabs.length === 0, "status.agentTabs reconciles the registry");
// relay restart loads and reconciles tabs.json
await cli(relay, ["newTab", '{"url":"https://keep.example/"}', "--timeout", "3000"]);
```

Finish the restart case: `relay.stop()` must keep the home (add `stop({ keepHome: true })` to the harness); `startRelay({ home })` reuses it; a new `fakeExtension` with the **same** `browserSession` whose status reports the kept id → row still present; with a **different** `browserSession` → the row is listed dead and pruned after the status reconciliation.

- [ ] **Step 2: Run to verify it fails**

Run: `node test/protocol.tabs.test.js`
Expected: FAIL at "registry records the browser session".

- [ ] **Step 3: Implement the hooks** listed under Interfaces. Extend the harness: `fakeExtension` gets a mutable `ext.agentTabs` array used by the default `status` handler and appended to by the default `newTab` handler; default handler answers `ok:false, error:"could not create"` for URLs containing `fail.example`; `stop({ keepHome })` and `startRelay({ home })`.

- [ ] **Step 4: Run the tests**

Run: `node test/protocol.tabs.test.js && node test/protocol.test.js && node test/protocol.access.test.js && node test/protocol.log.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/server.js test/protocol.tabs.test.js test/helpers/relay.js package.json
git commit -m "server: registry bookkeeping independent of the CLI socket; touch/remove/reconcile hooks; server-issued status after access"
```

---

### Task 7: Run leases, drain, cleanup, late creations, retained tabs, journal patching

**Files:**
- Create: `server/runs.js`
- Modify: `server/server.js` (`run`/`runEnd` messages, socket close, hooks from `finish`)
- Modify: `server/journal.js` (`patchRun`)
- Modify: `test/journal.test.js` (`patchRun`)
- Modify: `test/protocol.tabs.test.js` (part 2)

**Interfaces:**
- Consumes `registry` (Task 5/6), `sendInternal`, `accessState`, `log`.
- Produces `server/journal.js`: `patchRun(runId, patch) → boolean` — under `withLock(JOURNAL_FILE)`, rewrites `journal.jsonl` atomically with `{...record, ...patch}` for the **last** record whose `runId` matches; `false` when none.
- Produces `server/runs.js`: `createRunManager({ registry, sendCommand, accessState, log, patchJournal, drainMs = 5000 })`:
  - `rm.register({ runId, client, keepTabs, sock }) → { ok: true } | { ok: false, error: "run already live: <runId>" }`.
  - `rm.get(runId) → { runId, client, keepTabs, state: "live"|"ending"|"ended", counts: { opened, closed, retained, kept } } | undefined`.
  - `rm.noteOpened(runId)` — `counts.opened++` when the run is known (any state).
  - `rm.end(runId, { reason }) → Promise<counts|null>` — `null` for an unknown run; idempotent (returns the same promise). Algorithm: `state = "ending"`; poll every 50 ms until `registry.pendingForRun(runId) === 0` or `drainMs` elapsed; `ids = registry.rowsForRun(runId).map(r => r.tabId)`; if `keepTabs` → `counts.kept = ids.length` (rows stay live); else if `accessState() === "granted"` and `ids.length` → `const r = await sendCommand("closeTabs", { tabIds: ids })`; on `r.ok` → `counts.closed += r.result.closed.length`, `registry.remove(r.result.closed)`, `registry.markRetained` for the skipped ids (`counts.retained += skipped.length`); on `!r.ok` → everything retained; else (not granted) → `registry.markRetained(runId)`, `counts.retained = ids.length`. Then `state = "ended"`, log `run <runId> ended (<reason>): opened N closed N retained N kept N`, resolve counts.
  - `rm.lateCreation(runId, tabId) → Promise<void>` — for a run in state `ended`: mark the row `late: true`; if `!keepTabs && accessState() === "granted"` → `sendCommand("closeTabs", { tabIds: [tabId] })` and update `closed`/`retained` as above, else `retained++` and `markRetained`; then `patchJournal(runId, { tabsOpened, tabsClosed, tabsRetained, keptTabs, late: true })`; log `run <runId> late tab <tabId> <closed|retained>`.
  - `rm.onSocketClose(sock)` — `end(runId, { reason: "lease_closed" })` for every run registered on that socket that is still `live`.
- Produces in `server/server.js`:
  - CLI-role socket message `{type:"run", runId, client, keepTabs}` → `safeRunId` check (`ok:false, error:"bad runId"`), `rm.register(...)`, reply `{ type: "run", runId, ok, error? }`; log `run <runId> registered (<client>, keepTabs=<bool>)`.
  - `{type:"runEnd", runId}` → `rm.end(runId, { reason: "runEnd" })` then reply `{ type: "runEnd", runId, ok: true, tabs: counts }` (unknown → `ok:false, error:"unknown run"`).
  - Socket close → `rm.onSocketClose(sock)` (in addition to the Task 6 behaviour).
  - In `finish` for `newTab` `done ok`: after `completePending`, `rm.noteOpened(runId)`; if `rm.get(runId)?.state === "ended"` → `rm.lateCreation(runId, tabId)`.
  - `drainMs = Number(process.env.BRIDGE_DRAIN_MS) || 5000` (comment: tests only).

- [ ] **Step 1: Write the failing tests** — `test/journal.test.js` addition:

```js
J.appendJournal(rec({ runId: "patchme", job: "p" }));
assert(J.patchRun("patchme", { tabsClosed: 2, late: true }) === true, "patchRun returns true");
const got = J.readJournal().find((r) => r.runId === "patchme");
assert(got.tabsClosed === 2 && got.late === true && got.job === "p", "patchRun merges into the record in place");
assert(J.patchRun("nope", { x: 1 }) === false, "patchRun unknown run → false");
```

Second half of `test/protocol.tabs.test.js` (relay started with `env: { BRIDGE_DRAIN_MS: "300" }`, extension handler holds `newTab` for URLs containing `slow` and answers them when the test calls `ext.respond`):

```js
// lease closes without runEnd → closeTabs with exactly the run's live tabs after the drain; a creation answered during the drain is included
let lease = await leaseSocket(relay, { runId: "runA00000001", client: "bridge agent" });
await cli(relay, ["newTab", '{"url":"https://a.example/1"}', "--timeout", "3000"], { env: { AI_BRIDGE_RUN_ID: "runA00000001" } });  // id 100
const slow = cli(relay, ["newTab", '{"url":"https://slow.example/2"}', "--timeout", "3000"], { env: { AI_BRIDGE_RUN_ID: "runA00000001" } });
const slowCmd = await ext.waitFor("newTab");
await cli(relay, ["newTab", '{"url":"https://b.example/"}', "--timeout", "3000"], { env: { AI_BRIDGE_RUN_ID: "runB00000001" } }); // other run, id 101
lease.ws.terminate(); // simulated supervisor death
await sleep(100); ext.respond(slowCmd.id, { ok: true, result: { id: 902, windowId: 1 } }); await slow; // test-chosen ids are 900+, the handler's counter stays at 100+
const close1 = await ext.waitFor("closeTabs", { timeoutMs: 2000 });
assert(JSON.stringify(close1.params.tabIds.sort()) === "[100,902]", "lease loss → closeTabs with exactly the run's tabs, including one answered during the drain");
await sleep(100);
assert(!JSON.parse(fs.readFileSync(tabsFile, "utf8")).tabs.some((r) => r.runId === "runA00000001"), "closed rows removed");
assert(/run runA00000001 ended \(lease_closed\): opened 2 closed 2 retained 0 kept 0/.test(fs.readFileSync(relay.logFile, "utf8")), "run end logged with counts");
// runEnd with keepTabs sends nothing; ack carries counts
lease = await leaseSocket(relay, { runId: "runK00000001", keepTabs: true });
await cli(relay, ["newTab", '{"url":"https://k.example/"}', "--timeout", "3000"], { env: { AI_BRIDGE_RUN_ID: "runK00000001" } });
const before = ext.received.filter((m) => m.cmd === "closeTabs").length;
const ack = await lease.end();
assert(ack.ok === true && ack.tabs.opened === 1 && ack.tabs.kept === 1 && ack.tabs.closed === 0 && ext.received.filter((m) => m.cmd === "closeTabs").length === before, "runEnd with keepTabs: no closeTabs, counts in the ack");
assert(JSON.parse(fs.readFileSync(tabsFile, "utf8")).tabs.some((r) => r.runId === "runK00000001" && r.status === "live"), "kept tab stays live in the registry");
// run ended while revoked → retained, no closeTabs
lease = await leaseSocket(relay, { runId: "runR00000001" });
await cli(relay, ["newTab", '{"url":"https://r.example/"}', "--timeout", "3000"], { env: { AI_BRIDGE_RUN_ID: "runR00000001" } });
ext.sendAccess({ granted: false, until: null, gen: 9 }); await sleep(100);
const ack2 = await lease.end();
assert(ack2.tabs.retained === 1 && ack2.tabs.closed === 0 && ext.received.filter((m) => m.cmd === "closeTabs").length === before, "revoked at run end → retained, no closeTabs");
assert(JSON.parse(fs.readFileSync(tabsFile, "utf8")).tabs.find((r) => r.runId === "runR00000001").status === "retained", "row marked retained");
ext.sendAccess({ granted: true, until: null, gen: 10 }); await sleep(150);
// late creation after the drain
lease = await leaseSocket(relay, { runId: "runL00000001" });
const late = cli(relay, ["newTab", '{"url":"https://slow.example/late"}', "--timeout", "5000"], { env: { AI_BRIDGE_RUN_ID: "runL00000001" } });
const lateCmd = await ext.waitFor("newTab");
const journalFile = path.join(relay.home, "journal.jsonl"); // written with fs: journal.js binds AI_BRIDGE_HOME at require time
fs.appendFileSync(journalFile, JSON.stringify({ runId: "runL00000001", startedAt: new Date().toISOString(), verdict: "pass", tabsOpened: 0, tabsClosed: 0, tabsRetained: 0, keptTabs: 0 }) + "\n");
const ack3 = await lease.end(); // drain 300 ms expires with the creation pending
assert(ack3.tabs.opened === 0 && JSON.parse(fs.readFileSync(tabsFile, "utf8")).pending.some((p) => p.runId === "runL00000001"), "pending creation survives the drain deadline");
ext.respond(lateCmd.id, { ok: true, result: { id: 903, windowId: 1 } }); await late;
const close3 = await ext.waitFor("closeTabs", { timeoutMs: 2000 });
assert(JSON.stringify(close3.params.tabIds) === "[903]", "late creation closed by a second closeTabs");
await sleep(100);
const jrec = fs.readFileSync(journalFile, "utf8").trim().split("\n").map(JSON.parse).find((r) => r.runId === "runL00000001");
assert(jrec.tabsOpened === 1 && jrec.tabsClosed === 1 && jrec.late === true, "journal record patched in place with late: true");
// stale browser session never included
const keptId = JSON.parse(fs.readFileSync(tabsFile, "utf8")).tabs.find((r) => r.runId === "runK00000001").tabId;
const stale = await fakeExtension(relay, { browserSession: randomHex32() }); await sleep(150); // supersedes `ext`; its status reports no agentTabs
assert(JSON.parse(fs.readFileSync(tabsFile, "utf8")).tabs.every((r) => r.tabId !== keptId), "rows of the old browser session are pruned on reconciliation");
await cli(relay, ["closeTabs", '{"tabIds":[' + keptId + ']}', "--timeout", "3000"]); // explicit ids still go to the extension, which owns none of them
assert(stale.received.some((m) => m.cmd === "closeTabs") && !fs.readFileSync(tabsFile, "utf8").includes('"tabId": ' + keptId), "a stale row is never resurrected");
// duplicate run refused; lease socket still serves requests
lease = await leaseSocket(relay, { runId: "runD00000001" });
let dup = null; try { await leaseSocket(relay, { runId: "runD00000001" }); } catch (e) { dup = e; }
assert(dup && /already live/.test(dup.message), "a run for a live runId is refused");
lease.send({ type: "request", id: "feedfeedfeedfeed", cmd: "ping", params: {}, meta: { client: "lease" } });
const pong = await new Promise((res) => lease.ws.once("message", (d) => res(JSON.parse(d))));
assert(pong.type === "response" && pong.ok && pong.result.pong === true, "ordinary requests on a lease socket are served");
await lease.end();
```

Also a **SIGKILL child** case: spawn `node -e` (a child process) that opens a lease for `runX00000001` and then sleeps; create a tab under that run via `cli`; `child.kill("SIGKILL")`; assert `closeTabs [id]` arrives within 2 s. Use `AI_BRIDGE_HOME`/`BRIDGE_PORT` from `relay` in the child's env and `require("<repo>/server/lease.js")` — so this assertion is written now and enabled after Task 9 lands `server/lease.js` (mark it `// enabled in Task 9` and skip when the module is missing).

- [ ] **Step 2: Run to verify it fails**

Run: `node test/journal.test.js && node test/protocol.tabs.test.js`
Expected: journal FAIL on `patchRun`; protocol.tabs FAIL at "lease loss → closeTabs".

- [ ] **Step 3: Implement `patchRun`**, then `server/runs.js`, then the server wiring.

- [ ] **Step 4: Run the tests**

Run: `node test/journal.test.js && node test/protocol.tabs.test.js && node test/protocol.test.js && node test/protocol.access.test.js && node test/protocol.log.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/runs.js server/server.js server/journal.js test/journal.test.js test/protocol.tabs.test.js test/helpers/relay.js
git commit -m "server: run leases (run/runEnd), 5-s drain, owned-tab cleanup via closeTabs, retained tabs under revoke, late creations patch the journal"
```

---

### Task 8: `bridge tabs`, `bridge closeTabs`, restricted deny

**Files:**
- Modify: `server/cli.js`
- Modify: `server/server.js` (validate `closeTabs` params before forwarding)
- Modify: `test/cli.restricted.test.js`
- Modify: `test/protocol.tabs.test.js` (CLI section)

**Interfaces:**
- Consumes `openRegistry(TABS_FILE)` read-only from the CLI process; the `closeTabs` wire command.
- Produces in `server/cli.js`:
  - `bridge tabs [--json]` — prints `tabId  age  client  run  origin  status` rows for `list().current` (age from `lastCmdAt`, `Xm`/`Xh`/`Xd`), then `from an earlier Chrome session:` and the dead rows (tabId, client, run, origin); `--json` prints `{ current, dead }`. Empty registry prints `no bridge-opened tabs recorded`. Exit 0.
  - `bridge closeTabs --mine | --run <id> | --older-than <minutes> [--json]` — exactly one selector required (usage exit 2 otherwise); `--mine` uses the same client label the CLI sends; selection via `registry.select(...)`; empty selection prints `{"closed":[],"skipped":[]}` and exits 0 without connecting; otherwise sends `closeTabs {tabIds}` through the normal `send()` path (so access errors exit 8 and the server updates the registry). `bridge closeTabs '{"tabIds":[…]}'` (explicit JSON) keeps working through the generic path.
  - `RESTRICTED_DENY` gains `"tabs"`, `"closeTabs"`.
- Produces in `server/server.js`: a `closeTabs` request whose `params.tabIds` is not an array of integers is refused with `closeTabs: tabIds must be an array of integers` (through `finish`, kind `refused`).

- [ ] **Step 1: Write the failing tests** — `test/cli.restricted.test.js`: add `"tabs", "closeTabs"` to the loop of refused subcommands. `test/protocol.tabs.test.js` CLI section (relay from Task 7 still running, access granted, a fresh `ext`):

```js
await cli(relay, ["newTab", '{"url":"https://mine.example/"}', "--timeout", "3000"], { env: { AI_BRIDGE_CLIENT: "me" } });
await cli(relay, ["newTab", '{"url":"https://other.example/"}', "--timeout", "3000"], { env: { AI_BRIDGE_CLIENT: "other" } });
let r = await cli(relay, ["tabs"]);
assert(r.code === 0 && /mine\.example/.test(r.stdout) && /other\.example/.test(r.stdout) && /from an earlier Chrome session/.test(r.stdout), "bridge tabs lists current and dead rows");
r = await cli(relay, ["tabs", "--json"]);
assert(Array.isArray(r.json.current) && Array.isArray(r.json.dead), "bridge tabs --json");
r = await cli(relay, ["closeTabs", "--mine", "--timeout", "3000"], { env: { AI_BRIDGE_CLIENT: "me" } });
assert(r.code === 0 && r.json.closed.length === 1 && !(await cli(relay, ["tabs"])).stdout.includes("mine.example") && (await cli(relay, ["tabs"])).stdout.includes("other.example"), "closeTabs --mine closes only my tabs");
r = await cli(relay, ["closeTabs", "--older-than", "1", "--timeout", "3000"]);
assert(r.code === 0 && r.json.closed.length === 0, "nothing older than a minute → empty result, no request");
r = await cli(relay, ["closeTabs", "--older-than", "0", "--timeout", "3000"]);
assert(r.code === 0 && r.json.closed.length === 1, "--older-than 0 selects the remaining tab");
r = await cli(relay, ["closeTabs"]); assert(r.code === 2, "closeTabs without a selector → usage");
r = await cli(relay, ["closeTabs", "--mine", "--run", "x"]); assert(r.code === 2, "two selectors → usage");
r = await cli(relay, ["closeTabs", '{"tabIds":"nope"}', "--timeout", "3000"]);
assert(r.code === 1 && /tabIds must be an array of integers/.test(r.stderr), "server refuses malformed tabIds");
ext.sendAccess({ granted: false, until: null, gen: 20 }); await sleep(100);
await cli(relay, ["newTab", "{}", "--timeout", "500"]); // refused; make a row by re-granting below
ext.sendAccess({ granted: true, until: null, gen: 21 }); await sleep(100);
await cli(relay, ["newTab", '{"url":"https://z.example/"}', "--timeout", "3000"], { env: { AI_BRIDGE_CLIENT: "me" } });
ext.sendAccess({ granted: false, until: null, gen: 22 }); await sleep(100);
r = await cli(relay, ["closeTabs", "--mine", "--timeout", "3000"], { env: { AI_BRIDGE_CLIENT: "me" } });
assert(r.code === 8, "closeTabs while revoked → exit 8 (gate unchanged)");
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/cli.restricted.test.js && node test/protocol.tabs.test.js`
Expected: restricted FAIL on `tabs`/`closeTabs` (not refused); protocol.tabs FAIL at "bridge tabs lists".

- [ ] **Step 3: Implement** the CLI subcommands (parse their own flags **before** the generic `JSON.parse` loop), the deny-list entries, and the server-side `tabIds` validation.

- [ ] **Step 4: Run the tests**

Run: `node test/cli.restricted.test.js && node test/protocol.tabs.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/cli.js server/server.js test/cli.restricted.test.js test/protocol.tabs.test.js
git commit -m "cli: bridge tabs and bridge closeTabs --mine|--run|--older-than (restricted: denied); server validates closeTabs tabIds"
```

---

### Task 9: Supervisor lease in `bridge agent`, `--keep-tabs`, journal counters

**Files:**
- Create: `server/lease.js`
- Modify: `server/agent.js` (`runAgent`, `journalRecord`, `main`, `printJournalLine`)
- Modify: `server/journal.js` (`formatReport` column)
- Modify: `test/agent.test.js`, `test/journal.test.js`, `test/protocol.tabs.test.js` (enable the SIGKILL case)

**Interfaces:**
- Consumes the `run`/`runEnd` wire messages (Task 7).
- Produces `server/lease.js`: `openLease({ port = Number(process.env.BRIDGE_PORT || 8765), token = <read TOKEN_FILE>, runId, client, keepTabs = false, timeoutMs = 10000 }) → Promise<Lease>` — rejects on connect failure, auth failure or `run` ack `ok:false` (`new Error(ack.error)`). `Lease.end() → Promise<{opened, closed, retained, kept}|null>` — sends `runEnd`, resolves with `ack.tabs`, or `null` after `timeoutMs` or if the socket is already closed; closes the socket. `Lease.close()` — closes without `runEnd` (tests only).
- Produces in `server/agent.js`:
  - `runAgent`: `const client = opts.client || process.env.AI_BRIDGE_CLIENT || "bridge agent"`; `const keepTabs = !!opts.keepTabs || /\b(leave|keep)\b.{0,40}\btabs?\b.{0,20}\bopen\b/i.test(task)`; `childEnv` gains `AI_BRIDGE_CLIENT: client`; `D.openLease` (default `require("./lease").openLease`) is called right after `childEnv` is built: `lease = await D.openLease({ runId, client, keepTabs })` in a try/catch that logs `[agent] tab lease unavailable: <msg>` when verbose and continues; before `journalRecord`, `const tabs = lease ? await lease.end() : null` in a `finally`-equivalent position (runs on every exit path of the ladder, including abort and thrown errors); `journalRecord({..., tabs})` adds `tabsOpened, tabsClosed, tabsRetained, keptTabs` from `tabs` (omitted when `null`).
  - `main`: `--keep-tabs` → `opts.keepTabs = true`; usage line updated.
  - `printJournalLine`: appends `; tabs: opened N closed N retained N kept N` when the record has the counters, and `; N tab(s) left open` when `retained + kept > 0`.
- Produces in `server/journal.js`: `formatReport` gains a `tabs left` column = sum of `tabsRetained` over the group's runs.

- [ ] **Step 1: Write the failing tests** — `test/agent.test.js` additions (mock lease):

```js
function mockLease() { const calls = []; const open = async (o) => { calls.push({ open: o }); return { end: async () => { calls.push({ end: o.runId }); return { opened: 2, closed: 1, retained: 1, kept: 0 }; }, close() {} }; }; return { open, calls }; }
{ const m = mockRun(['{"verdict":"pass","feedback":"ok"}']); const L = mockLease();
  const r = await runAgent("test task", { runId: "leaseok00001" }, m.run, { openLease: L.open });
  assert(L.calls[0].open.runId === "leaseok00001" && L.calls[0].open.client === "bridge agent" && L.calls[0].open.keepTabs === false, "lease opened with runId/client/keepTabs");
  assert(L.calls.some((c) => c.end === "leaseok00001") && r.record.tabsOpened === 2 && r.record.tabsClosed === 1 && r.record.tabsRetained === 1 && r.record.keptTabs === 0, "runEnd sent; counters in the journal record");
  assert(m.calls[0].env.AI_BRIDGE_CLIENT === "bridge agent", "children get AI_BRIDGE_CLIENT"); }
{ const m = mockRun(['{"verdict":"fail","feedback":"no"}', '{"verdict":"fail","feedback":"no"}', '{"verdict":"fail","feedback":"no"}']); const L = mockLease();
  await runAgent("test task", {}, m.run, { openLease: L.open });
  assert(L.calls.filter((c) => c.end).length === 1, "a run that fails every rung still sends runEnd exactly once"); }
{ const m = mockRun([]); const L = mockLease(); const thrower = async () => { throw new Error("model exploded"); };
  let threw = false; try { await runAgent("t", {}, thrower, { openLease: L.open }); } catch { threw = true; }
  assert(threw && L.calls.some((c) => c.end), "runEnd sent even when the ladder throws"); }
{ const L = mockLease(); const m = mockRun(['{"verdict":"pass","feedback":"ok"}']);
  await runAgent("open the page and leave the tab open for me", {}, m.run, { openLease: L.open });
  assert(L.calls[0].open.keepTabs === true, "'leave the tab open' in the task → keepTabs");
  const L2 = mockLease(); await runAgent("t", { keepTabs: true }, m.run, { openLease: L2.open });
  assert(L2.calls[0].open.keepTabs === true, "--keep-tabs → keepTabs"); }
{ const m = mockRun(['{"verdict":"pass","feedback":"ok"}']);
  const r = await runAgent("t", {}, m.run, { openLease: async () => { throw new Error("ECONNREFUSED"); } });
  assert(r.verdict.verdict === "pass" && r.record.tabsOpened === undefined, "lease failure does not fail the run; counters omitted"); }
```

`test/journal.test.js`: two records with `tabsRetained: 1` and `0` under job `a` → `formatReport` output contains a `tabs left` header and the row for `job:a` shows `1`.

Enable the SIGKILL case in `test/protocol.tabs.test.js`: child script `const { openLease } = require(process.argv[1]); openLease({ runId: "runX00000001", client: "child" }).then(() => setInterval(() => {}, 1000))` run with `node -e` and `BRIDGE_PORT`/`AI_BRIDGE_HOME` from `relay`; wait for the log line `run runX00000001 registered`; `cli newTab` under `AI_BRIDGE_RUN_ID=runX00000001`; `child.kill("SIGKILL")`; `await ext.waitFor("closeTabs", { timeoutMs: 2000 })` names that tab id; assert the log has `ended (lease_closed)`.

- [ ] **Step 2: Run to verify it fails**

Run: `node test/agent.test.js && node test/journal.test.js && node test/protocol.tabs.test.js`
Expected: agent FAIL on "lease opened"; journal FAIL on `tabs left`; protocol.tabs FAIL/skip on the SIGKILL case.

- [ ] **Step 3: Implement** `server/lease.js`, the `runAgent` changes, `--keep-tabs`, `journalRecord` counters, `printJournalLine`, `formatReport` column.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: every script ends with its pass line; exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/lease.js server/agent.js server/journal.js test/agent.test.js test/journal.test.js test/protocol.tabs.test.js
git commit -m "agent: run lease around every run (runEnd on all exit paths), --keep-tabs, tab counters in the journal and report"
```

---

### Task 10: Extension — `browserSession`, `access` message, `agentTabs`, `closeTabs`, `status.agentTabs`

**Files:**
- Create: `extension/access.js`
- Modify: `extension/background.js`
- Create: `test/extension.access.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces `extension/access.js` (classic script: defines `BridgeAccess` on `self`, and `module.exports` when `module` exists; reads the global `chrome`; random bytes from `globalThis.crypto` or `require("crypto").webcrypto` when `require` exists):
  - `ensureBrowserSession() → Promise<string>` — `chrome.storage.session.get("browserSession")`; when absent or malformed, writes a fresh 32-lowercase-hex id and returns it.
  - `accessState() → Promise<{ granted, until, gen }>` — `chrome.storage.local.get({ access: { granted: true, until: null, gen: 1 } })` (slice-1 default; the next slice changes the default and adds grant/revoke).
  - `accessMessage(session) → Promise<{ type: "access", session, granted, until, gen, browserSession }>`.
  - `rememberAgentTab(tabId)`, `forgetAgentTab(tabId)`, `agentTabIds() → Promise<number[]>` — `chrome.storage.session` key `agentTabs` (array of integers, de-duplicated).
  - `closeOwnedTabs(tabIds) → Promise<{ closed: number[], skipped: number[] }>` — `skipped` = ids not in `agentTabs` (or not integers); for each owned id `await chrome.tabs.remove(id)` individually; a rejection moves the id to `skipped`; every attempted id (closed or rejected) is forgotten from `agentTabs`.
- Produces in `extension/background.js`: `importScripts("access.js")` first line; `DEFAULTS.session = "chrome"`; after `{type:"auth", ok:true}` the worker sends `await BridgeAccess.accessMessage(cfg.session)` and only then handles commands; `newTab` → `rememberAgentTab(tab.id)` before returning; `closeTab` → `forgetAgentTab`; `chrome.tabs.onRemoved` → `forgetAgentTab`; new case `closeTabs` → `BridgeAccess.closeOwnedTabs(p.tabIds)`; `status` adds `agentTabs: await BridgeAccess.agentTabIds()`.

- [ ] **Step 1: Write the failing test** `test/extension.access.test.js` with a stub `chrome`:

```js
function stubChrome() {
  const mem = { session: {}, local: {} };
  const area = (name) => ({
    get: async (q) => { const out = {}; const keys = typeof q === "string" ? [q] : Array.isArray(q) ? q : Object.keys(q); for (const k of keys) out[k] = k in mem[name] ? mem[name][k] : (q && typeof q === "object" && !Array.isArray(q) ? q[k] : undefined); return out; },
    set: async (o) => Object.assign(mem[name], o), clear: async () => { mem[name] = {}; },
  });
  const removed = []; let failIds = new Set();
  return { chrome: { storage: { session: area("session"), local: area("local") }, tabs: { remove: async (id) => { if (failIds.has(id)) throw new Error("No tab with id"); removed.push(id); } } }, mem, removed, failIds };
}
const S = stubChrome(); global.chrome = S.chrome;
const B = require("../extension/access.js");
const bs = await B.ensureBrowserSession();
assert(/^[0-9a-f]{32}$/.test(bs) && (await B.ensureBrowserSession()) === bs, "browserSession created once and stable");
await S.chrome.storage.session.clear(); // simulated reload / browser restart
assert((await B.ensureBrowserSession()) !== bs, "cleared session storage → new browserSession");
const msg = await B.accessMessage("work-chrome");
assert(msg.type === "access" && msg.session === "work-chrome" && msg.granted === true && msg.until === null && msg.gen === 1 && /^[0-9a-f]{32}$/.test(msg.browserSession), "slice-1 default access message is granted/indefinite/gen 1");
await S.chrome.storage.local.set({ access: { granted: false, until: null, gen: 4 } });
assert((await B.accessMessage("c")).granted === false && (await B.accessMessage("c")).gen === 4, "access message reflects stored state");
await B.rememberAgentTab(10); await B.rememberAgentTab(11); await B.rememberAgentTab(11);
assert(JSON.stringify(await B.agentTabIds()) === "[10,11]", "agentTabs de-duplicated");
let r = await B.closeOwnedTabs([10, 99, "x"]);
assert(JSON.stringify(r.closed) === "[10]" && JSON.stringify(r.skipped) === "[99,\"x\"]" && JSON.stringify(S.removed) === "[10]" && JSON.stringify(await B.agentTabIds()) === "[11]", "closeTabs closes only owned ids, reports the rest skipped");
S.failIds.add(11);
r = await B.closeOwnedTabs([11]);
assert(r.closed.length === 0 && JSON.stringify(r.skipped) === "[11]" && (await B.agentTabIds()).length === 0, "remove rejection → skipped and forgotten");
await B.rememberAgentTab(12); await B.forgetAgentTab(12);
assert((await B.agentTabIds()).length === 0, "forgetAgentTab");
```

Plus a source-level check that `background.js` wires it: `const src = fs.readFileSync("extension/background.js","utf8"); assert(/^importScripts\("access\.js"\)/m.test(src) && /case "closeTabs"/.test(src) && /agentTabs:/.test(src) && /rememberAgentTab\(/.test(src) && /forgetAgentTab\(/.test(src) && /accessMessage\(/.test(src), "background.js wires BridgeAccess")`.

- [ ] **Step 2: Run to verify it fails**

Run: `node test/extension.access.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `extension/access.js`** and the `background.js` wiring. Load the real `access.js` once in Chrome to confirm `importScripts` works (`chrome://extensions` → reload → service worker console shows no error): record the result in the commit message.

- [ ] **Step 4: Run the test and the full suite**

Run: `node test/extension.access.test.js && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/access.js extension/background.js test/extension.access.test.js package.json
git commit -m "extension: browserSession + access message after auth, agentTabs in session storage, closeTabs command, status.agentTabs"
```

---

### Task 11: Docs, spec amendments, manual test rows

**Files:**
- Modify: `docs/superpowers/specs/2026-11-21-docker-isolated-access-design.md` (Wire contract: `status` result `agentTabs`; `run`/`runEnd` acks; note that `bridge tabs` reads `tabs.json`; `BRIDGE_DRAIN_MS` as a test-only knob)
- Modify: `docs/DOCKER.md` (*Abandoned tabs*: `bridge tabs` output example, `--keep-tabs`, channel turns not leased yet; *Debugging*: the `(req <id>)` line and `journal --trace` columns; change table rows #13/#14 → "implemented in PR <n>")
- Modify: `README.md` (Usage: `bridge tabs`, `bridge closeTabs --mine|--run|--older-than`, `bridge agent --keep-tabs`; Security model: one sentence on what the registry stores)
- Modify: `test/TEST-PLAN.md` (manual rows: reload the extension with agent tabs open → `bridge tabs` shows them as "from an earlier Chrome session"; a run killed with Ctrl-C closes its tabs; a tab the user dragged into the agent's window survives `closeTabs`)

- [ ] **Step 1: Make the doc edits.** Keep the spec's contract wording in the same style as its existing entries; the amendments are three short paragraphs, not a rewrite.

- [ ] **Step 2: Verify** `npm test` still passes and `git diff --stat` touches only the files above.

- [ ] **Step 3: Commit**

```bash
git add docs README.md test/TEST-PLAN.md
git commit -m "docs: tab hygiene and request-id correlation as implemented (status.agentTabs, run acks, bridge tabs/closeTabs, --keep-tabs)"
```

---

### Task 12: Branch review and PR

- [ ] **Step 1:** `npm test` on the branch; paste the final pass lines into the PR description.
- [ ] **Step 2:** Astra review of the whole branch diff (`codex exec -m gpt-6-astra --sandbox read-only -C <repo> --ephemeral --skip-git-repo-check --color never -o "$OUT" "<prompt>" < /dev/null`, in the background), prompt: review `git diff docker-isolated..HEAD` against the spec sections named at the top of this plan, with the plan decisions listed as intentional; fold findings; repeat until APPROVE.
- [ ] **Step 3:** Open the PR against `docker-isolated` with the summary, the plan decisions, and the Astra verdict; no review text in the repo.
