# Messenger channels (`bridge channels`) — Design

**Date:** 2026-11-15
**Status:** Revised after Codex Astra audit and builder check; awaiting owner approval
**Base branch:** `economy-mode` (PR #5). The approval flow hooks into the
recipe risk model that PR introduces; merge #5 first or stack the PRs.

## Why

ai-bridge is driven from a terminal. Consumer agents (Meta Muse, OpenAI Dots,
Instinct) are driven from a phone, through a messenger, and that is the gap
engineers notice first. OpenClaw (MIT, 394k stars) proves the shape: one
always-on process, many messenger adapters, a pairing-code allowlist, tap
buttons for approvals. We want the same consumer surface on top of what
ai-bridge already does better than all of them: the task runs in the user's own
logged-in Chrome, on localhost, with no vendor holding credentials, through the
cheap-model ladder and token-free recipes.

Target user: a software engineer with a Mac that has Chrome, and optionally a
second machine or server. They text their bot a task from the phone and get the
result back in the same thread.

## Goals

- Text a task to a bot in any supported messenger; it runs through
  `bridge agent` and replies with the verdict, the evidence report and the
  files the task produced.
- Approve or cancel risky work from the phone, **before** it happens: by tap
  where the messenger has buttons, by a text reply where it does not.
- Status commands (`/ping`, `/status`, `/jobs`, `/journal`) answered with no
  model call.
- Pairing-code allowlist by default; nothing runs for an unknown sender.
- Channels pluggable behind one small interface; adding a messenger is one
  file plus one test. First release: Telegram. Then Slack, Discord,
  Mattermost, Matrix, WhatsApp, iMessage, MS Teams, Google Chat, Signal.
- Dependency budget stays near zero: Node 18 `fetch` and the existing `ws`
  carry Telegram, Slack (Socket Mode), Discord (gateway), Mattermost, Matrix
  (`/sync`), Signal (signal-cli HTTP+SSE). WhatsApp is the only adapter that
  pulls a library (`baileys`).

## Non-goals (v1)

- Group chats, threads, reactions, streaming edits. DM only.
- Multiple operators with separate permissions. **Every paired sender is
  owner-equivalent** (OpenClaw's model). `/jobs` and `/journal` therefore show
  everything; that is correct for one operator and documented as such.
- Inbound attachments. A photo or file sent with a task is ignored and the
  bot says so. Adapters do not download inbound media.
- Delivering files saved through Chrome's download manager (`download`
  lands in `~/Downloads`, possibly on another machine). Files are delivered
  through the outbox path below.
- Running the model on the phone side or in a cloud.
- End-to-end encryption for Matrix (plain rooms only).
- WhatsApp inside the single-executable build. WhatsApp is source-install
  only in v1; the binary reports a clear error.

## Anti-goals

- Any path that clicks Pay / Submit Payment. The ops playbook rule stays, and
  no channel command can override it.
- Inbound text ever reaching the server as an instruction. It becomes a task
  string for a **restricted** agent run (below), nothing else.
- A public inbound port on the laptop. Every v1 transport connects outbound.
  Teams and Google Chat need an HTTPS endpoint and are documented as
  "server or tunnel only".
- Falling back to the model ladder when an approval is declined. Declined
  means stopped.

## Where it runs

`bridge channels start` is a separate long-running process
(`server/channels/main.js`), not part of the relay in `server.js`. The relay
is started on demand by the native host and must stay tiny; the channel daemon
holds messenger sockets open for hours. `deploy/` gets launchd and systemd
templates for it. A lock file (`~/.ai-browser-bridge/channels.lock`) prevents
two daemons polling the same bot.

Default layout: daemon on the same machine as Chrome, Claude Code and the
relay. It calls `runAgent()` from `server/agent.js` in-process.

Two-machine layout (documented recipe, no new networking code): the daemon and
Claude Code run on the server; the laptop's relay port is reached through an
SSH tunnel or Tailscale (`ssh -N -L 8765:127.0.0.1:8765 laptop`), and the token
file is copied to the server. `docs/CHANNELS.md` carries the recipe.

## Restricted runs

Every channel-originated run is a **restricted run**. This is the core
security property and it is enforced by tooling, not by prompt text.

- Ops sessions get an allowlist of browser commands only, one `allowedTools`
  pattern per command: `ping status listTabs newTab navigate eval click type
  insertText key waitFor scroll snapshot screenshot pdf selectTab closeTab
  detach`. Administrative subcommands (`agent jobs recipe journal pairing
  channels claude-md reloadExtension detachAll activateTab`) are not in the
  list, so an injected "run bridge jobs set --login-cmd" cannot execute.
  `download` is excluded too (see outbox).
- The Codex rung is **off** for restricted runs. Codex has no per-command tool
  allowlist and runs with workspace write, so an injected instruction could
  reach the shell. Operators who accept that risk set `codex: true` per
  channel.
- Child processes get an explicit environment: `PATH HOME USER LANG TMPDIR
  BRIDGE_PORT AI_BRIDGE_*` run metadata, and nothing else. Messenger tokens
  never reach a model or a login hook. Token values are redacted from
  `channels.log`, error messages and delivered evidence.
- Per-run cwd is the run's outbox directory, so `screenshot --out` and
  `pdf --out` land there without the model knowing any path.
- Restricted runs never trigger learning, repair or recipe proposal from
  their traces (`autoLearn` is skipped); they may **run** existing recipes.
  Recipes stay something the operator grows from the terminal.

## Approvals: before, not after

The judge sees evidence after the ops rung has acted, so it cannot be the
gate. Three gates sit in front of execution instead.

1. **Intent gate.** Before the ladder starts, the task text is classified
   `read` or `write` by a keyword pass (`send submit post pay buy book order
   reply publish delete cancel transfer message email sign accept`) plus the
   existing cheap Haiku match call when the keywords are silent. `write` →
   approval prompt quoting the task; nothing runs until it is approved.
2. **Recipe gate.** A recipe whose effective risk is `write` asks before it
   runs, every time, in audit and economy mode alike. Effective risk is the
   stricter of the stored `risk` and `inferRisk()`; `inferRisk()` is extended
   to flag `eval` code containing `.click( .submit( fetch( XMLHttpRequest
   dispatchEvent .value=` and `poll`/`waitFor` on a URL change after such an
   eval. A recipe stored as `read` that inference calls `write` runs as read
   only after `bridge recipe approve <job>` records `riskApprovedBy:
   "operator"` on that version. `validateRecipe()` rejects unknown `do`
   commands.
3. **Stop-before-send (best effort).** The ops playbook for restricted runs
   adds: "before any irreversible action the task did not already name, stop
   and end your report with `NEEDS APPROVAL: <one line>`". `parseVerdict()`
   recognises that line in the evidence as a pending state; the daemon asks,
   and on approval re-runs the **same** rung with the feedback
   `approved: <line>; proceed`, counted as an extra stage. This catches
   surprises; the guarantees come from gates 1 and 2.

`runAgent` gains `opts.approve(request) → Promise<"approved" | "denied">` and
`opts.signal` (AbortSignal). Without `approve`, behaviour is unchanged.

Approval records live in memory in the daemon, single use, 10-minute TTL,
bound to the operation: `{ id, runId, kind, digest, channel, accountId,
chatId, senderId, createdAt }` where `digest` is sha256 of the task text (intent
gate), of `job + recipe version + rendered params` (recipe gate) or of the
`NEEDS APPROVAL` line (stop-before-send). The approval wait does not count
against the per-stage model timeout. Denied, expired, cancelled, or daemon
restart all resolve to **denied**; the run ends with journal verdict
`declined`, job state untouched, and the bot says what was not done.

Rendering per channel capability:

- Buttons (Telegram, Slack, Discord, WhatsApp interactive, Teams Adaptive
  Card, Google Chat card): `Approve` / `Cancel`. Button data carries only
  `ab1:<kind>:<a|d>:<id>`, never state or secrets.
- No buttons (iMessage, Signal, Matrix, Mattermost in v1): the prompt ends
  with `reply /approve <id> yes or /approve <id> no`.

On click or text: parse strictly (foreign prefixes are rejected and consumed),
require actor = the sender who started the run, compare channel, accountId,
chatId and kind against the record, resolve exactly once. A second click or an
expired record edits the message to "no longer pending", removes the buttons,
and never re-fires.

## Conversation contract

Plain text (not starting with `/`) is a task. Flow:

1. Daemon persists acceptance in `channels-state.json` (one atomic write that
   also marks the transport event id as seen) **before** acknowledging the
   transport event, so a crash never loses or doubles a task. Items found in
   `running` or `awaiting-approval` state after a restart are not replayed:
   they are journaled `declined` and the sender is told to resend. The journal
   keeps exactly one record per run (`source: "channel:<id>"`).
2. Replies `⏳ queued (run abc123, position N)` or `⏳ working on it`.
3. Intent gate (above). Then `runAgent()`. Progress lines are sent as they
   happen, coalesced to one message per 15 s.
4. On completion: verdict line, evidence report chunked to the channel limit,
   then outbox files as attachments.
5. On failure: the ladder's last feedback and `reply /retry to run again`.
   `/retry` of a `write`-intent task asks approval again.

**One global queue, one run at a time.** A single Chrome, a single relay, and
non-atomic job state make parallel runs wrong; the position message makes a
serial queue natural. Caps: 3 queued per sender, 10 global. Over cap: the task
is refused with a one-line reply.

Commands, all answered without a model:

| Command | Does |
|---|---|
| `/ping` | relay + extension health |
| `/status` | daemon uptime, queue, current run, attached tabs |
| `/jobs` | `bridge jobs` table (operator-wide) |
| `/journal [days]` | three-line summary: runs, pass rate, cost |
| `/approve <id> yes\|no` | text fallback for an approval |
| `/retry` | re-run the sender's last task |
| `/cancel` | stop the running task and drop this sender's queued tasks |
| `/help` | this list |

### Cancel

`runAgent` propagates `signal` to `runClaude`/`runCodex` (children spawned
`detached: true`, killed as a process group), to `runRecipe` (checked between
steps; the recipe's window is closed on abort), and to the approval wait
(rejects). Journal verdict `cancelled`; job state untouched (no
`regular-fail` / `recipe-fail`). The bot says: "stopped; actions already
performed were not undone".

### Outbox

Each run gets `~/.ai-browser-bridge/outbox/<runId>/` as cwd and as
`AI_BRIDGE_OUTBOX`. The restricted playbook says: "to deliver a file, fetch it
in the page with `eval` returning `{base64}` and `--out <name>`, or use
`pdf --out` / `screenshot --out`; files in the current directory are sent to
the user". This works same-origin with the user's cookies and needs no
extension change. Files named on the evidence `Screenshots:` line are
attached as well.

Delivery hardening: `lstat` every entry, regular files only, no symlinks,
same uid as the daemon, open by descriptor then `fstat`, at most 10 files,
45 MB each, 100 MB total (channel `maxFileBytes` applies). Delivered files
are deleted; undelivered ones are kept and the path is reported.

## Access control

Config `~/.ai-browser-bridge/channels.json` (created mode 600, refused if
group/world readable), per channel account:

```json
{
  "telegram": {
    "token": "123:ABC",
    "dmPolicy": "pairing",
    "allowFrom": ["123456789"],
    "codex": false
  }
}
```

Secrets may also come from env (`AI_BRIDGE_TELEGRAM_TOKEN`), which wins over
the file.

`dmPolicy` truth table (sender known = in `allowFrom`; paired = in the
pairing store's approved list):

| policy | known | paired | unknown |
|---|---|---|---|
| `pairing` (default) | run | run | one pairing reply, then silence |
| `allowlist` | run | drop | drop |
| `open` (needs `"*"` in allowFrom) | run | run | run |
| `disabled` | drop | drop | drop |

Pairing store `~/.ai-browser-bridge/pairing.json`, written atomically
(tmp + rename), re-read on every inbound so revocation is immediate.
Pending `{ channel, accountId, senderId, code, meta, createdAt }`; approved
`{ channel, accountId, senderId, approvedAt }`. Codes: 6 chars from
`crypto.randomBytes`, alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, unique
among pending. Pending expire after 1 hour; at most 20 pending per channel,
oldest evicted. Approved entries count only under `pairing`, so they never
widen `allowlist` or `open`.

Unknown sender under `pairing`: the bot replies once with
`Not paired. Code: X7K2PQ. The operator runs: bridge pairing approve telegram X7K2PQ`
and stays silent for that sender for an hour. Operator CLI:
`bridge pairing list | approve <channel> <code> | revoke <channel> <senderId>`;
`approve` prints the sender's id and display meta so the operator confirms the
right person. Approval is never done in-band by the sender.

Identity is the channel's stable id (Telegram numeric user id, Slack user id,
Discord snowflake, Mattermost user id, Matrix MXID, WhatsApp JID, iMessage
handle, Teams AAD object id, Google Chat user resource, Signal UUID). Never a
display name or `@username`.

Limits before any work: 20 inbound per paired sender per 60 s, 200 global,
a separate 5 per minute bucket for unknown senders, 8 KB text cap, at most
4096 tracked senders (LRU). Over-limit messages are dropped with one notice
per minute. `channels.log` rotates at 10 MB (keep 3) and records sender id,
command or kind, run id, never other senders' task text.

## Adapter interface

`server/channels/<id>.js` exports a factory:

```js
module.exports = function makeAdapter(config, deps) {
  return {
    id: "telegram",
    accountId: "default",
    capabilities: { buttons: true, media: true, edit: true,
                    textLimit: 4000, chunkMode: "markdown", maxFileBytes: 50e6 },
    async start(onInbound) {},   // onInbound({ accountId, senderId, chatId, chatType, messageId, eventId, text, raw })
    async stop() {},
    async sendText(chatId, text) {},                 // → { messageId }
    async sendFile(chatId, filePath, caption) {},
    async sendButtons(chatId, text, buttons) {},     // optional; buttons = [{label, data}]
    async editMessage(chatId, messageId, text, buttons) {}, // optional
    onAction(handler) {},        // optional; handler({ actorId, chatId, messageId, data, ack })
  };
};
```

Adapter duties: set `chatType` and only emit `"direct"` in v1; drop its own
and other bots' messages; supply a per-account-unique `eventId`; acknowledge
button callbacks itself (`ack`); map transport errors to
`{ retryAfterMs?, permanent? }`. Teams verifies the Bot Framework JWT
(issuer, audience = appId, expiry, tenant, signing key from JWKS); Google Chat
verifies the ID token (issuer `chat@system.gserviceaccount.com`, audience =
project number or app URL, expiry).

`deps` gives `fetch`, `WebSocket`, `log`, `sleep`, `now` so tests inject
fakes. The manager (`server/channels/manager.js`) owns: config load, policy
gate, rate limit, pairing, dedup (per account: committed offset plus a ring of
the last 1000 `eventId`s in `channels-state.json`), command parsing, the
queue, approvals, chunking, outbox delivery, logging. Adapters do transport
only.

`chunk(text, limit, mode)`: split on paragraph, then newline, then sentence;
in `markdown` mode a split inside a code fence closes the fence at the chunk
end and reopens it at the next chunk start.

## Shared-state fixes in existing code

- `jobs.saveJobs`, `recipe.saveRecipe`, pairing and channel state all go
  through one `atomicWrite(file, text)` (tmp + rename).
- `runRecipe` accepts `signal` and closes its window on abort.
- `runClaude`/`runCodex` accept `signal`, spawn detached, kill the group.
- Journal verdict gains `declined` and `cancelled`; `autoLearn`,
  `recipe propose` and candidate marking keep filtering on `pass`.

## Transports (all outbound-only unless marked)

| Channel | Transport | Auth artifact | Dep |
|---|---|---|---|
| Telegram | Bot API `getUpdates` long-poll (`allowed_updates: message, callback_query`), offset committed after the task is persisted | bot token | none |
| Slack | Socket Mode over `ws` (`apps.connections.open`), REST for sends, Block Kit buttons | `xoxb-` bot token, `xapp-` app token | none |
| Discord | Gateway over `ws` with MESSAGE_CONTENT intent, heartbeat/resume, REST for sends, components for buttons | bot token | none |
| Mattermost | `ws` to `/api/v4/websocket`, REST v4; text approval fallback (buttons need an HTTP callback) | bot token + server URL | none |
| Matrix | `/sync` long-poll, `/send`; text approval fallback | access token | none |
| WhatsApp | `baileys` multi-device, QR pairing, auth state on disk | QR link | `baileys` |
| iMessage | `imsg rpc` JSON-RPC if installed, else `osascript` send + `chat.db` poll; macOS only | Full Disk Access | none |
| MS Teams | HTTP listener `/api/messages`, Bot Framework JWT; **needs public HTTPS** | appId, secret, tenantId | none |
| Google Chat | HTTPS webhook, Google ID token; **needs public HTTPS** | service account JSON | none |
| Signal | `signal-cli` daemon, JSON-RPC `/api/v1/rpc` + SSE `/api/v1/events` | linked device dir | none |

Later: Viber, Webex, Zoom, Messenger, SMS.

## Branches and PRs

One PR per channel on top of the core:

1. `feat/channels-core` — manager, restricted runs, gates, approvals,
   pairing CLI, queue, cancel, outbox, chunking, atomic writes, Telegram
   adapter, `docs/CHANNELS.md`, deploy templates, playbook changes.
2. `feat/channel-slack`
3. `feat/channel-discord`
4. `feat/channel-mattermost`
5. `feat/channel-matrix`
6. `feat/channel-whatsapp`
7. `feat/channel-imessage`
8. `feat/channel-msteams`
9. `feat/channel-googlechat`
10. `feat/channel-signal`

Before implementation of each PR, its written plan is audited by Codex
`gpt-6-astra` (`codex exec`, read-only sandbox) and the findings are
addressed in the plan. The same audit runs on the diff before the PR opens.
Commits appear only under the owner's name; the owner merges.

## Tests

Same style as the existing suite (plain node scripts, `npm test`):

- `test/channels.manager.test.js` — fake adapter and fake `runAgent`:
  policy truth table, pairing lifecycle and expiry, rate limits including the
  unknown-sender bucket, dedup across a simulated restart, command routing,
  queue caps and ordering, cancel dropping queued tasks, chunking with fence
  reopening, outbox delivery refusing symlinks and oversize files, approval
  single-use, expiry, wrong-actor, wrong-chat, foreign prefix.
- `test/channels.restricted.test.js` — the allowedTools list produced for a
  restricted run contains no admin subcommand; the child env contains no
  token; Codex rung absent unless enabled.
- `test/channel-<id>.test.js` per adapter — a local `http`/`ws` fake of the
  messenger API; wire format of inbound normalization and outbound sends,
  offset/ack after persistence, reconnect on close, self-message drop.
- `test/agent.test.js` gains: `approve` called before a write recipe, denied
  → `declined` with job state unchanged, `signal` abort → `cancelled`,
  intent gate ordering, `NEEDS APPROVAL` → pause → same-rung rerun.

## Decisions made by the designer (check these)

- Single operator; paired senders are owner-equivalent.
- One global serial queue.
- Codex rung off for channel runs unless opted in.
- Intent gate adds one tap for write-looking tasks; the keyword list is a
  starting point and lives in config.
- Inbound attachments and Chrome downloads out of v1.
- WhatsApp source-install only.

## Left to the builder

- Reconnect/backoff constants per transport.
- Exact chunker heuristics beyond the stated order and fence rule.
- Haiku prompt wording for the intent classifier.
- iMessage: `imsg` vs `osascript` decided by what is installed.
