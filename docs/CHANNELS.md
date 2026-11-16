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

Keep it running with `deploy/launchd/com.ai-bridge.channels.plist` (macOS) or
`deploy/systemd/ai-bridge-channels.service` (Linux); both templates explain the
two paths to replace.

## What you can send

Plain text is a task. The daemon replies `⏳ working on it (run abc123)` (or a
queue position), sends progress lines at most every 15 s, then:

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
  included. Even a model that talked its way past the tool allowlist cannot
  write `pairing.json` or read your files through the bridge.
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

Identity is the messenger's stable id (Telegram numeric user id), never a
display name. Paired senders are owner-equivalent: `/jobs` and `/journal` show
everything. Pending pairing codes expire after an hour; `bridge pairing list`
shows them, `bridge pairing revoke telegram <id>` removes an approved sender.

Rate limits: 20 messages per paired sender per minute, 200 overall, 5 per
minute from unknown senders, 8 KB per message.

State lives under `~/.ai-browser-bridge/`: `channels.json` (config),
`pairing.json`, `channels-state.json` (dedup, offsets, queue),
`outbox/<runId>/`, `channels.log` (rotated at 10 MB, tokens redacted). Journal
records from channel runs carry `source: "channel:telegram"`.

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
