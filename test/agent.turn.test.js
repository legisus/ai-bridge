#!/usr/bin/env node
// runTurn: one restricted Claude session turn — argv shape (--session-id/--resume,
// snapshot off, system prompt), scrubbed env built by the runner itself, call ids,
// onSpawn, session_id check, missing-transcript handling; plus turnNote and the
// last-line approval marker. Uses the fake `claude` on PATH.
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-turn-"));
const { runTurn, lastNeedsApprovalLine, turnNote, OPS_PLAYBOOK } = require("../server/agent.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

(async () => {
  assert(lastNeedsApprovalLine("report\nNEEDS APPROVAL: send it\n\n") === "send it", "lastNeedsApprovalLine: last non-empty line");
  assert(lastNeedsApprovalLine("the user wrote NEEDS APPROVAL: x earlier\nall done") === null, "lastNeedsApprovalLine: a quoted line elsewhere does not count");
  assert(lastNeedsApprovalLine("") === null && lastNeedsApprovalLine(null) === null, "lastNeedsApprovalLine: empty is null");
  const note = turnNote({ turn: 2, authorized: null, declined: ["send it", "pay it"] });
  assert(note.startsWith(OPS_PLAYBOOK) && /Additional rules for this run/.test(note) && /turn 2 of an ongoing conversation/.test(note) && /Authorized for this turn: nothing beyond the user's message\./.test(note) && /do not do unless approved again\): send it; pay it\./.test(note), "turnNote: playbook + addendum + envelope");
  const note2 = turnNote({ turn: 3, authorized: "send it", declined: [] });
  assert(/Authorized for this turn: send it\./.test(note2) && /approved again\): none\./.test(note2) && /NEEDS APPROVAL: <what>/.test(note2), "turnNote: authorized line, empty declined list, marker instruction");

  // fake `claude` on PATH
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-fakebin-"));
  fs.copyFileSync(path.join(__dirname, "fixtures", "fake-claude.js"), path.join(bin, "claude"));
  fs.chmodSync(path.join(bin, "claude"), 0o755);
  const PATH = `${bin}:${process.env.PATH}`;
  const logFile = path.join(bin, "argv.log");
  const pidsFile = path.join(bin, "pids.json");
  const base = (extra = {}) => ({ PATH, HOME: process.env.HOME, FAKE_CLAUDE_LOG: logFile, ...extra });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
  const last = () => JSON.parse(fs.readFileSync(logFile, "utf8").trim().split("\n").pop());

  const U = "11111111-2222-4333-8444-555555555555";
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "turn-"));
  process.env.SECRET_TOKEN = "nope"; process.env.MGR_PASS = "yes"; process.env.AI_BRIDGE_JOB = "inherited";

  fs.writeFileSync(logFile, "");
  let r = await runTurn({ model: "m", text: "hello", claudeSessionId: U, resume: false, cwd, systemPrompt: "NOTE", baseEnv: base({ FAKE_CLAUDE_MODE: "ok" }), timeoutMs: 10000 });
  let argv = last();
  assert(r.sessionId === U && r.freshStart === false && r.calls.length === 1 && /^[0-9a-f]{12}$/.test(r.calls[0]) && Math.abs(r.usage.costUsd - 0.01) < 1e-9 && r.text.startsWith("EVIDENCE"), "runTurn: result shape with one call id");
  assert(argv[argv.indexOf("--session-id") + 1] === U && argv[argv.indexOf("--system-prompt-snapshot") + 1] === "off" && argv[argv.indexOf("--append-system-prompt") + 1] === "NOTE" && argv[argv.indexOf("-p") + 1] === "hello" && argv[argv.indexOf("--model") + 1] === "m" && argv[argv.indexOf("--output-format") + 1] === "json" && !argv.includes("--resume"), "runTurn: first turn uses --session-id, snapshot off, system prompt, text as -p");
  const allowed = argv[argv.indexOf("--allowedTools") + 1].split(",");
  const dis = argv[argv.indexOf("--disallowedTools") + 1].split(",");
  assert(allowed.length === 18 && allowed.every((t) => /^Bash\(.+ (ping|status|listTabs|newTab|navigate|eval|click|type|insertText|key|waitFor|scroll|snapshot|screenshot|pdf|selectTab|closeTab|detach):\*\)$/.test(t)) && ["Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent"].every((t) => dis.includes(t)) && dis.some((t) => /^Bash\(.+ agent:\*\)$/.test(t)), "runTurn: browser-only allowedTools; non-Bash tools and agent recursion disallowed");

  r = await runTurn({ model: "m", text: "again", claudeSessionId: U, resume: true, cwd, systemPrompt: "NOTE2", baseEnv: base({ FAKE_CLAUDE_MODE: "ok" }), timeoutMs: 10000 });
  argv = last();
  assert(argv[argv.indexOf("--resume") + 1] === U && !argv.includes("--session-id") && argv[argv.indexOf("--system-prompt-snapshot") + 1] === "off", "runTurn: later turns use --resume (snapshot still off)");

  // env: scrubbed base (inherited AI_BRIDGE_JOB removed), run metadata per call, default timeout
  let seen = null;
  const stub = (opts) => { seen = opts; return Promise.resolve({ result: "ok", session_id: U, usage: {}, total_cost_usd: 0 }); };
  await runTurn({ model: "m", text: "x", claudeSessionId: U, resume: true, cwd, systemPrompt: "n", envPassthrough: ["MGR_PASS"] }, stub);
  assert(/^[0-9a-f]{12}$/.test(seen.env.AI_BRIDGE_RUN_ID) && seen.env.AI_BRIDGE_OUTBOX === cwd && seen.env.AI_BRIDGE_RESTRICTED === "1" && !("AI_BRIDGE_JOB" in seen.env) && !("AI_BRIDGE_JOB" in seen.baseEnv) && seen.baseEnv.MGR_PASS === "yes" && !("SECRET_TOKEN" in seen.baseEnv) && seen.baseEnv.PATH === process.env.PATH && seen.restricted === true && seen.timeoutMs === 600000 && seen.session.id === U && seen.session.resume === true && seen.cwd === cwd && seen.prompt === "x" && seen.systemPrompt === "n", "runTurn: scrubbed base without the inherited job, call run id, default 10-minute timeout");
  await runTurn({ model: "m", text: "x", claudeSessionId: U, resume: true, cwd, systemPrompt: "n", baseEnv: { AI_BRIDGE_JOB: "given", PATH: "p" } }, stub);
  assert(!("AI_BRIDGE_JOB" in seen.baseEnv) && seen.baseEnv.PATH === "p", "runTurn: a supplied baseEnv also loses AI_BRIDGE_JOB");

  // onSpawn with the real child; a throwing onSpawn kills the child
  let pid = null;
  await runTurn({ model: "m", text: "x", claudeSessionId: U, resume: true, cwd, systemPrompt: "n", baseEnv: base({ FAKE_CLAUDE_MODE: "ok" }), timeoutMs: 10000, onSpawn: (p) => { pid = p; } });
  assert(Number.isInteger(pid) && pid > 0, "runTurn: onSpawn reports the child's pid");
  let err = null; fs.rmSync(pidsFile, { force: true });
  try { await runTurn({ model: "m", text: "x", claudeSessionId: U, resume: true, cwd, systemPrompt: "n", baseEnv: base({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_PIDS: pidsFile }), timeoutMs: 10000, onSpawn: () => { throw new Error("disk full"); } }); } catch (e) { err = e; }
  await new Promise((res) => setTimeout(res, 500));
  { let pids = null; try { pids = JSON.parse(fs.readFileSync(pidsFile, "utf8")); } catch {} assert(err && /disk full/.test(err.message) && (!pids || !alive(pids.parent)), "runTurn: a throwing onSpawn rejects and kills the child"); }

  // session id mismatch (runner returns another id)
  err = null; try { await runTurn({ model: "m", text: "x", claudeSessionId: U, resume: true, cwd, systemPrompt: "n" }, () => Promise.resolve({ result: "ok", session_id: "22222222-2222-4333-8444-555555555555", usage: {} })); } catch (e) { err = e; }
  assert(err && /session_id/.test(err.message), "runTurn: session_id mismatch is an error");
  err = null; try { await runTurn({ model: "m", text: "x", claudeSessionId: U, resume: true, cwd, systemPrompt: "n" }, () => Promise.resolve({ result: "ok", usage: {} })); } catch (e) { err = e; }
  assert(err && /session_id/.test(err.message), "runTurn: a result without session_id is an error");

  // missing transcript
  err = null; try { await runTurn({ model: "m", text: "x", claudeSessionId: U, resume: true, retryFresh: false, cwd, systemPrompt: "n", baseEnv: base({ FAKE_CLAUDE_MODE: "noconv" }), timeoutMs: 10000 }); } catch (e) { err = e; }
  assert(err && /No conversation found/.test(err.message), "runTurn: missing transcript with retryFresh=false fails closed");
  fs.writeFileSync(logFile, "");
  r = await runTurn({ model: "m", text: "x", claudeSessionId: U, resume: true, retryFresh: true, cwd, systemPrompt: "n", baseEnv: base({ FAKE_CLAUDE_MODE: "noconv" }), timeoutMs: 10000 });
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert(r.freshStart === true && r.calls.length === 2 && r.calls[0] !== r.calls[1] && lines.length === 2 && lines[0].includes("--resume") && lines[1].includes("--session-id") && !lines[1].includes("--resume"), "runTurn: retryFresh retries once with --session-id under a new call id");
  err = null; try { await runTurn({ model: "m", text: "x", claudeSessionId: U, resume: false, retryFresh: true, cwd, systemPrompt: "n" }, () => Promise.reject(new Error("claude (m) exited 1: No conversation found with session ID: x"))); } catch (e) { err = e; }
  assert(err && /No conversation found/.test(err.message), "runTurn: retryFresh never retries a non-resume spawn");

  r = await runTurn({ model: "m", text: "x", claudeSessionId: U, resume: true, cwd, systemPrompt: "n", baseEnv: base({ FAKE_CLAUDE_MODE: "approval" }), timeoutMs: 10000 });
  assert(lastNeedsApprovalLine(r.text) === "send the reply", "runTurn: approval marker survives in text");

  fs.rmSync(bin, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(process.env.AI_BRIDGE_HOME, { recursive: true, force: true });
  console.log(failures === 0 ? "\nAll turn tests passed." : `\n${failures} test(s) FAILED.`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
