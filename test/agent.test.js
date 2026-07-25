#!/usr/bin/env node
// Unit tests for the token-saver agent: escalation ladder, judge-JSON
// parsing, and evidence extraction. Uses an injected mock runner — no real
// claude CLI, no network.

const { runAgent, parseVerdict, extractEvidence, OPS_LADDER, JUDGE_MODEL } =
  require("../server/agent.js");

let failures = 0;
const assert = (cond, name) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
};

// Mock runner factory: scripted judge verdicts, records every call.
function mockRun(judgeVerdicts) {
  const calls = [];
  let judgeIdx = 0;
  const run = async ({ model, prompt }) => {
    calls.push({ model, prompt });
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

  // 3) first-pass success: haiku ops + one judge call, no escalation
  {
    const m = mockRun(['{"verdict":"pass","feedback":"done"}']);
    const r = await runAgent("test task", {}, m.run);
    assert(r.verdict.verdict === "pass", "ladder: pass on first rung");
    assert(m.calls.length === 2, "ladder: exactly 2 calls (haiku ops + judge)");
    assert(m.calls[0].model === "claude-haiku-4-5", "ladder: first ops model is haiku");
    assert(m.calls[1].model === JUDGE_MODEL, "ladder: judge is fable");
  }

  // 4) escalation: haiku fails -> sonnet passes; feedback forwarded
  {
    const m = mockRun(['{"verdict":"fail","feedback":"wrong tab"}', '{"verdict":"pass","feedback":"ok"}']);
    const r = await runAgent("test task", {}, m.run);
    assert(r.verdict.verdict === "pass", "escalation: pass on second rung");
    assert(m.calls[2].model === "claude-sonnet-5", "escalation: second ops model is sonnet");
    assert(m.calls[2].prompt.includes("wrong tab"), "escalation: judge feedback forwarded to retry");
  }

  // 5) full ladder exhausted: all three fail -> final verdict fail, fable was last ops rung
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
      "exhausted: ops models ran in ladder order haiku->sonnet->fable");
  }

  // 6) malformed judge JSON: one re-ask, then treated as fail
  {
    const m = mockRun(["not json at all", "still not json", '{"verdict":"pass","feedback":"ok"}']);
    const r = await runAgent("test task", {}, m.run);
    // first judge call garbage -> retry also garbage -> fail -> escalate to sonnet -> judge passes
    assert(r.verdict.verdict === "pass", "malformed judge: recovers via escalation");
    const judgeCalls = m.calls.filter((c) => c.prompt.includes("strict verifier"));
    assert(judgeCalls[1].prompt.includes("not valid JSON"), "malformed judge: re-ask prompt sent");
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
