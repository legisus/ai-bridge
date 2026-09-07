# Chrome Web Store submission kit

Everything the Developer Dashboard asks for, in one place. Keep this in sync with
`extension/manifest.json` and [PRIVACY.md](../PRIVACY.md).

## Listing

**Name:** AI Browser Bridge

**Summary (132 chars max):**
Let a program on your own computer, such as an AI coding agent, drive your logged-in browser through a local-only relay.

**Description:**

AI Browser Bridge connects your browser to a small server that runs on your own
machine (127.0.0.1). Any local program that can run a shell command — an AI coding
agent like Claude Code, a script, a cron job — can then open tabs, read pages, click,
type, scroll, take screenshots, print to PDF, and download files with your existing
logins. No cloud, no account, no telemetry: the extension talks to nothing except
the server you start yourself.

Why an extension instead of a headless browser? Because your real sessions are
here. Webmail, dashboards, internal tools, anything you are logged into just works,
and you can watch every action in your own tabs.

What you control:
• Host allowlist — restrict the bridge to the domains you name.
• Token — nothing can send commands without the secret generated on your machine.
• Two modes — direct mode (default) uses ordinary extension APIs and shows no
  banner; debugger mode is opt-in per command and shows Chrome's "is debugging
  this browser" banner whenever it is active.
• Activity indicator — a colored frame and favicon badge mark exactly which tabs
  are under control.
• Local log — every command is written to a log file on your computer.

Setup takes a few minutes: install the server from the open-source repository,
paste the token into this extension's options, done. Full guide, CLI reference and
source: https://github.com/legisus/ai-bridge

**Category:** Developer Tools

**Language:** English

**Privacy policy URL:** https://github.com/legisus/ai-bridge/blob/main/PRIVACY.md

**Homepage / support URL:** https://github.com/legisus/ai-bridge

## Single purpose

Let a program running on the user's own computer control the user's browser tabs
through a local relay on 127.0.0.1.

## Permission justifications

Paste each into the matching field of the *Privacy practices* tab.

- **tabs** — The local program asks to list, open, select, and close tabs; the
  extension needs tab ids, URLs, and titles to do that and to report which tab it
  is acting on.
- **scripting** — Clicks, typing, scrolling, waiting for an element, and the
  on-tab activity indicator are implemented as bundled functions injected with
  chrome.scripting. No remote code: every injected function ships in the package.
- **userScripts** — The `eval` command runs a snippet of code that the user's local
  program supplies, in the page the user chose. chrome.userScripts.execute() is
  Chrome's documented API for user-supplied code and is available only after the
  user turns on "Allow User Scripts" for this extension.
- **debugger** — When the user explicitly passes `--debugger` for a command (or
  pre-approves it), trusted input events for rich-text editors, print-to-PDF, and
  screenshots of background tabs are only possible through the DevTools protocol.
  It is never attached by default; idle sessions are released automatically and
  Chrome's banner stays visible while attached.
- **downloads** — The `download` command saves a URL with the user's cookies to the
  Downloads folder on request.
- **storage** — Stores the auth token, server port, host allowlist, and two UI
  settings locally.
- **alarms** — Reconnects the service worker to the local server every 24 s and
  releases idle debugger sessions.
- **nativeMessaging** — Connects to the native messaging host that the user
  registers on their own machine (`com.ai_bridge.host`) to receive the local
  server's auth token and port, so the user does not have to paste it, and to let
  the host start the local server on demand. The host is part of the same
  open-source project; no other host is contacted.
- **Host permissions `<all_urls>`** — The user decides which sites their local
  program may act on; that can be any site. The optional host allowlist in the
  options page narrows it to named domains, and the extension refuses commands on
  every other domain when the list is set.

## Remote code

The extension executes no remotely hosted code. Code supplied by the user's local
program runs only through chrome.userScripts (direct mode) or chrome.debugger
(debugger mode), both of which the Chrome Web Store lists as permitted paths for
user-supplied logic. The extension package contains all extension-context logic.

## Data usage declarations

- Personally identifiable information: **not collected**
- Health, financial, authentication, personal communications, location, web
  history, user activity, website content: **not collected by the developer**.
  Website content and screenshots are returned only to the program on the user's
  own machine that requested them, over 127.0.0.1, and are not stored by the
  extension.
- Certifications: not sold to third parties; not used for purposes unrelated to the
  single purpose; not used for creditworthiness or lending.

## Notes for the reviewer (Test instructions field)

The extension is a client for a local server. To exercise it:

1. Install Node.js 18+ and run:
   ```
   git clone https://github.com/legisus/ai-bridge.git && cd ai-bridge && npm install && npm start
   ```
   The server prints the path of a generated token file.
2. Load the extension, open its options, paste the token, save. Also turn on
   "Allow User Scripts" on the extension's Details page.
3. In a second terminal:
   ```
   node server/cli.js ping                                      # {"pong":true,...}
   node server/cli.js newTab '{"url":"https://example.com"}'    # returns a tabId
   node server/cli.js eval '{"tabId":<id>,"code":"document.title"}'
   node server/cli.js screenshot '{"tabId":<id>}' --out shot.png
   node server/cli.js pdf '{"tabId":<id>}' --out page.pdf --debugger   # shows the debugger banner
   node server/cli.js detachAll
   ```
The server binds 127.0.0.1 only. A screencast of these steps is attached to the
submission. Source for both parts: https://github.com/legisus/ai-bridge

## Assets checklist

- [ ] 128×128 icon (`extension/icons/128.png` — not yet in the repo)
- [ ] 1280×800 screenshots: options page, a driven tab with the activity frame, a
      terminal running `bridge ping` / `eval`
- [ ] 440×280 small promo tile
- [ ] Screencast of the reviewer steps above
- [ ] Developer account verified, one-time registration fee paid

## Wording to avoid in the listing

Do not describe direct mode as "stealth", "undetectable", "evades", "bypasses
anti-bot", or similar. It is a no-debugger mode; describe what it does (no DevTools
session, no banner, lower overhead), not who it hides from.
