// AI Browser Bridge — run journal + command traces.
//
// The agent appends one record per run to journal.jsonl; the server appends one
// line per bridge command to traces/<runId>.jsonl. `bridge journal` groups the
// runs by job signature so repeated jobs (economy-mode candidates) stand out.
// See docs/ECONOMY-MODE.md.

"use strict";

const fs = require("fs");
const path = require("path");
const { DIR } = require("./token");

const JOURNAL_FILE = path.join(DIR, "journal.jsonl");
const TRACES_DIR = path.join(DIR, "traces");

const CANDIDATE_MIN_PASSES = 3;
const DEFAULT_WINDOW_DAYS = 30;
const RESULT_PREVIEW_CHARS = 4000;

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { mode: 0o700, recursive: true }); }

// Run ids are file names: keep them boring.
function safeRunId(id) {
  const s = String(id || "");
  return /^[A-Za-z0-9_-]{4,64}$/.test(s) ? s : null;
}
function traceFile(runId) { return path.join(TRACES_DIR, `${runId}.jsonl`); }

// ---- traces (server side) ------------------------------------------------

function previewResult(result) {
  if (result === undefined) return undefined;
  let s;
  try { s = JSON.stringify(result); } catch { s = String(result); }
  if (s === undefined) return undefined;
  if (s.length <= RESULT_PREVIEW_CHARS) return result;
  return { _preview: s.slice(0, RESULT_PREVIEW_CHARS), _length: s.length };
}

function appendTrace(runId, entry) {
  const id = safeRunId(runId);
  if (!id) return false;
  try {
    ensureDir(TRACES_DIR);
    const e = { ...entry };
    if (e.result && typeof e.result === "object" && typeof e.result.base64 === "string") {
      e.result = { base64: `<${e.result.base64.length} chars omitted>` };
    } else {
      e.result = previewResult(e.result);
    }
    fs.appendFileSync(traceFile(id), JSON.stringify(e) + "\n");
    return true;
  } catch { return false; }
}

function readTrace(runId) {
  const id = safeRunId(runId);
  if (!id) return [];
  try {
    return fs.readFileSync(traceFile(id), "utf8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// Domains touched during a run, from newTab/navigate URLs in the trace.
function domainsFromTrace(entries) {
  const out = new Set();
  for (const e of entries) {
    const u = e && e.params && e.params.url;
    if (typeof u !== "string") continue;
    try { out.add(new URL(u).hostname.replace(/^www\./, "")); } catch {}
  }
  return [...out].sort();
}

// ---- journal (agent side) --------------------------------------------------

function normalizeTask(task) {
  return String(task || "").toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 160);
}

function signatureOf({ job, task, domains }) {
  if (job) return `job:${String(job).trim()}`;
  return `auto:${(domains || []).join(",")}|${normalizeTask(task)}`;
}

function appendJournal(record) {
  ensureDir(DIR);
  fs.appendFileSync(JOURNAL_FILE, JSON.stringify(record) + "\n");
  return JOURNAL_FILE;
}

function readJournal({ days } = {}) {
  let lines;
  try { lines = fs.readFileSync(JOURNAL_FILE, "utf8").split("\n").filter(Boolean); }
  catch { return []; }
  const since = days ? Date.now() - days * 86400e3 : 0;
  const out = [];
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (since && Date.parse(r.startedAt || r.endedAt || 0) < since) continue;
    out.push(r);
  }
  return out;
}

// Group runs by signature → stats. Pure: takes records, returns rows.
function summarize(records, { minPasses = CANDIDATE_MIN_PASSES } = {}) {
  const groups = new Map();
  for (const r of records) {
    if (r.mode === "session") continue;   // conversation turns are not judged runs
    const key = r.signature || signatureOf(r);
    if (!groups.has(key)) {
      groups.set(key, { signature: key, job: r.job || null, runs: 0, passes: 0, costUsd: 0,
        inputTokens: 0, outputTokens: 0, lastRun: null, lastVerdict: null, modes: {}, example: r.task });
    }
    const g = groups.get(key);
    g.runs++;
    if (r.verdict === "pass") g.passes++;
    g.costUsd += Number(r.costUsd) || 0;
    g.inputTokens += Number(r.inputTokens) || 0;
    g.outputTokens += Number(r.outputTokens) || 0;
    g.modes[r.mode || "regular"] = (g.modes[r.mode || "regular"] || 0) + 1;
    const t = r.endedAt || r.startedAt;
    if (!g.lastRun || Date.parse(t) > Date.parse(g.lastRun)) { g.lastRun = t; g.lastVerdict = r.verdict; }
  }
  const rows = [...groups.values()].map((g) => ({
    ...g,
    passRate: g.runs ? g.passes / g.runs : 0,
    avgCostUsd: g.runs ? g.costUsd / g.runs : 0,
    avgTokens: g.runs ? Math.round((g.inputTokens + g.outputTokens) / g.runs) : 0,
    candidate: g.passes >= minPasses,
  }));
  // Most expensive repeated work first.
  rows.sort((a, b) => (b.candidate - a.candidate) || (b.costUsd - a.costUsd) || (b.runs - a.runs));
  return rows;
}

function formatReport(rows, { days }) {
  if (!rows.length) return `journal: no agent runs in the last ${days} days (${JOURNAL_FILE}).`;
  const head = ["", "runs", "pass", "total $", "avg $", "avg tok", "last run", "signature"];
  const lines = rows.map((r) => [
    r.candidate ? "*" : " ",
    String(r.runs),
    `${Math.round(r.passRate * 100)}%`,
    r.costUsd.toFixed(2),
    r.avgCostUsd.toFixed(3),
    String(r.avgTokens),
    (r.lastRun || "").slice(0, 16).replace("T", " "),
    r.signature.length > 70 ? r.signature.slice(0, 67) + "…" : r.signature,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cols) => cols.map((c, i) => (i === cols.length - 1 ? c : c.padStart(widths[i]))).join("  ");
  const cands = rows.filter((r) => r.candidate).length;
  return [
    `journal: last ${days} days, ${rows.reduce((n, r) => n + r.runs, 0)} runs, ${rows.length} distinct jobs, ` +
      `$${rows.reduce((n, r) => n + r.costUsd, 0).toFixed(2)} total`,
    `* = economy-mode candidate (>= ${CANDIDATE_MIN_PASSES} passes): ${cands}`,
    "",
    fmt(head),
    ...lines.map(fmt),
  ].join("\n");
}

function main(argv) {
  const opts = { days: DEFAULT_WINDOW_DAYS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") opts.days = Number(argv[++i]);
    else if (argv[i] === "--job") opts.job = argv[++i];
    else if (argv[i] === "--json") opts.json = true;
    else if (argv[i] === "--trace") opts.trace = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.error("usage: bridge journal [--days N] [--job name] [--json] | bridge journal --trace <runId>");
      process.exit(2);
    }
  }
  if (opts.trace) {
    const t = readTrace(opts.trace);
    if (!t.length) { console.error(`no trace for run ${opts.trace} (${traceFile(opts.trace)})`); process.exit(1); }
    process.stdout.write(opts.json ? JSON.stringify(t, null, 2) + "\n"
      : t.map((e) => `${e.ts || ""} ${e.reqId || "-"} ${String(e.ms || 0).padStart(5)}ms ${e.ok ? "ok  " : e.outcome === "refused" ? "REF " : e.outcome === "cancelled" ? "CAN " : "FAIL"} ${e.cmd} ${JSON.stringify(e.params || {}).slice(0, 140)}${e.error ? `  -> ${e.error}` : ""}`).join("\n") + "\n");
    return;
  }
  let records = readJournal({ days: opts.days });
  if (opts.job) records = records.filter((r) => r.job === opts.job);
  const rows = summarize(records);
  process.stdout.write((opts.json ? JSON.stringify(rows, null, 2) : formatReport(rows, { days: opts.days })) + "\n");
}

module.exports = {
  JOURNAL_FILE, TRACES_DIR, CANDIDATE_MIN_PASSES, traceFile, safeRunId,
  appendTrace, readTrace, domainsFromTrace, normalizeTask, signatureOf,
  appendJournal, readJournal, summarize, formatReport, main,
};
