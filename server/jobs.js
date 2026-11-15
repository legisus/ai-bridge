// AI Browser Bridge — per-job economy-mode state machine.
//
//   regular ──(recipe proposed)──► audit ──(N judged passes, risk=read)──► economy
//   audit/economy failure ──► this run falls back to the model ladder; recipe repaired ──► audit
//   economy: no model at all, except a judge canary every `canaryEvery` runs.
//
// State lives in ~/.ai-browser-bridge/jobs.json. See docs/ECONOMY-MODE.md.

"use strict";

const fs = require("fs");
const path = require("path");
const { DIR } = require("./token");
const { safeJob } = require("./recipe");

const JOBS_FILE = path.join(DIR, "jobs.json");
const MODES = ["regular", "audit", "economy"];
const DEFAULTS = { auditRequired: 3, canaryEvery: 5 };

function loadJobs() {
  try { return JSON.parse(fs.readFileSync(JOBS_FILE, "utf8")); } catch { return {}; }
}
function saveJobs(jobs) {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { mode: 0o700, recursive: true });
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2) + "\n");
}
function getJob(job) {
  const j = safeJob(job);
  if (!j) return null;
  const all = loadJobs();
  return all[j] ? { ...DEFAULTS, ...all[j], job: j } : { job: j, mode: "regular", ...DEFAULTS, auditPasses: 0, runsSinceCanary: 0, history: [] };
}
function putJob(state) {
  const all = loadJobs();
  const { job, ...rest } = state;
  all[job] = { ...rest, updatedAt: new Date().toISOString() };
  saveJobs(all);
  return { ...state };
}
function pushHistory(state, entry) {
  const h = Array.isArray(state.history) ? state.history.slice(-19) : [];
  h.push({ ts: new Date().toISOString(), ...entry });
  return { ...state, history: h };
}

// Decide what to do for this run from the job's state (+ whether a recipe exists).
function plan(state, hasRecipe) {
  if (!state || !hasRecipe || state.mode === "regular") return { mode: "regular", judge: true };
  if (state.mode === "audit") return { mode: "audit", judge: true };
  const canary = (state.runsSinceCanary || 0) + 1 >= (state.canaryEvery || DEFAULTS.canaryEvery);
  return { mode: "economy", judge: canary, canary };
}

// Pure transition. event: {kind:"recipe-pass"|"recipe-fail"|"judge-fail"|"regular-pass"|"regular-fail", canary?, judged?}
function transition(state, event, { riskOverride } = {}) {
  let s = { ...DEFAULTS, ...state };
  const risk = riskOverride || s.risk || "write";
  switch (event.kind) {
    case "recipe-pass": {
      if (s.mode === "audit") {
        s.auditPasses = (s.auditPasses || 0) + 1;
        if (s.auditPasses >= s.auditRequired && risk === "read") { s.mode = "economy"; s.runsSinceCanary = 0; s.economySince = new Date().toISOString(); }
      } else if (s.mode === "economy") {
        s.runsSinceCanary = event.canary ? 0 : (s.runsSinceCanary || 0) + 1;
      }
      s.lastResult = "pass";
      break;
    }
    case "recipe-fail":
    case "judge-fail": {
      // Recipe broke (or passed its own assertions but the judge disagreed):
      // back to audit, needs repair; the caller runs the regular ladder now.
      s.mode = "audit"; s.auditPasses = 0; s.runsSinceCanary = 0;
      s.repairNeeded = true; s.lastResult = "fail"; s.lastFailure = event.error || null;
      break;
    }
    case "repaired": { s.repairNeeded = false; s.mode = "audit"; s.auditPasses = 0; s.recipeVersion = event.version; break; }
    case "regular-pass": s.lastResult = "pass"; break;
    case "regular-fail": s.lastResult = "fail"; break;
    default: throw new Error(`unknown event ${event.kind}`);
  }
  return s;
}

function formatTable(jobs) {
  const names = Object.keys(jobs).sort();
  if (!names.length) return `jobs: none yet (${JOBS_FILE}). Propose a recipe with: bridge recipe propose <job>`;
  const rows = names.map((n) => {
    const j = { ...DEFAULTS, ...jobs[n] };
    return [n, j.mode || "regular", j.risk || "-", j.mode === "audit" ? `${j.auditPasses || 0}/${j.auditRequired}` : "-",
      j.mode === "economy" ? `${j.runsSinceCanary || 0}/${j.canaryEvery}` : "-", j.recipeVersion != null ? `v${j.recipeVersion}` : "-",
      j.repairNeeded ? "REPAIR" : (j.lastResult || "-"), (j.updatedAt || "").slice(0, 16).replace("T", " ")];
  });
  const head = ["job", "mode", "risk", "audit", "canary", "recipe", "last", "updated"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => c.padEnd(w[i])).join("  ");
  return [fmt(head), ...rows.map(fmt)].join("\n");
}

function main(argv) {
  const sub = argv[0];
  if (!sub || sub === "list") { process.stdout.write(formatTable(loadJobs()) + "\n"); return; }
  if (sub === "--json") { process.stdout.write(JSON.stringify(loadJobs(), null, 2) + "\n"); return; }
  if (sub === "set" || sub === "reset") {
    const job = safeJob(argv[1]);
    if (!job) { console.error("usage: bridge jobs set <job> [--mode regular|audit|economy] [--risk read|write] [--audits N] [--canary N] | bridge jobs reset <job>"); process.exit(2); }
    let s = getJob(job);
    if (sub === "reset") { s = { job, mode: "regular", ...DEFAULTS, auditPasses: 0, runsSinceCanary: 0, history: [], recipeVersion: s.recipeVersion, risk: s.risk }; }
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === "--mode") { const m = argv[++i]; if (!MODES.includes(m)) { console.error(`mode must be one of ${MODES.join("|")}`); process.exit(2); } s.mode = m; if (m === "audit") s.auditPasses = 0; if (m === "economy") s.runsSinceCanary = 0; s.repairNeeded = false; }
      else if (argv[i] === "--risk") { const r = argv[++i]; if (!["read", "write"].includes(r)) { console.error("risk must be read|write"); process.exit(2); } s.risk = r; }
      else if (argv[i] === "--audits") s.auditRequired = Number(argv[++i]);
      else if (argv[i] === "--canary") s.canaryEvery = Number(argv[++i]);
    }
    putJob(pushHistory(s, { event: sub, by: "cli" }));
    process.stdout.write(formatTable(loadJobs()) + "\n");
    return;
  }
  console.error("usage: bridge jobs [list|--json] | bridge jobs set <job> [--mode m] [--risk r] [--audits N] [--canary N] | bridge jobs reset <job>");
  process.exit(2);
}

module.exports = { JOBS_FILE, MODES, DEFAULTS, loadJobs, saveJobs, getJob, putJob, pushHistory, plan, transition, formatTable, main };
