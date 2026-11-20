#!/usr/bin/env node
// The ack line ("⏳ working on it"): finalised on every outcome, dropped queued items
// included; a slow edit never overtakes the final line; edit failures (not modified,
// transient, permanent) and the no-ack case (after a restart) degrade to silent messages.
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-mgr-ack-"));
const pairing = require("../server/channels/pairing.js");
const { tick, until, advanceClock, fakeAdapter, fakeRunAgent, build } = require("./helpers/manager-fakes.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };
const err = (msg, permanent) => Object.assign(new Error(msg), { permanent, status: permanent ? 400 : 502 });

(async () => {
  pairing.save({ pending: [], approved: [{ channel: "fake", accountId: "default", senderId: "42", approvedAt: "x" }] });
  const a = fakeAdapter(); const ra = fakeRunAgent();
  const { m } = build({ adapter: a, runAgent: ra });
  await m.start();
  let n = 0;
  const say = (text) => a.emit({ senderId: "42", chatId: "42", eventId: `e${++n}`, text });
  const edits = (id) => a.sent.filter((s) => s.type === "edit" && s.messageId === id);
  const lastEdit = (id) => edits(id).pop();
  const progress = (i, stage) => { advanceClock(15000); ra.calls[i].opts.onProgress({ stage }); };

  // ---- A) dropped queued items are finalised; nothing leaks
  await say("first"); await until(() => ra.calls.length === 1);
  const ack1 = a.sent.length;
  await say("second"); await tick();
  const ack2 = a.sent.length;
  assert(a.sent[ack2 - 1].text === "⏳ queued (position 2)", "ack: a second task gets the queued line");
  await say("/cancel"); await tick(50);
  assert(lastEdit(ack2) && lastEdit(ack2).text === "⏹ dropped (never ran)", "cancel: the queued item's ack is finalised as dropped");
  ra.finish({ verdict: { verdict: "cancelled", feedback: "stopped" } }); await tick(60);
  assert(lastEdit(ack1) && /^⏹ stopped after \d+[smhd]/.test(lastEdit(ack1).text), "cancel: the running item's ack is finalised as stopped");
  assert(m.acks.size === 0, "acks: nothing left after both items ended");

  // ---- B) a slow edit never overtakes the final line; delivery waits for it
  await say("slow"); await until(() => ra.calls.length === 2);
  const ack3 = a.sent.length;
  let release = null;
  a.editHook = () => new Promise((r) => { release = r; });
  progress(1, "ops"); await tick();
  a.editHook = null;
  ra.finish({}); await tick(40);
  assert(release && edits(ack3).length === 0 && !a.texts().some((t) => t.startsWith("✅ pass")), "ordering: the final line and the reply wait behind the hanging edit");
  release(); await tick(60);
  assert(edits(ack3).map((e) => e.text.replace(/\d+[smhd].*$/, "N")).join("|") === "⏳ working on it · ops · N|✅ done in N" && a.texts().some((t) => t.startsWith("✅ pass")), "ordering: progress edit, then the final line, then the reply");

  // ---- C) edit failures
  await say("errs"); await until(() => ra.calls.length === 3);
  const ack4 = a.sent.length, run4 = ra.calls[2].opts.runId, texts4 = a.texts().length;
  a.editHook = () => { throw err("telegram editMessageText: Bad Request: message is not modified", true); };
  progress(2, "s1"); await tick();
  assert(m.acks.get(run4).messageId === ack4 && a.texts().length === texts4, "not modified: the ack is kept, nothing else is sent");
  a.editHook = () => { throw err("telegram editMessageText: HTTP 502", false); };
  progress(2, "s2"); await tick();
  assert(m.acks.get(run4).messageId === ack4 && a.texts().length === texts4, "transient failure: the tick is skipped, the ack is kept");
  a.editHook = () => { throw err("telegram editMessageText: Bad Request: message to edit not found", true); };
  progress(2, "s3"); await tick();
  const fb = a.sent[a.sent.length - 1];
  assert(fb.type === "text" && fb.silent === true && /working on it · s3/.test(fb.text) && m.acks.get(run4).messageId === a.sent.length, "permanent failure: a silent message replaces the ack and becomes the line to edit");
  const fbId = a.sent.length;
  a.editHook = null;
  ra.finish({}); await tick(60);
  assert(lastEdit(fbId) && /^✅ done in/.test(lastEdit(fbId).text), "permanent failure: the replacement line is finalised");

  // ---- D) no ack at all (as after a daemon restart)
  await say("restart"); await until(() => ra.calls.length === 4);
  m.acks.delete(ra.calls[3].opts.runId);
  progress(3, "r1"); await tick();
  const sId = a.sent.length;
  assert(a.sent[sId - 1].type === "text" && a.sent[sId - 1].silent === true && /r1/.test(a.sent[sId - 1].text), "no ack: progress goes out as one silent message");
  ra.finish({}); await tick(60);
  assert(lastEdit(sId) && /^✅ done in/.test(lastEdit(sId).text), "no ack: that silent message is finalised");
  assert(m.acks.size === 0, "acks: empty at the end");

  await m.stop();
  console.log(failures ? `${failures} test(s) FAILED.` : "all ack tests passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
