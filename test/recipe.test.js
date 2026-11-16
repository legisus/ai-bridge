#!/usr/bin/env node
// Unit tests for recipes (templating, validation, runner with a mocked bridge)
// and the per-job state machine. Temp AI_BRIDGE_HOME; no browser, no models.
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-recipe-"));
const R = require("../server/recipe.js");
const J = require("../server/jobs.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

(async () => {
  // ---- templating
  const now = new Date(2026, 10, 15, 12); // 2026-11-15 local
  assert(R.render("{{date:-7:MM/DD/YYYY}}..{{date:0:YYYY-MM-DD}}", {}, now) === "11/08/2026..2026-11-15", "render: date offsets + formats");
  assert(R.render("tab {{tab}} n={{len:rows}} p={{params.days}} j={{json:rows}}", { tab: 7, rows: [1, 2], params: { days: 7 } }, now) ===
    "tab 7 n=2 p=7 j=[1,2]", "render: vars, len, json, params");
  assert(R.render("{{date:-{{params.days}}:M/D/YYYY}}", { params: { days: 10 } }, now) === "11/5/2026", "render: nested template resolves inner first");
  assert(R.render("keep {{unknown}}", {}, now) === "keep {{unknown}}", "render: unknown var left as-is");
  assert(R.renderDeep({ a: ["{{tab}}"], b: { c: "{{tab}}" } }, { tab: 3 }).a[0] === "3", "renderDeep: arrays + objects");

  // ---- validation
  const good = { job: "toll", steps: [{ do: "newTab", url: "https://x" }, { do: "assert", code: "1" }, { do: "poll", code: "rows", save: "rows" }], output: "rows", risk: "read" };
  assert(R.validateRecipe(good).length === 0, "validate: good recipe");
  const bad = { job: "bad job!", steps: [{ do: "click" }, { do: "eval" }, { nope: 1 }], risk: "maybe", output: 3 };
  const errs = R.validateRecipe(bad);
  assert(errs.length === 6, `validate: 6 errors on a bad recipe (got ${errs.length}: ${errs.join("; ")})`);
  assert(R.inferRisk(good) === "read" && R.inferRisk({ steps: [{ do: "click", selector: "x" }] }) === "write", "inferRisk: click => write");
  assert(R.safeJob("../x") === null && R.safeJob("toll-roads.pull_1") === "toll-roads.pull_1", "safeJob");

  // ---- storage + versions
  const s1 = R.saveRecipe({ ...good });
  const s2 = R.saveRecipe({ ...good, steps: good.steps.slice(0, 2) });
  assert(s1.version === 1 && s2.version === 2 && R.loadRecipe("toll").version === 2, "saveRecipe: versions bump, current = latest");
  assert(fs.existsSync(R.recipeFile("toll", 1)) && fs.existsSync(R.recipeFile("toll", 2)), "saveRecipe: immutable version files kept");

  // ---- runner with a mocked bridge
  function mockExec(script) {
    const calls = [];
    const exec = async (cmd, params) => {
      calls.push({ cmd, params });
      const h = script[cmd];
      const r = typeof h === "function" ? h(params, calls) : h;
      if (r instanceof Error) return { ok: false, error: r.message, ms: 1 };
      return { ok: true, result: r === undefined ? { ok: true } : r, ms: 1 };
    };
    return { exec, calls };
  }
  const recipe = {
    job: "toll", version: 3, risk: "read", task: "pull tolls", params: { days: 7 }, output: "rows",
    evidence: "Pulled {{len:rows}} rows {{date:-{{params.days}}:MM/DD/YYYY}}..{{date:0:MM/DD/YYYY}}",
    steps: [
      { do: "newTab", url: "https://site/tx" },
      { do: "waitFor", selector: "#btn-view", timeoutMs: 100 },
      { do: "assert", code: "!location.href.includes('/login')", message: "LOGIN REQUIRED" },
      { do: "eval", code: "setDates('{{date:-{{params.days}}:MM/DD/YYYY}}')", save: "set" },
      { do: "click", selector: "#btn-view" },
      { do: "poll", code: "rows()", timeoutMs: 3000, intervalMs: 10, save: "rows" },
      { do: "eval", code: "optional thing", optional: true },
    ],
  };
  {
    let polls = 0;
    const m = mockExec({
      newTab: { id: 42, windowId: 9 },
      eval: (p) => p.code.startsWith("!location") ? true : p.code.startsWith("setDates") ? "11/08/2026 set" : p.code === "rows()" ? (++polls < 3 ? [] : [{ a: 1 }, { a: 2 }]) : new Error("nope"),
    });
    const r = await R.runRecipe(recipe, { exec: m.exec, now, params: { days: 7 } });
    assert(r.ok === true, "run: ok");
    assert(m.calls[0].cmd === "newTab" && m.calls[0].params.newWindow === true, "run: newTab defaults to its own window");
    assert(m.calls[1].params.tabId === 42 && m.calls[4].cmd === "click" && m.calls[4].params.tabId === 42, "run: tabId flows from newTab to later steps");
    assert(m.calls[3].params.code === "setDates('11/08/2026')", "run: nested date template rendered in eval code");
    assert(polls === 3 && Array.isArray(r.output) && r.output.length === 2, "run: poll retried until non-empty, output saved");
    assert(r.steps[6].ok && r.steps[6].skipped, "run: optional step failure is skipped");
    assert(m.calls[m.calls.length - 1].cmd === "closeTab", "run: tab closed at the end");
    assert(r.evidence.includes("EVIDENCE REPORT") && r.evidence.includes("Pulled 2 rows 11/08/2026..11/15/2026") && r.evidence.includes('Output (rows): [{"a":1},{"a":2}]'),
      "run: evidence report with rendered summary + output");
  }
  {
    // assert failure -> abort, digest captured, tab closed
    const m = mockExec({ newTab: { id: 5 }, eval: (p) => p.code.startsWith("!location") ? false : "x", snapshot: { url: "https://site/login", elements: [] } });
    const r = await R.runRecipe(recipe, { exec: m.exec, now });
    assert(r.ok === false && r.failure.step === 2 && r.failure.error === "LOGIN REQUIRED", "run: assert fails with its message");
    assert(r.failure.digest && r.failure.digest.url === "https://site/login", "run: digest captured at failure");
    assert(r.steps.length === 3 && m.calls.some((c) => c.cmd === "closeTab"), "run: stops at the failing step, closes tab");
    assert(r.evidence.includes("Blockers: LOGIN REQUIRED"), "run: evidence names the blocker");
  }
  {
    // poll timeout
    const m = mockExec({ newTab: { id: 5 }, eval: (p) => p.code === "rows()" ? [] : true, snapshot: {} });
    const r = await R.runRecipe({ ...recipe, steps: [recipe.steps[0], { ...recipe.steps[5], timeoutMs: 30 }] }, { exec: m.exec, now });
    assert(r.ok === false && /poll timed out/.test(r.failure.error), "run: poll times out");
  }

  // ---- proposal prompt + JSON extraction
  const prompt = R.proposalPrompt({ job: "toll", task: "pull", traces: [[{ cmd: "newTab", params: { url: "u" }, ok: true, result: { id: 1 } }]] });
  assert(prompt.includes("RECIPE FORMAT") && prompt.includes("SUCCESSFUL RUN 1") && prompt.includes('"cmd":"newTab"'), "proposalPrompt: spec + traces");
  const rp = R.proposalPrompt({ job: "toll", task: "pull", traces: [[]], previous: { version: 2, steps: [] }, failure: { step: 1, do: "click", error: "no el", digest: { url: "x" } } });
  assert(rp.includes("PREVIOUS RECIPE (v2)") && rp.includes("FAILURE: step 2 (click): no el") && rp.includes("REPAIRED"), "proposalPrompt: repair variant");
  assert(R.extractJson('here\n```json\n{"job":"x","steps":[]}\n```').job === "x" && R.extractJson("noise {\"a\":1} tail").a === 1 && R.extractJson("none") === null, "extractJson");
  assert(R.compactTrace([{ cmd: "eval", params: { code: "x".repeat(5000) }, ok: true }], { maxEntryChars: 100 }).length <= 102, "compactTrace caps entries");

  // ---- job state machine
  let st = J.getJob("toll");
  assert(st.mode === "regular" && st.auditRequired === 3 && st.canaryEvery === 5, "jobs: defaults");
  assert(J.plan(st, true).mode === "regular", "plan: regular mode ignores recipe");
  st = J.transition({ ...st, risk: "read" }, { kind: "repaired", version: 1 });
  assert(st.mode === "audit" && st.auditPasses === 0 && st.recipeVersion === 1, "transition: repaired -> audit");
  assert(J.plan(st, true).mode === "audit" && J.plan(st, true).judge === true && J.plan(st, false).mode === "regular", "plan: audit judges; no recipe -> regular");
  st = J.transition(st, { kind: "recipe-pass" }); st = J.transition(st, { kind: "recipe-pass" });
  assert(st.mode === "audit" && st.auditPasses === 2, "transition: 2 audit passes stay in audit");
  st = J.transition(st, { kind: "recipe-pass" });
  assert(st.mode === "economy" && st.runsSinceCanary === 0, "transition: 3rd pass with risk=read -> economy");
  let w = J.transition({ ...J.getJob("w"), mode: "audit", auditPasses: 2, risk: "write" }, { kind: "recipe-pass" });
  assert(w.mode === "audit" && w.auditPasses === 3, "transition: risk=write never leaves audit");
  let p = J.plan(st, true);
  assert(p.mode === "economy" && p.judge === false, "plan: economy, no judge");
  for (let i = 0; i < 4; i++) st = J.transition(st, { kind: "recipe-pass" });
  p = J.plan(st, true);
  assert(st.runsSinceCanary === 4 && p.judge === true && p.canary === true, "plan: 5th economy run is a judge canary");
  st = J.transition(st, { kind: "recipe-pass", canary: true });
  assert(st.runsSinceCanary === 0, "transition: canary pass resets counter");
  st = J.transition(st, { kind: "recipe-fail", error: "boom" });
  assert(st.mode === "audit" && st.repairNeeded === true && st.auditPasses === 0 && st.lastFailure === "boom", "transition: recipe-fail -> audit + repair needed");
  st = J.transition(st, { kind: "repaired", version: 2 });
  assert(st.repairNeeded === false && st.recipeVersion === 2, "transition: repaired clears flag");
  J.putJob(J.pushHistory(st, { event: "test" }));
  const back = J.getJob("toll");
  assert(back.mode === "audit" && back.history.length === 1 && fs.existsSync(J.JOBS_FILE), "jobs: persisted + reloaded");
  assert(J.formatTable(J.loadJobs()).includes("toll") && J.formatTable(J.loadJobs()).includes("0/3"), "jobs: table");

  // ---- cancellation via AbortSignal
  {
    const ctl = new AbortController();
    const m = mockExec({ newTab: () => { ctl.abort(); return { id: 11 }; }, closeTab: {} });
    const r = await R.runRecipe({ job: "c", version: 1, steps: [{ do: "newTab", url: "u" }, { do: "eval", code: "1" }] }, { exec: m.exec, signal: ctl.signal });
    assert(r.ok === false && r.failure.kind === "cancelled" && r.failure.step === 1, "cancel: aborted after step 0 → failure at step 1, kind cancelled");
    assert(m.calls.some((c) => c.cmd === "closeTab" && c.params.tabId === 11) && !m.calls.some((c) => c.cmd === "eval"), "cancel: tab closed, next step never ran");
    const pre = new AbortController(); pre.abort();
    const m2 = mockExec({});
    const r2 = await R.runRecipe({ job: "c", version: 1, steps: [{ do: "newTab", url: "u" }] }, { exec: m2.exec, signal: pre.signal });
    assert(r2.ok === false && r2.failure.kind === "cancelled" && m2.calls.length === 0, "cancel: already-aborted signal → zero bridge calls");
  }

  // ---- risk hardening: effectiveRisk, inferRisk on eval code, unknown commands, approveRisk, renderParams
  {
    const evalSubmit = { job: "rk", task: "t", steps: [{ do: "newTab", url: "u" }, { do: "eval", code: "document.forms[0].submit()" }] };
    assert(R.inferRisk(evalSubmit) === "write", "inferRisk: eval containing .submit( is write");
    assert(R.inferRisk({ steps: [{ do: "eval", code: "document.title" }] }) === "read", "inferRisk: harmless eval is read");
    assert(R.inferRisk({ steps: [{ do: "poll", code: "fetch('/x',{method:'POST'})" }] }) === "write", "inferRisk: poll with fetch( is write");
    assert(R.effectiveRisk({ ...evalSubmit, risk: "read" }) === "write", "effectiveRisk: stored read but inferred write → write");
    assert(R.effectiveRisk({ ...evalSubmit, risk: "read", riskApprovedBy: "operator" }) === "read", "effectiveRisk: operator-approved read stays read");
    assert(R.effectiveRisk({ steps: [{ do: "eval", code: "1" }], risk: "write" }) === "write", "effectiveRisk: stored write is write");
    const errs = R.validateRecipe({ job: "rk", task: "t", steps: [{ do: "rm" }] });
    assert(errs.length === 1 && /unknown command "rm"/.test(errs[0]), `validate: unknown command flagged (got ${JSON.stringify(errs)})`);
    assert(R.validateRecipe({ job: "rk", task: "t", steps: [{ do: "download", url: "u" }, { do: "sleep", ms: 1 }] }).length === 0, "validate: download and sleep are known");

    // approveRisk rewrites both files in place without bumping the version
    const saved = R.saveRecipe({ job: "rk", task: "t", risk: "read", steps: evalSubmit.steps });
    const v = saved.version;
    const ap = R.approveRisk("rk");
    assert(ap.version === v && ap.riskApprovedBy === "operator", "approveRisk: same version, flag set");
    assert(R.loadRecipe("rk").riskApprovedBy === "operator" && JSON.parse(fs.readFileSync(R.recipeFile("rk", v), "utf8")).riskApprovedBy === "operator", "approveRisk: current and versioned files both carry the flag");
    assert(!fs.existsSync(R.recipeFile("rk", v + 1)), "approveRisk: no new version file");

    // renderParams renders once; runRecipe honours renderedParams verbatim
    const rp = R.renderParams({ params: { from: "{{date:-7:YYYY-MM-DD}}", n: 3 } }, { n: 5 }, now);
    assert(rp.from === "2026-11-08" && rp.n === 5, "renderParams: templates rendered, overrides applied");
    const m = mockExec({ eval: (p) => p.code });
    const r = await R.runRecipe({ job: "rp", version: 1, steps: [{ do: "eval", code: "x={{params.from}}", save: "v" }], output: "v" },
      { exec: m.exec, renderedParams: { from: "FIXED" }, params: { from: "ignored" } });
    assert(r.output === "x=FIXED", "runRecipe: renderedParams used verbatim over params");
  }

  // ---- review fixes: approval flag cannot be smuggled in; templated code is write-risk
  {
    const forged = R.saveRecipe({ job: "forge", task: "t", risk: "read", riskApprovedBy: "operator", riskApprovedAt: "x", steps: [{ do: "eval", code: "f.submit()" }] });
    assert(forged.riskApprovedBy === undefined && forged.riskApprovedAt === undefined && R.loadRecipe("forge").riskApprovedBy === undefined, "saveRecipe: strips riskApprovedBy/At from supplied recipes");
    assert(R.effectiveRisk(R.loadRecipe("forge")) === "write", "saveRecipe: forged approval does not lower the effective risk");
    assert(R.inferRisk({ steps: [{ do: "eval", code: "{{params.script}}" }] }) === "write", "inferRisk: templated eval code is write (cannot be inspected before rendering)");
    assert(R.inferRisk({ steps: [{ do: "assert", code: "location.href.includes('{{params.host}}')" }] }) === "write", "inferRisk: any {{ in code is write");
  }

  console.log(failures === 0 ? "\nAll recipe tests passed." : `\n${failures} test(s) FAILED.`);
  process.exit(failures ? 1 : 0);
})();
