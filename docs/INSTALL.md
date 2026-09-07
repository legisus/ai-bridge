# Installing AI Browser Bridge (first time)

This guide takes you from nothing to a working `ping` in about ten minutes. It
assumes no prior knowledge of the project. Read the
[security model](../README.md#security-model) first: once installed, the
extension can act as *you* on any site you are logged into.

## Three ways to install

- **macOS app (easiest)** — download `AI-Browser-Bridge-<version>-arm64.dmg`
  from the [latest release](https://github.com/legisus/ai-bridge/releases/latest),
  drag the app to Applications, open it. A menu-bar icon appears; it registers
  the native host, starts the server, and its **Add to Chrome…** item walks you
  through the extension. See [macOS app](#macos-app) at the end of this guide.
- **Binary (no Node.js needed)** — one file, `ai-bridge`, that contains the
  server, the native host and the CLI. See [Binary install](#binary-install-no-nodejs)
  at the end of this guide. Attached to each
  [release](https://github.com/legisus/ai-bridge/releases) for macOS Apple
  Silicon; other platforms are built from source with `npm run build:sea`.
- **From source** — the steps below. Needs Node.js 18+ and git.

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

## 3. Register the native host

```bash
npm run register-host
```

This writes a small manifest into Chrome's `NativeMessagingHosts` folder (and
Brave, Edge, Chromium if they are installed). From now on Chrome can launch the
bridge's native host, which starts the server if it is not running and hands the
extension its token. Nothing to paste, nothing to keep alive. You can stop the
`npm start` from step 2 now if you like; the extension will start the server
itself.

Skipping this step is fine: the manual path in step 5b still works.

## 4. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the `extension/` folder inside your clone.
4. A card named **AI Browser Bridge** appears with the ID
   `hgckekkegbobpiikhgdoeakochamknkg` (fixed by the key in the manifest, so the
   native host manifest matches on every machine).

Chrome loads the extension from that folder on every start, so do not move,
rename or delete the clone afterwards. `git pull` updates it in place; run
`node server/cli.js reloadExtension` (or press the reload icon) after pulling.

## 5. Enable user scripts (and, without the native host, paste the token)

1. On the card click **Details**. Turn on **Allow User Scripts** — `eval` and
   `waitFor` with a JS condition run through Chrome's User Scripts API and are
   refused until this is on. (Chrome 135–137 has no toggle; Developer mode is
   enough there. Older Chrome: those two commands need `--debugger`.)
2. If you ran `npm run register-host`, you are done: open **Extension options**
   and the first line reads *token received from the native host*.

**5b. Manual provisioning** (only if you skipped step 3):

1. Copy the token:
   ```bash
   cat ~/.ai-browser-bridge/token
   ```
   On Windows the file is `%USERPROFILE%\.ai-browser-bridge\token`.
2. On the Details page click **Extension options**. Paste the token into
   **Auth token**. Leave **Server port** at `8765` unless you changed
   `BRIDGE_PORT` on the server.
3. Optionally fill the **Host allowlist**, one domain per line. Commands then run
   only on those domains and their subdomains. Empty means any site.
4. Click **Save**. The extension connects immediately and, after that, retries
   every ~24 seconds on its own.

## 6. Smoke test

```bash
node server/cli.js ping
# {"pong":true,"version":"0.1.10"}
```

If you get an error instead:

| Error | Meaning | Fix |
|---|---|---|
| `connect failed` | The server is not running. | Go back to step 2. |
| `extension not connected` | Token not saved, wrong, or the service worker is asleep. | With the native host: press the reload icon on the extension card, wait 5 s, retry. Manual: re-check Options and press *Save*, wait 30 s, retry. |
| `no token at …` | The server never ran on this machine, so no token exists. | Run the server once (step 2), or register the host and reload the extension. |
| `User Scripts API is not enabled` | `eval` ran but the toggle from step 5 is off. | Details → **Allow User Scripts**, then retry. |

## 7. Keep the server running

With the native host registered (step 3) this section is optional: Chrome starts
the server through the native host whenever the extension needs it, and the
server keeps running detached after that. Register a background service only if
you want the server up before Chrome is, or you skipped step 3. Templates live in
`deploy/`; replace the placeholder paths first.

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
- Commands run in direct mode by default. `--debugger` is opt-in per call and
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
node server/cli.js reloadExtension     # reloads the extension in place (or press the reload icon on its card)
node server/cli.js ping
```

## Uninstalling

1. Remove the extension from `chrome://extensions`.
2. `npm run register-host -- --unregister` to remove the native host manifests.
3. Stop and remove the service if you installed one (launchd: `launchctl unload …`
   and delete the plist; systemd: `systemctl --user disable --now ai-bridge`).
4. Delete `~/.ai-browser-bridge/` (token, log, native-host wrapper) and the clone.

## Binary install (no Node.js)

The single-executable build bundles Node, the relay server, the native host and
the CLI into one file. Nothing else to install.

1. Download `ai-bridge-<platform>-<arch>` from the
   [latest release](https://github.com/legisus/ai-bridge/releases/latest) and put
   it somewhere permanent, for example:
   ```bash
   mkdir -p ~/.ai-browser-bridge/bin
   mv ~/Downloads/ai-bridge-darwin-arm64 ~/.ai-browser-bridge/bin/ai-bridge
   chmod +x ~/.ai-browser-bridge/bin/ai-bridge
   ```
   On macOS the first launch of an unsigned download is blocked by Gatekeeper.
   Until releases are notarized, clear the quarantine flag once:
   ```bash
   xattr -d com.apple.quarantine ~/.ai-browser-bridge/bin/ai-bridge
   ```
2. Register the native host. The binary registers *itself* as the host, so keep
   it at this path (re-run this after moving it):
   ```bash
   ~/.ai-browser-bridge/bin/ai-bridge register-host
   ```
3. Load the extension (step 4 above) and turn on **Allow User Scripts** (step 5).
   You still need the `extension/` folder from the repository until the
   extension is on the Chrome Web Store: download the source zip from the same
   release page and unzip it somewhere permanent.
4. Smoke test:
   ```bash
   ~/.ai-browser-bridge/bin/ai-bridge ping
   # {"pong":true,"version":"0.1.10"}
   ```
   If it says `extension not connected`, reload the extension once; it asks the
   host for the token and the host starts the server.

Everything in this guide that says `node server/cli.js …` is `ai-bridge …` with
the binary, including `ai-bridge agent "…"`. Subcommands reserved by the binary:
`serve` (run the relay in the foreground), `host` (native host mode, what Chrome
invokes), `register-host`.

To build the binary yourself on another platform:
```bash
npm install && npm run build:sea      # → dist/ai-bridge-<platform>-<arch>
npm test                              # includes the binary test once dist/ exists
```

## macOS app

`AI Browser Bridge.app` is a menu-bar app wrapped around the same `ai-bridge`
binary (inside the app at `Contents/MacOS/ai-bridge`) plus a copy of the
extension folder. It has no Dock icon and no window, only a menu:

- **Status line** — Connected / Server not running / Extension not connected,
  refreshed every 5 seconds.
- **Add to Chrome…** — opens the Chrome Web Store page once the extension is
  published. Until then it opens `chrome://extensions`, reveals the bundled
  extension folder in Finder, and shows the three Load-unpacked steps.
- **Open Extension Options**, **Set up native host again** (forces
  re-registration; on first launch the app registers only if nothing valid is
  registered yet, so it never clobbers a source install).
- **Copy CLI path** and **Copy CLAUDE.md snippet** — paste the snippet into
  `~/.claude/CLAUDE.md` to teach Claude Code about the bridge.
- **Open log**, **Start at login**, **Quit**.

Install: open the `.dmg`, drag the app to **Applications**, eject, open the app
from Applications. If you open it from the disk image it refuses and tells you
to move it first, because the native host manifest must point at a permanent
path. Until releases are notarized, macOS will say the app "cannot be opened
because the developer cannot be verified": right-click the app → **Open** →
**Open**, once.

Build it yourself (needs the Xcode Command Line Tools):
```bash
npm run build:mac        # → dist/macos/AI Browser Bridge.app and the .dmg
AI_BRIDGE_STORE_URL="https://chromewebstore.google.com/detail/<id>" npm run build:mac   # once published
```
