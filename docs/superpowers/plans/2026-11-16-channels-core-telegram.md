# Channels core + Telegram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `bridge channels start` daemon that lets a paired Telegram user text a task, approve risky steps before they run, and receive the verdict, evidence and files, with the agent running in a restricted mode.

**Architecture:** A separate long-running process (`server/channels/main.js`) hosts transport adapters (`server/channels/telegram.js` first) and one manager that owns policy, pairing, rate limits, dedup, a serial queue, approvals, chunking and outbox delivery. The manager calls the existing `runAgent()` with new hooks (`approve`, `signal`, `restricted`, `cwd`, `onProgress`); `agent.js` gains the recipe gate, the stop-before-send pause, and `declined`/`cancelled` verdicts. Adapters do transport only.

**Tech Stack:** Node ≥ 18 (global `fetch`, `FormData`, `Blob`), existing `ws`, no new dependencies. Plain-node test scripts as in `test/*.test.js`.

**Spec:** `docs/superpowers/specs/2026-11-15-messenger-channels-design.md`

**Branch:** `feat/channels-core` off `economy-mode` (PR #5 is open; this PR stacks on it).

## Global Constraints

- No new npm dependencies in this PR.
- CommonJS, `"use strict"` optional, style matches `server/*.js` (small modules, `module.exports` at the end).
- All state under `token.DIR` (`AI_BRIDGE_HOME` override in tests). Never touch the real `~/.ai-browser-bridge` from tests.
- Every persistent write of JSON state goes through `atomicWrite` (tmp + rename).
- Restricted runs: allowedTools is exactly the browser command list in the spec; `download`, `agent`, `jobs`, `recipe`, `journal`, `pairing`, `channels`, `claude-md`, `reloadExtension`, `detachAll`, `activateTab` absent.
- Codex rung absent from restricted runs unless `codex: true`.
- Child env for restricted runs: only `PATH HOME USER LANG TMPDIR BRIDGE_PORT` plus `AI_BRIDGE_*` run metadata; never a value from `channels.json`.
- Approval button data format `ab1:<kind>:<a|d>:<id>` with `id` = 16 hex chars; TTL 10 min.
- Pairing codes: 6 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, pending TTL 1 h, max 20 pending per channel.
- Limits: 20 msgs/paired sender/60 s, 200 global/60 s, 5/min unknown senders, 8 KB text, 4096 tracked senders. Queue 3 per sender, 10 global. Outbox 10 files, 45 MB each, 100 MB total.
- Telegram: plain text sends (no `parse_mode`), `textLimit` 4000, `chunkMode` `"text"`, `allowed_updates: ["message","callback_query"]`, long-poll timeout 30 s.
- Journal verdict values: `pass | fail | declined | cancelled`. Job state transitions only on `pass`/`fail`.
- Commits under the owner's name only, no co-author trailers. Owner merges.

## Review Focus

1. A Telegram user sends two messages within one second: the second must be queued (position 2) or refused over cap, never silently dropped, never merged. Test in Task 15.
2. The daemon restarts while a task is queued: the task runs once after restart, not zero or two times. Test in Task 17.
3. A `callback_query` arrives from a different user than the one who started the run, with valid button data: refused, buttons stay, the originator can still approve. Test in Task 5 and Task 15.
4. An outbox contains a symlink to `~/.ai-browser-bridge/token`: never delivered, reported as skipped. Test in Task 7.
5. Telegram returns HTTP 429 with `retry_after` during delivery: the send waits and retries once, the user still gets the message, no crash. Test in Task 14.

---

### Task 1: Atomic JSON writes

**Files:**
- Create: `server/atomic.js`
- Modify: `server/jobs.js:31-34` (`saveJobs`), `server/recipe.js:43-56` (`saveRecipe`)
- Test: `test/atomic.test.js`

**Interfaces:**
- Produces: `atomicWrite(file: string, text: string, { mode = 0o600 } = {}) → void` — writes `file + ".tmp-<pid>-<rand>"` then `fs.renameSync`; creates the parent dir `0o700`.

- [ ] **Step 1: Write the failing test** `test/atomic.test.js`: writes to a temp dir, asserts file content equals text, no `*.tmp-*` leftover, mode `& 0o777 === 0o600`; second write replaces content.
- [ ] **Step 2: Run** `node test/atomic.test.js` → FAIL (module not found).
- [ ] **Step 3: Implement** `server/atomic.js`.
- [ ] **Step 4: Replace** `fs.writeFileSync` in `saveJobs` and both writes in `saveRecipe` with `atomicWrite(..., { mode: 0o644 })` for recipes and `0o600` for jobs.
- [ ] **Step 5: Run** `node test/atomic.test.js && node test/recipe.test.js && node test/agent.test.js` → PASS.
- [ ] **Step 6: Commit** `atomic JSON writes for jobs and recipes`.

### Task 2: Chunker

**Files:**
- Create: `server/channels/chunk.js`
- Test: `test/channels.chunk.test.js`

**Interfaces:**
- Produces: `chunk(text: string, limit: number, mode: "text"|"markdown" = "text") → string[]`.

- [ ] **Step 1: Test** assertions: short text → one chunk; 10 KB text with limit 4000 → every chunk `≤ 4000`, join equals original modulo added fence lines; splits prefer `\n\n`, then `\n`, then `. `; in `markdown` mode a split inside a ```` ``` ```` block ends chunk N with ```` ``` ```` and starts chunk N+1 with ```` ``` ````; a single 5000-char line with no separators still yields chunks `≤ limit`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `chunk`. Approach: find the last preferred separator before `limit`; fall back to a hard cut; track fence parity by counting ```` ``` ```` lines in the emitted chunk.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `channels: text chunker with fence reopening`.

### Task 3: Pairing store and CLI

**Files:**
- Create: `server/channels/pairing.js`
- Test: `test/channels.pairing.test.js`

**Interfaces:**
- Produces: `PAIRING_FILE`; `load() → { pending: [], approved: [] }`; `request({ channel, accountId, senderId, meta }) → { code, created: boolean }` (upsert, evicts oldest over 20, prunes pending older than 1 h); `isApproved({ channel, accountId, senderId }) → boolean`; `approve(channel, code) → { senderId, accountId, meta } | null`; `revoke(channel, senderId) → boolean`; `generateCode() → string`; `main(argv)` for `bridge pairing list | approve <channel> <code> | revoke <channel> <senderId>` printing the sender id and `meta` on approve.

- [ ] **Step 1: Test**: `generateCode()` is 6 chars from the alphabet and 100 calls are unique; `request` twice for the same sender returns the same code with `created:false`; 21 requests on one channel leave 20 pending with the oldest gone; `approve` moves the entry to approved and `isApproved` is true; `approve` with a wrong code returns null; `revoke` makes `isApproved` false; a pending entry with `createdAt` 2 h ago is pruned on next `load`; file is written via `atomicWrite` (no tmp leftovers).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** using `crypto.randomBytes` for codes.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `channels: pairing store and bridge pairing CLI`.

### Task 4: DM policy and rate limiter

**Files:**
- Create: `server/channels/policy.js`
- Test: `test/channels.policy.test.js`

**Interfaces:**
- Produces: `decide({ policy, allowFrom, senderId, paired }) → "run" | "pair" | "drop"` implementing the spec truth table (`open` without `"*"` behaves as `allowlist`); `class RateLimiter({ perSender = 20, global = 200, unknown = 5, windowMs = 60000, maxSenders = 4096, now = Date.now })` with `allow(senderKey, { unknown = false } = {}) → boolean` (LRU eviction of sender keys).

- [ ] **Step 1: Test**: every cell of the truth table; `open` with `allowFrom: ["123"]` and unknown sender → `"drop"`; limiter allows 20 then refuses the 21st for one sender within the window and allows again after `windowMs`; global 200 cap; unknown bucket 5; inserting 4097 senders evicts the least recent.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `channels: dm policy table and rate limiter`.

### Task 5: Approvals

**Files:**
- Create: `server/channels/approvals.js`
- Test: `test/channels.approvals.test.js`

**Interfaces:**
- Produces: `encode(kind, decision, id) → string`; `decode(data) → { kind, decision: "a"|"d", id } | { invalid: true } | null` (`null` for foreign prefixes, `invalid` for `ab1:` with bad shape); `class Approvals({ ttlMs = 600000, now })` with `create({ runId, kind, digest, channel, accountId, chatId, senderId, signal }) → { id, promise: Promise<"approved"|"denied"> }` and `resolve({ id, actorId, channel, accountId, chatId, kind, decision }) → "approved" | "denied" | "stale" | "forbidden"`; `digestOf(string) → sha256 hex`.

- [ ] **Step 1: Test**: `encode("intent","a",id)` round-trips through `decode`; `decode("tga1:x")` → null; `decode("ab1:bad")` → `{invalid:true}`; resolve by the originating sender → `"approved"` and the promise resolves `"approved"`; resolve by another actor → `"forbidden"` and the promise stays pending; second resolve → `"stale"`; mismatched `chatId` or `kind` → `"forbidden"`; `now` advanced 11 min then resolve → `"stale"` and the promise resolved `"denied"`; aborting `signal` resolves `"denied"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with an in-memory `Map`, `setTimeout` for TTL (unref'd), `crypto.randomBytes(8)` ids.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `channels: single-use bound approvals`.

### Task 6: Channel state (dedup ring, offsets, persisted queue)

**Files:**
- Create: `server/channels/state.js`
- Test: `test/channels.state.test.js`

**Interfaces:**
- Produces: `STATE_FILE`; `class ChannelState(file = STATE_FILE)` with `isSeen(accountKey, eventId) → boolean` (read only), `accept({ accountKey, eventId, item, offset }) → boolean` (**one** atomic write that marks the id seen in a ring of 1000 per account, appends `item` with `status: "queued"` when `item` is given, and stores `offset` when given; returns false if already seen), `getOffset(accountKey) → any`, `setOffset(accountKey, value)`, `setStatus(runId, status: "queued"|"running"|"awaiting-approval"|"done")`, `remove(predicate) → number`, `queue() → item[]`, `recoverable() → item[]` (items with `status === "queued"`), `uncertain() → item[]` (`running` or `awaiting-approval`), `save()`; all mutations persist via `atomicWrite`.

- [ ] **Step 1: Test**: `isSeen` false, `accept` true then `accept` again false; after 1001 ids the first is forgotten; offsets persist across a new instance on the same file; three `accept`s with items then a fresh instance `queue()` returns them in order with `status: "queued"`; `setStatus(runId,"running")` then a fresh instance puts that item in `uncertain()` and not in `recoverable()`; `remove(i => i.senderId === "1")` deletes only that sender's items; a crash simulated by throwing inside `atomicWrite` leaves the previous file intact (no partial state).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `channels: persisted dedup, offsets and queue`.

### Task 7: Outbox

**Files:**
- Create: `server/channels/outbox.js`
- Test: `test/channels.outbox.test.js`

**Interfaces:**
- Produces: `OUTBOX_DIR`; `createOutbox(runId) → string` (dir `0o700`); `collect(dir, { maxFiles = 10, maxFileBytes = 45e6, maxTotalBytes = 100e6 } = {}) → { files: [{ name, size, fd }], skipped: [{ name, reason }] }` — `lstat`, regular files only, same uid, `fs.openSync(path, "r" | O_NOFOLLOW)`, then `fstatSync(fd)` must report the same `ino`/`dev`/`size` as the lstat or the file is skipped `"changed"`; the **fd is the only handle delivered**: adapters read bytes from it; `finish(dir, delivered: string[], files) → void` closes every fd, unlinks delivered names, `rmdir` if empty, keeps the rest.

- [ ] **Step 1: Test**: a symlink to another file → skipped with reason `"symlink"` and the target never appears; a 46 MB sparse file → skipped `"too large"`; 11 small files → 10 collected, 1 skipped `"too many"`; `fs.readFileSync(files[0].fd)` returns the content; `finish` with all names removes the dir and leaves no open fds (`fs.fstatSync(fd)` throws `EBADF`); `finish` with a subset leaves the others.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `channels: hardened outbox collection`.

### Task 8: Restricted-run helpers

**Files:**
- Create: `server/channels/restricted.js`
- Test: `test/channels.restricted.test.js`

**Interfaces:**
- Produces: `BROWSER_COMMANDS` (array from the spec); `allowedTools(selfCmd) → string[]` producing one `Bash(<selfCmd> <cmd>:*)` per command; `cleanEnv(src = process.env) → object` keeping `PATH HOME USER LANG TMPDIR BRIDGE_PORT` and any `AI_BRIDGE_RUN_ID AI_BRIDGE_JOB AI_BRIDGE_OUTBOX AI_BRIDGE_AGENT`, dropping everything else; `PLAYBOOK_ADDENDUM` string containing the exact lines: `before any irreversible action the task did not already name, stop and end your report with "NEEDS APPROVAL: <one line>"` and `to deliver a file, fetch it in the page with eval returning {base64} and --out <name>, or use pdf --out / screenshot --out; files in the current directory are sent to the user`.

- [ ] **Step 1: Test**: `allowedTools("node x")` has no entry matching `/agent|jobs|recipe|journal|pairing|channels|claude-md|reloadExtension|detachAll|activateTab|download/`; contains `Bash(node x eval:*)`; `cleanEnv({ PATH: "p", AI_BRIDGE_TELEGRAM_TOKEN: "t", AI_BRIDGE_RUN_ID: "r", FOO: "1" })` → `{ PATH, AI_BRIDGE_RUN_ID }` only.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `channels: restricted-run allowlist, clean env, playbook addendum`.

### Task 9: Intent classifier

**Files:**
- Create: `server/channels/intent.js`
- Test: `test/channels.intent.test.js`

**Interfaces:**
- Produces: `DEFAULT_KEYWORDS` (spec list); `classifyIntent(task, { keywords = DEFAULT_KEYWORDS, classify } = {}) → Promise<"read"|"write">` — keyword hit → `"write"` without calling `classify`; otherwise `await classify(prompt)` which must return a string; the result is `"read"` only when the reply matches `/^\s*read\b/i`; anything else, a throw, or a missing `classify` → `"write"` (fail closed); `intentPrompt(task) → string` asks for the single word `read` or `write`.

- [ ] **Step 1: Test**: `"send the invoice"` → `"write"` with `classify` never called; `"what is the balance"` with `classify` resolving `"read"` → `"read"`; `classify` resolving `"write"` → `"write"`; `classify` throwing or returning unreadable text → `"write"` (fail closed).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; word-boundary regex, case-insensitive.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `channels: intent gate classifier (fail closed)`.

### Task 10: Cancellation through the agent

**Files:**
- Modify: `server/agent.js:113-158` (`runClaude`), `:161-198` (`runCodex`), `:239-460` (`runAgent`); `server/recipe.js:157-236` (`runRecipe`)
- Test: `test/agent.test.js` (append), `test/recipe.test.js` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: exported `spawnTracked(cmd, args, { signal, cwd, baseEnv, env, stdio }) → ChildProcess` — spawns `detached: true` with env `{ ...(baseEnv || process.env), AI_BRIDGE_AGENT: "1", ...env }`; on `signal` abort → `process.kill(-child.pid, "SIGKILL")` (fallback `child.kill`) and the caller rejects `Object.assign(new Error("cancelled"), { name: "AbortError" })`. `runClaude/runCodex({ ..., signal, cwd, baseEnv })` use it; `runCodex` passes `-C cwd || process.cwd()` **and** spawn `cwd`. `runRecipe(recipe, { ..., signal, baseEnv })` checks `signal?.aborted` before each step → `failure = { step: i, do: s.do, error: "cancelled", kind: "cancelled" }`, still closes the tab; `execBridge` receives `baseEnv` and uses it instead of `process.env` when given. `runLoginCmd(cmd, { ..., baseEnv })` likewise. `runAgent(task, { signal })` → on `AbortError` or `failure.kind === "cancelled"`: `finalVerdict = { verdict: "cancelled", feedback: "stopped by user; actions already performed were not undone" }`, no `jobs.transition`, journal written with `verdict: "cancelled"`, returns normally.

- [ ] **Step 1: Tests**: `spawnTracked("node", ["-e", "<spawns a grandchild node -e setInterval and prints both pids>"], { signal })` then `controller.abort()` → within 1 s `process.kill(pid, 0)` throws `ESRCH` for both pids. agent — mock `run` that rejects with `AbortError` when `signal.aborted` → `r.verdict.verdict === "cancelled"`, journal last record verdict `cancelled`, and with a job seeded in `audit` mode the saved state still has `mode: "audit"` and the same `auditPasses`. recipe — exec fake whose `newTab` handler calls `controller.abort()` → `ok:false`, `failure.kind === "cancelled"`, `failure.step === 1`, and `exec` was called for `closeTab` on the opened tab; with an already-aborted signal → zero `exec` calls.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `node test/agent.test.js && node test/recipe.test.js` → PASS.
- [ ] **Step 5: Commit** `agent: AbortSignal cancellation with cancelled verdict`.

### Task 11: Approval gates in the agent, recipe risk hardening

**Files:**
- Modify: `server/agent.js` (`parseVerdict`, `runAgent` recipe path and ladder loop, `journalRecord` unchanged), `server/recipe.js:57-88` (`validateRecipe`, `inferRisk`, new `effectiveRisk`), `server/recipe-cli.js` (`approve <job>`)
- Test: `test/agent.test.js`, `test/recipe.test.js`

**Interfaces:**
- Produces: `recipe.effectiveRisk(recipe) → "read"|"write"` = `"write"` if stored `risk` is write, or `inferRisk` says write and `recipe.riskApprovedBy !== "operator"`; `inferRisk` also flags steps `do: "eval"|"assert"|"poll"` whose `code` matches `/\.click\(|\.submit\(|fetch\(|XMLHttpRequest|dispatchEvent|\.value\s*=/`; `validateRecipe` pushes `unknown command "<do>"` for `do` not in `KNOWN_CMDS = [...BROWSER_COMMANDS from Task 8, "sleep","assert","poll","download"]`; new `recipe.approveRisk(job) → recipe` rewrites **both** `<job>.json` and `<job>.v<N>.json` in place with `riskApprovedBy: "operator"` and does **not** increment the version (`saveRecipe` always increments, so it is not used here); `bridge recipe approve <job>` calls it. New `recipe.renderParams(recipe, params, now) → object` (the first line of `runRecipe` extracted) and `runRecipe` accepts `{ renderedParams }` to use that snapshot verbatim. `runAgent(task, { approve })`: compute `rendered = renderParams(recipe, opts.params || {}, now)` once; before `D.runRecipe` when `effectiveRisk(recipe) === "write"` and `approve` → `await approve({ kind: "recipe", title: job, detail: `recipe v${recipe.version}`, digest: sha256(job + ":" + version + ":" + JSON.stringify(rendered)) })`; `"denied"` → `finalVerdict = { verdict: "declined", feedback: "write-risk recipe not approved; nothing was run" }`, no transition, journal, return; approved → `D.runRecipe(recipe, { renderedParams: rendered, ... })`. In the ladder, after `lastEvidence` is set: `m = /^NEEDS APPROVAL:\s*(.+)$/m.exec(lastEvidence)`; if `m && approve` → `await approve({ kind: "step", title: m[1], digest: sha256(m[1]) })`; approved → `feedback = \`approved: ${m[1]}; proceed\``, rerun the same rung once (stage label `ops:<label>(approved)`), then judge; denied → `declined`, break. Without `approve`, behaviour unchanged.

- [ ] **Step 1: Tests**: recipe — `effectiveRisk` on an eval containing `.submit(` is write, and read once `riskApprovedBy: "operator"`; `approveRisk` leaves `version` unchanged and both files carry the flag; `validateRecipe` on an otherwise valid recipe (`job`, `task`, `steps:[{do:"rm"}]`) returns exactly one error matching `/unknown command "rm"/`; `renderParams` renders `{{date:…}}` once and `runRecipe({ renderedParams })` passes them through untouched. agent — write recipe + `approve` resolving `"denied"` → `declined`, `D.runRecipe` not called, job state unchanged; `approve` resolving `"approved"` → recipe ran; ladder evidence `…Blockers: none\nNEEDS APPROVAL: click Send` with approve `"approved"` → `calls` show the same model twice and the second prompt contains `approved: click Send`; with `"denied"` → `declined` and one ops call.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `agent: approval gates before write recipes and NEEDS APPROVAL steps; recipe risk hardening`.

### Task 12: Restricted mode, cwd, progress in the agent

**Files:**
- Modify: `server/agent.js` (`runAgent` ladder construction, `childEnv`, `autoLearn`/repair guards, `stages.push` sites)
- Test: `test/agent.test.js`

**Interfaces:**
- Consumes: `restricted.allowedTools`, `restricted.cleanEnv`, `restricted.PLAYBOOK_ADDENDUM` (Task 8).
- Produces: `runAgent(task, { restricted, codex, cwd, onProgress, source })` (`source` is copied onto the journal record, e.g. `"channel:telegram"`): when `restricted` → ops `allowedTools = restricted.allowedTools(SELF_CMD)`, rungs filtered to `engine !== "codex"` unless `codex === true`, `OPS_PLAYBOOK + "\n\n" + PLAYBOOK_ADDENDUM`, every `run()` **and** `D.runRecipe` **and** `D.runLogin` get `baseEnv: cleanEnv()`; `run()` also gets `cwd` and `env.AI_BRIDGE_OUTBOX = cwd`; `autoLearn` and repair skipped; `onProgress({ stage, ms?, costUsd? })` invoked on each `stages.push` (wrap in a local `pushStage`).

- [ ] **Step 1: Tests**: first extend `mockRun` in `test/agent.test.js` to record the **whole** options object per call (`calls.push(opts)`), keeping existing assertions green. Then: restricted run `calls[0].allowedTools` has no `Bash(… agent:*)` and equals the Task 8 list; three failing judges yield only two ops calls (no codex) unless `codex: true`; with `process.env.AI_BRIDGE_TELEGRAM_TOKEN = "t"` set in the test, `calls[0].baseEnv` lacks it and `calls[0].cwd` equals the given dir; a stubbed `D.runRecipe` and `D.runLogin` receive `baseEnv` without the token; `onProgress` received stages `ops:opus-5.5` then `judge:fable-5.1`; learning: seed two prior passing journal records with the same signature **and** non-empty trace files (`journal.appendTrace`) plus a trace for the current run → an unrestricted run calls `D.propose`, the identical restricted run does not.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `agent: restricted runs (browser-only tools, clean env, no codex, no learning), cwd and progress hooks`.

### Task 13: Channel config loader

**Files:**
- Create: `server/channels/config.js`
- Test: `test/channels.config.test.js`

**Interfaces:**
- Produces: `CONFIG_FILE`; `loadConfig({ env = process.env } = {}) → { [channel]: { accountId: "default", token, dmPolicy, allowFrom, codex, ... } }` — defaults `dmPolicy: "pairing"`, `allowFrom: []`, `codex: false`; env `AI_BRIDGE_<CHANNEL>_TOKEN` overrides `token`; throws `channels.json is group/world readable (mode 0o6xx); run chmod 600` when `(mode & 0o077) !== 0`; throws when a channel has no token; `redact(text, config) → string` replacing every token value with `<redacted>`. Also `server/channels/log.js`: `makeLogger({ file = path.join(DIR, "channels.log"), maxBytes = 10e6, keep = 3, redact }) → log(line)` which appends ISO-timestamped lines through `redact`, rotates `channels.log → .1 → .2 → .3` when the size exceeds `maxBytes`, and mirrors to stderr when `verbose`.

- [ ] **Step 1: Tests**: defaults applied; env override wins; mode `0o644` throws; `redact("x 123:ABC y")` → `"x <redacted> y"`; logger with `maxBytes: 200` and 50 lines produces `channels.log` plus `.1` and no `.4` after many rotations; a logged line containing the token reads `<redacted>` on disk.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `channels: config loader with env overrides and mode check; rotating redacted logger`.

### Task 14: Telegram adapter

**Files:**
- Create: `server/channels/telegram.js`
- Test: `test/channel-telegram.test.js` (local `http` server faking `api.telegram.org`)

**Interfaces:**
- Consumes: `deps = { fetch, log, sleep, now }`.
- Produces: `makeAdapter(config, deps) → adapter` per the spec interface with `id: "telegram"`, `accountId`, `capabilities: { buttons: true, media: true, edit: true, textLimit: 4000, chunkMode: "text", maxFileBytes: 50e6 }`, `apiBase` default `https://api.telegram.org` (overridable via `config.apiBase` for tests). `start(onInbound, { getOffset, setOffset })` loops `getUpdates` with `offset: getOffset() ?? 0`, `timeout: 30`, `allowed_updates`; for each update: `callback_query` → `await` action handler with `{ actorId: String(from.id), chatId: String(message.chat.id), messageId: message.message_id, data, ack: () => answerCallbackQuery }`; `message` with `chat.type !== "private"` or `from.is_bot` → dropped (still advances offset); else `await onInbound({ accountId, senderId: String(from.id), chatId: String(chat.id), chatType: "direct", messageId, eventId: String(update_id), text: text || "", raw })`; after **every** update (handled or dropped) the adapter calls `await setOffset(update_id + 1)` and only then uses that offset in the next poll. Poll errors: `sleep` with backoff 1 s doubling to 30 s, reset on success. `sendText(chatId, text)` → `sendMessage` no `parse_mode`; `sendFile(chatId, { fd, name, size }, caption)` → `sendDocument` multipart from `fs.readFileSync(fd)`; `sendButtons(chatId, text, buttons)` → `inline_keyboard` one row; `editMessage(chatId, messageId, text, buttons)` → `editMessageText`; `onAction(handler)`. Send errors: HTTP 429 → `sleep(parameters.retry_after * 1000)` and retry once; 5xx or network error → `sleep(2000)` and retry once; still failing or any other 4xx → throw `Error` with `{ permanent: status >= 400 && status < 500 && status !== 429, status }`. `stop()` ends the loop.

- [ ] **Step 1: Tests** against the fake server: first `getUpdates` request body has `allowed_updates`, `timeout: 30` and `offset` from `getOffset`; a private text update calls `onInbound` with the normalized fields; a group update does not call `onInbound` but `setOffset` is still called with `update_id + 1`; a bot-authored update likewise; `setOffset` is called only after the handler's promise resolved (handler delays 50 ms, assert ordering) and the second poll carries that offset; a `callback_query` reaches the action handler and `ack()` posts `answerCallbackQuery`; `sendText` posts `chat_id` and `text` without `parse_mode`; `sendFile` posts multipart whose body contains the bytes read from the fd; first `sendMessage` answered `429 {parameters:{retry_after:1}}` then `200` → resolves after one retry and `sleep` was called with 1000; a `500` then `200` → resolves and `sleep` called with 2000; a `400` → rejects with `permanent: true`; `getUpdates` failing twice → `sleep` called with 1000 then 2000; `stop()` makes the loop exit within one poll.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `channels: telegram adapter (long-poll, buttons, files, 429 retry)`.

### Task 15: Manager

**Files:**
- Create: `server/channels/manager.js`
- Test: `test/channels.manager.test.js` (fake adapter object + fake `runAgent` + fake `runModel` for intent)

**Interfaces:**
- Consumes: Tasks 2–9, 13; `agent.runAgent`, `agent.MATCH_MODEL`, `jobs.loadJobs/formatTable`, `journal.readJournal/summarize`, `runtime.selfArgs`.
- Produces: `class Manager({ config, adapters, state, pairing, approvals, limiter, runAgent, runModel, spawn, log, now })` with `start()`, `stop()`, `handleInbound(adapter, evt)`, `handleAction(adapter, action)`, `drain()` (worker: one run at a time), `COMMANDS` map; message strings:
  - unknown under pairing: `Not paired. Code: <code>. The operator runs: bridge pairing approve <channel> <code>` (once per sender per hour; track `lastNotice` in `state`)
  - accepted: `⏳ queued (run <id>, position <n>)` or `⏳ working on it (run <id>)`
  - over cap: `queue full (<n> waiting); try again later`
  - intent prompt: `This task looks like it will send, submit or change something:\n"<task truncated to 1000 chars + "…">"\nApprove?` with buttons `Approve`/`Cancel` (`encode("intent","a"|"d",id)`) or the text fallback line when `!capabilities.buttons`; every prompt is `≤ textLimit` by construction
  - recipe/step prompts: `Approval needed: <title>\n<detail>` same buttons
  - completion: `✅ pass` / `❌ fail` / `🚫 declined` / `⏹ cancelled` + feedback, then evidence chunks, then files, then `skipped: <name> (<reason>)` lines if any
  - stale click: edit message to `(no longer pending)` and remove buttons
  - `/journal [days]` → three lines: `runs: N, pass rate: P%`, `cost: $X`, `jobs: a, b, c`
- Queue item: `{ runId, channel, accountId, chatId, senderId, task, acceptedAt, status }`; persisted with one `state.accept({ accountKey, eventId, item })` call **before** `handleInbound` returns (the state file is the acceptance record; the journal gets exactly one record per run, written by `runAgent` or, for intent-denied runs, by the manager via `agent.journalRecord({ runId, task, startedAt, stages: [], verdict: { verdict: "declined", feedback: "task not approved" }, mode: "regular", evidence: "" })` + `source` + `journal.appendJournal`). Per-run flow in `drain()`: `state.setStatus(runId, "running")` → `classifyIntent` (keywords from `config.intentKeywords || DEFAULT_KEYWORDS`, `classify` = `async (prompt) => String((await runModel({ model: MATCH_MODEL, prompt, allowedTools: [], timeoutMs: 60000, baseEnv: cleanEnv() })).result || "")`) → if write, `state.setStatus(runId, "awaiting-approval")`, `approvals.create({ kind: "intent", ... })`, send prompt, await; denied → journal declined, `🚫 declined`, `state.remove`, next; approved → `state.setStatus(runId, "running")`; then `createOutbox(runId)` → `runAgent(task, { runId, restricted: true, codex: cfg.codex, cwd: outbox, signal, approve, onProgress, source: "channel:<id>" })` → `state.setStatus(runId, "done")` → deliver → `finish(outbox, deliveredNames, files)` → `state.remove(i => i.runId === runId)`.
- Startup recovery in `start()`: items from `state.uncertain()` are **not** run; each gets a journal record `verdict: "declined", feedback: "daemon restarted while the task was running or awaiting approval; not replayed"`, the sender is told `restarted; "<task>" was not replayed, send it again if still wanted`, and the item is removed. Items from `state.recoverable()` are drained normally.
- `approve(request)` callback for the agent: `state.setStatus(runId, "awaiting-approval")`, creates an approval record with the run's sender/chat, sends the prompt via `sendButtons` or text, awaits, restores `"running"`, returns the decision.
- All user-facing error text and evidence pass through `config.redact` before sending; the manager's `log` is the Task 13 logger.
- `/cancel`: aborts the current run's controller if it belongs to this sender and `state.remove`s the sender's queued items; reply `stopped; actions already performed were not undone`.
- Progress: `onProgress` lines coalesced; send at most one progress message per 15 s (`now`-based).

- [ ] **Step 1: Tests** (fake adapter records `sent[]`, exposes `emit(evt)` and `emitAction(a)`; fake `runAgent` resolves a scripted report after `await` on a promise the test controls):
  - unknown sender → one pairing message; second message → nothing sent; `pairing.request` upserted.
  - `dmPolicy: "allowlist"`, unknown → nothing sent, nothing queued.
  - paired sender text → `state.queue()` has 1 item before `handleInbound` resolves; reply `⏳ working on it`.
  - two texts from one sender while the first runs → second reply contains `position 2`; a 4th queued → `queue full`.
  - write-intent task (`"send …"`) → prompt with buttons, `runAgent` not called until `emitAction` from the **same** actor with decision `a`; action from another actor → `runAgent` still not called and no edit; decision `d` → `🚫 declined` and `runAgent` never called.
  - fake adapter `capabilities.buttons=false` → prompt text contains `/approve <id> yes`; `/approve <id> yes` from the sender resolves it.
  - completion delivers `✅ pass`, evidence chunks each `≤ textLimit`, and a file placed in the outbox dir; a symlink there yields a `skipped:` line.
  - `/cancel` during a run → `runAgent` saw `signal.aborted`, report `⏹ cancelled` line sent, queued items of that sender removed.
  - `/ping`, `/status`, `/jobs`, `/help` answered without `runAgent`; `/journal` three lines.
  - rate limit: 21 texts in a tick → 20 queued/refused by cap, one `rate limited` notice at most.
  - callback with foreign prefix → ignored; `ab1:` malformed → ignored and `ack()` still called.
  - restart recovery: state file seeded with one `running`, one `awaiting-approval` and one `queued` item → `start()` sends two `restarted; … not replayed` messages, writes two `declined` journal records, and `runAgent` is called exactly once (for the `queued` item).
  - a 6000-char task flagged write → the approval prompt sent is `≤ 4000` chars.
  - an evidence string containing the bot token → the delivered message contains `<redacted>`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `channels: manager (policy, pairing, queue, approvals, delivery, commands)`.

### Task 16: Daemon entry, CLI dispatch, deploy templates, docs

**Files:**
- Create: `server/channels/main.js`, `deploy/launchd/com.ai-bridge.channels.plist`, `deploy/systemd/ai-bridge-channels.service`, `docs/CHANNELS.md`
- Modify: `server/cli.js:38-75` (usage lines + dispatch `channels`, `pairing`), `server/main.js` (no change needed: falls through to cli), `README.md` (new section "Messenger channels" after "Agent mode"), `package.json` (`test` script adds the new test files)
- Test: `test/channels.main.test.js`

**Interfaces:**
- Produces: `bridge channels start [--verbose]` → acquires `path.join(DIR, "channels.lock")` (write pid; if the pid is alive exit 1 with `another channels daemon is running (pid N)`), loads config, builds adapters for every configured channel (only `telegram` known in this PR; unknown channel name → error listing known ones), constructs `Manager`, `start()`, handles `SIGINT/SIGTERM` → `stop()` + lock removal. `bridge channels status` → prints lock pid and config channels (no tokens). `bridge pairing …` → `pairing.main`.
- `docs/CHANNELS.md`: setup (BotFather token, `channels.json` with chmod 600, start, pair), commands table, approval behaviour, the two-machine tunnel recipe (`ssh -N -L 8765:127.0.0.1:8765 laptop`, copy token), security notes (restricted runs, what the bot cannot do), troubleshooting (409 conflict = second poller).

- [ ] **Step 1: Test**: spawn `node server/cli.js channels start` with `AI_BRIDGE_HOME` pointing at a temp dir containing a `channels.json` with an unknown channel → exit 1 and stderr names `telegram`; with a lock file holding this test's own pid → exit 1 mentioning `pid`; `bridge pairing list` with empty store → exit 0 and prints `no pending`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** entry, dispatch, templates (copy the existing plist/service and change label, script path `server/channels/main.js`, log name), docs, README section (install, pair, text a task, approvals, two-machine, link to CHANNELS.md), `package.json` test list.
- [ ] **Step 4: Run** `npm test` → all PASS.
- [ ] **Step 5: Commit** `channels: bridge channels start daemon, pairing CLI dispatch, deploy templates, docs`.

### Task 17: End-to-end with the fake Telegram server

**Files:**
- Create: `test/channels.e2e.test.js`

**Interfaces:**
- Consumes: Tasks 14–16.

- [ ] **Step 1: Test**: start the fake Telegram `http` server; write `channels.json` (`apiBase` → fake, `allowFrom: ["42"]`); construct `Manager` with the real Telegram adapter and a fake `runAgent` that writes `result.txt` into `opts.cwd` and returns `pass`; feed an update from user 42 "get the page title" → assert, in order, `sendMessage` `⏳ working`, `sendMessage` `✅ pass`, `sendDocument` with `result.txt`; then feed `"send the report"` → assert a `sendMessage` with `reply_markup.inline_keyboard`, post a `callback_query` from user 42 with the `a` data → `runAgent` called, `editMessageText` posted; restart: stop the manager mid-queue (enqueue a second task, do not drain), build a new `Manager` on the same state file → the task runs exactly once (`runAgent` call count).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Fix** whatever the integration exposes (no new features).
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `channels: end-to-end test with fake Telegram API`.

---

## Self-review notes

- Spec coverage: restricted runs (8, 12), three gates (9, 11, 15), approvals (5, 15), conversation contract and queue (15), cancel (10, 15), outbox (7, 12, 15), access control and pairing (3, 4, 15, 16), adapter interface and Telegram (14), shared-state fixes (1, 10, 11), logging/redaction (13, 15), docs/deploy (16), tests (all).
- Deviation from the spec, recorded here and to be mirrored in the spec: acceptance is persisted in `channels-state.json` (one atomic write with the dedup mark), not as a `status: "queued"` journal record, so the journal keeps one record per run and `summarize()` is unchanged.
- Audit round 1 (Codex Astra, 2026-11-16): 18 findings, all folded in above (atomic accept + status lifecycle, fail-closed classifier, `runModel` result shape and timeout, Codex `-C cwd`, `approveRisk` without version bump, rendered-param digest, bounded prompts, 5xx retry, journal for intent-denied, clean env on recipe/login/classifier children, fd-based delivery, restart denies uncertain items, logger with rotation and redaction, real process-group cancel test, valid-recipe unknown-command test, full-options mock, seeded learning test, offset callbacks).
- Not in this PR (later channel PRs): other adapters; Mattermost/Matrix text fallback is already covered by `capabilities.buttons=false` in Task 15.
