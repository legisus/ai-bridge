// `bridge recipe …` — manage deterministic recipes for a job.
//
//   bridge recipe propose <job> [--runs 3] [--model m] [--task "…"]   learn a recipe from the job's last passing traces
//   bridge recipe run <job> [--params '{"days":7}'] [--json] [--keep-open] [--verbose]
//   bridge recipe show <job> | bridge recipe validate <file.json> | bridge recipe import <file.json>

"use strict";

const fs = require("fs");
const recipes = require("./recipe");
const journal = require("./journal");
const jobs = require("./jobs");

function usage() {
  console.error('usage: bridge recipe propose <job> [--runs 3] [--model m] [--task "…"]');
  console.error("       bridge recipe run <job> [--params json] [--json] [--keep-open] [--verbose]");
  console.error("       bridge recipe show <job> | validate <file> | import <file>");
  console.error("       bridge recipe approve <job>      # operator vouches for a recipe stored as risk=read whose code looks like a write");
  process.exit(2);
}

async function main(argv) {
  const sub = argv[0];
  const arg = argv[1];
  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--runs") opts.runs = Number(argv[++i]);
    else if (argv[i] === "--model") opts.model = argv[++i];
    else if (argv[i] === "--task") opts.task = argv[++i];
    else if (argv[i] === "--params") opts.params = JSON.parse(argv[++i]);
    else if (argv[i] === "--json") opts.json = true;
    else if (argv[i] === "--keep-open") opts.keepOpen = true;
    else if (argv[i] === "--verbose") opts.verbose = true;
  }
  if (!sub || !arg) usage();

  if (sub === "approve") {
    const r = recipes.approveRisk(arg);
    console.log(`approved risk for ${r.job} v${r.version}: effective risk is now ${recipes.effectiveRisk(r)}`);
    return;
  }
  if (sub === "show") {
    const r = recipes.loadRecipe(arg);
    if (!r) { console.error(`no recipe for job ${arg} (${recipes.recipeFile(arg)})`); process.exit(1); }
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    return;
  }
  if (sub === "validate" || sub === "import") {
    const obj = JSON.parse(fs.readFileSync(arg, "utf8"));
    const errs = recipes.validateRecipe(obj);
    if (errs.length) { console.error("INVALID:\n  " + errs.join("\n  ")); process.exit(1); }
    if (sub === "validate") { console.log(`valid recipe for job ${obj.job} (${obj.steps.length} steps, risk ${obj.risk || recipes.inferRisk(obj)})`); return; }
    if (!obj.risk) obj.risk = recipes.inferRisk(obj);
    const saved = recipes.saveRecipe(obj);
    const state = jobs.getJob(saved.job);
    jobs.putJob(jobs.pushHistory(jobs.transition({ ...state, risk: state.risk || saved.risk }, { kind: "repaired", version: saved.version }), { event: "import", version: saved.version }));
    console.log(`imported ${saved.job} v${saved.version}; job is now in audit mode`);
    return;
  }
  if (sub === "run") {
    const r = recipes.loadRecipe(arg);
    if (!r) { console.error(`no recipe for job ${arg}`); process.exit(1); }
    const res = await recipes.runRecipe(r, { params: opts.params || {}, verbose: opts.verbose, keepOpen: opts.keepOpen });
    if (opts.json) process.stdout.write(JSON.stringify({ ok: res.ok, steps: res.steps, output: res.output, failure: res.failure }, null, 2) + "\n");
    else {
      process.stdout.write(res.evidence + "\n");
      if (res.failure && res.failure.digest) process.stdout.write(`\nPage digest at failure: ${JSON.stringify(res.failure.digest).slice(0, 1500)}\n`);
    }
    process.exit(res.ok ? 0 : 1);
  }
  if (sub === "propose") {
    const job = recipes.safeJob(arg);
    if (!job) usage();
    const runs = opts.runs || 3;
    const recs = journal.readJournal({}).filter((x) => x.job === job && x.verdict === "pass" && (x.mode || "regular") === "regular")
      .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt)).slice(0, runs);
    if (!recs.length) { console.error(`no passing regular runs for job ${job} in the journal; run it with: bridge agent "…" --job ${job}`); process.exit(1); }
    const traces = recs.map((x) => journal.readTrace(x.runId)).filter((t) => t.length);
    if (!traces.length) { console.error("the journal has runs but their traces are missing"); process.exit(1); }
    const task = opts.task || recs[0].task;
    const { proposeRecipe, RECIPE_MODEL } = require("./agent");
    console.error(`proposing recipe for ${job} from ${traces.length} trace(s) with ${opts.model || RECIPE_MODEL}…`);
    const previous = recipes.loadRecipe(job);
    const saved = await proposeRecipe({ job, task, traces, previous: previous || undefined, model: opts.model, verbose: opts.verbose });
    let state = jobs.getJob(job);
    state = jobs.transition({ ...state, risk: state.risk || saved.risk, task }, { kind: "repaired", version: saved.version });
    jobs.putJob(jobs.pushHistory(state, { event: "propose", version: saved.version }));
    console.error(`saved ${recipes.recipeFile(job)} (v${saved.version}, ${saved.steps.length} steps, risk ${saved.risk}); job ${job} is now in AUDIT mode` +
      ` — ${state.auditRequired} judged passes${saved.risk === "read" ? " switch it to economy" : "; risk=write stays in audit (bridge jobs set --risk read to allow economy)"}.`);
    if (saved._usage) console.error(`tokens in:${saved._usage.input} out:${saved._usage.output}${typeof saved._usage.costUsd === "number" ? ` $${saved._usage.costUsd.toFixed(4)}` : ""}`);
    process.stdout.write(JSON.stringify(saved, null, 2) + "\n");
    return;
  }
  usage();
}

module.exports = { main };
