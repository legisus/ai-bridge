# Installing AI Browser Bridge (first time)

This guide takes you from nothing to a working `ping` in about ten minutes. It
assumes no prior knowledge of the project. Read the
[security model](../README.md#security-model) first: once installed, the
extension can act as *you* on any site you are logged into.

## 0. Prerequisites

- **Node.js 18 or newer** and **git**. Check with `node -v`.
- **Google Chrome** or another Chromium browser (Edge, Brave, Arc) on the same
  machine as the server. The server never leaves `127.0.0.1`.
- **Claude Code**, installed and logged in, *only* if you want `bridge agent`
  mode. Plain commands do not need it.

## 1. Get the code

```bash
git clone https://github.com/legisus/ai-bridge.git
cd ai-bridge
npm install          # single dependency: ws
```

## 2. Start the server once by hand

```bash
npm start
```

The first run prints two lines:

```
[bridge] token generated at ~/.ai-browser-bridge/token — paste it into the extension's Options page
[bridge] listening on ws://127.0.0.1:8765
```

Leave this terminal open for now; step 7 turns it into a background service.

## 3. Copy the token

```bash
cat ~/.ai-browser-bridge/token
```

On Windows the file is `%USERPROFILE%\.ai-browser-bridge\token`. The file is
created with mode `600`; treat it like a password.

## 4. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the `extension/` folder inside your clone.
4. A card named **AI Browser Bridge** appears.

Chrome loads the extension from that folder on every start, so do not move,
rename or delete the clone afterwards. `git pull` updates it in place; press the
reload icon on the card after pulling.

## 5. Provision the extension

1. On the card click **Details**, then **Extension options** (or right-click the
   extension icon in the toolbar and choose *Options*).
2. Paste the token into **Auth token**. Leave **Server port** at `8765` unless
   you changed `BRIDGE_PORT` on the server.
3. Optionally fill the **Host allowlist**, one domain per line. Commands then run
   only on those domains and their subdomains. Empty means any site.
4. Click **Save**. The extension connects immediately and, after that, retries
   every ~24 seconds on its own.

## 6. Smoke test

```bash
node server/cli.js ping
# {"pong":true,"version":"0.1.9"}
```

If you get an error instead:

| Error | Meaning | Fix |
|---|---|---|
| `connect failed` | The server is not running. | Go back to step 2. |
| `extension not connected` | Token not saved, wrong, or the service worker is asleep. | Re-check Options and press *Save*, wait 30 s, retry. Still failing: press the reload icon on the extension card. |
| `ENOENT … token` | The CLI cannot find the token file. | Run the server once (step 2) on this machine. |

## 7. Keep the server running

Run the server as a background service so it survives reboots and closed
terminals. Templates live in `deploy/`; replace the placeholder paths first.

**macOS (launchd)**

```bash
which node                                    # put this path into the plist
cp deploy/launchd/com.ai-bridge.server.plist ~/Library/LaunchAgents/
# edit ~/Library/LaunchAgents/com.ai-bridge.server.plist: fix the node and clone paths
launchctl load ~/Library/LaunchAgents/com.ai-bridge.server.plist
node server/cli.js ping                       # should answer again
```

To stop it: `launchctl unload ~/Library/LaunchAgents/com.ai-bridge.server.plist`.

**Linux (systemd user unit)**

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/ai-bridge.service ~/.config/systemd/user/
# edit the unit: fix the node and clone paths
systemctl --user daemon-reload
systemctl --user enable --now ai-bridge
```

**Windows**

Create a Task Scheduler task that runs at logon:
`node C:\path\to\ai-bridge\server\server.js`. Tick *Run whether user is logged
on or not* only if you understand it hides the console.

## 8. Shorten the command (optional)

```bash
alias bridge='node /ABSOLUTE/PATH/ai-bridge/server/cli.js'
```

Add that line to `~/.zshrc` or `~/.bashrc`, then `bridge ping`.

## 9. Teach Claude Code (optional)

1. Copy the *Browser control* block from [CLAUDE-CODE.md](CLAUDE-CODE.md) into
   `~/.claude/CLAUDE.md` (everywhere) or a project's `CLAUDE.md`. Replace
   `/path/to/ai-bridge` with your real clone path.
2. To skip a permission prompt on every call, add the CLI to the allow list in
   `~/.claude/settings.json`:
   ```json
   { "permissions": { "allow": [ "Bash(node /ABSOLUTE/PATH/ai-bridge/server/cli.js *)" ] } }
   ```
   Do this only if you have set a host allowlist in step 5, or accept that the
   agent may act on any site without asking.
3. Verify agent mode end to end:
   ```bash
   bridge agent "open https://example.com and report the page title"
   ```
   It prints a verdict, an evidence report and a token summary, and exits 0 on
   pass. `claude CLI not found` means Claude Code is not on your `PATH`.

## 10. Before daily use

- Set the **host allowlist** unless you really want the agent on every site.
- Every command is appended to `~/.ai-browser-bridge/bridge.log`.
- Commands run in stealth mode by default. `--debugger` is opt-in per call and
  makes Chrome show its *"… is debugging this browser"* banner, so you always
  know when trusted-input mode is active. `bridge detachAll` clears it.
- The extension icon shows an animated frame around tabs the agent is driving.
  Turn it off in Options if you prefer.

## Updating

```bash
cd /ABSOLUTE/PATH/ai-bridge
git pull
npm install
# restart the server (launchctl unload/load, systemctl --user restart ai-bridge, or Ctrl-C + npm start)
# then press the reload icon on the extension card in chrome://extensions
node server/cli.js ping
```

## Uninstalling

1. Remove the extension from `chrome://extensions`.
2. Stop and remove the service (launchd: `launchctl unload …` and delete the
   plist; systemd: `systemctl --user disable --now ai-bridge`).
3. Delete `~/.ai-browser-bridge/` (token and log) and the clone.
