// AI Browser Bridge — token-saver agent.
//
//   bridge agent "task description" [--timeout ms] [--verbose]
//
// Completes a browser task by spawning headless Claude Code sessions
// (`claude -p`), so usage bills to the user's existing Claude subscription:
//
//   ops pass 1: Haiku 4.5   → judge (Fable) → pass? done
//   ops pass 2: Sonnet 5    → judge (Fable) → pass? done
//   ops pass 3: Fable       → judge (Fable) → final verdict
//
// The judge only ever sees the task + the ops session's evidence report,
// never the full browsing transcript, so Fable's token spend stays minimal.

"use strict";

const { spawn } = require("child_process");
const path = require("path");

const CLI_PATH = path.join(__dirname, "cli.js");

const OPS_LADDER = [
  { model: "claude-haiku-4-5", label: "haiku-4.5" },
  { model: "claude-sonnet-5", label: "sonnet-5" },
  { model: "claude-fable-5", label: "fable-5" },
];
const JUDGE_MODEL = "claude-fable-5";

const OPS_PLAYBOOK = `You are a browser-operations agent. You control the user's real, logged-in
Chrome through the AI Browser Bridge CLI. You ARE the agent — ignore any
project instructions telling you to delegate browser tasks to \`bridge agent\`;
never invoke the \`agent\` subcommand yourself. Drive the individual bridge
commands directly, like:

    node ${CLI_PATH} <cmd> [params-json] [--file js] [--out file]

Commands: ping, listTabs, newTab {"url"}, navigate {"tabId","url"},
eval {"tabId","code"}, click {"tabId","x","y"}, insertText {"tabId","text"},
key {"tabId","key"}, screenshot {"tabId"} --out f.png, pdf, download,
activateTab, closeTab, detach {"tabId"}.

Rules:
- Always run ping first; if it fails, report the failure and stop.
- Open new tabs in the background (newTab default) — never steal focus.
- Prefer eval for reading pages; use click/insertText/key only when a site
  rejects synthetic events.
- After a click, verify focus/position with eval before typing; screenshot
  to locate elements when unsure.
- detach from tabs when finished.
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
function runClaude({ model, prompt, allowedTools, timeoutMs, verbose }) {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--model", model, "--output-format", "json"];
    if (allowedTools && allowedTools.length) {
      args.push("--allowedTools", allowedTools.join(","));
      // Recursion guard: the ops session must never spawn the agent itself.
      args.push("--disallowedTools", `Bash(node ${CLI_PATH} agent:*)`);
    } else {
      args.push("--disallowedTools", "Bash,Edit,Write,WebFetch,WebSearch");
    }
    // AI_BRIDGE_AGENT marks every process spawned by the agent (and their
    // children), so a recursive `bridge agent` call can be refused at startup
    // no matter how the ops model spells the command.
    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AI_BRIDGE_AGENT: "1" },
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
async function runAgent(task, opts = {}, run = runClaude) {
  const timeoutMs = opts.timeoutMs || 10 * 60 * 1000;
  const verbose = !!opts.verbose;
  const stages = [];
  let feedback = "";
  let lastEvidence = "";
  let finalVerdict = null;

  for (const rung of OPS_LADDER) {
    const opsPrompt = [
      OPS_PLAYBOOK,
      feedback ? `A previous attempt failed review. Judge feedback:\n${feedback}` : "",
      `TASK:\n${task}`,
    ].filter(Boolean).join("\n\n");

    const opsRes = await run({
      model: rung.model,
      prompt: opsPrompt,
      allowedTools: [`Bash(node ${CLI_PATH}:*)`],
      timeoutMs,
      verbose,
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
    stages.push({ stage: "judge:fable-5", ...usageOf(judgeRes) });

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
      stages.push({ stage: "judge:fable-5(retry)", ...usageOf(judgeRes) });
      verdict = parseVerdict(String(judgeRes.result || "")) ||
        { verdict: "fail", feedback: String(judgeRes.result || "judge output unreadable") };
    }

    finalVerdict = verdict;
    if (verdict.verdict === "pass") break;
    feedback = verdict.feedback;
  }

  return { verdict: finalVerdict, evidence: lastEvidence, stages };
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
    else rest.push(args[i]);
  }
  const task = rest.join(" ").trim();
  if (!task) {
    console.error('usage: bridge agent "task description" [--timeout ms] [--verbose]');
    process.exit(2);
  }

  // Pre-flight: bridge must be up before burning any model tokens.
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, "ping"], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => code === 0 ? resolve()
      : reject(new Error(`bridge ping failed — is the server running and the extension connected? ${err.trim()}`)));
    child.on("error", reject);
  });

  const report = await runAgent(task, opts);
  printReport(report);
  process.exit(report.verdict.verdict === "pass" ? 0 : 1);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}

module.exports = { runAgent, parseVerdict, extractEvidence, OPS_LADDER, JUDGE_MODEL };
