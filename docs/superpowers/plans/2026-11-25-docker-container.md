# Docker Container Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the container files the guide describes, build and run them for real (Colima on this Mac), prove the smoke job, and do one round trip with the real Chrome extension talking to the relay inside the container.

**Architecture:** `Dockerfile`, `.dockerignore`, `deploy/docker/compose.yml`, `deploy/docker/.env.example` exactly as `docs/DOCKER.md` specifies (the guide is the spec; deviations found while building are folded back into the guide). A `test/docker-smoke.sh` script (outside `npm test`: needs Docker) builds the image, starts it on a free host port with throwaway volumes and asserts the guide's smoke list. The agent's Codex rung learns `AI_BRIDGE_CODEX_SANDBOX=container`.

**Tech Stack:** Docker (Colima VM, linux/arm64 here; the PC is x86_64 — the image is multi-arch by virtue of `node:22-bookworm-slim`), Compose v2, Node 22 in the image.

**Spec:** `docs/DOCKER.md` sections *Files*, *Setup, step by step*, *Debugging*, *Troubleshooting*; `docs/superpowers/specs/2026-11-21-docker-isolated-access-design.md` section *Container* and the Docker row of *Tests*.

## Global Constraints

- Branch `docker-container` stacks on `target-guard`; PR against `target-guard`; Astra reviews; no co-author trailers.
- The published port is bound to `127.0.0.1` on the host in every file this repo ships; never `0.0.0.0`.
- Image runs as `node` (uid 1000); `/data` and `/work` created and chowned before `USER node`; `/data` mode 700; read-only root fs; `/tmp` tmpfs; `cap_drop: ALL`; `no-new-privileges`; `pids_limit`; `mem_limit`; healthcheck on the listening port (not `ping`).
- Pins: `@anthropic-ai/claude-code@2.1.317`, `@openai/codex@0.171.0` (the pair on this Mac). The smoke job fixes the pair that passes; record it in the guide.
- `AI_BRIDGE_CODEX_SANDBOX=container` → the Codex rung runs with Codex's own sandbox off (`--sandbox danger-full-access`) instead of `workspace-write`; any other value → today's arguments.
- Nothing in the repo carries a credential: `.env` is git-ignored; the smoke test takes credentials from the environment only when present and skips the model steps otherwise.

## Plan decisions

1. **Smoke script, not an npm test**: `test/docker-smoke.sh` (bash, `set -euo pipefail`), run by hand or by a CI job later; it prints `SMOKE OK` and the pin pair on success.
2. **Throwaway everything**: the smoke run uses a compose project name `ai-bridge-smoke`, `BRIDGE_PUBLISH_PORT` from a free port, and `docker compose down -v` at the end; it never touches the user's real `~/.ai-browser-bridge`.
3. **Codex login for the smoke step**: if `~/.codex/auth.json` exists on this Mac it is copied into the smoke run's `home` volume (never committed, never logged); the Codex step is skipped when it is absent.
4. **Round trip** (Task 4): the Mac's host relay is stopped for a few minutes, the container is published on `127.0.0.1:8765` with the host's existing token copied into `/data/token`, the extension reconnects on its own, `bridge ping` from inside the container shows the extension's `access` state; then the container is stopped and the host relay restarted. With the extension revoked (until the user Grants) the round trip proves connectivity and the access handshake, not a browser command.
5. **Architecture**: the image is built for the host platform (arm64 here); the guide notes `docker compose build` on the PC builds x86_64 from the same files.

## Review Focus

1. `docker compose config` must validate with no `.env` present (defaults apply). (Task 2)
2. A missing `./work` directory on Linux is created root-owned by Docker and unwritable by uid 1000: the guide's `mkdir`+`chown` step stands; the smoke test creates it itself. (Task 3)
3. The healthcheck must turn healthy with no extension and no token pasted. (Task 3)
4. `/data/token` must be mode 600 and owned by uid 1000 on a fresh volume. (Task 3)
5. The relay inside the container must refuse everything but `ping`/`status` until an extension with a granted `access` connects (fail closed holds in the container too). (Task 4)

---

### Task 1: Codex sandbox switch

**Files:** Modify `server/agent.js` (`codexArgs`), test `test/agent.test.js`.

- [ ] Step 1 test: `codexArgs({ model: "m", effort: "medium", cwd: "/w", outPath: "/o" }, { AI_BRIDGE_CODEX_SANDBOX: "container" })` contains `"--sandbox", "danger-full-access"` and no `workspace-write`; with `{}` it contains `"-s", "workspace-write"` and `sandbox_workspace_write.network_access=true`; `runCodex` builds its argv through `codexArgs(opts, baseEnv || process.env)`.
- [ ] Step 2 run → FAIL (`codexArgs` not exported).
- [ ] Step 3 implement `codexArgs(opts, env) → string[]`, exported, used by `runCodex`.
- [ ] Step 4 run → PASS. Step 5 commit `agent: AI_BRIDGE_CODEX_SANDBOX=container runs codex without its own sandbox (the container is the sandbox)`.

### Task 2: Container files

**Files:** Create `Dockerfile`, `.dockerignore`, `deploy/docker/compose.yml`, `deploy/docker/.env.example`; the `.gitignore` entries exist from PR #10.

- [ ] Step 1 test: `docker compose -f deploy/docker/compose.yml config` succeeds without `.env`, its output has `127.0.0.1:8765:8765`, `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`, `pids_limit: 256`, named volumes `data` and `home`; `.dockerignore` excludes `extension`, `docs`, `test`, `node_modules`, `deploy/docker/.env*`.
- [ ] Step 2 run → FAIL (files missing).
- [ ] Step 3 write the four files from the guide.
- [ ] Step 4 run → PASS. Step 5 commit `docker: Dockerfile, .dockerignore, compose file and .env.example as the guide specifies`.

### Task 3: Smoke job

**Files:** Create `test/docker-smoke.sh`; modify `docs/DOCKER.md` (*Smoke test* subsection, pins confirmed).

- [ ] Step 1: write the script with these assertions, each printing `PASS`/`FAIL`: image builds; the container logs `listening on ws://0.0.0.0:8765 — make sure only the host's loopback can reach this port`; `docker inspect` health becomes `healthy` within 60 s; `stat -c '%a %u' /data/token` inside is `600 1000`; `node /app/server/cli.js ping` inside exits 1 with `extension not connected` (relay up, no extension); `node /app/server/cli.js tabs` inside prints `no bridge-opened tabs recorded`; writing `/work/smoke.txt` from inside succeeds and is visible on the host; `claude --version` and `codex --version` inside print the pinned versions; with `~/.codex/auth.json` present, `codex exec --sandbox danger-full-access --skip-git-repo-check -C /work "run: echo smoke-ok"`-style one-shot prints `smoke-ok` (skipped otherwise, printed as `SKIP`); `docker compose down -v` leaves no volume behind. The script uses `BRIDGE_PUBLISH_PORT` chosen free and `COMPOSE_PROJECT_NAME=ai-bridge-smoke`.
- [ ] Step 2 run it → the first failure is informative (whatever the image build or the pins reveal); fix the files until `SMOKE OK`.
- [ ] Step 3 commit `docker: smoke job — build, listening line, healthcheck, token mode, /work write, pinned CLIs; pins 2.1.317/0.171.0 confirmed on arm64`.

### Task 4: Round trip with the real Chrome

- [ ] Step 1: find how the host relay runs (`pgrep -fl server/server.js`; native host start), note the pid, stop it.
- [ ] Step 2: `docker compose up -d` with `BRIDGE_PUBLISH_PORT=8765`, copy `~/.ai-browser-bridge/token` into the `data` volume as `/data/token` (mode 600, uid 1000) **before** the relay starts (compose `up` after a one-off `docker run --rm -v data:/data` copy), wait for the extension's reconnect alarm (≤ 30 s), `docker compose exec bridge node /app/server/cli.js ping` → `pong` with `access` present; `bridge status` from the host CLI against port 8765 shows the same; container log shows `extension connected`, `access revoked (session "chrome")` (or granted if the user has pressed Grant by then).
- [ ] Step 3: `docker compose down` (keep nothing), restart the host relay the way it was running, `bridge ping` from the host works again.
- [ ] Step 4: record the outcome in the guide's status paragraph and in `test/TEST-PLAN.md` (Docker row). Commit `docs: Docker round trip on the authoring Mac (Colima): extension ↔ containerised relay, access handshake observed`.

### Task 5: Review and PR

- [ ] `npm test`; Astra review of `git diff target-guard..HEAD` plus the smoke log; fold; PR against `target-guard`.
