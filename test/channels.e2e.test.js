#!/usr/bin/env node
// End to end: real Manager + real Telegram adapter against a fake Bot API, fake runAgent.
// Covers: task → working → pass → document; write-intent → buttons → callback → run;
// restart with a running and a queued task → the queued one runs exactly once.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.AI_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-e2e-"));
const { Manager } = require("../server/channels/manager.js");
const { ChannelState } = require("../server/channels/state.js");
const { loadConfig } = require("../server/channels/config.js");
const makeTelegram = require("../server/channels/telegram.js");
const pairing = require("../server/channels/pairing.js");

let failures = 0;
const assert = (cond, name) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake Bot API
const TOKEN = "777:E2E";
const requests = [];
let pending = [];
let nextUpdateId = 1000;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const method = req.url.split("/").pop();
    let body = null;
    if ((req.headers["content-type"] || "").startsWith("application/json")) { try { body = JSON.parse(raw.toString()); } catch {} }
    requests.push({ method, body, raw });
    const reply = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
    if (method === "getUpdates") {
      const upd = pending.filter((u) => u.update_id >= (body.offset || 0));
      pending = pending.filter((u) => u.update_id < (body.offset || 0));
      if (upd.length) return reply(200, { ok: true, result: upd });
      return setTimeout(() => reply(200, { ok: true, result: [] }), 25);
    }
    if (method === "sendMessage" || method === "editMessageText") return reply(200, { ok: true, result: { message_id: requests.length } });
    if (method === "sendDocument") return reply(200, { ok: true, result: { message_id: requests.length } });
    if (method === "answerCallbackQuery") return reply(200, { ok: true, result: true });
    reply(404, { ok: false });
  });
});
const user = { id: 42, is_bot: false, first_name: "Ann" };
const push = (text) => pending.push({ update_id: nextUpdateId++, message: { message_id: nextUpdateId, from: user, chat: { id: 42, type: "private" }, date: 1, text } });
const tap = (data, messageId) => pending.push({ update_id: nextUpdateId++, callback_query: { id: `cb${nextUpdateId}`, from: user, message: { message_id: messageId, chat: { id: 42, type: "private" } }, data } });
const msgs = () => requests.filter((r) => r.method === "sendMessage").map((r) => r.body);

// ---- fake runAgent
const runCalls = [];
let release = null;
const runAgent = (task, opts) => { runCalls.push({ task, opts }); return new Promise((resolve) => { release = (extra) => resolve({ verdict: { verdict: "pass", feedback: "done" }, evidence: "EVIDENCE REPORT\nTask: t\nFinal state: title is Example", stages: [], runId: opts.runId, record: {}, ...extra }); }); };

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const cfgFile = path.join(process.env.AI_BRIDGE_HOME, "channels.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ telegram: { token: TOKEN, apiBase, allowFrom: ["42"] } }), { mode: 0o600 });
  const config = loadConfig({ env: {} });
  const stateFile = path.join(process.env.AI_BRIDGE_HOME, "channels-state.json");
  const build = () => new Manager({ config, adapters: [makeTelegram(config.telegram, { log: () => {} })], state: new ChannelState(stateFile), pairing,
    runAgent, runModel: async () => ({ result: "read" }), bridgePing: async () => ({ ok: true, text: "{}" }), log: () => {} });

  // ---- 1) read task → working → pass + evidence + document
  let m = build();
  await m.start();
  push("get the page title");
  await wait(250);
  assert(runCalls.length === 1 && runCalls[0].task === "get the page title" && runCalls[0].opts.restricted === true, "e2e: task reached runAgent restricted");
  assert(msgs().some((b) => /^⏳ working on it/.test(b.text)), "e2e: 'working on it' sent via Telegram");
  fs.writeFileSync(path.join(runCalls[0].opts.cwd, "result.txt"), "TITLE");
  release();
  await wait(250);
  const order = requests.filter((r) => ["sendMessage", "sendDocument"].includes(r.method)).map((r) => r.method === "sendDocument" ? "doc" : r.body.text.slice(0, 12));
  assert(order.indexOf("✅ pass — don") > order.indexOf("⏳ working on") && order.indexOf("doc") > order.indexOf("✅ pass — don"), "e2e: order is working → pass → document");
  assert(requests.some((r) => r.method === "sendDocument" && r.raw.includes("TITLE") && r.raw.includes('filename="result.txt"')), "e2e: result.txt uploaded with its bytes");
  assert(msgs().some((b) => b.text.startsWith("EVIDENCE REPORT")), "e2e: evidence delivered");

  // ---- 2) write intent → buttons → tap → run → edit
  push("send the report to Bob");
  await wait(250);
  const prompt = msgs().find((b) => b.reply_markup && b.reply_markup.inline_keyboard);
  assert(prompt && prompt.text.includes('"send the report to Bob"') && prompt.reply_markup.inline_keyboard[0].length === 2, "e2e: approval prompt with inline keyboard");
  assert(runCalls.length === 1, "e2e: agent not started before approval");
  const promptMsgId = requests.findIndex((r) => r.body === prompt) + 1; // fake returns message_id = request index
  tap(prompt.reply_markup.inline_keyboard[0][0].callback_data, promptMsgId);
  await wait(300);
  assert(runCalls.length === 2 && runCalls[1].task === "send the report to Bob", "e2e: tap started the run");
  assert(requests.some((r) => r.method === "editMessageText" && /→ approved/.test(r.body.text) && r.body.reply_markup.inline_keyboard.length === 0), "e2e: prompt edited to approved with buttons removed");
  assert(requests.some((r) => r.method === "answerCallbackQuery"), "e2e: callback acknowledged");
  release();
  await wait(250);

  // ---- 3) restart mid-queue: running task declined, queued task runs exactly once
  push("first long task");
  await wait(250);
  push("second queued task");
  await wait(250);
  assert(runCalls.length === 3 && runCalls[2].task === "first long task", "e2e: first task running");
  const st = new ChannelState(stateFile);
  assert(st.queue().length === 2 && st.queue()[1].status === "queued", "e2e: second task persisted as queued");
  await m.stop();                       // aborts the running one; the fake runAgent never resolves it
  const before = runCalls.length;
  m = build();
  await m.start();
  await wait(400);
  assert(runCalls.length === before + 1 && runCalls[before].task === "second queued task", "e2e: after restart the queued task ran exactly once");
  assert(msgs().some((b) => b.text.startsWith('restarted; "first long task" was not replayed')), "e2e: running task reported as not replayed");
  release();
  await wait(250);
  assert(new ChannelState(stateFile).queue().length === 0, "e2e: queue empty after the run");
  await m.stop();

  server.close();
  fs.rmSync(process.env.AI_BRIDGE_HOME, { recursive: true, force: true });
  console.log(failures === 0 ? "\nAll e2e tests passed." : `\n${failures} test(s) FAILED.`);
  process.exit(failures ? 1 : 0);
})();
