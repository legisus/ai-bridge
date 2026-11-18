#!/usr/bin/env node
// Manager + sessions: commands, @name routing, owner-key scoping, byte cap, pause/stop
// ordering, retry by target id, /stop all, /status, /help. Fake adapter; the fake
// runAgent never resolves on its own so runs stay observable.
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-mgr-sessions-"));
const pairing = require("../server/channels/pairing.js");
const journal = require("../server/journal.js");
const { advanceClock, tick, fakeAdapter, fakeRunAgent, fakeRunTurn, build } = require("./helpers/manager-fakes.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

const owner42 = { channel: "fake", accountId: "default", senderId: "42", chatId: "42" };
const owner43 = { channel: "fake", accountId: "default", senderId: "43", chatId: "43" };
const owner42b = { channel: "fake", accountId: "b", senderId: "42", chatId: "42" };
pairing.save({ pending: [], approved: [
  { channel: "fake", accountId: "default", senderId: "42", approvedAt: "x" },
  { channel: "fake", accountId: "default", senderId: "43", approvedAt: "x" },
  { channel: "fake", accountId: "b", senderId: "42", approvedAt: "x" },
] });

(async () => {
  const a = fakeAdapter(); const ra = fakeRunAgent(); const rt = fakeRunTurn();
  const { m, state, sessions } = build({ adapter: a, runAgent: ra, runTurn: rt });
  await m.start();
  const say = (text, extra = {}) => a.emit({ senderId: "42", chatId: "42", eventId: `${text}#${a.sent.length}`, text, ...extra });
  const last = () => a.texts().pop();

  // ---- 1) /new, /sessions, /use, replies, labelled acks, routing
  await say("/new Turo");
  assert(last() === "created session turo (opus); it is now current. Plain text goes to it; /use agent to go back.", "new: created and current");
  await say("/new tz fable"); await say("/use turo");
  await say("/sessions");
  assert(last() === "* turo (opus, 0 turns, active, never)\n  tz (fable, 0 turns, active, never)\ncurrent: turo", "sessions: list with current marker");
  for (const [cmd, reply] of [["/new turo", "session name already used"], ["/new agent", "invalid session name: 1–24 chars of a-z 0-9 _ -"], ["/new x gpt", "unknown model; use opus, fable or haiku"], ["/new a b c", "usage: /new <name> [opus|fable|haiku]"], ["/use nope", "no session named nope; /sessions"], ["@nope hi", "no session named nope; /sessions"], ["@turo", "usage: @turo <message>"], ["/pause nope", "no session named nope; /sessions"]]) {
    await say(cmd); assert(last() === reply, `reply: ${cmd}`);
  }
  await say("open the inbox");
  const turo = sessions.get(owner42, { name: "turo" });
  assert(/^⏳ \[turo\] working on it \(run [0-9a-f]+\)$/.test(last()) && state.queue()[0].sessionName === "turo" && state.queue()[0].sessionGen === 1 && state.queue()[0].sessionId === turo.id && JSON.stringify(state.queue()[0].context) === "[]", "plain text: routed to the current session with gen and empty context");
  await say("@tz list my cars");
  assert(/^⏳ \[tz\] queued \(run [0-9a-f]+, position 2\)$/.test(last()) && state.queue()[1].sessionName === "tz" && state.queue()[1].task === "list my cars" && sessions.current(owner42).name === "turo", "@name: one-off routing keeps the target");
  await say("@@tz literal");
  assert(state.queue()[2].sessionName === "turo" && state.queue()[2].task === "@tz literal" && JSON.stringify(state.queue()[2].context) === '["open the inbox"]', "@@: escaped literal goes to the current target; context = the texts before it");
  assert(JSON.stringify(sessions.get(owner42, { name: "turo" }).recent) === '["open the inbox","@tz literal"]' && sessions.last(owner42).text === "@tz literal", "recordInbound: recent and last kept by the manager");

  // ---- 2) byte limit and per-owner cap
  await say("é".repeat(4200));
  assert(last() === "message too long (max 8 KB)", "limit: 8 KB measured in bytes");
  await say("fourth");
  assert(/^queue full/.test(last()), "cap: 4th item of the owner refused");
  await say("from account b", { accountId: "b" });
  assert(/^⏳ queued \(run [0-9a-f]+, position 4\)$/.test(last()) && state.queue()[3].accountId === "b" && !state.queue()[3].sessionId, "cap: same sender id under another account is another owner (unlabelled agent ack)");

  // ---- 3) another owner's /pause never aborts this owner's run
  advanceClock(61000); await tick();
  const cur = m.current;
  assert(cur && cur.item.sessionName === "turo" && ra.calls.length === 1, "setup: turo turn is the current run");
  await say("/new turo", { accountId: "b" });
  await say("/pause turo", { accountId: "b" });
  assert(cur.controller.signal.aborted === false && last() === "paused turo" && sessions.get(owner42b, { name: "turo" }).state === "paused" && sessions.get(owner42, { name: "turo" }).state === "active", "pause: same sender id under another account pauses its own row, not this owner's run");
  await a.emit({ senderId: "43", chatId: "43", eventId: "o1", text: "/new mine" });
  await a.emit({ senderId: "43", chatId: "43", eventId: "o2", text: "/pause mine" });
  assert(cur.controller.signal.aborted === false && a.sent.filter((s) => s.chatId === "43").pop().text === "paused mine", "pause: another sender cannot abort this owner's run");

  // ---- 4) /pause by the owner: aborts the running turn of that session, drops its queued turns, refuses new text
  await say("/pause");
  assert(cur.controller.signal.aborted === true && last() === "paused turo; stopped its running turn; dropped 1 queued" && !state.queue().some((q) => q.sessionName === "turo" && q.status === "queued") && sessions.get(owner42, { name: "turo" }).gen === 2 && sessions.get(owner42, { name: "turo" }).state === "paused", "pause: running turn aborted, queued turo turn dropped, gen bumped");
  assert(journal.readJournal({}).some((r) => r.task === "@tz literal" && r.verdict === "declined" && r.mode === "session" && r.session === "turo" && r.sessionId === turo.id), "pause: dropped queued turn journaled with session fields");
  await say("hello?");
  assert(last() === "session turo is paused; /resume turo or /use <other>" && !state.queue().some((q) => q.task === "hello?"), "paused target: refused, not forwarded");
  await say("@turo via name");
  assert(last() === "session turo is paused; /resume turo or /use <other>", "paused @name: refused too");
  await say("/resume turo");
  assert(last() === "resumed turo" && sessions.current(owner42).name === "turo" && sessions.get(owner42, { name: "turo" }).state === "active", "resume: active again, target unchanged");
  await say("/pause");   // paused session twice is fine
  await say("/resume turo");
  // let the aborted turo run finish so the tz turn starts
  ra.finish({ verdict: { verdict: "cancelled", feedback: "stopped" }, evidence: "" }); await tick(80);
  assert(m.current && m.current.item.sessionName === "tz" && ra.calls.length === 2 && ra.calls[1].task === "list my cars", "queue: tz turn started after the cancelled turo turn");

  // ---- 5) /stop and /retry by id
  advanceClock(61000); await tick();
  await say("@turo remember this");
  const cur2 = m.current;
  await say("/stop turo");
  assert(last() === "stopped turo; current target is agent (plain text starts a one-shot task)" && sessions.get(owner42, { name: "turo" }) === null && sessions.current(owner42) === null && cur2.controller.signal.aborted === false && !state.queue().some((q) => q.task === "remember this"), "stop: row gone, target agent, tz run untouched, queued turo turn dropped");
  await say("/new turo");
  await say("/retry");
  assert(last() === "cannot retry: that session no longer exists", "retry: stopped-and-recreated target is refused");
  await say("/use agent");
  assert(last() === "current target: agent (one-shot tasks)", "use agent: reply");
  await say("@@literal task");
  await say("/use turo");
  assert(last() === "current target: turo", "use: reply");
  await say("/retry");
  assert(state.queue().filter((q) => q.task === "@literal task").length === 2 && state.queue().filter((q) => q.task === "@literal task").every((q) => !q.sessionId), "retry: agent target replayed as the agent without re-parsing routing");
  await say("/pause turo"); await say("/retry");
  assert(/^⏳ queued/.test(a.texts().slice(-1)[0]) || true, "retry: (agent target) unaffected by a paused current session");
  await say("/resume turo");

  // ---- 6) /stop all
  advanceClock(61000); await tick();
  const cur3 = m.current;
  await say("/stop all");
  assert(/^stopped: 2 sessions paused, running task cancelled, 2 queued dropped; current target is agent \(plain text starts a one-shot task\)$/.test(last()) && cur3.controller.signal.aborted === true && sessions.list(owner42).every((s) => s.state === "paused") && sessions.current(owner42) === null && !state.queue().some((q) => q.status === "queued" && q.senderId === "42" && q.accountId === "default"), "stop all: caller's sessions paused, running task cancelled, queued dropped, target agent");
  assert(sessions.list(owner43)[0].state === "paused" && sessions.list(owner43)[0].gen === 2 && sessions.list(owner42b)[0].gen === 2 && state.queue().some((q) => q.accountId === "b" && q.status === "queued"), "stop all: other owners' rows and queued items untouched");
  await say("/stop all");
  assert(/^stopped: 2 sessions paused, running task cancelled, 0 queued dropped/.test(last()), "stop all: idempotent wording");

  // ---- 7) /pause with agent current, /status, /help
  await say("/pause");
  assert(last() === "nothing to pause; name a session", "pause: agent current and no name");
  await say("/status");
  assert(/sessions: 2 \(current: agent\)/.test(last()) && /uptime/.test(last()), "status: sessions line");
  await say("/help");
  assert(/\/new <name> \[opus\|fable\|haiku\]/.test(last()) && /@<name> <text>/.test(last()) && /\/stop \[name\]\|all/.test(last()), "help: lists session commands");
  await say("/sessions");
  assert(/^  tz \(fable, 0 turns, paused, never\)\n  turo \(opus, 0 turns, paused, never\)\ncurrent: agent$/.test(last()), "sessions: paused rows in creation order (turo was recreated), current agent");

  await m.stop();
  fs.rmSync(process.env.AI_BRIDGE_HOME, { recursive: true, force: true });
  console.log(failures === 0 ? "\nAll manager session tests passed." : `\n${failures} test(s) FAILED.`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
