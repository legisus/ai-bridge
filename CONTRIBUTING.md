# Contributing to AI Browser Bridge

Thanks for wanting to improve the bridge! It's a deliberately small codebase
(~3 source files, one dependency), and we'd like to keep it that way.

## Dev setup

```bash
git clone https://github.com/<you>/ai-bridge.git
cd ai-bridge
npm install        # only dependency: ws
```

- **Node ≥ 18** required.
- The extension (`extension/`) is plain Manifest V3 JavaScript — no build step.
  Load it via `chrome://extensions` → Developer mode → *Load unpacked*.
- The server and CLI (`server/`) run directly with `node`.

## Project layout

```
extension/    MV3 extension: background.js (service worker, all commands), options page
server/       server.js (WebSocket relay, 127.0.0.1 only) and cli.js (client)
test/         protocol.test.js (offline), integration.sh (live), TEST-PLAN.md
docs/         usage guides (e.g. Claude Code integration)
```

## Making a change

1. **Fork** the repo and create a branch: `git checkout -b my-fix`.
2. Make your change. Keep the style of the surrounding code: plain modern JS,
   no TypeScript, no build tooling, comments only where the code can't speak.
3. **Test** (see below). Both layers must pass before you open a PR.
4. If you changed behavior, update `README.md` and `test/TEST-PLAN.md`
   (the coverage map) to match.
5. If you added a command, add:
   - a case in `extension/background.js`'s `handle()`,
   - an example line in the README's *Usage* section,
   - an assertion in `test/integration.sh`,
   - a row in `test/TEST-PLAN.md`.
6. Open a **pull request** against `main` with a short description of *what*
   changed and *why*. Small, focused PRs get reviewed fast; grab-bag PRs don't.

## Testing

Two layers — run both:

```bash
npm test                    # offline: server + simulated extension + real CLI
bash test/integration.sh    # live: requires server running + extension connected in Chrome
```

`integration.sh` runs in a throwaway background tab and cleans up after itself.
After it passes, update the *Last run* section in `test/TEST-PLAN.md`.

If you change `background.js`, remember Chrome caches the service worker:
hit the reload icon on `chrome://extensions` before re-testing.

## Commit messages

- One logical change per commit.
- First line: imperative, ≤ 72 chars, says what the change does
  (`Add scrollTo command`, `Fix download polling on interrupted state`).
- Body (optional): the *why* — the motivation and any trade-offs.

## Versioning

Version lives in **two** places and they must stay in sync:

- `package.json` → `"version"`
- `extension/manifest.json` → `"version"`

Bump both in the same commit (patch for fixes, minor for new commands).
Maintainers tag releases (`git tag v0.x.y`).

## Security ground rules (non-negotiable)

The extension can act as the user on any site they're logged into, so PRs must
preserve the security model:

- The server **binds 127.0.0.1 only** — never add a way to listen on other interfaces.
- **Token auth stays mandatory** for every socket, extension and CLI alike.
- The **host allowlist** must keep gating every tab-targeting command
  (`assertAllowed` before any debugger/tab action on a tab).
- **No telemetry, no external requests** from the extension or server. Ever.
- New commands must be **logged** like existing ones (`~/.ai-browser-bridge/bridge.log`).

Found a security issue? Please **don't open a public issue** — use GitHub's
*Report a vulnerability* (Security tab) or email the maintainer instead.

## Scope

Good candidates: new CDP-backed commands (scroll, hover, DOM snapshot, network
capture), Firefox port, reliability fixes, docs. Out of scope: cloud relays,
bundlers/frameworks, telemetry of any kind, features that weaken the security model.
