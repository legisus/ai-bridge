#!/usr/bin/env node
// An approval nobody answers is not a refusal: the prompt is marked expired, the ack
// and status lines say "no answer in <ttl>", nothing is remembered as declined, and the
// intent gate's verdict (and why) is in the log.
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-mgr-expiry-"));
const pairing = require("../server/channels/pairing.js");
const journal = require("../server/journal.js");
const { tick, until, advanceClock, fakeAdapter, fakeRunAgent, fakeRunTurn, build } = require("./helpers/manager-fakes.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

(async () => {
  const keep = setInterval(() => {}, 1000);   // approval timers are unref'd; a live daemon has its poll loop, this test has this
  pairing.save({ pending: [], approved: [{ channel: "fake", accountId: "default", senderId: "42", approvedAt: "x" }] });
  const a = fakeAdapter(); const ra = fakeRunAgent(); const rt = fakeRunTurn();
  const logs = [];
  const { m, state, sessions } = build({ adapter: a, runAgent: ra, runTurn: rt, approvalTtlMs: 300, log: (l) => logs.push(l), classify: async () => "read" });
  await m.start();
  let n = 0;
  const say = (text) => a.emit({ senderId: "42", chatId: "42", eventId: `e${++n}`, text });
  const texts = () => a.texts();
  const last = () => texts().pop();
  const buttons = () => a.sent.filter((s) => s.type === "buttons");
  const lastButtons = () => buttons().pop();
  const idOf = (rec) => a.sent.indexOf(rec) + 1;   // the fake adapter's message id = position (1-based)
  const edits = (rec) => a.sent.filter((s) => s.type === "edit" && s.messageId === idOf(rec));
  const lastEdit = (rec) => edits(rec).pop() || { text: null, buttons: null };
  const lastRec = () => journal.readJournal({}).pop();
  const owner = { channel: "fake", accountId: "default", senderId: "42", chatId: "42" };

  // ---- A) one-shot: the intent prompt expires
  await say("send the invoice to Bob"); await tick();
  const ackA = a.sent[a.sent.length - 2];   // the ack was sent right before the prompt
  const promptA = lastButtons();
  assert(ackA.text === "⏳ working on it" && promptA && state.queue()[0].status === "awaiting-approval", "one-shot: ack then prompt, awaiting approval");
  assert(await until(() => state.queue().length === 0, 3000), "one-shot: the run ends once the prompt expires");
  const promptEditA = edits(promptA).pop();
  assert(promptEditA && promptEditA.text === `${promptA.text}\n→ expired (no answer in 0s)` && promptEditA.buttons.length === 0, "one-shot: the prompt is edited to expired, buttons removed");
  assert(lastEdit(ackA).text === "⏳ no answer in 0s", "one-shot: the ack ends as 'no answer in <ttl>'");
  assert(last() === '⏳ no answer in 0s — send "send the invoice to Bob" again to run it', "one-shot: the status line says how to run it");
  assert(ra.calls.length === 0 && lastRec().verdict === "declined" && lastRec().feedback === "approval expired (no answer in 0s)" && lastRec().task === "send the invoice to Bob", "one-shot: never ran; journaled declined with the expiry feedback");
  assert(!texts().some((t) => t.startsWith("🚫")), "one-shot: no 'declined' line for a timeout");
  await a.emitAction({ actorId: "42", chatId: "42", messageId: idOf(promptA), data: promptA.buttons[0].data }); await tick();
  assert(lastEdit(promptA).text === `${promptA.text}\n→ expired (no answer in 0s)\n(no longer pending)` && ra.calls.length === 0, "one-shot: a late tap says no longer pending under the expired line and starts nothing");
  const runA = lastRec().runId;
  assert(logs.some((l) => l === `intent for run ${runA}: write (keyword "send")`), "log: the gate's verdict and reason are logged (keyword)");

  // ---- B) the model's verdict is logged too
  await say("open the dashboard"); await until(() => ra.calls.length === 1);
  assert(logs.some((l) => /^intent for run [0-9a-f]{12}: read \(model\)$/.test(l)), "log: a model read is logged with its reason");
  ra.finish({}); await tick(60);

  // ---- C) session turn: the intent prompt expires
  await say("/new turo haiku"); await tick();
  await say("send a note to Ann"); await tick();
  const ackC = a.sent[a.sent.length - 2]; const promptC = lastButtons();
  assert(ackC.text === "⏳ [turo] working on it" && promptC.text.startsWith("[turo] This message looks like"), "session: labelled ack and prompt");
  assert(await until(() => state.queue().length === 0, 3000), "session: the turn ends once the prompt expires");
  assert(lastEdit(promptC).text === `${promptC.text}\n→ expired (no answer in 0s)`, "session: prompt edited to expired");
  assert(lastEdit(ackC).text === "⏳ [turo] no answer in 0s", "session: labelled ack ends as no answer");
  assert(last() === '⏳ [turo] no answer in 0s — send "send a note to Ann" again to run it', "session: labelled status line");
  const row = sessions.get(owner, { name: "turo" });
  assert(rt.calls.length === 0 && lastRec().verdict === "declined" && lastRec().feedback === "approval expired (no answer in 0s)" && lastRec().mode === "session" && row.declined.length === 0, "session: nothing spawned; journaled declined; nothing remembered as declined");

  // ---- D) mid-turn step approval expires: not remembered as declined
  advanceClock(61000);
  await say("open the inbox"); await until(() => rt.calls.length === 1);
  rt.finish({ text: "ready\nNEEDS APPROVAL: send the reply to Ann" }); await tick();
  const promptD = lastButtons();
  assert(promptD.text === "[turo] Approval needed: send the reply to Ann" && state.queue()[0].status === "awaiting-approval", "step: approval prompt");
  assert(await until(() => state.queue().length === 0, 3000), "step: the turn ends once the prompt expires");
  assert(lastEdit(promptD).text === `${promptD.text}\n→ expired (no answer in 0s)`, "step: prompt edited to expired");
  assert(last() === "⏳ [turo] no answer in 0s — not done: send the reply to Ann", "step: status line names what was not done");
  assert(lastRec().verdict === "declined" && lastRec().feedback === "approval expired (no answer in 0s): send the reply to Ann" && sessions.get(owner, { name: "turo" }).declined.length === 0 && rt.calls.length === 1, "step: journaled declined with the expiry feedback; not remembered; no continuation");

  // ---- E) one-shot: a recipe/step approval asked by the agent expires → the agent reports it, the chat shows "no answer"
  await say("/use agent"); await tick();
  await say("open the inbox"); await until(() => ra.calls.length === 2);
  const ackE = a.sent[a.sent.length - 1];
  const decisionE = ra.calls[1].opts.approve({ kind: "step", title: "send the reply to Ann", digest: "d".repeat(64) });
  await tick();
  const promptE = lastButtons();
  assert(promptE.text === "Approval needed: send the reply to Ann" && state.queue()[0].status === "awaiting-approval", "agent step: prompt sent through the manager");
  assert((await decisionE) === "expired", "agent step: the approve hook returns expired to the agent");
  ra.finish({ verdict: { verdict: "declined", feedback: "approval expired: send the reply to Ann" } }); await until(() => state.queue().length === 0, 3000);
  assert(lastEdit(promptE).text === `${promptE.text}\n→ expired (no answer in 0s)`, "agent step: prompt edited to expired");
  assert(lastEdit(ackE).text === "⏳ no answer in 0s", "agent step: ack ends as no answer");
  assert(texts().includes("⏳ no answer in 0s — not done: send the reply to Ann") && !texts().some((t) => t.startsWith("🚫 declined — approval expired")), "agent step: status line says what was not done, no 'declined' line");
  assert(lastRec().verdict === "declined" && lastRec().feedback === "approval expired: send the reply to Ann", "agent step: journaled declined with the expiry feedback");

  // ---- F) the classifier's reply is redacted before it is logged, even when truncated
  const { TOKEN } = require("./helpers/manager-fakes.js");
  const a2 = fakeAdapter(); const ra2 = fakeRunAgent(); const logs2 = [];
  const m2 = build({ adapter: a2, runAgent: ra2, approvalTtlMs: 300, log: (l) => logs2.push(l), classify: async () => "Unexpected: " + "x".repeat(18) + TOKEN + " trailing words" }).m;
  await m2.start();
  await a2.emit({ senderId: "42", chatId: "42", eventId: "f1", text: "open the dashboard" }); await tick();
  const intentLog = logs2.find((l) => /^intent for run/.test(l));
  assert(intentLog && /write \(model reply unreadable: "Unexpected: x{18}<redacted>…"\)$/.test(intentLog) && !logs2.some((l) => l.includes(TOKEN.slice(0, 6))), "log: the unreadable reply is redacted before truncation");
  await m2.stop();

  // ---- G) a prompt edit that never returns does not hold the run; a transient failure on the final ack falls back to a silent line
  const a3 = fakeAdapter(); const ra3 = fakeRunAgent();
  const m3 = build({ adapter: a3, runAgent: ra3, approvalTtlMs: 300 });
  await m3.m.start();
  await a3.emit({ senderId: "42", chatId: "42", eventId: "g1", text: "send g" }); await tick();
  const ackG = a3.sent[a3.sent.length - 2]; const promptG = a3.sent[a3.sent.length - 1];
  const idG = (rec) => a3.sent.indexOf(rec) + 1;
  let finalTried = 0;
  a3.editHook = async (rec) => {
    if (rec.messageId === idG(promptG)) return new Promise(() => {});                                   // the prompt edit stalls forever
    if (rec.messageId === idG(ackG) && /no answer/.test(rec.text) && finalTried++ === 0) throw Object.assign(new Error("Bad Gateway"), { permanent: false, status: 502 });
  };
  assert(await until(() => m3.state.queue().length === 0, 3000), "stalled prompt edit: the run still ends");
  const fbG = a3.sent.filter((s) => s.type === "text" && s.text === "⏳ no answer in 0s").pop();
  assert(fbG && fbG.silent === true, "transient final-ack failure: the final line goes out as a silent message instead of staying 'working on it'");
  assert(a3.texts().pop() === '⏳ no answer in 0s — send "send g" again to run it', "stalled prompt edit: the status line still follows");
  await m3.m.stop();

  // ---- H) late tap while the prompt's send response is still in flight: nothing erases the expiry line
  const a4 = fakeAdapter(); const ra4 = fakeRunAgent();
  const m4 = build({ adapter: a4, runAgent: ra4, approvalTtlMs: 300 });
  await m4.m.start();
  let releaseSend; a4.buttonsHook = () => new Promise((r) => { releaseSend = r; });
  await a4.emit({ senderId: "42", chatId: "42", eventId: "h1", text: "send h" }); await tick();
  const promptH = a4.sent.filter((s) => s.type === "buttons").pop(); const idH = a4.sent.indexOf(promptH) + 1;
  await tick(400);                                                                                         // expired, send response still pending
  const tapH = a4.emitAction({ actorId: "42", chatId: "42", messageId: idH, data: promptH.buttons[0].data });    // late tap; its edit waits for delivery
  await tick(50); assert(!a4.sent.some((s) => s.type === "edit"), "late tap race: no edit before the prompt's delivery is known");
  releaseSend(); await tapH; await until(() => m4.state.queue().length === 0, 3000); await tick(50);
  const editsH = a4.sent.filter((s) => s.type === "edit" && s.messageId === idH);
  assert(editsH.length === 2 && editsH[1].text.includes("→ expired (no answer in 0s)") && editsH[1].text.includes("(no longer pending)") && editsH.every((e) => e.text.startsWith(promptH.text)), "late tap race: edits are serialized after delivery; the expiry line survives");
  assert(ra4.calls.length === 0, "late tap race: nothing ran");
  await m4.m.stop();

  // ---- I) text-only prompts (no buttons, edits available) get the same expiry edit
  const a5 = fakeAdapter({ buttons: false }); const ra5 = fakeRunAgent();
  const m5 = build({ adapter: a5, runAgent: ra5, approvalTtlMs: 300 });
  await m5.m.start();
  await a5.emit({ senderId: "42", chatId: "42", eventId: "i1", text: "send i" }); await tick();
  const promptI = a5.sent[a5.sent.length - 1];
  assert(promptI.type === "text" && /reply \/approve [0-9a-f]{16} yes/.test(promptI.text), "text prompt: sent as text with the /approve hint");
  assert(await until(() => m5.state.queue().length === 0, 3000), "text prompt: the run ends on expiry");
  const editI = a5.sent.filter((s) => s.type === "edit" && s.messageId === a5.sent.indexOf(promptI) + 1).pop();
  assert(editI && editI.text === `${promptI.text}\n→ expired (no answer in 0s)`, "text prompt: edited to expired as well");
  await m5.m.stop();

  await m.stop(); clearInterval(keep);
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
