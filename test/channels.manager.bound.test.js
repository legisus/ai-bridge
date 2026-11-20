#!/usr/bin/env node
// Bound bots: a bot whose chat is one conversation. Routing (literal text, auto-create,
// model conflict, cap), the reduced command set, execution and retry binding, pairing
// wording, status privacy, redaction of prompts and journal records. Two fake adapters of
// one channel: a0 (general, default account) and a1 (bound, account "turo").
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-mgr-bound-"));
const pairing = require("../server/channels/pairing.js");
const journal = require("../server/journal.js");
const { TOKEN, advanceClock, tick, until, fakeAdapter, fakeRunAgent, fakeRunTurn, build } = require("./helpers/manager-fakes.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

const TOKEN_T = "tok-secret-turo-9999";
const bot = (accountId, extra) => ({ accountId, token: accountId === "default" ? TOKEN : TOKEN_T, dmPolicy: "pairing", allowFrom: [], codex: false, envPassthrough: ["MGR_PASS"], boundSession: null, ...extra });
const config = { fake: { ...bot("default"), bots: [bot("default"), bot("turo", { envPassthrough: ["MGR_PASS2"], boundSession: { name: "turo", model: "claude-haiku-5-5" } })] } };
const ownerTuro = { channel: "fake", accountId: "turo", senderId: "42", chatId: "42" };
const REFUSAL = "this bot is bound to session turo: plain text goes to it, /pause and /resume control it, /stop starts it over";
process.env.MGR_PASS2 = "yes2";

(async () => {
  pairing.save({ pending: [], approved: [{ channel: "fake", accountId: "default", senderId: "42", approvedAt: "x" }] });
  const a0 = fakeAdapter(); const a1 = fakeAdapter({ accountId: "turo" }); const ra = fakeRunAgent(); const rt = fakeRunTurn();
  const { m, state, sessions } = build({ adapters: [a0, a1], runAgent: ra, runTurn: rt, config });
  await m.start();
  let n = 0;
  const say = (adapter, text) => adapter.emit({ senderId: "42", chatId: "42", eventId: `e${++n}`, text });
  const last = (adapter = a1) => adapter.texts().pop();
  const lastRec = () => journal.readJournal({}).pop();
  const idle = () => until(() => state.queue().length === 0);

  // ---- pairing is per bot and names the binding
  await say(a1, "hello");
  assert(/^Not paired\. Code: [A-Z2-9]{6}\. The operator runs: bridge pairing approve fake [A-Z2-9]{6} \(this bot is the "turo" conversation; your message was not kept — send it again once paired\)$/.test(last()) && sessions.list(ownerTuro).length === 0, "bound: unpaired on this bot → pairing notice names the binding");
  pairing.save({ pending: [], approved: [{ channel: "fake", accountId: "default", senderId: "42", approvedAt: "x" }, { channel: "fake", accountId: "turo", senderId: "42", approvedAt: "x" }] });

  // ---- first message: literal text, auto-created row, this bot's config
  await say(a1, "@weird looking text");
  assert(await until(() => rt.calls.length === 1) && sessions.list(ownerTuro).length === 1 && sessions.list(ownerTuro)[0].model === "claude-haiku-5-5" && rt.calls[0].opts.text === "@weird looking text" && rt.calls[0].opts.envPassthrough[0] === "MGR_PASS2" && /^⏳ \[turo\] working on it/.test(last()) && a0.texts().length === 0, "bound: first message auto-creates the row and runs the turn as literal text through this bot");
  rt.finish({ text: "hi" }); await idle();
  assert(last() === "[turo] hi" && sessions.list(ownerTuro)[0].turns === 1, "bound: labelled reply");

  // ---- command set
  advanceClock(61000);
  for (const [cmd, reply] of [["/new x", REFUSAL], ["/use agent", REFUSAL], ["/stop all", REFUSAL], ["/pause other", 'this bot only has the conversation "turo"'], ["/pause turo extra", 'this bot only has the conversation "turo"'], ["/resume other", 'this bot only has the conversation "turo"'], ["/stop nope", 'this bot only has the conversation "turo"']]) {
    await say(a1, cmd); assert(last() === reply, `bound: ${cmd} → ${reply.slice(0, 30)}…`);
  }
  await say(a1, "/start"); assert(last().startsWith(REFUSAL + "\n") && /\/stop — start the conversation over/.test(last()) && !/\/new/.test(last().slice(REFUSAL.length)), "bound: /start explains and shows the bound help");
  await say(a1, "/help"); assert(/\/stop — start the conversation over/.test(last()) && !/\/use/.test(last()) && /Plain text continues the conversation/.test(last()), "bound: /help is the bound list");
  await say(a1, "/status"); assert(/bound: turo \(haiku\)/.test(last()) && /current: idle/.test(last()), "bound: status shows the binding");
  await say(a1, "/sessions"); assert(last() === "* turo (haiku, 1 turns, active, 1m ago)\ncurrent: turo", "bound: sessions lists the one row");
  await say(a1, "/pause"); assert(last() === "paused turo", "bound: bare /pause");
  await say(a1, "more"); assert(last() === "session turo is paused; /resume" && state.queue().length === 0, "bound: paused wording without /use");
  await say(a1, "/resume"); assert(last() === "resumed turo", "bound: bare /resume");
  await say(a1, "/pause turo"); await say(a1, "/resume turo"); assert(last() === "resumed turo", "bound: the bound name is accepted as the argument");

  // ---- /retry replays to the row
  await say(a1, "/retry");
  assert(await until(() => rt.calls.length === 2) && rt.calls[1].opts.text === "@weird looking text" && rt.calls[1].opts.resume === true, "bound: /retry replays the last message to the row");
  rt.finish({ text: "again" }); await idle();

  // ---- /stop forgets; the next message starts a fresh row
  advanceClock(61000);
  const oldId = sessions.list(ownerTuro)[0].id;
  await say(a1, "/stop"); assert(last() === "stopped turo; your next message starts a fresh conversation" && sessions.list(ownerTuro).length === 0, "bound: /stop forgets the conversation");
  await say(a1, "/retry"); assert(last() === "cannot retry: that message was not for this conversation; send a new message", "bound: retry after stop is refused");
  await say(a1, "/sessions"); assert(last() === "no conversation yet; just send a message", "bound: no row");
  await say(a1, "/pause"); assert(last() === "no conversation yet; just send a message", "bound: /pause without a row");
  await say(a1, "fresh");
  assert(await until(() => rt.calls.length === 3) && sessions.list(ownerTuro).length === 1 && sessions.list(ownerTuro)[0].id !== oldId && rt.calls[2].opts.resume === false, "bound: next message starts a new row with a fresh id");
  rt.finish({ text: "ok" }); await idle();

  // ---- model conflict (a row of another model under the bound name) refuses inbound and retry
  advanceClock(61000);
  sessions.stop(ownerTuro, sessions.list(ownerTuro)[0].id);
  const opusRow = sessions.create(ownerTuro, "turo", "opus");
  await say(a1, "x");
  assert(last() === "this conversation runs on opus, the bot is configured for haiku; /stop to start over on haiku" && state.queue().length === 0 && state.isSeen("fake:turo", `e${n}`), "bound: model conflict refuses and explains; the update is settled");
  sessions.recordInbound(ownerTuro, { text: "old", sessionId: opusRow.id });
  await say(a1, "/retry"); assert(last() === "this conversation runs on opus, the bot is configured for haiku; /stop to start over on haiku", "bound: retry against a conflicting row is refused the same way");
  // execution binding: a queued item for that row is dropped with the conflict wording; wrong-name and one-shot items too
  state.accept({ accountKey: "fake:turo", eventId: "q1", item: { runId: "runQ00000001", channel: "fake", accountId: "turo", chatId: "42", senderId: "42", task: "queued on opus row", sessionId: opusRow.id, sessionName: "turo", sessionGen: opusRow.gen, context: [] } });
  const otherRow = sessions.create(ownerTuro, "other");
  state.accept({ accountKey: "fake:turo", eventId: "q2", item: { runId: "runQ00000002", channel: "fake", accountId: "turo", chatId: "42", senderId: "42", task: "queued on other", sessionId: otherRow.id, sessionName: "other", sessionGen: otherRow.gen, context: [] } });
  state.accept({ accountKey: "fake:turo", eventId: "q3", item: { runId: "runQ00000003", channel: "fake", accountId: "turo", chatId: "42", senderId: "42", task: "old one-shot" } });
  const callsBefore = rt.calls.length;
  m.kick();
  assert(await idle() && rt.calls.length === callsBefore && ra.calls.length === 0, "bound: execution binding runs nothing for mismatched items");
  const texts = a1.texts();
  assert(texts.includes("🚫 [turo] this conversation runs on opus, the bot is configured for haiku; /stop to start over on haiku") && texts.filter((t) => t === "🚫 dropped — this bot is bound to session turo").length === 2, "bound: execution binding drops a conflicting row, a wrong-name session item and a pre-binding one-shot");
  assert(["runQ00000001", "runQ00000002", "runQ00000003"].every((id) => journal.readJournal({}).some((r) => r.runId === id && r.verdict === "declined")), "bound: dropped items are journaled declined");
  await say(a1, "/stop"); sessions.stop(ownerTuro, otherRow.id);

  // ---- cap
  for (let i = 0; i < 10; i++) sessions.create(ownerTuro, `s${i}`);
  await say(a1, "x");
  assert(last() === "cannot start the conversation: too many sessions on this bot (max 10); the operator can clear them" && state.queue().length === 0 && state.isSeen("fake:turo", `e${n}`), "bound: creation failure is reported and the message settled");
  for (const r of sessions.list(ownerTuro)) sessions.stop(ownerTuro, r.id);

  // ---- missing transcript wording
  advanceClock(61000);
  await say(a1, "y"); await until(() => rt.calls.length === callsBefore + 1);
  rt.finish(null, new Error("claude (m) exited 1: No conversation found with session ID: x")); await idle();
  assert(last() === "❌ [turo] this session's conversation is no longer available (Claude keeps transcripts ~30 days); /stop, then send a new message", "bound: missing-transcript wording");

  // ---- status privacy: the same sender id under another account sees no task text
  await say(a1, "z"); await until(() => rt.calls.length === callsBefore + 2);
  await say(a0, "/status"); assert(/current: busy \(another chat\)/.test(last(a0)) && !/\bz\b/.test(last(a0)), "status: another owner's task text hidden (same sender id, other account)");
  await say(a1, "/status"); assert(/current: running: z$/m.test(last()) && !/[0-9a-f]{12}/.test(last()), "status: the owner sees its own task");
  rt.finish({ text: "zz" }); await idle();

  // ---- redaction: prompt bodies (across the quote boundary), journal task/feedback, one-shot evidence
  advanceClock(61000);
  const longTask = "send " + "x".repeat(990) + TOKEN + " to Bob";
  await say(a0, longTask);
  assert(await until(() => a0.sent.some((s) => s.type === "buttons")), "redact: prompt sent");
  const prompt = a0.sent.filter((s) => s.type === "buttons").pop();
  assert(!prompt.text.includes(TOKEN) && !prompt.text.includes(TOKEN.slice(0, 8)) && /<red/.test(prompt.text), "redact: approval prompt body, redacted before quoting (the placeholder, not the token, is what the cut truncates)");
  await a0.emitAction({ actorId: "42", chatId: "42", messageId: 1, data: prompt.buttons[1].data }); await idle();
  assert(lastRec().task.includes("<redacted>") && !JSON.stringify(lastRec()).includes(TOKEN), "redact: journal task of a declined one-shot");
  await say(a0, `read the page about ${TOKEN}`); await until(() => ra.calls.length === 1);
  assert(ra.calls[0].opts.noJournal === true, "one-shot: runAgent is told not to journal (the manager does)");
  let journaledAtDelivery = null;
  const origSend0 = a0.sendText.bind(a0);
  a0.sendText = async (c, t) => { if (t.startsWith("✅ pass")) journaledAtDelivery = journal.readJournal({}).some((r) => r.runId === ra.calls[0].opts.runId); return origSend0(c, t); };
  const longEvidence = "EVIDENCE REPORT\n" + "x".repeat(3995 - 16) + TOKEN + " tail";
  ra.finish({ evidence: longEvidence, record: { runId: ra.calls[0].opts.runId, task: `read the page about ${TOKEN}`, signature: `auto:|read the page about ${TOKEN}`, mode: "regular", verdict: "pass", startedAt: "x", endedAt: "y", stages: [], costUsd: 0, domains: [], evidence: longEvidence.slice(0, 4000) } });
  await idle();
  a0.sendText = origSend0;
  const rec1 = lastRec();
  assert(journaledAtDelivery === true && rec1.runId === ra.calls[0].opts.runId && rec1.verdict === "pass" && rec1.source === "channel:fake", "redact: a completed one-shot's journal record is written by the manager before delivery");
  assert(!JSON.stringify(rec1).includes(TOKEN) && !JSON.stringify(rec1).includes(TOKEN.slice(0, 5)) && /<red/.test(rec1.evidence) && rec1.signature.includes("<redacted>"), "redact: signature recomputed from the redacted task; evidence redacted before truncation");

  // ---- bound /cancel does not depend on the session store
  await say(a1, "c1"); await until(() => rt.calls.length === callsBefore + 3);
  const origGet = sessions.get.bind(sessions); sessions.get = () => { throw new Error("channels-sessions.json unreadable: EACCES"); };
  const curC = m.current;
  await say(a1, "/cancel");
  sessions.get = origGet;
  assert(curC && curC.controller.signal.aborted === true && last() === "stopped; actions already performed were not undone", "bound: /cancel aborts the running turn even when the session store cannot be read");
  rt.finish(null, Object.assign(new Error("cancelled"), { name: "AbortError" })); await idle();

  await m.stop();
  fs.rmSync(process.env.AI_BRIDGE_HOME, { recursive: true, force: true });
  console.log(failures === 0 ? "\nAll bound-bot tests passed." : `\n${failures} test(s) FAILED.`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
