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

## Access switch — manual rows (need a real Chrome)

| # | behaviour | how | expected |
|---|-----------|-----|----------|
| A0 | auto-grant: reload keeps access | `Auto-grant` on; `bridge reloadExtension`; `bridge ping` | within a few seconds `"access":"granted"` with a new `extGen`, no click — verified 2026-11-26 |
| A0b | auto-grant: disable is the stop switch | with a tab attached (`--debugger`), disable the extension at chrome://extensions | banner gone, `bridge ping` → `extension not connected`; re-enable → `"access":"granted"` again |
| A0c | manual mode | turn `Auto-grant` off in Options | access shows revoked; Grant/Revoke buttons appear; rows A1–A12 apply |
| A1 | revoke during `waitFor` | `bridge waitFor '{"tabId":N,"selector":"#never","timeoutMs":60000}'`, then **Revoke** | the command fails with `access_revoked` within one poll tick (~200 ms) |
| A2 | revoke during `type` | `bridge type '{"tabId":N,"text":"<200 chars>","delay":50}'`, **Revoke** mid-way | typing stops mid-string; the CLI exits 8 |
| A3 | revoke while an attach is in flight | `bridge eval … --debugger` on a fresh tab, **Revoke** at once | no "is debugging" banner stays, the command fails `access_revoked` |
| A4 | queued direct screenshot after revoke | two parallel `bridge screenshot` (direct) then **Revoke** | the second capture is discarded with `access_revoked`, no image written |
| A5 | expiry alarm after a worker restart | **Grant for 1 h**, go to chrome://serviceworker-internals and stop the worker, wait for T | the badge turns grey at T and the next command is refused |
| A6 | late alarm does not revoke a renewed grant | **Grant for 1 h**, then **Grant** (indefinite) | at the old T nothing happens; access stays granted |
| A7 | grant from the popup without a reload | revoked state, **Grant**, `bridge newTab …` | the tab opens; no reload needed |
| A8 | changing the token in Options revokes | paste a different token, **Save** | access state shows revoked, the extension reconnects with the new token; Manual mode is on |
| A9 | manual mode ignores the native host | Manual mode on, native host registered, reload the extension | the token in Options is not overwritten |
| A10 | download in progress cancelled on revoke, finished one not | `bridge download` of a large file, **Revoke** while it runs; then a small finished download, **Revoke** | the large one shows as cancelled in chrome://downloads; the finished one stays |
| A11 | "revoke and close" after a worker restart | `bridge newTab`, stop the worker (A5), **Revoke and close agent tabs** | the tab closes (agentTabs lives in session storage, not in the worker) |
| A12 | extension reload revokes with a notice | **Grant**, `bridge reloadExtension` | the popup shows revoked and the "reloaded" notice; `bridge tabs` lists the old tabs as from an earlier session |

## Target guard — manual rows (need a real Chrome)

| # | behaviour | how | expected |
|---|-----------|-----|----------|
| G1 | privileged destinations refused | `bridge newTab '{"url":"chrome://extensions"}'`, same for `chrome-extension://<id>/options.html` with the allowlist empty and with `*` | `privileged target refused` |
| G2 | listTabs redaction | open chrome://settings and a site outside the allowlist, `bridge listTabs` | both appear as `{id, url:"redacted"}` with no title |
| G3 | redirect out of the allowlist stops waitFor | allowlist `ok.example`; tab on it; `bridge waitFor '{"tabId":N,"selector":"#never","timeoutMs":60000}'`; navigate the tab by hand to another host | the command fails `host "…" not in allowlist` within one tick |
| G4 | attached tab redirected to chrome:// detaches | `bridge eval … --debugger` on a tab, then type `chrome://version` in its address bar | the banner disappears; `bridge status` shows the tab is no longer attached; the event list has `detach … target_changed` |
| G5 | document changed under a direct eval | `bridge eval` with code that navigates the page, then a second `bridge eval` racing it | the second fails `target changed` or runs in the new document only after re-validation; never in the old one |
| G6 | status --events redaction | revoke, `bridge status --events` → counts only; grant, refuse a command on a disallowed host, `bridge status --events` | the refused event shows `origin: "redacted"` and `reason: not_allowed`; the popup's "Recent events" shows the real origin |

## Docker (needs Docker; scripts, not npm test)

| # | behaviour | how | expected |
|---|-----------|-----|----------|
| D1 | smoke job | `bash test/docker-smoke.sh` | `SMOKE OK (claude 2.1.317, codex 0.171.0, linux/…)` — last run 2026-11-25 on the authoring Mac (Colima, arm64) |
| D2 | round trip with the real extension | `bash test/docker-roundtrip.sh` (stops the host relay for ~1 min) | `ROUNDTRIP OK (extension access: granted|revoked)`; the container log shows `extension connected` and the access line |
| D3 | fail closed inside the container | round trip while the popup shows revoked | `listTabs` from inside the container is refused with `access_revoked` |

## Tab hygiene — manual rows (need a real Chrome)

| # | behaviour | how | expected |
|---|-----------|-----|----------|
| T1 | reload the extension with agent tabs open | `bridge newTab`, then `bridge reloadExtension`, then `bridge tabs` | the tab is listed under "from an earlier Chrome session"; `bridge closeTabs --mine` does not touch it |
| T2 | a run killed with Ctrl-C closes its tabs | `bridge agent "open example.com and wait"`, Ctrl-C while it runs | within ~5 s the run's tabs are gone; `bridge journal` shows `tabsClosed` for the run |
| T3 | a user tab in the agent's window survives | run opens a tab with `newWindow:true`; drag one of your tabs into that window; end the run | your tab stays, the agent's tab closes, the window stays open |
| T4 | restart the relay mid-session | `bridge newTab`, restart `server.js`, `bridge tabs` | the tab is still listed as live (registry reloaded, reconciled against the extension) |

## Last run

`integration.sh` — **15/15 PASS** (2026-07-07, extension v0.1.0, Chrome on macOS).
`protocol.test.js` — **4/4 PASS**.

Re-run both after any change to `background.js`, `server.js`, or `cli.js`.
