#!/usr/bin/env node
// The agent's access gate: pre-flight latches (serverId, extGen, accessGen),
// every spawn is preceded by a check, a running child is aborted when the
// 10-s poll sees a change, and the run ends with access_revoked without
// climbing the ladder. Injected ping — no relay, no models.
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-agent-access-"));
const { createAccessGate, withAccess, AccessError } = require("../server/access-gate.js");
const { runAgent, runTurn, JUDGE_MODEL } = require("../server/agent.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const granted = (over = {}) => ({ pong: true, access: "granted", serverId: "s1", extGen: 1, accessGen: 3, session: "chrome", ...over });
const noLease = async () => ({ end: async () => null, close() {} });

// Queued replies, the last one repeats. "timeout" rejects after timeoutMs;
// "malformed" resolves to a non-object; an object with `error` rejects with it.
function mockPing(replies) {
  let i = 0;
  const calls = [];
  const ping = ({ timeoutMs } = {}) => {
    const r = replies[Math.min(i++, replies.length - 1)];
    calls.push(r);
    if (r === "timeout") return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs || 20));
    if (r === "malformed") return Promise.resolve("not json");
    if (r && r.error) return Promise.reject(new Error(r.error));
    return Promise.resolve(r);
  };
  ping.calls = calls;
  return ping;
}
function mockRun(judgeVerdicts) {
  const calls = [];
  let judgeIdx = 0;
  const run = async (opts) => {
    calls.push({ ...opts });
    if (opts.model === JUDGE_MODEL && opts.prompt.includes("strict verifier")) {
      return { result: judgeVerdicts[judgeIdx++] || '{"verdict":"fail","feedback":"none"}', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 };
    }
    return { result: "did stuff\nEVIDENCE REPORT\nTask: t\nActions: 1. x\nFinal state: ok\nScreenshots: none\nBlockers: none", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 };
  };
  return { run, calls };
}

(async () => {
  // ---- gate unit ----------------------------------------------------------
  let gate = createAccessGate({ ping: mockPing([granted()]), intervalMs: 20, timeoutMs: 30 });
  const id = await gate.preflight();
  assert(id.serverId === "s1" && id.extGen === 1 && id.accessGen === 3 && gate.identity.accessGen === 3, "preflight latches the triple");
  await gate.check();
  for (const [name, reply] of [["accessGen", granted({ accessGen: 4 })], ["extGen", granted({ extGen: 2 })], ["serverId", granted({ serverId: "s2" })]]) {
    gate = createAccessGate({ ping: mockPing([granted(), reply]), intervalMs: 20, timeoutMs: 30 }); await gate.preflight();
    let e = null; try { await gate.check(); } catch (x) { e = x; }
    assert(e instanceof AccessError && /identity changed \(.*\)/.test(e.message) && new RegExp(name).test(e.message) && /^access_revoked: /.test(e.message), `a changed ${name} ends the run`);
  }
  gate = createAccessGate({ ping: mockPing([granted({ access: "revoked" })]) });
  let e = null; try { await gate.preflight(); } catch (x) { e = x; }
  assert(e instanceof AccessError && e.message === 'access_revoked: access revoked by user (session "chrome")', "preflight with revoked → access_revoked");
  gate = createAccessGate({ ping: mockPing([granted({ access: "not_granted", session: "work-chrome" })]) });
  e = null; try { await gate.preflight(); } catch (x) { e = x; }
  assert(e instanceof AccessError && e.message === 'access_revoked: access not granted yet (session "work-chrome")', "not_granted → structured access_revoked with the not-granted reason");
  gate = createAccessGate({ ping: mockPing([granted(), "malformed"]) }); await gate.preflight();
  e = null; try { await gate.check(); } catch (x) { e = x; }
  assert(e instanceof AccessError && /malformed/.test(e.message), "malformed reply → access_revoked");
  gate = createAccessGate({ ping: mockPing([{ pong: true }]) });
  e = null; try { await gate.preflight(); } catch (x) { e = x; }
  assert(e instanceof AccessError && /malformed/.test(e.message), "a ping without the identity fields (old relay) → access_revoked");
  gate = createAccessGate({ ping: mockPing([granted(), { error: "ERROR: extension not connected (req 1)" }]) }); await gate.preflight();
  e = null; try { await gate.check(); } catch (x) { e = x; }
  assert(e instanceof AccessError && /extension not connected/.test(e.message), "extension not connected → access_revoked");
  gate = createAccessGate({ ping: mockPing([granted(), "timeout", granted(), "timeout", "timeout"]), timeoutMs: 20 }); await gate.preflight();
  await gate.check(); // one timeout tolerated
  await gate.check(); // success resets
  await gate.check(); // first of two
  e = null; try { await gate.check(); } catch (x) { e = x; }
  assert(e instanceof AccessError && /twice/.test(e.message), "two consecutive timeouts end the run, one is tolerated");

  // ---- withAccess aborts a running child -----------------------------------
  gate = createAccessGate({ ping: mockPing([granted(), granted(), granted({ access: "revoked" })]), intervalMs: 15, timeoutMs: 30 }); await gate.preflight();
  let aborted = false;
  e = null;
  try {
    await withAccess(gate, (o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => { aborted = true; rej(Object.assign(new Error("cancelled"), { name: "AbortError" })); })), {});
  } catch (x) { e = x; }
  assert(aborted && e instanceof AccessError, "withAccess: the poll seeing revoked aborts the child and surfaces access_revoked");
  gate = createAccessGate({ ping: mockPing([granted()]), intervalMs: 1000 }); await gate.preflight();
  const outer = new AbortController();
  let sawAbort = false;
  const p = withAccess(gate, (o) => new Promise((res) => { if (o.signal.aborted) { sawAbort = true; return res("stopped"); } o.signal.addEventListener("abort", () => { sawAbort = true; res("stopped"); }); }), { signal: outer.signal });
  outer.abort();
  assert((await p) === "stopped" && sawAbort, "withAccess chains the caller's own signal");
  gate = createAccessGate({ ping: mockPing([granted()]), intervalMs: 1000 }); await gate.preflight();
  assert((await withAccess(gate, async () => 7, {})) === 7, "withAccess returns the child's result when nothing changes");

  // ---- runAgent integration ------------------------------------------------
  {
    const m = mockRun(['{"verdict":"pass","feedback":"ok"}']); const g = createAccessGate({ ping: mockPing([granted({ access: "revoked" })]) });
    const r = await runAgent("t", {}, m.run, { accessGate: g, openLease: noLease });
    assert(m.calls.length === 0 && r.verdict.verdict === "fail" && r.blocker === "access_revoked" && r.record.blocker === "access_revoked" && /^access_revoked: /.test(r.verdict.feedback), "pre-flight revoked: no model spawned, run recorded as access_revoked");
  }
  {
    const m = mockRun(['{"verdict":"fail","feedback":"no"}', '{"verdict":"pass","feedback":"ok"}']);
    // preflight, check(ops1), check(judge1), check(ops2) → revoked
    const g = createAccessGate({ ping: mockPing([granted(), granted(), granted(), granted({ access: "revoked" })]), intervalMs: 1000 });
    const r = await runAgent("t", {}, m.run, { accessGate: g, openLease: noLease });
    assert(m.calls.length === 2 && r.blocker === "access_revoked" && r.verdict.verdict === "fail", "revoke between rungs: the ladder does not climb");
  }
  {
    const m = mockRun([]); const g = createAccessGate({ ping: mockPing([granted(), granted({ accessGen: 9 })]), intervalMs: 1000 });
    const r = await runAgent("t", {}, m.run, { accessGate: g, openLease: noLease });
    assert(m.calls.length === 0 && /identity changed/.test(r.verdict.feedback), "a regrant between preflight and the first spawn ends the run");
  }
  {
    const pings = [];
    const g = createAccessGate({ ping: async () => { pings.push(1); return granted(); }, intervalMs: 1000 });
    const m = mockRun(['{"verdict":"pass","feedback":"ok"}']);
    await runAgent("t", {}, m.run, { accessGate: g, openLease: noLease });
    assert(pings.length === m.calls.length + 1, `every spawn is preceded by a check (preflight + ${m.calls.length} spawns = ${pings.length} pings)`);
  }
  {
    // a child aborted by the poll: the mock run honours the signal
    const g = createAccessGate({ ping: mockPing([granted(), granted(), granted({ access: "revoked" })]), intervalMs: 15, timeoutMs: 30 });
    let childAborted = false;
    const run = (o) => new Promise((res, rej) => { o.signal.addEventListener("abort", () => { childAborted = true; rej(Object.assign(new Error("cancelled"), { name: "AbortError" })); }); });
    const r = await runAgent("t", {}, run, { accessGate: g, openLease: noLease });
    assert(childAborted && r.blocker === "access_revoked" && r.verdict.verdict === "fail", "a revoke seen by the poll aborts the running child and ends the run");
  }
  // ---- runTurn through the gate ---------------------------------------------
  {
    const g = createAccessGate({ ping: mockPing([granted({ access: "revoked" })]) });
    let err = null, spawned = false;
    try { await runTurn({ model: "m", text: "hi", claudeSessionId: "u", cwd: os.tmpdir(), accessGate: g, baseEnv: {} }, async () => { spawned = true; return { result: "x", session_id: "u" }; }); } catch (x) { err = x; }
    assert(err instanceof AccessError && !spawned, "runTurn: revoked → AccessError, no spawn");
    const g2 = createAccessGate({ ping: mockPing([granted()]), intervalMs: 1000 });
    const t = await runTurn({ model: "m", text: "hi", claudeSessionId: "u", cwd: os.tmpdir(), accessGate: g2, baseEnv: {} }, async () => ({ result: "x", session_id: "u" }));
    assert(t.text === "x", "runTurn: granted → the turn runs");
  }

  console.log(failures ? `\n${failures} TEST(S) FAILED` : "\nAll agent access tests passed.");
  process.exit(failures ? 1 : 0);
})();
