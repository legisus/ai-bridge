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
  const run = async (opts) => {
    const { model, prompt } = opts;
    calls.push({ ...opts });
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

  // 8b) tab lease: opened with runId/client/keepTabs, ended on every exit path, counters journaled
  function mockLease() {
    const calls = [];
    const open = async (o) => { calls.push({ open: o }); return { end: async () => { calls.push({ end: o.runId }); return { opened: 2, closed: 1, retained: 1, kept: 0 }; }, close() {} }; };
    return { open, calls };
  }
  {
    const m = mockRun(['{"verdict":"pass","feedback":"ok"}']); const L = mockLease();
    const r = await runAgent("test task", { runId: "leaseok00001" }, m.run, { openLease: L.open });
    assert(L.calls[0].open.runId === "leaseok00001" && L.calls[0].open.client === "bridge agent" && L.calls[0].open.keepTabs === false, "lease: opened with runId/client/keepTabs");
    assert(L.calls.filter((c) => c.end === "leaseok00001").length === 1 && r.record.tabsOpened === 2 && r.record.tabsClosed === 1 && r.record.tabsRetained === 1 && r.record.keptTabs === 0, "lease: runEnd sent once; counters in the journal record");
    assert(m.calls[0].env.AI_BRIDGE_CLIENT === "bridge agent", "lease: children get AI_BRIDGE_CLIENT");
  }
  {
    const m = mockRun(['{"verdict":"fail","feedback":"no"}', '{"verdict":"fail","feedback":"no"}', '{"verdict":"fail","feedback":"no"}']); const L = mockLease();
    await runAgent("test task", {}, m.run, { openLease: L.open });
    assert(L.calls.filter((c) => c.end).length === 1, "lease: a run that fails every rung still sends runEnd exactly once");
  }
  {
    const L = mockLease(); const thrower = async () => { throw new Error("model exploded"); };
    let threw = false; try { await runAgent("t", {}, thrower, { openLease: L.open }); } catch { threw = true; }
    assert(threw && L.calls.some((c) => c.end), "lease: runEnd sent even when the ladder throws");
  }
  {
    const m = mockRun(['{"verdict":"pass","feedback":"ok"}']); const L = mockLease();
    await runAgent("open the page and leave the tab open for me", {}, m.run, { openLease: L.open });
    assert(L.calls[0].open.keepTabs === true, "lease: 'leave the tab open' in the task → keepTabs");
    const L2 = mockLease(); await runAgent("t", { keepTabs: true }, m.run, { openLease: L2.open });
    assert(L2.calls[0].open.keepTabs === true, "lease: --keep-tabs → keepTabs");
  }
  {
    const m = mockRun(['{"verdict":"pass","feedback":"ok"}']);
    const r = await runAgent("t", {}, m.run, { openLease: async () => { throw new Error("ECONNREFUSED"); } });
    assert(r.verdict.verdict === "pass" && r.record.tabsOpened === undefined, "lease: lease failure does not fail the run; counters omitted");
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

  // 11) automatic mode: untagged tasks are matched to jobs, verified once per wording, learned after 3 passes
  {
    const jobs = require("../server/jobs.js");
    const { MATCH_MODEL } = require("../server/agent.js");
    const tollTask = "Toll Roads transactions pull (read-only): on secure.thetollroads.com Find a Transaction, set From = 7 days ago and To = today, click VIEW, return every row as JSON plus the row count.";
    const recipe = { job: "tr", version: 1, risk: "read", task: tollTask, steps: [{ do: "newTab", url: "u" }], output: "rows" };
    const deps = {
      loadRecipe: (j) => (j === "tr" ? recipe : null),
      runRecipe: async () => ({ ok: true, evidence: "EVIDENCE REPORT\nFinal state: 3 rows", steps: [], output: [1, 2, 3] }),
      propose: async ({ job, task, traces }) => ({ job, version: 1, risk: "read", task, steps: [], _usage: { input: 1, output: 1 }, _n: traces.length }),
    };
    jobs.putJob({ job: "tr", mode: "economy", risk: "read", auditPasses: 3, auditRequired: 3, canaryEvery: 5, runsSinceCanary: 0, recipeVersion: 1, task: tollTask, taskVariants: [], history: [] });

    // a) similar wording with the same host → matched; economy but judged once (new wording)
    const reworded = "Please open https://secure.thetollroads.com/accounts/statements/transaction, Find a Transaction for the last 7 days (From = today-7, To = today), click VIEW and return the rows as JSON with the row count.";
    let m = mockRun(['{"verdict":"pass","feedback":"rows ok"}']);
    let r = await runAgent(reworded, { runId: "auto0000001" }, m.run, deps);
    assert(r.autoMatch && r.autoMatch.job === "tr" && !r.autoMatch.exact, "auto: untagged task matched to job by host + words");
    assert(r.mode === "economy" && m.calls.length === 1 && m.calls[0].model === JUDGE_MODEL, "auto: new wording in economy is judged exactly once");
    assert(jobs.getJob("tr").taskVariants.length === 1, "auto: passing wording remembered as a variant");

    // b) same wording again → exact → pure economy, no model
    m = mockRun([]);
    r = await runAgent(reworded, { runId: "auto0000002" }, m.run, deps);
    assert(r.autoMatch.exact === true && r.mode === "economy" && m.calls.length === 0, "auto: known wording runs free");

    // c) uncertain wording → classifier (MATCH_MODEL) decides; it says yes → judged economy run
    const vague = "toll roads: what did I pay on secure.thetollroads.com recently? json please";
    m = mockRun(['{"verdict":"pass","feedback":"ok"}']);
    const baseRun = m.run;
    const calls = m.calls;
    const run2 = async (o) => (o.model === MATCH_MODEL ? (calls.push(o), { result: '{"job":"tr","confidence":0.9,"why":"same pull"}', usage: { input_tokens: 800, output_tokens: 20 }, total_cost_usd: 0.001 }) : baseRun(o));
    r = await runAgent(vague, { runId: "auto0000003" }, run2, deps);
    assert(r.autoMatch && r.autoMatch.byModel && r.autoMatch.job === "tr", "auto: classifier settles an uncertain match");
    assert(calls[0].model === MATCH_MODEL && r.stages[0].stage === `match:${MATCH_MODEL}` && r.mode === "economy", "auto: match stage recorded, recipe used");

    // d) classifier says none → regular ladder, no job
    const run3 = async (o) => (o.model === MATCH_MODEL ? { result: '{"job":null,"confidence":0.2}', usage: {} } : baseRun(o));
    m = mockRun(['{"verdict":"pass","feedback":"ok"}']);
    r = await runAgent("toll roads: add a vehicle 9ABC123 on secure.thetollroads.com and return the result as JSON", { runId: "auto0000004" }, async (o) => (o.model === MATCH_MODEL ? { result: '{"job":null}', usage: {} } : m.run(o)), deps);
    assert(!r.autoMatch && r.mode === "regular" && r.job === null, "auto: classifier 'none' → regular run without a job");

    // e) matched but the judge rejects the recipe evidence for this task → mismatch: one-off run, job not penalised
    const before = jobs.getJob("tr");
    m = mockRun(['{"verdict":"fail","feedback":"task wants vehicles, not transactions"}', '{"verdict":"pass","feedback":"ok"}']);
    r = await runAgent("Open https://secure.thetollroads.com/accounts/statements/transaction, Find a Transaction, click VIEW, return the rows as JSON with the row count, then ALSO list my vehicles", { runId: "auto0000005" }, m.run, deps);
    assert(r.mismatch === true && r.job === null && r.mode === "regular" && r.verdict.verdict === "pass", "auto: judge-fail on heuristic match = mismatch, task completed by the ladder");
    const after = jobs.getJob("tr");
    assert(after.mode === "economy" && !after.repairNeeded && after.auditPasses === before.auditPasses, "auto: mismatched job keeps its state");
    assert(!m.calls[1].env.AI_BRIDGE_JOB, "auto: fallback ops run is not traced under the mismatched job");

    // f) --no-auto / --job none skip matching
    m = mockRun(['{"verdict":"pass","feedback":"ok"}']);
    r = await runAgent(reworded, { runId: "auto0000006", noAuto: true }, m.run, deps);
    assert(!r.autoMatch && r.mode === "regular", "auto: --no-auto runs regular");
    r = await runAgent(reworded, { runId: "auto0000007", job: "none" }, mockRun(['{"verdict":"pass","feedback":"ok"}']).run, deps);
    assert(!r.autoMatch && r.job === null, "auto: --job none runs regular without a job");

    // g) auto-learn: an unknown task passing 3× (same domains + wording) gets a job + recipe automatically
    const journal = require("../server/journal.js");
    const kbbTask = "Open https://www.kbb.com/ and get the trade-in value for VIN 1C4RJKAG7P8753841 with 42000 miles, ZIP 90732";
    for (const id of ["learn000001", "learn000002", "learn000003"]) {
      journal.appendTrace(id, { cmd: "newTab", params: { url: "https://www.kbb.com/" }, ok: true, result: { id: 1 } });
      m = mockRun(['{"verdict":"pass","feedback":"ok"}']);
      r = await runAgent(kbbTask.replace("42000", id === "learn000002" ? "43000" : "42000"), { runId: id }, m.run, deps);
    }
    assert(r.learned && r.learned.created && /^auto-kbb-[0-9a-f]{6}$/.test(r.learned.job), `auto-learn: job created on the 3rd pass (${r.learned && r.learned.job})`);
    assert(r.learned.recipe._n === 3 && r.stages.some((s) => s.stage.startsWith("learn:")), "auto-learn: recipe proposed from all 3 traces, stage recorded");
    const aj = jobs.getJob(r.learned.job);
    assert(aj.auto === true && aj.mode === "audit" && aj.recipeVersion === 1 && aj.taskVariants.length >= 1, "auto-learn: job is auto, in audit, with variants");
    // the 4th run of the same task now matches the new job and uses its recipe in audit
    m = mockRun(['{"verdict":"pass","feedback":"ok"}']);
    r = await runAgent(kbbTask, { runId: "learn000004" }, m.run, { ...deps, loadRecipe: (j) => (j === aj.job ? { job: j, version: 1, risk: "read", steps: [], task: kbbTask } : deps.loadRecipe(j)) });
    assert(r.autoMatch && r.autoMatch.job === aj.job && r.mode === "audit", "auto-learn: next run is recognised and audited with the new recipe");
  }

  // 12) login wall: recipe says LOGIN REQUIRED → login hook → replay; without a hook no model is spent; ladder stops on auth blockers
  {
    const jobs = require("../server/jobs.js");
    const recipe = { job: "lw", version: 1, risk: "read", task: "lw task on https://site.example.com/x", steps: [{ do: "newTab", url: "https://site.example.com/x" }], output: "rows" };
    let authFirst = true;
    const logins = [];
    const deps = {
      loadRecipe: () => recipe,
      runRecipe: async () => {
        if (authFirst) { authFirst = false; return { ok: false, evidence: "EVIDENCE REPORT\nBlockers: LOGIN REQUIRED", steps: [], failure: { step: 3, do: "assert", error: "LOGIN REQUIRED", kind: "auth" } }; }
        return { ok: true, evidence: "EVIDENCE REPORT\nFinal state: 2 rows", steps: [], output: [1, 2] };
      },
      runLogin: async (cmd) => { logins.push(cmd); return { ok: true, output: "logged in" }; },
      propose: async () => { throw new Error("must not propose"); },
    };
    // economy job WITH a login hook: hook runs, recipe replays, no model (known wording)
    jobs.putJob({ job: "lw", mode: "economy", risk: "read", auditPasses: 3, auditRequired: 3, canaryEvery: 5, runsSinceCanary: 0, recipeVersion: 1, task: recipe.task, taskVariants: [], history: [], loginCmd: "/bin/login-hook" });
    let m = mockRun([]);
    let r = await runAgent(recipe.task, { job: "lw", runId: "auth0000001" }, m.run, deps);
    assert(r.verdict.verdict === "pass" && r.mode === "economy" && m.calls.length === 0, "login hook: session restored, recipe replayed, zero model calls");
    assert(logins[0] === "/bin/login-hook" && r.stages.some((s) => s.stage === "login-hook" && s.ok) && r.stages.filter((s) => s.stage.startsWith("recipe:")).length === 2, "login hook: hook stage + two recipe stages");
    assert(jobs.getJob("lw").mode === "economy" && !jobs.getJob("lw").repairNeeded, "login hook: job state untouched");

    // hook fails / still logged out → stop: no ladder, no repair, recipe unchanged
    authFirst = true;
    deps.runLogin = async () => ({ ok: false, error: "bad password" });
    deps.runRecipe = async () => ({ ok: false, evidence: "EVIDENCE REPORT\nBlockers: LOGIN REQUIRED", steps: [], failure: { step: 3, do: "assert", error: "LOGIN REQUIRED", kind: "auth" } });
    m = mockRun([]);
    r = await runAgent(recipe.task, { job: "lw", runId: "auth0000002" }, m.run, deps);
    assert(r.verdict.verdict === "fail" && r.blocker === "auth" && m.calls.length === 0 && r.repaired === null, "login wall: hook failed → fail fast, no models, no repair");
    assert(/LOGIN REQUIRED/.test(r.verdict.feedback) && jobs.getJob("lw").mode === "economy" && !jobs.getJob("lw").repairNeeded && jobs.getJob("lw").lastAuthFail, "login wall: verdict explains, job stays in economy, auth time recorded");

    // no hook configured → same fail-fast with a hint
    const st = jobs.getJob("lw"); delete st.loginCmd; jobs.putJob(st);
    m = mockRun([]);
    r = await runAgent(recipe.task, { job: "lw", runId: "auth0000003" }, m.run, deps);
    assert(r.blocker === "auth" && m.calls.length === 0 && /--login-cmd/.test(r.verdict.feedback), "login wall: no hook → fail fast with the --login-cmd hint");

    // regular ladder: ops reports an auth blocker → judge fails once, no escalation to the next rungs
    const authRun = async ({ model, prompt, engine, effort, env }) => {
      if (model === JUDGE_MODEL && prompt.includes("strict verifier")) return { result: '{"verdict":"fail","feedback":"not logged in"}', usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 };
      return { result: "EVIDENCE REPORT\nTask: t\nActions: 1. x\nFinal state: login page\nScreenshots: none\nBlockers: Authentication required — the site shows a login form.", usage: { input_tokens: 100, output_tokens: 10 }, total_cost_usd: 0.05 };
    };
    r = await runAgent("some untagged task on https://other.example.com/", { runId: "auth0000004" }, authRun, {});
    assert(r.verdict.verdict === "fail" && r.blocker === "auth" && r.stages.filter((s) => s.stage.startsWith("ops:")).length === 1, "ladder: auth blocker stops after the first rung");
    // but "Blockers: none" does not trigger it
    r = await runAgent("another task", { runId: "auth0000005" }, mockRun(['{"verdict":"fail","feedback":"a"}', '{"verdict":"pass","feedback":"ok"}']).run, {});
    assert(r.verdict.verdict === "pass" && r.stages.filter((s) => s.stage.startsWith("ops:")).length === 2, "ladder: 'Blockers: none' still escalates normally");
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

  // 12) cancellation: spawnTracked kills the process group; runAgent reports "cancelled" without touching job state
  {
    const { spawnTracked } = require("../server/agent.js");
    const jobs = require("../server/jobs.js");
    const ctl = new AbortController();
    const script = `const {spawn}=require("child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(JSON.stringify({parent:process.pid,child:c.pid}));setInterval(()=>{},1000);`;
    const child = spawnTracked(process.execPath, ["-e", script], { signal: ctl.signal, stdio: ["ignore", "pipe", "ignore"] });
    const pids = await new Promise((resolve) => { let out = ""; child.stdout.on("data", (d) => { out += d; if (out.includes("}")) resolve(JSON.parse(out)); }); });
    ctl.abort();
    await new Promise((r) => setTimeout(r, 500));
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
    assert(!alive(pids.parent) && !alive(pids.child), "spawnTracked: abort kills parent and grandchild");

    // ladder path: the model runner rejects with AbortError once the signal is aborted
    const ctl2 = new AbortController();
    const run = async (opts) => {
      if (opts.signal && opts.signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
      ctl2.abort();
      return { result: "EVIDENCE REPORT\nTask: t\nFinal state: partial\nScreenshots: none\nBlockers: none", usage: {} };
    };
    jobs.putJob({ job: "canc", mode: "audit", risk: "read", auditPasses: 1, auditRequired: 3, canaryEvery: 5, runsSinceCanary: 0, recipeVersion: 1, repairNeeded: true, history: [] });
    let r = await runAgent("cancel me", { job: "canc", runId: "canc0000001", signal: ctl2.signal }, run, { loadRecipe: () => null });
    assert(r.verdict.verdict === "cancelled" && /not undone/.test(r.verdict.feedback), "cancel: ladder abort → verdict cancelled");
    assert(r.record.verdict === "cancelled" && journal.readJournal({}).some((x) => x.runId === "canc0000001" && x.verdict === "cancelled"), "cancel: journaled as cancelled");
    let st = jobs.getJob("canc");
    assert(st.mode === "audit" && st.auditPasses === 1 && st.repairNeeded === true && st.history.length === 0, "cancel: job state untouched");

    // recipe path: runner reports kind "cancelled"
    const ctl3 = new AbortController();
    jobs.putJob({ job: "canc2", mode: "audit", risk: "read", auditPasses: 2, auditRequired: 3, canaryEvery: 5, runsSinceCanary: 0, recipeVersion: 1, history: [] });
    r = await runAgent("pull", { job: "canc2", runId: "canc0000002", signal: ctl3.signal }, mockRun([]).run, {
      loadRecipe: () => ({ job: "canc2", version: 1, risk: "read", task: "pull", steps: [{ do: "newTab", url: "u" }] }),
      runRecipe: async (rec, o) => { ctl3.abort(); return { ok: false, evidence: "aborted", steps: [], failure: { step: 0, do: "newTab", error: "cancelled", kind: "cancelled" } }; },
    });
    assert(r.verdict.verdict === "cancelled", "cancel: recipe abort → verdict cancelled");
    st = jobs.getJob("canc2");
    assert(st.mode === "audit" && st.auditPasses === 2 && !st.repairNeeded && st.history.length === 0, "cancel: recipe abort leaves job state untouched (no recipe-fail)");
  }

  // 13) approval gates: write-risk recipe asks first; NEEDS APPROVAL pauses the ladder
  {
    const jobs = require("../server/jobs.js");
    const writeRecipe = { job: "wr", version: 2, risk: "write", task: "send it", steps: [{ do: "newTab", url: "u" }, { do: "click", selector: "#send" }] };
    const seed = () => jobs.putJob({ job: "wr", mode: "audit", risk: "write", auditPasses: 1, auditRequired: 3, canaryEvery: 5, runsSinceCanary: 0, recipeVersion: 2, history: [] });
    let recipeRuns = 0;
    const deps = { loadRecipe: () => writeRecipe, runRecipe: async () => { recipeRuns++; return { ok: true, evidence: "EVIDENCE REPORT\nFinal state: sent", steps: [] }; } };

    // denied → declined, recipe never ran, job untouched, no model calls
    seed();
    let asked = [];
    let m = mockRun([]);
    let r = await runAgent("send it", { job: "wr", runId: "appr0000001", approve: async (req) => { asked.push(req); return "denied"; } }, m.run, deps);
    assert(r.verdict.verdict === "declined" && recipeRuns === 0 && m.calls.length === 0, "recipe gate: denied → declined, nothing ran");
    assert(asked.length === 1 && asked[0].kind === "recipe" && asked[0].title === "wr" && /^[0-9a-f]{64}$/.test(asked[0].digest), "recipe gate: approve called with kind recipe and a digest");
    let st = jobs.getJob("wr");
    assert(st.auditPasses === 1 && st.history.length === 0 && st.mode === "audit", "recipe gate: job state untouched on decline");
    assert(journal.readJournal({}).some((x) => x.runId === "appr0000001" && x.verdict === "declined"), "recipe gate: journaled as declined");
    m = mockRun([]);
    r = await runAgent("send it", { job: "wr", runId: "appr0000001x", approve: async () => "expired" }, m.run, deps);
    assert(r.verdict.verdict === "declined" && r.verdict.feedback === "approval expired: write-risk recipe not approved; nothing was run" && recipeRuns === 0 && m.calls.length === 0, "recipe gate: expired → declined with the expiry as feedback, nothing ran");

    // approved → recipe ran, then judged as usual
    seed();
    m = mockRun(['{"verdict":"pass","feedback":"ok"}']);
    r = await runAgent("send it", { job: "wr", runId: "appr0000002", approve: async () => "approved" }, m.run, deps);
    assert(r.verdict.verdict === "pass" && recipeRuns === 1, "recipe gate: approved → recipe ran");

    // digest changes with params; same params → same digest
    seed();
    const d1 = []; await runAgent("send it", { job: "wr", runId: "appr0000003", params: { a: 1 }, approve: async (q) => { d1.push(q.digest); return "denied"; } }, mockRun([]).run, deps);
    seed();
    const d2 = []; await runAgent("send it", { job: "wr", runId: "appr0000004", params: { a: 2 }, approve: async (q) => { d2.push(q.digest); return "denied"; } }, mockRun([]).run, deps);
    assert(d1[0] !== d2[0], "recipe gate: digest binds the rendered params");

    // no approve hook → unchanged behaviour (recipe runs)
    seed(); recipeRuns = 0;
    r = await runAgent("send it", { job: "wr", runId: "appr0000005" }, mockRun(['{"verdict":"pass","feedback":"ok"}']).run, deps);
    assert(recipeRuns === 1 && r.verdict.verdict === "pass", "recipe gate: without approve hook the recipe runs as before");

    // ladder: NEEDS APPROVAL pauses; approved → same rung rerun with feedback; denied → declined
    const needs = "did stuff\nEVIDENCE REPORT\nTask: t\nActions: 1. opened\nFinal state: compose open\nScreenshots: none\nBlockers: none\nNEEDS APPROVAL: click Send on the draft to Bob";
    const scripted = (replies, judge) => {
      const calls = []; let i = 0, j = 0;
      const run = async (o) => {
        calls.push(o);
        if (o.model === JUDGE_MODEL && o.prompt.includes("strict verifier")) return { result: judge[j++], usage: {} };
        return { result: replies[i++], usage: {} };
      };
      return { run, calls };
    };
    let s1 = scripted([needs, "EVIDENCE REPORT\nTask: t\nFinal state: sent\nScreenshots: none\nBlockers: none"], ['{"verdict":"pass","feedback":"ok"}']);
    asked = [];
    r = await runAgent("email Bob the draft", { runId: "appr0000006", approve: async (q) => { asked.push(q); return "approved"; } }, s1.run, {});
    const ops = s1.calls.filter((c) => !c.prompt.includes("strict verifier"));
    assert(asked.length === 1 && asked[0].kind === "step" && asked[0].title === "click Send on the draft to Bob", "step gate: approve called with the NEEDS APPROVAL line");
    assert(ops.length === 2 && ops[0].model === ops[1].model && ops[1].prompt.includes("approved: click Send on the draft to Bob; proceed"), "step gate: same rung rerun with the approval in the prompt");
    assert(r.verdict.verdict === "pass" && r.stages.some((x) => x.stage === "ops:opus-5.5(approved)"), "step gate: rerun stage labelled (approved), then judged");

    let s2 = scripted([needs], []);
    r = await runAgent("email Bob the draft", { runId: "appr0000007", approve: async () => "denied" }, s2.run, {});
    assert(r.verdict.verdict === "declined" && s2.calls.length === 1, "step gate: denied → declined after one ops call, no judge");
    let s2x = scripted([needs], []);
    r = await runAgent("email Bob the draft", { runId: "appr0000007x", approve: async () => "expired" }, s2x.run, {});
    assert(r.verdict.verdict === "declined" && r.verdict.feedback === "approval expired: click Send on the draft to Bob" && s2x.calls.length === 1, "step gate: expired → declined with the expiry as feedback, no rerun");

    // without approve hook the NEEDS APPROVAL evidence just goes to the judge
    let s3 = scripted([needs], ['{"verdict":"fail","feedback":"not sent"}', '{"verdict":"fail","feedback":"x"}', '{"verdict":"fail","feedback":"y"}']);
    r = await runAgent("email Bob the draft", { runId: "appr0000008", only: true }, s3.run, {});
    assert(r.verdict.verdict === "fail" && s3.calls.length === 2, "step gate: no hook → evidence judged as before");
  }

  // 14) restricted runs: browser-only tools, no codex, clean env, cwd, progress, no learning, source
  {
    const { allowedTools, cleanEnv } = require("../server/channels/restricted.js");
    const { SELF_CMD } = require("../server/runtime.js");
    const os = require("os");
    process.env.AI_BRIDGE_TELEGRAM_TOKEN = "supersecret";
    const cwd = fs.mkdtempSync(require("path").join(os.tmpdir(), "ai-bridge-cwd-"));

    // three failing judges → only two ops rungs (no codex)
    let m = mockRun(['{"verdict":"fail","feedback":"a"}', '{"verdict":"fail","feedback":"b"}', '{"verdict":"fail","feedback":"c"}']);
    const progress = [];
    let r = await runAgent("read the title", { runId: "restr000001", restricted: true, cwd, source: "channel:telegram", onProgress: (p) => progress.push(p.stage) }, m.run, {});
    const ops = m.calls.filter((c) => !c.prompt.includes("strict verifier"));
    assert(ops.length === 2 && ops.every((c) => c.engine !== "codex"), "restricted: codex rung skipped");
    assert(JSON.stringify(ops[0].allowedTools) === JSON.stringify(allowedTools(SELF_CMD)), "restricted: allowedTools is the browser-only list");
    assert(!ops[0].allowedTools.some((t) => /agent|jobs|recipe/.test(t)), "restricted: no admin subcommand pattern");
    assert(ops[0].baseEnv && !("AI_BRIDGE_TELEGRAM_TOKEN" in ops[0].baseEnv) && ops[0].baseEnv.PATH === process.env.PATH, "restricted: baseEnv is scrubbed (no token, PATH kept)");
    assert(ops[0].cwd === cwd && ops[0].env.AI_BRIDGE_OUTBOX === cwd, "restricted: cwd and AI_BRIDGE_OUTBOX point at the outbox");
    assert(ops[0].prompt.includes("NEEDS APPROVAL") && ops[0].prompt.includes("Do not use download"), "restricted: playbook addendum included");
    assert(progress[0] === "ops:opus-5.5" && progress[1] === "judge:fable-5.1", "restricted: onProgress reports stages in order");
    assert(r.record.source === "channel:telegram", "restricted: source recorded on the journal record");

    // codex opt-in
    m = mockRun(['{"verdict":"fail","feedback":"a"}', '{"verdict":"fail","feedback":"b"}', '{"verdict":"fail","feedback":"c"}']);
    await runAgent("read the title", { runId: "restr000002", restricted: true, codex: true, cwd }, m.run, {});
    assert(m.calls.filter((c) => c.engine === "codex").length === 1, "restricted: codex: true re-enables the last rung");

    // unrestricted baseline still uses the blanket pattern and process.env
    m = mockRun(['{"verdict":"pass","feedback":"ok"}']);
    await runAgent("read the title", { runId: "restr000003" }, m.run, {});
    assert(m.calls[0].allowedTools[0] === `Bash(${SELF_CMD}:*)` && m.calls[0].baseEnv === undefined, "unrestricted: blanket tool pattern, inherited env");

    // recipe + login hook receive the scrubbed env
    const jobs = require("../server/jobs.js");
    jobs.putJob({ job: "rst", mode: "audit", risk: "read", auditPasses: 0, auditRequired: 3, canaryEvery: 5, runsSinceCanary: 0, recipeVersion: 1, loginCmd: "true", history: [] });
    const seen = {};
    let first = true;
    const deps = {
      loadRecipe: () => ({ job: "rst", version: 1, risk: "read", task: "t", steps: [{ do: "newTab", url: "u" }] }),
      runRecipe: async (rec, o) => { seen.recipe = o.baseEnv; if (first) { first = false; return { ok: false, evidence: "", steps: [], failure: { step: 0, do: "assert", error: "LOGIN REQUIRED", kind: "auth" } }; } return { ok: true, evidence: "EVIDENCE REPORT\nFinal state: ok", steps: [] }; },
      runLogin: async (cmd, o) => { seen.login = o.baseEnv; return { ok: true }; },
    };
    await runAgent("t", { job: "rst", runId: "restr000004", restricted: true, cwd }, mockRun(['{"verdict":"pass","feedback":"ok"}']).run, deps);
    assert(seen.recipe && !("AI_BRIDGE_TELEGRAM_TOKEN" in seen.recipe) && seen.login && !("AI_BRIDGE_TELEGRAM_TOKEN" in seen.login), "restricted: recipe runner and login hook get the scrubbed env");

    // learning: seeded history makes an unrestricted run propose; the same restricted run does not
    const task = "Fetch the KBB value page for 9GYW724 and report the number";
    const seedTrace = (id) => journal.appendTrace(id, { cmd: "newTab", params: { url: "https://www.kbb.com/x" }, ok: true });
    const sig = journal.signatureOf({ task, domains: ["kbb.com"] });
    for (const id of ["learn000001", "learn000002"]) {
      seedTrace(id);
      journal.appendJournal({ runId: id, task, signature: sig, verdict: "pass", mode: "regular", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), domains: ["kbb.com"], stages: [], costUsd: 0 });
    }
    let proposed = 0;
    const learnDeps = { propose: async ({ job, task: t }) => { proposed++; return { job, task: t, version: 1, risk: "read", steps: [{ do: "newTab", url: "u" }], _usage: { input: 1, output: 1 } }; } };
    seedTrace("learn000003");
    await runAgent(task, { runId: "learn000003" }, mockRun(['{"verdict":"pass","feedback":"ok"}']).run, learnDeps);
    assert(proposed === 1, "learning: unrestricted third pass proposes a recipe");
    seedTrace("learn000004");
    r = await runAgent(task, { runId: "learn000004", restricted: true, cwd, job: "none" }, mockRun(['{"verdict":"pass","feedback":"ok"}']).run, learnDeps);
    seedTrace("learn000005");
    r = await runAgent(task, { runId: "learn000005", restricted: true, cwd }, mockRun(['{"verdict":"pass","feedback":"ok"}']).run, learnDeps);
    assert(proposed === 1 && !r.learned, "learning: restricted runs never propose or repair");
    delete process.env.AI_BRIDGE_TELEGRAM_TOKEN;
  }

  // 15) real child processes: a fake `claude` on PATH
  {
    const { spawnTracked, runModel } = require("../server/agent.js");
    const { execFileSync } = require("child_process");
    const os = require("os");
    const path = require("path");
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-fakebin-"));
    fs.copyFileSync(path.join(__dirname, "fixtures", "fake-claude.js"), path.join(bin, "claude"));
    fs.chmodSync(path.join(bin, "claude"), 0o755);
    const PATH = `${bin}:${process.env.PATH}`;
    const logFile = path.join(bin, "argv.log");
    const pidsFile = path.join(bin, "pids.json");
    const base = (extra = {}) => ({ PATH, HOME: process.env.HOME, FAKE_CLAUDE_LOG: logFile, ...extra });
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };

    // restricted run: all non-Bash tools disallowed, AI_BRIDGE_RESTRICTED set for children
    fs.writeFileSync(logFile, "");
    let res = await runModel({ model: "m", prompt: "p", allowedTools: ["Bash(x eval:*)"], timeoutMs: 10000, restricted: true, baseEnv: base({ FAKE_CLAUDE_MODE: "ok" }), env: { AI_BRIDGE_RESTRICTED: "1" } });
    let argv = JSON.parse(fs.readFileSync(logFile, "utf8").trim().split("\n").pop());
    const dis = argv[argv.indexOf("--disallowedTools") + 1] || "";
    assert(res.result.startsWith("EVIDENCE") && ["Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "NotebookEdit"].every((t) => dis.split(",").includes(t)), "fake claude: restricted run disallows every non-Bash built-in tool");
    assert(argv.includes("--allowedTools") && argv[argv.indexOf("--allowedTools") + 1] === "Bash(x eval:*)", "fake claude: allowedTools forwarded");

    // judge/classifier (no tools): also no Read/Glob/Agent
    fs.writeFileSync(logFile, "");
    await runModel({ model: "m", prompt: "p", allowedTools: [], timeoutMs: 10000, baseEnv: base({ FAKE_CLAUDE_MODE: "ok" }) });
    argv = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
    const dis2 = (argv[argv.indexOf("--disallowedTools") + 1] || "").split(",");
    assert(["Bash", "Read", "Glob", "Grep", "Agent", "WebFetch"].every((t) => dis2.includes(t)), "fake claude: tool-less call disallows Bash and the read tools");

    // abort mid-rung → AbortError → runAgent reports cancelled and journals it
    const ctl = new AbortController();
    const p = runAgent("hang task", { runId: "realcancel01", baseEnv: base({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_PIDS: pidsFile }), signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 700));
    const pids = JSON.parse(fs.readFileSync(pidsFile, "utf8"));
    ctl.abort();
    const r = await p;
    await new Promise((r2) => setTimeout(r2, 300));
    assert(r.verdict.verdict === "cancelled", "fake claude: abort → verdict cancelled (not error)");
    assert(journal.readJournal({}).some((x) => x.runId === "realcancel01" && x.verdict === "cancelled"), "fake claude: cancelled run journaled");
    assert(!alive(pids.parent) && !alive(pids.child), "fake claude: abort killed claude and its grandchild");

    // timeout kills the whole group too
    fs.unlinkSync(pidsFile);
    let timedOut = null;
    try { await runModel({ model: "m", prompt: "p", allowedTools: [], timeoutMs: 600, baseEnv: base({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_PIDS: pidsFile }) }); } catch (e) { timedOut = e; }
    await new Promise((r2) => setTimeout(r2, 300));
    const pids2 = JSON.parse(fs.readFileSync(pidsFile, "utf8"));
    assert(timedOut && /timed out/.test(timedOut.message) && !alive(pids2.parent) && !alive(pids2.child), "fake claude: timeout kills claude and its grandchild");

    // without a signal the child stays in our process group (Ctrl-C still reaches it)
    const child = spawnTracked(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const pgid = (pid) => Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)]).toString().trim());
    assert(pgid(child.pid) === pgid(process.pid), "spawnTracked: no signal → same process group as the caller");
    child.kill("SIGKILL");
    const child2 = spawnTracked(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", signal: new AbortController().signal });
    assert(pgid(child2.pid) !== pgid(process.pid), "spawnTracked: with a signal → own process group");
    process.kill(-child2.pid, "SIGKILL");
    fs.rmSync(bin, { recursive: true, force: true });
  }

  // 16) approval hook may answer "cancelled"; learning ignores channel-originated records
  {
    const jobs = require("../server/jobs.js");
    jobs.putJob({ job: "wrc", mode: "audit", risk: "write", auditPasses: 0, auditRequired: 3, canaryEvery: 5, runsSinceCanary: 0, recipeVersion: 1, history: [] });
    const deps = { loadRecipe: () => ({ job: "wrc", version: 1, risk: "write", task: "t", steps: [{ do: "click", selector: "#x" }] }), runRecipe: async () => { throw new Error("must not run"); } };
    let r = await runAgent("t", { job: "wrc", runId: "apprcanc001", approve: async () => "cancelled" }, mockRun([]).run, deps);
    assert(r.verdict.verdict === "cancelled" && jobs.getJob("wrc").history.length === 0, "approve → cancelled: verdict cancelled, job untouched");

    const task = "Open the dealer page for 9GYW724 and report the price";
    const sig = journal.signatureOf({ task, domains: ["dealer.com"] });
    for (const id of ["chl000001", "chl000002"]) {
      journal.appendTrace(id, { cmd: "newTab", params: { url: "https://dealer.com/x" }, ok: true });
      journal.appendJournal({ runId: id, task, signature: sig, verdict: "pass", mode: "regular", source: "channel:telegram", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), domains: ["dealer.com"], stages: [], costUsd: 0 });
    }
    journal.appendTrace("chl000003", { cmd: "newTab", params: { url: "https://dealer.com/x" }, ok: true });
    let proposed = 0;
    r = await runAgent(task, { runId: "chl000003" }, mockRun(['{"verdict":"pass","feedback":"ok"}']).run, { propose: async () => { proposed++; return { version: 1, steps: [] }; } });
    assert(proposed === 0 && !r.learned, "learning: channel-originated passes do not count towards a recipe");
  }

  console.log(failures === 0 ? "\nAll agent tests passed." : `\n${failures} test(s) FAILED.`);
  process.exit(failures ? 1 : 0);
})();
