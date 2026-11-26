# Auto-grant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** The bridge is granted by default and stays granted ("always on"); the user stops it by disabling the extension. Manual Grant/Revoke remain available only when auto-grant is switched off.

**Spec:** the user's decision (2026-11-26: "I need grant always… I can disable extension when I want stop it") assessed by Astra (PROCEED WITH CHANGES, recommendations 1–7 below folded in); the design spec gets an "Auto-grant" paragraph and a note that the fail-closed default is now the OFF mode.

**Architecture:** `autoGrant` (Options, default ON) is a policy, not a default record: one serialised reconciliation (`reconcileAuto`) runs at worker init, `onInstalled`, `onStartup`, after a token/port change and when the setting flips; it grants indefinitely with source `auto` only when the record is not already an indefinite grant (no generation churn), replaces timed grants, and fails closed on storage errors. `reloadExtension` still revokes and cleans up before reloading and now waits for pending creations and verifies the cleanup; on failure it refuses the reload. Enforcement (assertAccess/dispatch, target guard, registry, leases, the agent's poll) is unchanged. The popup and Options hide Grant/Revoke/timed grants while ON and explain the toggle.

## Tasks

1. `access.js`: `autoGrantEnabled()`, `reconcileAuto({source})` (serialised through the transition queue, idempotent), `setAutoGrant(on)`, `"auto"` event source, `onInstalled`/`init` honour the policy; `parseAccessSet` unchanged but the worker rejects manual `access-set` while ON. Tests: lifecycle matrix (ON/OFF × missing/revoked/indefinite/timed/expired), idempotency (gen unchanged), timed→indefinite, OFF→revoke, storage failure fail-closed, `auto` event.
2. `background.js`: reconcile after init, onInstalled, onStartup, token/port change (after the revoke, before the access message), setting change via `chrome.storage.onChanged` on `autoGrant`; `reloadExtension` drains pending tabs/downloads (≤5 s), verifies `agentTabs` empty and in-progress bridge downloads cancelled, refuses with `reload refused: cleanup incomplete` otherwise; no auto re-grant during reload cleanup; `access-set` → `{ok:false, error:"auto-grant is on; disable it in Options to manage access by hand"}` while ON. Worker tests through the harness.
3. Popup/Options: always-on copy, hidden manual controls while ON, `Auto-grant` checkbox in Options (default checked) with the toggle explanation and its limits (disabling does not cancel downloads or close tabs: use Close agent tabs first). Source-level tests.
4. Docs: spec (Auto-grant paragraph, status), DOCKER.md (Access section + kill-switch limits), CHANGELOG, README install step, INSTALL 5c, TEST-PLAN rows (disable while attached; re-enable restores access without a click; reload keeps access).
5. Live: `bridge reloadExtension` on the Mac → the new worker comes back granted without a click; `npm test`; Astra review; PR against `fix/intent-gate-expiry`.
