#!/usr/bin/env node
// Manager: policy + pairing, queue, intent gate, approvals (buttons and text), delivery,
// commands, cancel, rate limits, redaction, restart recovery. Fake adapter, fake runAgent.
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-manager-"));
const { Manager } = require("../server/channels/manager.js");
const { ChannelState } = require("../server/channels/state.js");
const pairing = require("../server/channels/pairing.js");
const { Approvals, encode } = require("../server/channels/approvals.js");
const { RateLimiter } = require("../server/channels/policy.js");
const journal = require("../server/journal.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const TOKEN = "tok-secret-1234";
let clock = 1_700_000_000_000;
const now = () => clock;

function fakeAdapter({ buttons = true } = {}) {
  const a = {
    id: "fake", accountId: "default",
    capabilities: { buttons, media: true, edit: true, textLimit: 4000, chunkMode: "text", maxFileBytes: 1e6 },
    sent: [], started: false, offsets: null, inbound: null, action: null,
    async start(onInbound, offsets) { a.started = true; a.inbound = onInbound; a.offsets = offsets; },
    async stop() { a.started = false; },
    onAction(h) { a.action = h; },
    async sendText(chatId, text) { a.sent.push({ type: "text", chatId, text }); return { messageId: a.sent.length }; },
    async sendButtons(chatId, text, buttons) { a.sent.push({ type: "buttons", chatId, text, buttons }); return { messageId: a.sent.length }; },
    async editMessage(chatId, messageId, text, buttons) { a.sent.push({ type: "edit", chatId, messageId, text, buttons }); },
    async sendFile(chatId, file, caption) { a.sent.push({ type: "file", chatId, name: file.name, bytes: fs.readFileSync(file.fd, "utf8"), caption }); return { messageId: a.sent.length }; },
    emit(evt) { return a.inbound({ accountId: "default", chatType: "direct", ...evt }); },
    emitAction(act) { return a.action({ ack: async () => { a.acks = (a.acks || 0) + 1; }, ...act }); },
    texts() { return a.sent.filter((s) => s.type === "text").map((s) => s.text); },
  };
  return a;
}

function fakeRunAgent() {
  const calls = [];
  let pendingResolve = null;
  const fn = (task, opts) => {
    calls.push({ task, opts });
    return new Promise((resolve) => { pendingResolve = resolve; });
  };
  const finish = (report) => {
    const r = pendingResolve; pendingResolve = null;
    const last = calls[calls.length - 1];
    r({ verdict: { verdict: "pass", feedback: "done" }, evidence: "EVIDENCE REPORT\nTask: t\nFinal state: ok", stages: [], runId: last.opts.runId, record: {}, ...report });
  };
  return { fn, calls, finish, busy: () => pendingResolve !== null };
}

function build({ adapter, runAgent, config, stateFile, classify } = {}) {
  const state = new ChannelState(stateFile || path.join(process.env.AI_BRIDGE_HOME, `state-${Math.random().toString(36).slice(2)}.json`));
  process.env.MGR_PASS = "yes"; process.env.AI_BRIDGE_TELEGRAM_TOKEN = TOKEN;
  const m = new Manager({
    config: config || { fake: { token: TOKEN, dmPolicy: "pairing", allowFrom: [], codex: false, accountId: "default", envPassthrough: ["MGR_PASS"] } },
    adapters: [adapter], state, pairing,
    approvals: new Approvals({ now }),
    limiter: new RateLimiter({ now }),
    runAgent: runAgent.fn,
    runModel: async ({ prompt }) => ({ result: classify ? await classify(prompt) : "read" }),
    bridgePing: async () => ({ ok: true, text: '{"pong":true,"version":"test"}' }),
    jobsTable: () => "job   mode\n toll  economy",
    log: () => {}, now,
  });
  return { m, state };
}

(async () => {
  // ---- 1) pairing: unknown sender gets one code message, then silence
  {
    const a = fakeAdapter(); const ra = fakeRunAgent();
    const { m, state } = build({ adapter: a, runAgent: ra });
    await m.start();
    assert(a.started && typeof a.offsets.getOffset === "function" && typeof a.offsets.setOffset === "function", "start: adapter started with offset callbacks");
    await a.emit({ senderId: "1", chatId: "1", messageId: 1, eventId: "e1", text: "hello", meta: { username: "ann" } });
    await a.emit({ senderId: "1", chatId: "1", messageId: 2, eventId: "e2", text: "hello again" });
    const code = pairing.load().pending.find((p) => p.senderId === "1").code;
    assert(a.texts().length === 1 && a.texts()[0] === `Not paired. Code: ${code}. The operator runs: bridge pairing approve fake ${code}`, "pairing: exactly one notice with the code");
    assert(state.queue().length === 0 && ra.calls.length === 0, "pairing: nothing queued, nothing run");
    await m.stop();
  }

  // ---- 2) allowlist: unknown → silent drop
  {
    const a = fakeAdapter(); const ra = fakeRunAgent();
    const { m, state } = build({ adapter: a, runAgent: ra, config: { fake: { token: TOKEN, dmPolicy: "allowlist", allowFrom: ["9"], codex: false, accountId: "default" } } });
    await m.start();
    await a.emit({ senderId: "2", chatId: "2", messageId: 1, eventId: "e1", text: "hi" });
    assert(a.sent.length === 0 && state.queue().length === 0, "allowlist: unknown sender dropped silently");
    await m.stop();
  }

  // ---- 3) paired sender: task accepted atomically, queue positions, caps
  pairing.save({ pending: [], approved: [{ channel: "fake", accountId: "default", senderId: "42", approvedAt: "x" }, { channel: "fake", accountId: "default", senderId: "43", approvedAt: "x" }] });
  {
    const a = fakeAdapter(); const ra = fakeRunAgent();
    const { m, state } = build({ adapter: a, runAgent: ra });
    await m.start();
    let queuedDuring = null;
    const p = a.emit({ senderId: "42", chatId: "42", messageId: 1, eventId: "e1", text: "get the page title" }).then(() => { queuedDuring = state.queue().length; });
    await p;
    assert(queuedDuring === 1, "accept: task persisted before handleInbound resolves");
    await tick();
    assert(/^⏳ working on it \(run [0-9a-f]+\)$/.test(a.texts()[0]), "accept: first task replies 'working on it'");
    assert(ra.calls.length === 1 && ra.calls[0].opts.restricted === true && ra.calls[0].opts.source === "channel:fake" && ra.calls[0].opts.codex === false, "run: runAgent called restricted with source");
    assert(ra.calls[0].opts.baseEnv && ra.calls[0].opts.baseEnv.PATH === process.env.PATH && !("AI_BRIDGE_TELEGRAM_TOKEN" in ra.calls[0].opts.baseEnv) && ra.calls[0].opts.baseEnv.MGR_PASS === "yes", "run: baseEnv is scrubbed and honours envPassthrough");
    assert(fs.existsSync(ra.calls[0].opts.cwd) && ra.calls[0].opts.cwd.includes("outbox"), "run: cwd is a fresh outbox dir");
    assert(state.queue()[0].status === "running", "run: status running while the agent works");

    await a.emit({ senderId: "42", chatId: "42", messageId: 2, eventId: "e2", text: "second thing" });
    await a.emit({ senderId: "42", chatId: "42", messageId: 3, eventId: "e3", text: "third thing" });
    await a.emit({ senderId: "42", chatId: "42", messageId: 4, eventId: "e4", text: "fourth thing" });
    assert(a.texts().some((t) => /⏳ queued \(run [0-9a-f]+, position 2\)/.test(t)) && a.texts().some((t) => /position 3\)/.test(t)), "queue: later tasks get positions 2 and 3");
    assert(a.texts().some((t) => /^queue full \(\d+ waiting\); try again later$/.test(t)), "queue: 4th task from one sender refused");
    assert(state.queue().length === 3 && ra.calls.length === 1, "queue: one running, two waiting");

    // duplicate event id ignored
    await a.emit({ senderId: "42", chatId: "42", messageId: 2, eventId: "e2", text: "second thing" });
    assert(state.queue().length === 3, "dedup: replayed event id not queued twice");

    // progress coalescing: first progress message immediately, next within 15 s suppressed
    ra.calls[0].opts.onProgress({ stage: "ops:opus-5.5" });
    ra.calls[0].opts.onProgress({ stage: "judge:fable-5.1" });
    await tick();
    assert(a.texts().filter((t) => t.startsWith("… ")).length === 1 && a.texts().some((t) => t === "… ops:opus-5.5"), "progress: coalesced to one message per 15 s");

    // completion: verdict, evidence, file; symlink skipped; token redacted
    const cwd = ra.calls[0].opts.cwd;
    fs.writeFileSync(path.join(cwd, "result.txt"), "RESULT");
    fs.symlinkSync(path.join(process.env.AI_BRIDGE_HOME, "nothing"), path.join(cwd, "evil"));
    ra.finish({ evidence: `EVIDENCE REPORT\nTask: t\nFinal state: used ${TOKEN}\n` + "x".repeat(9000) });
    await tick(60);
    const texts = a.texts();
    const done = texts.findIndex((t) => t.startsWith("✅ pass"));
    assert(done > 0 && texts[done] === "✅ pass — done", "deliver: verdict line");
    const ev = texts.slice(done + 1).filter((t) => t.startsWith("EVIDENCE REPORT") || /^x+$/.test(t));
    assert(ev.length >= 3 && ev.every((t) => t.length <= 4000), "deliver: evidence chunked to textLimit");
    assert(ev[0].includes("<redacted>") && !texts.some((t) => t.includes(TOKEN)), "deliver: token redacted from evidence");
    const file = a.sent.find((s) => s.type === "file");
    assert(file && file.name === "result.txt" && file.bytes === "RESULT" && file.chatId === "42", "deliver: outbox file sent to the sender");
    assert(texts.some((t) => t === "skipped: evil (symlink)"), "deliver: symlink reported as skipped");
    assert(!fs.existsSync(path.join(cwd, "result.txt")), "deliver: delivered file removed from the outbox");
    await tick();
    assert(state.queue().length === 2 && ra.calls.length === 2 && ra.calls[1].task === "second thing", "queue: next task started after delivery");

    // /cancel: aborts the running task and drops the sender's queued tasks
    await a.emit({ senderId: "42", chatId: "42", messageId: 9, eventId: "e9", text: "/cancel" });
    assert(ra.calls[1].opts.signal.aborted === true, "cancel: current run's signal aborted");
    ra.finish({ verdict: { verdict: "cancelled", feedback: "stopped by user; actions already performed were not undone" }, evidence: "" });
    await tick(60);
    assert(a.texts().some((t) => t === "stopped; actions already performed were not undone") && a.texts().some((t) => t.startsWith("⏹ cancelled")), "cancel: confirmation and cancelled verdict line");
    assert(state.queue().length === 0 && ra.calls.length === 2, "cancel: queued tasks of the sender removed, nothing else started");
    await m.stop();
  }

  // ---- 4) intent gate with buttons: same actor approves; other actor forbidden; deny → declined
  {
    const a = fakeAdapter(); const ra = fakeRunAgent();
    const { m, state } = build({ adapter: a, runAgent: ra });
    await m.start();
    await a.emit({ senderId: "42", chatId: "42", messageId: 1, eventId: "e1", text: "send the invoice to Bob" });
    await tick();
    const prompt = a.sent.find((s) => s.type === "buttons");
    assert(prompt && prompt.text.startsWith("This task looks like it will send, submit or change something:\n\"send the invoice to Bob\"\nApprove?") && prompt.buttons.length === 2 && prompt.buttons[0].label === "Approve" && /^ab1:intent:a:[0-9a-f]{16}$/.test(prompt.buttons[0].data) && /^ab1:intent:d:/.test(prompt.buttons[1].data),
      "intent: approval prompt with Approve/Cancel buttons");
    assert(ra.calls.length === 0 && state.queue()[0].status === "awaiting-approval", "intent: agent not started, status awaiting-approval");
    await a.emitAction({ actorId: "43", chatId: "42", messageId: prompt && 1, data: prompt.buttons[0].data });
    await tick();
    assert(ra.calls.length === 0 && !a.sent.some((s) => s.type === "edit"), "intent: another paired user cannot approve (no run, no edit)");
    await a.emitAction({ actorId: "42", chatId: "42", messageId: 1, data: prompt.buttons[0].data });
    await tick();
    assert(ra.calls.length === 1 && ra.calls[0].task === "send the invoice to Bob", "intent: originator's tap starts the run");
    assert(a.sent.some((s) => s.type === "edit" && /approved/.test(s.text) && s.buttons.length === 0), "intent: prompt edited to approved, buttons removed");
    // stale second tap
    await a.emitAction({ actorId: "42", chatId: "42", messageId: 1, data: prompt.buttons[0].data });
    assert(a.sent.filter((s) => s.type === "edit").pop().text.includes("(no longer pending)"), "intent: stale tap edits to 'no longer pending'");
    assert(a.acks === 3, "intent: every callback acknowledged");
    ra.finish({});
    await tick(60);

    // deny path
    await a.emit({ senderId: "42", chatId: "42", messageId: 2, eventId: "e2", text: "pay the parking ticket" });
    await tick();
    const p2 = a.sent.filter((s) => s.type === "buttons").pop();
    await a.emitAction({ actorId: "42", chatId: "42", messageId: 2, data: p2.buttons[1].data });
    await tick(60);
    assert(ra.calls.length === 1 && a.texts().some((t) => t.startsWith("🚫 declined")), "intent: deny → declined, agent never called");
    assert(journal.readJournal({}).some((r) => r.verdict === "declined" && r.task === "pay the parking ticket" && r.source === "channel:fake"), "intent: declined run journaled with source");
    assert(state.queue().length === 0, "intent: declined item removed from the queue");

    // oversized task → prompt bounded
    await a.emit({ senderId: "42", chatId: "42", messageId: 3, eventId: "e3", text: "send " + "y".repeat(6000) });
    await tick();
    const p3 = a.sent.filter((s) => s.type === "buttons").pop();
    assert(p3.text.length <= 4000 && p3.text.includes("…"), "intent: 6000-char task → prompt ≤ textLimit, truncated with …");
    await a.emitAction({ actorId: "42", chatId: "42", messageId: 3, data: p3.buttons[1].data });
    await tick(60);

    // foreign / malformed callbacks
    const before = a.sent.length;
    await a.emitAction({ actorId: "42", chatId: "42", messageId: 1, data: "tga1:e:o:x" });
    await a.emitAction({ actorId: "42", chatId: "42", messageId: 1, data: "ab1:garbage" });
    assert(a.sent.length === before && a.acks === 7, "callbacks: foreign prefix and malformed data ignored but acknowledged");
    await m.stop();
  }

  // ---- 5) no buttons: text fallback and /approve
  {
    const a = fakeAdapter({ buttons: false }); const ra = fakeRunAgent();
    const { m } = build({ adapter: a, runAgent: ra });
    await m.start();
    await a.emit({ senderId: "42", chatId: "42", messageId: 1, eventId: "e1", text: "email the report" });
    await tick();
    const prompt = a.texts().find((t) => t.includes("/approve"));
    const id = /\/approve ([0-9a-f]{16}) yes/.exec(prompt)[1];
    assert(prompt.endsWith(`reply /approve ${id} yes or /approve ${id} no`), "text fallback: prompt ends with the /approve instructions");
    await a.emit({ senderId: "43", chatId: "43", messageId: 2, eventId: "e2", text: `/approve ${id} yes` });
    await tick();
    assert(ra.calls.length === 0 && a.sent.some((s) => s.chatId === "43" && /not yours|cannot approve/i.test(s.text)), "text fallback: other user's /approve refused");
    await a.emit({ senderId: "42", chatId: "42", messageId: 3, eventId: "e3", text: `/approve ${id} yes` });
    await tick();
    assert(ra.calls.length === 1, "text fallback: originator's /approve starts the run");
    ra.finish({});
    await tick(60);
    await m.stop();
  }

  // ---- 6) agent-side approvals (recipe/step) go through the same prompt
  {
    const a = fakeAdapter(); const ra = fakeRunAgent();
    const { m, state } = build({ adapter: a, runAgent: ra });
    await m.start();
    await a.emit({ senderId: "42", chatId: "42", messageId: 1, eventId: "e1", text: "look at the toll page" });
    await tick();
    const decisionP = ra.calls[0].opts.approve({ kind: "step", title: "click Send", detail: "the agent stopped before this action", digest: "d" });
    await tick();
    const prompt = a.sent.filter((s) => s.type === "buttons").pop();
    assert(prompt.text === "Approval needed: click Send\nthe agent stopped before this action" && /^ab1:step:a:/.test(prompt.buttons[0].data), "agent approval: prompt with kind step");
    assert(state.queue()[0].status === "awaiting-approval", "agent approval: status awaiting-approval while waiting");
    await a.emitAction({ actorId: "42", chatId: "42", messageId: 2, data: prompt.buttons[0].data });
    assert((await decisionP) === "approved" && state.queue()[0].status === "running", "agent approval: resolves approved and status back to running");
    ra.finish({ verdict: { verdict: "fail", feedback: "could not find Send" } });
    await tick(60);
    assert(a.texts().some((t) => t === "❌ fail — could not find Send") && a.texts().some((t) => t === "reply /retry to run again"), "deliver: fail line and retry hint");
    // /retry re-queues the last task
    await a.emit({ senderId: "42", chatId: "42", messageId: 3, eventId: "e3", text: "/retry" });
    await tick();
    assert(ra.calls.length === 2 && ra.calls[1].task === "look at the toll page", "/retry: last task re-run");
    ra.finish({});
    await tick(60);
    await m.stop();
  }

  // ---- 7) commands without a model; rate limit notice once
  {
    const a = fakeAdapter(); const ra = fakeRunAgent();
    const { m } = build({ adapter: a, runAgent: ra });
    await m.start();
    for (const [i, cmd] of ["/ping", "/status", "/jobs", "/help", "/journal 7", "/bogus"].entries()) await a.emit({ senderId: "42", chatId: "42", messageId: 10 + i, eventId: `c${i}`, text: cmd });
    const t = a.texts();
    assert(ra.calls.length === 0, "commands: no agent runs");
    assert(t[0].startsWith("bridge ok") && t[0].includes("pong"), "/ping: reports bridge health");
    assert(/queue: 0/.test(t[1]) && /uptime/.test(t[1]), "/status: uptime and queue");
    assert(t[2].includes("toll") && t[2].includes("economy"), "/jobs: table");
    assert(t[3].includes("/cancel") && t[3].includes("/approve <id> yes|no") && t[3].includes("/retry"), "/help: lists commands");
    assert(t[4].split("\n").length === 3 && /^runs: \d+, pass rate: \d+%$/.test(t[4].split("\n")[0]) && /^cost: \$/.test(t[4].split("\n")[1]) && /^jobs: /.test(t[4].split("\n")[2]), "/journal: three-line summary");
    assert(/unknown command/.test(t[5]) && t[5].includes("/help"), "unknown command: points to /help");

    // rate limit: 25 quick tasks → 3 queued, rest refused by queue cap or rate limit; one notice
    for (let i = 0; i < 25; i++) await a.emit({ senderId: "43", chatId: "43", messageId: 100 + i, eventId: `r${i}`, text: `task ${i}` });
    const rl = a.sent.filter((s) => s.chatId === "43" && /rate limited/.test(s.text));
    assert(rl.length === 1, `rate limit: exactly one notice (got ${rl.length})`);
    clock += 61000;
    await a.emit({ senderId: "43", chatId: "43", messageId: 200, eventId: "r200", text: "task later" });
    assert(a.sent.filter((s) => s.chatId === "43" && /queue full/.test(s.text)).length > 0 && !a.sent.slice(-1)[0].text.includes("rate limited"), "rate limit: window resets after 60 s");
    // oversized message
    await a.emit({ senderId: "42", chatId: "42", messageId: 300, eventId: "big", text: "z".repeat(9000) });
    assert(a.sent.slice(-1)[0].text.includes("too long"), "inbound: >8 KB text refused");
    await m.stop();
  }

  // ---- 8) restart recovery: uncertain items declined, queued item runs once
  {
    const stateFile = path.join(process.env.AI_BRIDGE_HOME, "recover.json");
    const seed = new ChannelState(stateFile);
    seed.accept({ accountKey: "fake:default", eventId: "s1", item: { runId: "runA00000001", channel: "fake", accountId: "default", chatId: "42", senderId: "42", task: "was running" } });
    seed.accept({ accountKey: "fake:default", eventId: "s2", item: { runId: "runB00000002", channel: "fake", accountId: "default", chatId: "42", senderId: "42", task: "was awaiting" } });
    seed.accept({ accountKey: "fake:default", eventId: "s3", item: { runId: "runC00000003", channel: "fake", accountId: "default", chatId: "42", senderId: "42", task: "was queued" } });
    seed.setStatus("runA00000001", "running");
    seed.setStatus("runB00000002", "awaiting-approval");
    const a = fakeAdapter(); const ra = fakeRunAgent();
    const { m, state } = build({ adapter: a, runAgent: ra, stateFile });
    await m.start();
    await tick();
    const restarted = a.texts().filter((t) => t.startsWith("restarted;"));
    assert(restarted.length === 2 && restarted.some((t) => t.includes('"was running"')) && restarted.some((t) => t.includes('"was awaiting"')) && restarted.every((t) => t.endsWith("was not replayed, send it again if still wanted")),
      "recovery: two 'not replayed' notices");
    assert(journal.readJournal({}).filter((r) => r.verdict === "declined" && /daemon restarted/.test(r.feedback || "") && ["runA00000001", "runB00000002"].includes(r.runId)).length === 2, "recovery: two declined journal records");
    assert(ra.calls.length === 1 && ra.calls[0].task === "was queued" && ra.calls[0].opts.runId === "runC00000003", "recovery: queued item runs exactly once");
    ra.finish({});
    await tick(60);
    assert(state.queue().length === 0, "recovery: queue drained");
    await m.stop();
  }

  // ---- 9) review fixes: revocation is honoured late, cancel while awaiting, done-item recovery, digest, drain guard
  {
    let unhandled = 0; const onUR = () => { unhandled++; }; process.on("unhandledRejection", onUR);
    pairing.save({ pending: [], approved: [{ channel: "fake", accountId: "default", senderId: "42", approvedAt: "x" }, { channel: "fake", accountId: "default", senderId: "44", approvedAt: "x" }] });
    const a = fakeAdapter(); const ra = fakeRunAgent();
    const { m, state } = build({ adapter: a, runAgent: ra });
    await m.start();
    // 44 queues a task behind 42's running one, then gets revoked
    await a.emit({ senderId: "42", chatId: "42", messageId: 1, eventId: "e1", text: "first" });
    await tick();
    await a.emit({ senderId: "44", chatId: "44", messageId: 2, eventId: "e2", text: "second from 44" });
    pairing.revoke("fake", "44");
    ra.finish({});
    await tick(60);
    assert(ra.calls.length === 1 && a.sent.some((s) => s.chatId === "44" && /no longer paired/.test(s.text)) && state.queue().length === 0, "revocation: a queued task from a revoked sender is dropped with a notice, not run");

    // revoked actor cannot approve: 42's write task, then revoke 42, tap → forbidden
    pairing.save({ pending: [], approved: [{ channel: "fake", accountId: "default", senderId: "42", approvedAt: "x" }] });
    await a.emit({ senderId: "42", chatId: "42", messageId: 3, eventId: "e3", text: "send it now" });
    await tick();
    const p1 = a.sent.filter((s) => s.type === "buttons").pop();
    pairing.revoke("fake", "42");
    await a.emitAction({ actorId: "42", chatId: "42", messageId: 3, data: p1.buttons[0].data });
    await tick();
    assert(ra.calls.length === 1 && !a.sent.some((s) => s.type === "edit" && /approved/.test(s.text)), "revocation: a revoked sender's tap does not approve");
    pairing.save({ pending: [], approved: [{ channel: "fake", accountId: "default", senderId: "42", approvedAt: "x" }] });
    // cancel while awaiting approval → cancelled, journaled as cancelled, not declined
    await a.emit({ senderId: "42", chatId: "42", messageId: 4, eventId: "e4", text: "/cancel" });
    await tick(60);
    const j = journal.readJournal({}).filter((r) => r.task === "send it now");
    assert(a.texts().some((t) => t.startsWith("⏹ cancelled")) && j.length === 1 && j[0].verdict === "cancelled", "cancel while awaiting approval: ⏹ cancelled and one journal record with verdict cancelled");
    assert(state.queue().length === 0 && ra.calls.length === 1, "cancel while awaiting approval: item removed, agent never called");

    // agent-side approval keeps the agent's digest
    await a.emit({ senderId: "42", chatId: "42", messageId: 5, eventId: "e5", text: "look at it" });
    await tick();
    const dp = ra.calls[1].opts.approve({ kind: "recipe", title: "toll", detail: "recipe v3 (risk write)", digest: "feedfacefeedface" });
    await tick();
    const runId = ra.calls[1].opts.runId;
    assert(m.approvals.pendingFor(runId)[0].digest === "feedfacefeedface", "approval binding: the agent's digest is stored, not the prompt text's");
    const pr = a.sent.filter((s) => s.type === "buttons").pop();
    await a.emitAction({ actorId: "42", chatId: "42", messageId: 5, data: pr.buttons[1].data });
    assert((await dp) === "denied", "approval: deny resolves denied");
    // drain guard: a throwing state write must not become an unhandled rejection
    const origRemove = state.remove.bind(state);
    let thrown = false;
    state.remove = (pred) => { if (!thrown) { thrown = true; throw new Error("disk full"); } return origRemove(pred); };
    ra.finish({});
    await tick(80);
    state.remove = origRemove;
    assert(unhandled === 0, "drain guard: a throwing state write is caught (no unhandledRejection)");
    await m.stop();
    process.off("unhandledRejection", onUR);
  }
  {
    // recovery: a `done` item whose journal record exists → one notice, no duplicate journal, removed
    const stateFile = path.join(process.env.AI_BRIDGE_HOME, "recover2.json");
    const seed = new ChannelState(stateFile);
    seed.accept({ accountKey: "fake:default", eventId: "d1", item: { runId: "runD00000004", channel: "fake", accountId: "default", chatId: "42", senderId: "42", task: "was done" } });
    seed.setStatus("runD00000004", "done");
    journal.appendJournal({ runId: "runD00000004", task: "was done", verdict: "pass", mode: "regular", source: "channel:fake", startedAt: "x", endedAt: "y", stages: [], costUsd: 0, domains: [] });
    const a = fakeAdapter(); const ra = fakeRunAgent();
    const { m, state } = build({ adapter: a, runAgent: ra, stateFile });
    await m.start();
    await tick();
    assert(a.texts().some((t) => t.includes('"was done"') && /lost|not delivered/.test(t)), "recovery: done item → 'result lost' notice");
    assert(journal.readJournal({}).filter((r) => r.runId === "runD00000004").length === 1, "recovery: no duplicate journal record for a run that already has one");
    assert(state.queue().length === 0 && ra.calls.length === 0, "recovery: done item removed, nothing run");
    await m.stop();
  }

  fs.rmSync(process.env.AI_BRIDGE_HOME, { recursive: true, force: true });
  console.log(failures === 0 ? "\nAll manager tests passed." : `\n${failures} test(s) FAILED.`);
  process.exit(failures ? 1 : 0);
})();
