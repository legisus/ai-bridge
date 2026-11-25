#!/usr/bin/env node
// Unit tests for the run journal: signatures, summary/candidate flag, and the
// trace + journal files under a temp AI_BRIDGE_HOME.
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-journal-"));
const J = require("../server/journal.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

// signatures
assert(J.signatureOf({ job: "toll-invoices", task: "x" }) === "job:toll-invoices", "signature: --job wins");
assert(J.signatureOf({ task: "Invoice trip 54220427 for $12.50", domains: ["turo.com", "thetollroads.com"] }) ===
  "auto:turo.com,thetollroads.com|invoice trip # for $#.#", "signature: auto = domains + digit-normalized task");
assert(J.safeRunId("../etc") === null && J.safeRunId("abc12345") === "abc12345", "safeRunId rejects path tricks");

// traces
const rid = "run0001abcd";
assert(J.appendTrace("../x", { cmd: "ping" }) === false, "appendTrace: bad run id ignored");
J.appendTrace(rid, { ts: "t1", cmd: "newTab", params: { url: "https://www.thetollroads.com/x" }, ok: true, ms: 5, result: { id: 1 } });
J.appendTrace(rid, { ts: "t2", cmd: "screenshot", params: { tabId: 1 }, ok: true, ms: 9, result: { base64: "AAAA" } });
J.appendTrace(rid, { ts: "t3", cmd: "eval", params: { tabId: 1, code: "1" }, ok: true, ms: 1, result: "x".repeat(5000) });
J.appendTrace(rid, { ts: "t4", cmd: "navigate", params: { tabId: 1, url: "https://turo.com/t" }, ok: false, error: "boom", ms: 2 });
const t = J.readTrace(rid);
assert(t.length === 4, "readTrace: 4 entries");
assert(t[1].result.base64.includes("omitted"), "trace: screenshot pixels omitted");
assert(t[2].result._length === 5002 && t[2].result._preview.length === 4000, "trace: long result previewed");
assert(JSON.stringify(J.domainsFromTrace(t)) === JSON.stringify(["thetollroads.com", "turo.com"]), "domainsFromTrace strips www, sorts");

// journal + summary
const now = Date.now();
const iso = (d) => new Date(now - d * 86400e3).toISOString();
const rec = (over) => ({ runId: "r", job: null, signature: "job:a", task: "t", startedAt: iso(1), endedAt: iso(1),
  mode: "regular", verdict: "pass", costUsd: 0.1, inputTokens: 1000, outputTokens: 100, ...over });
J.appendJournal(rec({ job: "a" }));
J.appendJournal(rec({ job: "a", costUsd: 0.3 }));
J.appendJournal(rec({ job: "a", verdict: "fail", costUsd: 0.2 }));
J.appendJournal(rec({ job: "a", startedAt: iso(0.5), endedAt: iso(0.5) }));
J.appendJournal(rec({ job: "b", signature: "job:b", costUsd: 5 }));
J.appendJournal(rec({ job: "old", signature: "job:old", startedAt: iso(40), endedAt: iso(40) }));
fs.appendFileSync(J.JOURNAL_FILE, "not json\n");

const all = J.readJournal({});
assert(all.length === 6, "readJournal: skips garbage line, keeps 6");
const recent = J.readJournal({ days: 30 });
assert(recent.length === 5, "readJournal: --days window drops the 40-day-old run");
const rows = J.summarize(recent);
assert(rows[0].signature === "job:a" && rows[0].candidate === true && rows[0].runs === 4 && rows[0].passes === 3,
  "summarize: job a is a candidate (3 passes of 4), sorted first");
assert(Math.abs(rows[0].costUsd - 0.7) < 1e-9 && rows[0].avgTokens === 1100, "summarize: totals + avg tokens");
assert(rows[1].signature === "job:b" && rows[1].candidate === false, "summarize: single run is not a candidate");
assert(rows[0].lastVerdict === "pass" && Date.parse(rows[0].lastRun) > Date.parse(iso(0.9)), "summarize: lastRun is the newest");
const withSessions = recent.concat([{ runId: "s1", task: "turn", mode: "session", session: "turo", verdict: "reply", costUsd: 5, startedAt: iso(0.5), endedAt: iso(0.5), stages: [] }]);
assert(J.summarize(withSessions).length === rows.length && J.summarize(withSessions).every((r) => !r.modes.session) && Math.abs(J.summarize(withSessions)[0].costUsd - 0.7) < 1e-9, "summarize: session records are ignored");
const report = J.formatReport(rows, { days: 30 });
assert(report.includes("* = economy-mode candidate") && /\*\s+4\s+75%/.test(report), "formatReport: marks candidate row");
assert(J.formatReport([], { days: 7 }).includes("no agent runs"), "formatReport: empty");
const leaky = J.summarize([rec({ job: "a", tabsRetained: 1 }), rec({ job: "a", tabsRetained: 0 }), rec({ job: "b", signature: "job:b" })]);
assert(leaky.find((r) => r.signature === "job:a").tabsRetained === 1 && leaky.find((r) => r.signature === "job:b").tabsRetained === 0, "summarize: tabsRetained summed per job");
const leakReport = J.formatReport(leaky, { days: 30 });
assert(/tabs left/.test(leakReport) && /job:a/.test(leakReport.split("\n").find((l) => /\b1\s+job:a$/.test(l)) || ""), "formatReport: tabs left column shows retained tabs per job");

// patchRun: the server updates a run's record in place (late tab closures)
J.appendJournal(rec({ runId: "patchme", job: "p" }));
assert(J.patchRun("patchme", { tabsClosed: 2, late: true }) === true, "patchRun returns true");
const got = J.readJournal().find((r) => r.runId === "patchme");
assert(got.tabsClosed === 2 && got.late === true && got.job === "p", "patchRun merges into the record in place");
assert(J.patchRun("nope", { x: 1 }) === false, "patchRun unknown run → false");
assert(J.readJournal().filter((r) => r.runId === "patchme").length === 1, "patchRun does not duplicate the record");

console.log(failures === 0 ? "\nAll journal tests passed." : `\n${failures} test(s) FAILED.`);
process.exit(failures ? 1 : 0);
