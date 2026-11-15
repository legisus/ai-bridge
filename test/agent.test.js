#!/usr/bin/env node
// Unit tests for the token-saver agent: escalation ladder, judge-JSON
// parsing, and evidence extraction. Uses an injected mock runner — no real
// claude CLI, no network.

const fs = require("fs");
const os = require("os");
// Journal/trace files go to a temp state dir, never the real ~/.ai-browser-bridge.
process.env.AI_BRIDGE_HOME = fs.mkdtempSync(require("path").join(os.tmpdir(), "ai-bridge-agent-"));
const { runAgent, journalRecord, parseVerdict, extractEvidence, OPS_LADDER, JUDGE_MODEL } =
  require("../server/agent.js");
const journal = require("../server/journal.js");

let failures = 0;
const assert = (cond, name) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
};

// Mock runner factory: scripted judge verdicts, records every call.
function mockRun(judgeVerdicts) {
  const calls = [];
  let judgeIdx = 0;
  const run = async ({ engine, model, effort, prompt, env }) => {
    calls.push({ engine, model, effort, prompt, env });
    if (model === JUDGE_MODEL && prompt.includes("strict verifier")) {
      const v = judgeVerdicts[judgeIdx++];
      return { result: v, usage: { input_tokens: 100, output_tokens: 20 }, total_cost_usd: 0.01 };
    }
    return {
      result: `did stuff\nEVIDENCE REPORT\nTask: t\nActions: 1. x\nFinal state: ok (${model})\nScreenshots: none\nBlockers: none`,
      usage: { input_tokens: 5000, output_tokens: 800 },
      total_cost_usd: 0.05,
    };
  };
  return { run, calls };
}

(async () => {
  // 1) parseVerdict
  assert(parseVerdict('{"verdict":"pass","feedback":"ok"}').verdict === "pass", "parseVerdict: clean pass");
  assert(parseVerdict('noise {"verdict":"fail","feedback":"missing"} trailing').feedback === "missing",
    "parseVerdict: JSON embedded in prose");
  assert(parseVerdict("no json here") === null, "parseVerdict: garbage -> null");
  assert(parseVerdict('{"verdict":"maybe"}') === null, "parseVerdict: invalid verdict -> null");

  // 2) evidence extraction
  assert(extractEvidence("preamble\nEVIDENCE REPORT\nTask: x").startsWith("EVIDENCE REPORT"),
    "extractEvidence: slices at marker");
  assert(extractEvidence("no marker at all") === "no marker at all",
    "extractEvidence: falls back to full text");

  // 3) first-pass success: opus ops + one judge call, no escalation
  {
    const m = mockRun(['{"verdict":"pass","feedback":"done"}']);
    const r = await runAgent("test task", {}, m.run);
    assert(r.verdict.verdict === "pass", "ladder: pass on first rung");
    assert(m.calls.length === 2, "ladder: exactly 2 calls (opus ops + judge)");
    assert(m.calls[0].model === "claude-opus-5-5", "ladder: first ops model is opus 5.5");
    assert(m.calls[1].model === JUDGE_MODEL, "ladder: judge is fable");
  }

  // 4) escalation: opus fails -> fable passes; feedback forwarded
  {
    const m = mockRun(['{"verdict":"fail","feedback":"wrong tab"}', '{"verdict":"pass","feedback":"ok"}']);
    const r = await runAgent("test task", {}, m.run);
    assert(r.verdict.verdict === "pass", "escalation: pass on second rung");
    assert(m.calls[2].model === "claude-fable-5-1", "escalation: second ops model is fable 5.1");
    assert(m.calls[2].prompt.includes("wrong tab"), "escalation: judge feedback forwarded to retry");
  }

  // 5) full ladder exhausted: all three fail -> final verdict fail, codex astra was last ops rung
  {
    const m = mockRun([
      '{"verdict":"fail","feedback":"a"}',
      '{"verdict":"fail","feedback":"b"}',
      '{"verdict":"fail","feedback":"c"}',
    ]);
    const r = await runAgent("test task", {}, m.run);
    assert(r.verdict.verdict === "fail", "exhausted: final verdict is fail");
    const opsModels = m.calls.filter((c) => !c.prompt.includes("strict verifier")).map((c) => c.model);
    assert(JSON.stringify(opsModels) === JSON.stringify(OPS_LADDER.map((r2) => r2.model)),
      "exhausted: ops models ran in ladder order opus->fable->astra");
    const last = m.calls.filter((c) => !c.prompt.includes("strict verifier")).pop();
    assert(last.engine === "codex" && last.effort === "medium", "exhausted: last rung is codex at medium effort");
  }

  // 6) malformed judge JSON: one re-ask, then treated as fail
  {
    const m = mockRun(["not json at all", "still not json", '{"verdict":"pass","feedback":"ok"}']);
    const r = await runAgent("test task", {}, m.run);
    // first judge call garbage -> retry also garbage -> fail -> escalate to fable -> judge passes
    assert(r.verdict.verdict === "pass", "malformed judge: recovers via escalation");
    const judgeCalls = m.calls.filter((c) => c.prompt.includes("strict verifier"));
    assert(judgeCalls[1].prompt.includes("not valid JSON"), "malformed judge: re-ask prompt sent");
  }

  // 8) journal: run id + job flow to the ops env, the run is journaled with a job signature
  {
    const m = mockRun(['{"verdict":"pass","feedback":"done"}']);
    const r = await runAgent("invoice trip 123", { job: "toll-invoices", runId: "testrun0001" }, m.run);
    assert(r.runId === "testrun0001" && r.job === "toll-invoices", "journal: runId/job returned");
    assert(m.calls[0].env && m.calls[0].env.AI_BRIDGE_RUN_ID === "testrun0001" && m.calls[0].env.AI_BRIDGE_JOB === "toll-invoices",
      "journal: ops rung gets AI_BRIDGE_RUN_ID/AI_BRIDGE_JOB");
    assert(r.record.signature === "job:toll-invoices" && r.record.verdict === "pass" && r.record.mode === "regular",
      "journal: record has job signature + verdict");
    assert(Math.abs(r.record.costUsd - 0.06) < 1e-9 && r.record.inputTokens === 5100 && r.record.outputTokens === 820,
      "journal: cost/tokens summed over ops + judge");
    const rows = journal.summarize(journal.readJournal({}));
    assert(rows.some((x) => x.signature === "job:toll-invoices" && x.runs === 1), "journal: appended to journal.jsonl");
  }

  // 9) journal: auto signature uses domains from the run's trace
  {
    journal.appendTrace("testrun0002", { cmd: "newTab", params: { url: "https://www.kbb.com/x" }, ok: true });
    const m = mockRun(['{"verdict":"pass","feedback":"ok"}']);
    const r = await runAgent("Get KBB value for 9GYW724", { runId: "testrun0002", noJournal: true }, m.run);
    assert(r.record.signature === "auto:kbb.com|get kbb value for #gyw#" && r.journalFile === null,
      "journal: auto signature from trace domains; noJournal skips the write");
    assert(m.calls[0].env.AI_BRIDGE_JOB === undefined, "journal: no AI_BRIDGE_JOB without --job");
  }

  // 10) economy mode paths: audit -> economy, economy without judge, fallback + repair
  {
    const jobs = require("../server/jobs.js");
    const recipe = { job: "toll", version: 2, risk: "read", task: "pull", steps: [{ do: "newTab", url: "u" }], output: "rows" };
    let recipeOk = true;
    const recipeCalls = [];
    const deps = {
      loadRecipe: () => recipe,
      runRecipe: async (r, o) => {
        recipeCalls.push({ version: r.version, env: o.env });
        return recipeOk
          ? { ok: true, evidence: "EVIDENCE REPORT\nTask: pull\nFinal state: 3 rows", steps: [], output: [1, 2, 3] }
          : { ok: false, evidence: "EVIDENCE REPORT\nBlockers: LOGIN REQUIRED", steps: [], failure: { step: 2, do: "assert", error: "LOGIN REQUIRED", digest: { url: "x" } } };
      },
      propose: async ({ job, previous, failure, traces }) => ({ job, version: (previous.version || 0) + 1, steps: [], _usage: { input: 1, output: 1 }, _failure: failure, _traces: traces }),
    };
    // seed: job in audit with the recipe
    jobs.putJob({ job: "toll", mode: "audit", risk: "read", auditPasses: 0, auditRequired: 3, canaryEvery: 3, runsSinceCanary: 0, recipeVersion: 2, history: [] });

    // audit pass #1: recipe + judge, no ops model
    let m = mockRun(['{"verdict":"pass","feedback":"ok"}']);
    let r = await runAgent("pull", { job: "toll", runId: "eco00000001" }, m.run, deps);
    assert(r.mode === "audit" && r.verdict.verdict === "pass", "economy: audit run passes via recipe + judge");
    assert(m.calls.length === 1 && m.calls[0].model === JUDGE_MODEL, "economy: audit spends only the judge call");
    assert(recipeCalls[0].env.AI_BRIDGE_RUN_ID === "eco00000001" && recipeCalls[0].env.AI_BRIDGE_JOB === "toll", "economy: recipe run is traced under the run id");
    assert(r.stages[0].stage === "recipe:toll@v2" && r.stages[0].costUsd === 0, "economy: recipe stage costs 0");
    assert(jobs.getJob("toll").auditPasses === 1 && jobs.getJob("toll").mode === "audit", "economy: audit pass counted");

    // audit passes #2, #3 -> economy
    for (const id of ["eco00000002", "eco00000003"]) await runAgent("pull", { job: "toll", runId: id }, mockRun(['{"verdict":"pass","feedback":"ok"}']).run, deps);
    assert(jobs.getJob("toll").mode === "economy", "economy: third audit pass switches to economy");

    // economy run: no model at all
    m = mockRun([]);
    r = await runAgent("pull", { job: "toll", runId: "eco00000004" }, m.run, deps);
    assert(r.mode === "economy" && r.verdict.verdict === "pass" && m.calls.length === 0 && r.record.costUsd === 0, "economy: run with zero model calls");

    // second economy run, then the 3rd is a canary (canaryEvery=3) -> judge called once
    await runAgent("pull", { job: "toll", runId: "eco00000005" }, mockRun([]).run, deps);
    m = mockRun(['{"verdict":"pass","feedback":"still fine"}']);
    r = await runAgent("pull", { job: "toll", runId: "eco00000006" }, m.run, deps);
    assert(m.calls.length === 1 && /canary/.test(r.stages[0].stage) && r.verdict.feedback.includes("canary"), "economy: periodic canary judges the recipe evidence");
    assert(jobs.getJob("toll").runsSinceCanary === 0, "economy: canary resets the counter");

    // recipe failure -> fallback to the ladder (ops opus + judge), state back to audit, recipe repaired
    recipeOk = false;
    m = mockRun(['{"verdict":"pass","feedback":"done by model"}']);
    r = await runAgent("pull", { job: "toll", runId: "eco00000007" }, m.run, deps);
    assert(r.mode === "economy-fallback" && r.verdict.verdict === "pass", "fallback: economy failure completes via the ladder");
    assert(m.calls[0].model === "claude-opus-5-5" && m.calls[0].prompt.includes("LOGIN REQUIRED"), "fallback: ops model told why the recipe failed");
    assert(r.repaired && r.repaired.version === 3 && r.repaired._failure.error === "LOGIN REQUIRED", "fallback: recipe repaired from the failure + fallback trace");
    const st = jobs.getJob("toll");
    assert(st.mode === "audit" && st.auditPasses === 0 && st.repairNeeded === false && st.recipeVersion === 3, "fallback: job back in audit with the repaired recipe");
    assert(r.stages.some((s) => s.stage.startsWith("repair:")), "fallback: repair stage reported");

    // judge rejects recipe evidence in audit -> fallback too; --no-repair skips repair
    recipeOk = true;
    m = mockRun(['{"verdict":"fail","feedback":"rows look stale"}', '{"verdict":"pass","feedback":"ok"}']);
    r = await runAgent("pull", { job: "toll", runId: "eco00000008", noRepair: true }, m.run, deps);
    assert(r.mode === "audit-fallback" && r.verdict.verdict === "pass" && r.repaired === null, "fallback: judge-fail in audit falls back; --no-repair");
    assert(jobs.getJob("toll").repairNeeded === true, "fallback: repair still flagged when skipped");

    // repairNeeded -> next run goes regular (no recipe attempt)
    recipeCalls.length = 0;
    r = await runAgent("pull", { job: "toll", runId: "eco00000009" }, mockRun(['{"verdict":"pass","feedback":"ok"}']).run, deps);
    assert(r.mode === "regular" && recipeCalls.length === 0, "fallback: repair-needed job runs regular until repaired");
  }

  // 7) recursion guard: agent.js refuses to start when spawned by the agent
  {
    const { execFile } = require("child_process");
    const path = require("path");
    const res = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [path.join(__dirname, "..", "server", "agent.js"), "some task"],
        { env: { ...process.env, AI_BRIDGE_AGENT: "1" } },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stderr })
      );
    });
    assert(res.code === 2, "recursion guard: exits 2 under AI_BRIDGE_AGENT=1");
    assert(res.stderr.includes("recursive"), "recursion guard: explains the refusal");
  }

  console.log(failures === 0 ? "\nAll agent tests passed." : `\n${failures} test(s) FAILED.`);
  process.exit(failures ? 1 : 0);
})();
