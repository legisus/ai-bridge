# Bound Bots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Several Telegram bots under one daemon, each optionally bound to one session, so that opening a bot's chat is that conversation.

**Architecture:** `loadConfig` normalises each channel to `{ ...defaults, bots: [merged bot…] }` (one-bot form unchanged); `main.js` builds one adapter per bot; the manager resolves adapters and configs by `(channel, accountId)` everywhere and, when the merged bot config carries `boundSession`, routes plain text to that one row (auto-created), restricts the command set, and binds `/retry` and execution to it. Approvals check ownership before answering stale; prompt edits go only through the adapter that sent the prompt; messenger tokens are denied in child environments and redacted in prompts and journal records.

**Tech Stack:** Node ≥ 18, no new dependencies, plain-node tests run by `npm test`.

**Spec:** `docs/superpowers/specs/2026-11-18-bound-bots-design.md` (revised after the Astra audit). Sessions spec: `docs/superpowers/specs/2026-11-17-channel-sessions-design.md`.

## Global Constraints

- Branch `feat/bound-bots` stacked on `feat/channels-sessions` (PR #7); PR only; commits under the user's identity, no `Co-Authored-By: Claude`.
- Owner key `channel:accountId:senderId` everywhere; adapters and configs resolved by `(channel, accountId)`, never by channel alone.
- `accountId` matches `/^[a-z0-9_-]{1,24}$/`, unique per channel, default `default` (one bot at most).
- Session model default is **fable** (`claude-fable-5-1`) everywhere: `boundSession.model` when `model` is absent, and `SessionStore.create(owner, name, modelKey = "fable")` (the sessions suite's "row defaults" and "/new reply" expectations change from opus to fable in Task 1; `MODELS` keeps `opus|fable|haiku`).
- Env keys: `AI_BRIDGE_<CHANNEL>_TOKEN` → default bot; `AI_BRIDGE_<CHANNEL>_<ACCOUNTID>_TOKEN` (upper-cased, `[^A-Z0-9]` → `_`) → that bot; collisions and duplicate effective tokens are errors; overrides apply before the token-presence check.
- `cleanEnv` denies any key matching `/^AI_BRIDGE_.*_TOKEN$/i` even when in `envPassthrough`.
- Bound bot replies (exact copy, from the spec): refusal `this bot is bound to session turo: plain text goes to it, /pause and /resume control it, /stop starts it over`; no row `no conversation yet; just send a message`; wrong name `this bot only has the conversation "turo"`; stop `stopped turo; your next message starts a fresh conversation`; paused `session turo is paused; /resume`; cap `cannot start the conversation: too many sessions on this bot (max 10); the operator can clear them`; model conflict `this conversation runs on <a>, the bot is configured for <b>; /stop to start over on <b>`; retry refusal `cannot retry: that message was not for this conversation; send a new message`; execution drop `🚫 dropped — this bot is bound to session turo`; missing transcript `❌ [turo] this session's conversation is no longer available (Claude keeps transcripts ~30 days); /stop, then send a new message`.

## Review Focus

1. A sender paired on the general bot but not on the turo bot must get a pairing code from the turo bot, never a turn. (Task 3 test `bound: unpaired on this bot → pairing notice names the binding`.)
2. Two bots of one channel: a queued item of bot B must be answered through adapter B even when adapter A was registered first. (Task 2 test `two bots: item of account b runs and replies through adapter b`.)
3. An old one-shot item queued before the binding must be dropped, not run, when the daemon restarts with the binding. (Task 3 test `bound: execution binding drops a pre-binding one-shot`.)
4. A stale callback id created on bot A, tapped in bot B's chat, must not edit anything in chat B. (Task 2 test `handleAction: stale id from another bot edits nothing`.)
5. `envPassthrough: ["AI_BRIDGE_TELEGRAM_TURO_TOKEN"]` must still not leak the token to a child. (Task 1 test `cleanEnv: messenger token keys denied even via passthrough`.)

---

### Task 1: Config — bots list, env overrides, validation, redaction, token deny

**Files:**
- Modify: `server/channels/config.js`, `server/channels/restricted.js` (`cleanEnv`), `server/channels/sessions.js` (default model key `fable`), `server/channels/manager.js` (`/new` usage text unchanged; default comes from the store)
- Test: `test/channels.config.test.js`, `test/channels.restricted.test.js`, `test/channels.sessions.test.js` (`create: row defaults` expects `claude-fable-5-1`; add `create(owner, "x", "opus")` → opus), `test/channels.manager.sessions.test.js` (`created session turo (fable)` in the `/new Turo` expectation and `(fable, …)` in `/sessions` listings where the model was not given)

**Interfaces:**
- Consumes: `normalizeName`, `MODELS` from `server/channels/sessions.js`.
- Produces: `loadConfig()` returns per channel `{ accountId, dmPolicy, allowFrom, codex, intentKeywords?, envPassthrough, token?, apiBase?, bots: [ { accountId, token, apiBase?, dmPolicy, allowFrom, codex, intentKeywords?, envPassthrough, boundSession: { name, model } | null } ] }` — every bot is the channel defaults merged with the bot entry and validated (`dmPolicy` in `POLICIES`, `allowFrom`/`envPassthrough` stringified, `codex` boolean). For the one-bot form the channel object also keeps `token`, `accountId` (and `apiBase`) so `cfg.telegram.token` and `makeTelegram(cfg.telegram)` keep working; `bots[0]` is that same bot. Errors (message contains the quoted text): `use either token or bots`, `accountId "<x>" is invalid`, `duplicate accountId "<x>"`, `no token` (names channel/account), `env keys collide` (names both account ids), `same token` (names both account ids), `session "<x>" is not a valid session name`, `model "<x>"` unknown.
- `redact(text, config)` replaces every bot token; `cleanEnv(src, extraKeys)` drops keys matching `/^AI_BRIDGE_.*_TOKEN$/i` regardless of `extraKeys`.
- `bridge channels status` output is Task 2.

- [ ] **Step 1: Write the failing tests** (append to `test/channels.config.test.js` before the logger block; `test/channels.restricted.test.js` gets one block)

```js
// bots list: merged + validated per bot, flat aliases for the one-bot form
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { dmPolicy: "allowlist", allowFrom: [1], bots: [
  { accountId: "default", token: "A:1" }, { accountId: "turo", token: "B:2", session: "Turo" }, { accountId: "mail", token: "C:3", session: "mail", model: "haiku", dmPolicy: "pairing", apiBase: "http://x" } ] } }), { mode: 0o600 });
cfg = loadConfig({ env: {} });
assert(cfg.telegram.bots.length === 3 && cfg.telegram.bots[1].accountId === "turo" && cfg.telegram.bots[1].dmPolicy === "allowlist" && JSON.stringify(cfg.telegram.bots[1].allowFrom) === '["1"]' && JSON.stringify(cfg.telegram.bots[1].boundSession) === '{"name":"turo","model":"claude-fable-5-1"}', "bots: channel defaults merged into each bot, session name normalised, model default fable");
assert(cfg.telegram.bots[0].boundSession === null && cfg.telegram.bots[2].dmPolicy === "pairing" && cfg.telegram.bots[2].apiBase === "http://x" && cfg.telegram.bots[2].boundSession.model === "claude-haiku-5-5", "bots: unbound bot, per-bot overrides kept");
assert(cfg.telegram.token === "A:1" && cfg.telegram.accountId === "default", "bots: flat token/accountId alias the default bot");
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { token: "t", accountId: "solo", apiBase: "http://y" } }), { mode: 0o600 });
cfg = loadConfig({ env: {} });
assert(cfg.telegram.bots.length === 1 && cfg.telegram.bots[0].accountId === "solo" && cfg.telegram.bots[0].token === "t" && cfg.telegram.bots[0].apiBase === "http://y" && cfg.telegram.bots[0].boundSession === null && cfg.telegram.accountId === "solo", "one-bot form: bots[0] mirrors the flat fields incl. a custom accountId");
cfg = loadConfig({ env: { AI_BRIDGE_TELEGRAM_TOKEN: "E:9" } });
assert(cfg.telegram.bots[0].token === "E:9" && cfg.telegram.token === "E:9", "one-bot form: AI_BRIDGE_TELEGRAM_TOKEN overrides the lone bot");
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { bots: [{ accountId: "default" }, { accountId: "turo", session: "turo" }] } }), { mode: 0o600 });
cfg = loadConfig({ env: { AI_BRIDGE_TELEGRAM_TOKEN: "D:0", AI_BRIDGE_TELEGRAM_TURO_TOKEN: "T:1" } });
assert(cfg.telegram.bots[0].token === "D:0" && cfg.telegram.bots[1].token === "T:1", "bots: env overrides apply before the token check (env-only credentials)");
for (const [name, body, re] of [
  ["token+bots", { telegram: { token: "t", bots: [{ accountId: "a", token: "x" }] } }, /either token or bots/],
  ["bad accountId", { telegram: { bots: [{ accountId: "Bad Id", token: "x" }] } }, /accountId "Bad Id" is invalid/],
  ["duplicate accountId", { telegram: { bots: [{ accountId: "a", token: "x" }, { accountId: "a", token: "y" }] } }, /duplicate accountId "a"/],
  ["two defaults", { telegram: { bots: [{ token: "x" }, { token: "y" }] } }, /duplicate accountId "default"/],
  ["missing token", { telegram: { bots: [{ accountId: "a" }] } }, /telegram\/a.*no token|no token.*telegram\/a/],
  ["env collision", { telegram: { bots: [{ accountId: "foo-bar", token: "x" }, { accountId: "foo_bar", token: "y" }] } }, /env keys collide.*foo-bar.*foo_bar/],
  ["same token", { telegram: { bots: [{ accountId: "a", token: "x" }, { accountId: "b", token: "x" }] } }, /same token.*"a".*"b"/],
  ["bad session", { telegram: { bots: [{ accountId: "a", token: "x", session: "agent" }] } }, /session "agent" is not a valid session name/],
  ["bad model", { telegram: { bots: [{ accountId: "a", token: "x", session: "s", model: "gpt" }] } }, /model "gpt"/],
  ["bad bot policy", { telegram: { bots: [{ accountId: "a", token: "x", dmPolicy: "yolo" }] } }, /dmPolicy/],
]) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(body), { mode: 0o600 }); err = null; try { loadConfig({ env: {} }); } catch (e) { err = e; } assert(err && re.test(err.message), `loadConfig: ${name} rejected`); }
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ telegram: { bots: [{ accountId: "default", token: "sec-ret_TOKEN:1" }, { accountId: "turo", token: "sec-ret_TOKEN:2", session: "turo" }] } }), { mode: 0o600 });
cfg = loadConfig({ env: {} });
assert(redact("a sec-ret_TOKEN:1 b sec-ret_TOKEN:2 c", cfg) === "a <redacted> b <redacted> c", "redact: every bot's token replaced");
```
`test/channels.restricted.test.js`:
```js
const env = cleanEnv({ PATH: "p", AI_BRIDGE_TELEGRAM_TOKEN: "t1", AI_BRIDGE_TELEGRAM_TURO_TOKEN: "t2", ai_bridge_x_token: "t3", MGR: "m" }, ["AI_BRIDGE_TELEGRAM_TURO_TOKEN", "ai_bridge_x_token", "MGR"]);
assert(env.PATH === "p" && env.MGR === "m" && !("AI_BRIDGE_TELEGRAM_TOKEN" in env) && !("AI_BRIDGE_TELEGRAM_TURO_TOKEN" in env) && !("ai_bridge_x_token" in env), "cleanEnv: messenger token keys denied even via passthrough");
```
(The logger block at the end of the config test keeps using `cfg` — reload the one-bot config with the env token before it, as today.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/channels.config.test.js; node test/channels.restricted.test.js`
Expected: `bots: channel defaults merged…` FAIL (`cfg.telegram.bots` undefined); `cleanEnv: messenger token keys denied…` FAIL

- [ ] **Step 3: Implement**

`loadConfig`: split the channel object into `channelKeys` (defaults + `token`/`accountId`/`apiBase`) and `bots`; build the list; for each bot compute `merged`, apply env (`envKeyFor(channel, accountId)`), validate, set `boundSession`; detect collisions (env key map, token map); copy `bots[0]`'s `token`/`accountId`/`apiBase` back onto the channel object when it came from the one-bot form (or when a `default` bot exists). `DEFAULTS` gains `boundSession: null`. `redact` walks `bots` too. `cleanEnv`: `if (/^AI_BRIDGE_.*_TOKEN$/i.test(k)) continue;` before the keep checks.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/channels.config.test.js && node test/channels.restricted.test.js`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add server/channels/config.js server/channels/restricted.js test/channels.config.test.js test/channels.restricted.test.js
git commit -m "feat(channels): several bots per channel in channels.json; messenger tokens never reach children"
```

---

### Task 2: Adapters, approvals and status per bot

**Files:**
- Modify: `server/channels/main.js` (`buildAdapters`, `status`), `server/channels/manager.js` (`adapterFor`, `cfgFor`, `recover`, `runOne`, `handleAction`, `prompts`), `server/channels/approvals.js` (`resolve`), `server/channels/pairing.js` (`main` output)
- Test: `test/channels.main.test.js`, `test/channels.approvals.test.js`, `test/channels.manager.test.js`

**Interfaces:**
- Consumes: Task 1's `cfg.<channel>.bots`.
- Produces:
  - `buildAdapters(config, deps)` → one adapter per bot: `make()({ ...bot }, deps)`; each adapter has `id` (channel) and `accountId` (bot).
  - `status()` prints per bot: `channel telegram/turo: dmPolicy pairing, allowFrom (none), codex off, session turo (fable)` (`session none` when unbound).
  - `Manager.adapterFor(channel, accountId = "default")` → the adapter with both ids, or `undefined`; `cfgFor(adapter)` → `config[adapter.id].bots.find(b => b.accountId === adapter.accountId)` merged bot config (falls back to the channel object when `bots` is absent, so tests that build a Manager with a flat config keep working). `recover`, `runOne`, `/retry`, recovery notices and the queued-item drop paths all use `adapterFor(item.channel, item.accountId)`; a missing adapter → `journalDeclined(item, "no adapter for this bot")` + remove, never another bot.
  - `Approvals.resolve`: ownership (`actorId`, `channel`, `accountId`, `chatId`, `kind`) is checked **before** `stale`, so a foreign caller gets `forbidden` even for settled/expired records.
  - `handleAction`: a stored prompt is edited only when `prompt.adapter === adapter` (same object); otherwise no edit (ack still answered).
  - `bridge pairing list|approve|revoke` print `telegram/turo` for channel+account (`telegram/default` for the default account).

- [ ] **Step 1: Write the failing tests**

`test/channels.approvals.test.js` (append):
```js
{
  const A = new Approvals({ ttlMs: 1000, now: () => 0 });
  const { id } = A.create(base);
  A.resolve({ id, actorId: "42", channel: "telegram", accountId: "default", chatId: "100", kind: "intent", decision: "d" });
  assert(A.resolve({ id, actorId: "42", channel: "telegram", accountId: "turo", chatId: "100", kind: "intent", decision: "a" }) === "forbidden", "resolve: a settled record answers forbidden, not stale, to another account");
  assert(A.resolve({ id, actorId: "42", channel: "telegram", accountId: "default", chatId: "100", kind: "intent", decision: "a" }) === "stale", "resolve: the owner still gets stale after settlement");
}
```
`test/channels.main.test.js` (status block): write a config with `bots: [{accountId:"default",token:"x"},{accountId:"turo",token:"y",session:"turo"}]` and assert `r.stdout` contains `channel telegram/default:` and `channel telegram/turo: dmPolicy pairing, allowFrom (none), codex off, session turo (fable)` and not `"y"`; `buildAdapters(config)` returns two adapters with `accountId` `default` and `turo` (unit assertion via `require("../server/channels/main.js").buildAdapters`).
`test/channels.manager.test.js` (new block; `fakeAdapter({ accountId })` gains the option): config `{ fake: { token: TOKEN, dmPolicy: "pairing", bots: [{ accountId: "default", token: TOKEN }, { accountId: "b", token: TOKEN + "b" }] } }`, two adapters `a1` (default) and `a2` (b), senders paired on both; emit a task on `a2` → the ack is sent by `a2`, `runAgent` runs it, `ra.finish` → verdict text arrives on `a2` only; then restart test: seed a running item with `accountId: "b"` → the recovery notice goes to `a2`; and `handleAction` stale-id test: create an approval via a task on `a1` (write intent), decline it, then emit the same button data as an action on `a2` from the same actor → no `edit` recorded on `a2`, no run. Names: `two bots: item of account b runs and replies through adapter b`, `two bots: recovery notice through the item's own adapter`, `handleAction: stale id from another bot edits nothing`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/channels.approvals.test.js; node test/channels.main.test.js; node test/channels.manager.test.js`
Expected: the new assertions FAIL (forbidden vs stale; one adapter built; ack through adapter a1)

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/channels.approvals.test.js && node test/channels.main.test.js && node test/channels.manager.test.js && node test/channels.manager.sessions.test.js && node test/channels.e2e.test.js`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add server/channels/main.js server/channels/manager.js server/channels/approvals.js server/channels/pairing.js test/channels.main.test.js test/channels.approvals.test.js test/channels.manager.test.js
git commit -m "feat(channels): one adapter per bot; adapters, approvals and prompts resolved per account"
```

---

### Task 3: Bound-bot routing, commands, execution binding, redaction

**Files:**
- Modify: `server/channels/manager.js`
- Create: `test/channels.manager.bound.test.js`
- Modify: `test/helpers/manager-fakes.js` (`fakeAdapter({ accountId })`, `build({ config })` already accepts a config), `package.json`

**Interfaces:**
- Consumes: `cfg.boundSession` (Task 1), `adapterFor/cfgFor` (Task 2), `SessionStore` (`get`, `create`, `stop`…).
- Produces (manager):
  - `boundOf(cfg) → { name, model } | null`.
  - `handleInbound`, bound: no `parseRoute`; `row = sessions.get(owner, { name })`; model conflict → reply, settle; absent → `try { sessions.create(owner, name, model) } catch` → cap/other error reply, settle; paused → `session turo is paused; /resume`; else `enqueue` with that row.
  - Pairing notice on a bound bot: `Not paired. Code: X. The operator runs: bridge pairing approve telegram X (this bot is the "turo" conversation; your message was not kept — send it again once paired)`.
  - `handleCommand`, bound: `/new`, `/use`, `/stop all` → the refusal line; `/start` → refusal line + `\n` + bound HELP; `/pause|/resume|/stop [name]`: accept no arg or the bound name (normalised), else `this bot only has the conversation "turo"`; absent row → `no conversation yet; just send a message`; `/stop` reply `stopped turo; your next message starts a fresh conversation`; `/sessions` → one row or `no conversation yet; just send a message`; `/status` adds `bound: turo (opus)`; `/retry` → only if `last.sessionId` equals the current row id, else `cannot retry: that message was not for this conversation; send a new message`; `/help` → `HELP_BOUND` (ping, status, journal, approve, retry, cancel, pause, resume, stop, help + one line "Plain text continues the conversation").
  - `runOne`: bound and (`!item.sessionId || item.sessionName !== name`) → `journalDeclined(item, "bot is bound to another target")` + `🚫 dropped — this bot is bound to session turo`.
  - `runSessionTurn` missing-transcript message on a bound bot ends with `/stop, then send a new message`.
  - Redaction: `ask` passes `this.red(text)` to `sendButtons`/`sendText` and stores the redacted body; `journalRun` and `writeJournal` pass `task`, `feedback`, `evidence` through `this.red`.
  - `/status` for everyone: `current:` shows the task text only when `sameOwner(current.item, owner)`, else `current: busy (another chat)`.

- [ ] **Step 1: Write the failing tests**

`test/channels.manager.bound.test.js`: config `{ fake: { token: TOKEN, dmPolicy: "pairing", envPassthrough: ["MGR_PASS"], bots: [{ accountId: "default", token: TOKEN }, { accountId: "turo", token: TOKEN + "t", boundSession: { name: "turo", model: "claude-haiku-5-5" } }] } }` (the Manager consumes normalised config, so `boundSession` is given directly), adapters `a0` (default) and `a1` (turo), fake `runTurn`; sender 42 paired only on `default` at first.
```js
// unpaired on this bot → pairing notice names the binding; nothing created
await a1.emit({ senderId: "42", chatId: "42", eventId: "u1", text: "hello" });
assert(/^Not paired\. Code: [A-Z2-9]{6}\. The operator runs: bridge pairing approve fake [A-Z2-9]{6} \(this bot is the "turo" conversation; your message was not kept — send it again once paired\)$/.test(a1.texts().pop()) && sessions.list(ownerTuro).length === 0, "bound: unpaired on this bot → pairing notice names the binding");
pairing.save({ pending: [], approved: [...both accounts for 42] });
// first message creates the row and runs
await a1.emit({ ..., text: "@weird looking text" }); await tick();
assert(sessions.list(ownerTuro).length === 1 && sessions.list(ownerTuro)[0].model === "claude-haiku-5-5" && rt.calls[0].opts.text === "@weird looking text" && /^⏳ \[turo\] working on it/.test(a1.texts().pop()) && a0.texts().length === 0, "bound: first message auto-creates the row and runs the turn as literal text through this adapter");
rt.finish({ text: "hi" }); await tick(80);
// commands
for (const [cmd, reply] of [["/new x", REFUSAL], ["/use agent", REFUSAL], ["/stop all", REFUSAL], ["/pause other", 'this bot only has the conversation "turo"'], ["/pause turo extra", 'this bot only has the conversation "turo"']]) …
await a1.emit({ ..., text: "/start" }); assert(last().startsWith(REFUSAL + "\n") && /\/stop — start the conversation over/.test(last()), "bound: /start explains and shows the bound help");
await a1.emit({ ..., text: "/status" }); assert(/bound: turo \(haiku\)/.test(last()), "bound: status shows the binding");
await a1.emit({ ..., text: "/sessions" }); assert(/^\* turo \(haiku, 1 turns, active, just now\)\ncurrent: turo$/.test(last()), "bound: sessions lists the one row");
await a1.emit({ ..., text: "/pause" }); assert(last() === "paused turo", "bound: bare /pause");
await a1.emit({ ..., text: "more" }); assert(last() === "session turo is paused; /resume", "bound: paused wording without /use");
await a1.emit({ ..., text: "/resume" }); assert(last() === "resumed turo", "bound: bare /resume");
// retry binding
await a1.emit({ ..., text: "/retry" }); await tick(); assert(rt.calls.length === 2 && rt.calls[1].opts.text === "@weird looking text", "bound: /retry replays the last message to the row"); rt.finish({ text: "again" }); await tick(80);
// /stop → fresh row next time
const oldId = sessions.list(ownerTuro)[0].id;
await a1.emit({ ..., text: "/stop" }); assert(last() === "stopped turo; your next message starts a fresh conversation" && sessions.list(ownerTuro).length === 0, "bound: /stop forgets the conversation");
await a1.emit({ ..., text: "/retry" }); assert(last() === "cannot retry: that message was not for this conversation; send a new message", "bound: retry after stop is refused");
await a1.emit({ ..., text: "/sessions" }); assert(last() === "no conversation yet; just send a message", "bound: no row");
await a1.emit({ ..., text: "fresh" }); await tick();
assert(sessions.list(ownerTuro).length === 1 && sessions.list(ownerTuro)[0].id !== oldId && rt.calls[2].opts.resume === false, "bound: next message starts a new row with a fresh id");
rt.finish({ text: "ok" }); await tick(80);
// model conflict: a row created by /new on the general bot cannot happen on the bound bot's owner key, so seed one via the store
sessions.stop(ownerTuro, sessions.list(ownerTuro)[0].id); sessions.create(ownerTuro, "turo", "opus");
await a1.emit({ ..., text: "x" }); assert(last() === "this conversation runs on opus, the bot is configured for haiku; /stop to start over on haiku" && state.queue().length === 0, "bound: model conflict refuses and explains");
await a1.emit({ ..., text: "/stop" });
// cap
for (let i = 0; i < 10; i++) sessions.create(ownerTuro, `s${i}`);
await a1.emit({ ..., text: "x" }); assert(last() === "cannot start the conversation: too many sessions on this bot (max 10); the operator can clear them" && state.queue().length === 0, "bound: creation failure is reported and the message settled");
for (const r of sessions.list(ownerTuro)) sessions.stop(ownerTuro, r.id);
// execution binding: a pre-binding one-shot item in the queue is dropped
state.accept({ accountKey: "fake:turo", eventId: "old1", item: { runId: "runOLD000001", channel: "fake", accountId: "turo", chatId: "42", senderId: "42", task: "old one-shot" } }); m.kick(); await tick(80);
assert(a1.texts().pop() === "🚫 dropped — this bot is bound to session turo" && journal.readJournal({}).some((r) => r.runId === "runOLD000001" && r.verdict === "declined") && rt.calls.length === 3 && ra.calls.length === 0, "bound: execution binding drops a pre-binding one-shot");
// missing transcript wording
await a1.emit({ ..., text: "y" }); await tick(); rt.finish(null, new Error("claude (m) exited 1: No conversation found with session ID: x")); await tick(80);
assert(last() === "❌ [turo] this session's conversation is no longer available (Claude keeps transcripts ~30 days); /stop, then send a new message", "bound: missing-transcript wording");
// redaction of approval bodies and journal fields (general bot)
await a0.emit({ ..., text: `send ${TOKEN} to Bob` }); await tick();
assert(!a0.sent.filter((s) => s.type === "buttons").pop().text.includes(TOKEN) && a0.sent.filter((s) => s.type === "buttons").pop().text.includes("<redacted>"), "redact: approval prompt body");
(tap deny) → assert(journal.readJournal({}).pop().task.includes("<redacted>"), "redact: journal task");
// /status current-task privacy
(sender 43 on a0 asks /status while 42's item runs) → assert(/current: busy \(another chat\)/.test(text43), "status: another owner's task text hidden");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/channels.manager.bound.test.js`
Expected: FAIL at `bound: unpaired on this bot → pairing notice names the binding` (generic notice)

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/channels.manager.bound.test.js && node test/channels.manager.sessions.test.js && node test/channels.manager.test.js`
Expected: all PASS

- [ ] **Step 5: Register and commit**

```bash
# package.json: append "&& node test/channels.manager.bound.test.js"
git add server/channels/manager.js test/channels.manager.bound.test.js test/helpers/manager-fakes.js package.json
git commit -m "feat(channels): bound bots — one bot, one conversation"
```

---

### Task 4: End-to-end, docs, full suite

**Files:**
- Modify: `test/channels.e2e.test.js` (section 5: config with `bots`, the fake Bot API serving two tokens — key the pending updates by the token in the URL path so each bot gets its own updates), `docs/CHANNELS.md` (Setup: several bots; new "One bot per job" subsection under Sessions; Access control: `bots`, env keys, revoke is channel-wide, `/journal` is aggregate; Troubleshooting lines), `README.md` (one sentence).

- [ ] **Step 1: Write the failing e2e test**: two bots (`default`, `turo` bound); push a message to the turo bot → `turnCalls` gets it with `resume: false`, the ack comes from the turo token's `sendMessage`; `/stop` on turo → the stop reply; a message to the default bot → `runAgent` (one-shot) as before.
- [ ] **Step 2: Run** `node test/channels.e2e.test.js` — Expected: new assertions FAIL until the harness is wired, then PASS.
- [ ] **Step 3: Docs.**
- [ ] **Step 4: Full suite** — `npm test > /tmp/bound-npm.log 2>&1; echo $?` → `0`, no `FAIL` lines.
- [ ] **Step 5: Commit** `docs(channels): several bots, one bot per job; e2e for a bound bot`.

## Self-review notes

- Spec coverage: config (T1), adapters/status/pairing output/approvals/prompt edits (T2), bound routing/commands/binding/wording/redaction/status privacy (T3), docs/e2e (T4).
- Names used across tasks: `cfg.boundSession { name, model }`, `adapterFor(channel, accountId)`, `cfgFor(adapter)`, `fakeAdapter({ accountId })`.
- Review Focus 1–5 each name their test.

## Amendments after the Astra plan audit (2026-11-18, 15 findings)

These override the task text above where they differ.

1. **Create with the key.** `boundSession.model` holds the full id; auto-creation calls `sessions.create(owner, name, modelKey(model))` (`modelKey` maps id → `opus|fable|haiku`). Comparisons use full ids.
2. **One-shot journal redaction (Task 3).** `runOne` calls `runAgent(…, { noJournal: true })`, then redacts `report.record` (`task`, `feedback`, `evidence`) with `this.red` and appends it (`journal.appendJournal`) **before** `deliver`. Test: a completed one-shot whose evidence contains the token → the journal record holds `<redacted>`.
3. **Missing adapter at recovery (Task 2).** Keep the orphan handling: `stopOrphan` runs first; an unstoppable orphan keeps its item (held) exactly as today; only then is a running/queued item without an adapter journaled declined and removed. Tests cover stopped and unkillable orphans of a bot that vanished from the config.
4. **Normalisation (Task 1).** The flat aliases (`token`, `accountId`, `apiBase`) come from the bot whose `accountId === "default"` when the `bots` form is used (whatever its position), and from the lone bot in the one-bot form. Flat `allowFrom`, `codex`, `envPassthrough`, `intentKeywords`, `dmPolicy` on the channel object are normalised exactly as before (they are the defaults). Test: `bots` listed default-last still aliases the default bot.
5. **Env precedence (Task 1).** One-bot form: `AI_BRIDGE_<CH>_TOKEN` applies to the lone bot whatever its `accountId` (legacy), and `AI_BRIDGE_<CH>_<ACCOUNTID>_TOKEN` wins when both are set. `bots` form: generic → `default` only. Duplicate effective tokens produced by overrides are the same error as in the file. Documented in CHANNELS.md.
6. **Fable default (Task 1).** `SessionStore.create(owner, name, modelKey = "fable")`, `/new` fallback `args[1] || "fable"`, `recordInbound`/store internals unchanged. Expectations updated in `test/channels.sessions.test.js` (`row defaults` → `claude-fable-5-1`, add an explicit `opus` case), `test/channels.manager.sessions.test.js` (`created session turo (fable)`, listings `(fable, …)`), `test/channels.e2e.test.js` (`created session turo (fable)`), docs examples. Task 1's test command and commit include these files.
7. **CLI test placement (Task 2).** In `test/channels.main.test.js`, `process.env.AI_BRIDGE_HOME = home` is set before any `require("../server/...")`; the `buildAdapters` unit assertion requires `main.js` only after that.
8. **Fakes (Task 2, not 3).** `test/helpers/manager-fakes.js`: `fakeAdapter({ accountId = "default" })` and `emit` uses `a.accountId`; `build({ adapter | adapters: [...] })`. Committed with Task 2.
9. **Fixtures (Tasks 2–3).** Manager fixtures are fully merged bot configs (every default field present per bot) and differ per bot: the bound bot uses `envPassthrough: ["MGR_PASS2"]` and the general bot `["MGR_PASS"]`; tests assert the turn's `envPassthrough` is the bot's own. `/status` privacy is tested for the same sender id on another account.
10. **Stale-prompt guard (Task 2).** Two tests: (a) a foreign account tapping a settled record gets `forbidden` and no edit; (b) with `m.approvals.resolve` stubbed to return `"stale"` and a retained prompt whose `adapter` is `a1`, `handleAction(a2, …)` edits nothing on either adapter; the owner tapping an expired record (clock past TTL) gets `stale` and the "(no longer pending)" edit through its own adapter.
11. **Error secrecy (Task 1).** Config JSON errors report only `invalid JSON (at position N)` (position parsed from the parser message, else omitted); validation errors quote `accountId`/`session`/`model` values only (never tokens). Test: a malformed file containing a token sentinel → the error message lacks it.
12. **Model binding everywhere (Task 3).** `/retry` on a bound bot refuses when the target row's model differs from the configured one (same wording as inbound); `runOne` on a bound bot also loads the row by `item.sessionId` and drops the item with the model-conflict wording when it differs. Tests: retry against a conflicting row; queued session item with the wrong name; matching name with conflicting model.
13. **Redact before quoting (Task 3).** `quote()` receives already-redacted text (`this.quote(this.red(item.task))`); `ask` sends and stores the redacted, then truncated body; edits reuse the stored body. Tests use a sentinel positioned across the `QUOTE_MAX` boundary.
14. **Pairing output (Task 2).** `list`/`approve` print `telegram/turo`; `revoke` prints `revoked telegram sender <id> (all bots)` and is documented as channel-wide.
15. **Test hygiene.** Distinct sentinel tokens per bot (`TOKEN_A`, `TOKEN_B`), assertions inside the IIFE scope, completion awaited through observable state (`state.queue().length === 0` / message counts) with bounded polling (`until(fn, 2000)` helper in the fakes), and settlement asserted via `state.isSeen`.
