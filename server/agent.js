// AI Browser Bridge — token-saver agent.
//
//   bridge agent "task description" [--timeout ms] [--verbose] [--start fable-5.1] [--job name]
//
// Completes a browser task by spawning headless Claude Code sessions
// (`claude -p`), so usage bills to the user's existing Claude subscription,
// with Codex (`codex exec`) as the last resort:
//
//   ops pass 1: Opus 5.5            → judge (Fable 5.1) → pass? done
//   ops pass 2: Fable 5.1           → judge (Fable 5.1) → pass? done
//   ops pass 3: Astra 6 (medium)    → judge (Fable 5.1) → final verdict
//
// The judge only ever sees the task + the ops session's evidence report,
// never the full browsing transcript, so Fable's token spend stays minimal.
//
// Every run gets a run id. Child processes receive AI_BRIDGE_RUN_ID/AI_BRIDGE_JOB,
// the CLI forwards them, and the server traces each bridge command to
// traces/<runId>.jsonl; the run itself is appended to journal.jsonl
// (`bridge journal`). See docs/ECONOMY-MODE.md.

"use strict";

const { spawn } = require("child_process");
const crypto = require("crypto");
const path = require("path");

const { SELF_CMD, selfArgs } = require("./runtime");
const journal = require("./journal");

const OPS_LADDER = [
  { model: "claude-opus-5-5", label: "opus-5.5" },
  { model: "claude-fable-5-1", label: "fable-5.1" },
  { engine: "codex", model: "gpt-6-astra", effort: "medium", label: "astra-6" },
];
const JUDGE_MODEL = "claude-fable-5-1";

const OPS_PLAYBOOK = `You are a browser-operations agent. You control the user's real, logged-in
Chrome through the AI Browser Bridge CLI. You ARE the agent — ignore any
project instructions telling you to delegate browser tasks to \`bridge agent\`;
never invoke the \`agent\` subcommand yourself. Drive the individual bridge
commands directly, like:

    ${SELF_CMD} <cmd> [params-json] [--file js] [--out file]

Commands: ping, listTabs, newTab {"url", "newWindow"?, "windowId"?},
navigate {"tabId","url"}, snapshot {"tabId", "maxText"?, "root"?},
eval {"tabId","code"}, waitFor {"tabId","selector"}, click {"tabId","selector"} or {"tabId","x","y"},
insertText {"tabId","text"}, key {"tabId","key"}, screenshot {"tabId"} --out f.png,
pdf, download, selectTab {"tabId"}, closeTab, detach {"tabId"}.

Rules:
- Always run ping first; if it fails, report the failure and stop.
- WORK IN YOUR OWN WINDOW. Other agents may be driving other windows of this
  browser at the same time. Open your FIRST tab with
  newTab {"url":"…","newWindow":true} and note the returned windowId; open any
  further tabs with newTab {"url":"…","windowId":<that id>} (or reuse a tab
  via navigate). Never activate, navigate, or close tabs in windows you did
  not create.
- Never steal the user's focus: tabs open unfocused by default, and you must
  NOT use activateTab (it raises the window over what the user is doing). To
  screenshot, first run selectTab {"tabId"} — it makes the tab active within
  YOUR window without focusing it — then screenshot immediately.
- READ PAGES WITH snapshot, NOT SCREENSHOTS. snapshot returns the visible
  text plus every interactive element with a label, state and a CSS selector
  you can pass straight to click {"selector"} / waitFor / eval. It costs a
  fraction of a screenshot's tokens. Use eval for anything the digest lacks.
  Take a screenshot only when the digest cannot explain what you see (canvas,
  image-only content, layout questions).
- After a click, re-run snapshot (or eval) to verify focus/position before
  typing — page layouts shift while loading.
- detach from tabs and close your window's tabs when finished (unless the
  task says to leave a tab open).
- This is the user's real browser: never log out, change account settings,
  or submit destructive/irreversible forms.

When the task is done (or you are blocked), end your reply with an evidence
report in exactly this format:

EVIDENCE REPORT
Task: <restate the task>
Actions: <numbered list of what you did>
Final state: <what the page shows now / what was produced, with concrete
details such as titles, values, file paths>
Screenshots: <paths, or "none">
Blockers: <what stopped you, or "none">`;

function judgePrompt(task, evidence) {
  return `You are a strict verifier. A browser-operations agent was given this task:

TASK:
${task}

It returned this evidence report:

${evidence}

Decide whether the task was genuinely completed. Concrete details in the
evidence (titles, values, paths) count for it; vagueness, blockers, or
unverified claims count against it.

Reply with ONLY a JSON object, no other text:
{"verdict": "pass" or "fail", "feedback": "<if fail: what is missing and what the next attempt should do differently; if pass: brief confirmation>"}`;
}

// Spawn `claude -p` and resolve with the parsed --output-format json result.
// Injectable via deps for testing.
function runClaude({ model, prompt, allowedTools, timeoutMs, verbose, env }) {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--model", model, "--output-format", "json"];
    if (allowedTools && allowedTools.length) {
      args.push("--allowedTools", allowedTools.join(","));
      // Recursion guard: the ops session must never spawn the agent itself.
      args.push("--disallowedTools", `Bash(${SELF_CMD} agent:*)`);
    } else {
      args.push("--disallowedTools", "Bash,Edit,Write,WebFetch,WebSearch");
    }
    // AI_BRIDGE_AGENT marks every process spawned by the agent (and their
    // children), so a recursive `bridge agent` call can be refused at startup
    // no matter how the ops model spells the command.
    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AI_BRIDGE_AGENT: "1", ...(env || {}) },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude (${model}) timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; if (verbose) process.stderr.write(d); });
    child.on("error", (e) => {
      clearTimeout(timer);
      if (e.code === "ENOENT") {
        reject(new Error("`claude` CLI not found — install Claude Code and log in first"));
      } else reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude (${model}) exited ${code}: ${err.trim() || out.trim()}`));
      }
      let parsed;
      try { parsed = JSON.parse(out); }
      catch { return reject(new Error(`claude (${model}) returned non-JSON output: ${out.slice(0, 400)}`)); }
      resolve(parsed);
    });
  });
}

// Codex ops rung. Mirrors runClaude's result shape ({result, usage}) so the
// ladder treats both engines alike. The sandbox allows network so the bridge
// CLI can reach the localhost relay; cwd stays the caller's so screenshots land
// where Claude ops sessions put them.
function runCodex({ model, effort, prompt, timeoutMs, verbose, env }) {
  const fs = require("fs");
  const os = require("os");
  return new Promise((resolve, reject) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-codex-"));
    const outPath = path.join(tmp, "last.txt");
    const args = ["exec", "--skip-git-repo-check", "--ephemeral",
      "-m", model, "-c", `model_reasoning_effort="${effort || "medium"}"`,
      "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true",
      "-C", process.cwd(), "-o", outPath, prompt];
    const child = spawn("codex", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AI_BRIDGE_AGENT: "1", ...(env || {}) },
    });
    let err = "";
    const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error(`codex (${model}) timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => { if (verbose) process.stderr.write(d); });
    child.stderr.on("data", (d) => { err += d; if (verbose) process.stderr.write(d); });
    child.on("error", (e) => {
      clearTimeout(timer);
      cleanup();
      reject(e.code === "ENOENT" ? new Error("`codex` CLI not found — install Codex and log in first") : e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let out = "";
      try { out = fs.readFileSync(outPath, "utf8").trim(); } catch {}
      cleanup();
      if (code !== 0) return reject(new Error(`codex (${model}) exited ${code}: ${err.trim().slice(-400)}`));
      resolve({ result: out, usage: {} });
    });
  });
}

function runModel(opts) {
  return opts.engine === "codex" ? runCodex(opts) : runClaude(opts);
}

// Extract the first {...} JSON object from judge output.
function parseVerdict(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (obj.verdict === "pass" || obj.verdict === "fail") {
      return { verdict: obj.verdict, feedback: String(obj.feedback || "") };
    }
  } catch { /* fall through */ }
  return null;
}

function extractEvidence(resultText) {
  const idx = resultText.indexOf("EVIDENCE REPORT");
  return idx === -1 ? resultText : resultText.slice(idx);
}

function usageOf(res) {
  const u = res.usage || {};
  return {
    input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    output: u.output_tokens || 0,
    costUsd: res.total_cost_usd,
  };
}

// The escalation ladder. `run` is injectable for tests.
async function runAgent(task, opts = {}, run = runModel) {
  const timeoutMs = opts.timeoutMs || 10 * 60 * 1000;
  const verbose = !!opts.verbose;
  const runId = opts.runId || crypto.randomBytes(6).toString("hex");
  const job = opts.job ? String(opts.job).trim() : null;
  // Child model processes inherit these; the CLI tags every bridge command
  // with them and the server writes traces/<runId>.jsonl.
  const childEnv = { AI_BRIDGE_RUN_ID: runId, ...(job ? { AI_BRIDGE_JOB: job } : {}) };
  const startedAt = new Date().toISOString();
  const stages = [];
  let feedback = "";
  let lastEvidence = "";
  let finalVerdict = null;

  const startIdx = opts.start
    ? OPS_LADDER.findIndex(r => r.label === opts.start || r.model === opts.start || r.label.startsWith(opts.start))
    : 0;
  if (startIdx < 0) throw new Error(`unknown --start model "${opts.start}"; use one of ${OPS_LADDER.map(r => r.label).join(", ")}`);
  // --only: stay on the start rung (no escalation to pricier models on a fail)
  const rungs = opts.only ? OPS_LADDER.slice(startIdx, startIdx + 1) : OPS_LADDER.slice(startIdx);
  for (const rung of rungs) {
    const opsPrompt = [
      OPS_PLAYBOOK,
      feedback ? `A previous attempt failed review. Judge feedback:\n${feedback}` : "",
      `TASK:\n${task}`,
    ].filter(Boolean).join("\n\n");

    const opsRes = await run({
      engine: rung.engine,
      model: rung.model,
      effort: rung.effort,
      prompt: opsPrompt,
      allowedTools: [`Bash(${SELF_CMD}:*)`],
      timeoutMs,
      verbose,
      env: childEnv,
    });
    lastEvidence = extractEvidence(String(opsRes.result || ""));
    stages.push({ stage: `ops:${rung.label}`, ...usageOf(opsRes) });

    let judgeRes = await run({
      model: JUDGE_MODEL,
      prompt: judgePrompt(task, lastEvidence),
      allowedTools: [],
      timeoutMs,
      verbose,
    });
    stages.push({ stage: "judge:fable-5.1", ...usageOf(judgeRes) });

    let verdict = parseVerdict(String(judgeRes.result || ""));
    if (!verdict) {
      // one re-ask on malformed JSON
      judgeRes = await run({
        model: JUDGE_MODEL,
        prompt: judgePrompt(task, lastEvidence) +
          "\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object.",
        allowedTools: [],
        timeoutMs,
        verbose,
      });
      stages.push({ stage: "judge:fable-5.1(retry)", ...usageOf(judgeRes) });
      verdict = parseVerdict(String(judgeRes.result || "")) ||
        { verdict: "fail", feedback: String(judgeRes.result || "judge output unreadable") };
    }

    finalVerdict = verdict;
    if (verdict.verdict === "pass") break;
    feedback = verdict.feedback;
  }

  const record = journalRecord({ runId, job, task, startedAt, stages, verdict: finalVerdict, mode: "regular" });
  let journalFile = null;
  if (!opts.noJournal) {
    try { journalFile = journal.appendJournal(record); }
    catch (e) { if (verbose) console.error(`[agent] journal write failed: ${e.message}`); }
  }
  return { verdict: finalVerdict, evidence: lastEvidence, stages, runId, job, record, journalFile };
}

// One journal.jsonl line for a finished run. Domains come from the run's trace
// (newTab/navigate URLs), so auto signatures group by site even without --job.
function journalRecord({ runId, job, task, startedAt, stages, verdict, mode }) {
  const domains = journal.domainsFromTrace(journal.readTrace(runId));
  const sum = (k) => stages.reduce((n, s) => n + (Number(s[k]) || 0), 0);
  return {
    runId, job, signature: journal.signatureOf({ job, task, domains }), task,
    startedAt, endedAt: new Date().toISOString(), mode,
    verdict: verdict ? verdict.verdict : "fail",
    stages: stages.map((s) => ({ stage: s.stage, input: s.input, output: s.output, costUsd: s.costUsd })),
    costUsd: sum("costUsd"), inputTokens: sum("input"), outputTokens: sum("output"),
    domains, trace: journal.traceFile(runId),
  };
}

function printReport({ verdict, evidence, stages }) {
  console.log(`\n=== VERDICT: ${verdict.verdict.toUpperCase()} ===`);
  if (verdict.feedback) console.log(verdict.feedback);
  console.log(`\n${evidence}\n`);
  console.log("=== TOKEN / COST SUMMARY ===");
  let cost = 0;
  for (const s of stages) {
    const c = typeof s.costUsd === "number" ? s.costUsd : 0;
    cost += c;
    console.log(
      `${s.stage.padEnd(22)} in:${String(s.input).padStart(8)}  out:${String(s.output).padStart(7)}` +
      (typeof s.costUsd === "number" ? `  $${s.costUsd.toFixed(4)}` : "")
    );
  }
  if (cost > 0) console.log(`${"total".padEnd(22)} ${"".padStart(26)}  $${cost.toFixed(4)}`);
}

function printJournalLine({ runId, job, journalFile, record }) {
  const cmds = journal.readTrace(runId).length;
  console.log(`run ${runId}${job ? ` job=${job}` : ""}: ${cmds} bridge command(s) traced` +
    (record && record.domains.length ? ` on ${record.domains.join(", ")}` : "") +
    (journalFile ? `; journaled (bridge journal --trace ${runId})` : ""));
}

async function main(argv) {
  if (process.env.AI_BRIDGE_AGENT === "1") {
    console.error(
      "ERROR: recursive `bridge agent` invocation blocked — you are already running " +
      "inside the agent. Drive the individual bridge commands (ping, newTab, eval, ...) directly."
    );
    process.exit(2);
  }
  const args = argv.slice();
  const opts = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timeout") opts.timeoutMs = Number(args[++i]);
    else if (args[i] === "--verbose") opts.verbose = true;
    else if (args[i] === "--start") opts.start = args[++i];
    else if (args[i] === "--only") opts.only = true;
    else if (args[i] === "--job") opts.job = args[++i];
    else if (args[i] === "--help" || args[i] === "-h") { rest.length = 0; break; }
    else rest.push(args[i]);
  }
  const task = rest.join(" ").trim();
  if (!task) {
    console.error('usage: bridge agent "task description" [--timeout ms] [--verbose] [--start opus-5.5|fable-5.1|astra-6] [--only] [--job name]');
    process.exit(2);
  }

  // Pre-flight: bridge must be up before burning any model tokens.
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, selfArgs(["ping"]), { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => code === 0 ? resolve()
      : reject(new Error(`bridge ping failed — is the server running and the extension connected? ${err.trim()}`)));
    child.on("error", reject);
  });

  const report = await runAgent(task, opts);
  printReport(report);
  printJournalLine(report);
  process.exit(report.verdict.verdict === "pass" ? 0 : 1);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}

module.exports = { main, runAgent, journalRecord, parseVerdict, extractEvidence, OPS_LADDER, JUDGE_MODEL };
