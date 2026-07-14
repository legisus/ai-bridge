# AI Browser Bridge — Test Plan

Goal: prove the bridge covers **every browser-control technique otherwise done
through OS-level input scripting**, so it can fully replace that approach.

Two layers:

1. **`protocol.test.js`** — offline unit test. Starts the server + a *simulated*
   extension + the real CLI; asserts auth rejection and command round-trips. No Chrome
   required. Run: `npm test`.
2. **`integration.sh`** — live end-to-end test. Drives the **real extension + Chrome**
   through the CLI against a self-injected fixture page, asserting observable results.
   Requires the server running and the extension connected. Run:
   `bash test/integration.sh`. Runs in a throwaway background tab; leaves your tabs alone.

## Coverage map — OS-level technique → bridge command → test case

| # | OS-level automation technique | Bridge command | Integration case | How it's verified |
|---|---|---|---|---|
| 0 | (health / is Chrome reachable) | `ping` | ping (health) | returns `{pong:true}` |
| 1 | `make new tab/window` (background, minimized) | `newTab` (`active:false`) | newTab background | returns a tab id; opens without focus |
| 2 | `execute javascript` — read innerText, scrape, set form fields | `eval` (CSP-proof `Runtime.evaluate`) | eval inject fixture / DOM read | reads title + element presence |
| 3 | list tabs / find tab by URL substring | `listTabs` | listTabs present | fixture tab id found in list |
| 4 | real **Cmd+V paste** (CSP-strict web forms) | `insertText` (trusted) | insertText into input | input `.value` equals inserted text |
| 5 | OS-level **click at {x,y}** (trusted) | `click` (trusted mouse event) | click fires handler | page `__clicked` flips true |
| 6 | `keystroke` (Enter, Cmd+A) | `key` (trusted key event) | keydown Enter | page records `__lastKey==="Enter"` |
| 7 | `set URL of tab` | `navigate` | navigate URL change | `location.hostname` updates |
| 8 | `chrome --headless --print-to-pdf` (archiving pages as PDF) | `pdf` | print-to-PDF | output file starts with `%PDF` |
| 9 | `screencapture` (page screenshot) | `screenshot` | PNG bytes | output file has PNG magic bytes |
| 10 | webmail attachment: fetch in page → base64 → file | `download` (uses browser cookies) | authenticated download | file lands on disk, path returned |
| 11 | `activate` / `set index` / focus window / un-minimize | `activateTab` | focus tab+window | returns `{ok:true}`; tab becomes active |
| 12 | (no OS-level equivalent) clear DevTools debugger banner | `detach` | release debugger | returns `{ok:true}` |
| 13 | `close tab` / `close window` | `closeTab` | tab removed | tab id absent from `listTabs` |
| 14 | (n/a) many CLIs, one tab, first-touch attach | per-tab attach lock | concurrency | 6 concurrent `eval` all return their own value; no attach race |
| 15 | type into autocomplete/React widget | `type` (per-char keystrokes) | type into input | input `.value` equals typed text |
| 16 | click without pixel math | `click` (`selector`) | click by selector | handler fires from selector-resolved center |
| 17 | wait for async element/condition | `waitFor` | selector becomes present | returns `{ok:true}` once `#late[data-ready]` appears |
| 18 | scroll page (to selector/top/bottom/by) | `scroll` | scroll to bottom | `window.scrollY` advances |
| 19 | health of connection + attached tabs | `status` | status shape | returns `version` + `attachedTabs[]` + `idleDetachMs` |
| 20 | clear all debugger banners at once | `detachAll` | detachAll | after call, `status.attachedTabs` is empty |
| — | auth/token rejection (security) | server auth | protocol.test.js | bad token → socket closed |

### Techniques deliberately NOT ported (host-OS, out of scope for the extension)

- **Clipboard backup/restore**: only needed *because* OS-level paste injection
  hijacks the system clipboard. `insertText` writes straight to the page and never
  touches the clipboard, so the whole dance is obsolete.
- **Window minimize gymnastics / focus hand-back**: the bridge works in background tabs
  with no focus change, so there is nothing to minimize or restore.
- **`screencapture` of the whole screen**: replaced by tab-scoped `screenshot`
  (and `pdf`), which don't require the window to be visible or frontmost.

## Manual / observational checks (not auto-assertable)

- **Debugger banner**: first `eval`/`click`/`pdf` on a tab shows Chrome's
  "AI Browser Bridge started debugging this browser" banner; `detach` clears it.
- **No focus theft**: run `integration.sh` while typing in another app — focus must
  never jump to Chrome (the classic OS-level automation pain point).
- **Allowlist enforcement**: set a host allowlist in Options, then `eval` on a
  non-listed domain must return `host "..." not in allowlist`.

## Last run

`integration.sh` — **15/15 PASS** (2026-07-07, extension v0.1.0, Chrome on macOS).
`protocol.test.js` — **4/4 PASS**.

Re-run both after any change to `background.js`, `server.js`, or `cli.js`.
