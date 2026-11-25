# AI Browser Bridge

A minimal, open-source bridge that lets an **AI coding agent** (Claude Code, or any local
tool that can run a shell command) drive **your real, logged-in browser** — safely, on
localhost, with no cloud in the loop.

Born from a practical problem: an AI agent working in a terminal needed to download email
attachments, fill review forms, and drive web editors on sites the user was logged into.
OS-level input synthesis is platform-bound, steals window focus, and its
synthetic events are rejected by CSP-strict web apps and rich-text editors. This bridge
fixes all of that with three small pieces:

```
AI agent / your scripts          bridge server               Chrome extension
   `bridge <cmd>` CLI  ⇄  ws://127.0.0.1:8765 (token)  ⇄  service worker (MV3)
                                                             │ chrome.tabs / scripting
                                                             │ chrome.debugger  → trusted input, CSP-proof eval
                                                             │ chrome.downloads → authenticated downloads
```

## Why the `chrome.debugger` route matters

- **Trusted input.** `Input.dispatchMouseEvent` / `Input.insertText` produce events with
  `isTrusted: true` — rich editors (contenteditable, ProseMirror- and Slate-class apps) accept
  them where synthetic DOM events are ignored.
- **CSP-proof eval.** `Runtime.evaluate` works on pages whose Content-Security-Policy
  blocks injected `eval`.
- **No focus stealing.** Everything runs in background tabs (`newTab` opens with
  `active:false`); your work is never interrupted.
- **Your sessions, no re-login.** The extension lives in your normal profile, so webmail,
  dashboards, internal tools — anything you're logged into — just work. This also sidesteps
  Chrome 136+'s restriction on `--remote-debugging-port` with the default profile.
- **Cross-platform.** macOS, Windows, Linux — no OS-level input scripting or
  accessibility APIs required.

## Direct mode by default, debugger on approval

By default every command runs in **direct mode**: the extension drives the tab with
ordinary extension APIs and *never* attaches `chrome.debugger`, so there is no
DevTools session and no "… is debugging this browser" banner. `eval` runs through
`chrome.userScripts.execute()` in the page's MAIN world — Chrome's documented API
for user-supplied code (enable it once with **Allow User Scripts** on the extension
card, see [Install](#install)); `click`/`type`/`insertText`/`key` are emulated with
synthetic DOM events. Direct mode is lighter and is enough for most reading,
scraping and form work — at the cost of untrusted events (`isTrusted: false`) and
active-tab-only screenshots.

When you need the `chrome.debugger` route — trusted input for rich-text editors,
`pdf`, or background-tab screenshots — request it per command with **`--debugger`**.
Because attaching the debugger shows the browser banner, it requires **approval**,
resolved in this order:

1. `--debugger` flag on the call — pre-approved (works headless).
2. `AI_BRIDGE_DEBUGGER=1` in the environment — pre-approved (works headless).
3. Otherwise, if stdin is a TTY — an interactive `y/N` prompt.
4. Needed but not approved and no TTY — the command **fails fast** (exit 5)
   rather than silently attaching or hanging.

`pdf` and background-tab `screenshot` are CDP-only, so they always need approval.
(`--stealth` and `--no-stealth` from releases before 0.1.10 are still accepted as
aliases of the default and of `--debugger`.)

## Install

Short version (full first-time walkthrough with troubleshooting, background
service templates and Windows notes: **[docs/INSTALL.md](docs/INSTALL.md)**).
On a Mac, the easiest path is the **menu-bar app**: download the `.dmg` from the
[releases](https://github.com/legisus/ai-bridge/releases), drag to Applications,
open — it registers the native host, starts the server and guides you through
adding the extension ([details](docs/INSTALL.md#macos-app)). No Node.js? The
single-file `ai-bridge` binary (server, native host and CLI in one executable) is
on the same page: [Binary install](docs/INSTALL.md#binary-install-no-nodejs).

1. **Server** (Node ≥ 18):
   ```bash
   git clone https://github.com/legisus/ai-bridge.git && cd ai-bridge
   npm install
   npm start          # generates ~/.ai-browser-bridge/token on first run (chmod 600)
   ```
2. **Extension:** open `chrome://extensions` → enable *Developer mode* → *Load unpacked* →
   select the `extension/` folder.
3. **Provision:** `npm run register-host` registers a [native messaging host](docs/INSTALL.md#3-register-the-native-host)
   so Chrome can start the server and fetch the token by itself — then reload the
   extension and click *Details* → turn on **Allow User Scripts** (needed by `eval`
   in direct mode; Chrome 138+). No native host? Paste the token from
   `~/.ai-browser-bridge/token` into *Extension options* instead.
4. **Smoke test:**
   ```bash
   node server/cli.js ping
   # {"pong":true,"version":"0.1.10"}
   ```
   `connect failed` = server not running; `extension not connected` = token not saved
   or wrong — re-save Options, wait 30 s, retry.
5. **Keep it running:** not needed with the native host — Chrome starts the server
   on demand. Otherwise copy a template from `deploy/`, fix the paths, load it.

## Usage

```bash
bridge() { node /path/to/ai-bridge/server/cli.js "$@"; }

bridge listTabs
bridge newTab   '{"url":"https://example.com"}'               # opens in background
bridge newTab   '{"url":"https://example.com","newWindow":true}'  # own unfocused window (isolates activateTab)
bridge eval     '{"tabId":123,"code":"document.title"}'
bridge eval     '{"tabId":123}' --file scrape.js              # long scripts from a file
bridge click    '{"tabId":123,"x":420,"y":310}'               # trusted click at CSS px
bridge click    '{"tabId":123,"selector":".submit-btn"}'      # …or click an element by selector (no pixel math)
bridge insertText '{"tabId":123,"text":"Hello"}'              # trusted "paste" at caret
bridge type     '{"tabId":123,"text":"hello"}'                # real per-char keystrokes (autocomplete/React widgets)
bridge key      '{"tabId":123,"key":"Enter"}'
bridge key      '{"tabId":123,"key":"v","modifiers":4,"commands":["paste"]}'  # native paste from the clipboard
bridge waitFor  '{"tabId":123,"selector":"#results"}'         # poll until an element appears
bridge waitFor  '{"tabId":123,"code":"document.readyState==='"'"'complete'"'"'"}'  # …or a JS condition
bridge scroll   '{"tabId":123,"bottom":true}'                 # also: {selector}, {top}, {dx,dy}
bridge download '{"url":"https://.../file.pdf","filename":"file.pdf"}'   # uses your cookies
bridge pdf      '{"tabId":123}' --out page.pdf
bridge screenshot '{"tabId":123}' --out page.png
bridge selectTab '{"tabId":123}'                              # activate tab, don't focus its window
bridge activateTab '{"tabId":123}'                            # activate tab AND bring its window to front
bridge status                                                 # version + which tabs are attached
bridge closeTab '{"tabId":123}'
bridge detach   '{"tabId":123}'                               # release debugger + clear the tab indicator
bridge detachAll                                              # release every attached tab in one call
bridge reloadExtension                                        # reload the extension after a git pull (no chrome://extensions visit)
bridge tabs                                                   # tabs the bridge opened: age, who opened them, run id, origin
bridge closeTabs --mine                                       # close the ones this client opened (also --run <id>, --older-than <minutes>)
bridge agent "task" --keep-tabs                               # leave the run's tabs open instead of closing them at the end
```

Every failure prints `ERROR: <reason> (req <id>)`; the same id is on the server's
log lines and in the run's trace, so one id leads from a failed shell call to what
the relay and the extension did with it.

For an AI agent, the contract is simple: every command is one shell invocation that
prints JSON to stdout and exits non-zero on failure.

## Agent mode — hand it a whole task

Instead of driving the bridge command-by-command, you can hand it a complete task
and let the built-in **token-saver agent** do the driving:

```bash
bridge agent "open https://example.com and report the page title and first heading"
bridge agent "…" --timeout 600000 --verbose
```

It spawns headless Claude Code sessions (`claude -p`) and walks an escalation
ladder: a cheap model attempts the task first, a strong model judges the evidence,
and only on failure does a stronger model retry —

```
ops: Opus 5.5       → judge (Fable 5.1) → pass? done
ops: Fable 5.1      → judge (Fable 5.1) → pass? done
ops: Codex Astra 6  → judge (Fable 5.1) → final verdict   (needs the `codex` CLI; skipped with an error otherwise)
```

The judge only ever sees the task plus the ops session's short evidence report —
never the full browsing transcript — so the expensive model's token spend stays
minimal. The command prints the verdict, the evidence report, and a per-stage
token/cost summary, and exits 0 only on a pass.

Requirements & notes:

- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code) must be
  installed and logged in** — usage bills to your existing Claude subscription.
- The agent pings the bridge before spending any model tokens, and fails fast if
  the server or extension is down.
- Give it a complete, self-contained task description: URLs, credentials context
  ("I'm already logged in"), and what "done" looks like.
- Default timeout is 10 minutes per stage (`--timeout` is in ms).
- The ops sessions are confined to bridge CLI calls (`--allowedTools`), and a
  recursion guard stops them from invoking `bridge agent` themselves.
- Tag recurring jobs with `--job <name>` (e.g. from cron or a bot) so the journal
  can group them.

### Economy mode: journal, recipes, audit → economy

Every agent run is journaled, and every bridge command it issues is traced, so
you can see which jobs repeat and what they cost — the first step towards
replaying repeated jobs as token-free recipes (see
[docs/ECONOMY-MODE.md](docs/ECONOMY-MODE.md)):

```bash
bridge agent "…" --job toll-invoices     # tag the run; AI_BRIDGE_RUN_ID/AI_BRIDGE_JOB flow to the ops models
bridge journal                           # runs grouped by job, pass rate, $, tokens; * = economy candidate
bridge journal --days 7 --job kbb --json
bridge journal --trace <runId>           # every bridge command of one run (cmd, params, ok, ms)
bridge snapshot '{"tabId":123}'          # DOM digest: text + interactive elements with CSS selectors
```

Files live under `~/.ai-browser-bridge/`: `journal.jsonl` (one line per run) and
`traces/<runId>.jsonl` (one line per command; screenshot pixels are omitted, long
results previewed). `snapshot` replaces most screenshots in the ops playbook: a
few KB of labelled elements with selectors you can pass straight to
`click {"selector"}` / `waitFor`, instead of an image the model has to guess at.

**The bridge decides on its own.** You keep calling `bridge agent "task"`; it
works out whether this is a job it already knows and which mode to run it in:

1. **Recognise.** The task text is matched to known jobs (shared hostname plus
   word overlap; a cheap Haiku call settles borderline cases). `--job <name>`
   forces a job, `--job none` or `--no-auto` opts out.
2. **Learn.** The third passing model run of the same task (same sites, same
   wording pattern) triggers one Opus call that turns the three traces into a
   **recipe** — a deterministic replay with assertions. A job is created
   (`auto-<site>-<hash>`, or your `--job` name) and goes to *audit*.
3. **Audit → economy.** In audit the recipe runs and the judge verifies its
   evidence (judge tokens only). Three passes on a read-only job switch it to
   *economy*: recipe only, no model. A new wording of a known job is verified
   once, then it is free too. Every 5th economy run is a judge canary.
4. **Fall back and repair.** A failing recipe step (selector gone, login page)
   or a judge rejection falls back to the model ladder so the task still
   completes; the recipe is repaired from that run's trace and the job returns
   to audit. If a heuristic match was wrong, the judge catches it on the first
   run and the task runs as a one-off with no penalty to the job.

```bash
bridge agent "pull my Toll Roads transactions for the last 7 days as JSON"   # that's all
bridge jobs                               # mode / risk / audit progress per job (* = auto-created)
bridge recipe show|run <job>              # inspect or replay a recipe by hand
bridge recipe propose <job>               # learn now instead of waiting for 3 passes
```

Expired sessions are handled without models: give a job a login hook
(`bridge jobs set <job> --login-cmd "…"`) and the bridge re-authenticates and
replays the recipe; without one, a `LOGIN REQUIRED` run fails fast instead of
escalating through the ladder.

Jobs whose recipes write to the outside world (`risk: write`) stay in audit —
recipe plus judge every time — unless you allow economy with
`bridge jobs set <job> --risk read`. Details: [docs/ECONOMY-MODE.md](docs/ECONOMY-MODE.md).

## Messenger channels — text it a task

`bridge channels start` connects your messengers to the bridge (Telegram
first; Slack, Discord, Mattermost, Matrix, WhatsApp, iMessage, Teams, Google
Chat and Signal follow). You text a task from your phone; it runs through
`bridge agent` in your own logged-in Chrome on your own machine, and the
verdict, evidence and any files come back in the chat.

```bash
echo '{ "telegram": { "token": "123456789:AA…" } }' > ~/.ai-browser-bridge/channels.json
chmod 600 ~/.ai-browser-bridge/channels.json
bridge channels start
# message your bot → it replies with a pairing code → approve it from the terminal:
bridge pairing approve telegram X7K2PQ
```

What makes this different from a cloud "personal agent": nobody holds a copy
of your passwords, the agent acts in the browser you are already signed into,
and risky steps ask for a tap **before** they happen — a task that looks like
it will send, pay, book or delete is quoted back for approval, write-risk
recipes ask every time, and the agent stops with `NEEDS APPROVAL` before any
irreversible action it was not told to take. Messenger-originated runs are
**restricted**: browser commands only, no admin subcommands, no Codex rung, a
scrubbed child environment, no recipe learning. Unknown senders get a pairing
code and nothing else. `/new turo` opens a **session**: a named conversation
that remembers your earlier messages, with `/use`, `/pause`, `/resume`,
`/stop [name|all]` and `@turo …` to keep several jobs going and switch between
them from one chat (turns still run one at a time), or bind one bot per job
(`"bots": [{ "accountId": "turo", "token": "…", "session": "turo" }]`) so that
each bot's chat simply *is* that conversation. Details, the two-machine (server + laptop) recipe, and troubleshooting:
**[docs/CHANNELS.md](docs/CHANNELS.md)**.

## Concurrency

The server is a many-CLI → single-extension relay. Any number of CLI clients can
connect at once; each request carries a random id and its response is routed back to
the CLI that sent it, so concurrent clients never cross wires.

The scaling axis is **tabs, not throughput** — everything funnels through one browser
and one extension. The rule that keeps concurrency safe:

- **One CLI per tab.** Driving N *different* tabs from N parallel CLI calls works
  cleanly — each tab attaches its own debugger session independently.
- **Don't point two clients at the same tab.** Concurrent trusted input (`click`,
  `insertText`, `key`) on one tab interleaves into garbage, and — before v0.1.2 —
  simultaneous *first* commands on a not-yet-attached tab could race the debugger
  attach (`Another debugger is already attached`). v0.1.2 dedupes that attach, but
  same-tab writes are still logically single-writer: serialize them.

## Use from Claude Code

One command writes the `CLAUDE.md` block that teaches Claude Code every command,
with this machine's CLI path filled in (no pasting):

```bash
npm run claude-md            # appends to ~/.claude/CLAUDE.md — or: node server/cli.js claude-md
node server/cli.js claude-md --project   # ./CLAUDE.md of the current project only
node server/cli.js claude-md --print     # just show the block
```

See **[docs/CLAUDE-CODE.md](docs/CLAUDE-CODE.md)** for the block itself, plus
permission and troubleshooting notes. Once added, you can ask things like *"open the dashboard tab and screenshot
the error"* and the agent composes the CLI calls itself.

## Security model

Full policy: [PRIVACY.md](PRIVACY.md). Read this before installing — the extension can act as *you* on any site you're logged into.

- The server binds **127.0.0.1 only**; nothing is reachable from the network.
- Every client must present the **token** from `~/.ai-browser-bridge/token`
  (created `chmod 600`). Without it, sockets are dropped.
- Optional **host allowlist** (extension Options): restrict commands to named domains
  and their subdomains. Empty list = allow all — set it if you want defense in depth.
- Every command is **logged** to `~/.ai-browser-bridge/bridge.log` with its request
  id, the client label and the run id, and ends in exactly one `done` / `refused` /
  `cancelled` line.
- The relay keeps a **registry of the tabs it opened** (`~/.ai-browser-bridge/tabs.json`:
  tab id, Chrome session, who, when, which run, origin only — never page content or
  full URLs). An agent run's tabs are closed when the run ends or its process dies;
  only tabs the extension itself opened can ever be closed this way, and never a
  whole window.
- Commands run in **direct mode by default** (no debugger, no banner). The
  `chrome.debugger` route is opt-in via `--debugger` and gated behind approval —
  see [Direct mode by default, debugger on approval](#direct-mode-by-default-debugger-on-approval).
- Chrome shows its native **"… is debugging this browser"** banner whenever the
  debugger is attached — so whenever you *do* approve `--debugger`, you always see
  that trusted-input mode is active. Clear it with `detach` (one tab) or
  `detachAll` (every attached tab). Idle tabs also auto-detach after `idleDetachMs`
  (default 2 min; set in Options), so banners never pile up. (The banner is
  browser-enforced and can't be hidden from an extension; that's the point.)
- **Per-tab activity indicator** (on by default, toggle in Options): a thin neon
  frame with colors flowing around the page edge, plus a small color-shifting glow
  badge on the tab's favicon, mark exactly which tabs the agent is driving —
  finer-grained than the global banner. The original favicon is restored and the
  frame removed on `detach`.
- No analytics, no telemetry, no external requests of any kind.

## Test

```bash
npm test    # spins up the server, a simulated extension, and the real CLI; asserts round-trips
```

## Project layout

```
extension/    Manifest V3 extension (service worker + options page)
server/       relay server (server.js), CLI client (cli.js), token-saver agent (agent.js),
              channels/ = messenger daemon (main.js), manager, policy, pairing, approvals,
              state, outbox, restricted-run helpers, intent gate, telegram adapter,
              run journal + command traces (journal.js), DOM digest (snapshot.js),
              recipes + runner (recipe.js, recipe-cli.js), per-job economy state (jobs.js),
              native messaging host (native-host.js) + its registrar (register-native-host.js),
              main.js = dispatcher for the single-executable build
scripts/      build-sea.js — Node SEA build of the `ai-bridge` binary (npm run build:sea)
macos/        menu-bar app (Swift/AppKit) + build-app.sh → .app and .dmg (npm run build:mac)
deploy/       launchd / systemd templates for the relay server and the channels daemon
docs/         INSTALL.md (first-time setup), CLAUDE-CODE.md (Claude Code integration), CHANNELS.md (messengers)
test/         protocol round-trip, agent ladder, native-host and binary tests
```

## Contributing

Improvements welcome — new CDP-backed commands, a Firefox port, reliability fixes.
See **[CONTRIBUTING.md](CONTRIBUTING.md)** for dev setup, the two-layer test
suite, and the security ground rules every PR must preserve.

## License

MIT © 2026 [Mykola Bielousov](https://scholar.google.com/citations?user=dOwVd0sAAAAJ)
