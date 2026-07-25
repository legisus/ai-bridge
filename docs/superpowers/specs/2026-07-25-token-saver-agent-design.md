# Token-Saver Browser Agent (`bridge agent`) — Design

**Date:** 2026-07-25
**Status:** Approved for implementation

## Problem

ai-bridge is driven today by a Claude Code session running Fable 5 — the most
expensive model ($10/$50 per MTok). Browser operations (page evals, screenshots,
form filling) are token-heavy but mostly mechanical; they don't need Fable.

## Goal

A new CLI command that completes a browser task using cheap models for the
operations and Fable **only for judging**, billed to the user's existing Claude
subscription (no separate API key).

```bash
node server/cli.js agent "open example.com and report the page title"
```

## Architecture

The agent spawns **headless Claude Code sessions** (`claude -p`) as
subprocesses. This reuses the user's Claude login/subscription and Claude
Code's own tool loop; no Anthropic SDK dependency is added.

### Escalation ladder

| Stage | Model | Role |
|---|---|---|
| Ops pass 1 | `claude-haiku-4-5` ($1/$5) | Execute the task via bridge CLI |
| Judge 1 | `claude-fable-5` ($10/$50) | Pass/fail verdict on evidence only |
| Ops pass 2 (if fail) | `claude-sonnet-5` ($3/$15) | Retry with judge feedback |
| Judge 2 | `claude-fable-5` | Verdict |
| Ops pass 3 (if fail) | `claude-fable-5` | Last-resort retry with all feedback |
| Judge 3 | `claude-fable-5` | Final verdict |

Ladder stops at the first `pass`. Maximum 3 ops passes, 3 judge calls.

### Ops session

- Spawned with `--model <ops model>`, `--output-format json`, and tools
  restricted to Bash invocations of the bridge CLI (`node server/cli.js ...`).
- Prompt = task + fixed operations playbook: `ping` first; background tabs
  only; verify focus/position after clicks; screenshots to locate elements
  when unsure; `detach` when done; never log out or submit destructive forms.
- Must end with an **evidence report**: actions taken, final page state,
  screenshot path(s), and any blockers.

### Judge session

- Spawned with `--model claude-fable-5`.
- Input is only the task + the ops evidence report (never the full ops
  transcript) — keeps Fable input tokens minimal.
- Must output strict JSON: `{"verdict": "pass" | "fail", "feedback": "..."}`.
  Malformed JSON → one re-ask; still malformed → treat as fail with the raw
  text as feedback.

### Output

The CLI prints: final verdict, evidence report, and a per-stage summary
(model, token usage, cost estimate) so savings are visible.

## Code layout

- `server/agent.js` — new module: subprocess spawning, JSON result parsing,
  escalation ladder, cost accounting.
- `server/cli.js` — new `agent` subcommand delegating to `agent.js`.
- No new npm dependencies (child_process only).

## Error handling

Fail loudly with clear messages: `claude` CLI not installed / not logged in;
bridge server not running (pre-flight `ping`); ops session timeout
(configurable, default 10 min per pass); judge JSON malformed after re-ask.

## Testing

- Unit: ladder logic and judge-JSON parsing with a mocked spawn function
  (added to `test/`).
- Manual smoke: a simple real task (e.g. "open example.com and report the
  page title") end-to-end.

## Out of scope

- Parallel tasks, task queues, GUI.
- Direct Anthropic API integration (violates same-subscription requirement).
