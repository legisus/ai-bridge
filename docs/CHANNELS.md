# Messenger channels — text your browser agent

`bridge channels start` runs a small daemon that connects your messengers to
the bridge. You text a task from your phone; it runs through `bridge agent`
in your own logged-in Chrome, on your own machine; you get the verdict, the
evidence report and any files back in the same chat. Risky steps ask for a tap
first. Nothing runs for a sender you have not paired.

Telegram ships first. Slack, Discord, Mattermost, Matrix, WhatsApp, iMessage,
Microsoft Teams, Google Chat and Signal follow, one adapter each.

## Setup (Telegram, five minutes)

1. Create a bot: message [@BotFather](https://t.me/BotFather), `/newbot`, copy
   the token (`123456789:AA…`).
2. Write the config, readable only by you:
   ```bash
   cat > ~/.ai-browser-bridge/channels.json <<'EOF'
   { "telegram": { "token": "123456789:AA…" } }
   EOF
   chmod 600 ~/.ai-browser-bridge/channels.json
   ```
   The token may also come from `AI_BRIDGE_TELEGRAM_TOKEN` (env wins over the file).
3. Make sure the relay and extension are up (`bridge ping`) and Claude Code is
   logged in (`claude -p "hi"` works), then start the daemon:
   ```bash
   bridge channels start            # or: node server/channels/main.js start
   ```
4. Open your bot in Telegram and send any message. It answers:
   `Not paired. Code: X7K2PQ. The operator runs: bridge pairing approve telegram X7K2PQ`
5. Approve yourself from the terminal — pairing is never done inside the chat:
   ```bash
   bridge pairing approve telegram X7K2PQ
   ```
6. Text a task: *"open example.com and tell me the page title"*.

Want a separate bot for each job? Create more bots with BotFather and list them
under `"bots"` (see *One bot per job* below); one daemon polls them all.

Keep it running with `deploy/launchd/com.ai-bridge.channels.plist` (macOS) or
`deploy/systemd/ai-bridge-channels.service` (Linux); both templates explain the
two paths to replace.

## What you can send

Plain text is a task. The daemon replies `⏳ working on it` (or `⏳ queued
(position 2)`), then edits that one line in place while it runs (`⏳ working on
it · ops:opus-5.5 · 45s`, at most every 15 s, never a new message or a
notification), ends it as `✅ done in 52s`, and sends:

- `✅ pass — …` / `❌ fail — …` / `🚫 declined — …` / `⏹ cancelled`
- the evidence report, split to the messenger's message limit
- every file the run left in its outbox, as attachments (see Files)
- `reply /retry to run again` after a failure

| Command | Does |
|---|---|
| `/ping` | relay + extension health (`bridge ping`) |
| `/status` | daemon uptime, queue length, current run |
| `/jobs` | known jobs and their economy-mode state |
| `/journal [days]` | runs, pass rate and cost over the last N days (default 7) |
| `/approve <id> yes\|no` | answer an approval by text (for messengers without buttons) |
| `/retry` | run your last task again |
| `/cancel` | stop the running task and drop your queued tasks |
| `/help` | the list above |

One task runs at a time (one Chrome, one relay). Up to 3 tasks per sender and
10 overall wait in the queue; more are refused with `queue full`.

## Sessions: conversations that remember

A **session** is a named, persistent Claude Code conversation that runs in your
Chrome under the same restrictions as every channel run. Where a plain task is
judged and forgotten, a session remembers what you said earlier, so "open my
inbox", "reply to the first guest", "shorter" work as a conversation. There is
no judge and no model ladder: you read the reply.

```
/new turo              created session turo (fable); it is now current …
open my turo inbox     ⏳ [turo] working on it   → edited to ⏳ [turo] thinking · 30s → ✅ [turo] done in 52s
                       [turo] Three unread messages: …
/new mail haiku        a second session, on a cheaper model
@turo reply to Ann     one message to turo without switching
/use mail              plain text now goes to mail
/sessions              * mail (haiku, 0 turns, active, never) / turo (fable, 2 turns, active, 3m ago)
```

| Command | Does |
|---|---|
| `/new <name> [opus\|fable\|haiku]` | create a session (default model fable) and make it current |
| `/sessions` | list your sessions; `*` marks the current one |
| `/use <name>` / `/use agent` | where plain text goes: a session, or the one-shot agent |
| `/pause [name]` | stop that session's running turn, drop its queued turns, refuse new ones until `/resume` |
| `/resume <name>` | make it active again (the target does not change) |
| `/stop [name]` | pause and forget the session; if it was current, plain text goes to the agent again |
| `/stop all` | pause every session you have, cancel your running task, drop your queued ones |
| `@<name> <text>` | one message to that session; `@@` at the start sends a literal `@` to the current target |
| `/retry` | re-send your last message to the target it went to (refused if that session is paused or gone) |

Names are 1–24 characters of `a-z 0-9 _ -`, up to 10 live sessions per sender;
sessions belong to the sender who made them and are never shared.

### One bot per job

If you would rather have `@my_turo_bot` *be* the turo conversation, bind a bot
to a session in `channels.json`:

```json
{
  "telegram": {
    "bots": [
      { "accountId": "default", "token": "123:AA…" },
      { "accountId": "turo",   "token": "456:BB…", "session": "turo" },
      { "accountId": "mail",   "token": "789:CC…", "session": "mail", "model": "haiku" }
    ]
  }
}
```

On a bound bot every plain message (even one starting with `@`) goes to that one
conversation, which is created on your first message; replies are labelled as
usual. `/pause`, `/resume`, `/stop` (start the conversation over), `/sessions`,
`/retry`, `/cancel`, `/status`, `/journal`, `/help` work; `/new`, `/use` and
`/stop all` are refused with a one-line explanation, and `@name` is not parsed
there (text starting with `@` is sent as written). Where pairing is required it
is per bot (the code message says which conversation the bot is), so a sender
paired on one bot has nothing on another until paired there; an `allowFrom` or
`open` policy inherited from the channel authorises a sender on every bot. The session model
is `fable` unless the bot sets `"model"`; a row created earlier under the same
name on another model is refused until you `/stop` it. The general bot (no
`session`) keeps the full session commands.

**Approvals in a session.** The intent gate sees the conversation: a bare
"continue" or "do it" is classified together with your previous messages, so
it inherits the risk of what it continues. Inside a turn the agent stops before
any irreversible action it was not told to take and ends its reply with
`NEEDS APPROVAL: <what>` (the marker counts only as the last line); you get
**Approve / Cancel**, and on approval the same conversation continues with that
one action authorised. An approval is spent by the turn it was given to; what
you declined is carried into later turns as explicitly *not* authorised, and
instructions found in pages are told to be data. At most three approval rounds
per message; a fourth stops the turn.

**Labels.** Every message from a session starts with `[name]` (`[turo] …`,
`⏳ [turo] working on it`, `… [turo] thinking`, `❌ [turo] error — …`), so two
sessions interleaved in one chat stay readable.

**Files.** A session has one directory,
`~/.ai-browser-bridge/sessions/<id>/`, which is the working directory of every
turn. Files a turn saves there are sent after the reply; anything that could not
be delivered (too large, send failed) is moved to `leftover/<runId>/` inside it
and reported once. A file that Claude would read back as instructions
(`CLAUDE.md`, `.mcp.json`, `.claude/…`, dotfiles) cannot be written by a
restricted run and, if one appears anyway, is quarantined and the turn refused.
Directories are kept after `/stop`; delete them yourself when you no longer
want the files.

**How much a session remembers.** The conversation is Claude Code's own
transcript: Claude keeps transcripts for about 30 days (`cleanupPeriodDays`)
and compacts long ones into a summary, so very old detail fades. If the
transcript is gone, the next turn fails closed — `❌ [turo] this session's
conversation is no longer available … /stop turo and /new turo to start over` —
rather than silently starting a fresh conversation under the old name.

`/journal` reports session turns on their own line (`session turns: N, $X`);
they never count toward the pass rate of judged runs or toward recipe learning.

**Restarts.** After a daemon restart, a session turn that was running is
stopped (the daemon remembers the child's pid and start time, verifies both,
and kills its process group) and reported as not replayed; queued session
messages then run normally. In the rare case the old turn cannot be confirmed
dead, the daemon keeps that item, tells you, drops your queued session messages
for this daemon run, and holds your session turns until the next restart (your
one-shot tasks still run). One-shot (`bridge agent`) runs that were in flight
are *not* tracked this way: their children are not killed on restart, as before.
`/pause`, `/stop`, `/stop all` and `/cancel` are accepted even while you are
rate limited.

## Approvals: before, not after

Three gates ask for a tap (**Approve** / **Cancel**) — or, where the messenger
has no buttons, a `/approve <id> yes` reply — before anything irreversible happens:

1. **Intent.** A task that looks like it will send, submit, pay, book, delete,
   reply, publish … is quoted back and must be approved before the agent starts.
   The keyword list is configurable (`"intentKeywords": [...]` per channel); when
   no keyword matches, a cheap model classifies, and anything unclear counts as
   a write.
2. **Recipe.** A learned recipe whose effective risk is `write` asks every time,
   in audit and economy mode alike.
3. **Stop-before-send.** The agent is told to stop before any irreversible action
   the task did not already name and report `NEEDS APPROVAL: <what>`; you are
   asked, and on approval the same step is retried with the answer.

Only the person who started the task can approve it. Approvals are single use
and expire after 10 minutes; declined, expired, cancelled and daemon restarts
all mean **stopped**, never "fall back and do it anyway". The ops playbook's
hard rule against clicking Pay / Submit Payment is unchanged.

## Files

Each run gets its own outbox directory as its working directory. Anything the
agent saves there — `pdf --out`, `screenshot --out`, or a same-origin fetch
with `eval … --out` — is sent to you after the run (10 files, 45 MB each,
100 MB total; symlinks and non-regular files are skipped and reported).
Chrome's own download manager (`download`) writes to `~/Downloads` and is not
delivered. Inbound attachments are ignored in this version.

## Restricted runs

A task that arrives over a messenger runs with less authority than one you
type in the terminal:

- The model may call **browser commands only** (`ping status listTabs newTab
  navigate eval click type insertText key waitFor scroll snapshot screenshot pdf
  selectTab closeTab detach`). `agent`, `jobs`, `recipe`, `journal`, `pairing`,
  `channels`, `claude-md`, `download`, `activateTab`, `detachAll` are not
  reachable, so text in a message cannot change the bridge's configuration.
- The **Codex rung is off** (it has no per-command tool allowlist). Set
  `"codex": true` on the channel to re-enable it.
- Child processes get a **scrubbed environment**: `PATH HOME USER LANG TMPDIR
  BRIDGE_PORT`, the run's `AI_BRIDGE_*` metadata, and the model's own
  credentials (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `CODEX_HOME`,
  `OPENAI_API_KEY`) so `claude -p` can start on a server. Anything else you
  need (a proxy, say) goes in `"envPassthrough": ["HTTPS_PROXY"]` per channel.
  Messenger tokens never reach a model, a recipe step or a login hook, and are
  redacted from logs, errors and delivered evidence.
- A **second fence at the CLI**: with `AI_BRIDGE_RESTRICTED=1` (set for every
  child of a channel run) the bridge CLI itself refuses the admin subcommands
  and confines `--out` / `--file` to the run's outbox directory, symlinks
  included, and refuses names Claude would read back as instructions or
  configuration (`CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `settings*.json`,
  anything under `.claude/`, dotfiles). Even a model that talked its way past
  the tool allowlist cannot write `pairing.json`, plant instructions for its
  next turn, or read your files through the bridge.
- Model runs may call **no built-in tool other than Bash** (no Read, Write,
  Glob, WebFetch…), whatever your `settings.json` allows elsewhere.
- Channel runs **never learn or repair recipes**; recipes stay something you grow
  from the terminal. They may run existing recipes.

## Access control

`channels.json` per channel:

```json
{
  "telegram": {
    "token": "123:ABC",
    "dmPolicy": "pairing",
    "allowFrom": ["123456789"],
    "codex": false,
    "intentKeywords": ["send", "pay", "..."],
    "envPassthrough": ["HTTPS_PROXY"]
  }
}
```

| `dmPolicy` | known (`allowFrom`) | paired | unknown |
|---|---|---|---|
| `pairing` (default) | run | run | one pairing code, then silence |
| `allowlist` | run | drop | drop |
| `open` (needs `"*"` in `allowFrom`) | run | run | run |
| `disabled` | drop | drop | drop |

Several bots under one channel: put them in `"bots": [...]`, each with a unique
`accountId` (`[a-z0-9_-]{1,24}`; one may be `default`), its own `token`, and
optional per-bot overrides of the channel-level keys (`dmPolicy`, `allowFrom`,
`codex`, `intentKeywords`, `envPassthrough`, `apiBase`). Tokens may come from
the environment instead: `AI_BRIDGE_TELEGRAM_TOKEN` for the `default` bot (or
the lone bot of the one-bot form) and `AI_BRIDGE_TELEGRAM_<ACCOUNTID>_TOKEN`
(upper-cased, other characters → `_`) for the rest; the account-specific key
wins when both are set. Two bots with the same token, or two account ids that
map to the same environment key, are refused at start. Bot tokens are never
passed to child processes, even if listed in `envPassthrough`.

Identity is the messenger's stable id (Telegram numeric user id) **per bot**:
pairing, sessions and queue limits are keyed by `channel:accountId:senderId`.
Paired senders are owner-equivalent: `/jobs` and `/journal` show everything
(the journal is one aggregate across all bots and channels). `/status` shows the
current run's text only to the sender who queued it. Pending pairing codes expire
after an hour; `bridge pairing list` shows them with the bot they belong to
(`telegram/turo`), `bridge pairing revoke telegram <id>` removes an approved
sender from **every** bot of that channel.

Rate limits: 20 messages per paired sender per minute, 200 overall, 5 per
minute from unknown senders, 8 KB per message.

State lives under `~/.ai-browser-bridge/`: `channels.json` (config),
`pairing.json`, `channels-state.json` (dedup, offsets, queue),
`channels-sessions.json` (sessions, current targets, last messages),
`sessions/<id>/` (a session's working directory), `outbox/<runId>/`,
`channels.log` (rotated at 10 MB, tokens redacted). Journal records from
channel runs carry `source: "channel:telegram"`; session turns add
`mode: "session"` and the session's name and id.

## Two machines: daemon on a server, Chrome on the laptop

The daemon must run where **Claude Code is logged in**; the relay (`server.js`)
and Chrome live where the browser is. To put the daemon on an always-on server:

```bash
# on the server — forward the laptop's relay port to localhost
ssh -N -L 8765:127.0.0.1:8765 you@laptop        # or use Tailscale and set BRIDGE_PORT accordingly
scp you@laptop:~/.ai-browser-bridge/token ~/.ai-browser-bridge/token
bridge channels start
```

The CLI on the server connects to `127.0.0.1:8765`, which is now the tunnel.
Claude Code on the server authenticates either through `claude login` run as
the daemon's user or through `CLAUDE_CODE_OAUTH_TOKEN` in the daemon's
environment (the systemd template shows where); both survive the scrubbed
child environment.
Screenshots and PDFs still land in the server-side outbox, so delivery works
unchanged. A built-in reverse connection is on the roadmap.

## Troubleshooting

- **`another channels daemon is running (pid N)`** — a second daemon would make
  Telegram return `409 Conflict` on `getUpdates`. Stop the first one or remove
  `~/.ai-browser-bridge/channels.lock` if the pid is dead.
- **No reply at all** — `bridge channels status`, then check `channels.log`.
  An unpaired sender gets one code per hour; check `bridge pairing list`.
- **`channels.json is group/world readable`** — `chmod 600` it.
- **`bridge down`** on `/ping` — start the relay (`npm start`) and reload the
  extension.
- **Tasks always ask for approval** — a keyword matched; narrow `intentKeywords`
  or rephrase ("show", "read", "list").
- **`[turo] this session's conversation is no longer available`** — Claude's
  transcript for that session expired or was removed; `/stop turo`, then
  `/new turo`. The daemon never substitutes another conversation.
- **`session turo is paused`** — `/resume turo`, or `/use agent` to send
  one-shot tasks meanwhile.
- **`this bot is bound to session turo: …`** — that bot is one conversation;
  use the general bot for `/new`, `/use` and `@name`.
- **`same token for accounts "a" and "b"` / `env keys collide`** — two
  entries in `bots` resolve to one credential or one environment key; fix the
  `accountId`s or tokens. **`model needs a session`** — `model` only makes
  sense on a bound bot.
- **`channels-sessions.json is corrupt`** at start — the daemon refuses to run
  with a damaged sessions file rather than forget your sessions; fix the JSON or
  move the file aside.
