// AI Browser Bridge — recipes: deterministic replays of a browser job.
//
// A recipe is JSON: ordered steps of bridge commands plus `assert`/`poll`/
// `sleep` pseudo-steps, with {{templates}} for saved values, params and dates.
// The runner executes it through the bridge CLI with zero model tokens and
// returns an evidence report the judge can verify (audit mode) or that stands
// on its own (economy mode). On a step failure it captures a DOM digest of the
// current tab so a model can repair the recipe. See docs/ECONOMY-MODE.md.

"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { DIR } = require("./token");
const { atomicWrite } = require("./atomic");
const { selfArgs } = require("./runtime");

const RECIPES_DIR = path.join(DIR, "recipes");
const PSEUDO = new Set(["assert", "poll", "sleep"]);
// A failure that no amount of model effort fixes: the session needs a login.
const AUTH_RE = /login required|log ?in|sign ?in|authenticat|session (has )?expired|logged out|password/i;
function isAuthFailure(text) { return AUTH_RE.test(String(text || "")); }
const WRITE_CMDS = new Set(["click", "insertText", "type", "key", "download"]);

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { mode: 0o700, recursive: true }); }
function safeJob(job) {
  const s = String(job || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) ? s : null;
}
function recipeFile(job, version) {
  return path.join(RECIPES_DIR, version ? `${job}.v${version}.json` : `${job}.json`);
}

// ---- storage ----------------------------------------------------------------

function loadRecipe(job) {
  const j = safeJob(job);
  if (!j) return null;
  try { return JSON.parse(fs.readFileSync(recipeFile(j), "utf8")); } catch { return null; }
}

// Saves as the current recipe and as an immutable version file; bumps version.
function saveRecipe(recipe) {
  const j = safeJob(recipe.job);
  if (!j) throw new Error(`invalid job name "${recipe.job}"`);
  ensureDir(RECIPES_DIR);
  const prev = loadRecipe(j);
  const version = prev ? (Number(prev.version) || 0) + 1 : 1;
  const out = { ...recipe, job: j, version, savedAt: new Date().toISOString() };
  const text = JSON.stringify(out, null, 2) + "\n";
  atomicWrite(recipeFile(j, version), text, { mode: 0o644 });
  atomicWrite(recipeFile(j), text, { mode: 0o644 });
  return out;
}

// ---- validation -------------------------------------------------------------

function validateRecipe(r) {
  const errs = [];
  if (!r || typeof r !== "object") return ["recipe is not an object"];
  if (!safeJob(r.job)) errs.push("job: missing or invalid name");
  if (!Array.isArray(r.steps) || !r.steps.length) errs.push("steps: must be a non-empty array");
  else r.steps.forEach((s, i) => {
    if (!s || typeof s !== "object" || typeof s.do !== "string") { errs.push(`step ${i}: missing "do"`); return; }
    if (s.do === "assert" && typeof s.code !== "string") errs.push(`step ${i}: assert needs "code"`);
    if (s.do === "poll" && typeof s.code !== "string") errs.push(`step ${i}: poll needs "code"`);
    if (s.do === "sleep" && typeof s.ms !== "number") errs.push(`step ${i}: sleep needs "ms"`);
    if (s.do === "eval" && typeof s.code !== "string") errs.push(`step ${i}: eval needs "code"`);
    if (s.do === "newTab" && typeof s.url !== "string") errs.push(`step ${i}: newTab needs "url"`);
    if (s.do === "navigate" && typeof s.url !== "string") errs.push(`step ${i}: navigate needs "url"`);
    if ((s.do === "waitFor") && typeof s.selector !== "string") errs.push(`step ${i}: waitFor needs "selector"`);
    if (s.do === "click" && typeof s.selector !== "string" && (typeof s.x !== "number" || typeof s.y !== "number"))
      errs.push(`step ${i}: click needs "selector" or x/y`);
    if (s.save != null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(s.save))) errs.push(`step ${i}: bad "save" name`);
  });
  if (r.risk != null && !["read", "write"].includes(r.risk)) errs.push('risk: must be "read" or "write"');
  if (r.output != null && typeof r.output !== "string") errs.push("output: must be a saved-variable name");
  return errs;
}

// A recipe that clicks/types anywhere is "write" unless it says otherwise;
// used as the default risk when the proposer does not classify.
function inferRisk(r) {
  return (r.steps || []).some((s) => WRITE_CMDS.has(s.do)) ? "write" : "read";
}

// ---- templating -------------------------------------------------------------

function pad2(n) { return String(n).padStart(2, "0"); }
function formatDate(d, fmt) {
  return fmt.replace(/YYYY/g, String(d.getFullYear())).replace(/MM/g, pad2(d.getMonth() + 1))
    .replace(/DD/g, pad2(d.getDate())).replace(/\bM\b/g, String(d.getMonth() + 1)).replace(/\bD\b/g, String(d.getDate()));
}
function getPath(obj, p) { return p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj); }

// {{name}} {{params.x}} {{json:name}} {{len:name}} {{date:-7:MM/DD/YYYY}} {{date:{{params.days}}:…}} (inner first).
function render(str, ctx, now = new Date()) {
  if (typeof str !== "string" || !str.includes("{{")) return str;
  let out = str;
  for (let pass = 0; pass < 4 && out.includes("{{"); pass++) {
    out = out.replace(/\{\{([^{}]+)\}\}/g, (m, expr) => {
      expr = expr.trim();
      let mm;
      if ((mm = /^date:(-?\d+):(.+)$/.exec(expr))) {
        const d = new Date(now); d.setDate(d.getDate() + Number(mm[1])); return formatDate(d, mm[2]);
      }
      if ((mm = /^json:(.+)$/.exec(expr))) { const v = getPath(ctx, mm[1]); return v === undefined ? m : JSON.stringify(v); }
      if ((mm = /^len:(.+)$/.exec(expr))) { const v = getPath(ctx, mm[1]); return v == null ? "0" : String(v.length != null ? v.length : Object.keys(v).length); }
      const v = getPath(ctx, expr);
      if (v === undefined) return m;
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  return out;
}
function renderDeep(val, ctx, now) {
  if (typeof val === "string") return render(val, ctx, now);
  if (Array.isArray(val)) return val.map((v) => renderDeep(v, ctx, now));
  if (val && typeof val === "object") { const o = {}; for (const k of Object.keys(val)) o[k] = renderDeep(val[k], ctx, now); return o; }
  return val;
}

// Numeric-looking rendered strings for tabId etc.
function coerce(v) { return typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : v; }

// ---- bridge exec -------------------------------------------------------------

// Run one bridge CLI command; resolves {ok, result|error, ms}. Injectable for tests.
function execBridge(cmd, params, { timeoutMs = 60000, debugger: dbg = false, env = {}, baseEnv } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const args = [cmd, JSON.stringify(params || {}), "--timeout", String(timeoutMs)];
    if (dbg) args.push("--debugger");
    const child = spawn(process.execPath, selfArgs(args), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...(baseEnv || process.env), ...env, ...(dbg ? { AI_BRIDGE_DEBUGGER: "1" } : {}) },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 5000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: (err.trim() || out.trim() || `exit ${code}`).replace(/^ERROR:\s*/, ""), ms: Date.now() - t0 });
      let result; try { result = JSON.parse(out); } catch { result = out.trim(); }
      resolve({ ok: true, result, ms: Date.now() - t0 });
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, ms: Date.now() - t0 }); });
  });
}

// ---- runner ----------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Execute a recipe. Returns {ok, steps, vars, output, evidence, failure?}.
async function runRecipe(recipe, { params = {}, env = {}, exec: execIn = execBridge, now, verbose = false, keepOpen = false, signal, baseEnv } = {}) {
  // Params may themselves be templates (e.g. "{{date:-7:MM/DD/YYYY}}") so a
  // recurring job never carries fixed dates.
  const ctx = { params: renderDeep({ ...(recipe.params || {}), ...params }, {}, now) };
  const exec = (cmd, p, o = {}) => execIn(cmd, p, { ...o, baseEnv });
  const aborted = () => !!(signal && signal.aborted);
  const steps = [];
  let failure = null;
  const log = (m) => { if (verbose) console.error(`[recipe] ${m}`); };

  const tabOf = (s, p) => {
    if (p.tabId != null) return coerce(p.tabId);
    if (ctx.tab != null) return coerce(ctx.tab);
    return undefined;
  };

  for (let i = 0; i < recipe.steps.length; i++) {
    const raw = recipe.steps[i];
    const s = renderDeep(raw, ctx, now);
    const t0 = Date.now();
    const rec = { i, do: s.do, ok: false, ms: 0 };
    if (s.note) rec.note = s.note;
    if (aborted()) {
      rec.error = "cancelled";
      failure = { step: i, do: s.do, error: "cancelled", note: s.note, kind: "cancelled" };
      steps.push(rec);
      break;
    }
    try {
      const { do: kind, save, optional, timeoutMs, note, debugger: dbg, ...p } = s;
      const timeout = timeoutMs || 60000;
      let value;
      if (kind === "sleep") { await sleep(p.ms); value = { slept: p.ms }; }
      else if (kind === "assert" || kind === "poll") {
        const tabId = tabOf(s, p);
        const deadline = Date.now() + (kind === "poll" ? timeout : 0);
        for (;;) {
          const r = await exec("eval", { tabId, code: p.code }, { timeoutMs: 30000, debugger: dbg, env });
          if (!r.ok) { if (kind === "assert" || Date.now() >= deadline) throw new Error(r.error); }
          else if (r.result !== null && r.result !== undefined && r.result !== false && r.result !== "" &&
                   !(Array.isArray(r.result) && r.result.length === 0 && kind === "poll")) { value = r.result; break; }
          else if (kind === "assert") throw new Error(p.message || `assertion failed: ${p.code.slice(0, 120)}`);
          if (Date.now() >= deadline) throw new Error(p.message || `poll timed out after ${timeout} ms: ${p.code.slice(0, 120)}`);
          await sleep(p.intervalMs || 1000);
        }
      } else {
        const cmdParams = { ...p };
        if (!["newTab", "listTabs", "ping", "download"].includes(kind)) {
          const tabId = tabOf(s, p);
          if (tabId != null) cmdParams.tabId = tabId;
        }
        if (kind === "newTab" && cmdParams.newWindow === undefined) cmdParams.newWindow = true;
        const r = await exec(kind, cmdParams, { timeoutMs: timeout, debugger: dbg, env });
        if (!r.ok) throw new Error(r.error);
        value = r.result;
        if (kind === "newTab" && value && value.id != null && ctx.tab == null) ctx.tab = value.id;
      }
      if (save) ctx[save] = value;
      rec.ok = true;
      if (value !== undefined && kind !== "eval" && kind !== "poll") rec.result = previewValue(value);
      if ((kind === "eval" || kind === "poll") && save) rec.saved = save;
    } catch (e) {
      rec.error = String(e.message || e);
      if (s.optional) { rec.ok = true; rec.skipped = true; log(`step ${i} optional failed: ${rec.error}`); }
      else {
        failure = { step: i, do: s.do, error: rec.error, note: s.note, kind: isAuthFailure(rec.error) ? "auth" : "step" };
        log(`step ${i} (${s.do}) FAILED: ${rec.error}`);
      }
    }
    rec.ms = Date.now() - t0;
    steps.push(rec);
    if (failure) break;
  }

  // Repair context: where did the page end up?
  if (failure && failure.kind !== "cancelled" && ctx.tab != null) {
    const snap = await exec("snapshot", { tabId: coerce(ctx.tab), maxText: 2500, maxElements: 120 }, { timeoutMs: 30000, env });
    failure.digest = snap.ok ? snap.result : { error: snap.error };
  }
  if (ctx.tab != null && !keepOpen && !(recipe.keepOpen)) {
    const closed = steps.some((s) => s.do === "closeTab" && s.ok);
    if (!closed) await exec("closeTab", { tabId: coerce(ctx.tab) }, { timeoutMs: 15000, env });
  }

  const output = recipe.output ? ctx[recipe.output] : undefined;
  const evidence = buildEvidence(recipe, { steps, ctx, output, failure, now });
  return { ok: !failure, steps, vars: ctx, output, evidence, failure };
}

function previewValue(v) {
  let s; try { s = JSON.stringify(v); } catch { s = String(v); }
  return s && s.length > 300 ? s.slice(0, 300) + "…" : v;
}

function buildEvidence(recipe, { steps, ctx, output, failure, now }) {
  const lines = [
    "EVIDENCE REPORT",
    `Task: ${recipe.task || recipe.job}`,
    `Mode: recipe ${recipe.job} v${recipe.version || "?"} (deterministic replay, no model)`,
    "Actions:",
    ...steps.map((s) => `${s.i + 1}. ${s.do}${s.note ? ` — ${s.note}` : ""}: ${s.ok ? (s.skipped ? "skipped (optional)" : "ok") : "FAILED"}${s.error ? ` (${s.error})` : ""}` +
      (s.result !== undefined ? ` → ${typeof s.result === "string" ? s.result : JSON.stringify(s.result)}` : "")),
  ];
  let outText = "";
  if (output !== undefined) {
    let s; try { s = JSON.stringify(output); } catch { s = String(output); }
    outText = s.length > 6000 ? s.slice(0, 6000) + `… (${s.length} chars)` : s;
  }
  const summary = recipe.evidence ? render(recipe.evidence, ctx, now) : "";
  lines.push(`Final state: ${failure ? `recipe aborted at step ${failure.step + 1} (${failure.do}): ${failure.error}` : (summary || "all steps ok")}` +
    (outText ? `\nOutput (${recipe.output}): ${outText}` : ""));
  lines.push("Screenshots: none");
  lines.push(`Blockers: ${failure ? failure.error : "none"}`);
  return lines.join("\n");
}

// ---- proposal / repair prompts ---------------------------------------------

const RECIPE_SPEC = `RECIPE FORMAT (JSON only, no prose):
{
  "job": "<job name>",
  "task": "<the task, one paragraph>",
  "risk": "read" | "write",           // "write" if any step changes data outside the browser tab (submits, sends, pays)
  "params": { "<name>": <default> },  // optional, referenced as {{params.name}}; dates MUST be templates like "{{date:-7:MM/DD/YYYY}}", never fixed values
  "steps": [ ... ],
  "output": "<saved variable holding the result>",
  "evidence": "<one-line summary template, e.g. 'Pulled {{len:rows}} rows for {{date:-7:MM/DD/YYYY}}..{{date:0:MM/DD/YYYY}}'>"
}
Step kinds (each may have "save":"<var>", "optional":true, "timeoutMs":N, "note":"why", "debugger":true):
  {"do":"newTab","url":"…"}                      opens in its own unfocused window; its id is saved as {{tab}} automatically
  {"do":"navigate","url":"…"}                    tabId defaults to {{tab}} for every step below
  {"do":"waitFor","selector":"css","timeoutMs":30000}
  {"do":"assert","code":"<js expression>","message":"LOGIN REQUIRED"}   fails the run if the expression is falsy
  {"do":"poll","code":"<js expression>","timeoutMs":45000,"intervalMs":1000,"save":"rows"}   repeats until truthy/non-empty
  {"do":"eval","code":"<js>","save":"x"}         result saved; use (()=>{...})() for multi-statement code
  {"do":"click","selector":"css"}  or {"do":"click","x":N,"y":N}
  {"do":"insertText","text":"…"}  {"do":"key","key":"Enter"}  {"do":"sleep","ms":1500}
  {"do":"snapshot"}  {"do":"closeTab"}           the runner closes {{tab}} at the end anyway
Templates: {{tab}}, {{params.x}}, {{savedVar}}, {{json:savedVar}}, {{len:savedVar}}, {{date:-7:MM/DD/YYYY}} (offset in days from today; also YYYY-MM-DD, M/D/YYYY).
RULES:
- Prefer stable selectors: #id, [name=], [data-testid], aria-label, exact button text via eval. Never generated class names.
- Put an "assert" before every step that changes state, checking the page is exactly where you expect (right URL, element present, no login form).
- Start with an assert that detects a login page and fails with message "LOGIN REQUIRED".
- Frameworks (Angular/React) need value setters + input/change/blur events; use the pattern that worked in the traces.
- Pages render slowly: use waitFor/poll, not fixed sleeps, except a short sleep after navigation.
- The output must be structured data (array of objects) and complete; no truncation in the recipe itself.
- The recipe must work on any future day: compute every date from {{date:…}} templates (relative to today), never copy dates seen in the traces.
- "task" must describe the job in relative terms too ("the last 7 days"), not with the dates seen in the traces.
- Never include credentials, never log out, never click Pay/Submit Payment.`;

function compactTrace(entries, { maxEntryChars = 1200, maxTotalChars = 40000 } = {}) {
  const lines = [];
  let total = 0;
  for (const e of entries) {
    const o = { cmd: e.cmd, params: e.params, ok: e.ok };
    if (e.error) o.error = e.error;
    if (e.result !== undefined) o.result = e.result;
    let s = JSON.stringify(o);
    if (s.length > maxEntryChars) s = s.slice(0, maxEntryChars) + "…";
    if (total + s.length > maxTotalChars) { lines.push("… (trace truncated)"); break; }
    lines.push(s); total += s.length;
  }
  return lines.join("\n");
}

function proposalPrompt({ job, task, traces, previous, failure }) {
  const parts = [
    `You convert successful browser-automation sessions into a deterministic RECIPE that replays the same job with no model involved.`,
    `JOB: ${job}`, `TASK:\n${task}`, RECIPE_SPEC,
  ];
  traces.forEach((t, i) => parts.push(`SUCCESSFUL RUN ${i + 1} — bridge commands in order (cmd, params, ok, result preview):\n${compactTrace(t)}`));
  if (previous) {
    parts.push(`PREVIOUS RECIPE (v${previous.version}) that FAILED:\n${JSON.stringify(previous, null, 1)}`);
    if (failure) parts.push(`FAILURE: step ${failure.step + 1} (${failure.do}): ${failure.error}\nPage digest at failure:\n${JSON.stringify(failure.digest || {}).slice(0, 8000)}`);
    parts.push("Produce a REPAIRED recipe that avoids this failure (fix selectors/waits/assertions; keep what worked).");
  }
  parts.push("Reply with ONLY the recipe JSON object.");
  return parts.join("\n\n");
}

function extractJson(text) {
  const s = String(text || "");
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const body = fence ? fence[1] : s;
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

module.exports = {
  RECIPES_DIR, recipeFile, safeJob, loadRecipe, saveRecipe, validateRecipe, inferRisk,
  render, renderDeep, formatDate, execBridge, runRecipe, buildEvidence,
  RECIPE_SPEC, compactTrace, proposalPrompt, extractJson, AUTH_RE, isAuthFailure,
};
