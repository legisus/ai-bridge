# Bound bots — one Telegram bot per session

**Status:** design, 2026-11-18, revised the same day after the Codex `gpt-6-astra` audit (15
findings folded in). Builds on `2026-11-17-channel-sessions-design.md` (sessions, PR #7) and
ships as its own branch/PR on top of `feat/channels-sessions`.

## Intent

The user wants a separate bot for each job ("turo", "taziky", "mail"): opening that bot's chat
*is* the conversation. No `/new`, no `/use`, no `@name`; the general bot keeps the full
session commands for ad-hoc work. Several bots run under one daemon, one Chrome, one queue.

## Goals

- `channels.json` can list several Telegram bots under one channel, each with its own
  `accountId`, token and optional **bound session**.
- A bound bot routes every plain message to its session, creating it on the first message,
  per authorized sender. Turn messages are labelled as today (`[turo] …`).
- On a bound bot: `/pause`, `/resume`, `/stop` (= start the conversation over), `/sessions`,
  `/retry`, `/cancel`, `/status`, `/journal`, `/help`, `/ping`, `/approve`, `/start` work;
  `/new`, `/use`, `/stop all` and `@name` routing are refused with one explanation.
- Everything else (pairing per bot, rate limits, intent gate, approvals, restricted turns,
  recovery) is shared, with the adapter/config always resolved by `(channel, accountId)`.

## Non-goals

- Cross-bot access to sessions: one sender has one `turo` row per bot (owner key
  `telegram:<accountId>:<senderId>`); rows, `last`, queue items and approvals stay per owner.
  `/journal` remains what it is today: an owner-equivalent **aggregate** over all channel runs
  (documented as such); `/status` shows the daemon's queue length for everyone but the current
  task's text only to its own owner (`current: busy (another chat)` otherwise).
- Automatic pairing across bots: each bot pairs separately (`bridge pairing approve telegram
  <code>`; codes are unique per channel). `bridge pairing revoke telegram <id>` is channel-wide
  (all bots), documented. Allowlisted (`allowFrom`) or `open` senders are authorized on every
  bot that inherits that policy; "separate pairing" applies where pairing is required.
- Per-bot concurrency: turns still run one at a time.

## Configuration

`channels.json` keeps today's shape for one bot and gains a `bots` list:

```json
{
  "telegram": {
    "dmPolicy": "pairing",
    "bots": [
      { "accountId": "default", "token": "123:AA…" },
      { "accountId": "turo",   "token": "456:BB…", "session": "turo" },
      { "accountId": "taziky", "token": "789:CC…", "session": "taziky", "model": "haiku" },
      { "accountId": "mail",   "token": "012:DD…", "session": "mail" }
    ]
  }
}
```

`loadConfig` normalises every channel to `{ ...channelDefaults, bots: [bot…] }` and
validates each **merged** bot (`{ ...channelDefaults, ...bot }`):

- One-bot form: `{ "token": …, "accountId"?: …, "apiBase"?: …, … }` becomes
  `bots: [{ accountId: accountId || "default", token, apiBase, … }]`; the flat fields stay on
  the channel object as well (`cfg.telegram.token`, `cfg.telegram.accountId` keep working, and
  `makeTelegram(cfg.telegram)` still builds the first bot). A channel with both `token` and
  `bots` is an error ("use either token or bots").
- `accountId` matches `[a-z0-9_-]{1,24}`, is unique per channel, defaults to `default`
  (only one bot may be `default`). `token` required per bot after env overrides are applied.
- Env overrides, applied **before** the token check: `AI_BRIDGE_TELEGRAM_TOKEN` → the
  `default` bot; `AI_BRIDGE_TELEGRAM_<ACCOUNTID>_TOKEN` (upper-cased, non-alphanumerics → `_`)
  → that bot. Two account ids that map to the same env key are an error, as are two bots with
  the same effective token.
- `session` is normalised with the session store's `normalizeName` (error if invalid or
  reserved); `model` is `opus|fable|haiku` (default `opus`). `cfg.boundSession = { name, model }`
  on the merged bot config, or `null`.
- `redact(text, config)` covers every bot's token (flat and in `bots`). `cleanEnv` denies any
  key matching `/^AI_BRIDGE_.*_TOKEN$/` even when listed in `envPassthrough` (messenger
  credentials never reach a child). Config errors name the file and the key, never raw content.
- `bridge channels status` prints one line per bot: `channel telegram/turo: dmPolicy pairing,
  allowFrom (none), codex off, session turo (opus)`.
- The daemon builds one adapter per bot (`makeAdapter({ token, accountId, apiBase, … })`);
  offsets and dedup rings are already keyed by `channel:accountId`; one daemon lock, one serial
  worker. The manager keeps `adapters` as a list and resolves `adapterFor(channel, accountId)`
  and `cfgFor(adapter)` (merged bot config) **everywhere** — `runOne`, `recover`, `/retry`,
  recovery notices — never by channel alone; an item whose adapter is gone is dropped with a
  declined journal record and no fallback to another bot.

## Manager behaviour on a bound bot (`cfg.boundSession`)

- **Target.** Plain text (including text starting with `@`; `parseRoute` is skipped) goes to
  the sender's row named `boundSession.name` on this owner key. If absent, it is created
  (`sessions.create(owner, name, model)`) just before queueing; creation failures (the
  10-row cap on an account that used to be a general bot) are caught: `cannot start the
  conversation: too many sessions on this bot (max 10); the operator can clear them` and the
  update is settled. The store's `current` is set but never consulted. If the row exists with a
  different model than configured (a row made by `/new` before the bot was bound): `this
  conversation runs on <model>, the bot is configured for <model2>; /stop to start over on
  <model2>`, and the message is not queued.
- **Execution binding.** `runOne` re-checks that a bound bot's item carries `sessionId` and
  `sessionName === boundSession.name`; anything else (old queued one-shots from before the
  binding, a recovery replay) is dropped as declined with `🚫 dropped — this bot is bound to
  session turo`. `/retry` only replays when the stored target is that row's id; otherwise
  `cannot retry: that message was not for this conversation; send a new message`.
- **Paused** → `session turo is paused; /resume` (no `/use` hint).
- **Commands.** `/pause`, `/resume`, `/stop` accept no argument or exactly the bound name;
  any other name or extra argument → `this bot only has the conversation "turo"`. Without a
  row: `no conversation yet; just send a message`. `/stop` (or `/stop turo`) removes the row
  as today (abort + drop queued) and replies `stopped turo; your next message starts a fresh
  conversation`; the next message creates a new row (new id, directory, `claudeSessionId`).
  `/new`, `/use`, `/stop all` → `this bot is bound to session turo: plain text goes to it,
  /pause and /resume control it, /stop starts it over`. `/start` → the same line plus the
  bound `/help` (no row is created). `/sessions` → the one row or `no conversation yet; just
  send a message`. `/status` adds `bound: turo (opus)`. `/help` shows the bound list.
- **Errors.** Missing transcript on a bound bot: `❌ [turo] this session's conversation is no
  longer available (…); /stop, then send a new message`. The general bot keeps `/stop turo and
  /new turo`.
- **Labels.** Turn messages (ack, progress, reply, files, approval prompts, errors) are
  labelled as today. Command replies, pairing and recovery notices are not (one conversation
  per chat makes them unambiguous).
- **Pairing notice** on a bound bot: `Not paired. Code: … The operator runs: … (this bot is
  the "turo" conversation; your message was not kept — send it again once paired)`.

## Security

- No new authority: a bound bot's turn is a session turn.
- Owner keys include the `accountId`; approvals already carry `accountId` and are resolved by
  actor + account + chat. **Fix carried here:** `Approvals.resolve` checks ownership before
  answering `stale`, and `handleAction` edits a stored prompt only through the adapter that
  sent it (prompts remember their adapter), so a stale callback id from one bot can never
  copy another bot's prompt text into this chat.
- Tokens of all bots are redacted from logs, errors, delivered text, **approval prompt bodies
  and their edits, and journal records written by the daemon** (task, feedback, evidence pass
  through `redact` before persisting); tokens never reach children (`cleanEnv` deny rule).
- A bot's `session`/`model` come from the operator's file, never from chat.

## Builder's calls

- `bots` list under the channel object; the one-bot form is byte-for-byte compatible.
- Auto-create on first message, not on pairing.
- `/stop` on a bound bot keeps "forget + start over"; `/stop all` is refused there.
- Bot names for the user's three jobs: `@ai_bridge_turo_bot`, `@ai_bridge_taziky_bot`,
  `@ai_bridge_mail_bot` (accountIds `turo`, `taziky`, `mail`; sessions of the same names;
  model `opus`). `@ai_bridge_mykola_bot` stays the general (unbound, `default`) bot.
- `bridge pairing list` / `approve` output shows `telegram/turo` (channel/account) so the
  operator sees which bot a code belongs to; the approve syntax is unchanged.

## Review

Audited by Codex `gpt-6-astra` (read-only; 15 findings folded); the plan and the diff get the
same treatment.
