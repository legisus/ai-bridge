# Economy mode — journal, audit, recipes

Goal: stop paying model tokens for browser jobs that repeat. A job that has run
successfully several times becomes a **recipe** (deterministic bridge commands
with assertions) that replays for zero tokens; a model is called only when the
recipe breaks, to repair it.

## Layers

| Layer | Who runs it | Tokens | Status |
|---|---|---|---|
| Journal | `bridge agent` + server | none | **this PR** |
| Snapshot (DOM digest instead of screenshots) | `bridge snapshot` | cheaper ops | **this PR** |
| Recipe runner | `bridge recipe run <job>` | none | **this PR** |
| Recipe proposal from traces | `bridge recipe propose <job>` | one call per job (~$0.30) | **this PR** |
| Audit / economy state machine | `bridge agent --job <name>` | judge only, then none | **this PR** |

## Journal (this PR)

Every `bridge agent` run appends one JSON line to `~/.ai-browser-bridge/journal.jsonl`:

```json
{"runId":"a1b2…","job":"toll-invoices","signature":"job:toll-invoices","task":"…",
 "startedAt":"…","endedAt":"…","mode":"regular","verdict":"pass","stages":[…],
 "costUsd":0.12,"inputTokens":51234,"outputTokens":2210,"domains":["thetollroads.com"],
 "trace":"~/.ai-browser-bridge/traces/a1b2….jsonl"}
```

Every bridge command issued during that run is traced to
`~/.ai-browser-bridge/traces/<runId>.jsonl` by the server (one line per
command: `cmd`, `params`, `ok`, `error`, `ms`, result preview). The agent
passes `AI_BRIDGE_RUN_ID` and `AI_BRIDGE_JOB` to its child `claude`/`codex`
processes; the CLI forwards them as `meta` on each request. Traces are the raw
material recipes are synthesized from, so `eval` code is kept in full.

**Job signature.** `--job <name>` on `bridge agent` is the key (`job:<name>`).
Without it, the signature is the sorted set of domains touched plus the task
text with digits and whitespace normalized (`auto:<domains>|<text>`). Jobs
started from cron or the bot should always pass `--job`.

`bridge journal [--days N] [--job name] [--json]` groups runs by signature and
prints runs, pass rate, total and average cost, average tokens, last run, and
marks **candidates**: 3 or more passes inside the window.

## Snapshot (this PR)

`bridge snapshot '{"tabId":N}'` returns a compact digest of the page: URL,
title, visible text (capped), and every interactive element with role, label,
state, a stable selector (`#id`, `[data-testid]`, `[name]`, `[aria-label]`,
else a short structural path), and its viewport box. It pierces open shadow
roots and same-origin iframes. It is implemented as a direct-mode `eval`, so it
needs no extension update. The ops playbook now tells models to use it first
and screenshot only when the digest is insufficient.

## Recipes

`~/.ai-browser-bridge/recipes/<job>.json` (current) + `<job>.v<N>.json` (every
version). A recipe is JSON: `job`, `task`, `risk` (`read`|`write`), `params`
(templates allowed, e.g. `{"fromDate":"{{date:-7:MM/DD/YYYY}}"}`), `steps`,
`output` (saved variable returned as the result), `evidence` (one-line summary
template). Steps are bridge commands (`newTab`, `navigate`, `waitFor`, `click`,
`insertText`, `key`, `eval`, `snapshot`, `closeTab`, …) plus `assert` (fail the
run if a JS expression is falsy, with a message such as `LOGIN REQUIRED`),
`poll` (repeat an expression until truthy/non-empty) and `sleep`. `save` stores
a step's result for `{{var}}`, `{{json:var}}`, `{{len:var}}`; `{{tab}}` is the
first opened tab and the default `tabId`; `optional: true` steps may fail.

The runner (`server/recipe.js`) executes through the bridge CLI under the run's
`AI_BRIDGE_RUN_ID`, so recipe runs are traced like model runs. It produces an
EVIDENCE REPORT in the same format as the ops models, so the judge can verify
it unchanged. On a failing step it captures a `snapshot` digest of the tab and
closes the tab.

```bash
bridge recipe propose <job> [--runs 3]   # learn from the job's last 3 passing regular runs (claude-opus-5-5)
bridge recipe run <job> [--params json]  # replay by hand, zero tokens
bridge recipe show <job> | validate <file> | import <file>
bridge jobs                              # per-job mode / risk / audit progress / canary countdown
bridge jobs set <job> --mode audit|economy|regular --risk read|write --audits 3 --canary 5
```

## State machine

```
regular ──(≥3 passes in 30 d)──► candidate ──(recipe proposed)──► audit
audit: recipe runs live + judge verifies; 3 consecutive passes ──► economy
audit fail ──► this run completes in regular mode; recipe marked for repair ──► audit
economy: recipe + assertions, no model; every Nth run (or weekly) a judge canary
economy fail ──► fallback to regular mode for this run; repair; back to audit
```

Protections in economy mode:

- every write step is preceded by an assertion on the expected page state;
  any miss aborts before the side effect and falls back to regular mode;
- recipes begin with an idempotency check (result already exists → done);
- risk tiers: read-only jobs may reach economy; jobs that write to the outside
  world (send invoice, add vehicle) stay in audit (recipe + judge every time)
  unless explicitly allowlisted; payment recipes stop at the review screen.

State lives in `~/.ai-browser-bridge/jobs.json`; recipes in
`~/.ai-browser-bridge/recipes/<job>.json`, versioned on every repair.

What `bridge agent "…" --job X` does per mode (`server/agent.js`):

| job mode | what runs | tokens | on failure |
|---|---|---|---|
| regular (or no recipe / repair needed) | model ladder + judge | as before | ladder escalates |
| audit | recipe, then judge on its evidence | judge only | fallback to the ladder, recipe repaired from this run's trace, back to audit |
| economy | recipe only; judge every `canaryEvery`-th run | none (canary: judge) | same fallback + repair |

Journal `mode` values: `regular`, `audit`, `economy`, `audit-fallback`,
`economy-fallback`. The repair step is one model call (`--no-repair` to skip).

## First jobs (2026-11-15)

- `toll-roads-pull` — Toll Roads "Find a Transaction" for the last 7 days, read-only.
  3 regular runs (~$0.67 each) → recipe v1 proposed ($0.29) → v2 with relative
  date params → audit.
- `mcw-memberships-pull` — Mister Car Wash membership list (Default Chrome
  profile), read-only.
