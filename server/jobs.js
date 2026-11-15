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

// Auto-matching an untagged task to a known job. A shared hostname in the
// text is the strong signal; word overlap (Jaccard) decides the rest:
//   ≥ MATCH → match, ≥ UNCERTAIN → ask a cheap model, else no match.
const MATCH_WITH_HOST = 0.2, UNCERTAIN_WITH_HOST = 0.08;
const MATCH_NO_HOST = 0.6, UNCERTAIN_NO_HOST = 0.3;
// Passes needed before a recipe is learned automatically.
const AUTO_PROPOSE_PASSES = 3;

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

// ---- task matching -----------------------------------------------------------

const STOP = new Set(["the", "and", "for", "with", "that", "this", "then", "from", "into", "your", "when", "must", "will", "are", "not", "any", "all", "its"]);
function tokens(task) {
  // URLs and bare hostnames are scored separately (hostsIn), so drop them here —
  // otherwise "secure thetollroads com" alone makes two different jobs look alike.
  return new Set(String(task || "").toLowerCase().replace(/https?:\/\/\S+/g, " ")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|gov|io|us|co|app|dev)\b/g, " ").replace(/\d+/g, " ")
    .split(/[^a-z#]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}
// Hostnames mentioned in a task: full URLs and bare "secure.thetollroads.com".
function hostsIn(task) {
  const out = new Set();
  const t = String(task || "");
  for (const m of t.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
    try { out.add(new URL(m[0]).hostname.replace(/^www\./, "")); } catch {}
  }
  for (const m of t.matchAll(/\b((?:[a-z0-9-]+\.)+(?:com|org|net|gov|io|us|co|app|dev))\b/gi)) out.add(m[1].toLowerCase().replace(/^www\./, ""));
  return out;
}
const urlsIn = hostsIn;
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
// → { score, sharedHost, verdict: "match" | "uncertain" | "no" }
function similarity(a, b) {
  const ha = hostsIn(a), hb = hostsIn(b);
  const words = jaccard(tokens(a), tokens(b));
  const sharedHost = [...ha].some((h) => hb.has(h));
  if (ha.size && hb.size && !sharedHost) return { score: words, sharedHost, verdict: "no" };
  const [m, u] = sharedHost ? [MATCH_WITH_HOST, UNCERTAIN_WITH_HOST] : [MATCH_NO_HOST, UNCERTAIN_NO_HOST];
  return { score: words, sharedHost, verdict: words >= m ? "match" : words >= u ? "uncertain" : "no" };
}
function normalizeVariant(task) { return String(task || "").toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim(); }

// Deterministic pass: { match: {job, score, exact} | null, uncertain: [{job, score, task}] }.
// `exact` = this exact wording already passed a judge with the recipe.
function findJobForTask(task, all = loadJobs()) {
  let match = null;
  const uncertain = [];
  const norm = normalizeVariant(task);
  for (const [name, j] of Object.entries(all)) {
    // Similarity is scored against the job's canonical task only; remembered
    // wordings (often short) count just for exact matches, or a terse variant
    // would make every short task on the same site look like this job.
    const texts = [j.task, ...(j.taskVariants || [])].filter(Boolean);
    const sim = j.task ? similarity(task, j.task) : { score: 0, verdict: "no" };
    const bestScore = sim.score, bestVerdict = sim.verdict;
    const exact = texts.map(normalizeVariant).includes(norm);
    if (exact || bestVerdict === "match") { if (!match || bestScore > match.score || exact) match = { job: name, score: exact ? 1 : bestScore, exact }; }
    else if (bestVerdict === "uncertain") uncertain.push({ job: name, score: bestScore, task: j.task });
  }
  uncertain.sort((a, b) => b.score - a.score);
  return { match, uncertain: uncertain.slice(0, 5) };
}

function classifyPrompt(task, candidates) {
  return `A browser task is about to run. Decide whether it is the SAME recurring job as one of the known jobs below
(same site, same goal, same kind of output; wording and dates may differ). Be strict: a different page, account,
action or output means "none".

TASK:
${task}

KNOWN JOBS:
${candidates.map((c) => `- ${c.job}: ${String(c.task || "").slice(0, 600)}`).join("\n")}

Reply with ONLY JSON: {"job": "<job name>" or null, "confidence": 0..1, "why": "<10 words>"}`;
}

// Name for a job created automatically from an untagged task: auto-<domain>-<hash>.
function autoJobName(task, domains, signature) {
  const crypto = require("crypto");
  const dom = (domains && domains[0]) || [...urlsIn(task)][0] || "web";
  const base = dom.split("/")[0].replace(/\.(com|org|net|gov|io)$/, "").replace(/[^a-z0-9]+/gi, "-").slice(0, 24);
  return `auto-${base}-${crypto.createHash("sha1").update(signature || task).digest("hex").slice(0, 6)}`;
}

function formatTable(jobs) {
  const names = Object.keys(jobs).sort();
  if (!names.length) return `jobs: none yet (${JOBS_FILE}). Propose a recipe with: bridge recipe propose <job>`;
  const rows = names.map((n) => {
    const j = { ...DEFAULTS, ...jobs[n] };
    return [n + (j.auto ? "*" : ""), j.mode || "regular", j.risk || "-", j.mode === "audit" ? `${j.auditPasses || 0}/${j.auditRequired}` : "-",
      j.mode === "economy" ? `${j.runsSinceCanary || 0}/${j.canaryEvery}` : "-", j.recipeVersion != null ? `v${j.recipeVersion}` : "-",
      j.repairNeeded ? "REPAIR" : (j.lastResult || "-"), (j.updatedAt || "").slice(0, 16).replace("T", " ")];
  });
  const head = ["job", "mode", "risk", "audit", "canary", "recipe", "last", "updated"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => c.padEnd(w[i])).join("  ");
  return [fmt(head), ...rows.map(fmt), names.some((n) => jobs[n].auto) ? "* = job created automatically from a repeated task" : ""].filter(Boolean).join("\n");
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

module.exports = {
  JOBS_FILE, MODES, DEFAULTS, AUTO_PROPOSE_PASSES, loadJobs, saveJobs, getJob, putJob, pushHistory, plan, transition, formatTable, main,
  tokens, hostsIn, urlsIn, similarity, normalizeVariant, findJobForTask, classifyPrompt, autoJobName,
};
